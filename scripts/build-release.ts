/**
 * Builds the Mac release bundle the installer downloads: dist/editz-mac.tar.gz
 *   editz/editz.mjs    MCP server, one file (all JS deps inlined; runs on plain Node 24)
 *   editz/warmup.mjs   installer step: Python env + core models
 *   editz/worker/      Python worker project (uv sets up its env on the user's Mac)
 *   editz/cep/         Premiere CEP panel
 *   editz/VERSION
 * Usage: pnpm release:build
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const out = join(dist, "editz");
// CI sets EDITZ_VERSION (major.minor from package.json + run number) so every release is newer.
const version = process.env.EDITZ_VERSION || (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string);

rmSync(dist, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// ws and other CJS deps call require() for Node built-ins; give the ESM bundle a real one.
const banner = `import { createRequire as __editzRequire } from "node:module"; const require = __editzRequire(import.meta.url);`;
const entries = [
  ["apps/daemon/src/index.ts", "editz.mjs"],
  ["apps/daemon/src/warmup.ts", "warmup.mjs"],
  ["apps/daemon/src/updater.ts", "updater.mjs"],
] as const;
for (const [entry, file] of entries) {
  await build({
    entryPoints: [join(root, entry)],
    outfile: join(out, file),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: { js: banner },
    // Optional speed-ups ws tries inside try/catch; not shipped.
    external: ["bufferutil", "utf-8-validate"],
    logLevel: "warning",
  });
}

const skip = (src: string) => !/(\/\.venv|\/__pycache__|\/node_modules|\/test|\.DS_Store|package\.json)(\/|$)/.test(src);
cpSync(join(root, "workers/editz-worker"), join(out, "worker"), { recursive: true, filter: skip });
cpSync(join(root, "apps/premiere-cep"), join(out, "cep"), { recursive: true, filter: skip });
writeFileSync(join(out, "VERSION"), version + "\n");

execFileSync("tar", ["-czf", join(dist, "editz-mac.tar.gz"), "-C", dist, "editz"], { stdio: "inherit" });
const sha = execFileSync("shasum", ["-a", "256", join(dist, "editz-mac.tar.gz")], { encoding: "utf8" }).split(" ")[0];
writeFileSync(join(dist, "editz-mac.tar.gz.sha256"), `${sha}  editz-mac.tar.gz\n`);
console.log(`built dist/editz-mac.tar.gz (v${version}) sha256 ${sha}`);
