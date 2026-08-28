import type Phaser from 'phaser';
import type {
  AdaptationPlan, GameEventType, Interaction, InteractionType,
  StoryScene, GameStory,
} from '../shared/types';
import type { ArtContext, CharacterView, PropView, SceneArtist } from './art/contract';

/**
 * ENGINE CONTRACT
 *
 * Three things plug into the running StoryScene and must not know about each
 * other: interaction primitives, gameplay systems, and the artist. This file
 * is the only thing all three import.
 */

/** Everything an interaction primitive is handed when it runs. */
export interface EngineContext {
  scene: Phaser.Scene;
  art: SceneArtist;
  artCtx: ArtContext;
  /** Props already drawn for this scene, keyed by prop id. */
  props: Map<string, PropView>;
  fox: CharacterView;
  mimo: CharacterView;
  story: GameStory;
  storyScene: StoryScene;
  /** The live adaptation policy. Interactions MUST respect helpAfterAttempt. */
  policy: RuntimePolicy;
  systems: Systems;
  /** Convert normalised 0..1 coords to pixels. */
  toPx(x: number, y: number): { x: number; y: number };
}

/**
 * The behavioural policy currently in force, derived from ClickHouse.
 * Defaults are used only until a real profile arrives.
 */
export interface RuntimePolicy {
  /** Failed attempts to allow before Mimo offers help. */
  helpAfterAttempt: number;
  /** How Mimo helps when it does. */
  interventionStyle: 'visual_hint' | 'spoken_hint' | 'none';
  /** Where this policy came from - shown in the dev view, never faked. */
  source: 'default' | 'clickhouse';
  plan: AdaptationPlan | null;
}

/** What every interaction primitive reports back when it finishes. */
export interface InteractionResult {
  completed: boolean;
  attempts: number;
  wrongChoices: number;
  hintsOffered: number;
  hintsAccepted: number;
  elapsedMs: number;
}

/**
 * One playable mechanic. Primitives are pure gameplay: they emit events
 * through ctx.systems.analytics and resolve when the child succeeds.
 */
export interface InteractionModule {
  readonly type: InteractionType;
  /** Set up visuals and input. Resolves once the child completes the beat. */
  run(ctx: EngineContext, config: Interaction): Promise<InteractionResult>;
  /** Tear down listeners/tweens. Always called, even on early exit. */
  destroy(): void;
}

/* ------------------------------------------------------------------ */
/* Systems                                                             */
/* ------------------------------------------------------------------ */

export interface Systems {
  companion: CompanionSystemApi;
  reward: RewardSystemApi;
  progress: ProgressSystemApi;
  analytics: AnalyticsSystemApi;
  audio: AudioSystemApi;
}

export interface CompanionSystemApi {
  /** Mimo speaks: bubble + TTS + mood. Resolves when the line finishes. */
  say(line: string, opts?: { mood?: string; durationMs?: number }): Promise<void>;
  /** Mimo physically points at a prop and glows it. */
  hintAt(propId: string): Promise<void>;
  /**
   * Ask the policy whether Mimo should intervene after `attempts` failures.
   * Interactions call this instead of deciding for themselves.
   */
  shouldOfferHelp(attempts: number): boolean;
  moveTo(x: number, y: number): Promise<void>;
  setMood(mood: string): void;
}

export interface RewardSystemApi {
  /** Award stars with a flying-star animation into the counter. */
  award(stars: number, atX: number, atY: number): Promise<void>;
  total(): number;
  celebrate(x: number, y: number): void;
}

export interface ProgressSystemApi {
  markSceneComplete(sceneId: string): void;
  scenesCompleted(): number;
  totalScenes(): number;
  /** Persist to the relational store. Fire-and-forget; never blocks play. */
  save(): void;
}

/** Emitting is fire-and-forget and must never block or throw into gameplay. */
export interface AnalyticsSystemApi {
  emit(type: GameEventType, fields?: Partial<AnalyticsFields>): void;
  /** Flush any batched events immediately (scene transitions, story end). */
  flush(): Promise<void>;
  sessionId: string;
  childId: string;
}

export interface AnalyticsFields {
  scene_id: string;
  interaction_type: InteractionType | '';
  word: string;
  phoneme: string;
  correct: boolean | null;
  attempt_number: number;
  response_time_ms: number;
  hint_used: boolean;
  companion_intervention: string;
  metadata: Record<string, unknown>;
}

export interface AudioSystemApi {
  /** Synthesised via WebAudio - there are no sound files in this project. */
  play(cue: AudioCue): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
}

export type AudioCue =
  | 'tap' | 'correct' | 'wrong' | 'collect' | 'sparkle' | 'whoosh'
  | 'celebrate' | 'star' | 'hop' | 'reveal' | 'page';

/* ------------------------------------------------------------------ */

export const DEFAULT_POLICY: RuntimePolicy = {
  helpAfterAttempt: 2,
  interventionStyle: 'visual_hint',
  source: 'default',
  plan: null,
};
