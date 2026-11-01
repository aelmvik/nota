// Nøta audio engine: a headless sidecar that owns the audio device, the live
// bass monitoring path and VST3/AU plugin hosting.
//
// Modes:
//   NotaEngine                      long-running engine, JSON lines on stdin/stdout
//   NotaEngine --list <format> [paths]   print candidate plugin identifiers
//   NotaEngine --describe <format> <id>  print plugin descriptions for one file
//   NotaEngine --render <script.json> <out.wav>   play a scripted session offline (tests)
//
// The --list/--describe modes exist so that the Electron host can scan each
// plugin in a throwaway process: a plugin that crashes while being scanned
// cannot take down the engine that is monitoring the user's instrument.

#include "AudioEngine.h"
#include "Protocol.h"

#include <iostream>
#include <string>

namespace
{
    juce::AudioPluginFormat* findFormat (juce::AudioPluginFormatManager& fm, const juce::String& name)
    {
        for (auto* f : fm.getFormats())
            if (f->getName().equalsIgnoreCase (name))
                return f;
        return nullptr;
    }

    juce::var describeToVar (const juce::PluginDescription& d)
    {
        auto o = juce::DynamicObject::Ptr (new juce::DynamicObject());
        o->setProperty ("name", d.name);
        o->setProperty ("manufacturer", d.manufacturerName);
        o->setProperty ("format", d.pluginFormatName);
        o->setProperty ("category", d.category);
        o->setProperty ("version", d.version);
        o->setProperty ("isInstrument", d.isInstrument);
        o->setProperty ("numInputChannels", d.numInputChannels);
        o->setProperty ("numOutputChannels", d.numOutputChannels);
        o->setProperty ("fileOrIdentifier", d.fileOrIdentifier);
        o->setProperty ("identifier", d.createIdentifierString());
        if (auto xml = d.createXml())
            o->setProperty ("descriptionXml", xml->toString (juce::XmlElement::TextFormat().singleLine().withoutHeader()));
        return juce::var (o.get());
    }

    juce::DynamicObject::Ptr obj() { return new juce::DynamicObject(); }

    void readTracks (const juce::var& list, SongPlayer::TrackSpec (&out)[SongPlayer::numSlots])
    {
        if (auto* items = list.getArray())
            for (int s = 0; s < SongPlayer::numSlots && s < items->size(); ++s)
            {
                const auto& t = items->getReference (s);
                if (t.isObject())
                    out[s] = { t["path"].toString() };
            }
    }

    std::vector<double> toDoubles (const juce::var& v)
    {
        std::vector<double> out;
        if (auto* a = v.getArray())
            for (auto& x : *a)
                out.push_back ((double) x);
        return out;
    }

    std::vector<bool> toBools (const juce::var& v)
    {
        std::vector<bool> out;
        if (auto* a = v.getArray())
            for (auto& x : *a)
                out.push_back ((bool) x);
        return out;
    }

    /** Song commands shared by the live engine and offline rendering. Returns false if `cmd` isn't one. */
    bool handleSongCommand (SongPlayer& p, const juce::String& cmd, const juce::var& msg, juce::var& result, juce::String& error)
    {
        const int seq = (int) msg["seq"];
        if (cmd == "song.load")
        {
            SongPlayer::TrackSpec specs[SongPlayer::numSlots];
            readTracks (msg["tracks"], specs);
            result = p.load (msg["songId"].toString(), specs, (double) msg["position"], (int) msg["mode"], seq);
        }
        else if (cmd == "song.tracks")
        {
            SongPlayer::TrackSpec specs[SongPlayer::numSlots];
            readTracks (msg["tracks"], specs);
            result = p.setTracks (specs, seq);
        }
        else if (cmd == "song.unload")   p.unload (seq);
        else if (cmd == "song.play")     p.play ((int) msg["countInBeats"], (double) msg["countInPeriod"], msg.hasProperty ("beatsPerBar") ? (int) msg["beatsPerBar"] : 4, seq);
        else if (cmd == "song.pause")    p.pause (seq);
        else if (cmd == "song.stop")     p.stop (seq);
        else if (cmd == "song.seek")     p.seek ((double) msg["position"], seq);
        else if (cmd == "song.mode")     p.setMode ((int) msg["mode"], seq);
        else if (cmd == "song.loop")     p.setLoop ((double) msg["start"], (double) msg["end"], (bool) msg["enabled"], seq);
        else if (cmd == "song.speed")    p.setSpeed ((double) msg["speed"]);
        else if (cmd == "song.pitch")    p.setPitchRatio ((double) msg["ratio"]);
        else if (cmd == "song.volume")
        {
            if (msg.hasProperty ("song"))   p.setSongVolume ((float) (double) msg["song"]);
            if (msg.hasProperty ("master")) p.setMasterVolume ((float) (double) msg["master"]);
        }
        else if (cmd == "song.returnToStart") p.setReturnToStart ((bool) msg["enabled"]);
        else if (cmd == "song.metronome")     p.setMetronome ((bool) msg["enabled"], (float) (double) msg["volume"]);
        else if (cmd == "song.beats")         p.setBeats (toDoubles (msg["times"]), toBools (msg["accents"]));
        else if (cmd == "song.lightweight")   p.setLightweight ((bool) msg["enabled"]);
        else if (cmd == "song.cuts")
        {
            std::vector<std::pair<double, double>> regions;
            if (auto* arr = msg["regions"].getArray())
                for (auto& r : *arr)
                    regions.emplace_back ((double) r["start"], (double) r["end"]);
            p.setCuts (std::move (regions));
        }
        else
            return false;
        juce::ignoreUnused (error);
        if (result.isVoid())
            result = true;
        return true;
    }
}

//==============================================================================
class StdinReader : public juce::Thread
{
public:
    explicit StdinReader (std::function<void (juce::String)> handler)
        : Thread ("stdin"), onLine (std::move (handler)) {}

    void run() override
    {
        std::string line;
        while (! threadShouldExit() && std::getline (std::cin, line))
        {
            juce::MessageManager::callAsync ([this, l = juce::String::fromUTF8 (line.c_str())] { onLine (l); });
        }

        // The host closed our stdin (or died): shut down cleanly.
        juce::MessageManager::callAsync ([] { juce::JUCEApplicationBase::quit(); });
    }

private:
    std::function<void (juce::String)> onLine;
};

//==============================================================================
class EngineApplication : public juce::JUCEApplication,
                          private juce::Timer
{
public:
    const juce::String getApplicationName() override    { return "NotaEngine"; }
    const juce::String getApplicationVersion() override { return JUCE_APPLICATION_VERSION_STRING; }
    bool moreThanOneInstanceAllowed() override          { return true; }

    void initialise (const juce::String&) override
    {
        Protocol::init();

        const auto args = getCommandLineParameterArray();
        if (args.contains ("--render"))
        {
            const auto idx = args.indexOf ("--render");
            setApplicationReturnValue (runRender (args[idx + 1], args[idx + 2]) ? 0 : 1);
            quit();
            return;
        }

        if (args.contains ("--list") || args.contains ("--describe"))
        {
            runScanCommand (args);
            setApplicationReturnValue (0);
            quit();
            return;
        }

        engine = std::make_unique<AudioEngine>();
        engine->onEditorClosed = [] (const juce::String& slotId)
        {
            auto p = obj();
            p->setProperty ("slotId", slotId);
            Protocol::sendEvent ("editorClosed", p);
        };

        reader = std::make_unique<StdinReader> ([this] (juce::String line) { handleLine (line); });
        reader->startThread();

        auto p = obj();
        p->setProperty ("version", getApplicationVersion());
        p->setProperty ("formats", [this] {
            juce::Array<juce::var> names;
            for (auto* f : engine->getFormatManager().getFormats())
                names.add (f->getName());
            return juce::var (names);
        }());
        p->setProperty ("device", engine->getDeviceState());
        Protocol::sendEvent ("ready", p);

        startTimerHz (60);
    }

    void shutdown() override
    {
        stopTimer();
        if (reader != nullptr)
            reader->signalThreadShouldExit();
        engine.reset();
        // The reader may be blocked in getline; the process is exiting anyway.
        if (reader != nullptr)
            reader->stopThread (100);
    }

    void systemRequestedQuit() override { quit(); }
    void anotherInstanceStarted (const juce::String&) override {}

private:
    void timerCallback() override
    {
        if (engine == nullptr)
            return;
        auto& song = engine->getSongPlayer();
        song.housekeeping();
        const auto captured = engine->finishCapture();
        if (captured.isNotEmpty())
        {
            auto p = obj();
            p->setProperty ("path", captured);
            Protocol::sendEvent ("captureDone", p);
        }
        // Song position at 60 Hz while playing (the UI interpolates between reports).
        if (song.wantsSnapshot())
            Protocol::sendEvent ("transport", song.takeSnapshot (engine->getOutputLatencySeconds(), engine->snapshotBlocksAhead()));

        if ((++tick % 2) != 0)
            return;
        Protocol::sendEvent ("meters", engine->takeMeterSnapshot());
        // Pitch at 15 Hz while the tuner is open.
        if (engine->isTunerEnabled() && (tick % 4) == 0)
            Protocol::sendEvent ("tuner", engine->detectPitch());
    }

    //==========================================================================
    // Offline rendering: the real song path, driven by a script instead of a
    // device. Used to check sample accuracy (and to listen to the stretcher)
    // without speakers or a microphone anywhere near it.
    //
    // Script: { sampleRate, blockSize, seconds, commands: [{ at: <seconds of output>, cmd, ...args }] }
    // Writes the output as 32-bit float WAV, and one JSON line per block to
    // stdout with the transport snapshot ({ frame, position, state, ... }).
    bool runRender (const juce::String& scriptPath, const juce::String& outPath)
    {
        juce::var script;
        if (juce::JSON::parse (juce::File (scriptPath).loadFileAsString(), script).failed())
        {
            std::cerr << "Could not read the render script" << std::endl;
            return false;
        }
        const double sr = script.hasProperty ("sampleRate") ? (double) script["sampleRate"] : 48000.0;
        const int block = script.hasProperty ("blockSize") ? (int) script["blockSize"] : 256;
        const auto total = (juce::int64) ((double) script["seconds"] * sr);
        const bool logBlocks = (bool) script["log"];

        SongPlayer player;
        player.prepare (sr, block);

        juce::Array<juce::var> commands;
        if (auto* list = script["commands"].getArray())
            commands = *list;
        int nextCommand = 0;

        juce::AudioBuffer<float> out (2, (int) total);
        out.clear();
        juce::AudioBuffer<float> blockBuf (2, block);

        for (juce::int64 pos = 0; pos < total; pos += block)
        {
            const double now = (double) pos / sr;
            while (nextCommand < commands.size() && (double) commands[nextCommand]["at"] <= now + 1e-9)
            {
                const auto& c = commands.getReference (nextCommand++);
                if (c["cmd"].toString() == "device.restart")
                {
                    // What a device change does: the callback stops, prepare runs again.
                    player.prepare (c.hasProperty ("sampleRate") ? (double) c["sampleRate"] : sr, block);
                    continue;
                }
                juce::var result;
                juce::String error;
                handleSongCommand (player, c["cmd"].toString(), c, result, error);
                if (c["cmd"].toString() == "song.load" || c["cmd"].toString() == "song.tracks")
                {
                    auto r = obj();
                    r->setProperty ("type", "loaded");
                    r->setProperty ("result", result);
                    Protocol::send (juce::var (r.get()));
                }
            }
            // A disk that is always fast enough, so the result is deterministic.
            player.waitUntilLoaded (5000);
            const int n = (int) juce::jmin<juce::int64> (block, total - pos);
            blockBuf.clear();
            player.process (blockBuf.getWritePointer (0), blockBuf.getWritePointer (1), n);
            out.copyFrom (0, (int) pos, blockBuf, 0, 0, n);
            out.copyFrom (1, (int) pos, blockBuf, 1, 0, n);
            player.housekeeping();

            if (logBlocks)
            {
                auto snap = player.takeSnapshot (0.0);
                snap->setProperty ("type", "block");
                snap->setProperty ("frame", (juce::int64) (pos + n));
                Protocol::send (juce::var (snap.get()));
            }
        }

        const juce::File outFile (outPath);
        outFile.deleteFile();
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::AudioFormatWriter> writer (wav.createWriterFor (new juce::FileOutputStream (outFile), sr, 2, 32, {}, 0));
        if (writer == nullptr)
            return false;
        writer->writeFromAudioSampleBuffer (out, 0, out.getNumSamples());
        return true;
    }

    //==========================================================================
    void runScanCommand (const juce::StringArray& args)
    {
        juce::AudioPluginFormatManager fm;
        fm.addDefaultFormats();

        auto result = obj();
        const bool isList = args.contains ("--list");
        const auto idx = args.indexOf (isList ? "--list" : "--describe");
        auto* format = findFormat (fm, args[idx + 1]);

        if (format == nullptr)
        {
            result->setProperty ("error", "Unsupported plugin format: " + args[idx + 1]);
            Protocol::send (juce::var (result.get()));
            return;
        }

        if (isList)
        {
            auto paths = args.size() > idx + 2 ? juce::FileSearchPath (args[idx + 2])
                                               : format->getDefaultLocationsToSearch();
            juce::Array<juce::var> ids;
            for (auto& id : format->searchPathsForPlugins (paths, true, true))
                ids.add (id);
            result->setProperty ("identifiers", ids);
        }
        else
        {
            juce::OwnedArray<juce::PluginDescription> found;
            format->findAllTypesForFile (found, args[idx + 2]);
            juce::Array<juce::var> list;
            for (auto* d : found)
                list.add (describeToVar (*d));
            result->setProperty ("plugins", list);
        }

        Protocol::send (juce::var (result.get()));
    }

    //==========================================================================
    void respond (const juce::var& id, const juce::var& result, const juce::String& error = {})
    {
        auto r = obj();
        r->setProperty ("type", "response");
        r->setProperty ("id", id);
        r->setProperty ("ok", error.isEmpty());
        if (error.isNotEmpty())
            r->setProperty ("error", error);
        else
            r->setProperty ("result", result);
        Protocol::send (juce::var (r.get()));
    }

    void handleLine (const juce::String& line)
    {
        if (line.trim().isEmpty() || engine == nullptr)
            return;

        juce::var msg;
        if (juce::JSON::parse (line, msg).failed() || ! msg.isObject())
            return;

        const auto id = msg["id"];
        const auto cmd = msg["cmd"].toString();
        auto& e = *engine;

        if (cmd.startsWith ("song."))
        {
            juce::var result;
            juce::String error;
            if (handleSongCommand (e.getSongPlayer(), cmd, msg, result, error))
                respond (id, result, error);
            else
                respond (id, {}, "Unknown command: " + cmd);
        }
        else if (cmd == "startTake")
        {
            const auto err = e.startTake (msg["path"].toString(), (double) msg["maxSeconds"]);
            respond (id, err.isEmpty(), err);
        }
        else if (cmd == "stopTake")
        {
            respond (id, e.stopTake());
        }
        else if (cmd == "captureOutput")
        {
            const auto err = e.startCapture (msg["path"].toString(), (double) msg["seconds"]);
            respond (id, err.isEmpty(), err);
        }
        else if (cmd == "getDeviceState")
        {
            respond (id, e.getDeviceState());
        }
        else if (cmd == "setDevice")
        {
            const auto err = e.applyDeviceSetup (msg);
            respond (id, e.getDeviceState(), err);
        }
        else if (cmd == "showDeviceControlPanel")
        {
            e.showDeviceControlPanel();
            respond (id, e.getDeviceState());
        }
        else if (cmd == "setMonitoring")
        {
            e.setMonitoring ((bool) msg["enabled"]);
            respond (id, e.getDeviceState());
        }
        else if (cmd == "setInputTrim")
        {
            e.setInputTrimDb ((float) (double) msg["db"]);
            respond (id, true);
        }
        else if (cmd == "setOutputLevel")
        {
            e.setOutputLevelDb ((float) (double) msg["db"]);
            respond (id, true);
        }
        else if (cmd == "addPlugin")
        {
            e.addPlugin (msg["slotId"].toString(), msg["descriptionXml"].toString(),
                         msg.hasProperty ("index") ? (int) msg["index"] : -1,
                         msg["state"].toString(), (bool) msg["bypassed"], msg["chain"].toString() == "output",
                         [this, id] (ChainSlot* slot, const juce::String& error)
                         {
                             if (slot == nullptr)
                             {
                                 respond (id, {}, error);
                                 return;
                             }
                             auto r = obj();
                             r->setProperty ("slotId", slot->slotId);
                             r->setProperty ("name", slot->name);
                             r->setProperty ("hasEditor", slot->plugin->hasEditor());
                             r->setProperty ("latencySamples", slot->plugin->getLatencySamples());
                             respond (id, juce::var (r.get()));
                         });
        }
        else if (cmd == "setOutputIncludesBass")
        {
            e.setOutputIncludesBass ((bool) msg["include"]);
            respond (id, true);
        }
        else if (cmd == "removePlugin")
        {
            const auto ok = e.removePlugin (msg["slotId"].toString());
            respond (id, ok, ok ? juce::String() : "Unknown effect");
        }
        else if (cmd == "movePlugin")
        {
            const auto ok = e.movePlugin (msg["slotId"].toString(), (int) msg["index"]);
            respond (id, ok, ok ? juce::String() : "Unknown effect");
        }
        else if (cmd == "setBypass")
        {
            const auto ok = e.setBypassed (msg["slotId"].toString(), (bool) msg["bypassed"]);
            respond (id, ok, ok ? juce::String() : "Unknown effect");
        }
        else if (cmd == "setDarkWindows")
        {
            e.setDarkWindows ((bool) msg["dark"]);
            respond (id, true);
        }
        else if (cmd == "openEditor")
        {
            respond (id, true, e.openEditor (msg["slotId"].toString()));
        }
        else if (cmd == "getChainState")
        {
            respond (id, e.getChainState());
        }
        else if (cmd == "clearChain")
        {
            e.clearChain();
            respond (id, true);
        }
        else if (cmd == "setTuner")
        {
            e.setTuner ((bool) msg["enabled"], (bool) msg["mute"]);
            respond (id, true);
        }
        else if (cmd == "quit")
        {
            respond (id, true);
            quit();
        }
        else
        {
            respond (id, {}, "Unknown command: " + cmd);
        }
    }

    std::unique_ptr<AudioEngine> engine;
    std::unique_ptr<StdinReader> reader;
    int tick = 0;
};

START_JUCE_APPLICATION (EngineApplication)
