// SAP Logon landscape parser — discovers on-prem ABAP systems and their ADT
// HTTP(S) endpoints for the LOCAL (SSO) connect flow.
//
// Why: the local flow connects directly to an on-prem ABAP system over the ADT
// HTTP API using Kerberos/SPNEGO SSO (no password). The developer's SAP Logon
// already knows every system. The base `SAPUILandscape.xml` only holds RFC/DIAG
// coordinates, but its <Include> files carry real web URLs per system:
//   - sapbc.xml        -> type="NWBC"  url="https://<sid>.bshg.com/sap/bc/ui2/nwbc"
//   - saplaunchpad.xml -> type="FIORI" url="https://<sid>.wdisp.bosch.com/sap/bc/ui2/flp"
//   - sapcloud.xml     -> cloud/web entries
// The ADT base is the same origin: `https://host[:port]` (commands append
// `/sap/bc/adt/...`). The Kerberos SPN is the system's SNC name, taken from the
// SAPGUI entries' `sncname="p:CN=<SID>SNCAD@REALM"` (verified on this landscape),
// with a `SAP/<SID>SNCAD` convention fallback.
//
// Pure file parsing (no network). Regex-based to avoid an XML dependency: the
// landscape <Service> elements are flat attribute lists.

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export interface SapLocalSystem {
	systemId: string;
	client?: string;
	/** ADT base URL, e.g. https://s1r.wdisp.bosch.com (no trailing path). */
	adtUrl: string;
	/** Kerberos service principal, e.g. SAP/S1RSNCAD. */
	spn: string;
	description?: string;
	/** Service type the URL came from (FIORI / NWBC / ...). */
	type?: string;
	/** Landscape file the entry came from (for diagnostics). */
	source?: string;
}

interface ServiceAttrs {
	[key: string]: string;
}

const ATTR_RE = /([\w:-]+)\s*=\s*"([^"]*)"/g;
const SERVICE_RE = /<Service\b([^>]*?)\/?>/gi;
const INCLUDE_RE = /<Include\b([^>]*?)\/?>/gi;

function parseAttrs(raw: string): ServiceAttrs {
	const out: ServiceAttrs = {};
	let m: RegExpExecArray | null;
	ATTR_RE.lastIndex = 0;
	while ((m = ATTR_RE.exec(raw)) !== null) out[m[1].toLowerCase()] = m[2];
	return out;
}

// Resolve the root SAPUILandscape.xml path (env override wins for tests).
function resolveRootFile(): string | undefined {
	if (process.env.SAP_LANDSCAPE_FILE) return process.env.SAP_LANDSCAPE_FILE;
	const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
	const root = join(appData, "SAP", "Common", "SAPUILandscape.xml");
	return existsSync(root) ? root : undefined;
}

// Collect the set of landscape files to scan: the root, its <Include> targets,
// plus the well-known sibling files that carry SNC names (Central/Global), even
// when they are not referenced by an <Include>.
function collectFiles(rootFile: string): string[] {
	const files = new Set<string>();
	const dir = dirname(rootFile);
	const tryAdd = (p: string) => {
		if (p && existsSync(p)) files.add(p);
	};
	tryAdd(rootFile);
	for (const sibling of ["sapbc.xml", "saplaunchpad.xml", "sapcloud.xml", "sapgui.xml", "SAPUILandscapeGlobal.xml", "SAPUILandscapeCentral.xml"]) {
		tryAdd(join(dir, sibling));
	}
	try {
		const xml = readFileSync(rootFile, "utf8");
		let m: RegExpExecArray | null;
		INCLUDE_RE.lastIndex = 0;
		while ((m = INCLUDE_RE.exec(xml)) !== null) {
			const url = parseAttrs(m[1]).url;
			if (!url) continue;
			try {
				tryAdd(url.startsWith("file:") ? fileURLToPath(url) : join(dir, url));
			} catch {
				/* ignore malformed include url */
			}
		}
	} catch {
		/* root unreadable -> just use the siblings we added */
	}
	return [...files];
}

// p:CN=S1RSNCAD@DE.BOSCH.COM -> S1RSNCAD
function sncCommonName(sncname?: string): string | undefined {
	if (!sncname) return undefined;
	const m = sncname.match(/CN=([^@,/]+)/i);
	return m ? m[1].trim() : undefined;
}

function originOf(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

/**
 * List on-prem ABAP systems known to the local SAP Logon, each with its ADT base
 * URL and Kerberos SPN, ready for `adt auth login basicsso`. Deduplicated by
 * (systemId, client). Returns [] if no landscape is found.
 */
export function listLocalSapSystems(): SapLocalSystem[] {
	const root = resolveRootFile();
	if (!root) return [];

	const sncBySid = new Map<string, string>(); // systemId -> SNC common name
	const webByKey = new Map<string, SapLocalSystem>(); // `${sid}|${client}` -> system

	for (const file of collectFiles(root)) {
		let xml: string;
		try {
			xml = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const tag = file.split(/[\\/]/).pop() || file;
		let m: RegExpExecArray | null;
		SERVICE_RE.lastIndex = 0;
		while ((m = SERVICE_RE.exec(xml)) !== null) {
			const a = parseAttrs(m[1]);
			const sid = (a.systemid || "").toUpperCase();
			if (!sid) continue;

			// Capture SNC name from any entry that carries one (SAPGUI services).
			const cn = sncCommonName(a.sncname);
			if (cn && !sncBySid.has(sid)) sncBySid.set(sid, cn);

			// Web entries (have a usable http(s) URL) become connectable systems.
			const origin = a.url ? originOf(a.url) : undefined;
			if (!origin || !/^https?:/i.test(origin)) continue;
			const key = `${sid}|${a.client || ""}`;
			if (!webByKey.has(key)) {
				webByKey.set(key, {
					systemId: sid,
					client: a.client || undefined,
					adtUrl: origin,
					spn: "", // resolved after the full scan (SNC map may fill later)
					description: a.description || a.name || undefined,
					type: a.type || undefined,
					source: tag,
				});
			}
		}
	}

	const systems = [...webByKey.values()].map((s) => {
		const cn = sncBySid.get(s.systemId);
		// SPN: use the landscape SNC name only when it looks like an ABAP SNC app-server
		// identity (ends with SNCAD); otherwise fall back to the SAP/<SID>SNCAD convention.
		// (Some legacy entries carry a generic CN=SAP which would yield a bogus SAP/SAP.)
		s.spn = cn && /SNCAD$/i.test(cn) ? `SAP/${cn}` : `SAP/${s.systemId}SNCAD`;
		return s;
	});
	systems.sort((a, b) => a.systemId.localeCompare(b.systemId) || (a.client || "").localeCompare(b.client || ""));
	return systems;
}
