#pragma once

#include <string>

// What Windows knows about an audio endpoint that JUCE doesn't expose: what
// kind of device it is and how it's connected. Device names are in the
// system's language ("Mikrofonijono", "Haut-parleurs"), so these are what
// tell a microphone from an interface's line input.

struct WindowsEndpoint
{
    bool found = false;
    /** Connected over Bluetooth */
    bool bluetooth = false;
    /** EndpointFormFactor: 1 speakers, 2 line level, 3 headphones, 4 microphone, 5 headset, … */
    int formFactor = -1;

    bool isMicrophone() const { return formFactor == 4 || formFactor == 5; }
    bool isSpeakers() const   { return formFactor == 1; }
};

/** The active endpoint with this name (as WASAPI lists it), on the input or output side. */
WindowsEndpoint findWindowsEndpoint (const std::wstring& name, bool input);
