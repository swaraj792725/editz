"""
Editz worker protocol (one JSON object per line):

  daemon → worker   {"id": 1, "method": "transcribe", "params": {...}}
  worker → daemon   {"event": "ready", "version": "0.1.0", "methods": [...]}      once, at start
                    {"id": 1, "event": "progress", "message": "...", "value": 0.4}  any number
                    {"id": 1, "result": {...}}                                     or
                    {"id": 1, "error": {"message": "...", "kind": "ValueError"}}

Requests run one at a time. The protocol uses a private copy of stdout; fd 1 is
pointed at stderr so stray prints from libraries can never corrupt it.
"""

import json
import os
import sys
import traceback

from . import __version__

_proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr


def send(obj: dict) -> None:
    _proto.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _proto.flush()


def _ping(params, progress):
    import platform

    return {"version": __version__, "python": platform.python_version(), "machine": platform.machine()}


def _transcribe(params, progress):
    from . import asr

    return asr.transcribe(progress=progress, **params)


def _tts(params, progress):
    from . import tts

    return tts.synthesize(progress=progress, **params)


def _voices(params, progress):
    from . import tts

    return {"voices": tts.voices(progress=progress)}


def _embed_images(params, progress):
    from . import vision

    return vision.embed_images(progress=progress, **params)


def _embed_texts(params, progress):
    from . import vision

    return vision.embed_texts(progress=progress, **params)


def _unload(params, progress):
    freed = []
    if "editz_worker.asr" in sys.modules:
        if sys.modules["editz_worker.asr"].unload():
            freed.append("whisper")
    if "editz_worker.tts" in sys.modules:
        if sys.modules["editz_worker.tts"].unload():
            freed.append("kokoro")
    if "editz_worker.vision" in sys.modules:
        if sys.modules["editz_worker.vision"].unload():
            freed.append("siglip")
    return {"freed": freed}


METHODS = {
    "ping": _ping,
    "transcribe": _transcribe,
    "tts": _tts,
    "voices": _voices,
    "embed_images": _embed_images,
    "embed_texts": _embed_texts,
    "unload": _unload,
}


def main() -> None:
    send({"event": "ready", "version": __version__, "methods": sorted(METHODS)})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            fn = METHODS.get(req.get("method"))
            if fn is None:
                raise ValueError(f"unknown method {req.get('method')!r}")

            def progress(message: str, value: float | None = None, _rid=rid):
                send({"id": _rid, "event": "progress", "message": message, "value": value})

            send({"id": rid, "result": fn(req.get("params") or {}, progress)})
        except Exception as e:  # noqa: BLE001 - every failure goes back to the daemon
            traceback.print_exc(file=sys.stderr)
            send({"id": rid, "error": {"message": str(e) or type(e).__name__, "kind": type(e).__name__}})


if __name__ == "__main__":
    main()
