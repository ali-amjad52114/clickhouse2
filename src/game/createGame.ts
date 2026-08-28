import * as Phaser from 'phaser';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from './art/contract';
import { BootScene } from './scenes/BootScene';
import { HomeScene } from './scenes/HomeScene';
import { StoryScene } from './scenes/StoryScene';
import { CompletionScene } from './scenes/CompletionScene';
import { REGISTRY, loadStory } from './StoryEngine';
import type { GameHooks, StoryEngine } from './StoryEngine';
import { createSystems } from './systems';
import type { GameSystems } from './systems';
import type { RuntimePolicy } from './engineContract';
import type { ValidationIssue } from '../shared/storySchema';

/**
 * The only entry point the React shell needs.
 *
 * Story JSON is validated before a game is built. An invalid story returns
 * `ok: false` with the real validation issues - it never boots a half-broken
 * book and never substitutes placeholder content.
 */

export interface CreateGameOptions {
  /** DOM element (or element id) the canvas mounts into. */
  parent: HTMLElement | string;
  /** Untrusted GameStory JSON: the builtin file or LLM output. */
  story: unknown;
  childId: string;
  sessionId?: string;
  /** Adaptation policy. Omit to run on DEFAULT_POLICY (source: 'default'). */
  policy?: RuntimePolicy;
  hooks?: GameHooks;
  /** Start muted. The in-game toggle flips it afterwards. */
  muted?: boolean;
}

export type CreateGameResult =
  | { ok: true; game: Phaser.Game; engine: StoryEngine; systems: GameSystems }
  | { ok: false; issues: ValidationIssue[] };

export function createGame(opts: CreateGameOptions): CreateGameResult {
  const loaded = loadStory(opts.story, {
    childId: opts.childId,
    sessionId: opts.sessionId,
    policy: opts.policy,
  });

  if (!loaded.ok) return { ok: false, issues: loaded.issues };
  const engine = loaded.engine;

  // Systems outlive individual scenes: the star total, the analytics session
  // and the progress record must survive every page turn.
  const systems = createSystems({
    childId: engine.childId,
    story: engine.story,
    sessionId: engine.sessionId,
    muted: opts.muted,
  });

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: opts.parent,
    backgroundColor: '#0b1020',
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: DESIGN_WIDTH,
      height: DESIGN_HEIGHT,
    },
    render: {
      antialias: true,
      roundPixels: false,
      powerPreference: 'high-performance',
    },
    // No physics: every motion in this game is a tween.
    scene: [BootScene, HomeScene, StoryScene, CompletionScene],
  });

  game.registry.set(REGISTRY.engine, engine);
  game.registry.set(REGISTRY.hooks, opts.hooks ?? {});
  game.registry.set(REGISTRY.systems, systems);

  return { ok: true, game, engine, systems };
}

/** Tear the canvas down. Call from a React effect cleanup. */
export function destroyGame(game: Phaser.Game): void {
  const systems = game.registry.get(REGISTRY.systems) as GameSystems | undefined;
  void systems?.destroy();
  game.destroy(true);
}
