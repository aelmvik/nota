"""Nøta bass transcription worker: turns the separated bass track into notes.

The pitch model is Spotify's Basic Pitch (Apache-2.0, models/basic-pitch.onnx,
run with onnxruntime). For every ~11.6 ms it gives the likelihood that each
piano key is sounding, and that a note starts there. Basic Pitch is made for
any number of notes at once; a bass plays one, so the notes are read off with
a decoder for a single line:

  * one Viterbi pass finds the most likely line through the whole song, with
    silence and each key as states. Holding a note is free; changing pitch
    costs something unless a pluck at the new key pays for it, and octave
    jumps cost extra. So brief wrong notes between right ones and flicker
    between neighbouring keys lose to the steady line, while real quick
    changes, slides and hammer-ons, which the model hears clearly, win;
  * a held key is split into repeated notes where it's plucked again: a
    confident onset, or a weaker one where the bass gets louder (so kick drum
    left in the bass track doesn't chop long notes up);
  * each note's octave is checked as a whole: a real high note doesn't light
    up the octave below, so a note whose lower octave is likelier is the
    lower note;
  * Basic Pitch's confidence fades on long notes while the string still
    rings, so a note carries on while the bass stays near its level;
  * a note out of silence must start with a pluck (or be a clear, long swell);
    without one it must follow straight on from a note (a slide or hammer-on).
    Notes the model barely hears in the track's hiss, and notes far quieter
    than the bass's loud passages (other instruments left behind by the
    separation), are dropped.

The settings were tuned on the bass parts of Slakh (BabySlakh, separated with
Demucs as the app does) and on synthetic slides, hammer-ons, ghost notes and
sustains, checked against held-out songs.

Prints JSON lines:
    {"type": "progress", "progress": 0.42}
    {"type": "done", "notes": [{"start": 1.23, "end": 1.61, "pitch": 40, "velocity": 0.8}, ...]}
    {"type": "error", "message": "..."}

pitch is a MIDI note number at sounding pitch (28 = E1, a four-string bass's
open low E). --tuning-cents is the song's offset from A440 (from analyze.py),
so a recording that sits 23 cents flat still lands on the right note names.

Usage: python transcribe.py --input bass.flac [--tuning-cents -23]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

# Windows: Microsoft's C++ runtime ships with Nøta (NOTA_VCRUNTIME), for PCs
# without the Visual C++ Redistributable. PyTorch and friends load it from there.
if sys.platform == "win32" and os.path.isdir(os.environ.get("NOTA_VCRUNTIME", "")):
    _vcruntime = os.add_dll_directory(os.environ["NOTA_VCRUNTIME"])

MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "basic-pitch.onnx")
SR = 22050
HOP = 256  # model frame: ~11.6 ms
FPS = SR / HOP
WINDOW = 43844  # samples the model takes at once (~2 s)
EDGE = 15  # frames dropped at each end of a window, where the model sees too little context
KEEP = 140  # frames kept per window; windows advance by exactly this many frames
BATCH = 16
KEY0 = 21  # the model's first key: A0
LOWEST, HIGHEST = 23, 76  # B0 to E5: everything a 4-, 5- or 6-string bass plays, harmonics included
OVERTONES = (12, 19, 24)
OVERTONE_WEIGHT = 0.25  # share of a key's overtones counted in its favour
# Viterbi costs (log likelihood)
SILENCE = 0.26  # likelihood at which a key and silence are equally likely
START_COST = 2.1  # starting a note from silence
STOP_COST = 4.3  # ending a note
CHANGE_COST = 10.0  # moving to another key...
OCTAVE_COST = 3.0  # ...plus this for an octave jump
FAR_COST = 1.0  # ...or this for a jump bigger than an octave
PLUCK_GAIN = 8.0  # times the onset likelihood at the new key: what a pluck pays towards a change
# Notes
REPLUCK = 0.61  # onset likelihood that may re-pluck a held key...
SURE_PLUCK = 0.75  # ...and above which it certainly does
REPLUCK_RISE_DB = 2.8  # in between, the bass must get this much louder
MIN_REPLUCK = 0.07  # seconds: closer onsets belong to the same attack
PLUCKED = 0.5  # onset likelihood at a note's start that counts as a pluck
MIN_PLUCKED = 0.067  # seconds: shortest plucked note
MIN_LEGATO = 0.1  # seconds: shortest unplucked note straight after another (slide target, hammer-on)
SWELL_LIKELIHOOD, MIN_SWELL = 0.5, 0.3  # a note out of silence without a pluck must be this sure and long
MIN_LIKELIHOOD = 0.1  # notes the model is less sure of are dropped
OCTAVE_BELOW = 1.2  # a note moves down an octave when the octave below is this much likelier...
OCTAVE_BELOW_MIN = 0.15  # ...and at least this likely
RING_DB = 12  # a note rings on while the bass is within this many dB of the note's peak
NOISE_DB, NOISE_LIKELIHOOD = 10, 0.45  # notes within NOISE_DB of the track's hiss need this likelihood
QUIET_DB = 35  # notes this far below the bass's loudest passages are bleed from other instruments
SILENT_DBFS = -60  # and anything quieter than this is bleed, even in a song without bass
LATENCY = 0.008  # the model reports onsets this much early (measured against known notes); ends are on time


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def run_model(y):
    """Note and onset likelihoods, frames x keys (88 piano keys from A0)."""
    import numpy as np
    import onnxruntime as ort

    session = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
    frames = int(np.ceil(len(y) / HOP))
    padded = np.concatenate([np.zeros(EDGE * HOP, np.float32), y.astype(np.float32), np.zeros(WINDOW, np.float32)])
    starts = range(0, frames * HOP, KEEP * HOP)
    windows = np.stack([padded[s : s + WINDOW] for s in starts])[..., None]
    note, onset = [], []
    for b in range(0, len(windows), BATCH):
        n, o = session.run(
            ["StatefulPartitionedCall:1", "StatefulPartitionedCall:2"],
            {"serving_default_input_2:0": windows[b : b + BATCH]},
        )
        note.append(n[:, EDGE : EDGE + KEEP])
        onset.append(o[:, EDGE : EDGE + KEEP])
        emit({"type": "progress", "progress": round(0.05 + 0.85 * min(1.0, (b + BATCH) / len(windows)), 3)})
    return np.concatenate(note).reshape(-1, 88)[:frames], np.concatenate(onset).reshape(-1, 88)[:frames]


def loudness(y, frames):
    """Level per model frame in dBFS (46 ms and 23 ms windows), and the level of the track's loudest passages.

    The reference is a high percentile rather than the median, so a song that
    has bass in only one section still measures that section. The short
    window shows each pluck of fast repeated notes.
    """
    import numpy as np
    import librosa

    def db(window):
        rms = librosa.feature.rms(y=y, frame_length=window, hop_length=HOP, center=True)[0][:frames]
        return 20 * np.log10(np.maximum(np.pad(rms, (0, frames - len(rms))), 1e-7))

    level = db(1024)
    return level, db(512), float(np.percentile(level, 99.5))


def viterbi(n, ons, quiet):
    """The most likely key per frame (-1 = silence) for a single line."""
    import numpy as np

    frames, keys = n.shape
    salience = n.copy()  # a key's likelihood plus a share of its overtones' favours the fundamental
    for k in OVERTONES:
        salience[:, : keys - k] += OVERTONE_WEIGHT * n[:, k:]
    emit = np.empty((frames, keys + 1))  # state 0 is silence, 1.. the keys
    emit[:, 1:] = np.log(np.maximum(salience, 1e-4))
    emit[:, 0] = np.log(SILENCE) + np.where(quiet, 5.0, 0.0)
    jump = np.abs(np.arange(keys)[:, None] - np.arange(keys)[None, :])
    cost = np.zeros((keys + 1, keys + 1))
    cost[1:, 1:] = np.where(jump == 0, 0.0, CHANGE_COST + OCTAVE_COST * np.isin(jump, (12, 24)) + FAR_COST * (jump > 12))
    cost[0, 1:], cost[1:, 0] = START_COST, STOP_COST
    stay = np.eye(keys + 1, dtype=bool)
    gain = np.zeros(keys + 1)
    states = np.arange(keys + 1)
    back = np.zeros((frames, keys + 1), dtype=np.int16)
    score = emit[0].copy()
    for t in range(1, frames):
        gain[1:] = PLUCK_GAIN * ons[t]
        m = score[:, None] - cost + np.where(stay, 0.0, gain[None, :])
        back[t] = m.argmax(0)
        score = m[back[t], states] + emit[t]
    path = np.empty(frames, dtype=int)
    path[-1] = int(score.argmax())
    for t in range(frames - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return path - 1


def decode(note, onset, level, fine, loudest):
    """One line of notes from the likelihoods: [start_frame, end_frame, midi, likelihood]."""
    import numpy as np

    lo, hi = LOWEST - KEY0, HIGHEST - KEY0
    n, o = note[:, lo : hi + 1], onset[:, lo : hi + 1]
    frames, keys = n.shape
    # Pluck evidence at a key: its own onset or its octave's (attacks show there too).
    ons = o.copy()
    ons[:, : keys - 12] = np.maximum(ons[:, : keys - 12], o[:, 12:])
    bleed = max(loudest - QUIET_DB, SILENT_DBFS)
    noise = float(np.percentile(level, 5))  # the track's own floor: hiss, separation residue
    path = viterbi(n, ons, level < bleed)

    def plucked_again(t, k):
        """A real re-pluck: a confident onset, or a weaker one where the bass gets louder."""
        return ons[t, k] >= SURE_PLUCK or fine[t : t + 3].max() - fine[max(0, t - 3) : max(1, t)].min() >= REPLUCK_RISE_DB

    # Runs of a key become notes, split where the key is plucked again.
    notes = []
    t = 0
    while t < frames:
        k, end = path[t], t
        while end < frames and path[end] == k:
            end += 1
        if k >= 0:
            start = t
            for x in range(t + 1, end - 1):
                peak = ons[x, k] > REPLUCK and ons[x, k] >= ons[x - 1, k] and ons[x, k] >= ons[x + 1, k]
                if peak and (x - start) / FPS >= MIN_REPLUCK and plucked_again(x, k):
                    notes.append([start, x, k])
                    start = x
            notes.append([start, end, k])
        t = end

    # A pitch change moves a frame to meet the pluck that caused it.
    for prev, cur in zip(notes, notes[1:]):
        a, b, k = cur
        if prev[1] != a or b - a < 3 or a - prev[0] < 3:
            continue
        best = max((a - 1, a, a + 1), key=lambda x: ons[x, k])
        prev[1] = cur[0] = best

    # Octave per note: a real high note doesn't light up the octave below.
    for x in notes:
        a, b, k = x
        while k >= 12 and n[a:b, k - 12].mean() > max(OCTAVE_BELOW_MIN, OCTAVE_BELOW * n[a:b, k].mean()):
            k -= 12
        x[2] = k

    # Sustain: Basic Pitch's confidence fades on long notes while the string still rings.
    # A same-key piece without a real re-pluck joins the note before it, and a note
    # carries on while the bass stays near its level.
    floor = max(bleed, noise + NOISE_DB)
    joined = []
    for x in notes:
        if joined:
            a, b, k = joined[-1]
            if k == x[2] and x[0] - b < FPS and not plucked_again(x[0], k) and level[b : x[0] + 1].min() > level[a:b].max() - RING_DB:
                joined[-1][1] = x[1]
                continue
        joined.append(x)
    notes = joined
    for i, x in enumerate(notes):
        a, b, _ = x
        stop = notes[i + 1][0] if i + 1 < len(notes) else frames
        ring = max(level[a:b].max() - RING_DB, floor)
        while b < stop and level[b] > ring:
            b += 1
        x[1] = b

    out = []
    prev_end = -10
    for a, b, k in notes:
        if b <= a:
            continue
        seconds, sure = (b - a) / FPS, float(n[a:b, k].mean())
        if sure < MIN_LIKELIHOOD or (sure < NOISE_LIKELIHOOD and level[a:b].max() < noise + NOISE_DB):
            continue  # too unsure, or hiss the model half-hears as a note
        if ons[max(0, a - 2) : a + 3, k].max() > PLUCKED:
            if seconds < MIN_PLUCKED:
                continue
        elif a - prev_end <= 2:  # straight on from a note: a slide, hammer-on or pull-off
            if seconds < MIN_LEGATO:
                continue
        elif sure < SWELL_LIKELIHOOD or seconds < MIN_SWELL:
            continue  # out of silence, a note starts with a pluck unless it's a clear, long swell
        out.append([int(a), int(b), int(k) + LOWEST, sure])
        prev_end = b
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--tuning-cents", type=float, default=0.0)
    args = ap.parse_args()

    try:
        import numpy as np  # noqa: F401
        import librosa
        import onnxruntime  # noqa: F401
    except ImportError as e:
        emit({"type": "error", "message": f"missing-module: {e.name}"})
        sys.exit(1)

    try:
        # Retune to A440 by resampling: a song 23 cents flat is read 23 cents
        # faster (and higher), then times are scaled back.
        ratio = 2 ** (args.tuning_cents / 1200)
        y, _ = librosa.load(args.input, sr=round(SR * ratio), mono=True)
        if len(y) == 0:
            raise ValueError("The bass track is empty")
        emit({"type": "progress", "progress": 0.05})

        note, onset = run_model(y)
        sec = 1 / FPS / ratio
        notes = [
            {"start": round(a * sec + LATENCY, 3), "end": round(b * sec, 3), "pitch": p, "velocity": round(min(1.0, max(0.1, v)), 2)}
            for a, b, p, v in decode(note, onset, *loudness(y, len(note)))
        ]
        emit({"type": "done", "notes": notes, "tracker": "basic-pitch"})
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "message": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
