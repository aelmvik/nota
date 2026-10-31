#pragma once

#include <juce_core/juce_core.h>

// Line-delimited JSON over a private copy of stdout.
//
// At startup the original stdout file descriptor is duplicated for the
// protocol and fd 1 is redirected to stderr, so anything a hosted plugin
// prints with printf/std::cout can never corrupt the protocol stream.
namespace Protocol
{
    void init();
    void send (const juce::var& message);
    void sendEvent (const juce::String& type, juce::DynamicObject::Ptr payload);
}
