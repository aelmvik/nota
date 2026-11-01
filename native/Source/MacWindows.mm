// macOS only: plugin windows in Nøta's theme (see MacWindows.h).
#import <AppKit/AppKit.h>

#include "MacWindows.h"

void setMacWindowTheme (void* view, bool dark, int backgroundRgb)
{
    NSWindow* window = [(NSView*) view window];
    if (window == nil)
        return;
    window.appearance = [NSAppearance appearanceNamed: dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
    // A transparent title bar shows the window's background: Nøta's own colour, not the system's grey.
    window.titlebarAppearsTransparent = backgroundRgb >= 0;
    if (backgroundRgb >= 0)
        window.backgroundColor = [NSColor colorWithSRGBRed: ((backgroundRgb >> 16) & 0xff) / 255.0
                                                     green: ((backgroundRgb >> 8) & 0xff) / 255.0
                                                      blue: (backgroundRgb & 0xff) / 255.0
                                                     alpha: 1.0];
}
