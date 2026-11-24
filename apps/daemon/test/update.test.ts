import { describe, expect, it } from "vitest";
import { SNOOZE_MS, isNewer, parseDialog, parseVersion, shortNotes, shouldAsk } from "../src/update-core.ts";

describe("updater helpers", () => {
  it("compares versions numerically", () => {
    expect(parseVersion("v0.1.12")).toEqual([0, 1, 12]);
    expect(parseVersion("0.1")).toBeNull();
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("v0.1.1", "0.1.0")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.5", "0.2.0")).toBe(false);
    expect(isNewer("garbage", "0.1.0")).toBe(false);
    expect(isNewer("0.1.1", "dev")).toBe(true);
  });

  it("snoozes one version only", () => {
    const now = 1_000_000;
    const s = { snoozed: { version: "0.1.3", until: now + SNOOZE_MS } };
    expect(shouldAsk(s, "0.1.3", now)).toBe(false);
    expect(shouldAsk(s, "0.1.3", now + SNOOZE_MS + 1)).toBe(true);
    expect(shouldAsk(s, "0.1.4", now)).toBe(true);
    expect(shouldAsk({}, "0.1.3", now)).toBe(true);
  });

  it("shortens release notes", () => {
    const body = Array.from({ length: 9 }, (_, i) => `- change ${i}`).join("\n") + "\n\nFull Changelog: x";
    const n = shortNotes(body, 3);
    expect(n.split("\n")).toEqual(["• change 0", "• change 1", "• change 2", "…and 6 more"]);
    expect(shortNotes(null)).toBe("");
  });

  it("reads osascript dialog output", () => {
    expect(parseDialog("button returned:Update now, gave up:false\n")).toEqual({ button: "Update now", gaveUp: false });
    expect(parseDialog("button returned:, gave up:true\n")).toEqual({ button: null, gaveUp: true });
    expect(parseDialog("")).toEqual({ button: null, gaveUp: false });
  });
});
