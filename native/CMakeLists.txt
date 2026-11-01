cmake_minimum_required(VERSION 3.22)

project(NotaEngine VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")
# Windows: link Microsoft's C++ runtime into the engine (and JUCE), so it runs on
# PCs without the Visual C++ Redistributable instead of failing to start.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_subdirectory(third_party/JUCE)

# A GUI app (not a console app) because plugin editors need a native
# message loop and windows. LSUIElement keeps it out of the Dock: the
# Electron app owns the user-facing UI.
juce_add_gui_app(NotaEngine
    PRODUCT_NAME "NotaEngine"
    COMPANY_NAME "Nota"
    BUNDLE_ID "app.nota.engine"
    # Same icon as the app, for activity monitors that list the engine process
    ICON_BIG "${CMAKE_CURRENT_SOURCE_DIR}/../build/icon.png"
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "Nøta needs audio input access to monitor your bass."
    PLIST_TO_MERGE "<plist><dict><key>LSUIElement</key><true/></dict></plist>")

target_sources(NotaEngine PRIVATE
    Source/Main.cpp
    Source/AudioEngine.cpp
    Source/SongPlayer.cpp
    Source/Protocol.cpp)

# Signalsmith Stretch (MIT, header-only) for slow-down and key change, with
# its FFT library; both are cloned by `npm run engine:build`.
target_include_directories(NotaEngine SYSTEM PRIVATE
    third_party/signalsmith-stretch/include
    third_party/signalsmith-linear/include)

target_compile_definitions(NotaEngine PRIVATE
    JUCE_PLUGINHOST_VST3=1
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:NotaEngine,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:NotaEngine,JUCE_VERSION>")

target_link_libraries(NotaEngine
    PRIVATE
        juce::juce_audio_utils
        juce::juce_audio_processors
        juce::juce_audio_devices
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)

# macOS only: Audio Unit hosting and Apple's Accelerate for the stretcher's FFT.
# Elsewhere the stretcher uses its own portable FFT.
if(APPLE)
    target_compile_definitions(NotaEngine PRIVATE
        JUCE_PLUGINHOST_AU=1
        SIGNALSMITH_USE_ACCELERATE=1
        ACCELERATE_NEW_LAPACK=1)
    target_link_libraries(NotaEngine PRIVATE "-framework Accelerate")
endif()

# Windows: what kind of device each audio endpoint is (microphone, speakers, Bluetooth).
if(WIN32)
    target_sources(NotaEngine PRIVATE Source/WindowsDevices.cpp)
    target_link_libraries(NotaEngine PRIVATE ole32)
endif()

# Windows: ASIO, from Steinberg's ASIO SDK (used under its GPLv3 option), which
# scripts/build-engine.mjs fetches and passes in.
if(WIN32 AND NOTA_ASIO_SDK)
    target_compile_definitions(NotaEngine PRIVATE JUCE_ASIO=1)
    target_include_directories(NotaEngine PRIVATE "${NOTA_ASIO_SDK}/common")
endif()

# Linux: JACK beside ALSA, the low-latency route (PipeWire's JACK on desktops).
# JUCE loads libjack at runtime, so the engine still starts without it.
if(UNIX AND NOT APPLE)
    target_compile_definitions(NotaEngine PRIVATE JUCE_JACK=1)
endif()

# MSVC reads sources in the system code page unless told otherwise; ours are UTF-8.
if(MSVC)
    target_compile_options(NotaEngine PRIVATE /utf-8)
endif()
