/**
 * Speech recognition for the reading beats, in the browser only.
 *
 * TRUTHFULNESS CONTRACT - read this before changing anything here.
 * -----------------------------------------------------------------
 * This module NEVER fabricates a transcript, a confidence, or a match.
 * `heard` is always a string a real recogniser produced. If the Web Speech API
 * is missing, the page is not a secure context, the mic is blocked, the
 * recogniser errors, or the child simply says nothing, the returned attempt has
 * `method: 'unavailable'` plus an honest `reason`, and the calling interaction
 * must fall back to tap-to-choose. A `method: 'unavailable'` attempt is NOT a
 * failed reading attempt and must not be logged as `word_failed`.
 *
 * Support today: Chrome/Edge/Safari expose (webkit)SpeechRecognition. Firefox
 * does not, and we say so rather than pretending.
 */

import { scoreWord } from '../shared/wordMatch.ts';
import type { WordScore } from '../shared/wordMatch.ts';

export type { WordScore };
export { scoreWord };

/* ------------------------------------------------------------------ */
/* Public shapes                                                       */
/* ------------------------------------------------------------------ */

/** How the attempt was captured. 'unavailable' means: fall back to tapping. */
export type SpeechMethod = 'speech' | 'unavailable';

export type SpeechUnavailableReason =
  | 'no_api'              // browser has no SpeechRecognition (e.g. Firefox)
  | 'insecure_context'    // needs https:// or localhost
  | 'permission_denied'   // child/parent blocked the mic
  | 'no_microphone'       // no capture device
  | 'no_speech'           // mic worked, nothing was said
  | 'network'             // Chrome's recogniser needs the network
  | 'aborted'             // we or the UI cancelled the listen
  | 'start_failed'        // recognition.start() threw
  | 'error';              // anything else the recogniser reported

export interface SpeechAttempt {
  /** Exactly what the recogniser transcribed. '' when nothing was heard. */
  heard: string;
  matched: boolean;
  /** 0..1 from the word matcher, NOT the recogniser's own score. */
  confidence: number;
  elapsedMs: number;
  method: SpeechMethod;
  /** Present only when method === 'unavailable'. */
  reason: SpeechUnavailableReason | null;
  /** Human-readable truth for the dev view / console. */
  detail: string;
  /** Edit distance to the target, when we had something to score. */
  distance: number;
  /** Which rule matched: exact | homophone | phonetic | near_miss | decoy | none. */
  tier: WordScore['tier'];
  /** Alternative transcripts the recogniser offered, best first. */
  alternatives: string[];
  /** The recogniser's OWN confidence for the primary transcript, if it gave one. */
  recognitionConfidence: number | null;
  /** The word we were listening for. */
  word: string;
}

export interface ListenOptions {
  /** How long to listen before giving up. Default 5000ms. */
  timeoutMs?: number;
  /** BCP-47 tag. Default 'en-US'. */
  lang?: string;
  /** Distractor words, so reading a different word is scored honestly. */
  decoys?: string[];
  /** Extra time after we stop the mic for final results to arrive. Default 900ms. */
  graceMs?: number;
  onStart?: () => void;
  /** Fired when the recogniser detects sound - good for a listening animation. */
  onSpeechStart?: () => void;
  /** Live partial transcript. Never treat this as a result. */
  onInterim?: (text: string) => void;
  signal?: AbortSignal;
}

export type MicPermissionState = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface SpeechSupport {
  available: boolean;
  /** Which global we found, or null. */
  api: 'SpeechRecognition' | 'webkitSpeechRecognition' | null;
  secureContext: boolean;
  detail: string;
}

/* ------------------------------------------------------------------ */
/* Minimal local typings for the Web Speech API                        */
/* Declared locally so we never collide with whatever lib.dom ships.   */
/* ------------------------------------------------------------------ */

interface AlternativeLike { transcript: string; confidence: number }
interface ResultLike { isFinal: boolean; length: number; [index: number]: AlternativeLike }
interface ResultListLike { length: number; [index: number]: ResultLike }
interface RecognitionEventLike { resultIndex: number; results: ResultListLike }
interface RecognitionErrorEventLike { error: string; message?: string }

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => RecognitionLike;

function findRecognition(): { ctor: RecognitionCtor; api: 'SpeechRecognition' | 'webkitSpeechRecognition' } | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  if (typeof w.SpeechRecognition === 'function') {
    return { ctor: w.SpeechRecognition as RecognitionCtor, api: 'SpeechRecognition' };
  }
  if (typeof w.webkitSpeechRecognition === 'function') {
    return { ctor: w.webkitSpeechRecognition as RecognitionCtor, api: 'webkitSpeechRecognition' };
  }
  return null;
}

function isSecure(): boolean {
  if (typeof window === 'undefined') return false;
  // Older browsers lack isSecureContext; only treat an explicit false as insecure.
  return (window as unknown as { isSecureContext?: boolean }).isSecureContext !== false;
}

/* ------------------------------------------------------------------ */
/* Capability reporting                                                */
/* ------------------------------------------------------------------ */

/** Real feature detection. False on Firefox, in workers, and over plain http. */
export function isSpeechAvailable(): boolean {
  return findRecognition() !== null && isSecure();
}

/** Sync capability snapshot, safe to render verbatim. */
export function speechSupport(): SpeechSupport {
  const found = findRecognition();
  const secure = isSecure();
  if (!found) {
    return {
      available: false,
      api: null,
      secureContext: secure,
      detail:
        'This browser has no SpeechRecognition API (Firefox does not ship one). ' +
        'Reading beats will use tap-to-choose.',
    };
  }
  if (!secure) {
    return {
      available: false,
      api: found.api,
      secureContext: false,
      detail:
        `${found.api} exists but the page is not a secure context. ` +
        'Serve over https:// or localhost to use the microphone.',
    };
  }
  return {
    available: true,
    api: found.api,
    secureContext: true,
    detail: `${found.api} available; the child can read out loud.`,
  };
}

/** Capability snapshot including the current mic permission. Never throws. */
export async function describeSpeechSupport(): Promise<SpeechSupport & { permission: MicPermissionState }> {
  return { ...speechSupport(), permission: await micPermission() };
}

/* ------------------------------------------------------------------ */
/* Microphone permission                                               */
/* ------------------------------------------------------------------ */

/**
 * Resolves the mic permission WITHOUT prompting and without throwing.
 * 'unknown' means the browser would not tell us - that is not a denial.
 */
export async function micPermission(): Promise<MicPermissionState> {
  if (typeof navigator === 'undefined') return 'unknown';
  const perms = (navigator as Navigator & {
    permissions?: { query?: (d: { name: string }) => Promise<{ state: string }> };
  }).permissions;
  if (!perms?.query) return 'unknown';
  try {
    const status = await perms.query({ name: 'microphone' });
    if (status.state === 'granted' || status.state === 'denied' || status.state === 'prompt') {
      return status.state;
    }
    return 'unknown';
  } catch {
    // Firefox rejects the 'microphone' descriptor outright.
    return 'unknown';
  }
}

/**
 * Triggers the browser's mic prompt from a user gesture and releases the
 * stream immediately. Call this once behind a "Let's read!" button so the
 * first real listen is not eaten by the permission dialog. Never throws.
 */
export async function requestMicPermission(): Promise<MicPermissionState> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'unknown';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return 'granted';
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'unknown';
    return 'unknown';
  }
}

/* ------------------------------------------------------------------ */
/* Listening                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_GRACE_MS = 900;
const MAX_ALTERNATIVES = 5;
/** Only the top few alternatives are trustworthy enough to score. */
const SCORED_ALTERNATIVES = 3;

let active: { recognition: RecognitionLike; cancel: (reason: SpeechUnavailableReason) => void } | null = null;

function unavailable(
  word: string,
  reason: SpeechUnavailableReason,
  detail: string,
  elapsedMs: number,
  heard = '',
): SpeechAttempt {
  return {
    heard,
    matched: false,
    confidence: 0,
    elapsedMs,
    method: 'unavailable',
    reason,
    detail,
    distance: 0,
    tier: 'none',
    alternatives: [],
    recognitionConfidence: null,
    word,
  };
}

const ERROR_REASONS: Record<string, SpeechUnavailableReason> = {
  'not-allowed': 'permission_denied',
  'service-not-allowed': 'permission_denied',
  'audio-capture': 'no_microphone',
  'no-speech': 'no_speech',
  network: 'network',
  aborted: 'aborted',
};

const ERROR_DETAILS: Record<SpeechUnavailableReason, string> = {
  no_api: 'this browser has no SpeechRecognition API',
  insecure_context: 'the page is not a secure context, so the mic is blocked',
  permission_denied: 'microphone permission was denied',
  no_microphone: 'no microphone could be opened',
  no_speech: 'the microphone was open but nothing was said',
  network: 'the recogniser could not reach its speech service',
  aborted: 'listening was cancelled',
  start_failed: 'recognition.start() threw',
  error: 'the recogniser reported an error',
};

/** Stops any listen in progress. The pending promise resolves as 'aborted'. */
export function stopListening(): void {
  active?.cancel('aborted');
}

/** True while a listen is in progress. */
export function isListening(): boolean {
  return active !== null;
}

/**
 * Listens for `word` for a short window and scores what the recogniser heard.
 *
 * Resolves with method 'speech' ONLY when a real transcript came back.
 * Everything else resolves with method 'unavailable' so the caller can offer
 * tap-to-choose instead. This function never rejects.
 */
export function listenForWord(word: string, opts: ListenOptions = {}): Promise<SpeechAttempt> {
  const startedAt = now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;

  const found = findRecognition();
  if (!found) {
    return Promise.resolve(
      unavailable(word, 'no_api', ERROR_DETAILS.no_api, 0),
    );
  }
  if (!isSecure()) {
    return Promise.resolve(
      unavailable(word, 'insecure_context', ERROR_DETAILS.insecure_context, 0),
    );
  }
  if (opts.signal?.aborted) {
    return Promise.resolve(unavailable(word, 'aborted', ERROR_DETAILS.aborted, 0));
  }

  // Only one recogniser may run at a time; a new listen supersedes the old.
  active?.cancel('aborted');

  return new Promise<SpeechAttempt>((resolve) => {
    const recognition = new found.ctor();
    recognition.lang = opts.lang ?? 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = MAX_ALTERNATIVES;

    const finals: string[] = [];
    const alternatives: string[] = [];
    let primaryConfidence: number | null = null;
    let settled = false;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let failure: { reason: SpeechUnavailableReason; detail: string } | null = null;

    const clearTimers = () => {
      if (stopTimer !== null) clearTimeout(stopTimer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      stopTimer = null;
      graceTimer = null;
    };

    const detach = () => {
      recognition.onstart = null;
      recognition.onspeechstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      opts.signal?.removeEventListener('abort', onAbort);
      if (active?.recognition === recognition) active = null;
    };

    const settle = (attempt: SpeechAttempt) => {
      if (settled) return;
      settled = true;
      clearTimers();
      detach();
      resolve(attempt);
    };

    const finish = () => {
      if (settled) return;
      const heard = finals.join(' ').trim() || alternatives[0] || '';
      const elapsedMs = Math.round(now() - startedAt);

      if (!heard) {
        const reason = failure?.reason ?? 'no_speech';
        settle(unavailable(word, reason, failure?.detail ?? ERROR_DETAILS[reason], elapsedMs));
        return;
      }

      // Score the primary transcript plus the recogniser's top alternatives,
      // and keep the best. All of these were genuinely proposed by the API.
      const pool = [heard, ...alternatives.slice(0, SCORED_ALTERNATIVES)];
      let best: WordScore = scoreWord(word, heard, { decoys: opts.decoys });
      for (const candidate of pool.slice(1)) {
        const s = scoreWord(word, candidate, { decoys: opts.decoys });
        const better =
          (s.matched && !best.matched) ||
          (s.matched === best.matched && s.confidence > best.confidence);
        if (better) best = s;
      }

      settle({
        heard,
        matched: best.matched,
        confidence: best.confidence,
        elapsedMs,
        method: 'speech',
        reason: null,
        detail: best.reason,
        distance: best.distance,
        tier: best.tier,
        alternatives: alternatives.slice(0, MAX_ALTERNATIVES),
        recognitionConfidence: primaryConfidence,
        word,
      });
    };

    const cancel = (reason: SpeechUnavailableReason) => {
      failure = { reason, detail: ERROR_DETAILS[reason] };
      try {
        recognition.abort();
      } catch {
        /* already stopped */
      }
      settle(unavailable(word, reason, ERROR_DETAILS[reason], Math.round(now() - startedAt)));
    };

    function onAbort() {
      cancel('aborted');
    }

    recognition.onstart = () => opts.onStart?.();
    recognition.onspeechstart = () => opts.onSpeechStart?.();

    recognition.onresult = (event) => {
      const results = event.results;
      const interim: string[] = [];
      finals.length = 0;
      alternatives.length = 0;

      for (let i = 0; i < results.length; i += 1) {
        const result = results[i];
        const top = result[0];
        if (!top) continue;
        if (result.isFinal) {
          finals.push(top.transcript.trim());
          if (primaryConfidence === null && typeof top.confidence === 'number') {
            primaryConfidence = top.confidence;
          }
          for (let a = 0; a < result.length && a < MAX_ALTERNATIVES; a += 1) {
            const alt = result[a]?.transcript?.trim();
            if (alt && !alternatives.includes(alt)) alternatives.push(alt);
          }
        } else {
          interim.push(top.transcript.trim());
          if (alternatives.length === 0 && top.transcript.trim()) {
            alternatives.push(top.transcript.trim());
          }
        }
      }

      const partial = [...finals, ...interim].join(' ').trim();
      if (partial) opts.onInterim?.(partial);
    };

    recognition.onerror = (event) => {
      const reason = ERROR_REASONS[event.error] ?? 'error';
      const detail = event.message
        ? `${ERROR_DETAILS[reason]} (${event.error}: ${event.message})`
        : `${ERROR_DETAILS[reason]} (${event.error})`;
      failure = { reason, detail };
      // Let onend settle it - a 'no-speech' error can still be followed by a
      // late final result on some builds.
    };

    recognition.onend = () => {
      finish();
    };

    opts.signal?.addEventListener('abort', onAbort, { once: true });
    active = { recognition, cancel };

    try {
      recognition.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      settle(
        unavailable(word, 'start_failed', `${ERROR_DETAILS.start_failed}: ${message}`, Math.round(now() - startedAt)),
      );
      return;
    }

    stopTimer = setTimeout(() => {
      try {
        recognition.stop();
      } catch {
        /* nothing to stop */
      }
      // Some builds never fire onend after stop(); guarantee a resolution.
      graceTimer = setTimeout(() => {
        try {
          recognition.abort();
        } catch {
          /* already gone */
        }
        finish();
      }, graceMs);
    }, timeoutMs);
  });
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
