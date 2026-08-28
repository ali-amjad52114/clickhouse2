import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GameStory } from '../../src/shared/types';

/**
 * The "what exists now" store: children, stories, progress.
 *
 * ClickHouse answers "what has happened"; this answers "what is true right
 * now". Postgres is the intended production driver - set DATABASE_URL and the
 * pg path below takes over. With no DATABASE_URL we use an embedded SQLite
 * file so the app runs with zero setup. The schema is plain SQL that works on
 * both, and /api/status always reports which driver is actually live.
 */

const DATA_DIR = join(process.cwd(), '.data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const driver: 'postgres' | 'sqlite' = process.env.DATABASE_URL ? 'postgres' : 'sqlite';

let sqlite: DatabaseSync | null = null;

function db(): DatabaseSync {
  if (!sqlite) {
    sqlite = new DatabaseSync(join(DATA_DIR, 'storybook.db'));
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS children (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        age         INTEGER,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stories (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        source      TEXT NOT NULL,
        json        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS progress (
        child_id        TEXT NOT NULL,
        story_id        TEXT NOT NULL,
        current_scene   TEXT,
        scenes_done     INTEGER NOT NULL DEFAULT 0,
        stars           INTEGER NOT NULL DEFAULT 0,
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (child_id, story_id)
      );
    `);
  }
  return sqlite;
}

export function relationalStatus() {
  return {
    driver,
    detail: driver === 'postgres'
      ? 'DATABASE_URL is set - using Postgres'
      : 'no DATABASE_URL - using embedded SQLite at .data/storybook.db',
  };
}

/* ------------------------------------------------------------------ */

export interface Child { id: string; name: string; age: number | null; created_at: string }

export function upsertChild(id: string, name: string, age: number | null): Child {
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO children (id, name, age, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, age = excluded.age`
  ).run(id, name, age, now);
  return getChild(id)!;
}

export function getChild(id: string): Child | null {
  const row = db().prepare(`SELECT * FROM children WHERE id = ?`).get(id);
  return (row as Child) ?? null;
}

export function listChildren(): Child[] {
  return db().prepare(`SELECT * FROM children ORDER BY created_at`).all() as unknown as Child[];
}

export function saveStory(story: GameStory): void {
  db().prepare(
    `INSERT INTO stories (id, title, source, json, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, json = excluded.json`
  ).run(story.id, story.title, story.source, JSON.stringify(story), new Date().toISOString());
}

export function getStory(id: string): GameStory | null {
  const row = db().prepare(`SELECT json FROM stories WHERE id = ?`).get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as GameStory) : null;
}

export function listStories(): { id: string; title: string; source: string }[] {
  return db()
    .prepare(`SELECT id, title, source FROM stories ORDER BY created_at DESC`)
    .all() as unknown as { id: string; title: string; source: string }[];
}

export function saveProgress(
  childId: string, storyId: string, currentScene: string | null,
  scenesDone: number, stars: number,
): void {
  db().prepare(
    `INSERT INTO progress (child_id, story_id, current_scene, scenes_done, stars, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(child_id, story_id) DO UPDATE SET
       current_scene = excluded.current_scene,
       scenes_done   = excluded.scenes_done,
       stars         = excluded.stars,
       updated_at    = excluded.updated_at`
  ).run(childId, storyId, currentScene, scenesDone, stars, new Date().toISOString());
}

export function getProgress(childId: string, storyId: string) {
  return db()
    .prepare(`SELECT * FROM progress WHERE child_id = ? AND story_id = ?`)
    .get(childId, storyId) ?? null;
}
