# M0 spike: status and live test

## What M0 is

M0 proves one Timeline IR builds the same golden 20-clip sequence on three Premiere bridges:

| Bridge | Premiere versions | How the sequence is built | Proven how |
|---|---|---|---|
| XML file | All (CS5+) | Writes FCP7 XML with sorted bins, then the user does File → Import | Offline round-trip test (emit → parse → compare) scores 1.0. **Not yet imported into a real Premiere.** |
| CEP / ExtendScript | CC 2018 (12.0) – 25.x | Live import, then clips are filed into bins and the sequence is read back | ES3 host lib runs against a mock Premiere object model, and the full flow scores 1.0. **Needs a live run.** |
| UXP | 25.6+ | Hello-world only (connect, auth, `info`). Builds use the XML file bridge until M1. | **Needs a live run.** |

Offline checks: `pnpm test` (48 tests), `pnpm typecheck`, `pnpm lint:jsx` (ES3 parse of the host lib).

## Layout

```
packages/ir          Timeline IR v1 (zod), time math (frames ↔ Premiere ticks), validation, snapshot compare
packages/compilers   FCP7 XML emit/parse, op protocol shared by CEP + UXP, import move planner
apps/premiere-cep    CEP panel (WebSocket client) + host/editz.jsx (ES3 ExtendScript ops)
apps/premiere-uxp    UXP panel hello-world (manifest v5)
apps/daemon          MCP server (stdio) + bridge (ws://127.0.0.1:47800/premiere, token auth)
scripts/             build-golden, make-golden-media.sh, install-cep.sh, live-m0.ts, check-extendscript
```

## Live test on a Mac with Premiere

1. Install the dependencies and generate the golden media. This needs the free tool ffmpeg.
   ```bash
   pnpm install
   ```
   ```bash
   brew install ffmpeg
   ```
   ```bash
   ./scripts/make-golden-media.sh
   ```
2. Install the CEP panel. It's a symlink plus PlayerDebugMode, which allows unsigned panels.
   ```bash
   ./scripts/install-cep.sh
   ```
   Restart Premiere. Open or create any project, then open **Window → Extensions → Editz**.
3. Run the exit check.
   ```bash
   pnpm tsx scripts/live-m0.ts
   ```
   - On success it prints `Readback score 1.000 PASS`.
   - On failure it prints each diff, for example `video2: expected broll_01.mp4 [60,150) in=24, got …`.
   - The bins should match: 01 A-ROLL, 02 B-ROLL/Own, 03 MUSIC, 04 VOICE-OVER, 09 SEQUENCES, with no leftover import bin.
4. Test the XML file bridge, which works on any version:
   ```bash
   pnpm golden
   ```
   In Premiere, choose File → Import → `golden/golden-20.xml`. Check that you see 20 clips on V1, V2, A1, A2 and A3 (plus the 10 linked A-roll audio clips on A1), three markers (Hook, Middle, CTA), and the four media bins.
5. Test UXP, on 25.6+ only.
   1. Load `apps/premiere-uxp` with the free Adobe UXP Developer Tool (Add Plugin → manifest.json → Load).
   2. Start the daemon (step 6). `editz_status` should show `backend: "uxp"`.
6. Use it from Claude. Add the daemon as an MCP server; for Claude Code, use `.mcp.json` in the repo root:
   ```json
   { "mcpServers": { "editz": { "command": "pnpm", "args": ["--silent", "daemon"] } } }
   ```
   Tools:
   - `editz_status`
   - `organize_project`: a dry run by default. `apply: true` imports into bins.
   - `build_sequence`
   - `readback_sequence`
   - `add_markers`
   - `export_sequence`

## Things to watch in the live run (known risks)

- **Media frame rate in the XML:** the emitter writes the sequence rate into each `<file>` element. Media at a different native rate may import with in-points shifted, so the readback diff will show it. The fix is to probe the media rate in M1.
- **What `importFiles` returns for an XML import:** the host finds new items by comparing the root bins before and after the import. If Premiere 2018/2019 puts the imported items straight into the root without a wrapper bin, the move plan still works. Check that no stray items are left behind.
- **`projectItem.getMediaPath()` on track items:** this is needed to match clips. Some builds return an empty string for clips that aren't linked.
- **`exportAsMediaDirect`:** it's synchronous and blocks the panel. Long renders need AME queueing (M1).
- **Marker readback:** this uses `getFirstMarker`/`getNextMarker`. Older builds may need `markers[i]` instead.
