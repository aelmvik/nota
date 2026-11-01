#pragma once

#include <juce_audio_formats/juce_audio_formats.h>

#include <memory>

// Song playback inside the engine, on the same sample clock as the live bass
// and the metronome.
//
// A song has up to three tracks (original, bass stem, backing track), one per
// slot. Each is streamed from disk by a background thread into a chunk cache,
// resampled to the device rate on the way in, so the audio thread only ever
// copies samples it already has: no disk I/O, locks or allocation there.
//
// All tracks of a song play together and only the selected one is audible.
// A mode switch ramps the track gains over ~30 ms, sample-locked, because
// every track is read at the same frame. Loops wrap at the exact frame (with
// a 5 ms crossfade so the jump never clicks), and seeks crossfade too.
//
// Slow-down and key change run through Signalsmith Stretch. At 100 % speed
// with no key change the stretcher is bypassed and the files play bit-exact. Switching between those, seeking while stretched and
// swapping in a new file all crossfade between two "voices", each with its own
// stretcher, so nothing ever cuts or clicks.
//
// Message thread: everything public except process(). Audio thread: process().
class SongPlayer
{
public:
    static constexpr int numSlots = 3; // 0 = original, 1 = bass, 2 = play along

    SongPlayer();
    ~SongPlayer();

    //==============================================================================
    // Device lifecycle (message thread, while the audio callback is not running)
    void prepare (double sampleRate, int maxBlockSize);

    // Audio thread: adds the song and the metronome to left/right.
    /** Adds the song to left/right; the metronome too, or into clickLeft/clickRight when given
        (so it can skip the output effects). */
    void process (float* left, float* right, int numSamples, float* clickLeft = nullptr, float* clickRight = nullptr) noexcept;

    //==============================================================================
    // Commands (message thread). `seq` is echoed in snapshots once applied, so the
    // UI can tell when a position report already reflects what it asked for.
    struct TrackSpec
    {
        juce::String path;
    };

    /** Opens the tracks and parks the transport at `position` (seconds). Returns per-track errors. */
    juce::var load (const juce::String& songId, const TrackSpec (&tracks)[numSlots], double position, int mode, int seq);
    /** Adds, replaces or removes tracks of the loaded song without stopping it. */
    juce::var setTracks (const TrackSpec (&tracks)[numSlots], int seq);
    void unload (int seq);

    void play (int countInBeats, double countInPeriodSeconds, int beatsPerBar, int seq);
    void pause (int seq);
    void stop (int seq);
    void seek (double seconds, int seq);
    void setMode (int slot, int seq);
    void setLoop (double start, double end, bool enabled, int seq);

    void setSpeed (double speed);
    void setPitchRatio (double ratio);
    void setSongVolume (float gain);
    void setMasterVolume (float gain);
    void setReturnToStart (bool enabled);
    void setMetronome (bool enabled, float volume);
    void setBeats (std::vector<double> timesSeconds, std::vector<bool> accents);
    /** Regions of the song (seconds) that playback skips, with a short crossfade. */
    void setCuts (std::vector<std::pair<double, double>> regions);
    /** The cheaper stretcher preset, for slow computers (the app doesn't use it at the moment). */
    void setLightweight (bool lightweight);

    //==============================================================================
    /** Transport state for the UI; `outputLatencySeconds` dates the position to when it is heard,
        after `blocksAhead` more blocks (see AudioEngine::snapshotBlocksAhead). */
    juce::DynamicObject::Ptr takeSnapshot (double outputLatencySeconds, int blocksAhead = 2);
    /** True when something changed since the last snapshot, or while playing. */
    bool wantsSnapshot() const;
    /** Audio thread, right after process(): the song position at the end of that block, and whether it was playing. */
    bool blockEndPosition (double& seconds) const noexcept;
    float takeSongPeak();
    bool takeSongClipped();

    /** Frees objects the audio thread has finished with (call from a timer). */
    void housekeeping();

    /** Waits until the disk loader has caught up (offline rendering and tests). */
    bool waitUntilLoaded (int timeoutMs);

    const juce::String& getSongId() const { return songId; }

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
    juce::String songId;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SongPlayer)
};
