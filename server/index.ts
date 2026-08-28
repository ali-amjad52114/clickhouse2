import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as ch from './db/clickhouse';
import { relationalStatus, saveStory, listChildren, upsertChild } from './db/relational';
import { validateStory } from '../src/shared/storySchema';
import type { GameStory } from '../src/shared/types';

import eventsRouter from './routes/events';
import analyticsRouter from './routes/analytics';
import profileRouter from './routes/profile';
import storyRouter from './routes/story';
import speechRouter from './routes/speech';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 8787);

/* ------------------------------------------------------------------ */
/* Status - the honesty endpoint. The UI reads this to decide what to  */
/* claim. Nothing in this app ever reports a capability it lacks.      */
/* ------------------------------------------------------------------ */

app.get('/api/status', async (_req, res) => {
  await ch.ping();
  res.json({
    clickhouse: ch.status(),
    relational: relationalStatus(),
    llm: {
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      provider: 'anthropic',
      model: process.env.LLM_MODEL || 'claude-sonnet-5',
      detail: process.env.ANTHROPIC_API_KEY
        ? 'ANTHROPIC_API_KEY present - story generation live'
        : 'ANTHROPIC_API_KEY not set - story generation disabled',
    },
    tts: {
      // Browser-side Web Speech API; the server only reports policy.
      available: true,
      detail: 'using browser SpeechSynthesis; falls back to subtitles',
    },
  });
});

app.use('/api/events', eventsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/profile', profileRouter);
app.use('/api/story', storyRouter);
app.use('/api/speech', speechRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[api error]', message);
  res.status(500).json({ error: message });
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function seedBuiltinStory() {
  const path = join(process.cwd(), 'src', 'stories', 'fox-and-lost-star.json');
  const story = JSON.parse(readFileSync(path, 'utf8')) as GameStory;
  const result = validateStory(story);
  if (!result.ok) {
    console.error('[boot] builtin story failed validation:', result.issues);
    return;
  }
  saveStory(story);
  console.log(`[boot] seeded builtin story "${story.title}" (${story.scenes.length} scenes)`);
}

async function boot() {
  seedBuiltinStory();
  if (listChildren().length === 0) {
    upsertChild('maya', 'Maya', 6);
    console.log('[boot] created demo child "Maya"');
  }

  const reachable = await ch.ping();
  const s = ch.status();
  console.log(`[boot] clickhouse: ${s.detail}`);
  if (reachable) {
    const flushed = await ch.flushQueue();
    if (flushed.inserted > 0) console.log(`[boot] replayed ${flushed.inserted} queued events`);
  } else if (s.queued > 0) {
    console.log(`[boot] ${s.queued} events waiting in local queue`);
  }
  console.log(`[boot] relational: ${relationalStatus().detail}`);

  app.listen(PORT, () => console.log(`[boot] api listening on http://localhost:${PORT}`));
}

boot().catch((err) => {
  console.error('[boot] fatal', err);
  process.exit(1);
});
