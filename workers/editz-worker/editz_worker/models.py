"""Where models live and how missing files get fetched (resumable later, in the S7 download manager)."""

import os
import urllib.request
from pathlib import Path


def models_dir() -> Path:
    d = Path(os.environ.get("EDITZ_MODELS") or Path.home() / ".editz" / "models")
    d.mkdir(parents=True, exist_ok=True)
    return d


def ensure_file(url: str, dest: Path, progress=None) -> Path:
    """Download url to dest once. Writes to a .part file and renames, so a crash never leaves a half file."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "editz-worker"})
    with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        last = -1
        while chunk := r.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            pct = int(done * 100 / total) if total else -1
            if progress and pct != last and pct % 10 == 0:
                progress(f"downloading {dest.name}", pct / 100 if total else None)
                last = pct
    if total and tmp.stat().st_size != total:
        tmp.unlink(missing_ok=True)
        raise IOError(f"download of {dest.name} was cut short")
    tmp.rename(dest)
    return dest
