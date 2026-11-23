#!/usr/bin/env node
/**
 * Editz daemon: MCP server on stdio for Claude + WebSocket bridge for Premiere panels.
 * stdout belongs to MCP. Log to stderr only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseProject, PPRO_TICKS_PER_SECOND, secondsToFrames } from "@editz/ir";
import type { RawSequence } from "@editz/compilers";
import { Bridge } from "./bridge.ts";
import { buildSequence } from "./build.ts";
import { scanFolder } from "./organize.ts";
import { ensureToken, supportDir, workDir } from "./paths.ts";
import { probe } from "./probe.ts";

const log = (m: string) => process.stderr.write(`[editz] ${m}\n`);
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ ...text(msg), isError: true });

const token = ensureToken();
const bridge = new Bridge({ token, port: Number(process.env.EDITZ_PORT ?? 47800), log });
let bridgeError: string | null = null;
try {
  await bridge.start();
  log(`bridge listening on ws://127.0.0.1:${bridge.port}/premiere`);
} catch (e) {
  bridgeError = `Bridge could not start (${(e as Error).message}). Is another Editz already running?`;
  log(bridgeError);
}

const server = new McpServer({ name: "editz", version: "0.0.1" });

server.registerTool(
  "editz_status",
  {
    title: "Editz status",
    description: "Which Premiere Pro versions are installed, whether the Editz panel is connected, and how timelines will be built right now.",
    inputSchema: {},
  },
  async () => text({ ...probe(bridge.connected), bridgeError, supportDir: supportDir(), workDir: workDir() }),
);

server.registerTool(
  "organize_project",
  {
    title: "Organise media into bins",
    description:
      "Scan a folder and sort every media file into the standard Editz bins (01 A-ROLL … 99 UNSORTED). Dry run by default; with apply=true and the panel connected, creates the bins in Premiere and imports each file into its bin. Files on disk are never moved.",
    inputSchema: {
      folder: z.string().describe("Absolute path to the footage folder"),
      apply: z.boolean().default(false).describe("Actually import into Premiere"),
    },
  },
  async ({ folder, apply }) => {
    const plan = scanFolder(folder);
    const summary = Object.fromEntries(Object.entries(plan.byBin).map(([b, f]) => [b, f.length]));
    const lowConfidence = plan.items.filter((i) => i.confidence < 0.5).map((i) => ({ path: i.path, reason: i.reason }));
    if (!apply) return text({ applied: false, summary, lowConfidence, items: plan.items, skipped: plan.skipped });
    if (bridge.connected?.backend !== "cep") return fail("Premiere panel (CEP) not connected, so nothing was imported. Run editz_status for help, or use apply=false to just see the plan.");
    await bridge.request("ensureBins", { paths: Object.keys(plan.byBin) });
    const results: Record<string, boolean> = {};
    for (const [bin, files] of Object.entries(plan.byBin)) {
      const r = await bridge.request<{ ok: boolean }>("importFiles", { paths: files, bin }, 600_000);
      results[bin] = r.ok;
    }
    return text({ applied: true, summary, importOk: results, lowConfidence });
  },
);

server.registerTool(
  "build_sequence",
  {
    title: "Build a timeline in Premiere",
    description:
      "Build a sequence from an Editz Timeline IR (v1). With the CEP panel connected: imports, files clips into bins and reads the timeline back to prove it matches. Otherwise writes an FCP7 XML that any Premiere version can import and says which menu to click.",
    inputSchema: {
      ir: z.any().optional().describe("Editz IR project object"),
      ir_path: z.string().optional().describe("Path to an IR .json file (instead of ir)"),
      sequence: z.string().optional().describe("Sequence name to build (default: first)"),
      out_dir: z.string().optional(),
    },
  },
  async ({ ir, ir_path, sequence, out_dir }) => {
    const input = ir ?? (ir_path ? JSON.parse(readFileSync(ir_path, "utf8")) : undefined);
    if (!input) return fail("Pass ir or ir_path.");
    const { project, issues } = parseProject(input);
    if (!project || issues.length) return fail("IR is invalid:\n" + issues.map((i) => `${i.path}: ${i.message}`).join("\n"));
    const outDir = out_dir ?? join(workDir(), project.name, "timelines");
    try {
      return text(await buildSequence(project, { bridge, outDir, sequence }));
    } catch (e) {
      return fail(`Build failed: ${(e as Error).message}`);
    }
  },
);

server.registerTool(
  "readback_sequence",
  {
    title: "Read a timeline back",
    description: "Read clips and markers from a Premiere sequence. Times in seconds, plus frames if fps is given.",
    inputSchema: {
      name: z.string(),
      fps_num: z.number().int().positive().optional(),
      fps_den: z.number().int().positive().optional(),
    },
  },
  async ({ name, fps_num, fps_den }) => {
    if (!bridge.connected) return fail("Premiere panel not connected.");
    const raw = await bridge.request<RawSequence>("readSequence", { name });
    const rate = fps_num ? { num: fps_num, den: fps_den ?? 1 } : null;
    const sec = (t: string) => Number(BigInt(t) * 1000n / BigInt(PPRO_TICKS_PER_SECOND)) / 1000;
    const conv = (t: string) => (rate ? { s: sec(t), f: secondsToFrames(sec(t), rate) } : { s: sec(t) });
    const track = (items: RawSequence["video"][number]) =>
      items.map((c) => ({ name: c.name, path: c.mediaPath, start: conv(c.start), end: conv(c.end), in: conv(c.inPoint) }));
    return text({ name: raw.name, video: raw.video.map(track), audio: raw.audio.map(track), markers: raw.markers.map((m) => ({ name: m.name, at: conv(m.start) })) });
  },
);

server.registerTool(
  "add_markers",
  {
    title: "Add sequence markers",
    description: "Add named markers to a Premiere sequence (e.g. Hook, CTA, beat points).",
    inputSchema: {
      sequence: z.string(),
      markers: z.array(z.object({ seconds: z.number().min(0), name: z.string(), comment: z.string().default(""), duration_seconds: z.number().min(0).default(0) })),
    },
  },
  async ({ sequence, markers }) => {
    if (!bridge.connected) return fail("Premiere panel not connected.");
    const r = await bridge.request("addMarkers", {
      sequence,
      markers: markers.map((m) => ({ seconds: m.seconds, name: m.name, comment: m.comment, durationSeconds: m.duration_seconds })),
    });
    return text(r);
  },
);

server.registerTool(
  "export_sequence",
  {
    title: "Export a sequence",
    description: "Render a sequence to a file with a Premiere/Media Encoder preset (.epr). Blocks until Premiere finishes.",
    inputSchema: { sequence: z.string(), out_path: z.string(), preset_path: z.string() },
  },
  async ({ sequence, out_path, preset_path }) => {
    if (!bridge.connected) return fail("Premiere panel not connected.");
    return text(await bridge.request("exportSequence", { sequence, outPath: out_path, presetPath: preset_path }, 3_600_000));
  },
);

await server.connect(new StdioServerTransport());
log("MCP server ready on stdio");

const shutdown = async () => {
  await bridge.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Client went away (Claude closed): free port 47800 for the next run.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
