// SAP ADT object-tree materialization for the workspace Artifacts panel.
//
// The host-direct SAP flow (see core-service/src/http.ts) materializes an
// Eclipse-style ADT object tree as real folders + files on disk under
// `artifacts/<connection>/`, so the agent can read them and users can @mention
// them. A sidecar manifest (`.adt-tree.json`) records, for each materialized
// path, how to reach the corresponding ADT node:
//   - expandable folders (packages / sub-packages) carry the parent_type +
//     parent_name needed to call `adt object list` again (lazy expansion);
//   - object files carry the ADT source URI needed to hydrate their content.
//
// All ADT-specific logic lives here / in http.ts (octo-v2 layer); adt-cli stays
// a dumb adapter that only returns nodestructure/source data.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type SapTreeKind = "package" | "category" | "object";

export interface SapTreeEntry {
	kind: SapTreeKind;
	// For expandable folders (kind "package"): the ADT node coordinates used to
	// list children, plus whether children have already been materialized.
	adtParentType?: string;
	adtParentName?: string;
	loaded?: boolean;
	// For object files (kind "object"): the ADT URI used to read the source,
	// plus presentation metadata so the UI can render an Eclipse-style label.
	adtUri?: string;
	typeId?: string;
	label?: string;
	description?: string;
}

export interface SapTreeManifest {
	version: number;
	entries: Record<string, SapTreeEntry>;
}

export const ADT_TREE_FILE = ".adt-tree.json";

// Folder name of the synthetic root node created on connect (mirrors Eclipse).
export const LOCAL_OBJECTS_ROOT = "Local Object ($TMP)";

// --- one node as returned by `adt object list --json` -----------------------
export interface AdtNode {
	typeId: string;
	name: string;
	techName: string;
	uri: string | null;
	description: string;
	expandable: boolean;
}

export interface AdtListResult {
	nodes: AdtNode[];
	categories: Array<Record<string, unknown>>;
	objectTypes: Array<Record<string, unknown>>;
}

// --- manifest IO ------------------------------------------------------------

export function manifestPath(connDir: string): string {
	return join(connDir, ADT_TREE_FILE);
}

export function readManifest(connDir: string): SapTreeManifest {
	const p = manifestPath(connDir);
	if (!existsSync(p)) return { version: 1, entries: {} };
	try {
		const parsed = JSON.parse(readFileSync(p, "utf8")) as SapTreeManifest;
		if (!parsed.entries) return { version: 1, entries: {} };
		return parsed;
	} catch {
		return { version: 1, entries: {} };
	}
}

export function writeManifest(connDir: string, manifest: SapTreeManifest): void {
	writeFileSync(manifestPath(connDir), `${JSON.stringify(manifest, null, 2)}\n`);
}

// Build a fresh manifest whose only entry is the synthetic $TMP root folder.
export function initialManifest(): SapTreeManifest {
	return {
		version: 1,
		entries: {
			[LOCAL_OBJECTS_ROOT]: {
				kind: "package",
				adtParentType: "DEVC/K",
				adtParentName: "$TMP",
				loaded: false,
			},
		},
	};
}

// --- category grouping + naming ---------------------------------------------

function str(v: unknown): string {
	return v == null ? "" : String(v);
}

interface ObjectTypeInfo {
	categoryTag: string;
	label: string;
	nodeId: number;
}

// Map each object type id -> its category tag, label and tree NODE_ID, from the
// OBJECT_TYPES block of a nodestructure response. Field names vary slightly
// across releases, so we probe a few aliases defensively.
function indexObjectTypes(objectTypes: Array<Record<string, unknown>>): Map<string, ObjectTypeInfo> {
	const map = new Map<string, ObjectTypeInfo>();
	for (const ot of objectTypes) {
		const typeId = str(ot.OBJECT_TYPE ?? ot.object_type);
		if (!typeId) continue;
		const categoryTag = str(ot.CATEGORY_TAG ?? ot.CATEGORY ?? ot.category_tag);
		const label = str(ot.OBJECT_TYPE_LABEL ?? ot.object_type_label ?? "");
		const nodeId = Number(ot.NODE_ID ?? ot.node_id ?? NaN);
		map.set(typeId, { categoryTag, label, nodeId });
	}
	return map;
}

// Index the human label of every object-type GROUP node (the `DEVC/*` pseudo
// types that carry OBJECT_TYPE_LABEL) by its NODE_ID. A leaf object type with
// NODE_ID = n is grouped under the DEVC/* entry whose NODE_ID = n-1 (verified
// against live $TMP nodestructure output).
function indexGroupLabelsByNodeId(otIndex: Map<string, ObjectTypeInfo>): Map<number, string> {
	const map = new Map<number, string>();
	for (const ot of otIndex.values()) {
		if (ot.label && Number.isFinite(ot.nodeId)) map.set(ot.nodeId, ot.label);
	}
	return map;
}

function indexCategories(categories: Array<Record<string, unknown>>): Map<string, string> {
	const map = new Map<string, string>();
	for (const c of categories) {
		const tag = str(c.CATEGORY ?? c.category);
		const label = str(c.CATEGORY_LABEL ?? c.category_label ?? tag);
		if (tag) map.set(tag, label);
	}
	return map;
}

// Fallback friendly label per object type, used only when the NODE_ID pairing
// fails to resolve a subgroup label.
const TYPE_GROUP_LABEL: Record<string, string> = {
	"CLAS/OC": "Classes",
	"INTF/OI": "Interfaces",
	"PROG/P": "Programs",
	"PROG/I": "Includes",
	"FUGR/F": "Function Groups",
	"DDLS/DF": "Data Definitions",
	"DCLS/DL": "Access Controls",
	"TABL/DT": "Database Tables",
	"TABL/DS": "Structures",
	"TTYP/DA": "Table Types",
	"VIEW/DV": "Views",
	"DTEL/DE": "Data Elements",
	"DOMA/DD": "Domains",
	"MSAG/N": "Message Classes",
	"TRAN/T": "Transactions",
	"SFPF/5F": "Forms",
	"SFPI/5I": "Interfaces",
};

// Resolve a display label for the category a node belongs to, from prebuilt
// indexes. Falls back to the object-type label, then the raw type id, so
// grouping never collapses to "".
function categoryLabel(node: AdtNode, otIndex: Map<string, ObjectTypeInfo>, catIndex: Map<string, string>): string {
	const ot = otIndex.get(node.typeId);
	if (ot) {
		const byTag = catIndex.get(ot.categoryTag);
		if (byTag) return byTag;
		if (ot.label) return ot.label;
	}
	return node.typeId;
}

// Resolve the object-type subgroup label (Classes / Programs / Data Definitions
// …) for a leaf node, the second grouping level under each category.
function subgroupLabel(node: AdtNode, otIndex: Map<string, ObjectTypeInfo>, groupByNodeId: Map<number, string>): string {
	const ot = otIndex.get(node.typeId);
	if (ot && Number.isFinite(ot.nodeId)) {
		const byNodeId = groupByNodeId.get(ot.nodeId - 1);
		if (byNodeId) return byNodeId;
	}
	return TYPE_GROUP_LABEL[node.typeId] || ot?.label || node.typeId;
}

// Source-language extension per object-type "slug" (the part before the slash,
// e.g. CLAS/OC -> "clas"). Anything unmapped is treated as plain text.
const SLUG_LANG: Record<string, string> = {
	clas: "abap",
	intf: "abap",
	prog: "abap",
	fugr: "abap",
	fmod: "abap",
	ddls: "asddls",
	dcls: "asdcls",
	tabl: "xml",
	dtel: "xml",
	doma: "xml",
	ttyp: "xml",
	view: "xml",
	msag: "xml",
	tran: "xml",
	enqu: "xml",
	shlp: "xml",
};

// abapGit-style file name: `<name>.<typeslug>.<lang>`. Encoding the type slug
// guarantees uniqueness within a category folder even when two different object
// types share a name (e.g. an IWSG service and its OA2S OAuth scope).
export function fileNameFor(node: AdtNode): string {
	const slug = (node.typeId.split("/")[0] || "obj").toLowerCase().replace(/[^a-z0-9]/g, "");
	const lang = SLUG_LANG[slug] ?? "txt";
	// abapGit convention: namespace separators (/) become '#'; lower-cased name.
	const base = node.name.toLowerCase().replace(/\//g, "#").replace(/[^a-z0-9_#.$-]/g, "_");
	return `${base}.${slug}.${lang}`;
}

// A node is an expandable folder (package / function group) rather than a leaf
// object file when it has no source URI but the server marks it expandable, or
// when its type is a package.
export function isExpandableFolder(node: AdtNode): boolean {
	if (node.typeId === "DEVC/K") return true;
	return node.expandable && !node.uri;
}

// --- materialization plan ---------------------------------------------------

export interface MaterializeChild {
	relName: string; // file/folder name to create under the parent folder
	isDir: boolean;
	entry?: SapTreeEntry; // manifest entry to record (omitted for plain category folders)
}

// Turn a nodestructure result into the set of folders/files to create directly
// under the expanded parent. Leaf objects are grouped under category folders;
// sub-packages become lazy folders of their own.
function sanitizeFolderName(name: string, fallback: string): string {
	return name.replace(/\//g, "#").replace(/[^A-Za-z0-9_#.$ ()-]/g, "_") || fallback;
}

export function planChildren(result: AdtListResult): MaterializeChild[] {
	const out: MaterializeChild[] = [];
	const seen = new Set<string>();
	const folders = new Set<string>();
	const otIndex = indexObjectTypes(result.objectTypes);
	const catIndex = indexCategories(result.categories);
	const groupByNodeId = indexGroupLabelsByNodeId(otIndex);

	// Ensure a grouping folder exists exactly once (idempotent within this plan).
	const ensureFolder = (relName: string) => {
		if (folders.has(relName)) return;
		folders.add(relName);
		out.push({ relName, isDir: true }); // plain grouping folder (no manifest entry)
	};

	for (const node of result.nodes) {
		if (isExpandableFolder(node)) {
			const folderName = sanitizeFolderName(node.name, node.typeId);
			const key = `dir:${folderName}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				relName: folderName,
				isDir: true,
				entry: {
					kind: "package",
					adtParentType: node.typeId,
					adtParentName: node.techName || node.name,
					loaded: false,
				},
			});
			continue;
		}
		if (!node.uri) continue; // leaf without a source URI: nothing to hydrate, skip

		// Two-level Eclipse grouping: Category / Object-type subgroup / file.
		const catName = sanitizeFolderName(categoryLabel(node, otIndex, catIndex), "Objects");
		const subName = sanitizeFolderName(subgroupLabel(node, otIndex, groupByNodeId), "Objects");
		ensureFolder(catName);
		ensureFolder(`${catName}/${subName}`);

		const fileRel = `${catName}/${subName}/${fileNameFor(node)}`;
		const key = `file:${fileRel}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			relName: fileRel,
			isDir: false,
			entry: {
				kind: "object",
				adtUri: node.uri,
				typeId: node.typeId,
				label: node.name,
				description: node.description || "",
			},
		});
	}
	return out;
}

// Create the planned folders/files on disk and fold their manifest entries into
// `manifest`, keyed by path relative to the connection folder.
export function applyPlan(connDir: string, parentRelKey: string, plan: MaterializeChild[], manifest: SapTreeManifest): void {
	for (const child of plan) {
		const relKey = parentRelKey ? `${parentRelKey}/${child.relName}` : child.relName;
		const abs = join(connDir, relKey);
		if (child.isDir) {
			mkdirSync(abs, { recursive: true });
		} else {
			// Create an empty placeholder file; content is hydrated on first open.
			mkdirSync(join(connDir, relKey, ".."), { recursive: true });
			if (!existsSync(abs)) writeFileSync(abs, "");
		}
		if (child.entry) manifest.entries[relKey] = child.entry;
	}
}

// Frontend-facing view of the manifest: which paths are lazy ADT folders and
// which are ADT-backed empty files awaiting hydration, plus the presentation
// metadata the UI needs to render Eclipse-style object labels + icons.
export interface SapTreeManifestEntryView {
	lazy: boolean;
	loaded: boolean;
	hasUri: boolean;
	typeId?: string;
	label?: string;
	description?: string;
}

export interface SapTreeManifestView {
	[relKey: string]: SapTreeManifestEntryView;
}

export function manifestView(manifest: SapTreeManifest): SapTreeManifestView {
	const view: SapTreeManifestView = {};
	for (const [relKey, e] of Object.entries(manifest.entries)) {
		const item: SapTreeManifestEntryView = {
			lazy: e.kind === "package",
			loaded: e.kind === "package" ? Boolean(e.loaded) : true,
			hasUri: e.kind === "object" && Boolean(e.adtUri),
		};
		if (e.kind === "object") {
			if (e.typeId) item.typeId = e.typeId;
			if (e.label) item.label = e.label;
			if (e.description) item.description = e.description;
		}
		view[relKey] = item;
	}
	return view;
}
