"""Nøta separation worker.

Splits a song into an isolated bass stem and a bass-free backing track with
Demucs (Hybrid Transformer Demucs, MIT licence).

The backing track is the *sum of the separated non-bass stems*
(drums + other + vocals). It is never produced by phase-inverting the bass
stem against the original mix.

Protocol: progress and results are printed to stdout as JSON lines.
    {"type": "progress", "stage": "...", "progress": 0.42}
    {"type": "done", "bass": {...}, "backing": {...}}
    {"type": "error", "message": "..."}

Usage:
    python separate.py --check
    python separate.py --input song.mp3 --out-dir DIR [--model htdemucs] [--device auto]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
import warnings

warnings.filterwarnings("ignore")

# Windows: Microsoft's C++ runtime ships with Nøta (NOTA_VCRUNTIME), for PCs
# without the Visual C++ Redistributable. PyTorch and friends load it from there.
if sys.platform == "win32" and os.path.isdir(os.environ.get("NOTA_VCRUNTIME", "")):
    _vcruntime = os.add_dll_directory(os.environ["NOTA_VCRUNTIME"])

SAMPLE_RATE = 44100


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def find_ffmpeg() -> str:
    path = os.environ.get("NOTA_FFMPEG") or shutil.which("ffmpeg")
    if not path:
        raise RuntimeError("ffmpeg was not found")
    return path


def pick_device(requested: str):
    import torch

    if requested != "auto":
        return requested
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def check() -> int:
    info = {"type": "check", "ok": False}
    try:
        import torch
        import demucs  # noqa: F401

        info["torch"] = torch.__version__
        info["device"] = pick_device("auto")
        info["ffmpeg"] = find_ffmpeg()
        info["ok"] = True
    except Exception as exc:  # pragma: no cover - reported to the host
        info["message"] = str(exc)
    emit(info)
    return 0 if info["ok"] else 1


def decode(ffmpeg: str, path: str):
    """Decode any input file to float32 stereo at the model sample rate."""
    import numpy as np
    import torch

    proc = subprocess.run(
        [ffmpeg, "-v", "error", "-nostdin", "-i", path, "-f", "f32le", "-acodec", "pcm_f32le",
         "-ac", "2", "-ar", str(SAMPLE_RATE), "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError("Could not decode the audio file: " + proc.stderr.decode(errors="replace").strip())
    data = np.frombuffer(proc.stdout, dtype=np.float32)
    if data.size < SAMPLE_RATE:
        raise RuntimeError("The audio file is empty or too short to separate.")
    return torch.from_numpy(data.reshape(-1, 2).T.copy())


def encode(ffmpeg: str, audio, path: str) -> None:
    """Write a stereo float tensor as 16-bit FLAC (dithered, CD quality, half the size of 24-bit), atomically."""
    import numpy as np

    tmp = path + ".partial.flac"
    pcm = audio.clamp(-1.0, 1.0).T.contiguous().cpu().numpy().astype(np.float32)
    proc = subprocess.run(
        [ffmpeg, "-v", "error", "-nostdin", "-y", "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "2",
         "-i", "-", "-af", "aresample=osf=s16:dither_method=triangular", "-c:a", "flac", "-sample_fmt", "s16", tmp],
        input=pcm.tobytes(),
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError("Could not write " + os.path.basename(path) + ": " + proc.stderr.decode(errors="replace"))
    os.replace(tmp, path)


def stats(audio) -> dict:
    rms = float(audio.pow(2).mean().sqrt())
    peak = float(audio.abs().max())
    return {
        "rmsDb": 20 * math.log10(rms) if rms > 0 else -120.0,
        "peakDb": 20 * math.log10(peak) if peak > 0 else -120.0,
        "durationSec": audio.shape[-1] / SAMPLE_RATE,
    }


def separate(args) -> int:
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    ffmpeg = find_ffmpeg()
    os.makedirs(args.out_dir, exist_ok=True)
    started = time.time()

    emit({"type": "progress", "stage": "loading-model", "progress": 0.0})
    model = get_model(args.model)
    model.eval()
    if "bass" not in model.sources:
        raise RuntimeError(f"Model {args.model} has no bass source")

    emit({"type": "progress", "stage": "decoding", "progress": 0.02})
    mix = decode(ffmpeg, args.input)

    device = pick_device(args.device)
    ref = mix.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    normalized = (mix - mean) / std

    num_models = len(getattr(model, "models", [model]))
    total_len = mix.shape[-1]
    last_report = [0.0]

    def on_progress(info: dict) -> None:
        if info.get("state") != "end":
            return
        model_idx = info.get("model_idx_in_bag", 0)
        seg = info.get("segment_offset", 0)
        frac = (model_idx + min(1.0, seg / max(1, total_len))) / num_models
        overall = 0.05 + 0.85 * frac
        if overall - last_report[0] >= 0.01:
            last_report[0] = overall
            emit({"type": "progress", "stage": "separating", "progress": round(overall, 3)})

    emit({"type": "progress", "stage": "separating", "progress": 0.05})
    with torch.no_grad():
        sources = apply_model(
            model, normalized[None], device=device, shifts=args.shifts, split=True,
            overlap=0.25, progress=False, callback=on_progress,
        )[0]
    sources = sources * std + mean

    bass_idx = model.sources.index("bass")
    bass = sources[bass_idx]
    backing = torch.zeros_like(bass)
    for i, _name in enumerate(model.sources):
        if i != bass_idx:
            backing += sources[i]

    emit({"type": "progress", "stage": "writing", "progress": 0.92})
    bass_path = os.path.join(args.out_dir, "bass.flac")
    backing_path = os.path.join(args.out_dir, "backing.flac")
    encode(ffmpeg, bass, bass_path)
    encode(ffmpeg, backing, backing_path)

    emit({
        "type": "done",
        "model": args.model,
        "device": str(device),
        "elapsedSec": round(time.time() - started, 2),
        "bass": {"path": bass_path, **stats(bass)},
        "backing": {"path": backing_path, **stats(backing)},
        "mix": stats(mix),
    })
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--out-dir")
    parser.add_argument("--model", default="htdemucs")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--shifts", type=int, default=1)
    args = parser.parse_args()

    if args.check:
        return check()
    if not args.input or not args.out_dir:
        emit({"type": "error", "message": "--input and --out-dir are required"})
        return 2
    try:
        return separate(args)
    except Exception as exc:
        emit({"type": "error", "message": str(exc)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
