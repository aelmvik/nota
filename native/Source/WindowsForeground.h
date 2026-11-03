#pragma once

/** A dark or light title bar, to match Nøta's theme (Windows draws it light unless asked),
    in Nøta's background colour (0xRRGGBB) where Windows allows it (Windows 11); -1 keeps Windows' own. */
void setTitleBarTheme (void* hwnd, bool dark, int captionRgb);
