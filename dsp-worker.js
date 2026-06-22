/*
 * rtlsdr-pwa — DSP worker.
 * Owns the active source (in-browser simulated FM, or an rtl_tcp stream bridged
 * over WebSocket by websockify), runs the FFT for display and the audio
 * demodulator, and posts spectrum frames + audio chunks back to the main thread.
 * Copyright (c) 2026 Tauasa Timoteo. MIT License.
 */
'use strict';
importScripts('dsp.js');

// rtl_tcp command opcodes (same as the desktop RtlTcpSource)
const CMD_SET_FREQUENCY = 0x01;
const CMD_SET_SAMPLE_RATE = 0x02;
const CMD_SET_GAIN_MODE = 0x03;
const CMD_SET_GAIN = 0x04;
const CMD_SET_AGC_MODE = 0x08;

let fftSize = 2048;
let sampleRate = 300000;
let centerFreq = 100000000;
let audioRate = 48000;
let mode = 'WFM';
let audioEnabled = false;
let gainTenthsDb = 0;
let autoGain = true;

let spectrum = new SpectrumProcessor(fftSize);
let demod = new Demodulator(audioRate);
demod.setMode(mode);
demod.configure(sampleRate);

let running = false;
let sourceKind = null; // 'sim' | 'ws'

// display pacing
let lastSpecTime = 0;
const SPEC_PERIOD_MS = 1000 / 40;

// block accumulator for the FFT (interleaved IQ)
let blockBuf = new Float32Array(fftSize * 2);
let blockFill = 0;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }
function status(text) { post({ type: 'status', text }); }

function reconfigure() {
  if (spectrum.size() !== fftSize) spectrum = new SpectrumProcessor(fftSize);
  blockBuf = new Float32Array(fftSize * 2);
  blockFill = 0;
  demod.configure(sampleRate);
}

// Feed interleaved IQ through audio + spectrum paths.
function feed(iq, complexCount) {
  if (audioEnabled) {
    const audio = demod.process(iq, complexCount);
    if (audio.length > 0) post({ type: 'audio', samples: audio }, [audio.buffer]);
  }
  // accumulate into FFT-sized blocks
  let off = 0;
  while (off < complexCount) {
    const take = Math.min(fftSize - blockFill, complexCount - off);
    blockBuf.set(iq.subarray(2 * off, 2 * (off + take)), 2 * blockFill);
    blockFill += take;
    off += take;
    if (blockFill === fftSize) {
      maybeSpectrum(blockBuf);
      blockFill = 0;
    }
  }
}

function maybeSpectrum(iqBlock) {
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (now - lastSpecTime < SPEC_PERIOD_MS) return;
  lastSpecTime = now;
  const power = spectrum.process(iqBlock).slice();
  post({ type: 'spectrum', power, center: centerFreq, sampleRate, fftSize }, [power.buffer]);
}

// ---------------- Simulated source ----------------
// A wideband-FM "station" at band centre, modulated by a 440 Hz tone, plus two
// faint CW carriers for visual interest and a low noise floor.
let simTimer = null;
let simLastTime = 0;
const sim = { phase: 0, t: 0, cw1: 0, cw2: 0 };

function gaussian() {
  // Box-Muller, one value
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function startSim() {
  sourceKind = 'sim';
  running = true;
  simLastTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  sim.phase = 0; sim.t = 0; sim.cw1 = 0; sim.cw2 = 0;
  status('Simulated source running — WFM station at centre.');
  simTimer = setInterval(simTick, 50);
}

function simTick() {
  if (!running || sourceKind !== 'sim') return;
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let count = Math.round((sampleRate * (now - simLastTime)) / 1000);
  simLastTime = now;
  if (count <= 0) return;
  if (count > sampleRate * 0.25) count = Math.round(sampleRate * 0.25); // cap after a stall

  const dev = 75000;          // peak FM deviation
  const carrier = 0.3;        // -10 dB
  const noiseAmp = 0.0016;    // ~ -56 dB floor
  const cw1f = 60000, cw2f = -82000;
  const cw1a = 0.006, cw2a = 0.004;
  const dphi1 = (2 * Math.PI * cw1f) / sampleRate;
  const dphi2 = (2 * Math.PI * cw2f) / sampleRate;

  let produced = 0;
  while (produced < count) {
    const take = Math.min(fftSize, count - produced);
    const blk = new Float32Array(take * 2);
    for (let s = 0; s < take; s++) {
      const tt = sim.t / sampleRate;
      const msg = 0.7 * Math.sin(2 * Math.PI * 440 * tt) + 0.25 * Math.sin(2 * Math.PI * 660 * tt);
      sim.phase += (2 * Math.PI * dev * msg) / sampleRate;
      let i = carrier * Math.cos(sim.phase);
      let q = carrier * Math.sin(sim.phase);
      sim.cw1 += dphi1; sim.cw2 += dphi2;
      i += cw1a * Math.cos(sim.cw1) + cw2a * Math.cos(sim.cw2);
      q += cw1a * Math.sin(sim.cw1) + cw2a * Math.sin(sim.cw2);
      i += noiseAmp * gaussian();
      q += noiseAmp * gaussian();
      blk[2 * s] = i; blk[2 * s + 1] = q;
      sim.t++;
    }
    feed(blk, take);
    produced += take;
  }
}

// ---------------- RTL-TCP over WebSocket ----------------
let ws = null;
let headerLeft = 12;     // skip the 12-byte rtl_tcp header
let oddByte = -1;        // carry a single leftover IQ byte across frames

function sendCmd(cmd, value) {
  if (!ws || ws.readyState !== 1) return;
  const buf = new ArrayBuffer(5);
  const dv = new DataView(buf);
  dv.setUint8(0, cmd);
  dv.setUint32(1, value >>> 0, false); // big-endian
  ws.send(buf);
}

function startWs(url) {
  sourceKind = 'ws';
  headerLeft = 12; oddByte = -1;
  status('Connecting to ' + url + ' …');
  try {
    ws = new WebSocket(url);
  } catch (e) {
    status('WebSocket error: ' + e.message);
    return;
  }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    running = true;
    status('Connected. Streaming from rtl_tcp.');
    sendCmd(CMD_SET_SAMPLE_RATE, sampleRate);
    sendCmd(CMD_SET_FREQUENCY, centerFreq);
    sendCmd(CMD_SET_AGC_MODE, 0);
    sendCmd(CMD_SET_GAIN_MODE, autoGain ? 0 : 1);
    if (!autoGain) sendCmd(CMD_SET_GAIN, gainTenthsDb);
  };
  ws.onerror = () => status('WebSocket error — is the websockify bridge running?');
  ws.onclose = () => { if (running) status('Connection closed.'); running = false; };
  ws.onmessage = (ev) => onWsData(new Uint8Array(ev.data));
}

function onWsData(bytes) {
  if (headerLeft > 0) {
    const skip = Math.min(headerLeft, bytes.length);
    headerLeft -= skip;
    bytes = bytes.subarray(skip);
    if (bytes.length === 0) return;
  }
  const hasOdd = oddByte >= 0 ? 1 : 0;
  const total = bytes.length + hasOdd;
  const complexCount = total >> 1;
  if (complexCount === 0) {
    // not enough for a full sample yet
    if (total === 1) oddByte = hasOdd ? oddByte : bytes[0];
    return;
  }
  const iq = new Float32Array(complexCount * 2);
  let bi = 0; // index into bytes
  const next = () => {
    let b;
    if (hasOdd && bi === 0 && oddByte >= 0) { b = oddByte; oddByte = -1; }
    else { b = bytes[bi - hasOdd]; }
    bi++;
    return (b - 127.5) / 127.5;
  };
  for (let s = 0; s < complexCount; s++) {
    iq[2 * s] = next();
    iq[2 * s + 1] = next();
  }
  // stash a trailing odd byte for next frame
  if (total & 1) oddByte = bytes[bytes.length - 1];
  feed(iq, complexCount);
}

// ---------------- control messages ----------------
function stopAll() {
  running = false;
  if (simTimer) { clearInterval(simTimer); simTimer = null; }
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }
  sourceKind = null;
  blockFill = 0;
}

self.onmessage = (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'config':
      if (m.fftSize) fftSize = m.fftSize;
      if (m.sampleRate) sampleRate = m.sampleRate;
      if (m.centerFreq) centerFreq = m.centerFreq;
      if (m.audioRate) audioRate = m.audioRate;
      if (m.mode) mode = m.mode;
      if (typeof m.autoGain === 'boolean') autoGain = m.autoGain;
      if (typeof m.gainTenthsDb === 'number') gainTenthsDb = m.gainTenthsDb;
      demod.setAudioRate(audioRate);
      demod.setMode(mode);
      reconfigure();
      break;
    case 'audioRate':
      audioRate = m.rate;
      demod.setAudioRate(audioRate);
      break;
    case 'start':
      stopAll();
      sampleRate = m.sampleRate || sampleRate;
      centerFreq = m.centerFreq || centerFreq;
      reconfigure();
      if (m.source === 'ws') startWs(m.wsUrl);
      else startSim();
      break;
    case 'stop':
      stopAll();
      status('Stopped.');
      break;
    case 'tune':
      centerFreq = m.hz;
      if (sourceKind === 'ws') sendCmd(CMD_SET_FREQUENCY, centerFreq);
      break;
    case 'rate':
      sampleRate = m.sps;
      reconfigure();
      if (sourceKind === 'ws') sendCmd(CMD_SET_SAMPLE_RATE, sampleRate);
      break;
    case 'mode':
      mode = m.mode;
      demod.setMode(mode);
      break;
    case 'audio':
      audioEnabled = !!m.on;
      break;
    case 'gain':
      autoGain = !!m.auto;
      if (typeof m.tenthsDb === 'number') gainTenthsDb = m.tenthsDb;
      if (sourceKind === 'ws') {
        sendCmd(CMD_SET_GAIN_MODE, autoGain ? 0 : 1);
        if (!autoGain) sendCmd(CMD_SET_GAIN, gainTenthsDb);
      }
      break;
    default:
      break;
  }
};
