#pragma once

/** Brings a window of the engine's in front of the app in use (Nøta's window), as
    the Mac's Process::makeForegroundProcess() does; JUCE's is empty on Windows. */
void bringToForeground (void* hwnd);
