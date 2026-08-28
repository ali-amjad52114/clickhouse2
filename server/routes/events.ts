/**
 * Event ingest.
 *
 * POST /api/events        { events: GameEvent[] } -> IngestResponse
 * GET  /api/events/recent ?childId=&limit=        -> RecentEventsResponse
 *
 * Ingest ALWAYS answers 200. Analytics is a passenger, never a blocker: if
 * ClickHouse is down or unconfigured the events land in the durable on-disk
 * queue and the response says so plainly. The game keeps playing either way.
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { insertEvents, flushQueue, status } from '../db/clickhouse.ts';
import { recentEvents } from '../services/analytics.ts';
import type { GameEvent } from '../../src/shared/types.ts';
import type { FlushResponse, IngestResponse } from '../../src/shared/analyticsTypes.ts';

const router = Router();

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const eventTypes = [
  'story_started', 'story_completed', 'story_abandoned',
  'scene_started', 'scene_completed',
  'interaction_started', 'interaction_completed',
  'object_tapped', 'wrong_choice', 'correct_choice',
  'word_presented', 'word_attempted', 'word_failed', 'word_succeeded',
  'hint_offered', 'hint_accepted', 'hint_ignored',
  'companion_spoke',
] as const;

const interactionTypes = [
  '', 'tap_target', 'choose_object', 'drag_drop', 'collect_items',
  'path_choice', 'reading_choice', 'simple_character_action',
] as const;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** ClickHouse column widths. Overflow would fail the whole batch, so clamp. */
const MAX_ATTEMPT = 255;        // UInt8
const MAX_RESPONSE_MS = 4_294_967_295; // UInt32
const MAX_EVENTS_PER_REQUEST = 500;
const MAX_ISSUES_REPORTED = 20;

const gameEventSchema = z.object({
  event_id: z.string().default(''),
  timestamp: z.string().default(''),
  session_id: z.string().default(''),
  child_id: z.string().min(1, 'child_id is required'),
  story_id: z.string().default(''),
  scene_id: z.string().default(''),
  event_type: z.enum(eventTypes),
  interaction_type: z.enum(interactionTypes).default(''),
  word: z.string().default(''),
  phoneme: z.string().default(''),
  correct: z.boolean().nullable().default(null),
  attempt_number: z.coerce.number().int().min(0).catch(0).default(0),
  response_time_ms: z.coerce.number().int().min(0).catch(0).default(0),
  hint_used: z.boolean().default(false),
  companion_intervention: z.string().default(''),
  // Callers reasonably send an object here; the column is a String.
  metadata: z.preprocess(
    (v) => (v === undefined || v === null ? '{}' : typeof v === 'string' ? v : JSON.stringify(v)),
    z.string(),
  ),
});

interface Normalised {
  event: GameEvent;
  notes: string[];
}

/**
 * Turns a validated event into a row ClickHouse will definitely accept.
 * Every correction is reported back to the caller - nothing is fixed silently.
 */
function normalise(parsed: z.infer<typeof gameEventSchema>, index: number): Normalised {
  const notes: string[] = [];

  let eventId = parsed.event_id;
  if (!UUID_RE.test(eventId)) {
    const generated = randomUUID();
    notes.push(
      `event[${index}]: event_id ${eventId ? `"${eventId}"` : '(empty)'} is not a UUID; ` +
        `stored as ${generated}`,
    );
    eventId = generated;
  }

  let timestamp = parsed.timestamp;
  const parsedDate = new Date(timestamp);
  if (!timestamp || Number.isNaN(parsedDate.getTime())) {
    timestamp = new Date().toISOString();
    notes.push(`event[${index}]: timestamp "${parsed.timestamp}" unparseable; stored as ${timestamp}`);
  } else {
    timestamp = parsedDate.toISOString();
  }

  let attempt = parsed.attempt_number;
  if (attempt > MAX_ATTEMPT) {
    notes.push(`event[${index}]: attempt_number ${attempt} clamped to ${MAX_ATTEMPT} (UInt8 column)`);
    attempt = MAX_ATTEMPT;
  }

  let responseMs = parsed.response_time_ms;
  if (responseMs > MAX_RESPONSE_MS) {
    notes.push(`event[${index}]: response_time_ms clamped to ${MAX_RESPONSE_MS} (UInt32 column)`);
    responseMs = MAX_RESPONSE_MS;
  }

  return {
    event: {
      event_id: eventId,
      timestamp,
      session_id: parsed.session_id,
      child_id: parsed.child_id,
      story_id: parsed.story_id,
      scene_id: parsed.scene_id,
      event_type: parsed.event_type,
      interaction_type: parsed.interaction_type,
      word: parsed.word,
      phoneme: parsed.phoneme,
      correct: parsed.correct,
      attempt_number: attempt,
      response_time_ms: responseMs,
      hint_used: parsed.hint_used,
      companion_intervention: parsed.companion_intervention,
      metadata: parsed.metadata,
    },
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* POST /api/events                                                    */
/* ------------------------------------------------------------------ */

router.post('/', async (req, res) => {
  const issues: string[] = [];
  const body = req.body as unknown;

  const raw =
    body && typeof body === 'object' && Array.isArray((body as { events?: unknown }).events)
      ? ((body as { events: unknown[] }).events)
      : null;

  if (raw === null) {
    const payload: IngestResponse = {
      inserted: 0,
      queued: 0,
      accepted: 0,
      rejected: 0,
      error: 'body must be { events: GameEvent[] }',
      issues: ['request body did not contain an "events" array'],
    };
    return res.status(200).json(payload);
  }

  const batch = raw.slice(0, MAX_EVENTS_PER_REQUEST);
  if (raw.length > MAX_EVENTS_PER_REQUEST) {
    issues.push(
      `received ${raw.length} events; only the first ${MAX_EVENTS_PER_REQUEST} were accepted. ` +
        'Send smaller batches.',
    );
  }

  const events: GameEvent[] = [];
  let rejected = 0;

  batch.forEach((candidate, i) => {
    const parsed = gameEventSchema.safeParse(candidate);
    if (!parsed.success) {
      rejected += 1;
      if (issues.length < MAX_ISSUES_REPORTED) {
        const detail = parsed.error.issues
          .map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`)
          .join('; ');
        issues.push(`event[${i}] rejected - ${detail}`);
      }
      return;
    }
    const { event, notes } = normalise(parsed.data, i);
    for (const note of notes) if (issues.length < MAX_ISSUES_REPORTED) issues.push(note);
    events.push(event);
  });

  const outcome = await insertEvents(events);

  const payload: IngestResponse = {
    inserted: outcome.inserted,
    queued: outcome.queued,
    accepted: events.length,
    rejected,
    error: outcome.error,
    issues,
  };
  return res.status(200).json(payload);
});

/* ------------------------------------------------------------------ */
/* GET /api/events/recent                                              */
/* ------------------------------------------------------------------ */

router.get('/recent', async (req, res) => {
  const childId = typeof req.query.childId === 'string' && req.query.childId ? req.query.childId : null;
  res.json(await recentEvents(childId, req.query.limit));
});

/** Replays anything stranded in the on-disk queue. */
router.post('/flush', async (_req, res) => {
  const outcome = await flushQueue();
  const payload: FlushResponse = {
    inserted: outcome.inserted,
    queued: outcome.queued,
    error: outcome.error,
  };
  res.json(payload);
});

/** What the writer side thinks is true right now. */
router.get('/status', (_req, res) => res.json(status()));

export default router;
