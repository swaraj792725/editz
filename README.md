# Editz

Editz lets Claude edit your Adobe Premiere Pro project for you. Ask in plain words and it gets on with it:

- sort your footage into bins
- cut out the silences
- add captions
- record a voiceover
- find shots by mood

All the AI runs on your own Mac. Nothing extra to pay for: you only need your Claude and Adobe subscriptions.

> **Early test build.** It is still being built. This is the first time it will run inside a real copy of Premiere, so expect rough edges. Please report what breaks.

---

## Install on a Mac

### What you need

- A Mac with an **Apple chip** (M1, M2, M3 or M4). To check: Apple menu → About This Mac. It should say "Chip: Apple M…". Intel Macs are not supported yet.
- **macOS 14 (Sonoma) or newer.**
- The **Claude desktop app**, installed and signed in. Get it from [claude.ai/download](https://claude.ai/download).
- **Adobe Premiere Pro.**
- About **8 GB of free disk space**. The AI models are large.
- About **15–30 minutes** on a normal internet connection. You don't need to watch it.

You don't need to be an admin, and you don't need any coding tools.

### Steps

1. Open **Terminal**. Press **Cmd + Space**, type `Terminal`, then press **Return**.
2. Copy the line below, paste it into Terminal (**Cmd + V**), then press **Return**:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/swaraj792725/editz/main/install.sh | bash
   ```

3. Wait until it says **"Editz is installed."** It works through 7 steps and prints a ✓ after each one. The AI model downloads take the longest.
4. **Quit Claude completely** (Cmd + Q), then open it again.
5. **Quit Premiere Pro** if it's open, then open it again.
6. In Premiere, open the panel: **Window → Extensions → Editz**. On newer Premiere versions the menu may be called **Extensions (Legacy)**. Leave that small panel open while you work.
7. In Claude, start a new chat and type: **Check Editz status**

### Things to try

- "Organise the footage in my Desktop/Shoot folder into bins"
- "Cut the silences out of interview.mp4"
- "Add captions to this sequence"
- "Find calm, warm shots of coffee in my footage"

Editz saves what it makes in **Movies → Editz**.

### If something goes wrong

- **The installer stopped with a red ✗.** Run the same line again. It picks up where it left off. If it still fails, take a screenshot of the Terminal window and send it.
- **Claude doesn't know about Editz.** Quit Claude with Cmd + Q (closing the window is not enough), then open it again.
- **There's no Editz entry in Premiere's Extensions menu.** Quit Premiere and open it again. If it's still missing, Claude can still build your timeline as a file you import with **File → Import**.

### Updates

Editz checks for a new version every 30 minutes. When one is out, a small window pops up with what changed and two buttons: **Update now** or **Later**.

- **Update now** installs it in the background, then offers to restart Claude. If Premiere is open, restart it once your project is saved.
- **Later** asks again in a few hours.

You can also update any time by running the install line again.

### Uninstall

Paste this into Terminal and press Return:

```bash
curl -fsSL https://raw.githubusercontent.com/swaraj792725/editz/main/install.sh | bash -s -- --uninstall
```

This removes Editz, its AI models and the Premiere panel, and takes Editz out of Claude's settings. Your videos and anything in **Movies → Editz** are not touched.

### What the installer puts on your Mac

Everything goes in `~/Library/Application Support/Editz`. Nothing is installed system-wide. The installer checks every download against a fixed checksum before using it:

| What | Why | From |
|---|---|---|
| Node.js 24 | Runs Editz | nodejs.org |
| uv | Sets up Python for the local AI | GitHub (astral-sh/uv) |
| FFmpeg 9.1 | Reads and writes video | ffmpeg.martin-riedl.de (signed Apple Silicon builds) |
| Editz | This project | This repo's Releases page |
| AI models (Whisper, Kokoro, SigLIP 2) | Speech-to-text, voiceover, shot search | Hugging Face |

The installer also changes four settings:

- It adds a background update check: `~/Library/LaunchAgents/app.editz.updater.plist`.

- It adds an `editz` entry to Claude's `claude_desktop_config.json`. A backup of the original is saved next to it as `.before-editz`.
- It copies the Premiere panel to `~/Library/Application Support/Adobe/CEP/extensions`.
- It turns on Adobe's `PlayerDebugMode` setting, which lets Premiere load an unsigned panel.

---

## For developers

These are pnpm workspaces:

| Path | What's there |
|---|---|
| `apps/daemon` | MCP server (stdio) and Premiere bridge (`ws://127.0.0.1:47800/premiere`) |
| `apps/premiere-cep`, `apps/premiere-uxp` | The Premiere panels |
| `packages/ir` | Timeline IR |
| `packages/compilers` | FCP7 XML and the op protocol |
| `workers/editz-worker` | Python worker (uv): Whisper, Kokoro, SigLIP 2 |

Plans and status are in [`docs/PRD.md`](docs/PRD.md) and [`docs/M1-PLAN.md`](docs/M1-PLAN.md).

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm release:build
```

**Releases are automatic.** Every push to `main` that passes the typecheck and tests becomes release `v<major>.<minor>.<run number>` (see `.github/workflows/release.yml`). Pushes that only change docs or `*.md` files are skipped. Testers' Macs pick it up within 30 minutes: the installer adds a LaunchAgent, `app.editz.updater`, which runs `app/updater.mjs`. It asks before updating, reruns that release's `install.sh`, and logs to `~/Library/Application Support/Editz/logs`. To ship a bigger step, bump `major.minor` in `package.json`.

`pnpm release:build` builds the same bundle locally: `dist/editz-mac.tar.gz` plus its `.sha256`. To test the installer without touching your real setup, point `EDITZ_HOME`, `EDITZ_CEP_DIR` and `EDITZ_CLAUDE_CONFIG` at scratch paths. See the top of `install.sh`.
