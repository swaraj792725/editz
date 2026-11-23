"""Speech to text with word timings: Whisper large-v3-turbo on MLX (Apple GPU)."""

import os

from .models import models_dir

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"

# Whisper tidies speech by default and drops "um"/"uh". A disfluent prompt makes it write them,
# which filler removal needs.
VERBATIM_PROMPT = "Umm, let me think like, hmm... Okay, here's what I'm, like, thinking. Uh, so, you know, I mean..."


def _r(x) -> float:
    return round(float(x), 3)


def transcribe(path: str, model: str = DEFAULT_MODEL, language: str | None = None, verbatim: bool = True, progress=None) -> dict:
    os.environ.setdefault("HF_HOME", str(models_dir() / "hf"))
    import mlx_whisper

    if progress:
        progress(f"transcribing with {model.split('/')[-1]}")
    r = mlx_whisper.transcribe(
        path,
        path_or_hf_repo=model,
        language=language,
        word_timestamps=True,
        initial_prompt=VERBATIM_PROMPT if verbatim else None,
        condition_on_previous_text=False,
        hallucination_silence_threshold=2.0,
        verbose=None,
    )
    segments, words = [], []
    for s in r.get("segments", []):
        text = s.get("text", "").strip()
        if not text:
            continue
        segments.append({"start": _r(s["start"]), "end": _r(s["end"]), "text": text})
        for w in s.get("words", []):
            t = w.get("word", "").strip()
            if t:
                words.append({"text": t, "start": _r(w["start"]), "end": _r(w["end"]), "p": round(float(w.get("probability", 0)), 3)})
    return {"language": r.get("language"), "model": model, "text": r.get("text", "").strip(), "segments": segments, "words": words}


def unload() -> bool:
    try:
        from mlx_whisper.transcribe import ModelHolder
        import mlx.core as mx
    except ImportError:
        return False
    had = ModelHolder.model is not None
    ModelHolder.model = None
    ModelHolder.model_path = None
    mx.clear_cache()
    return had
