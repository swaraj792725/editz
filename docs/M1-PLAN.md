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

## S2 decisions
- Python worker `workers/editz-worker` (uv, JSON lines over stdio: `ping`, `transcribe`, `tts`, `voices`, `unload`). Started lazily by the daemon under `taskpolicy -b`, with `PYTHONPATH` + `cwd` set to the worker dir. Progress goes to the log and to MCP `notifications/progress` when the client sends a `progressToken`.
- ASR: `mlx-whisper` `large-v3-turbo`, word timings, verbatim prompt so "um"/"uh" survive to be cut. TTS: `kokoro-onnx` (no torch; uv `override-dependencies`). Models in `<supportDir>/models` (`hf/`, `kokoro/`).
- Transcripts cached in the Media Index per checksum + model + language + verbatim, and written as JSON under `<work>/.cache/transcripts`.
- Every built timeline saves its IR beside the XML as `<name>.editz.json`; later tools (`create_captions`, `generate_voiceover`, `audio_mix`) take `ir_path`.
- VO: one WAV per script paragraph, two-pass loudness (measure, exact gain, limiter only if needed) → −16 LUFS, ≤ −1.5 dBTP, 48 kHz mono. One-pass loudnorm missed by 2–4 LU on short takes.
- VO track: track named "VO", else a VO-only track, else A2 if empty, else a new "VO" track. Overlap is an error, not a silent shift.
- Ducking: piecewise-linear dB envelope per music clip (default −15 dB, 0.25 s attack, 0.5 s release, gaps < 1.2 s stay ducked), emitted as FCP7 "Audio Levels" keyframes. [verify] keyframe `<when>` units in Premiere import.
- Captions: SRT/VTT written beside the XML (42 chars, 2 lines, 17 cps), QC'd; import into Premiere is a manual step for now (`nextStep`).

## S2 status (done, pending Premiere check)
- Tools: `transcribe`, `remove_filler`, `create_captions`, `list_voices`, `generate_voiceover`, `audio_mix`.
- Code: `workers/editz-worker/`, `apps/daemon/src/worker.ts`, `src/speech/` (transcript, captions, service), `src/edit/{voiceover,mix}.ts`.
- Checks: 25 new tests (fake-worker protocol, fillers, captions, ducking emit, VO placement); gated real-worker test `EDITZ_REAL_WORKER=1`. MCP smoke on a real talk: 4 filler cuts, QC pass, captions + VO on A2.
- Not yet: CEP caption import; Audio Levels keyframes and captions checked inside Premiere; full 10-min talk run.

## S3 decisions
- Vision: SigLIP 2 base/224 (Apache-2.0) through ONNX Runtime, no torch. Vision fp32 (372 MB), text int8 (283 MB, cos ≥ 0.995 vs fp16). Worker methods `embed_images`, `embed_texts`; vectors are L2-normalised float32, base64.
- Frames: one per shot (S1 scene cuts) plus one every 2 s, capped at 24 per clip; 224² JPEGs in `<supportDir>/cache/frames/<checksum>/`. Embeddings in the Media Index (`frame_vectors`, BLOBs), text embeddings cached (`text_vectors`). Search is brute-force cosine in JS: fine to ~100k frames; sqlite-vec deferred.
- Scores: SigLIP's calibrated sigmoid (`exp(4.7245)·cos − 16.77`) is too strict for generic labels ("a bird" on an owl = 1%), so ranking and tags use a fixed cosine ramp (0.04 → 0, 0.16 → 1). Tags keep fit ≥ 0.5, max 8. The calibrated value is still returned as `confidence`.
- Mood: 16 moods, each the mean of two prompt wordings; softmax (T = 100) across moods per frame, averaged over frames; fit = share / the clip's top share. Any word works as a search mood (added to the set for that query).
- Look: pure TS on 64×36 raw RGB at 2 fps: brightness, contrast, saturation, warmth, 5-colour Lab k-means palette, in-shot motion, cuts/min → plain words. `look` search takes words or a colour name / hex.
- `search_media` weights: content 0.5, mood 0.25, look 0.15, like 0.1, renormalised over what was asked. Returns the best moment (`at_s`) and its frame.
- Proxies: H.264 (VideoToolbox, libx264 fallback), short side 540, same fps and audio channel count, `_Proxy.mp4` in a `Proxies` folder beside the clip. CEP op `attachProxies` matches project items by media path and reads back `hasProxy()`; UXP and no-panel get a manual `next_step`.

## S3 status (done; Premiere proxy attach not yet tried in a real Premiere)
- Tools: `tag_media`, `search_media`, `make_proxies`; `analyze_media` gains kind `look`.
- Code: `workers/editz-worker/editz_worker/vision.py`, `src/media/{visual,look,proxy}.ts`, Media Index vector tables, CEP `attachProxies`.
- Checks: 13 new tests (frame sampling, Lab/k-means/look fit, scoring, fake-model search by content/mood/look/likeness, proxy encode, mock-Premiere attach). Real-model smoke on stills + a clip: 6 files tagged in 7 s (model warm), owl→bird, sunflower→flowers, sensible mood/look ranking.
- Done-when check passed on 10 CC0/public-domain Wikimedia Commons clips: 5 café clips (latte art ×2, Rateel café ×2, milk heating) and 5 contrast clips (storm, fireworks, snowy forest, child playing, coffee-shop lesson). 10 files tagged in 9 s with the model warm.
  - mood "cozy" → the 3 café clips come first (latte flower 0.86, Rateel café 0.76, latte leaf 0.61). "dramatic" → storm, fireworks, snow. "playful" → child.
  - query "coffee" / "latte art" / "a café" → café clips first. "a café" + "cozy" → café clips first.
  - Tags: latte art 1.0, barista 0.82, café 0.59.
- Fixes from the check: added `.ogv` to the video types (the latte clips had been skipped); added café tags (latte art, barista making coffee, espresso machine).
- Known weak spots:
  - Mood fit is relative to each clip's own top mood, so several clips can tie at 1.0 (e.g. "warm", "dramatic").
  - "calm" scores low everywhere (best 0.24).
  - The milk-heating clip gets no tags.
  - The tag list is small (no "owl", no "guitar").
- Not yet: `attachProxy` inside a real Premiere.
