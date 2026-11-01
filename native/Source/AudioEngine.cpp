#include "AudioEngine.h"
#include "Protocol.h"

#if JUCE_MAC
 #include <CoreAudio/CoreAudio.h>
 #include "MacWindows.h"
#elif JUCE_WINDOWS
 #include "WindowsDevices.h"
 #include "WindowsForeground.h"
#endif

namespace
{
#if JUCE_MAC
    // CoreAudio facts JUCE doesn't expose: whether a device is Bluetooth, and
    // how many input channels it has while we don't have it open.
    AudioObjectID findCoreAudioDevice (const juce::String& name)
    {
        AudioObjectPropertyAddress addr { kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, 0 };
        UInt32 size = 0;
        if (name.isEmpty() || AudioObjectGetPropertyDataSize (kAudioObjectSystemObject, &addr, 0, nullptr, &size) != noErr)
            return kAudioObjectUnknown;
        std::vector<AudioObjectID> ids (size / sizeof (AudioObjectID));
        if (AudioObjectGetPropertyData (kAudioObjectSystemObject, &addr, 0, nullptr, &size, ids.data()) != noErr)
            return kAudioObjectUnknown;
        for (auto id : ids)
        {
            CFStringRef cfName = nullptr;
            UInt32 nameSize = sizeof (cfName);
            AudioObjectPropertyAddress nameAddr { kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, 0 };
            if (AudioObjectGetPropertyData (id, &nameAddr, 0, nullptr, &nameSize, &cfName) != noErr || cfName == nullptr)
                continue;
            const auto n = juce::String::fromCFString (cfName);
            CFRelease (cfName);
            if (n == name)
                return id;
        }
        return kAudioObjectUnknown;
    }

    bool isBluetooth (const juce::String& name)
    {
        const auto id = findCoreAudioDevice (name);
        if (id == kAudioObjectUnknown)
            return false;
        UInt32 transport = 0, size = sizeof (transport);
        AudioObjectPropertyAddress addr { kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, 0 };
        if (AudioObjectGetPropertyData (id, &addr, 0, nullptr, &size, &transport) != noErr)
            return false;
        return transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE;
    }

    /**
     * An audio interface (or a virtual device) rather than a microphone: its
     * input can stay open all the time, so Monitor and the tuner switch on
     * without restarting the device. Microphones (built in, iPhone, a display's)
     * and Bluetooth headsets are only opened when something listens: opening a
     * headset's mic drops it to call quality, and an idle mic shouldn't be open.
     */
    bool keepsInputOpen (const juce::String& name)
    {
        if (name.isEmpty() || isBluetooth (name) || name.containsIgnoreCase ("microphone"))
            return false;
        const auto id = findCoreAudioDevice (name);
        if (id == kAudioObjectUnknown)
            return false;
        UInt32 transport = 0, size = sizeof (transport);
        AudioObjectPropertyAddress addr { kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, 0 };
        if (AudioObjectGetPropertyData (id, &addr, 0, nullptr, &size, &transport) != noErr)
            return false;
        return transport != kAudioDeviceTransportTypeBuiltIn
            && transport != kAudioDeviceTransportTypeContinuityCaptureWired
            && transport != kAudioDeviceTransportTypeContinuityCaptureWireless;
    }

    int inputChannelCount (const juce::String& name)
    {
        const auto id = findCoreAudioDevice (name);
        AudioObjectPropertyAddress addr { kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeInput, 0 };
        UInt32 size = 0;
        if (id == kAudioObjectUnknown || AudioObjectGetPropertyDataSize (id, &addr, 0, nullptr, &size) != noErr || size == 0)
            return 0;
        juce::HeapBlock<char> data (size);
        if (AudioObjectGetPropertyData (id, &addr, 0, nullptr, &size, data.get()) != noErr)
            return 0;
        auto* list = reinterpret_cast<AudioBufferList*> (data.get());
        int channels = 0;
        for (UInt32 i = 0; i < list->mNumberBuffers; ++i)
            channels += (int) list->mBuffers[i].mNumberChannels;
        return channels;
    }
#elif JUCE_WINDOWS
    // Windows says what a device is and how it's connected, whatever language
    // its name is in (WindowsDevices.cpp).
    WindowsEndpoint endpoint (const juce::String& name, bool input)
    {
        return name.isEmpty() ? WindowsEndpoint {} : findWindowsEndpoint (name.toWideCharPointer(), input);
    }

    bool isBluetooth (const juce::String& name)
    {
        return endpoint (name, true).bluetooth || endpoint (name, false).bluetooth;
    }

    /** An interface's input stays open; a microphone or headset only while something listens. */
    bool keepsInputOpen (const juce::String& name)
    {
        const auto e = endpoint (name, true);
        if (! e.found) // ASIO names the interface itself, not an endpoint
            return name.isNotEmpty() && ! name.containsIgnoreCase ("microphone");
        return ! e.bluetooth && ! e.isMicrophone();
    }

    /** A microphone feeding speakers: Monitor would feed back, so the app asks first. */
    bool feedbackRisk (const juce::String& input, const juce::String& output)
    {
        return endpoint (input, true).formFactor == 4 && endpoint (output, false).isSpeakers();
    }

    // WASAPI knows an endpoint's channel count without opening it for audio:
    // creating the device only reads its mix format, nothing starts recording.
    int inputChannelCount (const juce::String& name)
    {
        if (name.isEmpty())
            return 0;
        std::unique_ptr<juce::AudioIODeviceType> type (juce::AudioIODeviceType::createAudioIODeviceType_WASAPI (juce::WASAPIDeviceMode::shared));
        if (type == nullptr)
            return 0;
        type->scanForDevices();
        std::unique_ptr<juce::AudioIODevice> device (type->createDevice ({}, name));
        return device != nullptr ? device->getInputChannelNames().size() : 0;
    }
#elif JUCE_LINUX
    // Linux: ALSA and JACK don't say what a device is, so go by name. The system
    // default, the sound server and the computer's own sound card (ALSA's "HDA
    // Intel", PipeWire's "Built-in Audio" under JACK) may be a built-in mic and
    // speakers; a USB or other interface isn't.
    bool isSystemDevice (const juce::String& name)
    {
        return name.containsIgnoreCase ("default") || name.containsIgnoreCase ("pipewire") || name.containsIgnoreCase ("pulse")
            || name.startsWithIgnoreCase ("HDA ") || name.containsIgnoreCase ("built-in") || name.containsIgnoreCase ("microphone")
            || name == "system";
    }

    bool isBluetooth (const juce::String& name) { return name.containsIgnoreCase ("bluez") || name.containsIgnoreCase ("bluetooth"); }

    /** An interface's input stays open; the system default or built-in sound only while something listens. */
    bool keepsInputOpen (const juce::String& name) { return name.isNotEmpty() && ! isSystemDevice (name) && ! isBluetooth (name); }

    /** Possibly a built-in mic into speakers (HDMI goes to a screen or a receiver): the app asks first. */
    bool feedbackRisk (const juce::String& input, const juce::String& output)
    {
        return isSystemDevice (input) && isSystemDevice (output) && ! output.containsIgnoreCase ("HDMI");
    }

    int inputChannelCount (const juce::String&) { return 0; }

    // PipeWire's JACK runs at the graph's buffer size (its quantum, 1024 by default),
    // and a client asks for a smaller one with PIPEWIRE_LATENCY when it opens. JUCE
    // only offers the current size, so offer the usual ones; a JACK server other than
    // PipeWire ignores the request and keeps its own size, which is what's reported.
    const juce::Array<int> jackBufferSizes { 64, 128, 256, 512, 1024, 2048 };

    void requestPipeWireBuffer (int bufferSize, double sampleRate)
    {
        if (bufferSize <= 0)
            return;
        const auto latency = juce::String (bufferSize) + "/" + juce::String (juce::roundToInt (sampleRate > 0 ? sampleRate : 48000.0));
        setenv ("PIPEWIRE_LATENCY", latency.toRawUTF8(), 1);
    }

    /**
     * JACK's channel names are its port names. A numbered port (PipeWire's Pro Audio
     * profile: capture_AUX0 …; JACK's own server: capture_1 …) is in hardware order,
     * so it reads "Input 1" …. A port named after a speaker comes from a surround
     * profile, whose order isn't the hardware's (on a USB interface in "Analog
     * Surround 7.1", hardware input 3 is FC, the fifth port), so it keeps its
     * speaker name, readably (a stereo or mono device's two or one are in hardware
     * order, so they read "Input 1", "Input 2"). PipeWire also lists an output's monitor ports as
     * inputs; they're left out when they come last, so the indexes JUCE connects
     * by stay the same.
     */
    juce::StringArray jackChannelNames (const juce::StringArray& names, const juce::String& label)
    {
        static const std::pair<const char*, const char*> speakers[] = {
            { "FL", "Front left" }, { "FR", "Front right" }, { "FC", "Centre" }, { "LFE", "LFE" },
            { "RL", "Rear left" }, { "RR", "Rear right" }, { "SL", "Side left" }, { "SR", "Side right" },
            { "RC", "Rear centre" }, { "MONO", "Mono" } };
        int count = names.size();
        while (count > 0 && names[count - 1].startsWith ("monitor_"))
            --count;
        // A stereo or mono device (FL, FR / MONO) is in hardware order: Input 1, 2.
        const auto suffix = [&names] (int i) { return names[i].fromFirstOccurrenceOf ("_", false, false); };
        if (count == 1 && suffix (0) == "MONO")
            return { label + " 1" };
        if (count == 2 && suffix (0) == "FL" && suffix (1) == "FR")
            return { label + " 1", label + " 2" };
        juce::StringArray out;
        for (int i = 0; i < count; ++i)
        {
            const auto& n = names[i];
            const auto suffix = n.fromFirstOccurrenceOf ("_", false, false);
            juce::String name = n;
            if (suffix.startsWith ("AUX") && suffix.substring (3).containsOnly ("0123456789"))
                name = label + " " + juce::String (suffix.substring (3).getIntValue() + 1);
            else if (suffix.isNotEmpty() && suffix.containsOnly ("0123456789"))
                name = label + " " + suffix;
            else
                for (auto& [position, readable] : speakers)
                    if (suffix == position)
                        name = readable;
            out.add (name);
        }
        return out;
    }

    /**
     * ALSA lists each sound card several times: surround layouts, dmix and dsnoop,
     * and the raw hardware device ("card, device; description"). Keep one entry per
     * card and device, the one that converts formats, and always the one in use.
     * JACK is the low-latency route, so the raw hardware devices aren't needed.
     */
    juce::StringArray listedDevices (const juce::String& typeName, const juce::StringArray& names, const juce::String& current)
    {
        // JACK lists every client: PipeWire's MIDI bridges (no audio) and Nøta's own
        // engines too ("Nota", or "Nota-<id>" beside another copy) aren't devices.
        if (typeName == "JACK")
        {
            juce::StringArray audio;
            for (auto& n : names)
                if (n == current || ! (n.containsIgnoreCase ("midi") || n == "Nota" || n.startsWith ("Nota-")))
                    audio.add (n);
            return audio;
        }
        if (typeName != "ALSA")
            return names;
        const auto card = [] (const juce::String& n) { return n.upToFirstOccurrenceOf (";", false, false); };
        const auto rank = [] (const juce::String& n) {
            if (n.contains ("Surround output") || n.contains ("Direct sample snooping") || n.contains ("Direct sample mixing"))
                return 2;
            return n.contains ("Direct hardware") ? 1 : 0;
        };
        // The best entry for each card and device, in the order ALSA lists them.
        juce::StringArray best;
        for (auto& n : names)
        {
            if (! n.contains (";"))
            {
                best.add (n);
                continue;
            }
            int i = 0;
            while (i < best.size() && card (best[i]) != card (n))
                ++i;
            if (i == best.size())
                best.add (n);
            else if (rank (n) < rank (best[i]))
                best.set (i, n);
        }
        if (current.isNotEmpty() && names.contains (current) && ! best.contains (current))
            best.add (current);
        return best;
    }
#else
    bool isBluetooth (const juce::String&) { return false; }
    bool keepsInputOpen (const juce::String& name) { return name.isNotEmpty() && ! name.containsIgnoreCase ("microphone"); }
    int inputChannelCount (const juce::String&) { return 0; }
#endif

    constexpr int bluetoothMinBuffer = 512;

    juce::var toVarArray (const juce::StringArray& items)
    {
        juce::Array<juce::var> out;
        for (auto& s : items)
            out.add (s);
        return out;
    }

    template <typename T>
    juce::var toVarArray (const juce::Array<T>& items)
    {
        juce::Array<juce::var> out;
        for (auto v : items)
            out.add (v);
        return out;
    }

    void storeMax (std::atomic<float>& target, float value)
    {
        auto current = target.load (std::memory_order_relaxed);
        while (value > current && ! target.compare_exchange_weak (current, value, std::memory_order_relaxed)) {}
    }

    void storeMin (std::atomic<float>& target, float value)
    {
        auto current = target.load (std::memory_order_relaxed);
        while (value < current && ! target.compare_exchange_weak (current, value, std::memory_order_relaxed)) {}
    }
}

//==============================================================================
class AudioEngine::EditorWindow : public juce::DocumentWindow
{
public:
    EditorWindow (AudioEngine& ownerIn, ChainSlot& slot, juce::AudioProcessorEditor* editor)
        : DocumentWindow (slot.name, juce::Colour (0xff1b1d21), DocumentWindow::closeButton),
          owner (ownerIn), slotId (slot.slotId)
    {
        setUsingNativeTitleBar (true);
        setContentOwned (editor, true);
        setResizable (editor->isResizable(), false);
        centreWithSize (getWidth(), getHeight());
        setVisible (true);
        applyTheme();
        bringToFront();
    }

    /** The title bar follows Nøta's light or dark theme, in its background colour. */
    void applyTheme()
    {
       #if JUCE_WINDOWS
        setTitleBarTheme (getWindowHandle(), owner.darkWindows, owner.windowCaption);
       #elif JUCE_MAC
        setMacWindowTheme (getWindowHandle(), owner.darkWindows, owner.windowCaption);
       #endif
    }

    /** In front of Nøta's window: the engine is a separate app, behind it. */
    void bringToFront()
    {
        juce::Process::makeForegroundProcess();
        toFront (true);
       #if JUCE_WINDOWS
        bringToForeground (getWindowHandle());
       #endif
    }

    /** Whether the window is in front, or was until a moment ago: a click in Nøta's
        Mixer makes Nøta's window active first, so a window that was in front has only
        just stopped being active when the click arrives. */
    bool wasInFront() const
    {
        return isActiveWindow() || juce::Time::getMillisecondCounter() - lastActive < 800;
    }

    void activeWindowStatusChanged() override
    {
        DocumentWindow::activeWindowStatusChanged();
        if (! isActiveWindow())
            lastActive = juce::Time::getMillisecondCounter();
    }

    void closeButtonPressed() override
    {
        // Not from inside this window's own callback: it deletes the window.
        auto* engine = &owner;
        auto id = slotId;
        juce::MessageManager::callAsync ([engine, id] { engine->closeEditor (id); });
    }

    AudioEngine& owner;
    juce::String slotId;
    /** When the window last stopped being the active one (0: not yet). */
    juce::uint32 lastActive = 0;
};

//==============================================================================
AudioEngine::AudioEngine()
{
    formatManager.addDefaultFormats();

    // Output only until Monitor or the tuner needs the input; the Electron
    // side re-applies the user's saved device selection after startup.
    const auto error = deviceManager.initialise (0, 2, nullptr, true);
    if (error.isNotEmpty())
        lastDeviceError = error;
    if (auto* type = deviceManager.getCurrentDeviceTypeObject())
    {
        type->scanForDevices();
        const auto inputs = type->getDeviceNames (true);
        wantedInput = inputs[juce::jmax (0, type->getDefaultDeviceIndex (true))];
    }
    wantedInputChannels.setBit (0);

    deviceManager.addAudioCallback (this);
    deviceManager.addChangeListener (this);
}

AudioEngine::~AudioEngine()
{
    editors.clear();
    deviceManager.removeChangeListener (this);
    deviceManager.removeAudioCallback (this);
    deviceManager.closeAudioDevice();

    const juce::SpinLock::ScopedLockType sl (chainLock);
    slots.clear();
}

//==============================================================================
juce::var AudioEngine::getDeviceState()
{
    auto state = juce::DynamicObject::Ptr (new juce::DynamicObject());
    auto setup = deviceManager.getAudioDeviceSetup();

    state->setProperty ("deviceType", deviceManager.getCurrentAudioDeviceType());

    // Driver types this platform offers: CoreAudio on the Mac; Windows Audio, its
    // exclusive mode and ASIO on Windows; ALSA and JACK on Linux.
    juce::StringArray types;
    for (auto* t : deviceManager.getAvailableDeviceTypes())
    {
       #if ! JUCE_MAC
        // A driver with no devices (ASIO without an ASIO driver installed) can't be used.
        if (t->getTypeName() != deviceManager.getCurrentAudioDeviceType()
            && t->getDeviceNames (false).isEmpty() && t->getDeviceNames (true).isEmpty())
            continue;
       #endif
        types.add (t->getTypeName());
    }
    state->setProperty ("availableDeviceTypes", toVarArray (types));

    if (auto* type = deviceManager.getCurrentDeviceTypeObject())
    {
        type->scanForDevices();
       #if JUCE_LINUX
        const auto typeName = type->getTypeName();
        state->setProperty ("inputDevices", toVarArray (listedDevices (typeName, type->getDeviceNames (true), wantedInput)));
        state->setProperty ("outputDevices", toVarArray (listedDevices (typeName, type->getDeviceNames (false), setup.outputDeviceName)));
       #else
        state->setProperty ("inputDevices", toVarArray (type->getDeviceNames (true)));
        state->setProperty ("outputDevices", toVarArray (type->getDeviceNames (false)));
       #endif
        // ASIO: one driver is both the input and the output.
        state->setProperty ("separateInputs", type->hasSeparateInputsAndOutputs());
    }

    const bool inputOpen = inputIsOpen();
    state->setProperty ("inputDevice", wantedInput);
    state->setProperty ("outputDevice", setup.outputDeviceName);
    state->setProperty ("inputOpen", inputOpen);
    state->setProperty ("inputBluetooth", isBluetooth (wantedInput));
    state->setProperty ("outputBluetooth", isBluetooth (setup.outputDeviceName));
   #if JUCE_WINDOWS || JUCE_LINUX
    state->setProperty ("feedbackRisk", feedbackRisk (wantedInput, setup.outputDeviceName));
   #endif

    juce::Array<juce::var> activeInputs;
    for (int i = 0; i <= wantedInputChannels.getHighestBit(); ++i)
        if (wantedInputChannels[i])
            activeInputs.add (i);
    state->setProperty ("inputChannels", activeInputs);

    if (auto* device = deviceManager.getCurrentAudioDevice())
    {
        const auto sr = device->getCurrentSampleRate();
        const auto bs = device->getCurrentBufferSizeSamples();
        state->setProperty ("running", device->isPlaying());
        state->setProperty ("hasControlPanel", device->hasControlPanel());
        state->setProperty ("sampleRate", sr);
        state->setProperty ("bufferSize", bs);
        state->setProperty ("availableSampleRates", toVarArray (device->getAvailableSampleRates()));
       #if JUCE_LINUX
        if (deviceManager.getCurrentAudioDeviceType() == "JACK")
        {
            auto sizes = jackBufferSizes;
            sizes.addIfNotAlreadyThere (bs);
            sizes.sort();
            state->setProperty ("availableBufferSizes", toVarArray (sizes));
        }
        else
       #endif
        state->setProperty ("availableBufferSizes", toVarArray (device->getAvailableBufferSizes()));
        // Channel names of the chosen input, also while it isn't open.
        if (inputOpen)
        {
            lastInputChannelNames = device->getInputChannelNames();
           #if JUCE_LINUX
            if (deviceManager.getCurrentAudioDeviceType() == "JACK")
                lastInputChannelNames = jackChannelNames (lastInputChannelNames, "Input");
           #endif
            lastInputChannelDevice = wantedInput;
        }
        else if (lastInputChannelDevice != wantedInput)
        {
            lastInputChannelNames.clear();
            for (int i = 0, n = inputChannelCount (wantedInput); i < n; ++i)
                lastInputChannelNames.add ("Input " + juce::String (i + 1));
            lastInputChannelDevice = wantedInput;
        }
        state->setProperty ("inputChannelNames", toVarArray (lastInputChannelNames));
       #if JUCE_LINUX
        if (deviceManager.getCurrentAudioDeviceType() == "JACK")
            state->setProperty ("outputChannelNames", toVarArray (jackChannelNames (device->getOutputChannelNames(), "Output")));
        else
       #endif
        state->setProperty ("outputChannelNames", toVarArray (device->getOutputChannelNames()));

        // What the monitored bass passes through: its own chain, plus the output chain when it's included.
        int pluginLatency = 0;
        {
            const juce::SpinLock::ScopedLockType sl (chainLock);
            pluginLatency = chainLatency (false) + (outputIncludesBass.load() ? chainLatency (true) : 0);
        }

        auto totalSamples = device->getInputLatencyInSamples() + device->getOutputLatencyInSamples() + bs + pluginLatency;
       #if JUCE_LINUX
        if (deviceManager.getCurrentAudioDeviceType() == "JACK")
            totalSamples -= bs; // JACK's latency ranges include the period
       #elif JUCE_WINDOWS
        // ASIO's latencies (and JUCE's for WASAPI) already count each direction's buffer:
        // measured with a loopback cable, the round trip is input + output.
        totalSamples -= bs;
        state->setProperty ("latencyIncludesBuffer", true);
       #endif
        state->setProperty ("outputLatencySamples", device->getOutputLatencyInSamples());
        state->setProperty ("pluginLatencySamples", pluginLatency);
        // Round trip only means something with the input open.
        if (inputOpen)
        {
            state->setProperty ("inputLatencySamples", device->getInputLatencyInSamples());
            state->setProperty ("roundTripLatencyMs", sr > 0 ? 1000.0 * totalSamples / sr : 0.0);
        }
        state->setProperty ("xruns", device->getXRunCount());
    }
    else
    {
        state->setProperty ("running", false);
    }

    state->setProperty ("monitoring", monitoring.load());
    state->setProperty ("inputTrimDb", inputTrimDb.load());
    state->setProperty ("outputLevelDb", outputLevelDb.load());
    state->setProperty ("error", lastDeviceError);
    return juce::var (state.get());
}

juce::String AudioEngine::applyDeviceSetup (const juce::var& request)
{
    auto setup = deviceManager.getAudioDeviceSetup();
    auto* type = deviceManager.getCurrentDeviceTypeObject();

    // Another driver type (e.g. ASIO): it has its own devices, so start from its defaults.
    // It's opened once the whole setup is known (see reconfigure).
    juce::String newType;
    const auto requestedType = request["deviceType"].toString();
    if (requestedType.isNotEmpty() && requestedType != deviceManager.getCurrentAudioDeviceType())
    {
        for (auto* t : deviceManager.getAvailableDeviceTypes())
        {
            if (t->getTypeName() != requestedType)
                continue;
            t->scanForDevices();
            type = t;
            newType = requestedType;
            setup = {};
            setup.outputDeviceName = t->getDeviceNames (false)[juce::jmax (0, t->getDefaultDeviceIndex (false))];
            const auto inputs = t->getDeviceNames (true);
            wantedInput = t->hasSeparateInputsAndOutputs() ? inputs[juce::jmax (0, t->getDefaultDeviceIndex (true))]
                                                           : setup.outputDeviceName;
            wantedInputChannels.clear();
            wantedInputChannels.setBit (0);
        }
    }

    const auto previousInput = wantedInput;
    const auto exists = [type] (const juce::String& name, bool input) { return type == nullptr || type->getDeviceNames (input).contains (name); };

    if (request.hasProperty ("inputDevice") && exists (request["inputDevice"].toString(), true))
        wantedInput = request["inputDevice"].toString();
    if (request.hasProperty ("outputDevice") && exists (request["outputDevice"].toString(), false))
        setup.outputDeviceName = request["outputDevice"].toString();

    // One driver for both directions (ASIO): picking either picks both.
    if (type != nullptr && ! type->hasSeparateInputsAndOutputs())
    {
        if (request.hasProperty ("inputDevice") && wantedInput != previousInput)
            setup.outputDeviceName = wantedInput;
        else
            wantedInput = setup.outputDeviceName;
    }
    if (request.hasProperty ("sampleRate") && (double) request["sampleRate"] > 0)
        setup.sampleRate = (double) request["sampleRate"];
    if (request.hasProperty ("bufferSize") && (int) request["bufferSize"] > 0)
        setup.bufferSize = (int) request["bufferSize"];

    if (auto* channels = request["inputChannels"].getArray())
    {
        wantedInputChannels.clear();
        for (auto& c : *channels)
            wantedInputChannels.setBit ((int) c);
    }
    else if (previousInput != wantedInput)
    {
        wantedInputChannels.clear();
        wantedInputChannels.setBit (0);
    }

    lastDeviceError = reconfigure (setup, newType);
    return lastDeviceError;
}

bool AudioEngine::showDeviceControlPanel()
{
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device == nullptr || ! device->hasControlPanel())
        return false;
    // Modal; true when the driver's settings (buffer size, clock) may have changed.
    if (device->showControlPanel())
    {
        fadeOutForRestart();
        deviceManager.closeAudioDevice();
        deviceManager.restartLastAudioDevice();
    }
    return true;
}

bool AudioEngine::inputIsOpen()
{
    auto* device = deviceManager.getCurrentAudioDevice();
    return device != nullptr && deviceManager.getAudioDeviceSetup().inputDeviceName.isNotEmpty()
           && device->getActiveInputChannels().countNumberOfSetBits() > 0;
}

bool AudioEngine::inputWanted() const
{
    return monitoring.load() || tunerEnabled.load() || activeTake.load() != nullptr || keepsInputOpen (wantedInput);
}

juce::String AudioEngine::reconfigure (juce::AudioDeviceManager::AudioDeviceSetup setup, const juce::String& newType)
{
    const bool wantInput = inputWanted() && wantedInput.isNotEmpty();
    setup.inputDeviceName = wantInput ? wantedInput : juce::String();
    setup.useDefaultInputChannels = false;
    setup.useDefaultOutputChannels = false;
    setup.inputChannels = wantInput ? wantedInputChannels : juce::BigInteger();
    setup.outputChannels.clear();
    setup.outputChannels.setRange (0, 2, true);

    // Bluetooth adds ~100 ms or more anyway; small buffers only add dropouts.
    if (isBluetooth (setup.outputDeviceName) || (wantInput && isBluetooth (wantedInput)))
        setup.bufferSize = juce::jmax (setup.bufferSize, bluetoothMinBuffer);

   #if JUCE_LINUX
    if ((newType.isNotEmpty() ? newType : deviceManager.getCurrentAudioDeviceType()) == "JACK")
    {
        auto* device = deviceManager.getCurrentAudioDevice();
        requestPipeWireBuffer (setup.bufferSize, device != nullptr ? device->getCurrentSampleRate() : setup.sampleRate);
        // JUCE's JACK device opens its client when it's created: a new size needs a new one.
        if (newType.isEmpty() && device != nullptr && setup.bufferSize > 0 && setup.bufferSize != device->getCurrentBufferSizeSamples())
        {
            fadeOutForRestart();
            deviceManager.closeAudioDevice();
            return deviceManager.setAudioDeviceSetup (setup, true);
        }
    }
   #endif

    if (newType.isNotEmpty())
        return openWithDriver (newType, setup);

    auto current = deviceManager.getAudioDeviceSetup();
   #if ! JUCE_MAC
    // JUCE opens its default channels at startup, which are usually ours; don't
    // reopen the device for the flag alone.
    if (current.useDefaultInputChannels && current.inputChannels == setup.inputChannels)
        current.useDefaultInputChannels = false;
    if (current.useDefaultOutputChannels && current.outputChannels == setup.outputChannels)
        current.useDefaultOutputChannels = false;
   #endif
    if (current == setup && deviceManager.getCurrentAudioDevice() != nullptr)
        return {};

    fadeOutForRestart();
    return deviceManager.setAudioDeviceSetup (setup, true);
}

juce::String AudioEngine::openWithDriver (const juce::String& typeName, const juce::AudioDeviceManager::AudioDeviceSetup& setup)
{
    // setCurrentAudioDeviceType() waits 1.5 s and opens the driver's defaults before
    // the setup is applied, so ASIO was opened twice (2 s each). A setup with a
    // device type opens it once. Closing first skips the wait and keeps the old
    // driver's device (Windows Audio shared and exclusive share names) from being reused.
    fadeOutForRestart();
    deviceManager.closeAudioDevice();

    juce::XmlElement xml ("DEVICESETUP");
    xml.setAttribute ("deviceType", typeName);
    xml.setAttribute ("audioOutputDeviceName", setup.outputDeviceName);
    xml.setAttribute ("audioInputDeviceName", setup.inputDeviceName);
    if (setup.sampleRate > 0)
        xml.setAttribute ("audioDeviceRate", setup.sampleRate);
    if (setup.bufferSize > 0)
        xml.setAttribute ("audioDeviceBufferSize", setup.bufferSize);
    xml.setAttribute ("audioDeviceInChans", setup.inputChannels.toString (2));
    xml.setAttribute ("audioDeviceOutChans", setup.outputChannels.toString (2));
    return deviceManager.initialise (0, 2, &xml, true);
}

void AudioEngine::fadeOutForRestart()
{
    // Let the audio thread fade everything out (~10 ms) so the restart doesn't click.
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device == nullptr || ! device->isPlaying())
        return;
    restartFadeDone.store (false);
    restartFade.store (true);
    for (int i = 0; i < 60 && ! restartFadeDone.load(); ++i)
        juce::Thread::sleep (1);
}

void AudioEngine::setMonitoring (bool enabled)
{
    const bool before = inputWanted();
    monitoring.store (enabled);
    if (inputWanted() != before)
        lastDeviceError = reconfigure (deviceManager.getAudioDeviceSetup());
}

void AudioEngine::setTuner (bool enabled, bool mute)
{
    const bool before = inputWanted();
    tunerMute.store (mute);
    tunerEnabled.store (enabled);
    if (inputWanted() != before)
        lastDeviceError = reconfigure (deviceManager.getAudioDeviceSetup());
}

//==============================================================================
void AudioEngine::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    currentSampleRate = device->getCurrentSampleRate();
    currentBlockSize = juce::jmax (16, device->getCurrentBufferSizeSamples());

    stereoBuffer.setSize (2, currentBlockSize * 2, false, true, false);
    songBuffer.setSize (2, currentBlockSize * 2, false, true, false);
    clickBuffer.setSize (2, currentBlockSize * 2, false, true, false);
    clickDelay.setSize (2, clickDelaySize, false, true, false);
    clickDelay.clear();
    clickDelayWrite = 0;
    pluginBuffer.setSize (16, currentBlockSize, false, true, false);
    midiBuffer.ensureSize (256);

    trimGain.reset (currentSampleRate, 0.03);
    outputGain.reset (currentSampleRate, 0.03);
    monitorGate.reset (currentSampleRate, 0.02);
    monitorGate.setCurrentAndTargetValue (0.0f);
    trimGain.setCurrentAndTargetValue (juce::Decibels::decibelsToGain (inputTrimDb.load()));
    outputGain.setCurrentAndTargetValue (juce::Decibels::decibelsToGain (outputLevelDb.load()));
    limiterGain = 1.0f;
    limiterRelease = (float) std::exp (-1.0 / (0.08 * currentSampleRate));
    // Fade back in after a restart (and on the first start).
    deviceFade = 0.0f;
    deviceFadeStep = (float) (1.0 / (0.01 * currentSampleRate));
    restartFade.store (false);

    song.prepare (currentSampleRate, currentBlockSize);

    const juce::SpinLock::ScopedLockType sl (chainLock);
    for (auto& s : slots)
        prepareSlot (*s);
}

double AudioEngine::getOutputLatencySeconds()
{
    if (auto* device = deviceManager.getCurrentAudioDevice())
    {
        const auto sr = device->getCurrentSampleRate();
        // The song is heard later by the output chain's latency too.
        const int outputChain = outputChainLatency.load (std::memory_order_relaxed);
       #if JUCE_LINUX
        // JACK's playback latency already counts the period the block is written in.
        if (sr > 0 && deviceManager.getCurrentAudioDeviceType() == "JACK")
            return (device->getOutputLatencyInSamples() + outputChain) / sr;
       #endif
        if (sr > 0)
            return (device->getOutputLatencyInSamples() + device->getCurrentBufferSizeSamples() + outputChain) / sr;
    }
    return 0.0;
}

int AudioEngine::snapshotBlocksAhead()
{
   #if JUCE_LINUX
    // JACK runs the callback in the cycle whose output its latency is measured from.
    if (deviceManager.getCurrentAudioDeviceType() == "JACK")
        return 0;
   #elif JUCE_WINDOWS
    // ASIO drivers count the buffer the callback fills in their output latency,
    // and JUCE adds it to WASAPI's: getOutputLatencySeconds() already reaches
    // the end of this block. Two blocks more put the playhead two buffers late.
    return 0;
   #endif
    return 2;
}

void AudioEngine::audioDeviceStopped()
{
    const juce::SpinLock::ScopedLockType sl (chainLock);
    for (auto& s : slots)
        if (s->plugin != nullptr)
            s->plugin->releaseResources();
}

void AudioEngine::audioDeviceError (const juce::String& errorMessage)
{
    lastDeviceError = errorMessage;
    juce::MessageManager::callAsync ([msg = errorMessage]
    {
        auto payload = juce::DynamicObject::Ptr (new juce::DynamicObject());
        payload->setProperty ("message", msg);
        Protocol::sendEvent ("deviceError", payload);
    });
}

void AudioEngine::changeListenerCallback (juce::ChangeBroadcaster*)
{
    // Device list or configuration changed (e.g. interface unplugged).
    auto payload = juce::DynamicObject::Ptr (new juce::DynamicObject());
    payload->setProperty ("state", getDeviceState());
    Protocol::sendEvent ("deviceChanged", payload);
}

//==============================================================================
void AudioEngine::audioDeviceIOCallbackWithContext (const float* const* inputChannelData, int numInputChannels,
                                                     float* const* outputChannelData, int numOutputChannels,
                                                     int numSamples, const juce::AudioIODeviceCallbackContext&)
{
    juce::ScopedNoDenormals noDenormals;

    if (numSamples > stereoBuffer.getNumSamples())
    {
        for (int ch = 0; ch < numOutputChannels; ++ch)
            if (outputChannelData[ch] != nullptr)
                juce::FloatVectorOperations::clear (outputChannelData[ch], numSamples);
        return;
    }

    auto* left = stereoBuffer.getWritePointer (0);
    auto* right = stereoBuffer.getWritePointer (1);

    // One input is a mono bass, played on both sides. A pair is a stereo rig
    // (stereo effects, two amps): the first channel is left, the second right.
    const float* inputs[2] = {};
    int usedInputs = 0;
    for (int ch = 0; ch < numInputChannels && usedInputs < 2; ++ch)
        if (inputChannelData[ch] != nullptr)
            inputs[usedInputs++] = inputChannelData[ch];
    const bool stereoInput = usedInputs == 2;
    if (usedInputs > 0)
        juce::FloatVectorOperations::copy (left, inputs[0], numSamples);
    else
        juce::FloatVectorOperations::clear (left, numSamples);
    juce::FloatVectorOperations::copy (right, stereoInput ? inputs[1] : left, numSamples);

    const auto peakOf = [numSamples] (const float* data)
    {
        const auto r = juce::FloatVectorOperations::findMinAndMax (data, numSamples);
        return juce::jmax (std::abs (r.getStart()), std::abs (r.getEnd()));
    };

    // Converter-level peak: clipping here means the interface's gain knob is too high.
    const auto rawPeak = juce::jmax (peakOf (left), peakOf (right));
    storeMax (inputPeakRaw, rawPeak);
    if (rawPeak >= 0.999f)
        inputClipped.store (true);

    trimGain.setTargetValue (juce::Decibels::decibelsToGain (inputTrimDb.load()));
    trimGain.applyGain (stereoBuffer, numSamples);
    storeMax (inputPeak, juce::jmax (peakOf (left), peakOf (right)));

    // A take records the clean bass (after trim, before its effects).
    bool recordingTake = false;
    {
        const juce::GenericScopedTryLock<juce::SpinLock> lock (takeLock);
        if (lock.isLocked())
            if (auto* take = activeTake.load (std::memory_order_acquire))
            {
                const float* channels[] = { left, right };
                if (! take->write (channels, numSamples))
                    takeDropped.store (true); // disk fell behind: the take has a gap
                takeFrames += numSamples;
                recordingTake = true;
            }
    }

    if (tunerEnabled.load (std::memory_order_relaxed))
    {
        int w = tunerWrite.load (std::memory_order_relaxed);
        for (int i = 0; i < numSamples; ++i)
            tunerRing[(size_t) ((w + i) & (tunerRingSize - 1))] = stereoInput ? 0.5f * (left[i] + right[i]) : left[i];
        tunerWrite.store ((w + numSamples) & (tunerRingSize - 1), std::memory_order_release);
    }

    // Like a pedal tuner: optionally silence the monitor while tuning. Switching
    // fades over 20 ms (the effects keep running meanwhile), so it never clicks.
    const bool monitorOn = monitoring.load() && ! (tunerEnabled.load() && tunerMute.load());
    monitorGate.setTargetValue (monitorOn ? 1.0f : 0.0f);

    if (monitorOn || monitorGate.isSmoothing())
    {
        processChain (stereoBuffer, numSamples, false);

        outputGain.setTargetValue (juce::Decibels::decibelsToGain (outputLevelDb.load()));
        for (int i = 0; i < numSamples; ++i)
        {
            const auto g = outputGain.getNextValue() * monitorGate.getNextValue();
            left[i] *= g;
            right[i] *= g;
        }

        guardInvalid (stereoBuffer, numSamples);
        // The monitored bass on its own, after its effects and the Monitor level.
        const auto lr = juce::FloatVectorOperations::findMinAndMax (left, numSamples);
        const auto rr = juce::FloatVectorOperations::findMinAndMax (right, numSamples);
        storeMax (monitorPeak, juce::jmax (juce::jmax (std::abs (lr.getStart()), std::abs (lr.getEnd())),
                                           juce::jmax (std::abs (rr.getStart()), std::abs (rr.getEnd()))));
    }
    else
    {
        stereoBuffer.clear (0, numSamples);
        outputGain.setCurrentAndTargetValue (juce::Decibels::decibelsToGain (outputLevelDb.load()));
    }

    // The song, on the same clock, then the output chain: with the bass mixed
    // in first, or with the bass joining afterwards. The metronome skips the
    // output effects and joins at the end.
    auto* songL = songBuffer.getWritePointer (0);
    auto* songR = songBuffer.getWritePointer (1);
    auto* clickL = clickBuffer.getWritePointer (0);
    auto* clickR = clickBuffer.getWritePointer (1);
    juce::FloatVectorOperations::clear (songL, numSamples);
    juce::FloatVectorOperations::clear (songR, numSamples);
    juce::FloatVectorOperations::clear (clickL, numSamples);
    juce::FloatVectorOperations::clear (clickR, numSamples);
    song.process (songL, songR, numSamples, clickL, clickR);
    if (recordingTake)
    {
        const auto count = takeMarkCount.load (std::memory_order_relaxed);
        if (count < takeMarks.size())
        {
            double pos = 0.0;
            const bool playing = song.blockEndPosition (pos);
            takeMarks[count] = { takeFrames, pos, playing };
            takeMarkCount.store (count + 1, std::memory_order_release);
        }
    }
    if (outputIncludesBass.load (std::memory_order_relaxed))
    {
        juce::FloatVectorOperations::add (songL, left, numSamples);
        juce::FloatVectorOperations::add (songR, right, numSamples);
        processChain (songBuffer, numSamples, true);
        guardInvalid (songBuffer, numSamples);
        juce::FloatVectorOperations::copy (left, songL, numSamples);
        juce::FloatVectorOperations::copy (right, songR, numSamples);
    }
    else
    {
        processChain (songBuffer, numSamples, true);
        guardInvalid (songBuffer, numSamples);
        juce::FloatVectorOperations::add (left, songL, numSamples);
        juce::FloatVectorOperations::add (right, songR, numSamples);
    }
    delayClicks (clickL, clickR, numSamples);
    juce::FloatVectorOperations::add (left, clickL, numSamples);
    juce::FloatVectorOperations::add (right, clickR, numSamples);

    // Safety limiter on everything that leaves Nøta, so a feedback loop, a hot
    // plugin or a loud song can't blast the ears.
    float minGain = 1.0f, outPk = 0.0f;
    for (int i = 0; i < numSamples; ++i)
    {
        const auto peak = juce::jmax (std::abs (left[i]), std::abs (right[i]));
        const auto needed = peak > limiterCeiling ? limiterCeiling / peak : 1.0f;
        if (needed < limiterGain)
            limiterGain = needed;
        else
            limiterGain = needed + (limiterGain - needed) * limiterRelease;
        left[i] *= limiterGain;
        right[i] *= limiterGain;
        minGain = juce::jmin (minGain, limiterGain);
        outPk = juce::jmax (outPk, peak);
    }
    storeMin (minLimiterGain, minGain);
    storeMax (outputPeak, outPk);
    if (outPk >= 1.0f)
        outputClipped.store (true);

    // Fade out before a device restart, in after one.
    const float fadeTarget = restartFade.load (std::memory_order_relaxed) ? 0.0f : 1.0f;
    if (deviceFade != fadeTarget)
    {
        for (int i = 0; i < numSamples; ++i)
        {
            deviceFade = fadeTarget > deviceFade ? juce::jmin (fadeTarget, deviceFade + deviceFadeStep)
                                                 : juce::jmax (fadeTarget, deviceFade - deviceFadeStep);
            left[i] *= deviceFade;
            right[i] *= deviceFade;
        }
    }
    else if (fadeTarget == 0.0f)
    {
        juce::FloatVectorOperations::clear (left, numSamples);
        juce::FloatVectorOperations::clear (right, numSamples);
    }
    if (fadeTarget == 0.0f && deviceFade == 0.0f)
        restartFadeDone.store (true);

    if (auto* capture = captureTarget.load (std::memory_order_acquire))
    {
        const int written = captureWritten.load (std::memory_order_relaxed);
        const int n = juce::jmin (numSamples, capture->getNumSamples() - written);
        capture->copyFrom (0, written, left, n);
        capture->copyFrom (1, written, right, n);
        captureWritten.store (written + n, std::memory_order_release);
        if (written + n >= capture->getNumSamples())
        {
            captureTarget.store (nullptr, std::memory_order_release);
            captureFull.store (true, std::memory_order_release);
        }
    }

    for (int ch = 0; ch < numOutputChannels; ++ch)
    {
        if (outputChannelData[ch] == nullptr)
            continue;
        if (ch < 2)
            juce::FloatVectorOperations::copy (outputChannelData[ch], stereoBuffer.getReadPointer (ch), numSamples);
        else
            juce::FloatVectorOperations::clear (outputChannelData[ch], numSamples);
    }
}

/** Delays the metronome by the output chain's latency (a ring buffer; nothing to do without latency). */
void AudioEngine::delayClicks (float* l, float* r, int numSamples)
{
    const int delay = juce::jlimit (0, clickDelaySize - 1, outputChainLatency.load (std::memory_order_relaxed));
    if (delay != clickDelayUsed)
    {
        clickDelay.clear(); // a changed delay starts clean rather than replaying stale clicks
        clickDelayUsed = delay;
    }
    if (delay == 0)
        return;
    auto* dl = clickDelay.getWritePointer (0);
    auto* dr = clickDelay.getWritePointer (1);
    for (int i = 0; i < numSamples; ++i)
    {
        const int w = clickDelayWrite;
        const int rd = (w - delay + clickDelaySize) & (clickDelaySize - 1);
        dl[w] = l[i];
        dr[w] = r[i];
        l[i] = dl[rd];
        r[i] = dr[rd];
        clickDelayWrite = (w + 1) & (clickDelaySize - 1);
    }
}

/** Guard against NaN/inf from a misbehaving plugin: silence the block. */
bool AudioEngine::guardInvalid (juce::AudioBuffer<float>& buffer, int numSamples)
{
    const auto* l = buffer.getReadPointer (0);
    const auto* r = buffer.getReadPointer (1);
    for (int i = 0; i < numSamples; ++i)
    {
        if (! std::isfinite (l[i]) || ! std::isfinite (r[i]))
        {
            invalidSamples.store (true);
            buffer.clear (0, numSamples);
            return true;
        }
    }
    return false;
}

int AudioEngine::chainLatency (bool output) const
{
    int total = 0;
    for (auto& s : slots)
        if (s->output == output && s->plugin != nullptr && ! s->bypassed.load())
            total += s->plugin->getLatencySamples();
    return total;
}

void AudioEngine::processChain (juce::AudioBuffer<float>& stereo, int numSamples, bool output)
{
    const juce::GenericScopedTryLock<juce::SpinLock> lock (chainLock);
    if (! lock.isLocked())
        return; // chain is being edited: pass the dry signal for this block

    // Plugins can change their latency at any time; keep the click delay and the
    // reported song latency current from here, so other threads never need the lock.
    if (output)
        outputChainLatency.store (chainLatency (true), std::memory_order_relaxed);

    for (auto& slot : slots)
    {
        auto* plugin = slot->plugin.get();
        if (plugin == nullptr || slot->output != output || slot->bypassed.load())
            continue;

        const int numIns = plugin->getTotalNumInputChannels();
        const int numOuts = plugin->getTotalNumOutputChannels();
        const int numChannels = juce::jlimit (1, pluginBuffer.getNumChannels(), juce::jmax (numIns, numOuts));

        // Plugins are prepared for currentBlockSize, so never hand them more.
        for (int offset = 0; offset < numSamples; offset += currentBlockSize)
        {
            const int n = juce::jmin (currentBlockSize, numSamples - offset);

            for (int ch = 0; ch < numChannels; ++ch)
            {
                if (ch < 2 && ch < numIns)
                    pluginBuffer.copyFrom (ch, 0, stereo, ch, offset, n);
                else
                    pluginBuffer.clear (ch, 0, n);
            }

            juce::AudioBuffer<float> view (pluginBuffer.getArrayOfWritePointers(), numChannels, n);
            midiBuffer.clear();
            plugin->processBlock (view, midiBuffer);

            if (numOuts >= 2)
            {
                stereo.copyFrom (0, offset, view, 0, 0, n);
                stereo.copyFrom (1, offset, view, 1, 0, n);
            }
            else if (numOuts == 1)
            {
                stereo.copyFrom (0, offset, view, 0, 0, n);
                stereo.copyFrom (1, offset, view, 0, 0, n);
            }
        }
    }
}

//==============================================================================
void AudioEngine::prepareSlot (ChainSlot& slot)
{
    auto& p = *slot.plugin;
    p.releaseResources();
    p.disableNonMainBuses();

    using Set = juce::AudioChannelSet;
    const juce::AudioProcessor::BusesLayout candidates[] = {
        { { Set::stereo() }, { Set::stereo() } },
        { { Set::mono() },   { Set::stereo() } },
        { { Set::mono() },   { Set::mono() } },
    };

    for (auto& layout : candidates)
        if (p.checkBusesLayoutSupported (layout) && p.setBusesLayout (layout))
            break;

    p.setRateAndBufferSizeDetails (currentSampleRate, currentBlockSize);
    p.prepareToPlay (currentSampleRate, currentBlockSize);
}

ChainSlot* AudioEngine::findSlot (const juce::String& slotId)
{
    for (auto& s : slots)
        if (s->slotId == slotId)
            return s.get();
    return nullptr;
}

void AudioEngine::addPlugin (const juce::String& slotId, const juce::String& descriptionXml, int index,
                             const juce::String& base64State, bool bypassed, bool output, AddCallback callback)
{
    juce::PluginDescription description;
    auto xml = juce::parseXML (descriptionXml);
    if (xml == nullptr || ! description.loadFromXml (*xml))
    {
        callback (nullptr, "Invalid plugin description");
        return;
    }

    formatManager.createPluginInstanceAsync (description, currentSampleRate, currentBlockSize,
        [this, slotId, descriptionXml, index, base64State, bypassed, output, callback, name = description.name]
        (std::unique_ptr<juce::AudioPluginInstance> instance, const juce::String& error)
        {
            if (instance == nullptr)
            {
                callback (nullptr, error.isNotEmpty() ? error : "The plugin could not be loaded");
                return;
            }

            auto slot = std::make_unique<ChainSlot>();
            slot->slotId = slotId;
            slot->output = output;
            slot->name = name;
            slot->descriptionXml = descriptionXml;
            slot->plugin = std::move (instance);
            slot->bypassed.store (bypassed);

            if (base64State.isNotEmpty())
            {
                juce::MemoryBlock state;
                if (state.fromBase64Encoding (base64State))
                    slot->plugin->setStateInformation (state.getData(), (int) state.getSize());
            }

            prepareSlot (*slot);
            auto* raw = slot.get();

            {
                // `index` counts within the slot's chain; slots of both chains share one list.
                const juce::SpinLock::ScopedLockType sl (chainLock);
                auto pos = slots.end();
                int seen = 0;
                for (auto it = slots.begin(); it != slots.end(); ++it)
                {
                    if ((*it)->output != output)
                        continue;
                    if (index >= 0 && seen == index)
                    {
                        pos = it;
                        break;
                    }
                    ++seen;
                }
                slots.insert (pos, std::move (slot));
            }

            callback (raw, {});
        });
}

bool AudioEngine::removePlugin (const juce::String& slotId)
{
    editors.erase (std::remove_if (editors.begin(), editors.end(),
                                   [&] (auto& w) { return w->slotId == slotId; }),
                   editors.end());

    std::unique_ptr<ChainSlot> removed;
    {
        const juce::SpinLock::ScopedLockType sl (chainLock);
        for (auto it = slots.begin(); it != slots.end(); ++it)
        {
            if ((*it)->slotId == slotId)
            {
                removed = std::move (*it);
                slots.erase (it);
                break;
            }
        }
    }
    // Destroyed outside the lock, on the message thread.
    return removed != nullptr;
}

bool AudioEngine::movePlugin (const juce::String& slotId, int newIndex)
{
    const juce::SpinLock::ScopedLockType sl (chainLock);
    for (size_t i = 0; i < slots.size(); ++i)
    {
        if (slots[i]->slotId == slotId)
        {
            auto slot = std::move (slots[i]);
            slots.erase (slots.begin() + (long) i);
            // newIndex counts within the slot's own chain.
            auto pos = slots.end();
            int seen = 0;
            for (auto it = slots.begin(); it != slots.end(); ++it)
            {
                if ((*it)->output != slot->output)
                    continue;
                if (seen == newIndex)
                {
                    pos = it;
                    break;
                }
                ++seen;
            }
            slots.insert (pos, std::move (slot));
            return true;
        }
    }
    return false;
}

bool AudioEngine::setBypassed (const juce::String& slotId, bool bypassed)
{
    if (auto* s = findSlot (slotId))
    {
        s->bypassed.store (bypassed);
        return true;
    }
    return false;
}

void AudioEngine::closeEditor (const juce::String& slotId)
{
    const auto before = editors.size();
    editors.erase (std::remove_if (editors.begin(), editors.end(), [&] (auto& w) { return w->slotId == slotId; }),
                   editors.end());
    if (editors.size() != before && onEditorClosed)
        onEditorClosed (slotId);
}

juce::String AudioEngine::toggleEditor (const juce::String& slotId)
{
    for (auto& w : editors)
    {
        if (w->slotId == slotId)
        {
            // In front: close it. Behind Nøta (you clicked Nøta since): bring it back.
            if (w->wasInFront())
                closeEditor (slotId);
            else
                w->bringToFront();
            return {};
        }
    }
    return openEditor (slotId);
}

juce::String AudioEngine::openEditor (const juce::String& slotId)
{
    auto* slot = findSlot (slotId);
    if (slot == nullptr || slot->plugin == nullptr)
        return "Unknown effect";

    for (auto& w : editors)
    {
        if (w->slotId == slotId)
        {
            w->bringToFront();
            return {};
        }
    }

    if (! slot->plugin->hasEditor())
        return "This plugin has no graphical interface";

    auto* editor = slot->plugin->createEditorIfNeeded();
    if (editor == nullptr)
        return "The plugin could not open its interface";

    editors.push_back (std::make_unique<EditorWindow> (*this, *slot, editor));
    return {};
}

void AudioEngine::setWindowTheme (bool dark, int captionRgb)
{
    darkWindows = dark;
    windowCaption = captionRgb;
    for (auto& w : editors)
        w->applyTheme();
}

void AudioEngine::closeAllEditors()
{
    editors.clear();
}

juce::var AudioEngine::getChainState()
{
    juce::Array<juce::var> out;
    for (auto& s : slots)
    {
        auto obj = juce::DynamicObject::Ptr (new juce::DynamicObject());
        obj->setProperty ("slotId", s->slotId);
        obj->setProperty ("chain", s->output ? "output" : "input");
        obj->setProperty ("name", s->name);
        obj->setProperty ("bypassed", s->bypassed.load());
        obj->setProperty ("latencySamples", s->plugin != nullptr ? s->plugin->getLatencySamples() : 0);
        obj->setProperty ("hasEditor", s->plugin != nullptr && s->plugin->hasEditor());

        if (s->plugin != nullptr)
        {
            juce::MemoryBlock state;
            s->plugin->getStateInformation (state);
            obj->setProperty ("state", state.toBase64Encoding());
        }
        out.add (juce::var (obj.get()));
    }
    return out;
}

void AudioEngine::clearChain()
{
    editors.clear();
    std::vector<std::unique_ptr<ChainSlot>> removed;
    {
        const juce::SpinLock::ScopedLockType sl (chainLock);
        removed.swap (slots);
    }
}

juce::String AudioEngine::startTake (const juce::String& path, double maxSeconds)
{
    if (activeTake.load() != nullptr)
        return "A take is already being recorded";
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device == nullptr || ! device->isPlaying())
        return "The audio device is not running";
    if (wantedInput.isEmpty())
        return "Choose an input in the Mixer first";

    const bool inputWasWanted = inputWanted();
    takeRate = device->getCurrentSampleRate();
    const juce::File file (path);
    file.getParentDirectory().createDirectory();
    file.deleteFile();
    juce::WavAudioFormat wav;
    // Stereo, so a stereo rig is kept as played (a mono bass is on both sides);
    // the transcriber mixes it down.
    auto* writer = wav.createWriterFor (new juce::FileOutputStream (file), takeRate, 2, 24, {}, 0);
    if (writer == nullptr)
        return "Couldn't create the take file";
    if (! takeThread.isThreadRunning())
        takeThread.startThread();
    takeWriter = std::make_unique<juce::AudioFormatWriter::ThreadedWriter> (writer, takeThread, 1 << 17);

    const auto blocks = juce::jlimit (1.0, 3600.0, maxSeconds) * takeRate / juce::jmax (16, currentBlockSize);
    takeMarks.assign ((size_t) blocks + 4096, {});
    takeMarkCount.store (0);
    takeFrames = 0;
    takeDropped.store (false);
    takePath = path;
    activeTake.store (takeWriter.get(), std::memory_order_release);

    if (! inputWasWanted)
        lastDeviceError = reconfigure (deviceManager.getAudioDeviceSetup()); // open the input
    return {};
}

juce::var AudioEngine::stopTake()
{
    if (activeTake.load() == nullptr)
        return {};
    {
        // Once this lock is released the audio thread can't be writing any more.
        const juce::SpinLock::ScopedLockType sl (takeLock);
        activeTake.store (nullptr, std::memory_order_release);
    }
    takeWriter.reset(); // writes what's still buffered and closes the file

    int inputLatency = 0, outputLatency = 0, bufferSize = currentBlockSize;
    if (auto* device = deviceManager.getCurrentAudioDevice())
    {
        inputLatency = device->getInputLatencyInSamples();
        outputLatency = device->getOutputLatencyInSamples();
        bufferSize = device->getCurrentBufferSizeSamples();
    }

    // The marks can run to hundreds of thousands: write them as compact JSON directly.
    const auto count = takeMarkCount.load (std::memory_order_acquire);
    juce::MemoryOutputStream json;
    json << "{\"sampleRate\":" << takeRate << ",\"frames\":" << takeFrames
         << ",\"dropped\":" << (takeDropped.load() ? "true" : "false")
         << ",\"inputLatency\":" << inputLatency << ",\"outputLatency\":" << outputLatency
         << ",\"bufferSize\":" << bufferSize << ",\"outputChainLatency\":" << outputChainLatency.load();
   #if JUCE_WINDOWS
    json << ",\"latencyIncludesBuffer\":true"; // the driver's latencies count the buffers (see getDeviceState)
   #endif
    json << ",\"marks\":[";
    for (size_t i = 0; i < count; ++i)
    {
        const auto& m = takeMarks[i];
        if (i > 0)
            json << ",";
        json << "[" << m.frame << "," << juce::String (m.songPos, 4) << "," << (m.playing ? 1 : 0) << "]";
    }
    json << "]}";
    const juce::File marksFile (takePath + ".json");
    const bool written = marksFile.replaceWithText (json.toString());
    takeMarks.clear();
    takeMarks.shrink_to_fit();

    if (! inputWanted())
        lastDeviceError = reconfigure (deviceManager.getAudioDeviceSetup()); // close it again

    auto r = juce::DynamicObject::Ptr (new juce::DynamicObject());
    r->setProperty ("path", takePath);
    r->setProperty ("marksPath", marksFile.getFullPathName());
    r->setProperty ("seconds", takeRate > 0 ? (double) takeFrames / takeRate : 0.0);
    r->setProperty ("ok", written);
    return juce::var (r.get());
}

juce::String AudioEngine::startCapture (const juce::String& path, double seconds)
{
    if (captureBuffer != nullptr)
        return "A recording is already running";
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device == nullptr || ! device->isPlaying())
        return "The audio device is not running";
    captureRate = device->getCurrentSampleRate();
    const int frames = (int) juce::jlimit (1.0, 600.0, seconds) * (int) captureRate;
    captureBuffer = std::make_unique<juce::AudioBuffer<float>> (2, frames);
    captureBuffer->clear();
    capturePath = path;
    captureWritten.store (0);
    captureFull.store (false);
    captureTarget.store (captureBuffer.get(), std::memory_order_release);
    return {};
}

juce::String AudioEngine::finishCapture()
{
    if (captureBuffer == nullptr || ! captureFull.load (std::memory_order_acquire))
        return {};
    const juce::File file (capturePath);
    file.deleteFile();
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::AudioFormatWriter> writer (wav.createWriterFor (new juce::FileOutputStream (file), captureRate, 2, 32, {}, 0));
    if (writer != nullptr)
        writer->writeFromAudioSampleBuffer (*captureBuffer, 0, captureBuffer->getNumSamples());
    writer.reset();
    captureBuffer.reset();
    return capturePath;
}

juce::DynamicObject::Ptr AudioEngine::takeMeterSnapshot()
{
    auto m = juce::DynamicObject::Ptr (new juce::DynamicObject());
    m->setProperty ("inputPeakRaw", inputPeakRaw.exchange (0.0f));
    m->setProperty ("inputPeak", inputPeak.exchange (0.0f));
    m->setProperty ("outputPeak", outputPeak.exchange (0.0f));
    m->setProperty ("monitorPeak", monitorPeak.exchange (0.0f));
    m->setProperty ("limiterGainDb", juce::Decibels::gainToDecibels (minLimiterGain.exchange (1.0f), -60.0f));
    m->setProperty ("inputClipped", inputClipped.exchange (false));
    m->setProperty ("outputClipped", outputClipped.exchange (false));
    m->setProperty ("invalidSamples", invalidSamples.exchange (false));
    m->setProperty ("songPeak", song.takeSongPeak());
    m->setProperty ("songClipped", song.takeSongClipped());
    if (auto* device = deviceManager.getCurrentAudioDevice())
        m->setProperty ("xruns", device->getXRunCount());
    return m;
}

//==============================================================================
// YIN pitch detection (de Cheveigné & Kawahara 2002), set up for bass:
// 25-500 Hz, analysed at ~12 kHz over an ~85 ms window.
juce::DynamicObject::Ptr AudioEngine::detectPitch()
{
    auto result = juce::DynamicObject::Ptr (new juce::DynamicObject());
    const double sr = currentSampleRate;
    const int decim = juce::jmax (1, (int) std::round (sr / 12000.0));
    const double fs = sr / decim;
    const int window = 1024;
    const int tauMax = juce::jmin ((int) (fs / 25.0), 700);
    const int tauMin = juce::jmax (2, (int) (fs / 500.0));
    const int n = window + tauMax;
    const int raw = n * decim;
    if (raw >= tunerRingSize)
        return result;

    // Copy the most recent input and decimate with a boxcar average.
    const int end = tunerWrite.load (std::memory_order_acquire);
    std::vector<float> x ((size_t) n);
    double mean = 0.0;
    for (int i = 0; i < n; ++i)
    {
        float acc = 0.0f;
        for (int k = 0; k < decim; ++k)
            acc += tunerRing[(size_t) ((end - raw + i * decim + k) & (tunerRingSize - 1))];
        x[(size_t) i] = acc / (float) decim;
        mean += x[(size_t) i];
    }
    mean /= n;
    double energy = 0.0;
    for (auto& v : x)
    {
        v -= (float) mean;
        energy += v * v;
    }
    const auto rmsDb = juce::Decibels::gainToDecibels ((float) std::sqrt (energy / n), -100.0f);
    result->setProperty ("rmsDb", rmsDb);
    result->setProperty ("hz", 0.0);
    if (rmsDb < -62.0f)
        return result;

    // Difference function and its cumulative mean normalisation.
    std::vector<float> d ((size_t) tauMax + 2, 0.0f);
    for (int tau = 1; tau <= tauMax + 1; ++tau)
    {
        double sum = 0.0;
        for (int j = 0; j < window; ++j)
        {
            const float diff = x[(size_t) j] - x[(size_t) (j + tau)];
            sum += diff * diff;
        }
        d[(size_t) tau] = (float) sum;
    }
    d[0] = 1.0f;
    double running = 0.0;
    for (int tau = 1; tau <= tauMax + 1; ++tau)
    {
        running += d[(size_t) tau];
        d[(size_t) tau] = running > 0 ? (float) (d[(size_t) tau] * tau / running) : 1.0f;
    }

    // First dip under the threshold (avoids octave errors), refined to its minimum.
    int best = -1;
    for (int tau = tauMin; tau <= tauMax; ++tau)
    {
        if (d[(size_t) tau] < 0.15f)
        {
            while (tau + 1 <= tauMax && d[(size_t) tau + 1] < d[(size_t) tau])
                ++tau;
            best = tau;
            break;
        }
    }
    if (best < 0)
    {
        int argmin = tauMin;
        for (int tau = tauMin; tau <= tauMax; ++tau)
            if (d[(size_t) tau] < d[(size_t) argmin])
                argmin = tau;
        if (d[(size_t) argmin] < 0.35f)
            best = argmin;
    }
    if (best < 0)
        return result;

    // Parabolic interpolation around the minimum.
    double refined = best;
    if (best > 1 && best < tauMax + 1)
    {
        const double a = d[(size_t) best - 1], b = d[(size_t) best], c = d[(size_t) best + 1];
        const double denom = a - 2 * b + c;
        if (std::abs (denom) > 1e-12)
            refined = best + 0.5 * (a - c) / denom;
    }
    result->setProperty ("hz", fs / refined);
    result->setProperty ("clarity", 1.0 - d[(size_t) best]);
    return result;
}

