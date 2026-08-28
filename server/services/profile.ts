/**
 * Child profile: the derived answer to "what is this child struggling with,
 * and what kind of help actually works for them?"
 *
 * Two evidence sources, one shape:
 *
 *   clickhouse  - the real path. Uses the SQL + materialized views in
 *                 services/analytics.ts.
 *   local_queue - the fallback. When ClickHouse is unreachable, events are
 *                 still durably recorded in .data/event-queue.jsonl, so we
 *                 derive the SAME profile from those rows in TypeScript.
 *
 * The fallback is NOT a simulation: it reads genuinely recorded gameplay
 * events. Every response states which source produced it so nothing is ever
 * presented as a ClickHouse result when it is not one.
 *
 * Nothing here hardcodes a phonics pattern. Patterns are discovered from the
 * `phoneme` column, so a child who played the star story surfaces 'br' and a
 * child who played the grapes story surfaces 'tr'.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { childEngagement, childHints, childPatterns } from './analytics';
import { isConfigured, ping, query, CH } from '../db/clickhouse';
import type {
  ChildProfile, GameEvent, InteractionType, PatternStat,
} from '../../src/shared/types';

const QUEUE_FILE = join(process.cwd(), '.data', 'event-queue.jsonl');

/** Evidence thresholds. Exposed so the UI can explain itself. */
export const THRESHOLDS = {
  /** Resolved attempts needed before a pattern verdict is trustworthy. */
  minResolvedForConfidence: 3,
  /** Distinct words needed so one hard word cannot condemn a pattern. */
  minDistinctWords: 2,
  /** Accuracy below this is "weak". */
  weakBelow: 0.6,
  /** Accuracy at or above this is "strong". */
  strongAtOrAbove: 0.85,
  /** Interaction starts needed before calling something preferred. */
  minStartsForPreference: 2,
};

export type EvidenceSource = 'clickhouse' | 'local_queue' | 'none';

export interface ProfileResult extends ChildProfile {
  evidenceSource: EvidenceSource;
  sourceDetail: string;
  thresholds: typeof THRESHOLDS;
}

/* ------------------------------------------------------------------ */
/* Event loading                                                       */
/* ------------------------------------------------------------------ */

function readQueue(childId: string): GameEvent[] {
  if (!existsSync(QUEUE_FILE)) return [];
  const raw = readFileSync(QUEUE_FILE, 'utf8').trim();
  if (!raw) return [];
  const out: GameEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as GameEvent;
      if (e.child_id === childId) out.push(e);
    } catch {
      // A torn final line is expected if we read mid-append. Skip it.
    }
  }
  return out;
}

async function readClickHouse(childId: string): Promise<GameEvent[]> {
  return query<GameEvent>(
    `SELECT * FROM ${CH.DB}.${CH.TABLE} WHERE child_id = {childId:String} ORDER BY timestamp`,
    { childId },
  );
}

/* ------------------------------------------------------------------ */
/* Derivation - one implementation, used for the fallback path         */
/* ------------------------------------------------------------------ */

interface Resolved {
  word: string;
  pattern: string;
  succeeded: boolean;
  attemptNumber: number;
  hintUsed: boolean;
}

/** Collapse the raw stream into one row per (word, attempt) resolution. */
function resolveAttempts(events: GameEvent[]): Resolved[] {
  const out: Resolved[] = [];
  for (const e of events) {
    if (e.event_type !== 'word_succeeded' && e.event_type !== 'word_failed') continue;
    if (!e.word) continue;
    out.push({
      word: e.word.toUpperCase(),
      pattern: (e.phoneme || '').toLowerCase(),
      succeeded: e.event_type === 'word_succeeded',
      attemptNumber: e.attempt_number || 1,
      hintUsed: Boolean(e.hint_used),
    });
  }
  return out;
}

function patternStats(resolved: Resolved[]): PatternStat[] {
  const byPattern = new Map<string, Resolved[]>();
  for (const r of resolved) {
    if (!r.pattern) continue;
    const list = byPattern.get(r.pattern) ?? [];
    list.push(r);
    byPattern.set(r.pattern, list);
  }

  const stats: PatternStat[] = [];
  for (const [pattern, rows] of byPattern) {
    const successes = rows.filter((r) => r.succeeded);
    const words = new Set(rows.map((r) => r.word));
    const attemptsToSuccess = successes.map((r) => r.attemptNumber);
    stats.push({
      pattern,
      attempts: rows.length,
      successes: successes.length,
      accuracy: rows.length ? successes.length / rows.length : 0,
      avgAttemptsToSuccess: attemptsToSuccess.length
        ? attemptsToSuccess.reduce((a, b) => a + b, 0) / attemptsToSuccess.length
        : 0,
      wordsSeen: words.size,
      confident:
        rows.length >= THRESHOLDS.minResolvedForConfidence &&
        words.size >= THRESHOLDS.minDistinctWords,
    });
  }
  return stats.sort((a, b) => a.accuracy - b.accuracy);
}

interface InteractionAgg {
  type: string;
  starts: number;
  completions: number;
  totalMs: number;
  msSamples: number;
}

function engagementFromEvents(events: GameEvent[]) {
  const agg = new Map<string, InteractionAgg>();
  const bump = (type: string): InteractionAgg => {
    const cur = agg.get(type) ?? { type, starts: 0, completions: 0, totalMs: 0, msSamples: 0 };
    agg.set(type, cur);
    return cur;
  };

  let scenesCompleted = 0;
  let storiesStarted = 0;
  let storiesCompleted = 0;

  for (const e of events) {
    if (e.event_type === 'interaction_started' && e.interaction_type) {
      bump(e.interaction_type).starts++;
    } else if (e.event_type === 'interaction_completed' && e.interaction_type) {
      const a = bump(e.interaction_type);
      a.completions++;
      if (e.response_time_ms > 0) { a.totalMs += e.response_time_ms; a.msSamples++; }
    } else if (e.event_type === 'scene_completed') {
      scenesCompleted++;
    } else if (e.event_type === 'story_started') {
      storiesStarted++;
    } else if (e.event_type === 'story_completed') {
      storiesCompleted++;
    }
  }

  const interactionStats = [...agg.values()].map((a) => ({
    type: a.type,
    completions: a.completions,
    abandons: Math.max(0, a.starts - a.completions),
    avgMs: a.msSamples ? Math.round(a.totalMs / a.msSamples) : 0,
  }));

  const eligible = [...agg.values()].filter((a) => a.starts >= THRESHOLDS.minStartsForPreference);
  const rate = (a: InteractionAgg) => (a.starts ? a.completions / a.starts : 0);
  const best = eligible.length
    ? eligible.reduce((x, y) => (rate(y) > rate(x) ? y : x))
    : null;
  const worst = eligible.length
    ? eligible.reduce((x, y) => (rate(y) < rate(x) ? y : x))
    : null;

  return {
    interactionStats,
    preferredInteraction: (best?.type ?? null) as InteractionType | null,
    lowEngagementInteraction:
      worst && best && worst.type !== best.type ? (worst.type as InteractionType) : null,
    scenesCompleted,
    storiesStarted,
    storiesCompleted,
  };
}

function companionFromEvents(events: GameEvent[], resolved: Resolved[]) {
  const hintsOffered = events.filter((e) => e.event_type === 'hint_offered').length;
  const hintsAccepted = events.filter((e) => e.event_type === 'hint_accepted').length;

  const withHint = resolved.filter((r) => r.hintUsed);
  const withoutHint = resolved.filter((r) => !r.hintUsed);
  const rate = (rows: Resolved[]) =>
    rows.length ? rows.filter((r) => r.succeeded).length / rows.length : null;

  const successRateWithHint = rate(withHint);
  const successRateWithoutHint = rate(withoutHint);

  // Which attempt does this child actually succeed on unaided? Interrupting
  // before that is counterproductive; waiting past it is discouraging.
  const unaidedSuccesses = withoutHint.filter((r) => r.succeeded).map((r) => r.attemptNumber);
  const typicalUnaided = unaidedSuccesses.length
    ? Math.round(unaidedSuccesses.reduce((a, b) => a + b, 0) / unaidedSuccesses.length)
    : 2;

  let preferredIntervention: ChildProfile['companion']['preferredIntervention'] = null;
  if (successRateWithHint !== null && successRateWithoutHint !== null) {
    preferredIntervention = successRateWithHint > successRateWithoutHint ? 'visual_hint' : 'none';
  } else if (hintsOffered > 0 && successRateWithHint !== null) {
    preferredIntervention = 'visual_hint';
  }

  return {
    preferredIntervention,
    helpAfterAttempt: Math.min(4, Math.max(1, typicalUnaided)),
    hintsOffered,
    hintsAccepted,
    successRateWithHint,
    successRateWithoutHint,
  };
}

/** Build a profile purely from a list of recorded events. */
export function profileFromEvents(childId: string, events: GameEvent[]): ChildProfile {
  const resolved = resolveAttempts(events);
  const stats = patternStats(resolved);
  const confident = stats.filter((s) => s.confident);

  const successes = resolved.filter((r) => r.succeeded).length;

  return {
    childId,
    hasEvidence: events.length > 0,
    eventCount: events.length,
    reading: {
      weakPatterns: confident
        .filter((s) => s.accuracy < THRESHOLDS.weakBelow)
        .map((s) => s.pattern),
      strongPatterns: confident
        .filter((s) => s.accuracy >= THRESHOLDS.strongAtOrAbove)
        .map((s) => s.pattern),
      patternStats: stats,
      overallAccuracy: resolved.length ? successes / resolved.length : 0,
    },
    engagement: engagementFromEvents(events),
    companion: companionFromEvents(events, resolved),
  };
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * Preferred path: ClickHouse SQL. Falls back to the durable queue when the
 * service is unreachable, and always reports which source was used.
 */
export async function buildProfile(childId: string): Promise<ProfileResult> {
  const empty = (source: EvidenceSource, detail: string): ProfileResult => ({
    ...profileFromEvents(childId, []),
    hasEvidence: false,
    evidenceSource: source,
    sourceDetail: detail,
    thresholds: THRESHOLDS,
  });

  if (isConfigured() && (await ping())) {
    try {
      const [patterns, engagement, hints] = await Promise.all([
        childPatterns(childId),
        childEngagement(childId),
        childHints(childId),
      ]);

      if (!patterns.hasData && !engagement.hasData) {
        // ClickHouse answered, it simply has nothing for this child yet. The
        // queue may still hold events that have not been replayed.
        const queued = readQueue(childId);
        if (queued.length > 0) {
          return {
            ...profileFromEvents(childId, queued),
            evidenceSource: 'local_queue',
            sourceDetail:
              `ClickHouse reachable but holds no rows for "${childId}"; derived from ` +
              `${queued.length} event(s) still awaiting replay in the local queue`,
            thresholds: THRESHOLDS,
          };
        }
        return empty('clickhouse', `ClickHouse has no events for "${childId}" yet`);
      }

      const stats: PatternStat[] = patterns.patterns.map((p) => ({
        pattern: p.pattern,
        attempts: p.attempts,
        successes: p.successes,
        accuracy: p.accuracy ?? 0,
        avgAttemptsToSuccess: p.avgAttemptsToSuccess ?? 0,
        wordsSeen: p.wordsSeen,
        confident: p.confident,
      }));

      return {
        childId,
        hasEvidence: true,
        eventCount: patterns.totalAttempts,
        reading: {
          weakPatterns: patterns.weakPatterns,
          strongPatterns: patterns.strongPatterns,
          patternStats: stats,
          overallAccuracy: patterns.overallAccuracy ?? 0,
        },
        engagement: {
          preferredInteraction: engagement.preferredInteraction,
          lowEngagementInteraction: engagement.lowEngagementInteraction,
          interactionStats: engagement.interactions.map((i) => ({
            type: i.interactionType,
            completions: i.completions,
            abandons: i.abandons,
            avgMs: i.avgMs ?? 0,
          })),
          scenesCompleted: engagement.scenesCompleted,
          storiesCompleted: engagement.storiesCompleted,
          storiesStarted: engagement.storiesStarted,
        },
        companion: {
          preferredIntervention:
            (hints.bestIntervention as ChildProfile['companion']['preferredIntervention']) ?? null,
          helpAfterAttempt: hints.recommendedHelpAfterAttempt,
          hintsOffered: hints.hintsOffered,
          hintsAccepted: hints.hintsAccepted,
          successRateWithHint: hints.successRateWithHint,
          successRateWithoutHint: hints.successRateWithoutHint,
        },
        evidenceSource: 'clickhouse',
        sourceDetail: `derived from ClickHouse (${patterns.totalAttempts} attempts)`,
        thresholds: THRESHOLDS,
      };
    } catch (err) {
      // Fall through to the queue rather than failing the request.
      const detail = err instanceof Error ? err.message : String(err);
      const queued = readQueue(childId);
      if (queued.length === 0) return empty('none', `ClickHouse query failed: ${detail}`);
      return {
        ...profileFromEvents(childId, queued),
        evidenceSource: 'local_queue',
        sourceDetail: `ClickHouse query failed (${detail}); derived from ${queued.length} queued event(s)`,
        thresholds: THRESHOLDS,
      };
    }
  }

  const queued = readQueue(childId);
  if (queued.length === 0) {
    return empty('none', 'ClickHouse unreachable and no events recorded locally yet');
  }
  return {
    ...profileFromEvents(childId, queued),
    evidenceSource: 'local_queue',
    sourceDetail:
      `ClickHouse unreachable; derived from ${queued.length} genuinely recorded event(s) ` +
      `in the durable queue, which will replay on reconnect`,
    thresholds: THRESHOLDS,
  };
}

/** Every child id that has produced at least one event, from either source. */
export async function knownChildren(): Promise<string[]> {
  if (isConfigured() && (await ping())) {
    try {
      const rows = await query<{ child_id: string }>(
        `SELECT DISTINCT child_id FROM ${CH.DB}.${CH.TABLE}`,
      );
      if (rows.length) return rows.map((r) => r.child_id);
    } catch {
      // fall through to the queue
    }
  }
  if (!existsSync(QUEUE_FILE)) return [];
  const ids = new Set<string>();
  for (const line of readFileSync(QUEUE_FILE, 'utf8').trim().split('\n')) {
    if (!line) continue;
    try { ids.add((JSON.parse(line) as GameEvent).child_id); } catch { /* torn line */ }
  }
  return [...ids];
}
