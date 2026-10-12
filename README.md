# TuffAudio

A modern audio editor in the spirit of Audacity, with a cleaner, faster workflow:

- **Top-to-bottom timeline.** Time runs down the screen, and each track is a column. The scroll wheel moves through time, `Shift`+scroll moves across tracks, and `Ctrl/⌘`+scroll zooms. Drag a track's header sideways to move the track, drag a column's right edge to resize it, or drag the divider next to the side panel to resize the panel. Click a track name to select the track, and double-click it to rename the track. The follow button (`F`) turns auto-scroll during playback on or off, and Settings (the gear icon) has switches for smooth animations and quick presets. TuffAudio remembers these sizes and the window size.
- **Quick trimming.** Drag down a waveform, then **Trim** (keep it), **Delete**, **Silence**, **Fade in/out**, or **Auto-trim** silence from both ends in one click. Drag the edges of a selection to fine-tune it. Undo/redo covers everything.
- **Recording from anywhere.** Record a microphone, a line input, **desktop/system audio**, or **desktop + mic together**. You can record in mono or stereo. Existing tracks play while you record, so you can overdub.
- **One-click mono ⇄ stereo.** Mix to mono (or keep only left or right), copy mono to both sides, swap L/R, split a stereo track into two mono tracks, or join two mono tracks into stereo. Export to mono or stereo.
- **Non-destructive effects, like Blender's modifiers.** Each track has an effect stack. You can reorder it by dragging, toggle effects on and off, collapse them, duplicate them and reset them. Nothing touches your audio until you press **Apply** on one effect, on all of them, or on just the selection. The waveform shows the processed result live (press `V` to switch views).
- **18 built-in effects:** Gain, Fade In, Fade Out, Normalize, Compressor, Limiter, Noise Gate, Equalizer, Filter, Reverb, Echo/Delay, Chorus, Distortion, Lo-Fi, Tremolo, Pan, Stereo Width and Reverse. There are also one-click presets (Voice Clean-up, Podcast Polish, Telephone, Lo-fi Tape and Big Hall). They're off by default; turn them on under Settings (the gear icon).
- **Modern UI.** Dark glass theme, animated transport, GPU-friendly canvas waveforms that zoom down to individual samples, a command palette (`Ctrl/⌘+K`), drag-and-drop import, toasts and a live output meter.
- **Projects and export.** Save and reopen `.tuff` projects; effect stacks stay editable after a save. Export to **MP3, WAV, OGG (Vorbis), FLAC, Opus or AIFF**, in mono or stereo, for the whole project or just the selection.

## Getting started

**Windows:** download [`TuffAudio.exe`](https://github.com/KevinIsNotSeven/TuffAudio/releases/latest/download/TuffAudio.exe) and double-click it. There's nothing to install. Windows may show a "Windows protected your PC" warning because the app isn't code-signed. Click **More info → Run anyway**.

**From source:**

```bash
npm install
npm start          # launches the desktop app (Electron)
```

Other scripts:

```bash
npm test           # DSP / file-format unit tests (Node's built-in test runner)
npm run web        # runs the same UI in a browser at http://localhost:5173
npm run dist:win   # builds dist/TuffAudio.exe (portable, no install needed)
npm run dist       # builds for the current platform with electron-builder
```

## Recording desktop audio

| Platform | How it works |
| --- | --- |
| **Windows** | Pick **System audio** in the *Record from* menu. TuffAudio uses WASAPI loopback, so no extra setup is needed. |
| **macOS** | Pick **System audio**. This needs a recent macOS, and you must allow Screen & System Audio Recording in System Settings the first time. A virtual loopback device such as BlackHole also works. It shows up under *Desktop audio* automatically. |
| **Linux** | Pick a **"Monitor of …"** input. PulseAudio and PipeWire expose your speakers as a monitor source, and TuffAudio lists these under *Desktop audio*. |

Microphones and line inputs are recorded raw, with echo cancellation, noise suppression and auto-gain turned off. That keeps instruments and line-level sources clean.

## Keyboard shortcuts

| Action | Keys |
| --- | --- |
| Play / pause | `Space` |
| Record | `R` |
| Loop | `L` |
| Trim to selection | `Ctrl/⌘+T` |
| Delete selection | `Delete` / `Backspace` |
| Cut / copy / paste | `Ctrl/⌘+X / C / V` |
| Silence selection | `Ctrl/⌘+L` |
| Selection → new track | `Ctrl/⌘+D` |
| Auto-trim silence | `Ctrl/⌘+Shift+T` |
| Undo / redo | `Ctrl/⌘+Z` / `Ctrl/⌘+Shift+Z` |
| Zoom in / out / fit | `=` / `-` / `Ctrl/⌘+0` |
| Auto-scroll on/off | `F` |
| Command palette | `Ctrl/⌘+K` |
| All shortcuts | `?` |

On the mouse: drag down a waveform to select, double-click to select a whole track, and `Shift`+click to extend the selection. Scroll moves through time, `Ctrl/⌘`+scroll zooms, and `Shift`+scroll moves across tracks. While looping, moving or resizing the selection updates the loop as it plays. Double-click any slider to reset it.

## How it's built

Electron plus the Web Audio API, written as plain ES modules with no bundler or framework.

```
src/main/            Electron main process (app:// protocol, loopback capture, save dialogs)
src/renderer/
  index.html, styles.css
  js/main.js         UI bootstrap: toolbar, shortcuts, record-source picker, palette
  js/actions.js      Every command (toolbar, menus, shortcuts and palette all share these)
  js/state.js        Project state, event bus, snapshot-based undo
  js/audio/
    effects.js       Effect definitions: realtime Web Audio graphs or sample processors
    engine.js        Playback, live effect updates, offline rendering, export mixdown
    recorder.js      Mic / line / desktop / mixed capture through an AudioWorklet
  js/dsp/            Pure functions: editing, analysis, WAV/FLAC/AIFF/Ogg writers, .tuff format
  js/audio/exporters.js  Export formats (MP3/Ogg Vorbis via bundled WebAssembly, Opus via WebCodecs)
  vendor/            wasm-media-encoders (MIT): LAME MP3 + libvorbis compiled to WebAssembly
  js/ui/             Timeline (canvas waveforms), inspector (effect stack), widgets
test/                Unit tests for the DSP and file formats
```

Design notes:

- Audio is stored as immutable `Float32Array` channels. Every edit creates new arrays, so an undo snapshot only holds references and costs almost nothing.
- Effects come in two kinds. **Live** effects are Web Audio node graphs, so slider moves are heard instantly during playback. **Render** effects are sample-domain processors (Normalize, Noise Gate, Lo-Fi, Reverse). TuffAudio pre-renders everything up to the last render effect and runs the rest live.
- Playback, the waveform preview, **Apply** and **Export** all go through the same effect definitions, so what you hear is exactly what gets baked.
