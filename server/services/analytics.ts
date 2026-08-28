/**
 * Every number this app shows comes from one of the queries in this file.
 *
 * Rules held here:
 *  - No user-supplied value is ever interpolated into SQL. Everything goes
 *    through ClickHouse `query_params` ({name:Type}). Only CH.DB / CH.TABLE,
 *    which are operator config, are templated in - they are identifiers and
 *    cannot be parameterised.
 *  - A query that returns nothing produces `hasData: false` plus a reason.
 *    It never produces a plausible-looking placeholder.
 *  - A query that throws produces `hasData: false` plus `error`. The endpoint
 *    still answers 200 so the judge view can show the failure honestly.
 */

import { CH, query, status, queueDepth, ping } from '../db/clickhouse.ts';
import type {
  AnalyticsEnvelope,
  AnalyticsHealthResponse,
  EngagementResponse,
  HardWordRow,
  HintStyleRow,
  HintsResponse,
  InteractionEngagementRow,
  LiveEventRow,
  LiveResponse,
  MaterializedViewHealth,
  PatternRow,
  PatternsResponse,
  RecentEventsResponse,
  SceneFunnelRow,
  StoryScenesResponse,
  StoryWordsResponse,
  WordEvidenceRow,
} from '../../src/shared/analyticsTypes.ts';
import type { InteractionType } from '../../src/shared/types.ts';

const T = `${CH.DB}.${CH.TABLE}`;

/** Below this many resolved attempts we refuse to call a pattern weak or strong. */
const MIN_RESOLVED_FOR_CONFIDENCE = 4;
const WEAK_BELOW = 0.7;
const STRONG_AT_OR_ABOVE = 0.85;
const MIN_STARTS_FOR_PREFERENCE = 2;
const DEFAULT_HELP_AFTER_ATTEMPT = 3;

/* ------------------------------------------------------------------ */
/* Coercion - ClickHouse JSONEachRow quotes 64-bit ints and emits SQL  */
/* NULL as JSON null. Never let either become a fake number.           */
/* ------------------------------------------------------------------ */

function n(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

function nOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

/** 'YYYY-MM-DD hh:mm:ss.SSS' (ClickHouse) -> ISO-8601. */
function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.startsWith('1970-01-01 00:00:00')) return null;
  return s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
}

function boolOrNull(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return null;
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const x = Math.floor(Number(raw));
  if (!Number.isFinite(x) || x <= 0) return fallback;
  return Math.min(x, max);
}

/* ------------------------------------------------------------------ */
/* Envelope                                                            */
/* ------------------------------------------------------------------ */

function envelope(
  hasData: boolean,
  reason: string,
  error: string | null,
  queryMs: number,
): AnalyticsEnvelope {
  return {
    hasData,
    reason,
    source: 'clickhouse',
    error,
    generatedAt: new Date().toISOString(),
    queryMs,
    status: status(),
  };
}

function notConfiguredReason(): string {
  return (
    'ClickHouse is not configured (CLICKHOUSE_HOST / CLICKHOUSE_PASSWORD missing from .env). ' +
    'Gameplay events are being written to the durable queue at .data/event-queue.jsonl and will ' +
    'be replayed automatically once credentials are set. No analytics can be computed until then.'
  );
}

/** Runs `fn`, times it, and turns any failure into an honest empty response. */
async function guarded<T>(
  fn: () => Promise<T>,
  onFailure: (env: AnalyticsEnvelope) => T,
): Promise<T> {
  const started = Date.now();
  if (!status().configured) {
    return onFailure(envelope(false, notConfiguredReason(), null, 0));
  }
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return onFailure(
      envelope(
        false,
        `ClickHouse query failed - no numbers can be shown. ${message}`,
        message,
        Date.now() - started,
      ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* SQL                                                                 */
/* ------------------------------------------------------------------ */

export const SQL = {
  /** Per-pattern reading accuracy for one child. Exposed on the response. */
  patterns: `
SELECT
  phoneme                                                            AS pattern,
  toFloat64(countIf(event_type = 'word_attempted'))                  AS attempts,
  toFloat64(countIf(event_type = 'word_succeeded'))                  AS successes,
  toFloat64(countIf(event_type = 'word_failed'))                     AS failures,
  toFloat64(countIf(event_type IN ('word_succeeded','word_failed'))) AS resolved,
  round(successes / nullIf(resolved, 0), 3)                          AS accuracy,
  round(sumIf(attempt_number, event_type = 'word_succeeded')
        / nullIf(countIf(event_type = 'word_succeeded'), 0), 2)      AS avg_attempts_to_success,
  toFloat64(uniqExact(word))                                         AS words_seen,
  toFloat64(countIf(hint_used AND event_type IN ('word_succeeded','word_failed'))) AS hints_used
FROM ${T}
WHERE child_id = {childId:String}
  AND phoneme != ''
  AND event_type IN ('word_attempted','word_succeeded','word_failed')
GROUP BY pattern
ORDER BY accuracy ASC NULLS LAST, attempts DESC`.trim(),

  /** Per-word evidence backing the pattern verdict. */
  wordEvidence: `
SELECT
  word,
  argMax(phoneme, timestamp)                                         AS pattern,
  toFloat64(countIf(event_type = 'word_attempted'))                  AS attempts,
  toFloat64(countIf(event_type = 'word_succeeded'))                  AS successes,
  toFloat64(countIf(event_type = 'word_failed'))                     AS failures,
  round(successes / nullIf(successes + failures, 0), 3)              AS accuracy,
  round(sumIf(response_time_ms, event_type = 'word_attempted' AND response_time_ms > 0)
        / nullIf(countIf(event_type = 'word_attempted' AND response_time_ms > 0), 0)) AS avg_response_ms,
  round(countIf(hint_used AND event_type IN ('word_succeeded','word_failed'))
        / nullIf(countIf(event_type IN ('word_succeeded','word_failed')), 0), 3)      AS hint_rate,
  toString(max(timestamp))                                           AS last_seen
FROM ${T}
WHERE child_id = {childId:String} AND word != ''
GROUP BY word
ORDER BY accuracy ASC NULLS LAST, failures DESC
LIMIT {limit:UInt32}`.trim(),

  /** Engagement per interaction primitive. */
  engagement: `
SELECT
  interaction_type,
  toFloat64(countIf(event_type = 'interaction_started'))              AS starts,
  toFloat64(countIf(event_type = 'interaction_completed'))            AS completions,
  greatest(starts - completions, 0)                                   AS abandons,
  round(completions / nullIf(starts, 0), 3)                           AS completion_rate,
  toFloat64(countIf(event_type = 'wrong_choice'))                     AS wrong_choices,
  toFloat64(countIf(event_type = 'hint_offered'))                     AS hints_offered,
  round(sumIf(response_time_ms, event_type = 'interaction_completed' AND response_time_ms > 0)
        / nullIf(countIf(event_type = 'interaction_completed' AND response_time_ms > 0), 0)) AS avg_ms,
  if(countIf(event_type = 'interaction_completed' AND response_time_ms > 0) > 0,
     round(quantileIf(0.5)(response_time_ms, event_type = 'interaction_completed' AND response_time_ms > 0)),
     NULL)                                                            AS median_ms
FROM ${T}
WHERE child_id = {childId:String} AND interaction_type != ''
GROUP BY interaction_type
ORDER BY starts DESC`.trim(),

  /** Story/scene progress counters for one child. */
  childTotals: `
SELECT
  toFloat64(count())                                   AS total_events,
  toFloat64(countIf(event_type = 'scene_started'))     AS scenes_started,
  toFloat64(countIf(event_type = 'scene_completed'))   AS scenes_completed,
  toFloat64(countIf(event_type = 'story_started'))     AS stories_started,
  toFloat64(countIf(event_type = 'story_completed'))   AS stories_completed,
  toFloat64(countIf(event_type = 'story_abandoned'))   AS stories_abandoned
FROM ${T}
WHERE child_id = {childId:String}`.trim(),

  /**
   * Did a hint actually help?
   *
   * A window function walks every event for one word inside one scene of one
   * session in timestamp order, and carries forward how many hints the child
   * had already been given *before* the current row. Outcome rows are then
   * split into two populations - after-a-hint and unaided - and compared.
   */
  hintEffect: `
WITH marked AS (
  SELECT
    event_type,
    ifNull(hints_before, 0)  AS hints_before,
    ifNull(style_before, '') AS style_before
  FROM (
    SELECT
      event_type,
      sum(toUInt8(event_type IN ('hint_offered','hint_accepted'))) OVER (
        PARTITION BY session_id, scene_id, word
        ORDER BY timestamp ASC, event_id ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ) AS hints_before,
      max(if(event_type IN ('hint_offered','hint_accepted'), companion_intervention, '')) OVER (
        PARTITION BY session_id, scene_id, word
        ORDER BY timestamp ASC, event_id ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ) AS style_before
    FROM ${T}
    WHERE child_id = {childId:String} AND word != ''
  )
)
SELECT
  toFloat64(countIf(event_type IN ('word_succeeded','word_failed') AND hints_before > 0)) AS resolved_with_hint,
  toFloat64(countIf(event_type = 'word_succeeded' AND hints_before > 0))                  AS successes_with_hint,
  toFloat64(countIf(event_type IN ('word_succeeded','word_failed') AND hints_before = 0)) AS resolved_without_hint,
  toFloat64(countIf(event_type = 'word_succeeded' AND hints_before = 0))                  AS successes_without_hint,
  round(successes_with_hint / nullIf(resolved_with_hint, 0), 3)                           AS success_rate_with_hint,
  round(successes_without_hint / nullIf(resolved_without_hint, 0), 3)                     AS success_rate_without_hint
FROM marked`.trim(),

  /** Same window, but grouped by which intervention style preceded the attempt. */
  hintEffectByStyle: `
WITH marked AS (
  SELECT
    event_type,
    ifNull(hints_before, 0)  AS hints_before,
    ifNull(style_before, '') AS style_before
  FROM (
    SELECT
      event_type,
      sum(toUInt8(event_type IN ('hint_offered','hint_accepted'))) OVER (
        PARTITION BY session_id, scene_id, word
        ORDER BY timestamp ASC, event_id ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ) AS hints_before,
      max(if(event_type IN ('hint_offered','hint_accepted'), companion_intervention, '')) OVER (
        PARTITION BY session_id, scene_id, word
        ORDER BY timestamp ASC, event_id ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ) AS style_before
    FROM ${T}
    WHERE child_id = {childId:String} AND word != ''
  )
)
SELECT
  if(style_before = '', 'unlabelled', style_before)                  AS intervention,
  toFloat64(countIf(event_type IN ('word_succeeded','word_failed'))) AS resolved_after,
  toFloat64(countIf(event_type = 'word_succeeded'))                  AS successes_after,
  round(successes_after / nullIf(resolved_after, 0), 3)              AS success_rate_after
FROM marked
WHERE hints_before > 0
GROUP BY intervention
ORDER BY resolved_after DESC`.trim(),

  /** Offered / accepted / ignored per style, straight off the materialized view. */
  hintCounts: `
SELECT
  intervention,
  toFloat64(sum(hints_offered))  AS offered,
  toFloat64(sum(hints_accepted)) AS accepted,
  toFloat64(sum(hints_ignored))  AS ignored
FROM ${CH.DB}.hint_effect_mv
WHERE child_id = {childId:String}
GROUP BY intervention
ORDER BY offered DESC`.trim(),

  /** Scene funnel for one story, read off the materialized view. */
  storyScenes: `
SELECT
  agg.scene_id                                                         AS scene_id,
  toFloat64(agg.starts)                                                AS starts,
  toFloat64(agg.completions)                                           AS completions,
  toFloat64(greatest(toInt64(agg.starts) - toInt64(agg.completions), 0)) AS abandons,
  toFloat64(agg.explicit_abandons)                                     AS explicit_abandons,
  round(agg.completions / nullIf(agg.starts, 0), 3)                    AS completion_rate,
  toFloat64(agg.mistakes)                                              AS mistakes,
  round(agg.mistakes / nullIf(agg.starts, 0), 3)                       AS mistake_rate,
  toFloat64(agg.hints_offered)                                         AS hints_offered,
  round(agg.duration_ms_sum / nullIf(agg.duration_samples, 0))         AS avg_duration_ms,
  raw.median_duration_ms                                               AS median_duration_ms,
  toFloat64(raw.children)                                              AS unique_children,
  toString(raw.first_seen)                                             AS first_seen
FROM (
  SELECT
    scene_id,
    sum(starts)            AS starts,
    sum(completions)       AS completions,
    sum(explicit_abandons) AS explicit_abandons,
    sum(mistakes)          AS mistakes,
    sum(hints_offered)     AS hints_offered,
    sum(duration_ms_sum)   AS duration_ms_sum,
    sum(duration_samples)  AS duration_samples
  FROM ${CH.DB}.scene_funnel_mv
  WHERE story_id = {storyId:String}
  GROUP BY scene_id
) AS agg
LEFT JOIN (
  SELECT
    scene_id,
    uniqExact(child_id) AS children,
    min(timestamp)      AS first_seen,
    if(countIf(event_type = 'scene_completed' AND response_time_ms > 0) > 0,
       round(quantileIf(0.5)(response_time_ms, event_type = 'scene_completed' AND response_time_ms > 0)),
       NULL)            AS median_duration_ms
  FROM ${T}
  WHERE story_id = {storyId:String} AND scene_id != ''
  GROUP BY scene_id
) AS raw ON agg.scene_id = raw.scene_id
ORDER BY first_seen ASC, starts DESC`.trim(),

  /** Hardest words across every child who played this story. */
  storyWords: `
SELECT
  word,
  argMax(phoneme, timestamp)                                         AS pattern,
  toFloat64(countIf(event_type = 'word_attempted'))                  AS attempts,
  toFloat64(countIf(event_type = 'word_succeeded'))                  AS successes,
  toFloat64(countIf(event_type = 'word_failed'))                     AS failures,
  toFloat64(countIf(event_type IN ('word_succeeded','word_failed'))) AS resolved,
  round(failures / nullIf(resolved, 0), 3)                           AS failure_rate,
  round(successes / nullIf(resolved, 0), 3)                          AS accuracy,
  toFloat64(uniqExact(child_id))                                     AS children_affected,
  round(sumIf(response_time_ms, event_type = 'word_attempted' AND response_time_ms > 0)
        / nullIf(countIf(event_type = 'word_attempted' AND response_time_ms > 0), 0)) AS avg_response_ms,
  round(countIf(hint_used AND event_type IN ('word_succeeded','word_failed'))
        / nullIf(resolved, 0), 3)                                    AS hint_rate
FROM ${T}
WHERE story_id = {storyId:String} AND word != ''
GROUP BY word
HAVING resolved > 0
ORDER BY failure_rate DESC, attempts DESC
LIMIT {limit:UInt32}`.trim(),

  /** Raw rows, newest first. Nothing derived - this is the proof view. */
  liveEvents: `
SELECT
  toString(event_id)              AS event_id,
  toString(timestamp)             AS timestamp,
  session_id,
  child_id,
  story_id,
  scene_id,
  event_type,
  interaction_type,
  word,
  phoneme,
  correct,
  toUInt16(attempt_number)        AS attempt_number,
  toFloat64(response_time_ms)     AS response_time_ms,
  hint_used,
  companion_intervention
FROM ${T}
WHERE child_id = {childId:String}
ORDER BY timestamp DESC, event_id DESC
LIMIT {limit:UInt32}`.trim(),

  /** Same, across every child. */
  recentEvents: `
SELECT
  toString(event_id)              AS event_id,
  toString(timestamp)             AS timestamp,
  session_id,
  child_id,
  story_id,
  scene_id,
  event_type,
  interaction_type,
  word,
  phoneme,
  correct,
  toUInt16(attempt_number)        AS attempt_number,
  toFloat64(response_time_ms)     AS response_time_ms,
  hint_used,
  companion_intervention
FROM ${T}
ORDER BY timestamp DESC, event_id DESC
LIMIT {limit:UInt32}`.trim(),

  countForChild: `SELECT toFloat64(count()) AS c FROM ${T} WHERE child_id = {childId:String}`,

  health: `
SELECT
  toFloat64(count())                  AS total_rows,
  toFloat64(uniqExact(child_id))      AS distinct_children,
  toFloat64(uniqExact(story_id))      AS distinct_stories,
  toString(max(timestamp))            AS latest_event
FROM ${T}`.trim(),

  listTables: `SELECT name FROM system.tables WHERE database = {db:String}`,
};

/* ------------------------------------------------------------------ */
/* child patterns                                                      */
/* ------------------------------------------------------------------ */

interface PatternSqlRow {
  pattern: string;
  attempts: unknown; successes: unknown; failures: unknown; resolved: unknown;
  accuracy: unknown; avg_attempts_to_success: unknown; words_seen: unknown; hints_used: unknown;
}

interface EvidenceSqlRow {
  word: string; pattern: string;
  attempts: unknown; successes: unknown; failures: unknown;
  accuracy: unknown; avg_response_ms: unknown; hint_rate: unknown; last_seen: unknown;
}

const THRESHOLDS = {
  minResolvedForConfidence: MIN_RESOLVED_FOR_CONFIDENCE,
  weakBelow: WEAK_BELOW,
  strongAtOrAbove: STRONG_AT_OR_ABOVE,
};

function emptyPatterns(childId: string, env: AnalyticsEnvelope): PatternsResponse {
  return {
    ...env,
    childId,
    totalAttempts: 0,
    resolvedAttempts: 0,
    overallAccuracy: null,
    patterns: [],
    weakPatterns: [],
    strongPatterns: [],
    evidence: [],
    thresholds: THRESHOLDS,
    sql: SQL.patterns,
  };
}

export async function childPatterns(childId: string, evidenceLimit = 40): Promise<PatternsResponse> {
  return guarded<PatternsResponse>(
    async () => {
      const started = Date.now();
      const limit = clampLimit(evidenceLimit, 40, 200);
      const [rows, evidenceRows] = await Promise.all([
        query<PatternSqlRow>(SQL.patterns, { childId }),
        query<EvidenceSqlRow>(SQL.wordEvidence, { childId, limit }),
      ]);
      const queryMs = Date.now() - started;

      if (rows.length === 0) {
        return emptyPatterns(
          childId,
          envelope(
            false,
            `No reading events stored for child "${childId}". ` +
              'Play a scene with a reading_choice interaction to produce evidence.',
            null,
            queryMs,
          ),
        );
      }

      const patterns: PatternRow[] = rows.map((r) => {
        const resolved = n(r.resolved);
        return {
          pattern: r.pattern,
          attempts: n(r.attempts),
          successes: n(r.successes),
          failures: n(r.failures),
          accuracy: nOrNull(r.accuracy),
          avgAttemptsToSuccess: nOrNull(r.avg_attempts_to_success),
          wordsSeen: n(r.words_seen),
          hintsUsed: n(r.hints_used),
          confident: resolved >= MIN_RESOLVED_FOR_CONFIDENCE,
        };
      });

      const totalAttempts = patterns.reduce((s, p) => s + p.attempts, 0);
      const resolvedAttempts = rows.reduce((s, r) => s + n(r.resolved), 0);
      const totalSuccesses = patterns.reduce((s, p) => s + p.successes, 0);

      const weakPatterns = patterns
        .filter((p) => p.confident && p.accuracy !== null && p.accuracy < WEAK_BELOW)
        .sort((a, b) => (a.accuracy ?? 1) - (b.accuracy ?? 1))
        .map((p) => p.pattern);

      const strongPatterns = patterns
        .filter((p) => p.confident && p.accuracy !== null && p.accuracy >= STRONG_AT_OR_ABOVE)
        .sort((a, b) => (b.accuracy ?? 0) - (a.accuracy ?? 0))
        .map((p) => p.pattern);

      const evidence: WordEvidenceRow[] = evidenceRows.map((r) => ({
        word: r.word,
        pattern: r.pattern,
        attempts: n(r.attempts),
        successes: n(r.successes),
        failures: n(r.failures),
        accuracy: nOrNull(r.accuracy),
        avgResponseMs: nOrNull(r.avg_response_ms),
        hintRate: nOrNull(r.hint_rate),
        lastSeen: iso(r.last_seen),
      }));

      const confidentCount = patterns.filter((p) => p.confident).length;
      const reason =
        confidentCount === 0
          ? `${patterns.length} pattern(s) seen but none has reached ${MIN_RESOLVED_FOR_CONFIDENCE} ` +
            'resolved attempts yet, so none is called weak or strong.'
          : `${patterns.length} pattern(s) from ${totalAttempts} attempts; ` +
            `${confidentCount} have enough evidence to act on.`;

      return {
        ...envelope(true, reason, null, queryMs),
        childId,
        totalAttempts,
        resolvedAttempts,
        overallAccuracy: resolvedAttempts > 0 ? Number((totalSuccesses / resolvedAttempts).toFixed(3)) : null,
        patterns,
        weakPatterns,
        strongPatterns,
        evidence,
        thresholds: THRESHOLDS,
        sql: SQL.patterns,
      };
    },
    (env) => emptyPatterns(childId, env),
  );
}

/* ------------------------------------------------------------------ */
/* child engagement                                                    */
/* ------------------------------------------------------------------ */

interface EngagementSqlRow {
  interaction_type: string;
  starts: unknown; completions: unknown; abandons: unknown; completion_rate: unknown;
  wrong_choices: unknown; hints_offered: unknown; avg_ms: unknown; median_ms: unknown;
}

interface TotalsSqlRow {
  total_events: unknown; scenes_started: unknown; scenes_completed: unknown;
  stories_started: unknown; stories_completed: unknown; stories_abandoned: unknown;
}

function emptyEngagement(childId: string, env: AnalyticsEnvelope): EngagementResponse {
  return {
    ...env,
    childId,
    interactions: [],
    preferredInteraction: null,
    lowEngagementInteraction: null,
    scenesStarted: 0,
    scenesCompleted: 0,
    storiesStarted: 0,
    storiesCompleted: 0,
    storiesAbandoned: 0,
    minStartsForPreference: MIN_STARTS_FOR_PREFERENCE,
    sql: SQL.engagement,
  };
}

export async function childEngagement(childId: string): Promise<EngagementResponse> {
  return guarded<EngagementResponse>(
    async () => {
      const started = Date.now();
      const [rows, totalsRows] = await Promise.all([
        query<EngagementSqlRow>(SQL.engagement, { childId }),
        query<TotalsSqlRow>(SQL.childTotals, { childId }),
      ]);
      const queryMs = Date.now() - started;
      const totals = totalsRows[0];

      const interactions: InteractionEngagementRow[] = rows.map((r) => ({
        interactionType: r.interaction_type,
        starts: n(r.starts),
        completions: n(r.completions),
        abandons: n(r.abandons),
        completionRate: nOrNull(r.completion_rate),
        wrongChoices: n(r.wrong_choices),
        hintsOffered: n(r.hints_offered),
        avgMs: nOrNull(r.avg_ms),
        medianMs: nOrNull(r.median_ms),
      }));

      const totalEvents = n(totals?.total_events);
      if (interactions.length === 0 && totalEvents === 0) {
        return emptyEngagement(
          childId,
          envelope(false, `No events stored for child "${childId}".`, null, queryMs),
        );
      }

      // Only rank interactions the child has actually met more than once.
      const rankable = interactions.filter(
        (i) => i.starts >= MIN_STARTS_FOR_PREFERENCE && i.completionRate !== null,
      );
      const byRate = [...rankable].sort(
        (a, b) => (b.completionRate ?? 0) - (a.completionRate ?? 0) || b.starts - a.starts,
      );
      const preferred = byRate[0]?.interactionType ?? null;
      const lowest = byRate.length > 1 ? byRate[byRate.length - 1].interactionType : null;

      const reason =
        interactions.length === 0
          ? `${totalEvents} events stored for "${childId}" but none carries an interaction_type yet.`
          : rankable.length === 0
            ? `${interactions.length} interaction type(s) seen, none reached ` +
              `${MIN_STARTS_FOR_PREFERENCE} starts, so no preference is claimed.`
            : `${interactions.length} interaction type(s) across ${totalEvents} events.`;

      return {
        ...envelope(interactions.length > 0, reason, null, queryMs),
        childId,
        interactions,
        preferredInteraction: (preferred as InteractionType | null) ?? null,
        lowEngagementInteraction: (lowest as InteractionType | null) ?? null,
        scenesStarted: n(totals?.scenes_started),
        scenesCompleted: n(totals?.scenes_completed),
        storiesStarted: n(totals?.stories_started),
        storiesCompleted: n(totals?.stories_completed),
        storiesAbandoned: n(totals?.stories_abandoned),
        minStartsForPreference: MIN_STARTS_FOR_PREFERENCE,
        sql: SQL.engagement,
      };
    },
    (env) => emptyEngagement(childId, env),
  );
}

/* ------------------------------------------------------------------ */
/* child hints                                                         */
/* ------------------------------------------------------------------ */

interface HintEffectSqlRow {
  resolved_with_hint: unknown; successes_with_hint: unknown;
  resolved_without_hint: unknown; successes_without_hint: unknown;
  success_rate_with_hint: unknown; success_rate_without_hint: unknown;
}

interface HintStyleSqlRow {
  intervention: string;
  resolved_after: unknown; successes_after: unknown; success_rate_after: unknown;
}

interface HintCountSqlRow {
  intervention: string; offered: unknown; accepted: unknown; ignored: unknown;
}

function emptyHints(childId: string, env: AnalyticsEnvelope): HintsResponse {
  return {
    ...env,
    childId,
    hintsOffered: 0,
    hintsAccepted: 0,
    hintsIgnored: 0,
    acceptRate: null,
    resolvedWithHint: 0,
    successesWithHint: 0,
    successRateWithHint: null,
    resolvedWithoutHint: 0,
    successesWithoutHint: 0,
    successRateWithoutHint: null,
    lift: null,
    byStyle: [],
    bestIntervention: null,
    recommendedHelpAfterAttempt: DEFAULT_HELP_AFTER_ATTEMPT,
    recommendationBasis:
      `No hint evidence stored, so the stated default of ${DEFAULT_HELP_AFTER_ATTEMPT} attempts is used.`,
    sql: SQL.hintEffect,
  };
}

export async function childHints(childId: string): Promise<HintsResponse> {
  return guarded<HintsResponse>(
    async () => {
      const started = Date.now();
      const [effectRows, styleRows, countRows] = await Promise.all([
        query<HintEffectSqlRow>(SQL.hintEffect, { childId }),
        query<HintStyleSqlRow>(SQL.hintEffectByStyle, { childId }),
        query<HintCountSqlRow>(SQL.hintCounts, { childId }),
      ]);
      const queryMs = Date.now() - started;

      const e = effectRows[0];
      const resolvedWithHint = n(e?.resolved_with_hint);
      const resolvedWithoutHint = n(e?.resolved_without_hint);
      const successRateWithHint = nOrNull(e?.success_rate_with_hint);
      const successRateWithoutHint = nOrNull(e?.success_rate_without_hint);

      const offeredTotal = countRows.reduce((s, r) => s + n(r.offered), 0);
      const acceptedTotal = countRows.reduce((s, r) => s + n(r.accepted), 0);
      const ignoredTotal = countRows.reduce((s, r) => s + n(r.ignored), 0);

      if (offeredTotal === 0 && resolvedWithHint === 0 && resolvedWithoutHint === 0) {
        return emptyHints(
          childId,
          envelope(
            false,
            `No hint or reading-attempt events stored for child "${childId}". ` +
              'Mimo has not offered help yet, so there is nothing to compare.',
            null,
            queryMs,
          ),
        );
      }

      const countsByStyle = new Map(countRows.map((r) => [r.intervention, r]));
      const afterByStyle = new Map(styleRows.map((r) => [r.intervention, r]));
      const names = new Set([...countsByStyle.keys(), ...afterByStyle.keys()]);

      const byStyle: HintStyleRow[] = [...names]
        .map((name) => {
          const c = countsByStyle.get(name);
          const a = afterByStyle.get(name);
          const offered = n(c?.offered);
          const accepted = n(c?.accepted);
          return {
            intervention: name,
            offered,
            accepted,
            ignored: n(c?.ignored),
            acceptRate: offered > 0 ? Number((accepted / offered).toFixed(3)) : null,
            resolvedAfter: n(a?.resolved_after),
            successesAfter: n(a?.successes_after),
            successRateAfter: nOrNull(a?.success_rate_after),
          };
        })
        .sort((x, y) => y.offered - x.offered || y.resolvedAfter - x.resolvedAfter);

      // Only name a best style when it has cleared the confidence bar.
      const ranked = byStyle
        .filter(
          (s) =>
            s.intervention !== 'none' &&
            s.successRateAfter !== null &&
            s.resolvedAfter >= MIN_RESOLVED_FOR_CONFIDENCE,
        )
        .sort((x, y) => (y.successRateAfter ?? 0) - (x.successRateAfter ?? 0));
      const bestIntervention = ranked[0]?.intervention ?? null;

      const lift =
        successRateWithHint !== null && successRateWithoutHint !== null
          ? Number((successRateWithHint - successRateWithoutHint).toFixed(3))
          : null;

      const enoughToJudge =
        resolvedWithHint >= MIN_RESOLVED_FOR_CONFIDENCE &&
        resolvedWithoutHint >= MIN_RESOLVED_FOR_CONFIDENCE;

      let recommendedHelpAfterAttempt = DEFAULT_HELP_AFTER_ATTEMPT;
      let recommendationBasis =
        `Only ${resolvedWithHint} resolved attempts after a hint and ${resolvedWithoutHint} unaided; ` +
        `below the ${MIN_RESOLVED_FOR_CONFIDENCE}-attempt bar, so the stated default of ` +
        `${DEFAULT_HELP_AFTER_ATTEMPT} is kept.`;

      if (enoughToJudge && lift !== null) {
        if (lift >= 0.1) {
          recommendedHelpAfterAttempt = 2;
          recommendationBasis =
            `Hints lift success by ${(lift * 100).toFixed(0)} points ` +
            `(${((successRateWithHint ?? 0) * 100).toFixed(0)}% with vs ` +
            `${((successRateWithoutHint ?? 0) * 100).toFixed(0)}% without) - offer help sooner.`;
        } else if (lift <= -0.05) {
          recommendedHelpAfterAttempt = 4;
          recommendationBasis =
            `This child does better unaided (${((successRateWithoutHint ?? 0) * 100).toFixed(0)}% vs ` +
            `${((successRateWithHint ?? 0) * 100).toFixed(0)}% after a hint) - hold help back longer.`;
        } else {
          recommendationBasis =
            `Hints make little measurable difference (lift ${(lift * 100).toFixed(0)} points) - ` +
            `keeping ${DEFAULT_HELP_AFTER_ATTEMPT} attempts.`;
        }
      }

      return {
        ...envelope(
          true,
          `${offeredTotal} hints offered; ${resolvedWithHint} attempts resolved after a hint vs ` +
            `${resolvedWithoutHint} unaided.`,
          null,
          queryMs,
        ),
        childId,
        hintsOffered: offeredTotal,
        hintsAccepted: acceptedTotal,
        hintsIgnored: ignoredTotal,
        acceptRate: offeredTotal > 0 ? Number((acceptedTotal / offeredTotal).toFixed(3)) : null,
        resolvedWithHint,
        successesWithHint: n(e?.successes_with_hint),
        successRateWithHint,
        resolvedWithoutHint,
        successesWithoutHint: n(e?.successes_without_hint),
        successRateWithoutHint,
        lift,
        byStyle,
        bestIntervention,
        recommendedHelpAfterAttempt,
        recommendationBasis,
        sql: SQL.hintEffect,
      };
    },
    (env) => emptyHints(childId, env),
  );
}

/* ------------------------------------------------------------------ */
/* story scenes                                                        */
/* ------------------------------------------------------------------ */

interface SceneSqlRow {
  scene_id: string;
  starts: unknown; completions: unknown; abandons: unknown; explicit_abandons: unknown;
  completion_rate: unknown; mistakes: unknown; mistake_rate: unknown; hints_offered: unknown;
  avg_duration_ms: unknown; median_duration_ms: unknown; unique_children: unknown; first_seen: unknown;
}

function emptyScenes(storyId: string, env: AnalyticsEnvelope): StoryScenesResponse {
  return {
    ...env,
    storyId,
    scenes: [],
    hardestScene: null,
    biggestDropOff: null,
    totalStarts: 0,
    totalCompletions: 0,
    uniqueChildren: 0,
    sql: SQL.storyScenes,
  };
}

export async function storyScenes(storyId: string): Promise<StoryScenesResponse> {
  return guarded<StoryScenesResponse>(
    async () => {
      const started = Date.now();
      const rows = await query<SceneSqlRow>(SQL.storyScenes, { storyId });
      const queryMs = Date.now() - started;

      if (rows.length === 0) {
        return emptyScenes(
          storyId,
          envelope(
            false,
            `No scene events stored for story "${storyId}". Play it once and the funnel fills in.`,
            null,
            queryMs,
          ),
        );
      }

      const firstStarts = n(rows[0]?.starts);

      const scenes: SceneFunnelRow[] = rows.map((r) => {
        const starts = n(r.starts);
        const completionRate = nOrNull(r.completion_rate);
        return {
          sceneId: r.scene_id,
          starts,
          completions: n(r.completions),
          abandons: n(r.abandons),
          explicitAbandons: n(r.explicit_abandons),
          completionRate,
          dropOffRate: completionRate === null ? null : Number((1 - completionRate).toFixed(3)),
          reachRate: firstStarts > 0 ? Number((starts / firstStarts).toFixed(3)) : null,
          avgDurationMs: nOrNull(r.avg_duration_ms),
          medianDurationMs: nOrNull(r.median_duration_ms),
          mistakes: n(r.mistakes),
          mistakeRate: nOrNull(r.mistake_rate),
          hintsOffered: n(r.hints_offered),
          uniqueChildren: n(r.unique_children),
          firstSeen: iso(r.first_seen),
        };
      });

      const played = scenes.filter((s) => s.starts > 0);
      const hardest = [...played].sort(
        (a, b) =>
          (b.mistakeRate ?? 0) - (a.mistakeRate ?? 0) ||
          (a.completionRate ?? 1) - (b.completionRate ?? 1),
      )[0];
      const dropOff = [...played].sort((a, b) => b.abandons - a.abandons || a.starts - b.starts)[0];

      const totalStarts = scenes.reduce((s, x) => s + x.starts, 0);
      const totalCompletions = scenes.reduce((s, x) => s + x.completions, 0);

      return {
        ...envelope(
          true,
          `${scenes.length} scene(s), ${totalStarts} starts and ${totalCompletions} completions stored.`,
          null,
          queryMs,
        ),
        storyId,
        scenes,
        hardestScene: hardest && (hardest.mistakes > 0 || (hardest.completionRate ?? 1) < 1)
          ? hardest.sceneId
          : null,
        biggestDropOff: dropOff && dropOff.abandons > 0 ? dropOff.sceneId : null,
        totalStarts,
        totalCompletions,
        uniqueChildren: Math.max(0, ...scenes.map((s) => s.uniqueChildren)),
        sql: SQL.storyScenes,
      };
    },
    (env) => emptyScenes(storyId, env),
  );
}

/* ------------------------------------------------------------------ */
/* story words                                                         */
/* ------------------------------------------------------------------ */

interface WordSqlRow {
  word: string; pattern: string;
  attempts: unknown; successes: unknown; failures: unknown; resolved: unknown;
  failure_rate: unknown; accuracy: unknown; children_affected: unknown;
  avg_response_ms: unknown; hint_rate: unknown;
}

function emptyWords(storyId: string, limit: number, env: AnalyticsEnvelope): StoryWordsResponse {
  return { ...env, storyId, words: [], hardestWord: null, limit, sql: SQL.storyWords };
}

export async function storyWords(storyId: string, rawLimit: unknown = 25): Promise<StoryWordsResponse> {
  const limit = clampLimit(rawLimit, 25, 200);
  return guarded<StoryWordsResponse>(
    async () => {
      const started = Date.now();
      const rows = await query<WordSqlRow>(SQL.storyWords, { storyId, limit });
      const queryMs = Date.now() - started;

      if (rows.length === 0) {
        return emptyWords(
          storyId,
          limit,
          envelope(
            false,
            `No resolved word attempts stored for story "${storyId}".`,
            null,
            queryMs,
          ),
        );
      }

      const words: HardWordRow[] = rows.map((r) => ({
        word: r.word,
        pattern: r.pattern,
        attempts: n(r.attempts),
        successes: n(r.successes),
        failures: n(r.failures),
        failureRate: nOrNull(r.failure_rate),
        accuracy: nOrNull(r.accuracy),
        childrenAffected: n(r.children_affected),
        avgResponseMs: nOrNull(r.avg_response_ms),
        hintRate: nOrNull(r.hint_rate),
      }));

      const hardest = words.find((w) => (w.failureRate ?? 0) > 0) ?? null;

      return {
        ...envelope(
          true,
          `${words.length} word(s) with at least one resolved attempt, hardest first.`,
          null,
          queryMs,
        ),
        storyId,
        words,
        hardestWord: hardest?.word ?? null,
        limit,
        sql: SQL.storyWords,
      };
    },
    (env) => emptyWords(storyId, limit, env),
  );
}

/* ------------------------------------------------------------------ */
/* live feed                                                           */
/* ------------------------------------------------------------------ */

interface LiveSqlRow {
  event_id: string; timestamp: unknown; session_id: string; child_id: string;
  story_id: string; scene_id: string; event_type: string; interaction_type: string;
  word: string; phoneme: string; correct: unknown; attempt_number: unknown;
  response_time_ms: unknown; hint_used: unknown; companion_intervention: string;
}

function toLiveRow(r: LiveSqlRow): LiveEventRow {
  return {
    eventId: r.event_id,
    timestamp: iso(r.timestamp) ?? String(r.timestamp ?? ''),
    sessionId: r.session_id,
    childId: r.child_id,
    storyId: r.story_id,
    sceneId: r.scene_id,
    eventType: r.event_type,
    interactionType: r.interaction_type,
    word: r.word,
    phoneme: r.phoneme,
    correct: boolOrNull(r.correct),
    attemptNumber: n(r.attempt_number),
    responseTimeMs: n(r.response_time_ms),
    hintUsed: boolOrNull(r.hint_used) ?? false,
    companionIntervention: r.companion_intervention,
  };
}

function emptyLive(childId: string, limit: number, env: AnalyticsEnvelope): LiveResponse {
  return { ...env, childId, limit, events: [], totalEvents: 0, sql: SQL.liveEvents };
}

export async function liveEvents(childId: string, rawLimit: unknown = 50): Promise<LiveResponse> {
  const limit = clampLimit(rawLimit, 50, 500);
  return guarded<LiveResponse>(
    async () => {
      const started = Date.now();
      const [rows, countRows] = await Promise.all([
        query<LiveSqlRow>(SQL.liveEvents, { childId, limit }),
        query<{ c: unknown }>(SQL.countForChild, { childId }),
      ]);
      const queryMs = Date.now() - started;
      const totalEvents = n(countRows[0]?.c);

      if (rows.length === 0) {
        return emptyLive(
          childId,
          limit,
          envelope(false, `No events stored for child "${childId}" yet.`, null, queryMs),
        );
      }

      return {
        ...envelope(
          true,
          `Showing the ${rows.length} newest of ${totalEvents} stored events.`,
          null,
          queryMs,
        ),
        childId,
        limit,
        events: rows.map(toLiveRow),
        totalEvents,
        sql: SQL.liveEvents,
      };
    },
    (env) => emptyLive(childId, limit, env),
  );
}

export async function recentEvents(
  childId: string | null,
  rawLimit: unknown = 50,
): Promise<RecentEventsResponse> {
  const limit = clampLimit(rawLimit, 50, 500);
  const sql = childId ? SQL.liveEvents : SQL.recentEvents;
  return guarded<RecentEventsResponse>(
    async () => {
      const started = Date.now();
      const params = childId ? { childId, limit } : { limit };
      const rows = await query<LiveSqlRow>(sql, params);
      const queryMs = Date.now() - started;

      if (rows.length === 0) {
        return {
          ...envelope(
            false,
            childId
              ? `No events stored for child "${childId}".`
              : 'No events stored yet.',
            null,
            queryMs,
          ),
          childId,
          limit,
          events: [],
          sql,
        };
      }

      return {
        ...envelope(true, `${rows.length} event(s), newest first.`, null, queryMs),
        childId,
        limit,
        events: rows.map(toLiveRow),
        sql,
      };
    },
    (env) => ({ ...env, childId, limit, events: [], sql }),
  );
}

/* ------------------------------------------------------------------ */
/* health                                                              */
/* ------------------------------------------------------------------ */

const VIEWS = ['pattern_stats_mv', 'scene_funnel_mv', 'hint_effect_mv'];

export async function health(): Promise<AnalyticsHealthResponse> {
  const generatedAt = new Date().toISOString();
  const base: AnalyticsHealthResponse = {
    ok: false,
    ping: false,
    status: status(),
    totalRows: null,
    distinctChildren: null,
    distinctStories: null,
    latestEvent: null,
    queueDepth: queueDepth(),
    // exists:false here means "could not be checked", never "confirmed absent".
    materializedViews: VIEWS.map((name) => ({
      name,
      exists: false,
      rows: null,
      error: 'not checked - ClickHouse was not reachable',
    })),
    pingMs: null,
    error: null,
    generatedAt,
  };

  if (!status().configured) {
    return { ...base, status: status(), error: notConfiguredReason() };
  }

  const started = Date.now();
  let reachable = false;
  try {
    reachable = await ping();
  } catch (err) {
    return {
      ...base,
      status: status(),
      pingMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const pingMs = Date.now() - started;

  if (!reachable) {
    return { ...base, status: status(), pingMs, error: status().detail };
  }

  try {
    const [totals, tables] = await Promise.all([
      query<{ total_rows: unknown; distinct_children: unknown; distinct_stories: unknown; latest_event: unknown }>(
        SQL.health,
      ),
      query<{ name: string }>(SQL.listTables, { db: CH.DB }),
    ]);

    const present = new Set(tables.map((t) => t.name));
    const views: MaterializedViewHealth[] = [];
    for (const name of VIEWS) {
      if (!present.has(name)) {
        views.push({
          name,
          exists: false,
          rows: null,
          error: `not found in ${CH.DB} - run "npx tsx scripts/ch-setup.ts"`,
        });
        continue;
      }
      try {
        // Identifier is from our own VIEWS allowlist, never from a request.
        const c = await query<{ c: unknown }>(`SELECT toFloat64(count()) AS c FROM ${CH.DB}.${name}`);
        views.push({ name, exists: true, rows: n(c[0]?.c), error: null });
      } catch (err) {
        views.push({
          name,
          exists: true,
          rows: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const t = totals[0];
    return {
      ok: views.every((v) => v.exists && v.error === null),
      ping: true,
      status: status(),
      totalRows: n(t?.total_rows),
      distinctChildren: n(t?.distinct_children),
      distinctStories: n(t?.distinct_stories),
      latestEvent: iso(t?.latest_event),
      queueDepth: queueDepth(),
      materializedViews: views,
      pingMs,
      error: null,
      generatedAt,
    };
  } catch (err) {
    return {
      ...base,
      ping: true,
      status: status(),
      pingMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
