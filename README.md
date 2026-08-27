# Reactor Control Room

A reactor control room simulation: control rods, coolant loops, pressurizer, turbine and emergency systems of a pressurized water reactor — as a browser game, Android app and Windows desktop app, all running the same game engine.

Goal: generate as much energy as possible over one shift without endangering the plant. Xenon poisoning, loss of coolant, pump failures and grid outages occur at random and need to be recognized and handled. Mishandle the plant — or override the reactor protection system — and a genuine meltdown is possible.

## Play

Ready-to-run builds live in [`releases/`](releases/):

| Platform | File | Note |
|---|---|---|
| Android | `reactor-control-panel-android-v1.0.apk` | Debug-signed, installs directly (allow unknown sources) |
| Windows | `reactor-control-panel-windows-v1.0.exe` | Portable version, no installation needed. Unsigned — a SmartScreen warning on first launch is expected ("More info" → "Run anyway") |
| Web | [`game/`](game/) | Any static web server, see below |

A detailed player's handbook (controls, gauges, incidents, first shift walkthrough) lives at [`docs/Reactor_Handbook.docx`](docs/Reactor_Handbook.docx).

## Project structure

```
game/           The actual game engine + UI (plain HTML/CSS/JS, no dependencies)
  js/engine.js    Reactor physics: reactivity, xenon/iodine poisoning, thermal, pressure
  js/events.js    Random incidents (pump failure, grid outage, LOCA, sensor fault, ...)
  js/render.js    Canvas rendering: plant diagram + gauges
  js/main.js      Game loop, input, menus
  test/           Headless engine tests (plain Node, no browser needed)
android/        Capacitor-generated Android project (loads game/ in a WebView)
electron/       Electron main process for the Windows/desktop build (loads game/ in a window)
docs/           Player's handbook
resources/      App icon and splash screen (source for the Android and Windows builds)
releases/       Built APK and .exe
```

`game/` is the only place game logic lives — Android and Windows are just different wrappers around the same code.

## Development

Requirement: Node.js (tested with v22).

```bash
npm install
```

### Run the web version locally

```bash
cd game && python3 -m http.server 8933
# then in a browser: http://localhost:8933/index.html
```

### Tests

The engine has a headless test suite (checks reactor physics, incidents, score calculation — no browser required):

```bash
node game/test/headless.mjs
```

### Windows build (Electron)

```bash
npm run electron:start      # run the app in dev mode
npm run build:win           # build a portable .exe -> releases/electron-dist/
```

### Android build (Capacitor)

Additionally requires an Android SDK (`ANDROID_HOME`/`ANDROID_SDK_ROOT` set) with platform 34+ and build tools.

```bash
npm run sync:android         # copy game/ into android/
npm run build:apk:debug      # build a debug APK -> android/app/build/outputs/apk/debug/
```

## Tech stack

- **Game engine:** Vanilla JavaScript (ES modules), no frameworks, no runtime dependencies
- **Android:** [Capacitor](https://capacitorjs.com/) — loads `game/` in a native WebView
- **Windows:** [Electron](https://www.electronjs.org/) — loads `game/` in a native window
- **Rendering:** HTML5 Canvas (plant diagram + gauges), otherwise plain HTML/CSS

## License

Use-Restriction-License (All Rights Reserved with individual exceptions) — see [`LICENSE.md`](LICENSE.md).
