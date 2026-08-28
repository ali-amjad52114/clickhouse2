/**
 * Response shapes for every analytics endpoint.
 *
 * Imported by BOTH the browser bundle and the node server, so this file stays
 * dependency-free (types only).
 *
 * TRUTHFULNESS CONTRACT
 * ---------------------
 * Every numeric field in this file is produced by a SQL query against the
 * ClickHouse `gameplay_events` table or one of its materialized views. Nothing
 * is defaulted to a plausible-looking value.
 *
 * Consumers MUST branch on `hasData` before rendering a number. When
 * `hasData` is false the numeric fields are zeros/nulls that mean "we have no
 * evidence", NOT "the measured value is zero". `reason` explains why, and
 * `error` is non-null when the query itself failed.
 */

import type { GameEventType, InteractionType } from './types.ts';

/* ------------------------------------------------------------------ */
/* Envelope - present on every analytics response                      */
/* ------------------------------------------------------------------ */

/** Mirrors the runtime state of the ClickHouse connection. */
export interface AnalyticsStatus {
  configured: boolean;
  connected: boolean;
  detail: string;
  database: string;
  table: string;
  /** Events sitting in the durable on-disk queue, not yet in ClickHouse. */
  queued: number;
}

export interface AnalyticsEnvelope {
  /** False means: no rows matched, or the query could not run. Never render numbers when false. */
  hasData: boolean;
  /** Human-readable explanation. Safe to show a judge verbatim. */
  reason: string;
  /** Always 'clickhouse'. No other source is ever allowed to populate these numbers. */
  source: 'clickhouse';
  /** Non-null only when the query threw (unreachable, bad credentials, ...). */
  error: string | null;
  /** ISO-8601. */
  generatedAt: string;
  /** Wall-clock time the SQL spent, measured around the driver call. */
  queryMs: number;
  status: AnalyticsStatus;
}

/* ------------------------------------------------------------------ */
/* GET /api/analytics/child/:id/patterns                               */
/* ------------------------------------------------------------------ */

export interface PatternRow {
  pattern: string;
  /** `word_attempted` events. */
  attempts: number;
  successes: number;
  failures: number;
  /** successes / (successes + failures). Null when nothing resolved yet. */
  accuracy: number | null;
  /** Mean `attempt_number` on the succeeding attempt. Null when never succeeded. */
  avgAttemptsToSuccess: number | null;
  /** Distinct words seen exercising this pattern. */
  wordsSeen: number;
  hintsUsed: number;
  /** Enough resolved attempts to act on. Below this we do not adapt. */
  confident: boolean;
}

/** One word, with the raw counts that justify calling it hard or easy. */
export interface WordEvidenceRow {
  word: string;
  pattern: string;
  attempts: number;
  successes: number;
  failures: number;
  accuracy: number | null;
  avgResponseMs: number | null;
  hintRate: number | null;
  /** ISO-8601 of the most recent event for this word. */
  lastSeen: string | null;
}

export interface PatternsResponse extends AnalyticsEnvelope {
  childId: string;
  totalAttempts: number;
  resolvedAttempts: number;
  overallAccuracy: number | null;
  patterns: PatternRow[];
  /** Patterns below the weak threshold, worst first. Only `confident` rows. */
  weakPatterns: string[];
  /** Patterns above the strong threshold. Only `confident` rows. */
  strongPatterns: string[];
  evidence: WordEvidenceRow[];
  /** Thresholds used, so the UI can explain itself instead of asserting. */
  thresholds: { minResolvedForConfidence: number; weakBelow: number; strongAtOrAbove: number };
  /** The literal SQL that produced `patterns`, for the judge view. */
  sql: string;
}

/* ------------------------------------------------------------------ */
/* GET /api/analytics/child/:id/engagement                             */
/* ------------------------------------------------------------------ */

export interface InteractionEngagementRow {
  interactionType: InteractionType | string;
  starts: number;
  completions: number;
  /** starts - completions. The funnel definition, not a guess. */
  abandons: number;
  completionRate: number | null;
  wrongChoices: number;
  hintsOffered: number;
  /** Mean response_time_ms on interaction_completed. */
  avgMs: number | null;
  /** quantile(0.5) of the same population. */
  medianMs: number | null;
}

export interface EngagementResponse extends AnalyticsEnvelope {
  childId: string;
  interactions: InteractionEngagementRow[];
  /** Highest completion rate with enough starts to be meaningful. */
  preferredInteraction: InteractionType | null;
  /** Lowest completion rate. What we should stop showing this child. */
  lowEngagementInteraction: InteractionType | null;
  scenesStarted: number;
  scenesCompleted: number;
  storiesStarted: number;
  storiesCompleted: number;
  storiesAbandoned: number;
  minStartsForPreference: number;
  sql: string;
}

/* ------------------------------------------------------------------ */
/* GET /api/analytics/child/:id/hints                                  */
/* ------------------------------------------------------------------ */

/** Per companion intervention style. Powers "which help actually works". */
export interface HintStyleRow {
  intervention: string;
  offered: number;
  accepted: number;
  ignored: number;
  acceptRate: number | null;
  /** Resolved word attempts that happened after this style was shown. */
  resolvedAfter: number;
  successesAfter: number;
  successRateAfter: number | null;
}

export interface HintsResponse extends AnalyticsEnvelope {
  childId: string;
  hintsOffered: number;
  hintsAccepted: number;
  hintsIgnored: number;
  acceptRate: number | null;
  /** Attempts that followed a hint on the same word, in the same scene+session. */
  resolvedWithHint: number;
  successesWithHint: number;
  successRateWithHint: number | null;
  resolvedWithoutHint: number;
  successesWithoutHint: number;
  successRateWithoutHint: number | null;
  /** withHint - withoutHint. Positive means hints are helping this child. */
  lift: number | null;
  byStyle: HintStyleRow[];
  /** Style with the best post-hint success rate, given enough evidence. */
  bestIntervention: string | null;
  /** Derived from `lift`; falls back to a stated default when evidence is thin. */
  recommendedHelpAfterAttempt: number;
  recommendationBasis: string;
  sql: string;
}

/* ------------------------------------------------------------------ */
/* GET /api/analytics/story/:id/scenes                                 */
/* ------------------------------------------------------------------ */

export interface SceneFunnelRow {
  sceneId: string;
  starts: number;
  completions: number;
  /** starts - completions. */
  abandons: number;
  /** Rows where a `story_abandoned` event actually names this scene. */
  explicitAbandons: number;
  completionRate: number | null;
  dropOffRate: number | null;
  /** starts / starts-of-the-first-scene. How far the cohort gets. */
  reachRate: number | null;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  mistakes: number;
  /** mistakes / starts. */
  mistakeRate: number | null;
  hintsOffered: number;
  uniqueChildren: number;
  firstSeen: string | null;
}

export interface StoryScenesResponse extends AnalyticsEnvelope {
  storyId: string;
  /** Ordered by when the scene was first played, so it reads as a funnel. */
  scenes: SceneFunnelRow[];
  /** Highest mistake rate, tie-broken by lowest completion rate. */
  hardestScene: string | null;
  /** Largest absolute starts-to-completions gap. */
  biggestDropOff: string | null;
  totalStarts: number;
  totalCompletions: number;
  uniqueChildren: number;
  sql: string;
}

/* ------------------------------------------------------------------ */
/* GET /api/analytics/story/:id/words                                  */
/* ------------------------------------------------------------------ */

export interface HardWordRow {
  word: string;
  pattern: string;
  attempts: number;
  successes: number;
  failures: number;
  failureRate: number | null;
  accuracy: number | null;
  childrenAffected: number;
  avgResponseMs: number | null;
  hintRate: number | null;
}

export interface StoryWordsResponse extends AnalyticsEnvelope {
  storyId: string;
  /** Hardest first. */
  words: HardWordRow[];
  hardestWord: string | null;
  limit: number;
  sql: string;
}

/* ------------------------------------------------------------------ */
/* GET /api/analytics/live/:childId  and  GET /api/events/recent       */
/* ------------------------------------------------------------------ */

/** A raw row, straight out of the table. This is the "it is really real" view. */
export interface LiveEventRow {
  eventId: string;
  timestamp: string;
  sessionId: string;
  childId: string;
  storyId: string;
  sceneId: string;
  eventType: GameEventType | string;
  interactionType: string;
  word: string;
  phoneme: string;
  correct: boolean | null;
  attemptNumber: number;
  responseTimeMs: number;
  hintUsed: boolean;
  companionIntervention: string;
}

export interface LiveResponse extends AnalyticsEnvelope {
  childId: string;
  limit: number;
  /** Newest first. */
  events: LiveEventRow[];
  /** Total rows stored for this child, not just the returned page. */
  totalEvents: number;
  sql: string;
}

export interface RecentEventsResponse extends AnalyticsEnvelope {
  /** Null when the caller asked for every child. */
  childId: string | null;
  limit: number;
  events: LiveEventRow[];
  sql: string;
}

/* ------------------------------------------------------------------ */
/* GET /api/analytics/health                                           */
/* ------------------------------------------------------------------ */

export interface MaterializedViewHealth {
  name: string;
  exists: boolean;
  /** Null when the view is missing or unreadable. */
  rows: number | null;
  error: string | null;
}

export interface AnalyticsHealthResponse {
  ok: boolean;
  ping: boolean;
  status: AnalyticsStatus;
  totalRows: number | null;
  distinctChildren: number | null;
  distinctStories: number | null;
  /** ISO-8601 of the newest stored event. */
  latestEvent: string | null;
  queueDepth: number;
  materializedViews: MaterializedViewHealth[];
  pingMs: number | null;
  error: string | null;
  generatedAt: string;
}

/* ------------------------------------------------------------------ */
/* POST /api/events                                                    */
/* ------------------------------------------------------------------ */

export interface IngestResponse {
  /** Rows actually written to ClickHouse (may exceed the batch: replays backlog). */
  inserted: number;
  /** Rows parked in the durable on-disk queue instead. */
  queued: number;
  /** Non-null when ClickHouse refused or was unreachable. Gameplay ignores it. */
  error: string | null;
  /** Events dropped because they did not validate. */
  rejected: number;
  /** Validation problems and any normalisation we had to apply. Capped. */
  issues: string[];
  /** Events accepted for storage (inserted + queued). */
  accepted: number;
}

export interface FlushResponse {
  inserted: number;
  queued: number;
  error: string | null;
}
