import { Router } from 'express';
import { z } from 'zod';

import { getStory, listStories, saveStory } from '../db/relational.js';
import { llmStatus, LlmNotConfiguredError, LlmRequestError } from '../services/llm.js';
import {
  generateStory,
  INTERACTION_TYPES,
  StoryInputError,
} from '../services/storyGen.js';

const router = Router();

/**
 * Story surface.
 *
 * /capabilities exists so the UI can disable the generate button for an honest
 * reason instead of letting a child press a button that cannot work. Nothing
 * here ever invents a story: if generation fails, the caller gets the real
 * validation issues or the real upstream error.
 */

/* ------------------------------------------------------------------ */
/* GET /api/story/capabilities                                         */
/* ------------------------------------------------------------------ */

router.get('/capabilities', (_req, res) => {
  const s = llmStatus();
  res.json({
    llmConfigured: s.configured,
    provider: s.provider,
    model: s.model,
    endpoint: s.endpoint,
    detail: s.detail,
    interactionTypes: INTERACTION_TYPES,
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/story/list                                                 */
/* ------------------------------------------------------------------ */

router.get('/list', (_req, res) => {
  res.json({ stories: listStories() });
});

/* ------------------------------------------------------------------ */
/* POST /api/story/generate                                            */
/* ------------------------------------------------------------------ */

const generateBody = z.object({
  text: z.string(),
  title: z.string().max(120).optional(),
  adapt: z
    .object({
      targetPattern: z.string().min(1).max(4).optional(),
      preferredInteraction: z.enum(INTERACTION_TYPES).optional(),
    })
    .optional(),
});

router.post('/generate', async (req, res) => {
  const parsed = generateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid request body',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }

  try {
    const outcome = await generateStory({
      text: parsed.data.text,
      title: parsed.data.title,
      adapt: parsed.data.adapt,
    });

    if (!outcome.ok) {
      // Real model output that never became playable. No substitute is offered.
      res.status(422).json({
        error: `the model could not produce a valid story after ${outcome.meta.repairs} repair attempts`,
        issues: outcome.issues,
        meta: outcome.meta,
      });
      return;
    }

    saveStory(outcome.story);
    res.json({ story: outcome.story, meta: outcome.meta });
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) {
      res.status(503).json({
        error: 'story generation is not configured',
        llmConfigured: false,
        detail: err.message,
      });
      return;
    }
    if (err instanceof StoryInputError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof LlmRequestError) {
      res.status(err.status).json({
        error: err.message,
        detail: err.detail,
        upstreamStatus: err.upstreamStatus,
      });
      return;
    }
    throw err;
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/story/:id                                                  */
/* Registered last so it never shadows the named routes above.         */
/* ------------------------------------------------------------------ */

router.get('/:id', (req, res) => {
  const story = getStory(req.params.id);
  if (!story) {
    res.status(404).json({ error: `no story with id "${req.params.id}"` });
    return;
  }
  res.json(story);
});

export default router;
