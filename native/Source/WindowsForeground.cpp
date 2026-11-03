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
