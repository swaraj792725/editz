# M1 MVP plan

M1 = PRD FR-01..15 + FR-29/30. Exit: scenarios 1, 2, 4, 7 pass QC after one storyboard approval, $0 extra spend.
Built in vertical slices. Each slice ends with tests green and a tool Claude can call.

| Slice | Scope | FRs | Done when |
|---|---|---|---|
| **S1 Media foundation** ✅ | FFmpeg layer (probe, silence, loudness, scene cuts, contact sheets), Media Index (SQLite, analyse-once by checksum), background QoS, `remove_silence` → IR, QC v0 (gaps, offline, format, loudness) | FR-04, 06 (part), 09 (part), 15 (part), 30 (part) | `ingest_media`, `analyze_media`, `contact_sheet`, `remove_silence`, `run_qc` work on real files |
| S2 Ears + voice | Python worker runtime (uv, JSON over stdio), Whisper word timings, filler removal, captions (SRT, 42 chars / 17 cps / 2 lines), Kokoro VO placed on A2 with ducking | FR-06, 09, 10, 11 | 10-min talk → cut + captions + VO pass QC |
| S3 Eyes + mood | Proxies, SigLIP 2 tags + mood, colour profile, `search_media` | FR-06 | Café clips tagged and searchable by mood |
| S4 Free media | Openverse, Wikimedia, NASA, Internet Archive (keyless); Pexels/Pixabay/Freesound (free key); mood scoring; music library; licence ledger; credits | FR-12, 13 | "rainy Tokyo, moody blue" returns ranked, licensed clips |
| S5 Autopilot | `start_brief` (≤ 5 questions), `make_storyboard` + local review page, `approve`, plain-language feedback → IR diff, snapshots, `undo_last`, undo everything | FR-07, 08, 15 | Scenario 1 end to end with one approval |
| S6 Delivery | Export presets (AME via ExtendScript, FFmpeg draft), metadata pack, full QC, Claude Code plugin + Desktop extension, Craft Skills v0 | FR-14, 15 | Scenario 2 and 7 deliver |
| S7 Zero-skill | Doctor self-test + repair, hardware tier, model download manager, governor (RAM cap, one heavy model, pause on playback), sample render | FR-29, 30 | Fresh Mac → first video without Terminal |

## S1 decisions
- FFmpeg found as `EDITZ_FFMPEG`/`EDITZ_FFPROBE` → bundled `<supportDir>/bin` → `PATH`. The installer (S7) bundles it.
- Heavy jobs run under `taskpolicy -b` on macOS (efficiency cores, background I/O), so Premiere stays smooth.
- Media Index: `node:sqlite` (no native build), at `<supportDir>/media-index.sqlite`. Key = fast checksum (size + SHA-256 of first and last 4 MB). Analysis results are cached per checksum and per analysis version.
- `remove_silence` builds an IR sequence (keeps speech ranges with handles, merges short gaps), then hands it to `build_sequence`, so every Premiere tier gets it.
- QC v0 runs on the IR (gaps, offline media, format) and on a rendered file (integrated loudness, true peak). Blocking issues fail the run.

## S1 status (done)
- Tools: `ingest_media`, `analyze_media`, `contact_sheet`, `remove_silence`, `run_qc`.
- Code: `apps/daemon/src/media/` (ffmpeg, index-db, analyze), `src/edit/silence-cut.ts`, `src/qc.ts`.
- Checks: 64 tests (16 new, 5 run real FFmpeg on generated media), MCP stdio smoke via `pnpm smoke <tool> '<json>'`.
- Scene detection decodes every frame (keyframe-only was off by up to half a second), at 320 px, VideoToolbox decode on Mac.
- Not yet: captions, filler words (need transcripts, S2); media frame rate ≠ sequence rate in XML (S1 avoids it by building the sequence at the source's rate).
