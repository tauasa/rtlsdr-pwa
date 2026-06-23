/*
 * rtlsdr-pwa — pure DSP core.
 * Works both inside a Web Worker (via importScripts) and under Node (via require),
 * so the signal path can be unit-tested off-browser. No DOM / Web APIs here.
 *
 * Ported from the rtlsdr-fx desktop app (org.tauasa.apps.sdr.dsp).
 * Copyright (c) 2026 Tauasa Timoteo. MIT License.
 */
(function (root) {
  'use strict';

  // ---- radix-2 iterative FFT (in place, forward) ----
  function fft(re, im) {
    const n = re.length;
    // bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) {
        j ^= bit;
      }
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k];
          const ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr;
          im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr;
          im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    }
    return w;
  }

  // ---- windowed-sinc (Hamming) low-pass with unity DC gain ----
  function lowPass(numTaps, fcNorm) {
    if (numTaps < 1) numTaps = 1;
    if (fcNorm <= 0) fcNorm = 1e-4;
    if (fcNorm >= 0.5) fcNorm = 0.4999;
    const h = new Float32Array(numTaps);
    const m = numTaps - 1;
    const wc = 2 * Math.PI * fcNorm;
    let sum = 0;
    for (let i = 0; i < numTaps; i++) {
      const x = i - m / 2;
      const sinc = Math.abs(x) < 1e-9 ? wc : Math.sin(wc * x) / x;
      const win = m === 0 ? 1 : 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / m);
      const v = sinc * win;
      h[i] = v;
      sum += v;
    }
    if (sum !== 0) for (let i = 0; i < numTaps; i++) h[i] /= sum;
    return h;
  }

  // ---- decimating FIR over interleaved complex input ----
  class ComplexFirDecimator {
    constructor(taps, decim) {
      this.taps = taps;
      this.decim = Math.max(1, decim | 0);
      this.n = taps.length;
      this.zi = new Float32Array(this.n);
      this.zq = new Float32Array(this.n);
      this.pos = 0;
      this.phase = 0;
    }
    maxOutput(complexSamples) { return ((complexSamples / this.decim) | 0) + 1; }
    process(inIq, complexInput, out) {
      const { taps, n, zi, zq } = this;
      let pos = this.pos, phase = this.phase, outCount = 0;
      for (let s = 0; s < complexInput; s++) {
        zi[pos] = inIq[2 * s];
        zq[pos] = inIq[2 * s + 1];
        if (++pos === n) pos = 0;
        if (++phase >= this.decim) {
          phase = 0;
          let accI = 0, accQ = 0, idx = pos - 1;
          if (idx < 0) idx += n;
          for (let k = 0; k < n; k++) {
            const t = taps[k];
            accI += t * zi[idx];
            accQ += t * zq[idx];
            if (--idx < 0) idx += n;
          }
          out[2 * outCount] = accI;
          out[2 * outCount + 1] = accQ;
          outCount++;
        }
      }
      this.pos = pos; this.phase = phase;
      return outCount;
    }
  }

  // ---- decimating FIR over a real channel ----
  class RealFirDecimator {
    constructor(taps, decim) {
      this.taps = taps;
      this.decim = Math.max(1, decim | 0);
      this.n = taps.length;
      this.z = new Float32Array(this.n);
      this.pos = 0;
      this.phase = 0;
    }
    maxOutput(samples) { return ((samples / this.decim) | 0) + 1; }
    process(inBuf, count, out) {
      const { taps, n, z } = this;
      let pos = this.pos, phase = this.phase, outCount = 0;
      for (let s = 0; s < count; s++) {
        z[pos] = inBuf[s];
        if (++pos === n) pos = 0;
        if (++phase >= this.decim) {
          phase = 0;
          let acc = 0, idx = pos - 1;
          if (idx < 0) idx += n;
          for (let k = 0; k < n; k++) {
            acc += taps[k] * z[idx];
            if (--idx < 0) idx += n;
          }
          out[outCount++] = acc;
        }
      }
      this.pos = pos; this.phase = phase;
      return outCount;
    }
  }

  // ---- spectrum: Hann window -> FFT -> power dB -> fftshift ----
  class SpectrumProcessor {
    constructor(fftSize) {
      this.n = fftSize;
      this.win = hann(fftSize);
      this.re = new Float32Array(fftSize);
      this.im = new Float32Array(fftSize);
      this.out = new Float32Array(fftSize);
      let s = 0;
      for (let i = 0; i < fftSize; i++) s += this.win[i];
      this.cg = s / fftSize; // coherent gain of the window
      this.norm = 1 / (this.n * this.n * this.cg * this.cg); // amplitude-1 tone -> 0 dB
    }
    size() { return this.n; }
    process(iq) {
      const n = this.n, re = this.re, im = this.im, win = this.win, out = this.out;
      for (let i = 0; i < n; i++) {
        re[i] = iq[2 * i] * win[i];
        im[i] = iq[2 * i + 1] * win[i];
      }
      fft(re, im);
      const half = n >> 1;
      for (let j = 0; j < n; j++) {
        const bin = (j + half) % n; // fftshift: DC to centre
        const p = re[bin] * re[bin] + im[bin] * im[bin];
        out[j] = 10 * Math.log10(p * this.norm + 1e-12);
      }
      return out;
    }
  }

  // ---- RBJ biquad band-pass (constant 0 dB peak gain), normalised coeffs ----
  function makeBandpass(f0, bw, fs) {
    const w0 = (2 * Math.PI * f0) / fs;
    const Q = Math.max(0.5, f0 / Math.max(1, bw));
    const alpha = Math.sin(w0) / (2 * Q);
    const cosw = Math.cos(w0);
    const a0 = 1 + alpha;
    return {
      b0: alpha / a0,
      b1: 0,
      b2: -alpha / a0,
      a1: (-2 * cosw) / a0,
      a2: (1 - alpha) / a0,
    };
  }

  // ---- WFM / NFM / AM / CW demodulator -> mono audio at a target rate ----
  const MODES = ['WFM', 'NFM', 'AM', 'CW'];
  const MODE_LABELS = { WFM: 'Wideband FM', NFM: 'Narrowband FM', AM: 'AM', CW: 'CW (Morse)' };
  const IF_TARGET = 240000;

  class Demodulator {
    constructor(audioRate) {
      this.audioRate = audioRate || 48000;
      this.mode = 'WFM';
      this.inputRate = 0;
      this.cwPitch = 700;      // BFO / sidetone pitch (Hz)
      this.cwBandwidth = 300;  // CW filter bandwidth (Hz)
    }
    setAudioRate(rate) {
      this.audioRate = rate;
      if (this.inputRate > 0) this.configure(this.inputRate);
    }
    setMode(m) {
      if (MODES.indexOf(m) >= 0) {
        this.mode = m;
        if (this.inputRate > 0) this.configure(this.inputRate);
      }
    }
    getMode() { return this.mode; }

    setCwParams(pitch, bandwidth) {
      if (pitch > 0) this.cwPitch = pitch;
      if (bandwidth > 0) this.cwBandwidth = bandwidth;
      if (this.inputRate > 0) this.configure(this.inputRate);
    }

    configure(inputRate) {
      this.inputRate = inputRate;
      const decim1 = Math.max(1, Math.round(inputRate / IF_TARGET));
      this.ifRate = inputRate / decim1;
      const frontCut = 0.45 / decim1;
      this.front = new ComplexFirDecimator(lowPass(63, frontCut), decim1);

      let audioCutHz;
      if (this.mode === 'WFM') {
        audioCutHz = 15000;
        this.fmGain = this.ifRate / (2 * Math.PI * 75000);
        this.useDeemph = true;
      } else if (this.mode === 'NFM') {
        audioCutHz = 3400;
        this.fmGain = this.ifRate / (2 * Math.PI * 5000);
        this.useDeemph = false;
      } else if (this.mode === 'CW') {
        // pass the pitch tone (it is created by the BFO mix below)
        audioCutHz = Math.min(this.audioRate * 0.45, this.cwPitch + this.cwBandwidth + 400);
        this.fmGain = 1;
        this.useDeemph = false;
      } else {
        audioCutHz = 4500;
        this.fmGain = 1;
        this.useDeemph = false;
      }

      const decim2 = Math.max(1, Math.round(this.ifRate / this.audioRate));
      this.preAudioRate = this.ifRate / decim2;
      const audioCutNorm = Math.min(0.45, audioCutHz / this.ifRate);
      this.audioStage = new RealFirDecimator(lowPass(63, audioCutNorm), decim2);

      const tau = 75e-6;
      this.deemphAlpha = 1 - Math.exp(-1 / (tau * this.audioRate));

      this.resampleStep = this.preAudioRate / this.audioRate;
      this.resamplePos = 0;
      this.resamplePrev = 0;

      this.lastI = 0; this.lastQ = 0;
      this.dcState = 0; this.amDc = 0; this.deemphState = 0;

      // CW: a BFO rotator at the IF rate shifts a centre carrier up to the pitch,
      // and a band-pass at the audio rate makes the tight CW filter.
      const ncoInc = (2 * Math.PI * this.cwPitch) / this.ifRate;
      this.cwCosInc = Math.cos(ncoInc);
      this.cwSinInc = Math.sin(ncoInc);
      this.cwOscR = 1; this.cwOscI = 0; this.cwOscN = 0;
      this.cwbp = makeBandpass(this.cwPitch, this.cwBandwidth, this.audioRate);
      this.cwX1 = 0; this.cwX2 = 0; this.cwY1 = 0; this.cwY2 = 0;

      const ifMax = this.front.maxOutput(1 << 15);
      this.ifBuf = new Float32Array(ifMax * 2);
      this.demodBuf = new Float32Array(ifMax);
      const aMax = this.audioStage.maxOutput(ifMax);
      this.audioBuf = new Float32Array(aMax);
      this.outBuf = new Float32Array(((aMax / Math.max(0.05, this.resampleStep)) | 0) + 8);
    }

    process(iq, complexInput) {
      if (this.inputRate <= 0 || !this.front) return new Float32Array(0);
      // grow scratch if a bigger block arrives
      const ifMax = this.front.maxOutput(complexInput);
      if (this.ifBuf.length < ifMax * 2) {
        this.ifBuf = new Float32Array(ifMax * 2);
        this.demodBuf = new Float32Array(ifMax);
        const aMax = this.audioStage.maxOutput(ifMax);
        this.audioBuf = new Float32Array(aMax);
        this.outBuf = new Float32Array(((aMax / Math.max(0.05, this.resampleStep)) | 0) + 8);
      }
      const ifCount = this.front.process(iq, complexInput, this.ifBuf);
      const ifBuf = this.ifBuf, demodBuf = this.demodBuf;

      if (this.mode === 'AM') {
        for (let k = 0; k < ifCount; k++) {
          const i = ifBuf[2 * k], q = ifBuf[2 * k + 1];
          const env = Math.sqrt(i * i + q * q);
          this.amDc += 0.0005 * (env - this.amDc);
          demodBuf[k] = env - this.amDc;
        }
      } else if (this.mode === 'CW') {
        // mix up by the pitch (centre carrier -> audible tone) and take the real part
        let oR = this.cwOscR, oI = this.cwOscI, nn = this.cwOscN;
        const cI = this.cwCosInc, sI = this.cwSinInc;
        for (let k = 0; k < ifCount; k++) {
          const i = ifBuf[2 * k], q = ifBuf[2 * k + 1];
          demodBuf[k] = i * oR - q * oI; // Re{(i + jq) * e^{j theta}}
          const nR = oR * cI - oI * sI;
          oI = oR * sI + oI * cI;
          oR = nR;
          if ((++nn & 1023) === 0) {       // periodic renormalise to fight drift
            const m = Math.sqrt(oR * oR + oI * oI) || 1;
            oR /= m; oI /= m;
          }
        }
        this.cwOscR = oR; this.cwOscI = oI; this.cwOscN = nn;
      } else {
        let lastI = this.lastI, lastQ = this.lastQ, dc = this.dcState;
        const g = this.fmGain;
        for (let k = 0; k < ifCount; k++) {
          const i = ifBuf[2 * k], q = ifBuf[2 * k + 1];
          const re = i * lastI + q * lastQ;
          const im = q * lastI - i * lastQ;
          lastI = i; lastQ = q;
          const v = Math.atan2(im, re) * g;
          dc += 0.0008 * (v - dc);
          demodBuf[k] = v - dc;
        }
        this.lastI = lastI; this.lastQ = lastQ; this.dcState = dc;
      }

      const audioCount = this.audioStage.process(demodBuf, ifCount, this.audioBuf);
      const audioBuf = this.audioBuf, outBuf = this.outBuf;

      let outCount = 0;
      let pos = this.resamplePos;
      const step = this.resampleStep;
      while (pos < audioCount) {
        const idx = pos | 0;
        const frac = pos - idx;
        const a = idx === 0 ? this.resamplePrev : audioBuf[idx - 1];
        const b = audioBuf[idx];
        if (outCount >= outBuf.length) break;
        outBuf[outCount++] = a + frac * (b - a);
        pos += step;
      }
      if (audioCount > 0) {
        this.resamplePrev = audioBuf[audioCount - 1];
        this.resamplePos = pos - audioCount;
        if (this.resamplePos < 0) this.resamplePos = 0;
      }

      if (this.useDeemph) {
        let s = this.deemphState;
        const al = this.deemphAlpha;
        for (let k = 0; k < outCount; k++) {
          s += al * (outBuf[k] - s);
          outBuf[k] = s;
        }
        this.deemphState = s;
      }

      if (this.mode === 'CW') {
        const bp = this.cwbp;
        let x1 = this.cwX1, x2 = this.cwX2, y1 = this.cwY1, y2 = this.cwY2;
        for (let k = 0; k < outCount; k++) {
          const x0 = outBuf[k];
          const y0 = bp.b0 * x0 + bp.b1 * x1 + bp.b2 * x2 - bp.a1 * y1 - bp.a2 * y2;
          x2 = x1; x1 = x0; y2 = y1; y1 = y0;
          outBuf[k] = y0 * 2.0; // makeup for the narrow filter + real-part halving
        }
        this.cwX1 = x1; this.cwX2 = x2; this.cwY1 = y1; this.cwY2 = y2;
      }

      return outBuf.slice(0, outCount);
    }
  }

  const api = {
    fft, hann, lowPass,
    ComplexFirDecimator, RealFirDecimator,
    SpectrumProcessor, Demodulator,
    MODES, MODE_LABELS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node (tests)
  } else {
    Object.assign(root, api); // Worker global / window
  }
})(typeof self !== 'undefined' ? self : this);
