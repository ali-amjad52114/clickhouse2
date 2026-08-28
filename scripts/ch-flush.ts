/**
 * Replays the durable event queue (.data/event-queue.jsonl) into ClickHouse.
 *
 * Events are queued whenever ClickHouse is unreachable so gameplay is never
 * blocked by analytics. This drains that queue once the service is back.
 *
 * Run: npx tsx scripts/ch-flush.ts
 */
import 'dotenv/config';
import { flushQueue, ping, status, queueDepth } from '../server/db/clickhouse';

async function main() {
  const before = queueDepth();
  console.log(`ch-flush: ${before} event(s) in the local queue`);

  if (before === 0) {
    console.log('ch-flush: nothing to replay.');
    return;
  }

  const reachable = await ping();
  if (!reachable) {
    console.log(`ch-flush: ${status().detail}`);
    console.log('ch-flush: leaving the queue intact so nothing is lost.');
    process.exitCode = 1;
    return;
  }

  const result = await flushQueue();
  if (result.error) {
    console.log(`ch-flush: FAILED - ${result.error}`);
    console.log(`ch-flush: ${result.queued} event(s) returned to the queue.`);
    process.exitCode = 1;
    return;
  }

  console.log(`ch-flush: inserted ${result.inserted} event(s) into ClickHouse.`);
  console.log(`ch-flush: ${queueDepth()} event(s) remain queued.`);
}

main().catch((err) => {
  console.error('ch-flush: fatal', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
