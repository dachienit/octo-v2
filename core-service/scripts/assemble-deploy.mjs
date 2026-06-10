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
const deployDir = join(coreServiceDir, "deploy");
const vendorDir = join(deployDir, "vendor");

console.log("[assemble-deploy] core-service:", coreServiceDir);
console.log("[assemble-deploy] core-agent:  ", coreAgentDir);

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

// 3. Pack @octo/core-agent into a tarball (real files on extract, survives relocation).
const coreAgentDist = join(coreAgentDir, "dist");
if (!existsSync(coreAgentDist)) {
	throw new Error("[assemble-deploy] core-agent/dist not found — run the build first (before-all).");
}
execFileSync("npm", ["pack", "--pack-destination", vendorDir], {
	cwd: coreAgentDir,
	stdio: "inherit",
	shell: process.platform === "win32",
});
const tarball = readdirSync(vendorDir).find((f) => f.endsWith(".tgz"));
if (!tarball) throw new Error("[assemble-deploy] npm pack did not produce a .tgz in vendor/.");
console.log("[assemble-deploy] vendored tarball:", tarball);

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
		"@octo/core-agent": `file:./vendor/${tarball}`,
	},
	engines: { node: ">=22.19.0" },
};
writeFileSync(join(deployDir, "package.json"), `${JSON.stringify(deployPkg, null, 2)}\n`);

console.log("[assemble-deploy] done →", deployDir);
