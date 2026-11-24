#!/bin/bash
# Editz installer for Macs with Apple Silicon (M1 or newer). No admin password needed.
#
#   Install or update:  curl -fsSL https://raw.githubusercontent.com/swaraj792725/editz/main/install.sh | bash
#   Uninstall:          curl -fsSL https://raw.githubusercontent.com/swaraj792725/editz/main/install.sh | bash -s -- --uninstall
#
# Everything goes into ~/Library/Application Support/Editz, plus the Premiere panel in
# ~/Library/Application Support/Adobe/CEP/extensions and one "editz" entry in Claude's settings.
set -euo pipefail

REPO="swaraj792725/editz"
NODE_VER="v24.22.3"
NODE_SHA="ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd"
UV_VER="0.11.26"
UV_SHA="8f7fbf1708399b921857bce71e1d60f0d3ccf52a30caebc1c1a2f175dce13ab6"
FF_BASE="https://ffmpeg.martin-riedl.de/download/macos/arm64/1795207104_9.1"
FFMPEG_SHA="1f66e9a690a7f1c9e60b012379f8869c11818d1797f45b21dbb2f2564ba61ae1"
FFPROBE_SHA="6ef2df5f575042923a28537ab37adf936f28bf3e7b85de23a1447ed447ec1dbd"

# Overrides exist for testing; normal installs never set them.
EZ="${EDITZ_HOME:-$HOME/Library/Application Support/Editz}"
CEP_DIR="${EDITZ_CEP_DIR:-$HOME/Library/Application Support/Adobe/CEP/extensions}"
CLAUDE_CFG="${EDITZ_CLAUDE_CONFIG:-$HOME/Library/Application Support/Claude/claude_desktop_config.json}"
BUNDLE_URL="${EDITZ_BUNDLE_URL:-https://github.com/$REPO/releases/latest/download/editz-mac.tar.gz}"
LA_DIR="${EDITZ_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"
LABEL="app.editz.updater"
PLIST="$LA_DIR/$LABEL.plist"
APP="$EZ/app"
BIN="$EZ/bin"
NODE_HOME="$EZ/node"
NODE="$NODE_HOME/bin/node"
export UV_PYTHON_INSTALL_DIR="$EZ/py/python"
export UV_CACHE_DIR="$EZ/py/cache"

bold=$'\033[1m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; off=$'\033[0m'
step() { printf '\n%s%s%s\n' "$bold" "$1" "$off"; }
ok()   { printf '  %s✓%s %s\n' "$green" "$off" "$1"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$off" "$1"; }
die()  { printf '\n%sEditz could not finish installing:%s %s\n' "$red" "$off" "$1" >&2; printf 'Nothing else on your Mac was changed. Send a screenshot of this window to whoever shared Editz with you.\n' >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() { curl -fL --retry 3 --retry-delay 2 --progress-bar -A "editz-installer" -o "$2" "$1" || die "could not download $1 (check the internet connection and run the installer again)."; }
check() { echo "$2  $1" | shasum -a 256 -c - >/dev/null 2>&1 || die "the download $(basename "$1") was damaged or changed (checksum mismatch). Run the installer again."; }

editz_config() { # $1 = add | remove
  "$NODE" - "$CLAUDE_CFG" "$1" "$NODE" "$APP/editz.mjs" "$UV_PYTHON_INSTALL_DIR" "$UV_CACHE_DIR" "${EDITZ_HOME:-}" <<'JS'
const fs = require("fs"), path = require("path");
const [cfg, mode, node, app, pyDir, cacheDir, home] = process.argv.slice(2);
let d = {};
if (fs.existsSync(cfg)) {
  const raw = fs.readFileSync(cfg, "utf8");
  try { d = raw.trim() ? JSON.parse(raw) : {}; } catch { console.error(`Claude's settings file is not valid JSON, so Editz left it alone: ${cfg}`); process.exit(2); }
  if (!fs.existsSync(cfg + ".before-editz")) fs.copyFileSync(cfg, cfg + ".before-editz");
}
d.mcpServers ??= {};
if (mode === "add") {
  const env = { UV_PYTHON_INSTALL_DIR: pyDir, UV_CACHE_DIR: cacheDir };
  if (home) env.EDITZ_HOME = home;
  d.mcpServers.editz = { command: node, args: [app], env };
} else delete d.mcpServers.editz;
fs.mkdirSync(path.dirname(cfg), { recursive: true });
fs.writeFileSync(cfg, JSON.stringify(d, null, 2) + "\n");
JS
}

# Background update check: every 30 minutes and at login, run app/updater.mjs (asks before updating).
install_updater() {
  mkdir -p "$LA_DIR" "$EZ/logs"
  local env_xml=""
  [ -n "${EDITZ_HOME:-}" ] && env_xml="<key>EnvironmentVariables</key><dict><key>EDITZ_HOME</key><string>$EZ</string></dict>"
  cat > "$PLIST.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$APP/updater.mjs</string></array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$EZ/logs/updater.log</string>
  <key>StandardErrorPath</key><string>$EZ/logs/updater.log</string>
  $env_xml
</dict>
</plist>
EOF
  mv "$PLIST.tmp" "$PLIST"
  [ -n "${EDITZ_SKIP_LAUNCHD:-}" ] && return 0
  local job; job="gui/$(id -u)/$LABEL"
  if launchctl print "$job" >/dev/null 2>&1; then
    # An update is run by this very job; reloading it now would stop the update half way.
    [ -n "${EDITZ_UPDATING:-}" ] && return 0
    launchctl bootout "$job" 2>/dev/null || true
  fi
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
}

remove_updater() {
  [ -z "${EDITZ_SKIP_LAUNCHD:-}" ] && launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
}

# Everything runs inside main() so `curl | bash` reads the whole script before any step
# starts (otherwise a step reading stdin could swallow the rest of the script).
main() {
# ───────────────────────── uninstall ─────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  step "Removing Editz"
  if [ -f "$PLIST" ]; then remove_updater; ok "Turned off update checks"; fi
  if [ -x "$NODE" ] && [ -f "$CLAUDE_CFG" ]; then editz_config remove && ok "Removed Editz from Claude's settings"; fi
  if [ -L "$CEP_DIR/app.editz.bridge" ] || [ -d "$CEP_DIR/app.editz.bridge" ]; then rm -rf "$CEP_DIR/app.editz.bridge"; ok "Removed the Premiere panel"; fi
  if [ -d "$EZ" ]; then rm -rf "$EZ"; ok "Removed $EZ (app, AI models, media index)"; fi
  echo; echo "Done. Your videos and anything Editz made in ~/Movies/Editz were not touched."
  echo "Quit Claude (Cmd+Q) and open it again so it forgets Editz."
  exit 0
fi

# ───────────────────────── checks ─────────────────────────
printf '%sEditz installer%s — links Claude with Adobe Premiere Pro. Takes 10–30 minutes, mostly downloading AI models (about 4 GB).\n' "$bold" "$off"
step "1/7 Checking this Mac"
[ "$(uname -s)" = "Darwin" ] || die "Editz runs on macOS only."
[ "$(uname -m)" = "arm64" ] || die "this Mac has an Intel chip. Editz needs Apple Silicon (M1 or newer) for its local AI."
MACOS="$(sw_vers -productVersion)"
[ "${MACOS%%.*}" -ge 14 ] || die "macOS $MACOS is too old. Editz needs macOS 14 (Sonoma) or newer — update in System Settings → General → Software Update."
ok "macOS $MACOS on Apple Silicon"
FREE_GB=$(df -g "$HOME" | awk 'NR==2 {print $4}')
[ "${FREE_GB:-0}" -ge 8 ] || die "only ${FREE_GB} GB free on the disk. Editz needs about 8 GB. Free some space and run the installer again."
ok "${FREE_GB} GB free"
if ls -d /Applications/Adobe\ Premiere\ Pro* >/dev/null 2>&1; then ok "Found: $(ls -d /Applications/Adobe\ Premiere\ Pro* | sed 's#.*/##' | paste -sd ', ' -)"; else warn "Adobe Premiere Pro not found in /Applications. Editz will still install; install Premiere from Creative Cloud."; fi
if [ -d /Applications/Claude.app ]; then ok "Found Claude"; else warn "Claude desktop app not found. Get it from https://claude.ai/download, sign in, then come back to Premiere."; fi
mkdir -p "$EZ" "$BIN"

# ───────────────────────── tools ─────────────────────────
step "2/7 Getting Node.js (runs Editz)"
if [ -x "$NODE" ] && [ "$("$NODE" -v)" = "$NODE_VER" ]; then ok "Node.js $NODE_VER already here"; else
  fetch "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-arm64.tar.gz" "$TMP/node.tgz"
  check "$TMP/node.tgz" "$NODE_SHA"
  rm -rf "$NODE_HOME" && mkdir -p "$NODE_HOME"
  tar -xzf "$TMP/node.tgz" -C "$NODE_HOME" --strip-components 1
  ok "Node.js $("$NODE" -v)"
fi

step "3/7 Getting uv (runs the local AI)"
if [ -x "$BIN/uv" ] && "$BIN/uv" --version 2>/dev/null | grep -q "^uv $UV_VER"; then ok "uv $UV_VER already here"; else
  fetch "https://github.com/astral-sh/uv/releases/download/$UV_VER/uv-aarch64-apple-darwin.tar.gz" "$TMP/uv.tgz"
  check "$TMP/uv.tgz" "$UV_SHA"
  tar -xzf "$TMP/uv.tgz" -C "$TMP"
  install -m 0755 "$TMP/uv-aarch64-apple-darwin/uv" "$BIN/uv"
  ok "$("$BIN/uv" --version)"
fi

step "4/7 Getting FFmpeg (reads and writes video)"
if [ -x "$BIN/ffmpeg" ] && [ -x "$BIN/ffprobe" ]; then ok "FFmpeg already here"
elif [ -n "${EDITZ_USE_SYSTEM_FFMPEG:-}" ] && command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then
  ln -sf "$(command -v ffmpeg)" "$BIN/ffmpeg"; ln -sf "$(command -v ffprobe)" "$BIN/ffprobe"; ok "Using the FFmpeg already on this Mac"
else
  for t in ffmpeg ffprobe; do
    fetch "$FF_BASE/$t.zip" "$TMP/$t.zip"
    if [ "$t" = ffmpeg ]; then check "$TMP/$t.zip" "$FFMPEG_SHA"; else check "$TMP/$t.zip" "$FFPROBE_SHA"; fi
    unzip -oq "$TMP/$t.zip" -d "$TMP/ff"
    install -m 0755 "$TMP/ff/$t" "$BIN/$t"
  done
  ok "$("$BIN/ffmpeg" -version | head -1 | cut -d' ' -f1-3)"
fi

# ───────────────────────── Editz ─────────────────────────
step "5/7 Getting Editz"
if [ -f "$BUNDLE_URL" ]; then cp "$BUNDLE_URL" "$TMP/editz.tgz"; else
  fetch "$BUNDLE_URL" "$TMP/editz.tgz"
  fetch "$BUNDLE_URL.sha256" "$TMP/editz.sha"
  check "$TMP/editz.tgz" "$(cut -d' ' -f1 "$TMP/editz.sha")"
fi
tar -xzf "$TMP/editz.tgz" -C "$TMP"
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$TMP/editz" "$APP" && rm -rf "$APP.old"
ok "Editz $(cat "$APP/VERSION")"

step "6/7 Connecting Premiere Pro and Claude"
mkdir -p "$CEP_DIR"
rm -rf "$CEP_DIR/app.editz.bridge"
cp -R "$APP/cep" "$CEP_DIR/app.editz.bridge"
ok "Premiere panel installed"
if [ -z "${EDITZ_SKIP_DEBUGMODE:-}" ]; then
  # Lets Premiere load a panel that isn't from Adobe's store (same switch every free panel uses).
  for v in 8 9 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
  ok "Premiere allowed to load the Editz panel"
fi
editz_config add || die "could not update Claude's settings ($CLAUDE_CFG)."
ok "Editz added to Claude (a backup of the old settings is beside it: claude_desktop_config.json.before-editz)"

step "7/7 Setting up the local AI (the slow part)"
if [ -n "${EDITZ_SKIP_MODELS:-}" ]; then "$NODE" "$APP/warmup.mjs" --skip-models || die "the local AI helper did not start."
else "$NODE" "$APP/warmup.mjs" || die "the local AI helper did not start. Run the installer again — it picks up where it stopped."; fi
install_updater || die "could not set up update checks."
ok "Editz checks for updates every 30 minutes and asks before installing one"

printf '\n%s%sEditz is installed.%s\n\n' "$green" "$bold" "$off"
cat <<EOF
Next:
  1. Quit Claude completely (Claude menu → Quit, or Cmd+Q) and open it again.
  2. Quit Premiere Pro if it is open, then open it and your project.
  3. In Premiere: Window → Extensions → Editz. Leave that small panel open.
  4. In Claude, start a chat and ask: "Check Editz status".
     Then try: "Organise my footage in /path/to/folder into bins".

Updates: Editz asks with a pop-up when a new version is out. To remove Editz:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash -s -- --uninstall
EOF
}

main "$@"
