#!/usr/bin/env bash
# Dev install of the Editz CEP panel (Premiere Pro CC 2018 → 25.x) on macOS.
# Symlinks the panel into the user CEP extensions folder and allows unsigned
# extensions (PlayerDebugMode) for CSXS 8–12. Restart Premiere afterwards:
# Window → Extensions → Editz.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/../apps/premiere-cep" && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/app.editz.bridge"
mkdir -p "$(dirname "$DEST")"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
  echo "Refusing to overwrite non-symlink $DEST" >&2
  exit 1
fi
ln -sfn "$SRC" "$DEST"
for v in 8 9 10 11 12; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done
echo "Linked $DEST -> $SRC"
echo "Restart Premiere Pro, then open Window > Extensions > Editz."
