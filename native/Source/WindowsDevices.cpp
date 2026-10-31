// Windows only (see CMakeLists.txt). Kept apart from the JUCE sources so the
// Windows headers don't meet JUCE's.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>

#include "WindowsDevices.h"

namespace
{
    // PKEY_Device_FriendlyName, PKEY_Device_EnumeratorName and PKEY_AudioEndpoint_FormFactor,
    // spelled out so nothing has to define the property keys.
    const PROPERTYKEY keyFriendlyName   { { 0xa45c254e, 0xdf1c, 0x4efd, { 0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0 } }, 14 };
    const PROPERTYKEY keyEnumeratorName { { 0xa45c254e, 0xdf1c, 0x4efd, { 0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0 } }, 24 };
    const PROPERTYKEY keyFormFactor     { { 0x1da5d803, 0xd492, 0x4edd, { 0x8c, 0x23, 0xe0, 0xc0, 0xff, 0xee, 0x7f, 0x0e } }, 0 };

    template <typename T>
    struct Com
    {
        T* p = nullptr;
        ~Com() { if (p != nullptr) p->Release(); }
        T** operator&() { return &p; }
        T* operator->() const { return p; }
    };

    struct Prop
    {
        PROPVARIANT v;
        Prop()  { PropVariantInit (&v); }
        ~Prop() { PropVariantClear (&v); }
        const wchar_t* text() const { return v.vt == VT_LPWSTR ? v.pwszVal : nullptr; }
    };
}

WindowsEndpoint findWindowsEndpoint (const std::wstring& name, bool input)
{
    WindowsEndpoint result;
    if (name.empty())
        return result;

    // The message thread already has COM (JUCE starts it); this only matters elsewhere.
    const auto init = CoInitializeEx (nullptr, COINIT_MULTITHREADED);

    Com<IMMDeviceEnumerator> enumerator;
    Com<IMMDeviceCollection> list;
    UINT count = 0;
    if (SUCCEEDED (CoCreateInstance (__uuidof (MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof (IMMDeviceEnumerator), (void**) &enumerator))
        && SUCCEEDED (enumerator->EnumAudioEndpoints (input ? eCapture : eRender, DEVICE_STATE_ACTIVE, &list))
        && SUCCEEDED (list->GetCount (&count)))
    {
        for (UINT i = 0; i < count && ! result.found; ++i)
        {
            Com<IMMDevice> device;
            Com<IPropertyStore> props;
            if (FAILED (list->Item (i, &device)) || FAILED (device->OpenPropertyStore (STGM_READ, &props)))
                continue;

            Prop friendly;
            if (FAILED (props->GetValue (keyFriendlyName, &friendly.v)) || friendly.text() == nullptr || name != friendly.text())
                continue;

            result.found = true;
            Prop bus, form;
            // The bus the device hangs off: HDAUDIO or INTELAUDIO built in, USB, or BTHENUM / BTHHFENUM / BTHLEDEVICE.
            if (SUCCEEDED (props->GetValue (keyEnumeratorName, &bus.v)) && bus.text() != nullptr)
                result.bluetooth = wcsncmp (bus.text(), L"BTH", 3) == 0;
            if (SUCCEEDED (props->GetValue (keyFormFactor, &form.v)) && form.v.vt == VT_UI4)
                result.formFactor = (int) form.v.ulVal;
        }
    }

    if (SUCCEEDED (init))
        CoUninitialize();
    return result;
}
