import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GameEvent } from '../../src/shared/types';

/**
 * ClickHouse access layer.
 *
 * Truthfulness rules enforced here:
 *  - If ClickHouse is not configured, `isConfigured()` is false and every
 *    analytics endpoint reports that plainly. We never synthesise rows.
 *  - If ClickHouse is configured but temporarily unreachable, events are
 *    appended to a durable on-disk queue and replayed later. Gameplay is
 *    never blocked by an analytics failure.
 */

const DB = process.env.CLICKHOUSE_DATABASE || 'storybook';
const TABLE = 'gameplay_events';
const QUEUE_FILE = join(process.cwd(), '.data', 'event-queue.jsonl');

let client: ClickHouseClient | null = null;
let schemaReady = false;
let lastError = '';
let connected = false;

export function isConfigured(): boolean {
  return Boolean(process.env.CLICKHOUSE_HOST && process.env.CLICKHOUSE_PASSWORD !== undefined);
}

export function status() {
  return {
    configured: isConfigured(),
    connected,
    detail: !isConfigured()
      ? 'CLICKHOUSE_HOST not set in .env - analytics disabled, events queued locally'
      : connected
        ? `connected to ${process.env.CLICKHOUSE_HOST}/${DB}`
        : `configured but unreachable: ${lastError}`,
    database: DB,
    table: TABLE,
    queued: queueDepth(),
  };
}

function getClient(): ClickHouseClient {
  if (client) return client;
  const host = process.env.CLICKHOUSE_HOST!;
  const port = process.env.CLICKHOUSE_PORT || '8443';
  const secure = (process.env.CLICKHOUSE_SECURE ?? 'true') !== 'false';
  const url = host.startsWith('http')
    ? host
    : `${secure ? 'https' : 'http'}://${host}:${port}`;

  client = createClient({
    url,
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    request_timeout: 30_000,
    clickhouse_settings: {
      // Batches small inserts server-side so per-event writes stay cheap.
      async_insert: 1,
      wait_for_async_insert: 1,
    },
  });
  return client;
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

const DDL_TABLE = `
CREATE TABLE IF NOT EXISTS ${DB}.${TABLE}
(
  event_id              UUID,
  timestamp             DateTime64(3),
  session_id            String,
  child_id              String,
  story_id              String,
  scene_id              String,
  event_type            LowCardinality(String),
  interaction_type      LowCardinality(String),
  word                  String,
  phoneme               String,
  correct               Nullable(Bool),
  attempt_number        UInt8,
  response_time_ms      UInt32,
  hint_used             Bool,
  companion_intervention String,
  metadata              String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (child_id, story_id, timestamp, event_id)
`;

/**
 * Real-time rollup of reading attempts per child and pattern.
 * This is what makes "what is this child struggling with?" a sub-millisecond
 * question instead of a full scan.
 */
const DDL_MV_PATTERN = `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DB}.pattern_stats_mv
ENGINE = SummingMergeTree
ORDER BY (child_id, phoneme)
POPULATE
AS SELECT
  child_id,
  phoneme,
  countIf(event_type = 'word_attempted')  AS attempts,
  countIf(event_type = 'word_succeeded')  AS successes,
  countIf(event_type = 'word_failed')     AS failures,
  sum(toUInt64(hint_used))                AS hints_used
FROM ${DB}.${TABLE}
WHERE phoneme != '' AND event_type IN ('word_attempted','word_succeeded','word_failed')
GROUP BY child_id, phoneme
`;

export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const c = getClient();
  await c.command({ query: `CREATE DATABASE IF NOT EXISTS ${DB}` });
  await c.command({ query: DDL_TABLE });
  await c.command({ query: DDL_MV_PATTERN });
  schemaReady = true;
}

export async function ping(): Promise<boolean> {
  if (!isConfigured()) {
    connected = false;
    lastError = 'not configured';
    return false;
  }
  try {
    await getClient().query({ query: 'SELECT 1', format: 'JSONEachRow' });
    await ensureSchema();
    connected = true;
    lastError = '';
    return true;
  } catch (err) {
    connected = false;
    lastError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Durable queue - gameplay must never block on analytics              */
/* ------------------------------------------------------------------ */

function ensureQueueDir() {
  const dir = dirname(QUEUE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function enqueue(events: GameEvent[]) {
  ensureQueueDir();
  appendFileSync(QUEUE_FILE, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

export function queueDepth(): number {
  if (!existsSync(QUEUE_FILE)) return 0;
  const raw = readFileSync(QUEUE_FILE, 'utf8').trim();
  return raw ? raw.split('\n').length : 0;
}

function drainQueueFile(): GameEvent[] {
  if (!existsSync(QUEUE_FILE)) return [];
  const raw = readFileSync(QUEUE_FILE, 'utf8').trim();
  if (!raw) return [];
  writeFileSync(QUEUE_FILE, '', 'utf8');
  return raw.split('\n').flatMap((line) => {
    try { return [JSON.parse(line) as GameEvent]; } catch { return []; }
  });
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/** Row shape ClickHouse expects: Bool nullable and DateTime64 as string. */
function toRow(e: GameEvent) {
  return {
    ...e,
    timestamp: e.timestamp.replace('T', ' ').replace('Z', ''),
    correct: e.correct === null ? null : e.correct,
  };
}

export interface InsertOutcome {
  inserted: number;
  queued: number;
  error: string | null;
}

export async function insertEvents(events: GameEvent[]): Promise<InsertOutcome> {
  if (events.length === 0) return { inserted: 0, queued: 0, error: null };

  if (!isConfigured()) {
    enqueue(events);
    return { inserted: 0, queued: events.length, error: 'clickhouse not configured' };
  }

  // Opportunistically replay anything stranded by an earlier outage.
  const backlog = connected ? drainQueueFile() : [];
  const batch = [...backlog, ...events];

  try {
    await ensureSchema();
    await getClient().insert({
      table: `${DB}.${TABLE}`,
      values: batch.map(toRow),
      format: 'JSONEachRow',
    });
    connected = true;
    lastError = '';
    return { inserted: batch.length, queued: 0, error: null };
  } catch (err) {
    connected = false;
    lastError = err instanceof Error ? err.message : String(err);
    enqueue(batch);
    return { inserted: 0, queued: batch.length, error: lastError };
  }
}

/** Replays the on-disk queue. Called on boot and by /api/analytics/flush. */
export async function flushQueue(): Promise<InsertOutcome> {
  if (!isConfigured()) return { inserted: 0, queued: queueDepth(), error: 'not configured' };
  const pending = drainQueueFile();
  if (pending.length === 0) return { inserted: 0, queued: 0, error: null };
  return insertEvents(pending);
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function query<T>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
  await ensureSchema();
  const rs = await getClient().query({
    query: sql,
    query_params: params,
    format: 'JSONEachRow',
  });
  connected = true;
  return rs.json<T>();
}

export const CH = { DB, TABLE };
