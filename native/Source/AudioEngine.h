#pragma once

#include <juce_audio_utils/juce_audio_utils.h>

#include "SongPlayer.h"

#include <atomic>
#include <memory>
#include <vector>

// One effect in the bass chain or the output chain. Owned by the message
// thread; the audio thread only reads `plugin` and `bypassed` while holding
// the chain lock.
struct ChainSlot
{
    juce::String slotId;
    bool output = false; // in the output chain (the whole mix) rather than the bass chain
    juce::String name;
    juce::String descriptionXml;
    std::unique_ptr<juce::AudioPluginInstance> plugin;
    std::atomic<bool> bypassed { false };
};

// Real-time signal path:
//
//   selected input channel(s) -> input trim -> bass chain -> monitor level ---(a)---+
//   song tracks -> stretch / key -> song volume ----> output chain --(b)--+--> safety limiter -> outputs 1/2
//   metronome clicks (on the song's beat grid) ---------------------------+
//
// The bass joins at (a), before the output chain, or at (b), after it
// (setOutputIncludesBass), so output effects can leave your bass dry.
//
// The song, the metronome and the monitored bass share one device and one
// sample clock, so loops, mode switches and clicks are sample-accurate.
class AudioEngine : private juce::AudioIODeviceCallback,
                    private juce::ChangeListener
{
public:
    AudioEngine();
    ~AudioEngine() override;

    juce::AudioDeviceManager& getDeviceManager() { return deviceManager; }
    juce::AudioPluginFormatManager& getFormatManager() { return formatManager; }

    juce::var getDeviceState();
    juce::String applyDeviceSetup (const juce::var& request);
    /** Opens the driver's own settings window (ASIO); false if it has none. */
    bool showDeviceControlPanel();

    // An audio interface's input stays open, so Monitor and the tuner switch on
    // instantly. A microphone or Bluetooth headset is only opened while something
    // listens to it (Monitor or the tuner): opening a headset's microphone
    // switches it to a low-quality 'headset' mode, and an idle mic shouldn't be open.
    void setMonitoring (bool enabled);
    void setTuner (bool enabled, bool mute);
    void setInputTrimDb (float db)           { inputTrimDb.store (juce::jlimit (-24.0f, 24.0f, db)); }
    void setOutputLevelDb (float db)         { outputLevelDb.store (juce::jlimit (-60.0f, 6.0f, db)); }

    // Effects chains (message thread only). Indexes count within the slot's own chain.
    using AddCallback = std::function<void (ChainSlot*, const juce::String& error)>;
    void addPlugin (const juce::String& slotId, const juce::String& descriptionXml, int index,
                    const juce::String& base64State, bool bypassed, bool output, AddCallback callback);
    bool removePlugin (const juce::String& slotId);
    bool movePlugin (const juce::String& slotId, int newIndex);
    void setOutputIncludesBass (bool include) { outputIncludesBass.store (include); }
    bool setBypassed (const juce::String& slotId, bool bypassed);
    juce::String openEditor (const juce::String& slotId);
    void closeAllEditors();
    /** Plugin windows' title bars follow Nøta's theme and background colour (0xRRGGBB, or -1)
        on Windows; elsewhere the system draws them. */
    void setWindowTheme (bool dark, int captionRgb);
    juce::var getChainState();
    void clearChain();

    juce::DynamicObject::Ptr takeMeterSnapshot();

    SongPlayer& getSongPlayer() { return song; }

    // Records what leaves the engine (after the limiter) into a WAV file, for
    // checking the live output sample by sample. finishCapture() writes the
    // file once the recording is complete; call it from a timer.
    juce::String startCapture (const juce::String& path, double seconds);
    juce::String finishCapture();
    // Takes: the bass (clean, before its effects) recorded to a WAV file while
    // playing along, with the song position at every audio block so each moment
    // of the take maps back to the song (speed changes, loops and seeks included).
    // stopTake() writes "<path>.json" with those marks and the device latencies.
    juce::String startTake (const juce::String& path, double maxSeconds);
    juce::var stopTake();

    /** Device output latency (driver + one buffer), for dating position reports. */
    double getOutputLatencySeconds();
    /** Blocks between the one being rendered and the one being heard, before the output latency. */
    int snapshotBlocksAhead();

    // Tuner: the audio thread copies the (trimmed) input into a ring buffer;
    // detectPitch() runs YIN on it from the message thread.
    bool isTunerEnabled() const              { return tunerEnabled.load(); }
    juce::DynamicObject::Ptr detectPitch();

    std::function<void (const juce::String&)> onEditorClosed;

private:
    void audioDeviceIOCallbackWithContext (const float* const* inputChannelData, int numInputChannels,
                                           float* const* outputChannelData, int numOutputChannels,
                                           int numSamples, const juce::AudioIODeviceCallbackContext&) override;
    void audioDeviceAboutToStart (juce::AudioIODevice*) override;
    void audioDeviceStopped() override;
    void audioDeviceError (const juce::String& errorMessage) override;
    void changeListenerCallback (juce::ChangeBroadcaster*) override;

    void prepareSlot (ChainSlot&);
    /** Whether the input should be open: something listens, or it's an interface that stays open. */
    bool inputWanted() const;
    bool inputIsOpen();
    /** Applies `setup` with the input opened or closed as needed; fades the output around the restart. */
    juce::String reconfigure (juce::AudioDeviceManager::AudioDeviceSetup setup, const juce::String& newType = {});
    juce::String openWithDriver (const juce::String& typeName, const juce::AudioDeviceManager::AudioDeviceSetup& setup);
    void fadeOutForRestart();
    ChainSlot* findSlot (const juce::String& slotId);
    void processChain (juce::AudioBuffer<float>& stereo, int numSamples, bool output);
    /** Latency of the active (not bypassed) plugins in one chain; call with the chain lock held. */
    int chainLatency (bool output) const;
    bool guardInvalid (juce::AudioBuffer<float>& buffer, int numSamples);

    juce::AudioDeviceManager deviceManager;
    SongPlayer song;
    juce::AudioPluginFormatManager formatManager;

    std::vector<std::unique_ptr<ChainSlot>> slots;
    juce::SpinLock chainLock;

    class EditorWindow;
    std::vector<std::unique_ptr<EditorWindow>> editors;
    bool darkWindows = false;
    int windowCaption = -1;

    std::atomic<bool> monitoring { false };
    std::atomic<bool> outputIncludesBass { true };
    std::atomic<float> inputTrimDb { 0.0f };
    std::atomic<float> outputLevelDb { -6.0f };

    juce::SmoothedValue<float> trimGain, outputGain;
    /** 0–1: fades the monitored bass in and out (Monitor, or the tuner muting it) instead of cutting it */
    juce::SmoothedValue<float> monitorGate;
    juce::AudioBuffer<float> stereoBuffer, songBuffer, clickBuffer, pluginBuffer;

    // The metronome skips the output effects, so it's delayed by their latency
    // to land with the song. Latency is read on the message thread.
    static constexpr int clickDelaySize = 1 << 17; // ~2.7 s at 48 kHz
    juce::AudioBuffer<float> clickDelay;
    int clickDelayWrite = 0, clickDelayUsed = 0;
    std::atomic<int> outputChainLatency { 0 };
    void delayClicks (float* l, float* r, int numSamples);
    juce::MidiBuffer midiBuffer;
    double currentSampleRate = 48000.0;
    int currentBlockSize = 256;

    // Safety limiter: instant attack, ~80 ms release, -1 dBFS ceiling
    float limiterGain = 1.0f, limiterRelease = 0.999f;
    static constexpr float limiterCeiling = 0.891f;

    // Meters, written by the audio thread and drained by the message thread
    std::atomic<float> inputPeakRaw { 0.0f }, inputPeak { 0.0f }, monitorPeak { 0.0f }, outputPeak { 0.0f }, minLimiterGain { 1.0f };
    std::atomic<bool> inputClipped { false }, outputClipped { false }, invalidSamples { false };
    std::atomic<int> xruns { 0 };

    static constexpr int tunerRingSize = 1 << 15;
    std::vector<float> tunerRing = std::vector<float> ((size_t) tunerRingSize, 0.0f);
    std::atomic<int> tunerWrite { 0 };
    std::atomic<bool> tunerEnabled { false }, tunerMute { false };

    juce::String lastDeviceError;

    // The input the user picked, applied only while inputWanted().
    juce::String wantedInput;
    juce::BigInteger wantedInputChannels;
    juce::StringArray lastInputChannelNames;
    juce::String lastInputChannelDevice;

    // Short fade on everything that leaves the engine, around device restarts.
    std::atomic<bool> restartFade { false }, restartFadeDone { false };
    float deviceFade = 0.0f, deviceFadeStep = 0.001f;

    struct TakeMark
    {
        juce::int64 frame; // take frames recorded by the end of the block
        double songPos;    // song position at the end of the block, seconds
        bool playing;
    };
    juce::TimeSliceThread takeThread { "Take writer" };
    std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> takeWriter;
    std::atomic<juce::AudioFormatWriter::ThreadedWriter*> activeTake { nullptr };
    juce::SpinLock takeLock; // held by stopTake() while it detaches the writer
    std::vector<TakeMark> takeMarks; // preallocated; only the audio thread appends
    std::atomic<size_t> takeMarkCount { 0 };
    juce::int64 takeFrames = 0;
    std::atomic<bool> takeDropped { false };
    juce::String takePath;
    double takeRate = 48000.0;

    std::unique_ptr<juce::AudioBuffer<float>> captureBuffer;
    std::atomic<juce::AudioBuffer<float>*> captureTarget { nullptr };
    std::atomic<int> captureWritten { 0 };
    std::atomic<bool> captureFull { false };
    juce::String capturePath;
    double captureRate = 48000.0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (AudioEngine)
};
