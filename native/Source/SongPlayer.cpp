#include "SongPlayer.h"

#include <signalsmith-stretch/signalsmith-stretch.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <mutex>
#include <vector>

using juce::int64;

namespace
{
    constexpr int chunkFrames = 8192;     // cache granularity, in device-rate frames
    constexpr int maxPoolChunks = 160;    // per track: ≈ 27 s at 48 kHz (a short song is cached whole)
    constexpr int taps = 64;              // resampler: windowed sinc
    constexpr int halfTaps = taps / 2;
    constexpr int phases = 512;

    constexpr double modeFadeSeconds = 0.03;
    constexpr double seekFadeSeconds = 0.01;
    constexpr double loopFadeSeconds = 0.005;
    constexpr double startFadeSeconds = 0.003;
    constexpr double pauseFadeSeconds = 0.01;
    constexpr double minLoopSeconds = 0.05;
    constexpr double waitLimitSeconds = 1.5; // give up waiting for the disk after this

    double besselI0 (double x)
    {
        double sum = 1.0, term = 1.0;
        for (int k = 1; k < 32; ++k)
        {
            const double t = x / (2.0 * k);
            term *= t * t;
            sum += term;
        }
        return sum;
    }

    // Stateless polyphase windowed-sinc kernel: every output frame is computed
    // from the source alone, so chunks decoded separately join seamlessly.
    struct Kernel
    {
        double ratio = 1.0; // source frames per device frame
        std::vector<float> table; // (phases + 1) rows of `taps`

        void build (double r)
        {
            ratio = r;
            table.clear();
            if (r == 1.0)
                return;

            const double fc = 0.94 * std::min (1.0, 1.0 / r); // cutoff, relative to the source Nyquist
            const double beta = 8.5, i0b = besselI0 (beta);
            table.assign ((size_t) (phases + 1) * taps, 0.0f);

            for (int p = 0; p <= phases; ++p)
            {
                const double frac = (double) p / phases;
                float* row = &table[(size_t) p * taps];
                double sum = 0.0;
                for (int j = 0; j < taps; ++j)
                {
                    const double x = frac + (halfTaps - 1) - j; // distance from the output instant to source tap j
                    const double u = x / halfTaps;
                    const double w = std::abs (u) < 1.0 ? besselI0 (beta * std::sqrt (1.0 - u * u)) / i0b : 0.0;
                    const double px = juce::MathConstants<double>::pi * fc * x;
                    const double s = std::abs (px) < 1e-12 ? 1.0 : std::sin (px) / px;
                    row[j] = (float) (fc * s * w);
                    sum += row[j];
                }
                for (int j = 0; j < taps; ++j)
                    row[j] = (float) (row[j] / sum); // unity gain at DC for every phase
            }
        }
    };

    template <typename T, int N>
    struct Ring
    {
        static_assert ((N & (N - 1)) == 0, "power of two");
        T items[N];
        int64 count = 0;

        void clear() noexcept                     { count = 0; }
        void push (const T& v) noexcept           { items[count & (N - 1)] = v; ++count; }
        T& at (int64 i) noexcept                  { return items[i & (N - 1)]; }
        int64 oldest() const noexcept             { return std::max<int64> (0, count - N); }
    };

    struct BlockMark { int64 out; double in; };
    struct SegMark   { int64 in; int64 pos; juce::uint32 id; };
    struct SongPos   { double pos; juce::uint32 id; int64 segIndex; };
}

//==============================================================================
// One audio file, streamed from disk at the device rate.
class StreamedTrack
{
public:
    StreamedTrack (std::unique_ptr<juce::AudioFormatReader> r, double deviceRateIn, const juce::String& pathIn)
        : path (pathIn), deviceRate (deviceRateIn), reader (std::move (r))
    {
        ratio = reader->sampleRate / deviceRate;
        if (std::abs (ratio - 1.0) < 1e-9)
            ratio = 1.0;
        sourceLength = reader->lengthInSamples;
        length = ratio == 1.0 ? sourceLength : (int64) std::floor ((double) (sourceLength - 1) / ratio) + 1;
        numChunks = (int) ((length + chunkFrames - 1) / chunkFrames);

        table.reset (new std::atomic<int>[(size_t) numChunks]);
        for (int k = 0; k < numChunks; ++k)
            table[(size_t) k].store (-1);
        keep.assign ((size_t) numChunks, 0);

        numSlots = std::min (numChunks, maxPoolChunks);
        slots.reset (new Slot[(size_t) numSlots]);
        pool.assign ((size_t) numSlots * chunkFrames * 2, 0.0f);

        kernel.build (ratio);
        decodeBuffer.setSize (2, (int) std::ceil (chunkFrames * ratio) + taps + 8);
    }

    double durationSeconds() const { return (double) length / deviceRate; }

    //==========================================================================
    // Audio thread

    /** Overwrites [start, start + n) into L/R. False if part of it isn't cached (zeros there). */
    bool read (int64 start, int n, float* L, float* R) const noexcept
    {
        bool complete = true;
        while (n > 0)
        {
            if (start < 0 || start >= length)
            {
                const int m = start < 0 ? (int) std::min<int64> (n, -start) : n;
                juce::FloatVectorOperations::clear (L, m);
                juce::FloatVectorOperations::clear (R, m);
                start += m; L += m; R += m; n -= m;
                continue;
            }
            const int k = (int) (start / chunkFrames);
            const int offset = (int) (start - (int64) k * chunkFrames);
            const int m = (int) std::min<int64> ({ (int64) n, (int64) (chunkFrames - offset), length - start });
            if (! readChunk (k, offset, m, L, R))
            {
                juce::FloatVectorOperations::clear (L, m);
                juce::FloatVectorOperations::clear (R, m);
                complete = false;
            }
            start += m; L += m; R += m; n -= m;
        }
        return complete;
    }

    bool isCached (int64 start, int64 n) const noexcept
    {
        const int64 end = std::min (start + n, length);
        start = std::max<int64> (0, start);
        for (int64 k = start / chunkFrames; k * chunkFrames < end; ++k)
            if (table[(size_t) k].load (std::memory_order_acquire) < 0)
                return false;
        return true;
    }

    //==========================================================================
    // Loader thread

    void clearKeep() { std::fill (keep.begin(), keep.end(), (char) 0); }

    void markKeep (int64 start, int64 end)
    {
        for (int64 k = std::max<int64> (0, start / chunkFrames); k < numChunks && k * chunkFrames < end; ++k)
            keep[(size_t) k] = 1;
    }

    /** Loads the first missing chunk in [start, end). Returns 1 if it loaded one, 0 if all there, -1 if the pool is full. */
    int loadFirstMissing (int64 start, int64 end)
    {
        for (int64 k = std::max<int64> (0, start / chunkFrames); k < numChunks && k * chunkFrames < end; ++k)
            if (table[(size_t) k].load (std::memory_order_relaxed) < 0)
                return loadChunk ((int) k) ? 1 : -1;
        return 0;
    }

    const juce::String path;
    const double deviceRate;
    int64 length = 0;   // device-rate frames

private:
    struct Slot
    {
        std::atomic<int> chunk { -1 };
        std::atomic<juce::uint32> seq { 0 };   // odd while being written (seqlock)
        juce::uint64 stamp = 0;                // loader only: for least-recently-loaded eviction
    };

    bool readChunk (int k, int offset, int m, float* L, float* R) const noexcept
    {
        const int s = table[(size_t) k].load (std::memory_order_acquire);
        if (s < 0)
            return false;
        auto& slot = slots[(size_t) s];
        const auto before = slot.seq.load (std::memory_order_acquire);
        if ((before & 1) != 0 || slot.chunk.load (std::memory_order_relaxed) != k)
            return false;
        const float* base = pool.data() + (size_t) s * chunkFrames * 2;
        std::memcpy (L, base + offset, sizeof (float) * (size_t) m);
        std::memcpy (R, base + chunkFrames + offset, sizeof (float) * (size_t) m);
        std::atomic_thread_fence (std::memory_order_acquire);
        return slot.seq.load (std::memory_order_relaxed) == before;
    }

    bool loadChunk (int k)
    {
        int target = -1;
        juce::uint64 oldest = std::numeric_limits<juce::uint64>::max();
        for (int s = 0; s < numSlots; ++s)
        {
            const int c = slots[(size_t) s].chunk.load (std::memory_order_relaxed);
            if (c < 0)
            {
                target = s;
                break;
            }
            if (! keep[(size_t) c] && slots[(size_t) s].stamp < oldest)
            {
                oldest = slots[(size_t) s].stamp;
                target = s;
            }
        }
        if (target < 0)
            return false;

        auto& slot = slots[(size_t) target];
        const int previous = slot.chunk.load (std::memory_order_relaxed);
        if (previous >= 0)
            table[(size_t) previous].store (-1, std::memory_order_release);

        slot.seq.fetch_add (1, std::memory_order_acq_rel); // odd: readers back off
        float* base = pool.data() + (size_t) target * chunkFrames * 2;
        decode (k, base, base + chunkFrames);
        slot.chunk.store (k, std::memory_order_relaxed);
        slot.seq.fetch_add (1, std::memory_order_release);
        slot.stamp = ++loadCounter;
        table[(size_t) k].store (target, std::memory_order_release);
        return true;
    }

    void decode (int k, float* L, float* R)
    {
        const int64 d0 = (int64) k * chunkFrames;
        const int n = (int) std::min<int64> (chunkFrames, length - d0);
        juce::FloatVectorOperations::clear (L, chunkFrames);
        juce::FloatVectorOperations::clear (R, chunkFrames);

        auto readSource = [this] (int64 start, int count) { readRange (start, count); };

        if (ratio == 1.0)
        {
            readSource (d0, n);
            std::memcpy (L, decodeBuffer.getReadPointer (0), sizeof (float) * (size_t) n);
            std::memcpy (R, decodeBuffer.getReadPointer (1), sizeof (float) * (size_t) n);
            return;
        }

        const int64 srcStart = (int64) std::floor ((double) d0 * ratio) - halfTaps + 1;
        const int64 srcEnd = (int64) std::floor ((double) (d0 + n - 1) * ratio) + halfTaps + 1;
        const int srcCount = (int) (srcEnd - srcStart);
        readSource (srcStart, srcCount);
        const float* sl = decodeBuffer.getReadPointer (0);
        const float* sr = decodeBuffer.getReadPointer (1);

        for (int i = 0; i < n; ++i)
        {
            const double t = (double) (d0 + i) * ratio;
            const double whole = std::floor (t);
            const double phase = (t - whole) * phases;
            const int p = std::min (phases - 1, (int) phase);
            const float f = (float) (phase - p);
            const float* row0 = &kernel.table[(size_t) p * taps];
            const float* row1 = row0 + taps;
            const int base = (int) ((int64) whole - halfTaps + 1 - srcStart);
            float accL = 0.0f, accR = 0.0f;
            for (int j = 0; j < taps; ++j)
            {
                const float c = row0[j] + f * (row1[j] - row0[j]);
                accL += c * sl[base + j];
                accR += c * sr[base + j];
            }
            L[i] = accL;
            R[i] = accR;
        }
    }

    /**
     * Fills decodeBuffer[0, count) with source frames [start, start + count).
     *
     * The file is only ever read forwards: the overlap with the previous read
     * (resampling needs a few dozen frames of context) is kept from memory, and
     * after a jump the file is opened afresh. JUCE's FLAC reader returned
     * silence for short backward reads, which at a resampled device rate (say
     * 24 kHz Bluetooth) meant every chunk.
     */
    void readRange (int64 start, int count)
    {
        if (count > decodeBuffer.getNumSamples())
            decodeBuffer.setSize (2, count, true, false, true);

        int kept = 0;
        if (bufferedCount > 0 && start >= bufferedStart && start < bufferedStart + bufferedCount)
        {
            kept = (int) std::min<int64> (count, bufferedStart + bufferedCount - start);
            const int from = (int) (start - bufferedStart);
            for (int ch = 0; ch < 2; ++ch)
                std::memmove (decodeBuffer.getWritePointer (ch), decodeBuffer.getReadPointer (ch) + from, sizeof (float) * (size_t) kept);
        }
        if (kept < count)
            readFromFile (start + kept, kept, count - kept);
        bufferedStart = start;
        bufferedCount = count;
    }

    void readFromFile (int64 pos, int offset, int n)
    {
        decodeBuffer.clear (offset, n);
        if (pos < 0)
        {
            const int silence = (int) std::min<int64> (n, -pos);
            offset += silence;
            n -= silence;
            pos = 0;
        }
        if (n <= 0 || pos >= sourceLength)
            return;
        bool ok = true;
        if (pos == readerNext)
            ok = reader->read (&decodeBuffer, offset, n, pos, true, true);
        if (pos != readerNext || ! ok)
            ok = jumpAndRead (pos, offset, n);
        if (reader->numChannels == 1)
            decodeBuffer.copyFrom (1, offset, decodeBuffer, 0, offset, n);
        readerNext = ok ? pos + n : -1;
    }

    /**
     * A read that doesn't continue the previous one: open the file afresh and
     * start at a 4096-frame boundary. JUCE's FLAC reader seeks in 512-frame
     * steps and returned silence when asked to start in between.
     */
    bool jumpAndRead (int64 pos, int offset, int n)
    {
        if (reopen)
            if (auto fresh = reopen())
                reader = std::move (fresh);
        const int64 aligned = pos & ~(int64) 4095;
        const int lead = (int) (pos - aligned);
        alignBuffer.setSize (2, lead + n, false, false, true);
        alignBuffer.clear();
        const bool ok = reader->read (&alignBuffer, 0, lead + n, aligned, true, true);
        for (int ch = 0; ch < 2; ++ch)
            decodeBuffer.copyFrom (ch, offset, alignBuffer, juce::jmin (ch, (int) reader->numChannels - 1), lead, n);
        return ok;
    }

public:
    /** Opens the file again (a fresh reader after a jump). */
    std::function<std::unique_ptr<juce::AudioFormatReader>()> reopen;

private:
    std::unique_ptr<juce::AudioFormatReader> reader;
    juce::AudioBuffer<float> alignBuffer;
    int64 readerNext = 0, bufferedStart = 0;
    int bufferedCount = 0;
    double ratio = 1.0;
    int64 sourceLength = 0;
    int numChunks = 0, numSlots = 0;
    std::unique_ptr<std::atomic<int>[]> table;   // chunk -> slot, -1 when not cached
    std::unique_ptr<Slot[]> slots;
    std::vector<float> pool;                     // per slot: chunkFrames left, then chunkFrames right
    std::vector<char> keep;                      // loader: chunks wanted right now
    juce::uint64 loadCounter = 0;
    Kernel kernel;
    juce::AudioBuffer<float> decodeBuffer;

    JUCE_DECLARE_NON_COPYABLE (StreamedTrack)
};

//==============================================================================
struct Stretcher
{
    using Engine = signalsmith::stretch::SignalsmithStretch<float>;
    Engine engine;      // speed changes only
    Engine keyEngine;   // key changes (with or without speed): a longer block, so bass notes land on pitch
};

struct BeatList
{
    std::vector<double> times;     // seconds of song time, ascending
    std::vector<char> accents;
};

// Cut regions (seconds of song time, sorted, not overlapping): playback skips them.
struct CutList
{
    std::vector<std::pair<double, double>> regions;
};

//==============================================================================
struct SongPlayer::Impl : public juce::Thread
{
    Impl() : juce::Thread ("Song loader")
    {
        formats.registerBasicFormats();
        startThread (juce::Thread::Priority::normal);
    }

    ~Impl() override
    {
        stopThread (2000);
    }

    //==========================================================================
    // Shared configuration

    juce::AudioFormatManager formats;
    double sampleRate = 48000.0;
    int maxBlock = 0;
    bool prepared = false;
    bool lightweight = false;

    // Message-thread ownership; the loader walks `tracks` under the mutex.
    std::mutex ownedMutex;
    std::vector<std::unique_ptr<StreamedTrack>> tracks;
    std::vector<std::unique_ptr<Stretcher>> stretchers;
    std::vector<std::unique_ptr<BeatList>> beatLists;
    std::vector<std::unique_ptr<CutList>> cutLists;
    CutList* loaderCuts = nullptr; // the latest list, for the loader's look-ahead (under ownedMutex)
    struct SlotInfo { TrackSpec spec; StreamedTrack* track = nullptr; } slotInfo[numSlots];

    //==========================================================================
    // Message -> audio commands, audio -> message retirements (single producer, single consumer)

    enum class Cmd { setTrack, play, pause, stop, seek, park, setMode, setLoop, setBeats, setCuts, setStretcher, unload };

    struct Command
    {
        Cmd type;
        int seq = 0;
        int slot = 0;
        double a = 0.0, b = 0.0;
        bool flag = false;
        int countBeats = 0, perBar = 4;
        void* ptr = nullptr;
    };

    enum class Kind { track, stretcher, beats, cuts };
    struct Retired { Kind kind; void* ptr; };

    static constexpr int fifoSize = 512;
    juce::AbstractFifo commandFifo { fifoSize };
    Command commands[fifoSize];
    juce::AbstractFifo retireFifo { fifoSize };
    Retired retired[fifoSize];

    void push (const Command& c)
    {
        const auto scope = commandFifo.write (1);
        if (scope.blockSize1 > 0)
            commands[scope.startIndex1] = c;
        else
            jassertfalse; // full: the audio thread is not running
    }

    void retire (Kind kind, void* ptr) noexcept
    {
        if (ptr == nullptr)
            return;
        const auto scope = retireFifo.write (1);
        if (scope.blockSize1 > 0)
            retired[scope.startIndex1] = { kind, ptr };
        // If full, the object leaks rather than being freed on the audio thread.
    }

    void housekeeping()
    {
        while (retireFifo.getNumReady() > 0)
        {
            Retired r {};
            {
                const auto scope = retireFifo.read (1);
                if (scope.blockSize1 == 0)
                    break;
                r = retired[scope.startIndex1];
            }
            const std::lock_guard<std::mutex> lock (ownedMutex);
            auto drop = [&r] (auto& list)
            {
                for (auto it = list.begin(); it != list.end(); ++it)
                    if (it->get() == r.ptr)
                    {
                        list.erase (it);
                        return;
                    }
            };
            if (r.kind == Kind::track) drop (tracks);
            else if (r.kind == Kind::stretcher) drop (stretchers);
            else if (r.kind == Kind::cuts) drop (cutLists);
            else drop (beatLists);
        }
    }

    //==========================================================================
    // Parameters the audio thread reads every block

    std::atomic<double> speed { 1.0 }, pitchRatio { 1.0 };
    std::atomic<bool> returnToStart { true }, metronomeOn { false };
    std::atomic<float> songVolume { 1.0f }, masterVolume { 0.9f }, metronomeVolume { 0.6f };

    // Published by the audio thread for the loader (device-rate frames)
    std::atomic<int64> pubHead { 0 }, pubSeek { -1 }, pubCue { 0 }, pubLoopStart { 0 }, pubLoopEnd { 0 };
    std::atomic<bool> pubLoopOn { false };
    std::atomic<int> pubMode { 0 };

    // Published for snapshots (seqlock: the audio thread never waits)
    struct Snap
    {
        double pos = 0.0;
        int64 ticks = 0;
        int frames = 0;
        int state = 0;
        bool buffering = false;
        double rate = 1.0;
        int mode = 0;
        int seq = 0;
        juce::uint32 wraps = 0, ended = 0;
        int64 length = 0;
        double sampleRate = 48000.0;
        int countInLeft = 0;
    };
    std::atomic<juce::uint32> snapSeq { 0 };
    Snap snap;
    Snap lastSent;
    bool forceSnapshot = true;

    std::atomic<float> songPeak { 0.0f };
    std::atomic<bool> songClipped { false };
    std::atomic<int> underruns { 0 };

    //==========================================================================
    // Audio-thread state

    struct Voice
    {
        bool active = false;
        bool stretching = false;
        Stretcher* stretcher = nullptr;
        Stretcher::Engine* engine = nullptr;   // stretcher->engine or ->keyEngine
        StreamedTrack* tracks[numSlots] {};
        float gain[numSlots] {}, target[numSlots] {};
        float transpose = 1.0f;
        int64 head = 0;            // next song frame to read
        double inputAcc = 0.0;
        int64 tailPos = 0;         // loop wrap: the audio past the loop end, fading out
        int tailLeft = 0;
        int64 inCount = 0, outCount = 0;
        int latIn = 0, latOut = 0;
        Ring<BlockMark, 4096> marks;   // (output frame, input frame) at each block start
        Ring<SegMark, 256> segs;       // where the input jumped (start, loop wraps)
        juce::uint32 nextSegId = 1;
        juce::uint32 clickSeg = 0;     // metronome: segment of the last span
    };

    enum State { stopped = 0, starting = 1, countIn = 2, playing = 3 };

    StreamedTrack* slots[numSlots] {};
    Voice voices[2];
    int mainVoice = 0;
    int switchLeft = 0, switchTotal = 1;
    bool switchWanted = false;
    Stretcher* voiceStretcher[2] {};
    Stretcher* pendingStretcher[2] {};
    StreamedTrack* retiring[16] {};

    State state = stopped;
    float outGain = 0.0f, outTarget = 0.0f, outStep = 0.0f;
    bool stopAfterFade = false, returnAfterFade = false;
    int64 parked = 0, cue = 0;
    int64 seekTarget = -1;
    int seekSeq = 0, appliedSeq = 0;
    int waitFrames = 0;
    int mode = 0, pendingMode = -1;
    int64 loopStart = 0, loopEnd = 0;
    bool loopOn = false;
    double loopStartSec = 0.0, loopEndSec = 0.0;
    bool loopWanted = false;
    int64 songLength = 0;
    juce::uint32 wraps = 0, ended = 0;

    double countPeriod = 0.0;
    int countBeats = 0, countPerBar = 4, countClicked = 0;
    int64 countElapsed = 0;

    BeatList* beats = nullptr;
    CutList* cuts = nullptr;
    struct Click { const float* data = nullptr; int length = 0; int pos = 0; };
    Click clicks[8];
    std::vector<float> accentClick, normalClick;

    float songGain = 1.0f;
    juce::AudioBuffer<float> mixBuffer, voiceBuffer, inBuffer, scratchBuffer, tailBuffer;
    int maxInput = 0;
    int tailFrames = 1;
    float gainStep = 0.001f;

    //==========================================================================
    // Device

    void configureStretcher (Stretcher& s)
    {
        if (lightweight)
            s.engine.presetCheaper (2, (float) sampleRate);
        else
            s.engine.presetDefault (2, (float) sampleRate);

        // The presets' 0.1-0.12 s blocks can't separate the partials of low bass notes
        // (41 Hz apart at E1), which puts key-changed bass tens of cents off pitch. A 0.2 s
        // block resolves them; with the patched peak mapping, key changes land within
        // about 0.1 cent from E1 up.
        const int block = (int) (sampleRate * 0.2);
        if (lightweight)
            s.keyEngine.configure (2, block, (int) (sampleRate * 0.08), true);
        else
            s.keyEngine.configure (2, block, (int) (sampleRate * 0.05));
    }

    std::unique_ptr<Stretcher> makeStretcher()
    {
        auto s = std::make_unique<Stretcher>();
        configureStretcher (*s);
        return s;
    }

    void prepare (double sr, int block)
    {
        // The audio callback is not running here. Apply anything still queued
        // first, so no command refers to the old configuration.
        drainCommands();
        housekeeping();

        // A device restart (new buffer size, rate or device) carries on playing from where it was.
        const bool wasPlaying = state != stopped;
        if (state == playing)
        {
            auto& v = voices[mainVoice];
            parked = seekTarget >= 0 ? seekTarget : clampPos ((int64) std::llround (audiblePos (v, (double) v.outCount)));
        }
        stopNow();
        seekTarget = -1;

        const bool rateChanged = std::abs (sr - sampleRate) > 0.5;
        const double oldRate = sampleRate;
        sampleRate = sr;
        maxBlock = juce::jmax (16, block) * 2;

        if (rateChanged)
        {
            // Everything streamed is at the device rate: reopen the tracks, keep positions in seconds.
            const double k = sr / oldRate;
            parked = (int64) std::llround ((double) parked * k);
            cue = (int64) std::llround ((double) cue * k);
        }

        {
            const std::lock_guard<std::mutex> lock (ownedMutex);
            for (int s = 0; s < numSlots; ++s)
            {
                auto& info = slotInfo[s];
                if (info.track == nullptr || std::abs (info.track->deviceRate - sr) < 0.5)
                    continue;
                auto fresh = openTrack (info.spec);
                for (auto it = tracks.begin(); it != tracks.end(); ++it)
                    if (it->get() == info.track)
                    {
                        tracks.erase (it);
                        break;
                    }
                info.track = fresh.get();
                slots[s] = info.track;
                if (fresh != nullptr)
                    tracks.push_back (std::move (fresh));
            }

            stretchers.clear();
            for (int v = 0; v < 2; ++v)
            {
                voices[v] = Voice();
                stretchers.push_back (makeStretcher());
                voiceStretcher[v] = stretchers.back().get();
                pendingStretcher[v] = nullptr;
            }
        }
        recomputeLength();
        applyLoop();

        maxInput = maxBlock * 4 + 64;
        for (const auto* probe : { &voiceStretcher[0]->engine, &voiceStretcher[0]->keyEngine })
            maxInput = juce::jmax (maxInput, probe->inputLatency() + 2 * probe->outputLatency() + 64);
        mixBuffer.setSize (2, maxBlock, false, true, false);
        voiceBuffer.setSize (4, maxBlock, false, true, false);
        inBuffer.setSize (2, maxInput, false, true, false);
        scratchBuffer.setSize (2, maxInput, false, true, false);
        tailBuffer.setSize (2, maxInput, false, true, false);
        tailFrames = juce::jmax (1, (int) (loopFadeSeconds * sr));
        gainStep = (float) (1.0 / (modeFadeSeconds * sr));

        makeClick (accentClick, 1760.0, 0.9);
        makeClick (normalClick, 1175.0, 0.6);
        for (auto& c : clicks)
            c = {};

        prepared = true;
        forceSnapshot = true;
        if (wasPlaying && songLength > 0)
        {
            state = starting;
            waitFrames = 0;
        }
        notify();
    }

    void makeClick (std::vector<float>& out, double freq, double level)
    {
        const int len = (int) std::round (sampleRate * 0.045);
        out.assign ((size_t) len, 0.0f);
        for (int i = 0; i < len; ++i)
        {
            const double t = i / sampleRate;
            const double env = std::exp (-t * 90.0) * std::min (1.0, i / 24.0);
            out[(size_t) i] = (float) (level * env * (std::sin (2 * juce::MathConstants<double>::pi * freq * t)
                                                       + 0.3 * std::sin (4 * juce::MathConstants<double>::pi * freq * t)));
        }
    }

    std::unique_ptr<StreamedTrack> openTrack (const TrackSpec& spec)
    {
        if (spec.path.isEmpty())
            return {};
        const juce::File file (spec.path);
        std::unique_ptr<juce::AudioFormatReader> reader (formats.createReaderFor (file));
        if (reader == nullptr || reader->lengthInSamples <= 0 || reader->sampleRate <= 0)
            return {};
        auto track = std::make_unique<StreamedTrack> (std::move (reader), sampleRate, spec.path);
        track->reopen = [this, file]
        {
            return std::unique_ptr<juce::AudioFormatReader> (formats.createReaderFor (file));
        };
        return track;
    }

    //==========================================================================
    // Loader thread

    std::atomic<juce::uint32> loaderRequest { 0 }, loaderIdle { 0 };

    void run() override
    {
        while (! threadShouldExit())
        {
            const auto request = loaderRequest.load();
            bool worked = false;
            {
                const std::lock_guard<std::mutex> lock (ownedMutex);
                worked = loadSomething();
            }
            if (! worked)
            {
                loaderIdle.store (request);
                wait (15);
            }
        }
    }

    /** Blocks until the loader has nothing left to do (offline rendering and tests). */
    bool waitUntilLoaded (int timeoutMs)
    {
        const auto request = loaderRequest.fetch_add (1) + 1;
        notify();
        const auto until = juce::Time::getMillisecondCounter() + (juce::uint32) timeoutMs;
        while ((juce::int32) (loaderIdle.load() - request) < 0)
        {
            if (juce::Time::getMillisecondCounter() > until)
                return false;
            juce::Thread::sleep (1);
        }
        return true;
    }

    bool loadSomething()
    {
        if (tracks.empty())
            return false;

        const double sr = sampleRate;
        const int64 head = pubHead.load(), seek = pubSeek.load(), cuePos = pubCue.load();
        const int64 ls = pubLoopStart.load(), le = pubLoopEnd.load();
        const bool looping = pubLoopOn.load();
        const int active = juce::jlimit (0, numSlots - 1, pubMode.load());
        auto secs = [sr] (double s) { return (int64) (s * sr); };

        struct Range { int64 start, end; };
        Range ranges[20];
        int numRanges = 0;
        auto add = [&] (int64 a, int64 b) { if (b > a && numRanges < 20) ranges[numRanges++] = { a, b }; };

        // Where playback lands after the next few cuts.
        if (loaderCuts != nullptr)
        {
            int added = 0;
            for (auto& [cs, ce] : loaderCuts->regions)
                if (secs (ce) > head && added++ < 6)
                    add (secs (ce), secs (ce) + secs (1.5));
        }

        if (seek >= 0)
            add (seek, seek + secs (0.6));
        add (head - secs (0.25), head + secs (1.5));
        if (looping)
        {
            add (ls, ls + secs (1.5));
            add (le, le + secs (0.1));
        }
        add (cuePos, cuePos + secs (1.0));
        // Look ahead, following the loop.
        int64 from = head + secs (1.5), budget = secs (12.0);
        for (int guard = 0; guard < 4 && budget > 0; ++guard)
        {
            if (looping && from >= le && head < le)
                from = ls + (from - le);
            const int64 limit = (looping && from < le) ? le + secs (0.1) : from + budget;
            const int64 to = std::min (from + budget, limit);
            add (from, to);
            budget -= (to - from);
            from = to;
            if (! looping || head >= le)
                break;
        }
        if (seek >= 0)
            add (seek, seek + secs (6.0));

        // The selected track first, then the others, then any waiting to be swapped in.
        StreamedTrack* order[8];
        int numOrder = 0;
        auto addTrack = [&] (StreamedTrack* t)
        {
            if (t == nullptr || numOrder >= 8)
                return;
            for (int i = 0; i < numOrder; ++i)
                if (order[i] == t)
                    return;
            order[numOrder++] = t;
        };
        addTrack (slotInfo[active].track);
        for (auto& s : slotInfo)
            addTrack (s.track);
        for (auto& t : tracks)
            addTrack (t.get());

        bool full[8] {};
        for (int i = 0; i < numOrder; ++i)
        {
            order[i]->clearKeep();
            for (int r = 0; r < numRanges; ++r)
                order[i]->markKeep (ranges[r].start, ranges[r].end);
        }
        for (int r = 0; r < numRanges; ++r)
            for (int i = 0; i < numOrder; ++i)
            {
                if (full[i])
                    continue;
                const int res = order[i]->loadFirstMissing (ranges[r].start, ranges[r].end);
                if (res > 0)
                    return true;
                if (res < 0)
                    full[i] = true;
            }
        return false;
    }

    //==========================================================================
    // Audio thread: commands

    void drainCommands() noexcept
    {
        while (commandFifo.getNumReady() > 0)
        {
            Command c;
            {
                const auto scope = commandFifo.read (1);
                if (scope.blockSize1 == 0)
                    break;
                c = commands[scope.startIndex1];
            }
            apply (c);
            appliedSeq = std::max (appliedSeq, c.seq);
        }
    }

    int64 toFrames (double seconds) const noexcept { return (int64) std::llround (seconds * sampleRate); }

    int64 clampPos (int64 f) const noexcept
    {
        const int64 maxPos = songLength > 0 ? std::max<int64> (0, songLength - toFrames (0.01)) : 0;
        return juce::jlimit<int64> (0, maxPos, f);
    }

    void apply (const Command& c) noexcept
    {
        switch (c.type)
        {
            case Cmd::setTrack:
            {
                auto* fresh = static_cast<StreamedTrack*> (c.ptr);
                auto* old = slots[c.slot];
                slots[c.slot] = fresh;
                recomputeLength();
                applyLoop();
                if (old != nullptr)
                    scheduleRetire (old);
                waitFrames = 0; // an audible swap waits (briefly) for the new file
                break;
            }
            case Cmd::unload:
                stopNow();
                parked = cue = 0;
                seekTarget = -1;
                pendingMode = -1;
                break;
            case Cmd::park:
                stopNow();
                parked = cue = clampPos (toFrames (c.a));
                seekTarget = -1;
                mode = c.slot;
                pendingMode = -1;
                break;
            case Cmd::play:
                if (state == playing)
                {
                    // Pressed again while fading out: keep playing.
                    stopAfterFade = false;
                    outTarget = 1.0f;
                    break;
                }
                if (state != stopped || songLength <= 0)
                    break;
                {
                    int64 pos = parked;
                    if (pos >= songLength - 1)
                        pos = 0;
                    if (loopOn && pos >= loopEnd)
                        pos = loopStart;
                    parked = cue = pos;
                }
                countBeats = c.countBeats;
                countPeriod = c.a * sampleRate;
                countPerBar = juce::jmax (1, c.perBar);
                countClicked = 0;
                countElapsed = 0;
                waitFrames = 0;
                state = (countBeats > 0 && countPeriod > 0) ? countIn : starting;
                break;
            case Cmd::pause:
            case Cmd::stop:
            {
                const bool back = c.type == Cmd::stop && returnToStart.load();
                if (state == playing)
                {
                    stopAfterFade = true;
                    returnAfterFade = back;
                    outTarget = 0.0f;
                    outStep = (float) (1.0 / (pauseFadeSeconds * sampleRate));
                }
                else
                {
                    state = stopped;
                    if (back)
                        parked = cue;
                }
                break;
            }
            case Cmd::seek:
            {
                const int64 target = clampPos (toFrames (c.a));
                cue = target;
                if (state == playing && ! stopAfterFade)
                {
                    seekTarget = target;
                    seekSeq = c.seq;
                    waitFrames = 0;
                }
                else
                {
                    parked = target;
                    seekTarget = -1;
                }
                break;
            }
            case Cmd::setMode:
                if (c.slot == mode)
                    pendingMode = -1;
                else if (state == playing)
                {
                    pendingMode = c.slot;
                    waitFrames = 0;
                }
                else
                {
                    mode = c.slot;
                    pendingMode = -1;
                }
                break;
            case Cmd::setLoop:
                loopStartSec = c.a;
                loopEndSec = c.b;
                loopWanted = c.flag;
                applyLoop();
                break;
            case Cmd::setCuts:
                retire (Kind::cuts, cuts);
                cuts = static_cast<CutList*> (c.ptr);
                break;
            case Cmd::setBeats:
                retire (Kind::beats, beats);
                beats = static_cast<BeatList*> (c.ptr);
                for (auto& v : voices)
                    v.clickSeg = 0;
                break;
            case Cmd::setStretcher:
            {
                auto* s = static_cast<Stretcher*> (c.ptr);
                const int v = c.slot;
                if (! voices[v].active)
                {
                    retire (Kind::stretcher, voiceStretcher[v]);
                    retire (Kind::stretcher, pendingStretcher[v]);
                    pendingStretcher[v] = nullptr;
                    voiceStretcher[v] = s;
                }
                else
                {
                    retire (Kind::stretcher, pendingStretcher[v]);
                    pendingStretcher[v] = s;
                    switchWanted = true;
                }
                break;
            }
        }
    }

    void applyLoop() noexcept
    {
        loopStart = toFrames (loopStartSec);
        loopEnd = std::min (toFrames (loopEndSec), songLength);
        loopOn = loopWanted && loopEnd - loopStart >= toFrames (minLoopSeconds) && loopStart >= 0;
    }

    void recomputeLength() noexcept
    {
        songLength = 0;
        for (auto* t : slots)
            if (t != nullptr)
                songLength = std::max (songLength, t->length);
    }

    void stopNow() noexcept
    {
        state = stopped;
        stopAfterFade = false;
        switchLeft = 0;
        switchWanted = false;
        for (int v = 0; v < 2; ++v)
            deactivate (voices[v], v);
    }

    void scheduleRetire (StreamedTrack* t) noexcept
    {
        for (auto& r : retiring)
            if (r == nullptr)
            {
                r = t;
                break;
            }
        flushRetire();
    }

    void flushRetire() noexcept
    {
        for (auto& r : retiring)
        {
            if (r == nullptr)
                continue;
            bool used = false;
            for (auto* s : slots)
                used = used || s == r;
            for (auto& v : voices)
                for (auto* t : v.tracks)
                    used = used || (v.active && t == r);
            if (! used)
            {
                retire (Kind::track, r);
                r = nullptr;
            }
        }
    }

    void deactivate (Voice& v, int index) noexcept
    {
        v.active = false;
        for (auto*& t : v.tracks)
            t = nullptr;
        if (pendingStretcher[index] != nullptr)
        {
            retire (Kind::stretcher, voiceStretcher[index]);
            voiceStretcher[index] = pendingStretcher[index];
            pendingStretcher[index] = nullptr;
        }
        flushRetire();
    }

    //==========================================================================
    // Audio thread: reading the timeline

    void pushSeg (Voice& v) noexcept
    {
        v.segs.push ({ v.inCount, v.head, v.nextSegId++ });
    }

    /** The cut containing frame `pos`, as [start, end) frames, or false. */
    bool cutAt (int64 pos, int64& start, int64& end) const noexcept
    {
        if (cuts == nullptr)
            return false;
        for (auto& [s, e] : cuts->regions)
        {
            const int64 a = toFrames (s), b = toFrames (e);
            if (pos >= a && pos < b)
            {
                start = a;
                end = b;
                return true;
            }
            if (a > pos)
                break;
        }
        return false;
    }

    /** First cut start after `pos` (frames), or -1. */
    int64 nextCutStart (int64 pos) const noexcept
    {
        if (cuts != nullptr)
            for (auto& [s, e] : cuts->regions)
                if (toFrames (s) > pos)
                    return toFrames (s);
        return -1;
    }

    /** Skip a cut: jump to its end with the same short crossfade as a loop wrap. */
    void skipCut (Voice& v, int64 to) noexcept
    {
        v.tailPos = v.head;
        v.tailLeft = tailFrames;
        v.head = to;
        pushSeg (v);
    }

    void wrap (Voice& v) noexcept
    {
        v.tailPos = v.head;
        v.tailLeft = tailFrames;
        v.head = loopStart;
        pushSeg (v);
        ++wraps;
    }

    void mixTracks (Voice& v, int64 pos, int n, float* L, float* R, bool advance) noexcept
    {
        juce::FloatVectorOperations::clear (L, n);
        juce::FloatVectorOperations::clear (R, n);
        float* sL = scratchBuffer.getWritePointer (0);
        float* sR = scratchBuffer.getWritePointer (1);

        for (int s = 0; s < numSlots; ++s)
        {
            auto* t = v.tracks[s];
            float g = v.gain[s];
            const float tg = v.target[s];
            if (t == nullptr || (g == 0.0f && tg == 0.0f))
            {
                if (advance)
                    v.gain[s] = tg;
                continue;
            }
            if (! t->read (pos, n, sL, sR) && advance && g > 0.0f)
                underruns.fetch_add (1, std::memory_order_relaxed);

            if (g == tg)
            {
                juce::FloatVectorOperations::addWithMultiply (L, sL, g, n);
                juce::FloatVectorOperations::addWithMultiply (R, sR, g, n);
            }
            else
            {
                for (int i = 0; i < n; ++i)
                {
                    L[i] += sL[i] * g;
                    R[i] += sR[i] * g;
                    g = g < tg ? std::min (tg, g + gainStep) : std::max (tg, g - gainStep);
                }
            }
            if (advance)
                v.gain[s] = g;
        }
    }

    /** Reads n frames of the song for a voice: loops, the loop crossfade and track gains included. */
    void readInput (Voice& v, int n, float* L, float* R) noexcept
    {
        float* tL = tailBuffer.getWritePointer (0);
        float* tR = tailBuffer.getWritePointer (1);
        int done = 0;
        while (done < n)
        {
            if (loopOn && v.head >= loopEnd)
                wrap (v);
            int64 cs = 0, ce = 0;
            for (int guard = 0; guard < 4 && cutAt (v.head, cs, ce); ++guard)
            {
                skipCut (v, ce);
                if (loopOn && v.head >= loopEnd)
                    wrap (v);
            }
            int64 room = loopOn ? loopEnd - v.head : (int64) (n - done);
            const int64 nextCut = nextCutStart (v.head);
            if (nextCut > v.head)
                room = std::min (room, nextCut - v.head);
            const int m = (int) std::min<int64> (n - done, room);
            mixTracks (v, v.head, m, L + done, R + done, true);

            if (v.tailLeft > 0)
            {
                const int k = std::min (m, v.tailLeft);
                mixTracks (v, v.tailPos, k, tL, tR, false);
                for (int i = 0; i < k; ++i)
                {
                    const float w = (float) (tailFrames - v.tailLeft + i + 1) / (float) tailFrames;
                    L[done + i] = L[done + i] * w + tL[i] * (1.0f - w);
                    R[done + i] = R[done + i] * w + tR[i] * (1.0f - w);
                }
                v.tailPos += k;
                v.tailLeft -= k;
            }
            v.head += m;
            v.inCount += m;
            done += m;
        }
        if (loopOn && v.head >= loopEnd)
            wrap (v);
    }

    void renderVoice (Voice& v, float* L, float* R, int n, double spd) noexcept
    {
        v.marks.push ({ v.outCount, (double) v.inCount });
        if (! v.stretching)
        {
            readInput (v, n, L, R);
            v.outCount += n;
            return;
        }
        v.inputAcc += n * spd;
        const int inN = juce::jlimit (0, maxInput, (int) v.inputAcc);
        v.inputAcc -= inN;
        float* iL = inBuffer.getWritePointer (0);
        float* iR = inBuffer.getWritePointer (1);
        readInput (v, inN, iL, iR);
        float* ins[2] = { iL, iR };
        float* outs[2] = { L, R };
        v.engine->process (ins, inN, outs, n);
        v.outCount += n;
    }

    struct Config { bool stretching; float transpose; };

    static bool keyChanged (float transpose) noexcept { return std::abs (transpose - 1.0f) > 1e-5f; }

    Config desiredConfig (double spd) const noexcept
    {
        const float tr = (float) pitchRatio.load();
        return { std::abs (spd - 1.0) > 1e-4 || keyChanged (tr), tr };
    }

    void primeVoice (int index, int64 pos, const Config& cfg, double spd) noexcept
    {
        auto& v = voices[index];
        if (pendingStretcher[index] != nullptr)
        {
            retire (Kind::stretcher, voiceStretcher[index]);
            voiceStretcher[index] = pendingStretcher[index];
            pendingStretcher[index] = nullptr;
        }
        v.active = true;
        v.stretching = cfg.stretching;
        v.stretcher = voiceStretcher[index];
        v.engine = keyChanged (cfg.transpose) ? &v.stretcher->keyEngine : &v.stretcher->engine;
        for (int s = 0; s < numSlots; ++s)
        {
            v.tracks[s] = slots[s];
            v.gain[s] = v.target[s] = s == mode ? 1.0f : 0.0f;
        }
        v.head = pos;
        v.inputAcc = 0.0;
        v.tailLeft = 0;
        v.inCount = v.outCount = 0;
        v.marks.clear();
        v.segs.clear();
        v.clickSeg = 0;
        pushSeg (v);

        if (cfg.stretching)
        {
            auto& st = *v.engine;
            st.setTransposeFactor (cfg.transpose);
            v.transpose = cfg.transpose;
            v.latIn = st.inputLatency();
            v.latOut = st.outputLatency();
            const int len = juce::jlimit (0, maxInput, st.outputSeekLength ((float) spd));
            float* iL = inBuffer.getWritePointer (0);
            float* iR = inBuffer.getWritePointer (1);
            readInput (v, len, iL, iR);
            float* ins[2] = { iL, iR };
            st.outputSeek (ins, len);
            v.marks.push ({ -(int64) v.latOut, (double) v.latIn });
        }
        else
        {
            v.transpose = 1.0f;
            v.latIn = v.latOut = 0;
        }
    }

    //==========================================================================
    // Audio thread: where the voice's output is in the song

    double audibleInput (Voice& v, double c) noexcept
    {
        const double target = c - v.latOut;
        if (v.marks.count == 0)
            return 0.0;
        for (int64 i = v.marks.count - 1; i >= v.marks.oldest(); --i)
        {
            auto& m = v.marks.at (i);
            if ((double) m.out <= target)
            {
                int64 nOut;
                double nIn;
                if (i == v.marks.count - 1) { nOut = v.outCount; nIn = (double) v.inCount; }
                else { nOut = v.marks.at (i + 1).out; nIn = v.marks.at (i + 1).in; }
                const double f = nOut > m.out ? (target - (double) m.out) / (double) (nOut - m.out) : 0.0;
                return m.in + std::min (1.0, f) * (nIn - m.in) - v.latIn;
            }
        }
        return v.marks.at (v.marks.oldest()).in - v.latIn;
    }

    SongPos songAt (Voice& v, double inC) noexcept
    {
        for (int64 i = v.segs.count - 1; i >= v.segs.oldest(); --i)
        {
            auto& s = v.segs.at (i);
            if ((double) s.in <= inC + 1e-6)
                return { (double) s.pos + (inC - (double) s.in), s.id, i };
        }
        auto& s = v.segs.at (v.segs.oldest());
        return { (double) s.pos, s.id, v.segs.oldest() };
    }

    double audiblePos (Voice& v, double c) noexcept { return songAt (v, audibleInput (v, c)).pos; }

    //==========================================================================
    // Audio thread: metronome

    void triggerClick (int offset, bool accent) noexcept
    {
        auto& buf = accent ? accentClick : normalClick;
        Click* slot = &clicks[0];
        for (auto& c : clicks)
            if (c.data == nullptr || c.pos >= c.length)
            {
                slot = &c;
                break;
            }
        *slot = { buf.data(), (int) buf.size(), -offset };
    }

    /** Clicks for beats heard in voice output [c0, c0 + n), written at block offset `at`. */
    void beatClicks (Voice& v, int64 c0, int n, int at) noexcept
    {
        if (beats == nullptr || beats->times.empty() || n <= 0)
            return;
        int64 cur = c0;
        const int64 end = c0 + n;
        for (int guard = 0; guard < 8 && cur < end; ++guard)
        {
            const double inStart = audibleInput (v, (double) cur);
            const auto p = songAt (v, inStart);
            // Find where this segment ends inside the block (a loop wrap).
            int64 lo = cur, hi = end;
            if (songAt (v, audibleInput (v, (double) end)).id != p.id)
            {
                while (hi - lo > 1)
                {
                    const int64 mid = (lo + hi) / 2;
                    if (songAt (v, audibleInput (v, (double) mid)).id == p.id) lo = mid;
                    else hi = mid;
                }
            }
            const int64 spanEnd = hi;
            const auto& seg = v.segs.at (p.segIndex);
            const double posStart = p.pos;
            const double posEnd = (double) seg.pos + (audibleInput (v, (double) spanEnd) - (double) seg.in);

            const bool fresh = v.clickSeg != p.id;
            v.clickSeg = p.id;
            const double from = (fresh ? posStart - 0.5 : posStart) / sampleRate;
            const double to = posEnd / sampleRate;
            if (to > from)
            {
                auto& times = beats->times;
                auto it = std::lower_bound (times.begin(), times.end(), from);
                for (; it != times.end() && *it < to; ++it)
                {
                    const double frac = juce::jlimit (0.0, 1.0, (*it * sampleRate - posStart) / std::max (1e-9, posEnd - posStart));
                    const int offset = at + (int) ((cur - c0) + (int64) (frac * (double) (spanEnd - cur)));
                    triggerClick (offset, beats->accents[(size_t) (it - times.begin())] != 0);
                }
            }
            cur = spanEnd;
        }
    }

    void renderClicks (float* L, float* R, int n, float volume) noexcept
    {
        for (auto& c : clicks)
        {
            if (c.data == nullptr || c.pos >= c.length)
                continue;
            for (int i = 0; i < n; ++i)
            {
                const int idx = c.pos + i;
                if (idx >= 0 && idx < c.length)
                {
                    L[i] += c.data[idx] * volume;
                    R[i] += c.data[idx] * volume;
                }
            }
            c.pos += n;
        }
    }

    //==========================================================================
    // Audio thread: the block

    bool readyAt (StreamedTrack* t, int64 pos) const noexcept
    {
        return t == nullptr || t->isCached (pos, toFrames (0.25));
    }

    /** Starts a crossfade from the current voice to a fresh one at `pos`. */
    void startSwitch (int64 pos, double fadeSeconds, const Config& cfg, double spd) noexcept
    {
        const int next = 1 - mainVoice;
        if (voices[next].active)
            deactivate (voices[next], next);
        primeVoice (next, pos, cfg, spd);
        mainVoice = next;
        switchTotal = switchLeft = juce::jmax (1, (int) (fadeSeconds * sampleRate));
        switchWanted = false;
    }

    void updateVoices (double spd, int n) noexcept
    {
        auto& v = voices[mainVoice];
        const auto cfg = desiredConfig (spd);
        waitFrames += n;
        const bool waitedLong = waitFrames > toFrames (waitLimitSeconds);

        if (switchLeft > 0)
            return; // one crossfade at a time; the rest waits until it ends

        if (seekTarget >= 0)
        {
            if (readyAt (slots[mode], seekTarget) || waitedLong)
            {
                startSwitch (seekTarget, seekFadeSeconds, cfg, spd);
                seekTarget = -1;
            }
            return;
        }

        if (pendingMode >= 0)
        {
            auto* target = slots[pendingMode];
            if (target == nullptr)
                pendingMode = -1;
            else if (readyAt (target, v.head) || waitedLong)
            {
                mode = pendingMode;
                pendingMode = -1;
                for (int s = 0; s < numSlots; ++s)
                    v.target[s] = s == mode ? 1.0f : 0.0f;
            }
        }

        // Tracks swapped under a playing voice: silent ones change in place,
        // an audible one gets a crossfade to a voice reading the new file.
        bool audibleChange = false;
        for (int s = 0; s < numSlots; ++s)
        {
            if (v.tracks[s] == slots[s])
                continue;
            if (v.gain[s] > 0.0f || v.target[s] > 0.0f)
            {
                if (slots[s] == nullptr || readyAt (slots[s], v.head) || waitedLong)
                    audibleChange = true;
            }
            else
                v.tracks[s] = slots[s];
        }
        flushRetire();

        const auto fresh = desiredConfig (spd);
        // Key 0 <-> another key also moves to the other engine, so it crossfades too.
        if (audibleChange || switchWanted || fresh.stretching != v.stretching
            || (fresh.stretching && keyChanged (fresh.transpose) != keyChanged (v.transpose)))
        {
            startSwitch ((int64) std::llround (audiblePos (v, (double) v.outCount)), modeFadeSeconds, fresh, spd);
            return;
        }
        if (v.stretching && fresh.transpose != v.transpose)
        {
            v.engine->setTransposeFactor (fresh.transpose);
            v.transpose = fresh.transpose;
        }
    }

    void finishSwitchIfDone() noexcept
    {
        if (switchLeft <= 0)
        {
            const int old = 1 - mainVoice;
            if (voices[old].active)
                deactivate (voices[old], old);
        }
    }

    void begin (double spd) noexcept
    {
        for (int v = 0; v < 2; ++v)
            if (voices[v].active)
                deactivate (voices[v], v);
        primeVoice (mainVoice, parked, desiredConfig (spd), spd);
        switchLeft = 0;
        switchWanted = false;
        state = playing;
        stopAfterFade = false;
        outGain = 0.0f;
        outTarget = 1.0f;
        outStep = (float) (1.0 / (startFadeSeconds * sampleRate));
        waitFrames = 0;
    }

    void process (float* outL, float* outR, int n, float* clickL, float* clickR) noexcept
    {
        if (! prepared || n > maxBlock || n <= 0)
            return;

        const auto ticks = juce::Time::getHighResolutionTicks();
        drainCommands();
        const double spd = juce::jlimit (0.1, 4.0, speed.load());

        float* L = mixBuffer.getWritePointer (0);
        float* R = mixBuffer.getWritePointer (1);
        juce::FloatVectorOperations::clear (L, n);
        juce::FloatVectorOperations::clear (R, n);

        int startAt = -1; // block offset where playback starts this block
        if (state == starting)
        {
            waitFrames += n;
            if (readyAt (slots[mode], parked) || waitFrames > toFrames (waitLimitSeconds))
                startAt = 0;
        }
        else if (state == countIn)
        {
            for (; countClicked < countBeats; ++countClicked)
            {
                const int64 at = (int64) std::llround (countClicked * countPeriod) - countElapsed;
                if (at >= n)
                    break;
                triggerClick ((int) std::max<int64> (0, at), countClicked % countPerBar == 0);
            }
            const int64 startFrame = (int64) std::llround (countBeats * countPeriod) - countElapsed;
            if (startFrame < n && readyAt (slots[mode], parked))
                startAt = (int) std::max<int64> (0, startFrame);
            countElapsed += n;
        }
        if (startAt >= 0)
            begin (spd);

        if (state == playing)
        {
            const int off = std::max (0, startAt);
            const int len = n - off;
            if (startAt < 0)
                updateVoices (spd, n);

            auto& v = voices[mainVoice];
            const int64 c0 = v.outCount;
            float* vL = voiceBuffer.getWritePointer (0);
            float* vR = voiceBuffer.getWritePointer (1);
            renderVoice (v, vL, vR, len, spd);

            if (switchLeft > 0)
            {
                auto& old = voices[1 - mainVoice];
                float* oL = voiceBuffer.getWritePointer (2);
                float* oR = voiceBuffer.getWritePointer (3);
                if (old.active)
                    renderVoice (old, oL, oR, len, spd);
                else
                {
                    juce::FloatVectorOperations::clear (oL, len);
                    juce::FloatVectorOperations::clear (oR, len);
                }
                for (int i = 0; i < len; ++i)
                {
                    const float w = juce::jlimit (0.0f, 1.0f, 1.0f - (float) (switchLeft - i) / (float) switchTotal);
                    vL[i] = vL[i] * w + oL[i] * (1.0f - w);
                    vR[i] = vR[i] * w + oR[i] * (1.0f - w);
                }
                switchLeft -= len;
                finishSwitchIfDone();
            }

            // Fade in after a start, out before a pause.
            for (int i = 0; i < len; ++i)
            {
                L[off + i] = vL[i] * outGain;
                R[off + i] = vR[i] * outGain;
                if (outGain != outTarget)
                    outGain = outGain < outTarget ? std::min (outTarget, outGain + outStep) : std::max (outTarget, outGain - outStep);
            }

            if (metronomeOn.load())
                beatClicks (v, c0, len, off);

            const double heard = audiblePos (v, (double) v.outCount);
            if (stopAfterFade && outGain <= 0.0f)
            {
                const int64 at = clampPos ((int64) std::llround (heard));
                stopNow();
                parked = returnAfterFade ? cue : at;
                if (seekTarget >= 0)
                {
                    parked = seekTarget;
                    seekTarget = -1;
                }
            }
            else if (heard >= (double) songLength)
            {
                stopNow();
                parked = returnToStart.load() ? cue : songLength;
                ++ended;
            }
        }

        // Song volume x the Song fader, smoothed; then into the output.
        const float wantGain = songVolume.load() * masterVolume.load();
        const float step = (float) (1.0 / (0.02 * sampleRate));
        float peak = 0.0f;
        for (int i = 0; i < n; ++i)
        {
            if (songGain != wantGain)
                songGain = songGain < wantGain ? std::min (wantGain, songGain + step) : std::max (wantGain, songGain - step);
            const float l = L[i] * songGain, r = R[i] * songGain;
            peak = std::max (peak, std::max (std::abs (l), std::abs (r)));
            outL[i] += l;
            outR[i] += r;
        }
        if (peak > songPeak.load (std::memory_order_relaxed))
            songPeak.store (peak, std::memory_order_relaxed);
        if (peak >= 1.0f)
            songClipped.store (true, std::memory_order_relaxed);

        // The metronome has its own level, not the song's.
        renderClicks (clickL != nullptr ? clickL : outL, clickR != nullptr ? clickR : outR, n, metronomeVolume.load());

        publish (ticks, n, spd);
    }

    void publish (int64 ticks, int n, double spd) noexcept
    {
        const bool isPlaying = state == playing;
        auto& v = voices[mainVoice];
        pubHead.store (isPlaying ? v.head : parked);
        pubSeek.store (seekTarget);
        pubCue.store (cue);
        pubLoopStart.store (loopStart);
        pubLoopEnd.store (loopEnd);
        pubLoopOn.store (loopOn);
        pubMode.store (pendingMode >= 0 ? pendingMode : mode);

        snapSeq.fetch_add (1, std::memory_order_acq_rel);
        snap.pos = (isPlaying ? audiblePos (v, (double) v.outCount) : (double) parked) / sampleRate;
        snap.ticks = ticks;
        snap.frames = n;
        snap.state = (int) state;
        snap.buffering = state == starting || (isPlaying && (seekTarget >= 0 || pendingMode >= 0) && waitFrames > toFrames (0.1));
        snap.rate = spd;
        snap.mode = pendingMode >= 0 ? pendingMode : mode;
        snap.seq = seekTarget >= 0 ? std::min (appliedSeq, seekSeq - 1) : appliedSeq;
        snap.wraps = wraps;
        snap.ended = ended;
        snap.length = songLength;
        snap.sampleRate = sampleRate;
        snap.countInLeft = state == countIn ? juce::jmax (0, countBeats - countClicked) : 0;
        snapSeq.fetch_add (1, std::memory_order_release);
    }

    Snap readSnap() const
    {
        for (;;)
        {
            const auto before = snapSeq.load (std::memory_order_acquire);
            if ((before & 1) != 0)
                continue;
            Snap s = snap;
            std::atomic_thread_fence (std::memory_order_acquire);
            if (snapSeq.load (std::memory_order_relaxed) == before)
                return s;
        }
    }
};

//==============================================================================
SongPlayer::SongPlayer() : impl (std::make_unique<Impl>()) {}

SongPlayer::~SongPlayer() = default;

void SongPlayer::prepare (double sampleRate, int maxBlockSize)   { impl->prepare (sampleRate, maxBlockSize); }
void SongPlayer::process (float* l, float* r, int n, float* cl, float* cr) noexcept { impl->process (l, r, n, cl, cr); }
void SongPlayer::housekeeping()                                  { impl->housekeeping(); }
bool SongPlayer::waitUntilLoaded (int timeoutMs)                 { return impl->waitUntilLoaded (timeoutMs); }

static int clampSlot (int s) { return juce::jlimit (0, SongPlayer::numSlots - 1, s); }

juce::var SongPlayer::load (const juce::String& id, const TrackSpec (&specs)[numSlots], double position, int mode, int seq)
{
    auto& p = *impl;
    songId = id;
    Impl::Command park { Impl::Cmd::park };
    park.seq = seq;
    park.a = position;
    park.slot = clampSlot (mode);

    // Clear first, so the parked position is clamped against the new song.
    for (int s = 0; s < numSlots; ++s)
    {
        Impl::Command c { Impl::Cmd::setTrack };
        c.slot = s;
        c.seq = seq;
        p.push (c);
        const std::lock_guard<std::mutex> lock (p.ownedMutex);
        p.slotInfo[s] = {};
    }
    auto result = setTracks (specs, seq);
    p.push (park);
    p.forceSnapshot = true;
    return result;
}

juce::var SongPlayer::setTracks (const TrackSpec (&specs)[numSlots], int seq)
{
    auto& p = *impl;
    auto result = juce::DynamicObject::Ptr (new juce::DynamicObject());
    juce::Array<juce::var> list;
    double duration = 0.0;

    for (int s = 0; s < numSlots; ++s)
    {
        auto& info = p.slotInfo[s];
        const auto& spec = specs[s];
        auto entry = juce::DynamicObject::Ptr (new juce::DynamicObject());
        entry->setProperty ("slot", s);

        const bool same = info.spec.path == spec.path
                          && (spec.path.isEmpty() || info.track != nullptr);
        if (! same)
        {
            std::unique_ptr<StreamedTrack> track;
            if (spec.path.isNotEmpty())
            {
                track = p.openTrack (spec);
                if (track == nullptr)
                    entry->setProperty ("error", "This audio file could not be opened");
            }
            {
                const std::lock_guard<std::mutex> lock (p.ownedMutex);
                info.spec = spec;
                info.track = track.get();
                if (track != nullptr)
                    p.tracks.push_back (std::move (track));
            }
            Impl::Command c { Impl::Cmd::setTrack };
            c.slot = s;
            c.seq = seq;
            c.ptr = info.track;
            p.push (c);
        }
        if (info.track != nullptr)
        {
            entry->setProperty ("durationSec", info.track->durationSeconds());
            duration = std::max (duration, info.track->durationSeconds());
        }
        entry->setProperty ("ok", info.track != nullptr || spec.path.isEmpty());
        list.add (juce::var (entry.get()));
    }
    p.notify();
    result->setProperty ("tracks", list);
    result->setProperty ("durationSec", duration);
    return juce::var (result.get());
}

void SongPlayer::unload (int seq)
{
    auto& p = *impl;
    songId = {};
    for (int s = 0; s < numSlots; ++s)
    {
        Impl::Command c { Impl::Cmd::setTrack };
        c.slot = s;
        c.seq = seq;
        p.push (c);
        const std::lock_guard<std::mutex> lock (p.ownedMutex);
        p.slotInfo[s] = {};
    }
    Impl::Command c { Impl::Cmd::unload };
    c.seq = seq;
    p.push (c);
    p.forceSnapshot = true;
}

void SongPlayer::play (int countInBeats, double period, int perBar, int seq)
{
    Impl::Command c { Impl::Cmd::play };
    c.seq = seq;
    c.countBeats = juce::jlimit (0, 64, countInBeats);
    c.a = juce::jlimit (0.0, 5.0, period);
    c.perBar = perBar;
    impl->push (c);
}

void SongPlayer::pause (int seq) { Impl::Command c { Impl::Cmd::pause }; c.seq = seq; impl->push (c); }
void SongPlayer::stop (int seq)  { Impl::Command c { Impl::Cmd::stop };  c.seq = seq; impl->push (c); }

void SongPlayer::seek (double seconds, int seq)
{
    Impl::Command c { Impl::Cmd::seek };
    c.seq = seq;
    c.a = std::max (0.0, seconds);
    impl->push (c);
    impl->notify();
}

void SongPlayer::setMode (int slot, int seq)
{
    Impl::Command c { Impl::Cmd::setMode };
    c.seq = seq;
    c.slot = clampSlot (slot);
    impl->push (c);
}

void SongPlayer::setLoop (double start, double end, bool enabled, int seq)
{
    Impl::Command c { Impl::Cmd::setLoop };
    c.seq = seq;
    c.a = start;
    c.b = end;
    c.flag = enabled;
    impl->push (c);
    impl->notify();
}

void SongPlayer::setSpeed (double s)            { impl->speed.store (juce::jlimit (0.1, 4.0, s)); }
void SongPlayer::setPitchRatio (double r)       { impl->pitchRatio.store (juce::jlimit (0.25, 4.0, r)); }
void SongPlayer::setSongVolume (float g)        { impl->songVolume.store (juce::jlimit (0.0f, 4.0f, g)); }
void SongPlayer::setMasterVolume (float g)      { impl->masterVolume.store (juce::jlimit (0.0f, 4.0f, g)); }
void SongPlayer::setReturnToStart (bool on)     { impl->returnToStart.store (on); }

void SongPlayer::setMetronome (bool enabled, float volume)
{
    impl->metronomeOn.store (enabled);
    impl->metronomeVolume.store (juce::jlimit (0.0f, 2.0f, volume));
}

void SongPlayer::setBeats (std::vector<double> times, std::vector<bool> accents)
{
    auto list = std::make_unique<BeatList>();
    list->times = std::move (times);
    std::sort (list->times.begin(), list->times.end());
    list->accents.assign (list->times.size(), 0);
    for (size_t i = 0; i < list->accents.size() && i < accents.size(); ++i)
        list->accents[i] = accents[i] ? 1 : 0;
    Impl::Command c { Impl::Cmd::setBeats };
    c.ptr = list.get();
    {
        const std::lock_guard<std::mutex> lock (impl->ownedMutex);
        impl->beatLists.push_back (std::move (list));
    }
    impl->push (c);
}

void SongPlayer::setCuts (std::vector<std::pair<double, double>> regions)
{
    auto list = std::make_unique<CutList>();
    std::sort (regions.begin(), regions.end());
    for (auto& r : regions)
    {
        if (r.second - r.first < 0.01)
            continue;
        if (! list->regions.empty() && r.first <= list->regions.back().second)
            list->regions.back().second = std::max (list->regions.back().second, r.second);
        else
            list->regions.push_back (r);
    }
    Impl::Command c { Impl::Cmd::setCuts };
    c.ptr = list.get();
    {
        const std::lock_guard<std::mutex> lock (impl->ownedMutex);
        impl->loaderCuts = list.get();
        impl->cutLists.push_back (std::move (list));
    }
    impl->push (c);
}

void SongPlayer::setLightweight (bool lightweight)
{
    auto& p = *impl;
    if (p.lightweight == lightweight)
        return;
    p.lightweight = lightweight;
    if (! p.prepared)
        return;
    for (int v = 0; v < 2; ++v)
    {
        auto s = p.makeStretcher();
        Impl::Command c { Impl::Cmd::setStretcher };
        c.slot = v;
        c.ptr = s.get();
        {
            const std::lock_guard<std::mutex> lock (p.ownedMutex);
            p.stretchers.push_back (std::move (s));
        }
        p.push (c);
    }
}

bool SongPlayer::wantsSnapshot() const
{
    auto& p = *impl;
    if (p.forceSnapshot)
        return true;
    const auto s = p.readSnap();
    const auto& l = p.lastSent;
    return s.state != 0 || s.state != l.state || std::abs (s.pos - l.pos) > 1e-6 || s.mode != l.mode
           || s.seq != l.seq || s.ended != l.ended || s.length != l.length || s.buffering != l.buffering;
}

juce::DynamicObject::Ptr SongPlayer::takeSnapshot (double outputLatencySeconds)
{
    auto& p = *impl;
    const auto s = p.readSnap();
    p.lastSent = s;
    p.forceSnapshot = false;

    // Date the position to when it is heard: this block plays after the one
    // now playing, plus the device's own output latency.
    const auto nowTicks = juce::Time::getHighResolutionTicks();
    const double nowMs = std::chrono::duration<double, std::milli> (std::chrono::system_clock::now().time_since_epoch()).count();
    const double ageMs = juce::Time::highResolutionTicksToSeconds (nowTicks - s.ticks) * 1000.0;
    const double aheadMs = s.sampleRate > 0 ? (2.0 * s.frames / s.sampleRate + outputLatencySeconds) * 1000.0 : 0.0;

    static const char* states[] = { "stopped", "starting", "countIn", "playing" };
    auto o = juce::DynamicObject::Ptr (new juce::DynamicObject());
    o->setProperty ("songId", songId);
    o->setProperty ("state", states[juce::jlimit (0, 3, s.state)]);
    o->setProperty ("playing", s.state == Impl::playing);
    o->setProperty ("position", s.pos);
    o->setProperty ("at", nowMs - ageMs + aheadMs);
    o->setProperty ("rate", s.rate);
    o->setProperty ("mode", s.mode);
    o->setProperty ("buffering", s.buffering);
    o->setProperty ("seq", s.seq);
    o->setProperty ("wraps", (int) s.wraps);
    o->setProperty ("ended", (int) s.ended);
    o->setProperty ("durationSec", s.sampleRate > 0 ? (double) s.length / s.sampleRate : 0.0);
    o->setProperty ("countInLeft", s.countInLeft);
    o->setProperty ("underruns", p.underruns.load());
    return o;
}

bool SongPlayer::blockEndPosition (double& seconds) const noexcept
{
    // Written by process() on this same thread, so no seqlock is needed here.
    seconds = impl->snap.pos;
    return impl->snap.state == Impl::playing;
}

float SongPlayer::takeSongPeak()     { return impl->songPeak.exchange (0.0f); }
bool SongPlayer::takeSongClipped()   { return impl->songClipped.exchange (false); }
