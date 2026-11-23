import { Project, type ProjectInput, type Sequence, type Track } from "./schema.ts";

export interface IrIssue {
  path: string;
  message: string;
}

/** Parse + semantic checks the schema can't express (refs, overlaps, source bounds). */
export function parseProject(input: unknown): { project?: Project; issues: IrIssue[] } {
  const r = Project.safeParse(input);
  if (!r.success) {
    return {
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  const issues = semanticIssues(r.data);
  return { project: r.data, issues };
}

export function assertProject(input: ProjectInput | unknown): Project {
  const { project, issues } = parseProject(input);
  if (!project || issues.length) {
    throw new Error("Invalid Editz IR:\n" + issues.map((i) => `  ${i.path}: ${i.message}`).join("\n"));
  }
  return project;
}

function semanticIssues(p: Project): IrIssue[] {
  const issues: IrIssue[] = [];
  const media = new Map(p.media.map((m) => [m.id, m]));
  if (media.size !== p.media.length) issues.push({ path: "media", message: "duplicate media ids" });

  const clipIds = new Set<string>();
  p.sequences.forEach((seq, si) => {
    const checkTrack = (t: Track, kind: "video" | "audio", ti: number) => {
      const sorted = [...t.items].sort((a, b) => a.start - b.start);
      sorted.forEach((c, ci) => {
        const path = `sequences.${si}.${kind}.${ti}.items.${c.id}`;
        if (clipIds.has(c.id)) issues.push({ path, message: "duplicate clip id" });
        clipIds.add(c.id);
        const m = media.get(c.media_id);
        if (!m) return issues.push({ path, message: `unknown media_id ${c.media_id}` });
        if (kind === "video" && !m.has_video) issues.push({ path, message: "media has no video" });
        if (kind === "audio" && !m.has_audio) issues.push({ path, message: "media has no audio" });
        if (m.kind !== "image" && c.in + (c.end - c.start) > m.duration) {
          issues.push({ path, message: `source out ${c.in + c.end - c.start} beyond media duration ${m.duration}` });
        }
        const prev = sorted[ci - 1];
        if (prev && prev.end > c.start) issues.push({ path, message: `overlaps ${prev.id}` });
      });
    };
    seq.video.forEach((t, ti) => checkTrack(t, "video", ti));
    seq.audio.forEach((t, ti) => checkTrack(t, "audio", ti));
  });
  return issues;
}

export function sequenceDuration(seq: Sequence): number {
  let d = 0;
  for (const t of [...seq.video, ...seq.audio]) for (const c of t.items) d = Math.max(d, c.end);
  return d;
}
