// Synthesized sound effects via the Web Audio API — no audio files to host
// or license. Every effect is a couple of short oscillator/noise bursts.

import { local } from './storage.js';

const MUTE_KEY = 'wlink_sound_muted';
const VOLUME_KEY = 'wlink_sound_volume';

let ctx = null;
let masterGain = null;
let muted = local.get(MUTE_KEY, false);
let volume = local.get(VOLUME_KEY, 0.6);

function ensureContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  masterGain = ctx.createGain();
  masterGain.gain.value = muted ? 0 : volume;
  masterGain.connect(ctx.destination);
  return ctx;
}

// Call from inside a user-gesture handler (join/create/controller-connect
// taps). Safe to call repeatedly; a catch-all listener also calls this once.
export function unlock() {
  const c = ensureContext();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  // iOS Safari's legacy unlock trick: play a near-silent 1-sample buffer
  // inside the gesture so later programmatic playback is allowed.
  try {
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, 22050);
    src.connect(c.destination);
    src.start(0);
  } catch (e) { /* ignore */ }
}

export function setMuted(v) {
  muted = !!v;
  local.set(MUTE_KEY, muted);
  if (masterGain) masterGain.gain.value = muted ? 0 : volume;
}

export function isMuted() { return muted; }

export function setVolume(v) {
  volume = Math.max(0, Math.min(1, v));
  local.set(VOLUME_KEY, volume);
  if (masterGain && !muted) masterGain.gain.value = volume;
}

export function getVolume() { return volume; }

function tone({ type = 'sine', freq, freqEnd, dur = 0.15, delay = 0, gain = 0.18 }) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noiseBurst({ dur = 0.08, filterFreq = 4000, delay = 0, gain = 0.15 }) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const frames = Math.floor(ctx.sampleRate * dur);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = filterFreq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(masterGain);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

function safe(fn) {
  return (...args) => {
    if (!ctx) return; // not unlocked yet — no-op rather than throwing
    try { fn(...args); } catch (e) { /* ignore */ }
  };
}

export const tick = safe((urgent = false) => {
  tone({ type: 'square', freq: urgent ? 1400 : 1000, dur: 0.06, gain: 0.1 });
});

export const correct = safe(() => {
  tone({ type: 'sine', freq: 880, freqEnd: 1760, dur: 0.15, gain: 0.2 });
  tone({ type: 'sine', freq: 1760, dur: 0.28, delay: 0.02, gain: 0.08 });
});

export const wrong = safe(() => {
  tone({ type: 'sawtooth', freq: 120, freqEnd: 90, dur: 0.28, gain: 0.2 });
  tone({ type: 'sawtooth', freq: 124, freqEnd: 94, dur: 0.28, gain: 0.12 });
});

export const bank = safe(() => {
  tone({ type: 'triangle', freq: 1046.5, dur: 0.1, gain: 0.18 });
  tone({ type: 'triangle', freq: 1568, dur: 0.2, delay: 0.08, gain: 0.18 });
  noiseBurst({ dur: 0.1, filterFreq: 4500, delay: 0.08, gain: 0.12 });
});

export const eliminate = safe(() => {
  tone({ type: 'sawtooth', freq: 400, freqEnd: 80, dur: 0.65, gain: 0.22 });
  tone({ type: 'triangle', freq: 280, freqEnd: 60, dur: 0.65, gain: 0.14 });
});

export const win = safe(() => {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => tone({ type: 'triangle', freq: f, dur: 0.18, delay: i * 0.12, gain: 0.16 }));
  notes.forEach((f) => tone({ type: 'triangle', freq: f, dur: 0.6, delay: 0.48, gain: 0.1 }));
});

export const vote = safe(() => {
  tone({ type: 'sine', freq: 660, dur: 0.08, gain: 0.12 });
});

export const kick = safe(() => {
  tone({ type: 'square', freq: 220, freqEnd: 140, dur: 0.1, gain: 0.14 });
});
