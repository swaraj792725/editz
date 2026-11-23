"""Voice-over: Kokoro-82M (Apache-2.0) through ONNX Runtime. No PyTorch, runs faster than real time on CPU."""

import wave
from pathlib import Path

import numpy as np

from .models import ensure_file, models_dir

RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1"
MODEL_FILE = "kokoro-v1.0.onnx"
VOICES_FILE = "voices-v1.0.bin"

_engine = None


def _get(progress=None):
    global _engine
    if _engine is None:
        from kokoro_onnx import Kokoro

        d = models_dir() / "kokoro"
        model = ensure_file(f"{RELEASE}/{MODEL_FILE}", d / MODEL_FILE, progress)
        voices = ensure_file(f"{RELEASE}/{VOICES_FILE}", d / VOICES_FILE, progress)
        _engine = Kokoro(str(model), str(voices))
    return _engine


def voices(progress=None) -> list[str]:
    return sorted(_get(progress).get_voices())


def synthesize(text: str, out: str, voice: str = "af_heart", speed: float = 1.0, lang: str = "en-us", progress=None) -> dict:
    if not text.strip():
        raise ValueError("text is empty")
    k = _get(progress)
    if voice not in k.get_voices():
        raise ValueError(f"unknown voice {voice!r}; try one of {', '.join(sorted(k.get_voices())[:12])}…")
    if progress:
        progress(f"speaking {len(text)} characters as {voice}")
    samples, rate = k.create(text, voice=voice, speed=float(speed), lang=lang)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return {"path": out, "duration": round(len(samples) / rate, 3), "sample_rate": rate, "voice": voice}


def unload() -> bool:
    global _engine
    had = _engine is not None
    _engine = None
    return had
