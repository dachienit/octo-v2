// Assemble a self-contained Cloud Foundry deploy folder for core-service.
//
// Why: the CF nodejs buildpack relocates node_modules to /home/vcap/deps/0 and
// breaks npm-workspace symlinks, so `@octo/core-agent` cannot be resolved at runtime
// when the monorepo is pushed as-is. Instead we vendor `@octo/core-agent` as an
// `npm pack` tarball and reference it via `file:` — npm EXTRACTS a tarball into
// node_modules as real files (not a symlink), so it survives the relocation, and
// core-agent's own deps (@earendil-works/pi-*, typebox, diff) are installed from the
// registry automatically.
//
// Output: ./deploy (mirrors core-service: dist/ + templates/ + package.json + vendor/).
// mbt packages this folder (build-result: deploy) as the octo-srv module.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const coreServiceDir = resolve(scriptDir, "..");
const coreAgentDir = resolve(coreServiceDir, "..", "core-agent");
// adt-cli lives OUTSIDE the monorepo tree (sibling of octo-v2), so it is vendored
// the same way as core-agent: npm pack -> tarball -> file: reference.
const adtCliDir = resolve(coreServiceDir, "..", "..", "adt-cli");
const deployDir = join(coreServiceDir, "deploy");
const vendorDir = join(deployDir, "vendor");

console.log("[assemble-deploy] core-service:", coreServiceDir);
console.log("[assemble-deploy] core-agent:  ", coreAgentDir);
console.log("[assemble-deploy] adt-cli:     ", adtCliDir);

// 1. Reset deploy/ and create vendor/.
rmSync(deployDir, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });

// 2. Copy the runtime payload (mirror core-service layout so relative paths hold).
const distDir = join(coreServiceDir, "dist");
if (!existsSync(distDir)) {
	throw new Error("[assemble-deploy] core-service/dist not found — run the build first (before-all).");
}
cpSync(distDir, join(deployDir, "dist"), { recursive: true });
const templatesDir = join(coreServiceDir, "templates");
if (existsSync(templatesDir)) {
	cpSync(templatesDir, join(deployDir, "templates"), { recursive: true });
}

// 3. Pack vendored deps into tarballs (real files on extract, survive relocation).
//    Each pack returns exactly one .tgz; we capture it by diffing vendor/ before/after
//    so the two tarballs never get confused with each other.
function packInto(srcDir, label) {
	const before = new Set(readdirSync(vendorDir).filter((f) => f.endsWith(".tgz")));
	execFileSync("npm", ["pack", "--pack-destination", vendorDir], {
		cwd: srcDir,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	const produced = readdirSync(vendorDir)
		.filter((f) => f.endsWith(".tgz") && !before.has(f));
	if (produced.length !== 1) {
		throw new Error(`[assemble-deploy] expected exactly one new .tgz for ${label}, got ${produced.length}.`);
	}
	console.log(`[assemble-deploy] vendored ${label}:`, produced[0]);
	return produced[0];
}

// 3a. @octo/core-agent (built TypeScript — needs dist/).
const coreAgentDist = join(coreAgentDir, "dist");
if (!existsSync(coreAgentDist)) {
	throw new Error("[assemble-deploy] core-agent/dist not found — run the build first (before-all).");
}
const coreAgentTarball = packInto(coreAgentDir, "@octo/core-agent");

// 3b. adt-cli (plain JS — no build step). The package.json `files` allowlist keeps the
//     local PP test harness and any service-key files out of the tarball.
if (!existsSync(join(adtCliDir, "package.json"))) {
	throw new Error(`[assemble-deploy] adt-cli not found at ${adtCliDir} (expected sibling of octo-v2).`);
}
const adtCliTarball = packInto(adtCliDir, "adt-cli");

// 4. Generate a self-contained deploy package.json.
const pkg = JSON.parse(readFileSync(join(coreServiceDir, "package.json"), "utf8"));
const deployPkg = {
	name: pkg.name,
	version: pkg.version,
	description: pkg.description,
	private: true,
	type: pkg.type,
	main: pkg.main,
	dependencies: {
		...pkg.dependencies,
		"@octo/core-agent": `file:./vendor/${coreAgentTarball}`,
		"adt-cli": `file:./vendor/${adtCliTarball}`,
	},
	engines: { node: ">=22.19.0" },
};
writeFileSync(join(deployDir, "package.json"), `${JSON.stringify(deployPkg, null, 2)}\n`);

console.log("[assemble-deploy] done →", deployDir);
