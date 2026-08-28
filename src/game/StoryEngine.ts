import type { GameStory, StoryScene } from '../shared/types';
import { validateStory } from '../shared/storySchema';
import type { ValidationIssue } from '../shared/storySchema';
import { DEFAULT_POLICY } from './engineContract';
import type { RuntimePolicy } from './engineContract';

/**
 * StoryEngine - the story-agnostic run state.
 *
 * It knows nothing about any particular book. Give it validated GameStory JSON
 * and it walks the scene graph, tracks what the child actually completed, and
 * hands the Phaser scenes the current page. All rendering lives elsewhere.
 */

export interface SceneOutcome {
  sceneId: string;
  /** False when the child skipped or the interaction could not run. */
  completed: boolean;
  starsAwarded: number;
  attempts: number;
  wrongChoices: number;
  hintsOffered: number;
  hintsAccepted: number;
  elapsedMs: number;
}

export interface RunSummary {
  storyId: string;
  title: string;
  childId: string;
  sessionId: string;
  scenesCompleted: number;
  totalScenes: number;
  stars: number;
  durationMs: number;
  outcomes: SceneOutcome[];
}

export interface StoryEngineOptions {
  childId: string;
  sessionId?: string;
  policy?: RuntimePolicy;
}

export type StoryLoadResult =
  | { ok: true; engine: StoryEngine }
  | { ok: false; issues: ValidationIssue[] };

/**
 * Validate untrusted story JSON (builtin file or LLM output) and build an
 * engine for it. Invalid stories never reach a child's screen.
 */
export function loadStory(input: unknown, opts: StoryEngineOptions): StoryLoadResult {
  const result = validateStory(input);
  if (!result.ok) return { ok: false, issues: result.issues };
  return { ok: true, engine: new StoryEngine(input as GameStory, opts) };
}

export class StoryEngine {
  readonly story: GameStory;
  readonly childId: string;
  readonly sessionId: string;

  private byId = new Map<string, StoryScene>();
  private order: string[] = [];
  private cursor = 0;
  private outcomes: SceneOutcome[] = [];
  private stars = 0;
  private startedAt = 0;
  private endedAt = 0;
  private policy: RuntimePolicy;

  constructor(story: GameStory, opts: StoryEngineOptions) {
    this.story = story;
    this.childId = opts.childId;
    this.sessionId = opts.sessionId ?? newId();
    this.policy = opts.policy ?? { ...DEFAULT_POLICY };
    for (const scene of story.scenes) this.byId.set(scene.id, scene);
    this.order = buildOrder(story, this.byId);
  }

  /* -------------------------------------------------- run lifecycle */

  /** Reset to page one. Called by the title screen and by "play again". */
  start(): StoryScene | null {
    this.cursor = 0;
    this.outcomes = [];
    this.stars = 0;
    this.startedAt = Date.now();
    this.endedAt = 0;
    return this.currentScene();
  }

  hasStarted(): boolean {
    return this.startedAt > 0;
  }

  /* -------------------------------------------------- scene access */

  currentScene(): StoryScene | null {
    const id = this.order[this.cursor];
    return id ? this.byId.get(id) ?? null : null;
  }

  sceneById(id: string): StoryScene | null {
    return this.byId.get(id) ?? null;
  }

  /** 1-based page number, for progress pips. */
  sceneNumber(): number {
    return this.cursor + 1;
  }

  totalScenes(): number {
    return this.order.length;
  }

  /** Scene ids in play order. Drives the progress pips. */
  sceneOrder(): string[] {
    return [...this.order];
  }

  isFirstScene(): boolean {
    return this.cursor === 0;
  }

  isLastScene(): boolean {
    const scene = this.currentScene();
    if (!scene) return true;
    return scene.nextScene === null || this.cursor >= this.order.length - 1;
  }

  /** Move to `nextScene`. Returns null when the story is over. */
  advance(): StoryScene | null {
    const scene = this.currentScene();
    if (!scene) return null;

    if (scene.nextScene === null) {
      this.cursor = this.order.length;
      this.endedAt = Date.now();
      return null;
    }

    const next = this.order.indexOf(scene.nextScene);
    this.cursor = next >= 0 ? next : this.cursor + 1;

    const now = this.currentScene();
    if (!now) this.endedAt = Date.now();
    return now;
  }

  /** Dev/teacher jump. Returns false for an unknown scene id. */
  jumpTo(sceneId: string): boolean {
    const idx = this.order.indexOf(sceneId);
    if (idx < 0) return false;
    this.cursor = idx;
    return true;
  }

  /* -------------------------------------------------- outcomes */

  recordOutcome(outcome: SceneOutcome): void {
    this.outcomes = this.outcomes.filter((o) => o.sceneId !== outcome.sceneId);
    this.outcomes.push(outcome);
    this.stars += outcome.starsAwarded;
  }

  scenesCompleted(): number {
    return this.outcomes.filter((o) => o.completed).length;
  }

  isSceneCompleted(sceneId: string): boolean {
    return this.outcomes.some((o) => o.sceneId === sceneId && o.completed);
  }

  totalStars(): number {
    return this.stars;
  }

  summary(): RunSummary {
    const end = this.endedAt || Date.now();
    return {
      storyId: this.story.id,
      title: this.story.title,
      childId: this.childId,
      sessionId: this.sessionId,
      scenesCompleted: this.scenesCompleted(),
      totalScenes: this.totalScenes(),
      stars: this.stars,
      durationMs: this.startedAt ? end - this.startedAt : 0,
      outcomes: [...this.outcomes],
    };
  }

  /* -------------------------------------------------- policy */

  /**
   * The live adaptation policy. Defaults until a real ClickHouse-derived
   * profile replaces it - `policy.source` says which, and is never faked.
   */
  getPolicy(): RuntimePolicy {
    return this.policy;
  }

  setPolicy(policy: RuntimePolicy): void {
    this.policy = policy;
  }
}

/* ------------------------------------------------------------------ */

/**
 * Phaser registry keys. Everything the scenes need is stashed on
 * `game.registry` by createGame() so no scene has to import React or fetch.
 */
export const REGISTRY = {
  engine: 'storyEngine',
  hooks: 'gameHooks',
  /** GameSystems, created once per play session and shared across scenes. */
  systems: 'gameSystems',
} as const;

/** Optional callbacks the React shell can listen on. */
export interface GameHooks {
  onStoryComplete?: (summary: RunSummary) => void;
  onSceneComplete?: (outcome: SceneOutcome) => void;
  onExit?: () => void;
}

/**
 * Play order follows the `nextScene` links from the first scene, not array
 * order, so a generated story can branch its authoring order freely. Cycles
 * terminate; unreachable scenes are appended so totals stay honest.
 */
function buildOrder(story: GameStory, byId: Map<string, StoryScene>): string[] {
  const seen = new Set<string>();
  const order: string[] = [];

  let cursor: string | null = story.scenes[0]?.id ?? null;
  while (cursor && !seen.has(cursor)) {
    const scene: StoryScene | undefined = byId.get(cursor);
    if (!scene) break;
    seen.add(cursor);
    order.push(cursor);
    cursor = scene.nextScene;
  }

  for (const scene of story.scenes) {
    if (!seen.has(scene.id)) order.push(scene.id);
  }
  return order;
}

function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
