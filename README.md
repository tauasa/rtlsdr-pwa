# rtlsdr-pwa — SDR receiver progressive web app

A browser port of the [rtlsdr-fx](https://github.com/tauasa/rtlsdr-fx) desktop receiver: live **spectrum**, scrolling **waterfall**, and **WFM / NFM / AM audio**, all decoded in pure JavaScript. Installable as a Progressive Web App and fully usable offline in Simulated mode.

## Two sources

Browsers can't open raw TCP sockets, so the app mirrors the desktop's two sources in a browser-native way:

1. **Simulated** — a wideband-FM "station" generated entirely in the browser (a 440 + 660 Hz tone modulating an FM carrier at band centre, plus two faint carriers and a noise floor). Needs no hardware, no server, and works offline. This is the headline mode and what the install demo runs on.
2. **RTL-TCP (WebSocket)** — streams real IQ from an `rtl_tcp` server. Because the page can only speak WebSocket, a small bridge forwards WebSocket ↔ TCP (see below).

All DSP runs client-side: the FFT and the audio demodulator live in a **Web Worker**, and audio plays through an **AudioWorklet**, so the UI stays smooth.

## Running it

A service worker, module/worker scripts, and the AudioWorklet all require a **secure context**, so the app must be served over `http://` (or `https://`) — opening `index.html` from `file://` will not work.

From the project folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

(Any static file server works — `npx serve`, nginx, etc.)

### Simulated mode

1. Leave **Source** on *Simulated*.
2. Click **Connect** — the spectrum and waterfall come alive, with the FM station centred under the amber tuning marker.
3. Click **Audio**, pick **Wideband FM**, and raise **Volume** to hear the tone.

### Real hardware (RTL-TCP over WebSocket)

On the machine with the dongle:

```bash
rtl_tcp -a 0.0.0.0 -p 1234                 # start the rtl_tcp server
websockify 8073 localhost:1234             # bridge WebSocket :8073 -> TCP :1234
```

`websockify` (from the [websockify](https://github.com/novnc/websockify) project, `pip install websockify`) passes the raw `rtl_tcp` byte stream straight through, so the app speaks the real protocol — it reads the 12-byte header and the uint8 IQ stream and
sends the standard 5-byte big-endian commands.

Then in the app:

1. Set **Source** to *RTL-TCP (WebSocket)* and point **Bridge URL** at the bridge (`ws://localhost:8073`, or the bridge host's address).
2. Set **Freq**, **Rate**, and **Gain**, then **Connect**.

## Listening

The signal at the **centre** of the captured band is demodulated, so tune the dongle directly onto the station. Pick **Mode** (`WFM` for broadcast FM, `NFM` for narrowband FM, `AM`), toggle **Audio**, and set **Volume**. The dashed amber line marks the demodulated point. Audio is resampled to the browser's audio rate automatically.

## Installing

When the browser offers it, an **Install** button appears in the top bar (or use the browser's own install action). Once installed it launches in its own window and the Simulated receiver keeps working with no network.

## Files

| File | Role |
|------|------|
| `index.html` / `styles.css` | App shell and dark instrument-console theme. |
| `app.js` | UI, spectrum + waterfall rendering, Web Audio, worker control. |
| `dsp.js` | Pure DSP: FFT, FIRs, spectrum, WFM/NFM/AM demodulator (also unit-testable under Node). |
| `dsp-worker.js` | Source handling (simulated + WebSocket) and DSP, off the main thread. |
| `pcm-player-processor.js` | AudioWorklet that plays the demodulated audio. |
| `manifest.webmanifest` / `sw.js` | PWA manifest and offline app-shell cache. |
| `icons/` | App icons (192, 512, maskable). |

## Notes & limitations

- A browser tab can't reach a raw TCP port; the `websockify` bridge is what makes real hardware possible. There is no "Exit" control as on the desktop app — close the tab or window; Settings and About live in the top bar instead.
- Channel selectivity is intentionally simple (the dongle is assumed tuned onto the station); the focus is a faithful, lightweight port of the desktop receiver.
- Sample rates are capped by what JavaScript can comfortably process in real time; the defaults are tuned for smooth in-browser performance.

Copyright © 2026 Tauasa Timoteo · MIT License.