"""Vision: SigLIP 2 (Apache-2.0) image and text embeddings through ONNX Runtime. No PyTorch.

Images and texts land in one space; cosine similarity ranks search results and,
through the model's own sigmoid calibration, gives zero-shot tag probabilities.
"""

import base64
import os

import numpy as np

from .models import ensure_file, models_dir

MODEL = "siglip2-base-patch16-224"
REPO = "https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX/resolve/main"
FILES = {
    "vision": "onnx/vision_model.onnx",  # fp32, 372 MB: fast on CPU, exact
    "text": "onnx/text_model_quantized.onnx",  # int8, 283 MB: the 256k-token vocab table dominates
    "tokenizer": "tokenizer.json",
}
SIZE = 224
MAX_TOKENS = 64
# From google/siglip2-base-patch16-224 (model.safetensors): p = sigmoid(exp(scale) * cos + bias).
LOGIT_SCALE = float(np.exp(4.724453449249268))
LOGIT_BIAS = -16.771724700927734

_vision = None
_text = None
_tok = None


def _session(path):
    import onnxruntime as ort

    o = ort.SessionOptions()
    o.intra_op_num_threads = max(1, min(4, (os.cpu_count() or 4) // 2))
    o.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(path), o, providers=["CPUExecutionProvider"])


def _file(key, progress=None):
    return ensure_file(f"{REPO}/{FILES[key]}", models_dir() / MODEL / FILES[key].split("/")[-1], progress)


def _get_vision(progress=None):
    global _vision
    if _vision is None:
        _vision = _session(_file("vision", progress))
    return _vision


def _get_text(progress=None):
    global _text, _tok
    if _text is None:
        from tokenizers import Tokenizer

        _tok = Tokenizer.from_file(str(_file("tokenizer", progress)))
        _tok.enable_truncation(MAX_TOKENS)
        _tok.enable_padding(length=MAX_TOKENS, pad_id=_tok.token_to_id("<pad>"), pad_token="<pad>")
        _text = _session(_file("text", progress))
    return _text, _tok


def _norm(x: np.ndarray) -> np.ndarray:
    return x / np.maximum(np.linalg.norm(x, axis=-1, keepdims=True), 1e-12)


def _pack(x: np.ndarray) -> list[str]:
    """Each row as base64 little-endian float32 (≈4 KB per 768-d vector, 3× smaller than JSON numbers)."""
    return [base64.b64encode(r.astype("<f4").tobytes()).decode("ascii") for r in x]


def _pixels(path: str) -> np.ndarray:
    from PIL import Image

    with Image.open(path) as im:
        im = im.convert("RGB").resize((SIZE, SIZE), Image.Resampling.BILINEAR)
        a = np.asarray(im, dtype=np.float32) / 255.0
    return ((a - 0.5) / 0.5).transpose(2, 0, 1)


def _first_output(sess, feeds, prefer):
    names = [o.name for o in sess.get_outputs()]
    name = next((n for n in prefer if n in names), names[-1])
    return sess.run([name], feeds)[0]


def embed_images(paths: list[str], batch: int = 8, progress=None) -> dict:
    if not paths:
        return {"model": MODEL, "dim": 0, "vectors": []}
    sess = _get_vision(progress)
    inp = sess.get_inputs()[0].name
    out = []
    for i in range(0, len(paths), batch):
        px = np.stack([_pixels(p) for p in paths[i : i + batch]])
        out.append(_first_output(sess, {inp: px}, ("pooler_output", "image_embeds")))
        if progress and len(paths) > batch:
            progress(f"looked at {min(i + batch, len(paths))}/{len(paths)} frames", min(1.0, (i + batch) / len(paths)))
    v = _norm(np.concatenate(out).astype(np.float32))
    return {"model": MODEL, "dim": int(v.shape[1]), "vectors": _pack(v)}


def embed_texts(texts: list[str], progress=None) -> dict:
    if not texts:
        return {"model": MODEL, "dim": 0, "vectors": []}
    sess, tok = _get_text(progress)
    # SigLIP 2 was trained on lower-cased text, padded to 64 tokens.
    ids = np.array([e.ids for e in tok.encode_batch([t.lower() for t in texts])], dtype=np.int64)
    feeds = {sess.get_inputs()[0].name: ids}
    v = _norm(_first_output(sess, feeds, ("pooler_output", "text_embeds")).astype(np.float32))
    return {"model": MODEL, "dim": int(v.shape[1]), "vectors": _pack(v), "logit_scale": LOGIT_SCALE, "logit_bias": LOGIT_BIAS}


def unload() -> bool:
    global _vision, _text, _tok
    had = _vision is not None or _text is not None
    _vision = _text = _tok = None
    return had
