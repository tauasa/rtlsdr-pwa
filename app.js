/*
 * rtlsdr-pwa — main thread.
 * UI, canvas rendering (spectrum + waterfall), Web Audio playback, and control
 * of the DSP worker. Copyright (c) 2026 Tauasa Timoteo. MIT License.
 */
'use strict';

const REPO_URL = 'https://github.com/tauasa/rtlsdr-pwa';

// ---- waterfall palettes (mirrors the desktop Palette presets) ----
const PALETTES = {
  Classic: [[0,0,0],[0,0,80],[0,40,200],[0,200,220],[40,210,60],[240,230,40],[240,60,30],[255,255,255]],
  Inferno: [[0,0,4],[40,11,84],[101,21,110],[159,42,99],[212,72,66],[245,125,21],[250,193,39],[252,255,164]],
  Ice:     [[0,0,0],[0,10,40],[0,30,90],[0,70,150],[0,130,200],[80,190,230],[180,230,245],[255,255,255]],
  'Green (CRT)': [[0,0,0],[0,20,0],[0,60,0],[0,110,10],[0,170,20],[40,220,40],[150,245,90],[230,255,200]],
  Grayscale: [[0,0,0],[255,255,255]],
};

function lerpStops(stops, v) {
  if (v <= 0) return stops[0];
  if (v >= 1) return stops[stops.length - 1];
  const scaled = v * (stops.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0]-a[0])*f, a[1] + (b[1]-a[1])*f, a[2] + (b[2]-a[2])*f];
}

function buildLut(name) {
  const stops = PALETTES[name] || PALETTES.Classic;
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const c = lerpStops(stops, i / 255);
    lut[3*i] = c[0]; lut[3*i+1] = c[1]; lut[3*i+2] = c[2];
  }
  return lut;
}

// ---- state ----
const state = {
  connected: false,
  fftSize: 2048,
  sampleRate: 300000,
  centerFreq: 100000000,
  minDb: -100,
  maxDb: 0,
  traceColor: '#50c8ff',
  peakColor: '#5f697d',
  palette: 'Classic',
  lut: null,
  latestPower: null,
  latestCenter: 100000000,
  latestRate: 300000,
  powerSeq: 0,
  renderedSeq: -1,
  peak: null,
  fps: 0,
  frames: 0,
  fpsWindow: 0,
};
state.lut = buildLut(state.palette);

let worker = null;
let audioCtx = null;
let pcmNode = null;
let gainNode = null;
let installEvent = null;

// waterfall offscreen buffer (fftSize wide)
let wfCanvas = document.createElement('canvas');
let wfCtx = wfCanvas.getContext('2d');
let wfData = null;
const WF_ROWS = 360;

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const els = {};
['sourceSel','wsRow','wsUrl','freq','rate','autoGain','gain','mode','audioBtn',
 'volume','connectBtn','status','readout','spectrum','waterfall',
 'settingsBtn','aboutBtn','installBtn','settingsModal','aboutModal',
 'paletteSel','palettePreview','traceColor','peakColor','minDb','maxDb',
 'cwPitch','cwBandwidth','cwPitchVal','cwBandwidthVal',
 'settingsClose','aboutClose','resetColors','repoLink'].forEach((id) => els[id] = $(id));

// ---- worker ----
function initWorker() {
  worker = new Worker('dsp-worker.js');
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'spectrum') {
      state.latestPower = m.power;
      state.latestCenter = m.center;
      state.latestRate = m.sampleRate;
      state.powerSeq++;
      state.frames++;
    } else if (m.type === 'audio') {
      if (pcmNode) pcmNode.port.postMessage({ samples: m.samples }, [m.samples.buffer]);
    } else if (m.type === 'status') {
      els.status.textContent = m.text;
    }
  };
  worker.postMessage({
    type: 'config',
    fftSize: state.fftSize,
    sampleRate: state.sampleRate,
    centerFreq: state.centerFreq,
    audioRate: 48000,
    mode: els.mode.value,
    autoGain: els.autoGain.checked,
    gainTenthsDb: Math.round(parseFloat(els.gain.value) * 10),
    cwPitch: parseInt(els.cwPitch.value, 10),
    cwBandwidth: parseInt(els.cwBandwidth.value, 10),
  });
}

// ---- audio ----
async function enableAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.audioWorklet.addModule('pcm-player-processor.js');
    pcmNode = new AudioWorkletNode(audioCtx, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [1] });
    gainNode = audioCtx.createGain();
    pcmNode.connect(gainNode).connect(audioCtx.destination);
    worker.postMessage({ type: 'audioRate', rate: audioCtx.sampleRate });
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  gainNode.gain.value = parseFloat(els.volume.value);
  worker.postMessage({ type: 'audio', on: true });
}

function disableAudio() {
  worker.postMessage({ type: 'audio', on: false });
}

// ---- controls ----
function currentFreqHz() {
  const mhz = parseFloat(els.freq.value);
  return isNaN(mhz) ? state.centerFreq : Math.round(mhz * 1e6);
}

function connect() {
  state.sampleRate = parseInt(els.rate.value, 10);
  state.centerFreq = currentFreqHz();
  const source = els.sourceSel.value; // 'sim' | 'ws'
  worker.postMessage({
    type: 'start',
    source,
    wsUrl: els.wsUrl.value.trim(),
    sampleRate: state.sampleRate,
    centerFreq: state.centerFreq,
  });
  state.connected = true;
  els.connectBtn.textContent = 'Disconnect';
  els.connectBtn.classList.add('active');
  els.sourceSel.disabled = true;
  els.wsUrl.disabled = true;
  resetPeak();
}

function disconnect() {
  worker.postMessage({ type: 'stop' });
  state.connected = false;
  els.connectBtn.textContent = 'Connect';
  els.connectBtn.classList.remove('active');
  els.sourceSel.disabled = false;
  els.wsUrl.disabled = false;
}

function resetPeak() { state.peak = null; }

// ---- rendering ----
function resizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  return dpr;
}

function ensureWaterfallBuffer() {
  if (wfCanvas.width !== state.fftSize || wfCanvas.height !== WF_ROWS) {
    wfCanvas.width = state.fftSize;
    wfCanvas.height = WF_ROWS;
    wfData = wfCtx.createImageData(state.fftSize, WF_ROWS);
    wfData.data.fill(255);
    for (let i = 0; i < wfData.data.length; i += 4) {
      wfData.data[i] = 11; wfData.data[i+1] = 14; wfData.data[i+2] = 20;
    }
    wfCtx.putImageData(wfData, 0, 0);
  }
}

function pushWaterfallRow(power) {
  ensureWaterfallBuffer();
  const n = state.fftSize, stride = n * 4, data = wfData.data, lut = state.lut;
  const span = state.maxDb - state.minDb;
  data.copyWithin(stride, 0, data.length - stride); // scroll down one row
  for (let x = 0; x < n; x++) {
    let t = (power[x] - state.minDb) / span;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const li = (t * 255) | 0;
    const o = x * 4;
    data[o] = lut[3*li]; data[o+1] = lut[3*li+1]; data[o+2] = lut[3*li+2]; data[o+3] = 255;
  }
  wfCtx.putImageData(wfData, 0, 0);
}

function withAlpha(hex, a) {
  const v = hex.replace('#','');
  const r = parseInt(v.substring(0,2),16), g = parseInt(v.substring(2,4),16), b = parseInt(v.substring(4,6),16);
  return `rgba(${r},${g},${b},${a})`;
}

function drawSpectrum() {
  const c = els.spectrum, dpr = resizeCanvas(c), g = c.getContext('2d');
  const w = c.width, h = c.height;
  g.setTransform(1,0,0,1,0,0);
  g.fillStyle = '#0a0d13';
  g.fillRect(0, 0, w, h);
  const power = state.latestPower;
  const { minDb, maxDb } = state;
  const span = maxDb - minDb;
  const dbToY = (db) => { let t = (db - minDb) / span; if (t<0) t=0; else if (t>1) t=1; return h - t*h; };

  g.lineWidth = 1 * dpr;
  g.font = `${10*dpr}px ui-monospace, Menlo, Consolas, monospace`;
  g.textBaseline = 'bottom';

  // dB grid
  const dbLines = 6;
  for (let i = 0; i <= dbLines; i++) {
    const db = maxDb - span * i / dbLines;
    const y = dbToY(db);
    g.strokeStyle = '#1b212c';
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    g.fillStyle = '#5b6678';
    g.fillText(db.toFixed(0), 3*dpr, y - 2*dpr);
  }
  // frequency grid
  const fdiv = 8;
  const center = state.latestCenter, rate = state.latestRate;
  for (let i = 0; i <= fdiv; i++) {
    const x = w * i / fdiv;
    g.strokeStyle = '#1b212c';
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    const fHz = center + ((i / fdiv) - 0.5) * rate;
    g.fillStyle = '#5b6678';
    g.fillText((fHz/1e6).toFixed(3), Math.min(x + 2*dpr, w - 40*dpr), h - 3*dpr);
  }

  if (power) {
    const n = power.length;
    // peak hold
    if (!state.peak || state.peak.length !== n) { state.peak = new Float32Array(n); state.peak.fill(minDb); }
    const peak = state.peak;
    for (let i = 0; i < n; i++) { const d = peak[i] - 0.25; peak[i] = d > power[i] ? d : power[i]; }
    g.strokeStyle = state.peakColor; g.lineWidth = 1*dpr; g.beginPath();
    for (let i = 0; i < n; i++) { const x = w*i/(n-1), y = dbToY(peak[i]); i===0?g.moveTo(x,y):g.lineTo(x,y); }
    g.stroke();
    // filled live trace
    g.beginPath(); g.moveTo(0, h);
    for (let i = 0; i < n; i++) g.lineTo(w*i/(n-1), dbToY(power[i]));
    g.lineTo(w, h); g.closePath();
    g.fillStyle = withAlpha(state.traceColor, 0.25); g.fill();
    g.strokeStyle = state.traceColor; g.lineWidth = 1.3*dpr; g.beginPath();
    for (let i = 0; i < n; i++) { const x = w*i/(n-1), y = dbToY(power[i]); i===0?g.moveTo(x,y):g.lineTo(x,y); }
    g.stroke();
  }
  // tuned-centre marker (we demodulate the centre of the band)
  g.strokeStyle = withAlpha('#ffb454', 0.7); g.setLineDash([4*dpr, 4*dpr]); g.lineWidth = 1*dpr;
  g.beginPath(); g.moveTo(w/2, 0); g.lineTo(w/2, h); g.stroke(); g.setLineDash([]);
}

function drawWaterfall() {
  const c = els.waterfall, dpr = resizeCanvas(c), g = c.getContext('2d');
  g.setTransform(1,0,0,1,0,0);
  g.fillStyle = '#0a0d13'; g.fillRect(0, 0, c.width, c.height);
  ensureWaterfallBuffer();
  g.imageSmoothingEnabled = false;
  g.drawImage(wfCanvas, 0, 0, state.fftSize, WF_ROWS, 0, 0, c.width, c.height);
}

function renderLoop(now) {
  if (state.powerSeq !== state.renderedSeq && state.latestPower) {
    state.renderedSeq = state.powerSeq;
    pushWaterfallRow(state.latestPower);
  }
  drawSpectrum();
  drawWaterfall();

  if (now - state.fpsWindow >= 1000) {
    state.fps = state.frames * 1000 / (now - state.fpsWindow);
    state.frames = 0; state.fpsWindow = now;
    updateReadout();
  }
  requestAnimationFrame(renderLoop);
}

function updateReadout() {
  const f = (state.latestCenter / 1e6).toFixed(4);
  const sr = (state.latestRate / 1e6).toFixed(3);
  els.readout.textContent =
    `${f} MHz · ${sr} Msps · FFT ${state.fftSize} · ${els.mode.value} · ${state.fps.toFixed(0)} fps`;
}

// ---- settings / about ----
function drawPalettePreview() {
  const c = els.palettePreview, g = c.getContext('2d');
  const w = c.width, h = c.height, stops = PALETTES[els.paletteSel.value];
  for (let x = 0; x < w; x++) {
    const col = lerpStops(stops, x / (w - 1));
    g.fillStyle = `rgb(${col[0]|0},${col[1]|0},${col[2]|0})`;
    g.fillRect(x, 0, 1, h);
  }
}

function openModal(m) { m.classList.add('open'); }
function closeModal(m) { m.classList.remove('open'); }

// ---- wire up ----
function wireEvents() {
  els.sourceSel.addEventListener('change', () => {
    els.wsRow.style.display = els.sourceSel.value === 'ws' ? '' : 'none';
    if (els.sourceSel.value === 'simcw') {
      els.mode.value = 'CW';
      worker.postMessage({ type: 'mode', mode: 'CW' });
      updateReadout();
    }
  });

  els.connectBtn.addEventListener('click', () => state.connected ? disconnect() : connect());

  const applyFreq = () => { state.centerFreq = currentFreqHz(); if (state.connected) worker.postMessage({ type: 'tune', hz: state.centerFreq }); };
  els.freq.addEventListener('change', applyFreq);

  els.rate.addEventListener('change', () => {
    state.sampleRate = parseInt(els.rate.value, 10);
    if (state.connected) worker.postMessage({ type: 'rate', sps: state.sampleRate });
  });

  els.autoGain.addEventListener('change', () => {
    els.gain.disabled = els.autoGain.checked;
    worker.postMessage({ type: 'gain', auto: els.autoGain.checked, tenthsDb: Math.round(parseFloat(els.gain.value)*10) });
  });
  els.gain.addEventListener('input', () => {
    worker.postMessage({ type: 'gain', auto: els.autoGain.checked, tenthsDb: Math.round(parseFloat(els.gain.value)*10) });
  });

  els.mode.addEventListener('change', () => { worker.postMessage({ type: 'mode', mode: els.mode.value }); updateReadout(); });

  els.audioBtn.addEventListener('click', async () => {
    const turningOn = !els.audioBtn.classList.contains('active');
    try {
      if (turningOn) { await enableAudio(); els.audioBtn.classList.add('active'); }
      else { disableAudio(); els.audioBtn.classList.remove('active'); }
    } catch (e) {
      els.audioBtn.classList.remove('active');
      els.status.textContent = 'Audio error: ' + e.message;
    }
  });

  els.volume.addEventListener('input', () => { if (gainNode) gainNode.gain.value = parseFloat(els.volume.value); });

  // settings
  els.settingsBtn.addEventListener('click', () => { drawPalettePreview(); openModal(els.settingsModal); });
  els.settingsClose.addEventListener('click', () => closeModal(els.settingsModal));
  els.paletteSel.addEventListener('change', () => { state.palette = els.paletteSel.value; state.lut = buildLut(state.palette); drawPalettePreview(); });
  els.traceColor.addEventListener('input', () => state.traceColor = els.traceColor.value);
  els.peakColor.addEventListener('input', () => state.peakColor = els.peakColor.value);
  els.minDb.addEventListener('input', () => { state.minDb = parseFloat(els.minDb.value); });
  els.maxDb.addEventListener('input', () => { state.maxDb = parseFloat(els.maxDb.value); });
  const sendCw = () => {
    els.cwPitchVal.textContent = els.cwPitch.value + ' Hz';
    els.cwBandwidthVal.textContent = els.cwBandwidth.value + ' Hz';
    worker.postMessage({ type: 'cw', pitch: parseInt(els.cwPitch.value, 10), bandwidth: parseInt(els.cwBandwidth.value, 10) });
  };
  els.cwPitch.addEventListener('input', sendCw);
  els.cwBandwidth.addEventListener('input', sendCw);
  els.resetColors.addEventListener('click', () => {
    state.traceColor = '#50c8ff'; state.peakColor = '#5f697d'; state.palette = 'Classic';
    state.minDb = -100; state.maxDb = 0; state.lut = buildLut('Classic');
    els.traceColor.value = '#50c8ff'; els.peakColor.value = '#5f697d'; els.paletteSel.value = 'Classic';
    els.minDb.value = -100; els.maxDb.value = 0; drawPalettePreview();
    els.cwPitch.value = 700; els.cwBandwidth.value = 300; sendCw();
  });

  // about
  els.aboutBtn.addEventListener('click', () => openModal(els.aboutModal));
  els.aboutClose.addEventListener('click', () => closeModal(els.aboutModal));
  els.repoLink.href = REPO_URL;
  els.repoLink.textContent = REPO_URL;

  [els.settingsModal, els.aboutModal].forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModal(m); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(els.settingsModal); closeModal(els.aboutModal); } });

  // install
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; els.installBtn.hidden = false; });
  els.installBtn.addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null; els.installBtn.hidden = true;
  });
}

function init() {
  wireEvents();
  els.wsRow.style.display = els.sourceSel.value === 'ws' ? '' : 'none';
  els.gain.disabled = els.autoGain.checked;
  initWorker();
  ensureWaterfallBuffer();
  updateReadout();
  requestAnimationFrame(renderLoop);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
}

init();
