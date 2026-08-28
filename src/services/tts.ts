/**
 * Mimo's voice: browser SpeechSynthesis, tuned for a small energetic creature.
 *
 * TRUTHFULNESS CONTRACT
 * ---------------------
 * Nothing here pretends to speak. If `window.speechSynthesis` is missing, or
 * the browser has no usable voice, `speak()` resolves immediately with
 * `spoke: false` and `method: 'unavailable'` so the game keeps moving with the
 * on-screen subtitle only. Boundary events used for lip-sync are flagged
 * `synthetic` when the browser did not emit real ones, so no caller can mistake
 * an estimated mouth flap for measured speech timing.
 */

/* ------------------------------------------------------------------ */
/* Public shapes                                                       */
/* ------------------------------------------------------------------ */

export interface TtsBoundary {
  /** Index into the spoken text where the current word starts. */
  charIndex: number;
  charLength: number;
  /** The word itself - hand this straight to Mimo's mouth animation. */
  word: string;
  /** Milliseconds since speech actually started (our clock, not the engine's). */
  elapsedMs: number;
  /** TRUE when the browser emitted no boundary events and we estimated the beat. */
  synthetic: boolean;
}

export type TtsMethod = 'speech_synthesis' | 'unavailable' | 'muted';

export interface TtsResult {
  spoke: boolean;
  method: TtsMethod;
  elapsedMs: number;
  /** Name of the voice actually used, or null. */
  voice: string | null;
  /** Honest explanation - safe to show in the dev view. */
  detail: string;
}

export interface SpeakOptions {
  /** 0..2. Default 1.4 - Mimo is small and bright. */
  pitch?: number;
  /** 0.1..10. Default 1.05 - a touch quicker than a narrator. */
  rate?: number;
  /** 0..1. Default 1. */
  volume?: number;
  /** BCP-47 tag. Default 'en-US'. */
  lang?: string;
  /** Force a specific voice by name (dev view voice picker). */
  voiceName?: string;
  /** Cancel whatever Mimo was saying. Default true. */
  interrupt?: boolean;
  onStart?: () => void;
  /** Per-word hook for lip-sync. Check `synthetic` before trusting timing. */
  onBoundary?: (boundary: TtsBoundary) => void;
  signal?: AbortSignal;
}

export interface TtsSupport {
  available: boolean;
  enabled: boolean;
  voiceCount: number;
  /** The voice Mimo would use right now, or null if none is loaded yet. */
  selectedVoice: string | null;
  detail: string;
}

/** Mimo's default voice character. */
export const MIMO_VOICE = { pitch: 1.4, rate: 1.05, volume: 1 } as const;

/* ------------------------------------------------------------------ */
/* Availability                                                        */
/* ------------------------------------------------------------------ */

function synth(): SpeechSynthesis | null {
  if (typeof window === 'undefined') return null;
  const s = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  const hasUtterance =
    typeof (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance === 'function';
  return s && hasUtterance ? s : null;
}

export function isTtsAvailable(): boolean {
  return synth() !== null;
}

let enabled = true;

/** Global mute for Mimo's voice. Subtitles keep working. */
export function setTtsEnabled(on: boolean): void {
  enabled = on;
  if (!on) cancel();
}

export function isTtsEnabled(): boolean {
  return enabled;
}

/* ------------------------------------------------------------------ */
/* Voice selection                                                     */
/* ------------------------------------------------------------------ */

/** Voices that read as bright, small and friendly, best first. */
const PREFERRED_VOICES = [
  'google uk english female',
  'google us english',
  'microsoft aria',
  'microsoft jenny',
  'microsoft zira',
  'samantha',
  'karen',
  'tessa',
  'fiona',
  'moira',
  'serena',
  'victoria',
  'allison',
  'ava',
  'shelley',
];

let cachedVoices: SpeechSynthesisVoice[] = [];

/**
 * Voices arrive asynchronously in Chrome. Resolves with whatever exists by
 * `timeoutMs` - an empty list is a real answer, not a failure to report.
 */
export async function loadVoices(timeoutMs = 1200): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s) return [];
  const immediate = s.getVoices();
  if (immediate.length > 0) {
    cachedVoices = immediate;
    return immediate;
  }
  return new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      s.removeEventListener?.('voiceschanged', onChanged);
      cachedVoices = s.getVoices();
      resolve(cachedVoices);
    };
    const onChanged = () => finish();
    const poll = setInterval(() => {
      if (s.getVoices().length > 0) finish();
    }, 100);
    const timer = setTimeout(finish, timeoutMs);
    s.addEventListener?.('voiceschanged', onChanged);
  });
}

function scoreVoice(voice: SpeechSynthesisVoice, lang: string): number {
  const name = (voice.name || '').toLowerCase();
  const vLang = (voice.lang || '').toLowerCase().replace('_', '-');
  let score = 0;

  if (vLang === lang.toLowerCase()) score += 50;
  else if (vLang.startsWith('en')) score += 40;
  else return -100; // Mimo speaks English; a mismatched voice mangles the words.

  const preferred = PREFERRED_VOICES.findIndex((p) => name.includes(p));
  if (preferred >= 0) score += 30 - preferred;
  if (/female|woman|girl|child|kid/.test(name)) score += 8;
  if (/\bmale\b|\bman\b/.test(name) && !name.includes('female')) score -= 8;
  if (voice.localService) score += 3;
  if (voice.default) score += 1;
  return score;
}

/** The voice Mimo will use, or null when the browser has none loaded. */
export async function pickVoice(lang = 'en-US', voiceName?: string): Promise<SpeechSynthesisVoice | null> {
  const voices = cachedVoices.length > 0 ? cachedVoices : await loadVoices();
  if (voices.length === 0) return null;
  if (voiceName) {
    const exact = voices.find((v) => v.name === voiceName);
    if (exact) return exact;
  }
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -Infinity;
  for (const v of voices) {
    const s = scoreVoice(v, lang);
    if (s > bestScore) {
      bestScore = s;
      best = v;
    }
  }
  // Every voice scored as non-English: still better to speak than to be silent.
  return best ?? voices[0];
}

export async function listVoices(): Promise<{ name: string; lang: string; local: boolean }[]> {
  const voices = await loadVoices();
  return voices.map((v) => ({ name: v.name, lang: v.lang, local: v.localService }));
}

export async function describeTtsSupport(lang = 'en-US'): Promise<TtsSupport> {
  if (!isTtsAvailable()) {
    return {
      available: false,
      enabled,
      voiceCount: 0,
      selectedVoice: null,
      detail: 'This browser has no speechSynthesis; Mimo speaks in subtitles only.',
    };
  }
  const voices = await loadVoices();
  const chosen = await pickVoice(lang);
  return {
    available: true,
    enabled,
    voiceCount: voices.length,
    selectedVoice: chosen?.name ?? null,
    detail: chosen
      ? `speechSynthesis ready with ${voices.length} voices; Mimo uses "${chosen.name}".`
      : 'speechSynthesis exists but reported no voices; Mimo falls back to subtitles.',
  };
}

/* ------------------------------------------------------------------ */
/* Speaking                                                            */
/* ------------------------------------------------------------------ */

/** ~14 characters per second at rate 1 - used only for the safety timeout
 *  and for synthetic lip-sync beats, never reported as measured timing. */
const CHARS_PER_SECOND = 14;
const SAFETY_MARGIN_MS = 4000;
/** If the browser emits no real boundary by then, start estimating. */
const SYNTHETIC_BOUNDARY_DELAY_MS = 350;

export function estimateSpeechDurationMs(text: string, rate: number = MIMO_VOICE.rate): number {
  const chars = Math.max(1, text.trim().length);
  return Math.round((chars / (CHARS_PER_SECOND * Math.max(0.1, rate))) * 1000);
}

let currentCleanup: (() => void) | null = null;

/** Stops Mimo mid-sentence. Any pending speak() resolves with spoke:false. */
export function cancel(): void {
  const s = synth();
  currentCleanup?.();
  currentCleanup = null;
  try {
    s?.cancel();
  } catch {
    /* nothing playing */
  }
}

function wordsWithIndex(text: string): { word: string; index: number }[] {
  const out: { word: string; index: number }[] = [];
  const re = /\S+/g;
  let m = re.exec(text);
  while (m) {
    out.push({ word: m[0], index: m.index });
    m = re.exec(text);
  }
  return out;
}

/**
 * Mimo says a line. Always resolves, never rejects, never blocks the game.
 *
 * Resolves when the utterance ends, is interrupted, or the browser proves it
 * cannot speak. Callers should render the subtitle regardless of the result.
 */
export function speak(text: string, opts: SpeakOptions = {}): Promise<TtsResult> {
  const startedAt = now();
  const line = (text ?? '').trim();
  const s = synth();

  if (!s) {
    return Promise.resolve({
      spoke: false,
      method: 'unavailable',
      elapsedMs: 0,
      voice: null,
      detail: 'speechSynthesis is not available in this browser; subtitle only.',
    });
  }
  if (!enabled) {
    return Promise.resolve({
      spoke: false,
      method: 'muted',
      elapsedMs: 0,
      voice: null,
      detail: 'Mimo\'s voice is muted; subtitle only.',
    });
  }
  if (!line) {
    return Promise.resolve({
      spoke: false,
      method: 'speech_synthesis',
      elapsedMs: 0,
      voice: null,
      detail: 'nothing to say',
    });
  }
  if (opts.signal?.aborted) {
    return Promise.resolve({
      spoke: false,
      method: 'speech_synthesis',
      elapsedMs: 0,
      voice: null,
      detail: 'cancelled before speaking',
    });
  }

  if (opts.interrupt !== false) cancel();

  return new Promise<TtsResult>((resolve) => {
    void (async () => {
      const voice = await pickVoice(opts.lang ?? 'en-US', opts.voiceName);
      if (opts.signal?.aborted) {
        resolve({
          spoke: false, method: 'speech_synthesis', elapsedMs: Math.round(now() - startedAt),
          voice: null, detail: 'cancelled before speaking',
        });
        return;
      }

      const utterance = new SpeechSynthesisUtterance(line);
      utterance.pitch = opts.pitch ?? MIMO_VOICE.pitch;
      utterance.rate = opts.rate ?? MIMO_VOICE.rate;
      utterance.volume = opts.volume ?? MIMO_VOICE.volume;
      utterance.lang = opts.lang ?? voice?.lang ?? 'en-US';
      if (voice) utterance.voice = voice;

      let settled = false;
      let speechStartedAt = 0;
      let sawNativeBoundary = false;
      let syntheticTimer: ReturnType<typeof setTimeout> | null = null;
      let syntheticInterval: ReturnType<typeof setInterval> | null = null;
      let safetyTimer: ReturnType<typeof setTimeout> | null = null;

      const stopSynthetic = () => {
        if (syntheticTimer !== null) clearTimeout(syntheticTimer);
        if (syntheticInterval !== null) clearInterval(syntheticInterval);
        syntheticTimer = null;
        syntheticInterval = null;
      };

      const cleanup = () => {
        stopSynthetic();
        if (safetyTimer !== null) clearTimeout(safetyTimer);
        safetyTimer = null;
        utterance.onstart = null;
        utterance.onboundary = null;
        utterance.onend = null;
        utterance.onerror = null;
        opts.signal?.removeEventListener('abort', onAbort);
        if (currentCleanup === cleanup) currentCleanup = null;
      };

      const settle = (result: TtsResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      function onAbort() {
        try {
          s?.cancel();
        } catch {
          /* nothing playing */
        }
        settle({
          spoke: true,
          method: 'speech_synthesis',
          elapsedMs: Math.round(now() - startedAt),
          voice: voice?.name ?? null,
          detail: 'interrupted',
        });
      }

      /** Estimated per-word beats, only when the browser gives us none. */
      const startSyntheticBoundaries = () => {
        if (!opts.onBoundary) return;
        const words = wordsWithIndex(line);
        if (words.length === 0) return;
        const total = estimateSpeechDurationMs(line, utterance.rate);
        const step = Math.max(90, Math.round(total / words.length));
        let i = 0;
        syntheticInterval = setInterval(() => {
          if (settled || i >= words.length) {
            stopSynthetic();
            return;
          }
          const w = words[i];
          i += 1;
          opts.onBoundary?.({
            charIndex: w.index,
            charLength: w.word.length,
            word: w.word,
            elapsedMs: Math.round(now() - (speechStartedAt || startedAt)),
            synthetic: true,
          });
        }, step);
      };

      utterance.onstart = () => {
        speechStartedAt = now();
        opts.onStart?.();
        if (opts.onBoundary) {
          syntheticTimer = setTimeout(() => {
            if (!sawNativeBoundary && !settled) startSyntheticBoundaries();
          }, SYNTHETIC_BOUNDARY_DELAY_MS);
        }
      };

      utterance.onboundary = (event: SpeechSynthesisEvent) => {
        if (event.name && event.name !== 'word') return;
        sawNativeBoundary = true;
        stopSynthetic();
        if (!opts.onBoundary) return;
        const charIndex = event.charIndex ?? 0;
        const rest = line.slice(charIndex);
        const match = /^\S+/.exec(rest);
        const word = match ? match[0] : '';
        const charLength =
          (event as SpeechSynthesisEvent & { charLength?: number }).charLength || word.length;
        opts.onBoundary({
          charIndex,
          charLength,
          word,
          elapsedMs: Math.round(now() - (speechStartedAt || startedAt)),
          synthetic: false,
        });
      };

      utterance.onend = () => {
        settle({
          spoke: true,
          method: 'speech_synthesis',
          elapsedMs: Math.round(now() - startedAt),
          voice: voice?.name ?? null,
          detail: voice ? `spoken with "${voice.name}"` : 'spoken with the browser default voice',
        });
      };

      utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
        const code = event.error ?? 'unknown';
        // 'interrupted'/'canceled' are our own cancel() - not a failure.
        const interrupted = code === 'interrupted' || code === 'canceled';
        settle({
          spoke: interrupted,
          method: interrupted ? 'speech_synthesis' : 'unavailable',
          elapsedMs: Math.round(now() - startedAt),
          voice: voice?.name ?? null,
          detail: interrupted ? 'interrupted' : `speechSynthesis error: ${code}`,
        });
      };

      opts.signal?.addEventListener('abort', onAbort, { once: true });
      currentCleanup = cleanup;

      // Some builds silently drop an utterance (backgrounded tab, dead voice).
      // Resolve honestly instead of hanging the story loop forever.
      safetyTimer = setTimeout(
        () => {
          settle({
            spoke: false,
            method: 'unavailable',
            elapsedMs: Math.round(now() - startedAt),
            voice: voice?.name ?? null,
            detail: 'speechSynthesis never finished the utterance; continuing with the subtitle.',
          });
        },
        estimateSpeechDurationMs(line, utterance.rate) + SAFETY_MARGIN_MS,
      );

      try {
        s.speak(utterance);
      } catch (err) {
        settle({
          spoke: false,
          method: 'unavailable',
          elapsedMs: Math.round(now() - startedAt),
          voice: voice?.name ?? null,
          detail: `speechSynthesis.speak() threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    })();
  });
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
