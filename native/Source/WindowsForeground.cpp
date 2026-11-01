// Windows only (see CMakeLists.txt). Kept apart from the JUCE sources so the
// Windows headers don't meet JUCE's.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <dwmapi.h>

#include "WindowsForeground.h"

void setTitleBarTheme (void* handle, bool dark, int captionRgb)
{
    const auto hwnd = (HWND) handle;
    if (hwnd == nullptr)
        return;
    // DWMWA_USE_IMMERSIVE_DARK_MODE: 20 on Windows 11 and recent Windows 10, 19 before that.
    const BOOL value = dark ? TRUE : FALSE;
    if (FAILED (DwmSetWindowAttribute (hwnd, 20, &value, sizeof (value))))
        DwmSetWindowAttribute (hwnd, 19, &value, sizeof (value));
    // DWMWA_CAPTION_COLOR (Windows 11; older versions refuse it and keep their own).
    const COLORREF caption = captionRgb < 0 ? 0xFFFFFFFF // DWMWA_COLOR_DEFAULT
                                            : RGB ((captionRgb >> 16) & 0xff, (captionRgb >> 8) & 0xff, captionRgb & 0xff);
    DwmSetWindowAttribute (hwnd, 35, &caption, sizeof (caption));
}

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
