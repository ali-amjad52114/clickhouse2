/**
 * Child profile + adaptation.
 *
 * GET  /api/profile/:childId              the derived ChildProfile
 * GET  /api/profile/:childId/policy       the RuntimePolicy the game consumes
 * GET  /api/profile/:childId/adaptation   the plan + the evidence behind it
 * POST /api/profile/:childId/adapt        {storyId} - applies and persists
 * GET  /api/profile/                      children that have produced events
 *
 * Every response names its evidence source. Nothing here invents a number.
 */

import { Router } from 'express';
import { buildProfile, knownChildren, THRESHOLDS } from '../services/profile';
import { applyPlan, planFor, policyFor } from '../services/adaptation';
import { getProgress, listChildren, saveProgress, upsertChild } from '../db/relational';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const withEvents = await knownChildren();
    res.json({ children: listChildren(), withEvents, thresholds: THRESHOLDS });
  } catch (err) { next(err); }
});

router.get('/:childId', async (req, res, next) => {
  try {
    res.json(await buildProfile(req.params.childId));
  } catch (err) { next(err); }
});

router.get('/:childId/policy', async (req, res, next) => {
  try {
    res.json(await policyFor(req.params.childId));
  } catch (err) { next(err); }
});

router.get('/:childId/adaptation', async (req, res, next) => {
  try {
    const { plan, profile, narrationSource } = await planFor(req.params.childId);
    res.json({
      plan,
      narrationSource,
      evidenceSource: profile.evidenceSource,
      sourceDetail: profile.sourceDetail,
      thresholds: profile.thresholds,
      evidence: profile.reading.patternStats,
      overallAccuracy: profile.reading.overallAccuracy,
      eventCount: profile.eventCount,
    });
  } catch (err) { next(err); }
});

router.post('/:childId/adapt', async (req, res, next) => {
  try {
    const storyId = String(req.body?.storyId ?? '').trim();
    if (!storyId) {
      res.status(400).json({ error: 'storyId is required' });
      return;
    }
    const result = await applyPlan(req.params.childId, storyId);
    res.status(result.applied ? 200 : 409).json(result);
  } catch (err) { next(err); }
});

/** The game persists progress here. Fire-and-forget from the client. */
router.post('/:childId/progress', (req, res, next) => {
  try {
    const { storyId, currentScene, scenesDone, stars, name } = req.body ?? {};
    if (!storyId) {
      res.status(400).json({ error: 'storyId is required' });
      return;
    }
    upsertChild(req.params.childId, String(name ?? req.params.childId), null);
    saveProgress(
      req.params.childId, String(storyId),
      currentScene ? String(currentScene) : null,
      Number(scenesDone ?? 0), Number(stars ?? 0),
    );
    res.json({ ok: true, progress: getProgress(req.params.childId, String(storyId)) });
  } catch (err) { next(err); }
});

export default router;
