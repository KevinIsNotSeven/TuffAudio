# TuffAudio

A modern audio editor in the spirit of Audacity, with a cleaner, faster workflow:

- **Top-to-bottom timeline.** Time runs down the screen, and each track is a column you can drag to any position left or right. The scroll wheel moves through time, `Shift`+scroll moves across tracks, and `Ctrl/⌘`+scroll zooms. Each track's background shows where its audio starts and ends. Click a track name to select it, double-click to rename it, and right-click the header (or press ⋯) for Duplicate, Split, and Convert to mono or stereo. The volume and pan sliders snap to 0 dB and centre. Drag a column's right edge or the side-panel divider to resize them.
- **Quick trimming.** Drag down a waveform, then use **Trim** (keep the selection), **Delete**, **Silence** or **Auto-trim** (remove silence from both ends). Drag the edges of a selection to fine-tune it. Undo and redo cover everything.
- **Recording from anywhere.** Record a microphone, a line input, **desktop/system audio**, or **desktop + mic together**. You can record in mono or stereo. Existing tracks play while you record, so you can overdub.
- **One-click mono ⇄ stereo.** Mix to mono (or keep only left or right), copy mono to both sides, swap L/R, split a stereo track into two mono tracks, or join two mono tracks into stereo. Export to mono or stereo.
- **Non-destructive effects, like Blender's modifiers.** Every effect has its own **start and end time**. It appears as a coloured bar beside the waveform: drag the bar's ends to change when it starts and stops, double-click an end to send it to the start or end of the track, and click the bar to open its editor. Right-click a waveform to add an effect to the selection or the whole track. Effects stay editable until you **Apply** them, and the waveform previews the result live (`V` switches between the processed and original waveform).
- **18 built-in effects:** Gain, Fade In, Fade Out, Normalize, Compressor, Limiter, Noise Gate, Equalizer, Filter, Reverb, Echo/Delay, Chorus, Distortion, Lo-Fi, Tremolo, Pan, Stereo Width and Reverse. There are also one-click presets (Voice Clean-up, Podcast Polish, Telephone, Lo-fi Tape and Big Hall). They're off by default; turn them on under Settings (the gear icon).
- **Modern UI.** Five themes (Tuff, Midnight, OLED Black, Sunset, Forest), smooth animations (can be turned off), customisable **keybinds**, a built-in **Check for updates**, a command palette (`Ctrl/⌘+K`), drag-and-drop import and a live output meter. TuffAudio also remembers your last recording source.
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

These are the defaults. You can change any of them in **Settings → Keybinds**.

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
| Save / Save as | `Ctrl/⌘+S` / `Ctrl/⌘+Shift+S` |
| Keybinds (view and change) | `?` |

On the mouse: drag down a waveform to select, double-click to select a whole track, `Shift`+click to extend the selection, and right-click a waveform to add an effect. Scroll moves through time, `Ctrl/⌘`+scroll zooms, and `Shift`+scroll moves across tracks. While looping, moving or resizing the selection updates the loop as it plays. Double-click any slider to reset it.

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
