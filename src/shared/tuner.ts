// Tuner maths: note names, cents and the nearest bass string.

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

/** Open strings of 4-, 5- and 6-string basses (B0 to C3), as MIDI notes. */
export const BASS_STRINGS = [
  { name: 'B', midi: 23 },
  { name: 'E', midi: 28 },
  { name: 'A', midi: 33 },
  { name: 'D', midi: 38 },
  { name: 'G', midi: 43 },
  { name: 'C', midi: 48 }
]

export interface TunerReading {
  /** e.g. "E" */
  note: string
  octave: number
  midi: number
  /** −50..+50 from the nearest note */
  cents: number
  /** Open string this note is (if any) */
  string: string | null
  hz: number
}

/** Frequency of A4 when the reference (440 Hz unless set otherwise) is shifted by `cents`. */
export function referenceA4(offsetCents = 0, base = 440): number {
  return base * Math.pow(2, offsetCents / 1200)
}

export function readNote(hz: number, a4 = 440): TunerReading | null {
  if (!(hz > 0) || !Number.isFinite(hz)) return null
  const exact = 69 + 12 * Math.log2(hz / a4)
  const midi = Math.round(exact)
  const cents = Math.round((exact - midi) * 1000) / 10 || 0 // no "−0"
  const string = BASS_STRINGS.find((s) => s.midi === midi)?.name ?? null
  return { note: NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1, midi, cents, string, hz }
}

/** Median of recent readings, to steady the needle without lagging. */
export function smoothHz(history: number[]): number | null {
  const valid = history.filter((h) => h > 0)
  if (valid.length < Math.ceil(history.length / 2)) return null
  const s = [...valid].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

export const IN_TUNE_CENTS = 3
