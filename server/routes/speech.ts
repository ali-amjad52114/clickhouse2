/**
 * Speech endpoints.
 *
 *   GET  /api/speech/capabilities  - what the SERVER can actually do
 *   POST /api/speech/score         - { word, heard, decoys? } -> match verdict
 *   GET  /api/speech/score         - same, as query params, for curl/demos
 *
 * TRUTHFULNESS CONTRACT
 * ---------------------
 * There is NO server-side speech recognition in this deployment and this file
 * never pretends otherwise. Recognition and synthesis both run in the child's
 * browser (Web Speech API). What the server owns is the SCORING RULE: the same
 * pure function the browser uses, exposed over HTTP so it can be tested and so
 * a judge can reproduce any verdict the game showed a child.
 *
 * This endpoint receives a transcript; it never produces one.
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  scoreWord,
  normalizeWord,
  phoneticKey,
  levenshtein,
  SCORING_ALGORITHM,
} from '../../src/shared/wordMatch.ts';
import type { WordScore } from '../../src/shared/wordMatch.ts';

/** Re-exported so unit tests and the acceptance script can call it directly. */
export { scoreWord, normalizeWord, phoneticKey, levenshtein, SCORING_ALGORITHM };
export type { WordScore };

const router = Router();

/* ------------------------------------------------------------------ */
/* GET /api/speech/capabilities                                        */
/* ------------------------------------------------------------------ */

export interface SpeechCapabilities {
  serverRecognition: { configured: false; provider: null; detail: string };
  serverSynthesis: { configured: false; provider: null; detail: string };
  scoring: {
    available: true;
    algorithm: string;
    endpoint: string;
    tiers: string[];
    detail: string;
  };
  browser: {
    recognition: string;
    synthesis: string;
    fallback: string;
  };
}

const CAPABILITIES: SpeechCapabilities = {
  serverRecognition: {
    configured: false,
    provider: null,
    detail:
      'No server-side ASR is configured. This project ships no Whisper/Deepgram/Google ' +
      'Speech integration, so the server cannot transcribe audio and none is uploaded to it.',
  },
  serverSynthesis: {
    configured: false,
    provider: null,
    detail:
      'No server-side TTS is configured. Mimo speaks through the browser SpeechSynthesis API; ' +
      'no audio files exist in this project.',
  },
  scoring: {
    available: true,
    algorithm: SCORING_ALGORITHM,
    endpoint: 'POST /api/speech/score',
    tiers: ['exact', 'homophone', 'phonetic', 'near_miss', 'decoy', 'none'],
    detail:
      'Pure, deterministic word matching shared byte-for-byte with the browser ' +
      '(src/shared/wordMatch.ts), so a client verdict can always be reproduced here.',
  },
  browser: {
    recognition:
      'Recognition runs in the child\'s browser via (webkit)SpeechRecognition. The server ' +
      'cannot detect whether a given browser supports it - the client reports that with ' +
      'isSpeechAvailable() from src/services/speech.ts. Firefox has no support.',
    synthesis:
      'Mimo\'s voice uses window.speechSynthesis with pitch 1.4 / rate 1.05 ' +
      '(src/services/tts.ts). When it is missing the game shows subtitles only.',
    fallback:
      'When recognition is unavailable, permission is denied, or nothing is heard, the ' +
      'reading interaction falls back to tap-to-choose. A fallback attempt is never ' +
      'recorded as a failed reading attempt.',
  },
};

router.get('/capabilities', (_req, res) => res.json(CAPABILITIES));

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

const MAX_LEN = 120;
const MAX_DECOYS = 12;

const scoreSchema = z.object({
  word: z.string().min(1, 'word is required').max(MAX_LEN),
  heard: z.string().max(MAX_LEN).default(''),
  decoys: z.array(z.string().max(MAX_LEN)).max(MAX_DECOYS).optional(),
});

export interface ScoreResponse extends WordScore {
  /** Echo of the raw inputs, so a stored verdict is self-describing. */
  input: { word: string; heard: string; decoys: string[] };
  algorithm: string;
}

function buildResponse(word: string, heard: string, decoys: string[]): ScoreResponse {
  const score = scoreWord(word, heard, { decoys });
  return { ...score, input: { word, heard, decoys }, algorithm: SCORING_ALGORITHM };
}

router.post('/score', (req, res) => {
  const parsed = scoreSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return res.status(400).json({ error: `invalid body - ${detail}`, expected: '{ word, heard, decoys? }' });
  }
  const { word, heard, decoys } = parsed.data;
  return res.json(buildResponse(word, heard, decoys ?? []));
});

/** Convenience mirror of POST /score so the endpoint is curl-able in a demo. */
router.get('/score', (req, res) => {
  const word = typeof req.query.word === 'string' ? req.query.word : '';
  const heard = typeof req.query.heard === 'string' ? req.query.heard : '';
  const decoysRaw = typeof req.query.decoys === 'string' ? req.query.decoys : '';
  if (!word) {
    return res.status(400).json({ error: 'word is required', expected: '?word=BRAVE&heard=brav&decoys=cave,grave' });
  }
  const decoys = decoysRaw.split(',').map((d) => d.trim()).filter(Boolean).slice(0, MAX_DECOYS);
  return res.json(buildResponse(word.slice(0, MAX_LEN), heard.slice(0, MAX_LEN), decoys));
});

export default router;
