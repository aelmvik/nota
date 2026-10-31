# Third-party software

Nøta is built on the following software. Their licences decide what Nøta's own licence can be, and what a distributed build must include.

## Bundled in the app

| Component | Used for | Licence |
| --- | --- | --- |
| [JUCE](https://juce.com) 8.0.4 | The native audio engine: CoreAudio input/output, VST3 and Audio Unit hosting (on Windows with a local patch that opens WASAPI devices faster, native/patches) | AGPLv3, or a commercial JUCE licence |
| [Steinberg VST3 SDK](https://www.steinberg.net/developers/) (as bundled with JUCE 8.0.4) | VST3 plug-in hosting | GPLv3, or the proprietary Steinberg VST3 licence |
| [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) 1.4.0 and [Signalsmith Linear](https://github.com/Signalsmith-Audio/linear) 0.6.4 | Slow-down and live key change in the audio engine (Stretch carries a local pitch-accuracy patch, native/patches) | MIT |
| [Basic Pitch](https://github.com/spotify/basic-pitch) model (`separation/models/basic-pitch.onnx`, Spotify AB) | Reading the bass notes for the Notes view | Apache-2.0 (`separation/models/LICENSE-basic-pitch.txt`, `NOTICE-basic-pitch.txt`) |
| [FFmpeg](https://ffmpeg.org) 8.1.3, built from source by `scripts/build-tools.mjs` (audio only, no GPL parts) | Decoding, waveforms and format conversion (`ffmpeg`, `ffprobe` in `Resources/tools`) | LGPL-2.1-or-later (`FFmpeg-COPYING.LGPLv2.1.txt`) |
| FFmpeg 8.1.3 and LAME 3.100 on Windows: the same audio-only build from the same sources and flags, made by `scripts/build-tools.mjs` in [MSYS2](https://www.msys2.org) (UCRT64, MinGW-w64 GCC) and linked statically | The same, as `ffmpeg.exe` and `ffprobe.exe` | LGPL-2.1-or-later and LGPL-2.0-or-later, the same files as on the Mac. Besides Windows' own system libraries they contain only GCC's and MinGW-w64's runtime support code, which their licences (the GCC Runtime Library Exception; MinGW-w64's permissive runtime licences) allow in any program |
| [LAME](https://lame.sourceforge.io) 3.100, linked into FFmpeg | MP3 export | LGPL-2.0-or-later (`LAME-COPYING.txt`) |
| [Steinberg ASIO SDK](https://www.steinberg.net/developers/) 2.3.4 (Windows only, compiled into the audio engine; fetched by `scripts/build-engine.mjs`) | Low-latency audio with interfaces that have an ASIO driver | GPL-3.0, Steinberg's open-source option of the SDK's dual licence (combined with Nøta's AGPL-3.0 under section 13 of both licences). ASIO is a trademark and software of Steinberg Media Technologies GmbH |
| Microsoft Visual C++ runtime (Windows only: `msvcp140.dll`, `vcruntime140*.dll` and the rest of `Microsoft.VC143.CRT`, in `resources/tools/vcruntime`) | Lets PyTorch and the other Python packages run on PCs without the Visual C++ Redistributable | Microsoft's redistributable code, shipped under the Visual Studio redistribution terms |
| [uv](https://github.com/astral-sh/uv) 0.12.19 | Installing Python and the separation packages on first use | MIT or Apache-2.0 (`uv-LICENSE-*.txt`) |
| [Electron](https://www.electronjs.org) | Application shell | MIT |
| [React](https://react.dev) | User interface | MIT |
| [Archivo](https://fonts.google.com/specimen/Archivo) | Interface typeface | SIL Open Font License 1.1 (`src/renderer/fonts/OFL-Archivo.txt`) |
| [Big Shoulders Display](https://fonts.google.com/specimen/Big+Shoulders+Display) | Numerals | SIL Open Font License 1.1 (`src/renderer/fonts/OFL-BigShoulders.txt`) |

## Installed on first use (not bundled)

Separation, analysis and transcription run in a Python environment that Nøta creates with the bundled uv on the user's Mac (`~/Library/Application Support/Nøta`) from `separation/requirements.txt`. Nothing below ships inside the app.

| Component | Used for | Licence |
| --- | --- | --- |
| [Demucs](https://github.com/facebookresearch/demucs) (htdemucs, htdemucs_ft) | Separating the bass from the rest of the song | MIT (pretrained weights published by Meta) |
| [Python](https://www.python.org) 3.13 ([python-build-standalone](https://github.com/astral-sh/python-build-standalone), downloaded by uv) | Running the workers | PSF License (and the licences of its bundled libraries) |
| [PyTorch](https://pytorch.org) / torchaudio | Running Demucs on the Apple GPU or CPU | BSD-3-Clause |
| [beat_this](https://github.com/CPJKU/beat_this) | Beat and downbeat detection | MIT |
| [librosa](https://librosa.org) | Key and tuning detection, audio loading | ISC |
| [ONNX Runtime](https://onnxruntime.ai) | Running the Basic Pitch model | MIT |
| [SciPy](https://scipy.org) | Signal filtering | BSD-3-Clause |
| [NumPy](https://numpy.org) | Numerics | BSD-3-Clause |

## Why Nøta is AGPL-3.0

Nøta is licensed under the AGPL-3.0-or-later (see `LICENSE`). JUCE requires the AGPLv3 unless you buy a commercial licence, and the VST3 SDK bundled with it is GPLv3; the AGPL-3.0 satisfies both. FFmpeg and LAME are LGPL and linked statically; since Nøta's full source and the script that builds them are public, they can be rebuilt and relinked as the LGPL requires. A closed-source release would need a commercial JUCE licence (JUCE 8's free Starter tier covers small revenue) and the proprietary VST3 licence from Steinberg.
