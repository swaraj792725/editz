/**
 * M0 exit check on a machine with Premiere: waits for the Editz panel, builds the
 * golden 20-clip sequence through the live bridge, reads it back, prints the score.
 * Run with the MCP daemon stopped (both use port 47800):
 *   pnpm tsx scripts/live-m0.ts ["/path/to/golden media"]
 */
import { join } from "node:path";
import { assertProject } from "@editz/ir";
import { Bridge } from "../apps/daemon/src/bridge.ts";
import { buildSequence } from "../apps/daemon/src/build.ts";
import { ensureToken, workDir } from "../apps/daemon/src/paths.ts";
import { twentyClipProject } from "../packages/ir/test/fixtures.ts";

const bridge = new Bridge({ token: ensureToken() });
await bridge.start();
console.log("Waiting for the Editz panel in Premiere (Window → Extensions → Editz)…");
while (!bridge.connected) await new Promise((r) => setTimeout(r, 500));
const info = bridge.connected;
console.log(`Connected: ${info.backend} · Premiere ${info.appVersion} · project ${info.projectName ?? "(none open)"}`);

const p = assertProject(twentyClipProject(process.argv[2]));
const r = await buildSequence(p, { bridge, outDir: join(workDir(), "m0-live") });
for (const s of r.steps) console.log("  " + s);
if (r.nextStep) console.log("\nNEXT: " + r.nextStep);
if (r.compare) {
  console.log(`\nReadback score ${r.compare.score.toFixed(3)} ${r.compare.match ? "PASS" : "FAIL"}`);
  for (const d of r.compare.diffs) console.log("  " + d);
  if (r.unmatched?.length) console.log("Unmatched imports:", r.unmatched);
}
await bridge.stop();
process.exit(r.compare && !r.compare.match ? 1 : 0);
