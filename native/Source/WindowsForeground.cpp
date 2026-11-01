// Windows only (see CMakeLists.txt). Kept apart from the JUCE sources so the
// Windows headers don't meet JUCE's.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include "WindowsForeground.h"

void bringToForeground (void* handle)
{
    const auto hwnd = (HWND) handle;
    if (hwnd == nullptr || SetForegroundWindow (hwnd))
        return;

    // Windows only lets the app in front hand the foreground over, and the engine
    // runs behind Nøta's window. Sharing the front app's input state for a moment
    // counts as that, the usual way for a helper process to show a window someone
    // asked for.
    const auto front = GetForegroundWindow();
    const auto frontThread = front != nullptr ? GetWindowThreadProcessId (front, nullptr) : 0;
    const auto thisThread = GetCurrentThreadId();
    if (frontThread == 0 || frontThread == thisThread || ! AttachThreadInput (thisThread, frontThread, TRUE))
        return;
    BringWindowToTop (hwnd);
    SetForegroundWindow (hwnd);
    AttachThreadInput (thisThread, frontThread, FALSE);
}
