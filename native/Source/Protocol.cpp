#include "Protocol.h"

#include <cstdio>
#if JUCE_WINDOWS
 #include <fcntl.h>
 #include <io.h>
 #define NOMINMAX
 #define WIN32_LEAN_AND_MEAN
 #include <windows.h>
 #define dup _dup
 #define dup2 _dup2
 #define fdopen _fdopen
 #define STDOUT_FILENO 1
 #define STDERR_FILENO 2
#else
 #include <unistd.h>
#endif

namespace
{
    FILE* protocolOut = stdout;
    juce::CriticalSection writeLock;
}

void Protocol::init()
{
    fflush (stdout);
    const int protocolFd = dup (STDOUT_FILENO);

    if (protocolFd >= 0)
    {
       #if JUCE_WINDOWS
        _setmode (protocolFd, _O_BINARY); // "\n", not "\r\n", like everywhere else
       #endif
        if (auto* f = fdopen (protocolFd, "w"))
        {
            protocolOut = f;
            dup2 (STDERR_FILENO, STDOUT_FILENO);
           #if JUCE_WINDOWS
            // Code that writes to the Win32 handle rather than the C runtime's goes to stderr too.
            SetStdHandle (STD_OUTPUT_HANDLE, GetStdHandle (STD_ERROR_HANDLE));
           #endif
        }
    }
}

void Protocol::send (const juce::var& message)
{
    const auto line = juce::JSON::toString (message, true) + "\n";
    const juce::ScopedLock sl (writeLock);
    fputs (line.toRawUTF8(), protocolOut);
    fflush (protocolOut);
}

void Protocol::sendEvent (const juce::String& type, juce::DynamicObject::Ptr payload)
{
    if (payload == nullptr)
        payload = new juce::DynamicObject();

    payload->setProperty ("type", type);
    send (juce::var (payload.get()));
}
