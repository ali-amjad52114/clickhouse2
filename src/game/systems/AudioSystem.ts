import type { AudioCue, AudioSystemApi } from '../engineContract';

/**
 * Every sound in this game is synthesised. There are no audio files in the
 * project and no way to fetch any, so each cue is built from oscillators,
 * envelopes and filtered noise at play time.
 *
 * Browsers refuse to start an AudioContext before a user gesture, so the
 * context is created lazily and unlocked by the first pointer/key event.
 * Until that happens `play()` is a silent no-op rather than a thrown error.
 */

export interface AudioSystemOptions {
  muted?: boolean;
  /** 0..1 master trim. Kept gentle by default - this plays next to a child. */
  masterVolume?: number;
}

export interface AudioState {
  supported: boolean;
  unlocked: boolean;
  contextState: 'none' | AudioContextState;
  muted: boolean;
}

type Wave = OscillatorType;

interface ToneSpec {
  freq: number;
  /** Glide target. Omit for a steady pitch. */
  to?: number;
  type?: Wave;
  at: number;
  dur: number;
  peak: number;
  attack?: number;
}

interface NoiseSpec {
  at: number;
  dur: number;
  peak: number;
  /** Filter sweep, in Hz. */
  from: number;
  to: number;
  q?: number;
  filter?: BiquadFilterType;
  attack?: number;
}

const GESTURES = ['pointerdown', 'touchend', 'mousedown', 'keydown'] as const;

/** Equal-temperament note table for the cues below. */
const N = {
  a3: 220, c4: 261.63, e4: 329.63, g4: 392.0,
  c5: 523.25, e5: 659.26, g5: 783.99, a5: 880,
  c6: 1046.5, e6: 1318.51, g6: 1567.98, c7: 2093,
};

export class AudioSystem implements AudioSystemApi {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private muted: boolean;
  private volume: number;
  private supported: boolean;
  private listening = false;
  private destroyed = false;

  constructor(opts: AudioSystemOptions = {}) {
    this.muted = opts.muted ?? false;
    this.volume = Math.min(1, Math.max(0, opts.masterVolume ?? 0.32));
    this.supported =
      typeof window !== 'undefined' &&
      ('AudioContext' in window ||
        'webkitAudioContext' in (window as unknown as Record<string, unknown>));
    this.armUnlock();
  }

  /* ---------------------------------------------------------------- */
  /* Context lifecycle                                                 */
  /* ---------------------------------------------------------------- */

  private ctor(): typeof AudioContext | null {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    return w.AudioContext ?? w.webkitAudioContext ?? null;
  }

  private ensure(): AudioContext | null {
    if (this.destroyed || !this.supported) return null;
    if (this.ctx) return this.ctx;
    const Ctor = this.ctor();
    if (!Ctor) {
      this.supported = false;
      return null;
    }
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
      return this.ctx;
    } catch {
      this.supported = false;
      return null;
    }
  }

  /** Listens for the first user gesture so the context can legally start. */
  private armUnlock(): void {
    if (this.listening || typeof window === 'undefined') return;
    this.listening = true;
    for (const ev of GESTURES) {
      window.addEventListener(ev, this.onGesture, { passive: true });
    }
  }

  private onGesture = (): void => {
    void this.unlock();
  };

  private disarmUnlock(): void {
    if (!this.listening || typeof window === 'undefined') return;
    this.listening = false;
    for (const ev of GESTURES) window.removeEventListener(ev, this.onGesture);
  }

  /** Safe to call from any gesture handler; resolves once audio can sound. */
  async unlock(): Promise<boolean> {
    const ctx = this.ensure();
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { return false; }
    }
    if (ctx.state === 'running') this.disarmUnlock();
    return ctx.state === 'running';
  }

  state(): AudioState {
    return {
      supported: this.supported,
      unlocked: this.ctx?.state === 'running',
      contextState: this.ctx ? this.ctx.state : 'none',
      muted: this.muted,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Synthesis primitives                                              */
  /* ---------------------------------------------------------------- */

  private envelope(source: AudioNode, at: number, dur: number, peak: number, attack: number): GainNode {
    const ctx = this.ctx as AudioContext;
    const g = ctx.createGain();
    const top = Math.max(0.0005, peak);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(top, at + Math.min(attack, dur * 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    source.connect(g);
    g.connect(this.master as GainNode);
    return g;
  }

  private tone(spec: ToneSpec): void {
    const ctx = this.ctx as AudioContext;
    const osc = ctx.createOscillator();
    osc.type = spec.type ?? 'sine';
    osc.frequency.setValueAtTime(spec.freq, spec.at);
    if (spec.to !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), spec.at + spec.dur * 0.9);
    }
    const gain = this.envelope(osc, spec.at, spec.dur, spec.peak, spec.attack ?? 0.008);
    osc.start(spec.at);
    osc.stop(spec.at + spec.dur + 0.06);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }

  private noiseBuffer(): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    if (this.noise) return this.noise;
    const len = Math.floor(ctx.sampleRate * 0.7);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    this.noise = buf;
    return buf;
  }

  private noiseBurst(spec: NoiseSpec): void {
    const ctx = this.ctx as AudioContext;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    const filter = ctx.createBiquadFilter();
    filter.type = spec.filter ?? 'bandpass';
    filter.Q.value = spec.q ?? 1.2;
    filter.frequency.setValueAtTime(spec.from, spec.at);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, spec.to), spec.at + spec.dur);
    src.connect(filter);
    const gain = this.envelope(filter, spec.at, spec.dur, spec.peak, spec.attack ?? 0.03);
    src.start(spec.at);
    src.stop(spec.at + spec.dur + 0.06);
    src.onended = () => { src.disconnect(); filter.disconnect(); gain.disconnect(); };
  }

  private arpeggio(notes: number[], at: number, step: number, dur: number, peak: number, type: Wave = 'sine'): void {
    notes.forEach((f, i) => this.tone({ freq: f, type, at: at + i * step, dur, peak }));
  }

  /* ---------------------------------------------------------------- */
  /* Cues                                                              */
  /* ---------------------------------------------------------------- */

  play(cue: AudioCue): void {
    if (this.muted || this.destroyed) return;
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      // Not unlocked yet: try (harmless if it fails) and skip this cue rather
      // than queueing a burst that would all fire at once on resume.
      void this.unlock();
      return;
    }

    const t = ctx.currentTime + 0.002;
    switch (cue) {
      case 'tap':
        this.tone({ freq: N.a5, type: 'sine', at: t, dur: 0.07, peak: 0.16 });
        return;

      case 'correct':
        // Rising major third, warm and small.
        this.tone({ freq: N.c5, type: 'triangle', at: t, dur: 0.16, peak: 0.2 });
        this.tone({ freq: N.e5, type: 'triangle', at: t + 0.09, dur: 0.22, peak: 0.2 });
        this.tone({ freq: N.g5, type: 'sine', at: t + 0.18, dur: 0.26, peak: 0.11 });
        return;

      case 'wrong':
        // Deliberately neutral: a soft downward boop, no dissonance, no buzz.
        this.tone({ freq: 330, to: 247, type: 'sine', at: t, dur: 0.2, peak: 0.13, attack: 0.02 });
        this.tone({ freq: 165, to: 124, type: 'sine', at: t, dur: 0.22, peak: 0.05, attack: 0.02 });
        return;

      case 'collect':
        this.tone({ freq: N.g6, to: N.e6, type: 'triangle', at: t, dur: 0.16, peak: 0.18 });
        this.tone({ freq: N.c7, type: 'sine', at: t + 0.01, dur: 0.1, peak: 0.07 });
        return;

      case 'sparkle':
        this.arpeggio([N.c6, N.e6, N.g6, N.c7], t, 0.045, 0.13, 0.09);
        return;

      case 'star':
        // Bell-ish: fundamental plus a bright partial that decays faster.
        this.tone({ freq: N.g6, type: 'sine', at: t, dur: 0.5, peak: 0.16 });
        this.tone({ freq: 2349, type: 'sine', at: t, dur: 0.3, peak: 0.06 });
        this.tone({ freq: N.c6, type: 'triangle', at: t + 0.02, dur: 0.36, peak: 0.07 });
        return;

      case 'celebrate':
        // Triumphant spread chord plus a shimmer on top.
        [N.c5, N.e5, N.g5, N.c6].forEach((f, i) =>
          this.tone({ freq: f, type: 'triangle', at: t + i * 0.055, dur: 0.85, peak: 0.16 }));
        this.arpeggio([N.g6, N.c7, N.e6 * 2], t + 0.24, 0.07, 0.3, 0.07);
        this.tone({ freq: N.c4, type: 'sine', at: t, dur: 0.9, peak: 0.1 });
        return;

      case 'hop':
        this.tone({ freq: N.a3, to: 520, type: 'triangle', at: t, dur: 0.1, peak: 0.15, attack: 0.005 });
        return;

      case 'whoosh':
        this.noiseBurst({ at: t, dur: 0.34, peak: 0.12, from: 420, to: 2600, q: 0.9, attack: 0.09 });
        return;

      case 'reveal':
        this.tone({ freq: 300, to: 1200, type: 'sine', at: t, dur: 0.45, peak: 0.12, attack: 0.06 });
        this.arpeggio([N.e6, N.g6, N.c7], t + 0.16, 0.06, 0.22, 0.06);
        return;

      case 'page':
        this.noiseBurst({ at: t, dur: 0.2, peak: 0.1, from: 2400, to: 700, q: 0.6, filter: 'lowpass', attack: 0.02 });
        this.tone({ freq: N.e4, type: 'sine', at: t + 0.04, dur: 0.12, peak: 0.05 });
        return;

      default:
        return;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(muted ? 0 : this.volume, now, 0.02);
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (!this.muted) this.setMuted(false);
  }

  destroy(): void {
    this.destroyed = true;
    this.disarmUnlock();
    try { void this.ctx?.close(); } catch { /* context already gone */ }
    this.ctx = null;
    this.master = null;
    this.noise = null;
  }
}
