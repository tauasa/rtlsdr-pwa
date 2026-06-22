/*
 * rtlsdr-pwa — PCM player AudioWorklet.
 * Receives mono Float32 audio chunks (already at the context sample rate) from
 * the main thread and streams them to the output, dropping the oldest audio if
 * the queue grows too large so latency stays bounded.
 * Copyright (c) 2026 Tauasa Timoteo. MIT License.
 */
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.cur = null;
    this.curPos = 0;
    this.queued = 0;            // total samples queued
    this.maxQueued = sampleRate; // ~1 s ceiling before we drop
    this.port.onmessage = (e) => {
      const s = e.data.samples;
      if (!s) return;
      this.queue.push(s);
      this.queued += s.length;
      while (this.queued > this.maxQueued && this.queue.length > 1) {
        const dropped = this.queue.shift();
        this.queued -= dropped.length;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      if (!this.cur || this.curPos >= this.cur.length) {
        this.cur = this.queue.length ? this.queue.shift() : null;
        this.curPos = 0;
      }
      if (this.cur) {
        out[i] = this.cur[this.curPos++];
        this.queued--;
      } else {
        out[i] = 0; // underrun -> silence
      }
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
