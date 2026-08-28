/**
 * Proof that data actually landed in ClickHouse.
 *
 *   npx tsx scripts/ch-inspect.ts
 *   npx tsx scripts/ch-inspect.ts --child maya --limit 20
 *
 * Prints row counts, materialized-view contents and a sample of raw rows.
 * Every number here comes from a query run at the moment you ran the script.
 */

import 'dotenv/config';
import { CH, isConfigured, ping, query, queueDepth, status } from '../server/db/clickhouse.ts';

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const childFilter = arg('--child');
const sampleLimit = Math.min(Math.max(Number(arg('--limit')) || 10, 1), 100);
const T = `${CH.DB}.${CH.TABLE}`;

function table(rows: Record<string, unknown>[], title: string) {
  console.log(`\n${title}`);
  if (rows.length === 0) {
    console.log('  (no rows)');
    return;
  }
  console.table(rows);
}

async function main() {
  console.log(`ch-inspect: database "${CH.DB}", table "${CH.TABLE}"`);

  if (!isConfigured()) {
    console.log('');
    console.log('NOT CONFIGURED. CLICKHOUSE_HOST / CLICKHOUSE_PASSWORD are missing from .env.');
    console.log(`Events are queued locally instead: ${queueDepth()} waiting in .data/event-queue.jsonl`);
    console.log('Fill in .env (see .env.example), then run: npx tsx scripts/ch-setup.ts');
    process.exitCode = 1;
    return;
  }

  const reachable = await ping();
  console.log(`ch-inspect: ${status().detail}`);
  if (!reachable) {
    console.log(`ch-inspect: ${queueDepth()} events waiting in the local queue.`);
    process.exitCode = 1;
    return;
  }

  /* ---------------- totals ---------------- */

  const totals = await query<Record<string, unknown>>(`
    SELECT
      toFloat64(count())               AS rows,
      toFloat64(uniqExact(child_id))   AS children,
      toFloat64(uniqExact(story_id))   AS stories,
      toFloat64(uniqExact(session_id)) AS sessions,
      toString(min(timestamp))         AS first_event,
      toString(max(timestamp))         AS last_event
    FROM ${T}`);
  table(totals, `TOTALS  ${T}`);

  const rowCount = Number(totals[0]?.rows ?? 0);
  console.log(`\nlocal queue depth: ${queueDepth()}`);

  if (rowCount === 0) {
    console.log('\nThe table exists but holds no rows yet.');
    console.log('Play a scene, or POST to /api/events, then run this again.');
    return;
  }

  /* ---------------- breakdowns ---------------- */

  table(
    await query<Record<string, unknown>>(`
      SELECT event_type, toFloat64(count()) AS events
      FROM ${T}
      GROUP BY event_type
      ORDER BY events DESC`),
    'ROWS BY EVENT TYPE',
  );

  table(
    await query<Record<string, unknown>>(`
      SELECT
        child_id,
        toFloat64(count())                                 AS events,
        toFloat64(uniqExact(story_id))                     AS stories,
        toFloat64(countIf(event_type = 'word_attempted'))  AS word_attempts,
        toString(max(timestamp))                           AS last_seen
      FROM ${T}
      GROUP BY child_id
      ORDER BY events DESC
      LIMIT 20`),
    'ROWS BY CHILD',
  );

  /* ---------------- materialized views ---------------- */

  for (const view of ['pattern_stats_mv', 'scene_funnel_mv', 'hint_effect_mv']) {
    try {
      const rows = await query<Record<string, unknown>>(
        `SELECT * FROM ${CH.DB}.${view} ORDER BY 1, 2 LIMIT 15`,
      );
      table(rows, `MATERIALIZED VIEW  ${CH.DB}.${view}  (first 15)`);
    } catch (err) {
      console.log(`\nMATERIALIZED VIEW  ${CH.DB}.${view}`);
      console.log(`  UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`);
      console.log('  run: npx tsx scripts/ch-setup.ts');
    }
  }

  /* ---------------- raw sample ---------------- */

  const sample = childFilter
    ? await query<Record<string, unknown>>(
        `SELECT toString(timestamp) AS ts, event_type, scene_id, interaction_type, word, phoneme,
                correct, attempt_number, response_time_ms, hint_used
         FROM ${T}
         WHERE child_id = {childId:String}
         ORDER BY timestamp DESC
         LIMIT {limit:UInt32}`,
        { childId: childFilter, limit: sampleLimit },
      )
    : await query<Record<string, unknown>>(
        `SELECT toString(timestamp) AS ts, child_id, event_type, scene_id, interaction_type, word,
                phoneme, correct, attempt_number, response_time_ms, hint_used
         FROM ${T}
         ORDER BY timestamp DESC
         LIMIT {limit:UInt32}`,
        { limit: sampleLimit },
      );

  table(
    sample,
    `RAW SAMPLE  newest ${sampleLimit}${childFilter ? ` for child "${childFilter}"` : ''}`,
  );
}

await main();
