/**
 * Analytics read API. Every route is backed by SQL in server/services/analytics.ts.
 *
 *   GET  /api/analytics/child/:id/patterns
 *   GET  /api/analytics/child/:id/engagement
 *   GET  /api/analytics/child/:id/hints
 *   GET  /api/analytics/story/:id/scenes
 *   GET  /api/analytics/story/:id/words
 *   GET  /api/analytics/live/:childId
 *   GET  /api/analytics/health
 *   GET  /api/analytics/sql            - the literal SQL behind every endpoint
 *   POST /api/analytics/flush          - replay the durable queue
 *
 * These answer 200 even when ClickHouse is unreachable. The body then carries
 * hasData:false plus the real error text, so the UI can say what is wrong
 * instead of showing a spinner or a made-up number.
 */

import { Router } from 'express';

import {
  SQL,
  childEngagement,
  childHints,
  childPatterns,
  health,
  liveEvents,
  storyScenes,
  storyWords,
} from '../services/analytics.ts';
import { flushQueue } from '../db/clickhouse.ts';
import type { FlushResponse } from '../../src/shared/analyticsTypes.ts';

const router = Router();

router.get('/child/:id/patterns', async (req, res) => {
  res.json(await childPatterns(req.params.id, Number(req.query.evidenceLimit) || 40));
});

router.get('/child/:id/engagement', async (req, res) => {
  res.json(await childEngagement(req.params.id));
});

router.get('/child/:id/hints', async (req, res) => {
  res.json(await childHints(req.params.id));
});

router.get('/story/:id/scenes', async (req, res) => {
  res.json(await storyScenes(req.params.id));
});

router.get('/story/:id/words', async (req, res) => {
  res.json(await storyWords(req.params.id, req.query.limit));
});

router.get('/live/:childId', async (req, res) => {
  res.json(await liveEvents(req.params.childId, req.query.limit));
});

router.get('/health', async (_req, res) => {
  res.json(await health());
});

/** Every query this app can run, for the judge view. */
router.get('/sql', (_req, res) => {
  res.json({
    note: 'These are the literal query texts executed. User input is bound via ClickHouse query_params ({name:Type}); nothing is string-interpolated.',
    queries: SQL,
  });
});

router.post('/flush', async (_req, res) => {
  const outcome = await flushQueue();
  const payload: FlushResponse = {
    inserted: outcome.inserted,
    queued: outcome.queued,
    error: outcome.error,
  };
  res.json(payload);
});

export default router;
