/**
 * Creates the ClickHouse database, the event table and every materialized view
 * this app reads from.
 *
 *   npx tsx scripts/ch-setup.ts
 *
 * Safe to run repeatedly - every statement is IF NOT EXISTS.
 *
 * The base table and `pattern_stats_mv` are owned by server/db/clickhouse.ts
 * (`ensureSchema`). This script calls that first, then layers on the extra
 * views. It never rewrites what that module already defines.
 *
 * Pass --drop-views to recreate the extra views from scratch (POPULATE will
 * re-read the whole table). Useful when a view definition changes.
 */

import 'dotenv/config';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { CH, ensureSchema, isConfigured, status } from '../server/db/clickhouse.ts';

/* ------------------------------------------------------------------ */
/* DDL                                                                 */
/* ------------------------------------------------------------------ */

export interface Ddl {
  name: string;
  purpose: string;
  sql: string;
}

/**
 * Built from CH.DB at call time so a throwaway verification database can reuse
 * exactly the statements production runs.
 */
export function extraDdl(): Ddl[] {
  const db = CH.DB;
  const table = `${db}.${CH.TABLE}`;

  return [
    {
      name: 'scene_funnel_mv',
      purpose: 'per story x scene: starts, completions, abandons, duration, mistakes',
      sql: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${db}.scene_funnel_mv
ENGINE = SummingMergeTree
ORDER BY (story_id, scene_id)
POPULATE
AS SELECT
  story_id,
  scene_id,
  countIf(event_type = 'scene_started')    AS starts,
  countIf(event_type = 'scene_completed')  AS completions,
  countIf(event_type = 'story_abandoned')  AS explicit_abandons,
  countIf(event_type = 'wrong_choice')     AS mistakes,
  countIf(event_type = 'hint_offered')     AS hints_offered,
  sumIf(toUInt64(response_time_ms), event_type = 'scene_completed' AND response_time_ms > 0) AS duration_ms_sum,
  countIf(event_type = 'scene_completed' AND response_time_ms > 0)                           AS duration_samples
FROM ${table}
WHERE scene_id != ''
GROUP BY story_id, scene_id`.trim(),
    },
    {
      name: 'hint_effect_mv',
      purpose: 'per child x intervention style: attempts and successes, with a hint vs without',
      sql: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${db}.hint_effect_mv
ENGINE = SummingMergeTree
ORDER BY (child_id, intervention)
POPULATE
AS SELECT
  child_id,
  if(companion_intervention = '', 'none', companion_intervention) AS intervention,
  countIf(event_type = 'hint_offered')                       AS hints_offered,
  countIf(event_type = 'hint_accepted')                      AS hints_accepted,
  countIf(event_type = 'hint_ignored')                       AS hints_ignored,
  countIf(event_type = 'word_attempted' AND hint_used)       AS attempts_with_hint,
  countIf(event_type = 'word_attempted' AND NOT hint_used)   AS attempts_without_hint,
  countIf(event_type = 'word_succeeded' AND hint_used)       AS successes_with_hint,
  countIf(event_type = 'word_succeeded' AND NOT hint_used)   AS successes_without_hint,
  countIf(event_type = 'word_failed' AND hint_used)          AS failures_with_hint,
  countIf(event_type = 'word_failed' AND NOT hint_used)      AS failures_without_hint
FROM ${table}
GROUP BY child_id, intervention`.trim(),
    },
  ];
}

/** Views this app depends on, including the one owned by clickhouse.ts. */
export const MATERIALIZED_VIEWS = ['pattern_stats_mv', 'scene_funnel_mv', 'hint_effect_mv'];

/* ------------------------------------------------------------------ */
/* Client - clickhouse.ts exposes no `command` helper, and DDL cannot  */
/* go through `query` (the driver appends a FORMAT clause).            */
/* ------------------------------------------------------------------ */

export function ddlClient(): ClickHouseClient {
  const host = process.env.CLICKHOUSE_HOST!;
  const port = process.env.CLICKHOUSE_PORT || '8443';
  const secure = (process.env.CLICKHOUSE_SECURE ?? 'true') !== 'false';
  const url = host.startsWith('http') ? host : `${secure ? 'https' : 'http'}://${host}:${port}`;
  return createClient({
    url,
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    request_timeout: 60_000,
  });
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

export interface SetupResult {
  ok: boolean;
  database: string;
  applied: string[];
  failed: { name: string; error: string }[];
  error: string | null;
}

export async function runSetup(opts: { dropViews?: boolean; log?: boolean } = {}): Promise<SetupResult> {
  const log = opts.log ?? true;
  const say = (msg: string) => { if (log) console.log(msg); };

  const result: SetupResult = {
    ok: false,
    database: CH.DB,
    applied: [],
    failed: [],
    error: null,
  };

  if (!isConfigured()) {
    result.error =
      'ClickHouse is not configured. Set CLICKHOUSE_HOST and CLICKHOUSE_PASSWORD in .env ' +
      '(see .env.example). Until then the API queues events to .data/event-queue.jsonl and ' +
      'every analytics endpoint reports hasData:false.';
    say(`SKIPPED. ${result.error}`);
    return result;
  }

  const client = ddlClient();
  try {
    // Base schema: database, gameplay_events, pattern_stats_mv.
    await ensureSchema();
    result.applied.push('database', CH.TABLE, 'pattern_stats_mv');
    say(`ok  database ${CH.DB}`);
    say(`ok  table    ${CH.DB}.${CH.TABLE}`);
    say(`ok  view     ${CH.DB}.pattern_stats_mv  (owned by server/db/clickhouse.ts)`);

    for (const ddl of extraDdl()) {
      try {
        if (opts.dropViews) {
          await client.command({ query: `DROP VIEW IF EXISTS ${CH.DB}.${ddl.name}` });
          say(`--  dropped ${ddl.name}`);
        }
        await client.command({ query: ddl.sql });
        result.applied.push(ddl.name);
        say(`ok  view     ${CH.DB}.${ddl.name}  - ${ddl.purpose}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.failed.push({ name: ddl.name, error: message });
        say(`FAIL view    ${CH.DB}.${ddl.name}: ${message}`);
      }
    }

    // Report what actually exists now, rather than assuming the DDL worked.
    const rs = await client.query({
      query: `
        SELECT name, engine
        FROM system.tables
        WHERE database = {db:String}
        ORDER BY name`,
      query_params: { db: CH.DB },
      format: 'JSONEachRow',
    });
    const tables = await rs.json<{ name: string; engine: string }>();
    say('');
    say(`objects in ${CH.DB}:`);
    for (const t of tables) {
      if (t.name.startsWith('.inner')) continue;
      say(`  ${t.name.padEnd(24)} ${t.engine}`);
    }

    const missing = MATERIALIZED_VIEWS.filter((v) => !tables.some((t) => t.name === v));
    if (missing.length > 0) {
      say('');
      say(`MISSING views: ${missing.join(', ')}`);
    }

    result.ok = result.failed.length === 0 && missing.length === 0;
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    say(`FAILED to reach ClickHouse: ${result.error}`);
    return result;
  } finally {
    await client.close();
  }
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/ch-setup.ts');

if (isMain) {
  const dropViews = process.argv.includes('--drop-views');
  console.log(`ch-setup: target database "${CH.DB}"`);
  console.log(`ch-setup: host ${process.env.CLICKHOUSE_HOST || '(not set)'}`);
  console.log('');
  const res = await runSetup({ dropViews });
  console.log('');
  if (res.ok) {
    console.log(`ch-setup: ${status().detail}`);
    console.log('ch-setup: schema ready.');
    console.log('ch-setup: run "npx tsx scripts/ch-inspect.ts" to see what is stored.');
  } else {
    console.log('ch-setup: schema NOT ready.');
    // Report the actual failure, not the shared client's stale status string.
    if (res.error) console.log(`  ${res.error}`);
    for (const f of res.failed) console.log(`  ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
}
