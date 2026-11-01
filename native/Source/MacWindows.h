#pragma once

/** A plugin window in Nøta's light or dark theme, whatever the Mac is set to (the engine
    is a separate app, which would follow the system), with its title bar in Nøta's
    background colour (0xRRGGBB; -1 keeps the system's). `view` is JUCE's window handle. */
void setMacWindowTheme (void* view, bool dark, int backgroundRgb);
