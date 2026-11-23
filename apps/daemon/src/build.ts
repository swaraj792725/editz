import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareSnapshots, snapshotFromIr, type CompareResult, type Project } from "@editz/ir";
import {
  binPaths,
  planImportedMoves,
  projectToFcp7Xml,
  snapshotFromRaw,
  SEQUENCE_BIN,
  type HostInfo,
  type ImportedItem,
  type OpName,
  type RawSequence,
} from "@editz/compilers";

/** What build needs from the bridge; lets tests use a fake. */
export interface Requester {
  readonly connected: HostInfo | null;
  request<T = unknown>(op: OpName, args?: object, timeoutMs?: number): Promise<T>;
}

export interface BuildResult {
  route: "cep-live" | "xml-guided";
  sequence: string;
  xmlPath: string;
  steps: string[];
  compare?: CompareResult;
  unmatched?: string[];
  /** Plain-language instruction when the user has to click something. */
  nextStep?: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sequence";

/** "Main" → "Main (2)" if taken, so readback finds *our* sequence, never an older one. */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} (${i})`)) return `${name} (${i})`;
}

export async function buildSequence(project: Project, opts: { bridge?: Requester; outDir: string; sequence?: string; now?: Date }): Promise<BuildResult> {
  const src = opts.sequence ? project.sequences.find((s) => s.name === opts.sequence) : project.sequences[0];
  if (!src) throw new Error(`Sequence not in IR: ${opts.sequence}`);
  mkdirSync(opts.outDir, { recursive: true });
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const steps: string[] = [];
  const live = opts.bridge?.connected;

  if (!live || live.backend !== "cep") {
    // File-interchange tier: every Premiere version imports FCP7 XML.
    const xmlPath = join(opts.outDir, `${slug(project.name)}-${slug(src.name)}-${stamp}.xml`);
    writeFileSync(xmlPath, projectToFcp7Xml(project, { includeBins: true, sequences: [src.name] }));
    steps.push(`wrote ${xmlPath}`);
    return {
      route: "xml-guided",
      sequence: src.name,
      xmlPath,
      steps,
      nextStep: `In Premiere Pro choose File → Import…, pick "${xmlPath}", then open the sequence "${src.name}". Bins come in already sorted.`,
    };
  }

  const bridge = opts.bridge!;
  const { sequences } = await bridge.request<{ sequences: { name: string }[] }>("listSequences");
  const name = uniqueName(src.name, new Set(sequences.map((s) => s.name)));
  if (name !== src.name) steps.push(`"${src.name}" already exists; building as "${name}"`);
  const seq = { ...src, name };
  const p: Project = { ...project, sequences: [seq] };

  const xmlPath = join(opts.outDir, `${slug(project.name)}-${slug(name)}-${stamp}.xml`);
  writeFileSync(xmlPath, projectToFcp7Xml(p));
  steps.push(`wrote ${xmlPath}`);

  await bridge.request("ensureBins", { paths: binPaths(p, [SEQUENCE_BIN]) });
  steps.push("bins ready");

  const { items } = await bridge.request<{ items: ImportedItem[] }>("importXml", { path: xmlPath }, 300_000);
  steps.push(`imported ${items.length} items`);

  const plan = planImportedMoves(p, items);
  if (plan.moves.length) {
    const r = await bridge.request<{ moved: number; missing: string[] }>("moveItems", { moves: plan.moves }, 120_000);
    steps.push(`moved ${r.moved} items into bins`);
  }
  if (plan.deleteBins.length) {
    const r = await bridge.request<{ deleted: number }>("deleteBins", { nodeIds: plan.deleteBins });
    steps.push(`removed ${r.deleted} empty import bins`);
  }

  const raw = await bridge.request<RawSequence>("readSequence", { name }, 120_000);
  const compare = compareSnapshots(snapshotFromIr(p, seq), snapshotFromRaw(raw, seq.rate));
  steps.push(`readback ${compare.match ? "matches" : "differs"} (score ${compare.score.toFixed(3)})`);
  return {
    route: "cep-live",
    sequence: name,
    xmlPath,
    steps,
    compare,
    unmatched: plan.unmatched.map((u) => u.mediaPath ?? u.name),
  };
}
