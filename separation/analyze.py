"""Nøta musical analysis worker: beats, downbeats, key and tuning offset.

Beats and downbeats come from beat_this (CPJKU, MIT licence), a neural
beat tracker; librosa's beat tracker is the fallback when it isn't installed.
The app regularises the raw beats into a stable grid (see src/shared/beats.ts).

Prints a single JSON line:
    {"type": "done", "beats": [...], "downbeats": [...], "tracker": "beat_this",
     "key": "E minor", "keyConfidence": 0.71, "tuningCents": -23.0}
    {"type": "error", "message": "..."}

tuningCents is how far the recording sits from A440 equal temperament:
-23 means the song is 23 cents flat, so it needs +23 cents to match a bass
tuned to standard pitch.

Usage: python analyze.py --input song.mp3
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import warnings

warnings.filterwarnings("ignore")

# Windows: Microsoft's C++ runtime ships with Nøta (NOTA_VCRUNTIME), for PCs
# without the Visual C++ Redistributable. PyTorch and friends load it from there.
if sys.platform == "win32" and os.path.isdir(os.environ.get("NOTA_VCRUNTIME", "")):
    _vcruntime = os.add_dll_directory(os.environ["NOTA_VCRUNTIME"])

SR = 22050
NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]

# Krumhansl-Kessler key profiles
MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def decode(path: str):
    import numpy as np

    ffmpeg = os.environ.get("NOTA_FFMPEG") or shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg was not found")
    proc = subprocess.run(
        [ffmpeg, "-v", "error", "-nostdin", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError("Could not decode the audio file")
    y = np.frombuffer(proc.stdout, dtype=np.float32).copy()
    if y.size < SR * 2:
        raise RuntimeError("The audio is too short to analyse")
    return y


def detect_key(chroma):
    import numpy as np

    profile = chroma.mean(axis=1)
    best = (-2.0, 0, "major")
    scores = []
    for mode, template in (("major", MAJOR), ("minor", MINOR)):
        t = np.array(template)
        for tonic in range(12):
            r = float(np.corrcoef(profile, np.roll(t, tonic))[0, 1])
            scores.append(r)
            if r > best[0]:
                best = (r, tonic, mode)
    scores.sort(reverse=True)
    # Confidence: how clearly the winner beats the runner-up (0..1).
    margin = scores[0] - scores[1] if len(scores) > 1 else 0.0
    confidence = max(0.0, min(1.0, best[0] * 0.6 + margin * 4))
    return f"{NOTE_NAMES[best[1]]} {best[2]}", round(confidence, 2)


def track_beats(y):
    """Returns (beats, downbeats, tracker name)."""
    try:
        from beat_this.inference import Audio2Beats
        import torch

        device = "mps" if torch.backends.mps.is_available() else "cpu"
        beats, downbeats = Audio2Beats(checkpoint_path="final0", device=device, dbn=False)(y, SR)
        return [float(b) for b in beats], [float(d) for d in downbeats], "beat_this"
    except ImportError:
        import librosa

        onset_env = librosa.onset.onset_strength(y=y, sr=SR)
        _, frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=SR, trim=False)
        return librosa.frames_to_time(frames, sr=SR).tolist(), [], "librosa"


def analyze(path: str) -> dict:
    import librosa

    y = decode(path)

    tuning = float(librosa.estimate_tuning(y=y, sr=SR, bins_per_octave=12))
    tuning_cents = round(tuning * 100.0, 1)

    beats, downbeats, tracker = track_beats(y)

    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, tuning=tuning)
    key, confidence = detect_key(chroma)

    return {
        "type": "done",
        "beats": [round(b, 4) for b in beats],
        "downbeats": [round(b, 4) for b in downbeats],
        "tracker": tracker,
        "key": key,
        "keyConfidence": confidence,
        "tuningCents": tuning_cents,
        "durationSec": round(len(y) / SR, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    args = parser.parse_args()
    try:
        emit(analyze(args.input))
        return 0
    except Exception as exc:
        emit({"type": "error", "message": str(exc)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
