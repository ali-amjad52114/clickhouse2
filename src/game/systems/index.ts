import type Phaser from 'phaser';
import type { GameStory } from '../../shared/types';
import type { ArtContext, CharacterView, PropView, SceneArtist } from '../art/contract';
import type { RuntimePolicy, Systems } from '../engineContract';

import { AdaptationSystem } from './AdaptationSystem';
import { AnalyticsSystem } from './AnalyticsSystem';
import { AudioSystem } from './AudioSystem';
import { CompanionSystem } from './CompanionSystem';
import { ProgressSystem } from './ProgressSystem';
import { RewardSystem } from './RewardSystem';

export { AdaptationSystem } from './AdaptationSystem';
export { AnalyticsSystem } from './AnalyticsSystem';
export { AudioSystem } from './AudioSystem';
export { CompanionSystem } from './CompanionSystem';
export { ProgressSystem } from './ProgressSystem';
export { RewardSystem } from './RewardSystem';
export type { AdaptationStatus } from './AdaptationSystem';
export type { AnalyticsStats } from './AnalyticsSystem';
export type { AudioState } from './AudioSystem';
export type { ProgressStatus } from './ProgressSystem';

/**
 * Systems are created ONCE per play session (so the star total, the analytics
 * session id and the progress record survive scene changes) and re-bound to
 * each StoryScene as it boots via `attachScene`.
 */

export interface CreateSystemsOptions {
  childId: string;
  story: GameStory;
  /** Continue an existing analytics session across a reload. */
  sessionId?: string;
  /** Stars already earned, e.g. from saved progress. */
  initialStars?: number;
  /** Scene ids already completed, e.g. from saved progress. */
  completedScenes?: string[];
  muted?: boolean;
  /** Mimo speaks aloud when a speech service is present. Default true. */
  voice?: boolean;
  /** Fetch the ClickHouse-derived policy on creation. Default true. */
  fetchPolicy?: boolean;
  endpoints?: {
    events?: string;
    progress?: string;
    policy?: string;
  };
}

/** What a StoryScene hands the systems when it starts. */
export interface SceneBinding {
  scene: Phaser.Scene;
  art: SceneArtist;
  artCtx: ArtContext;
  mimo: CharacterView;
  props: Map<string, PropView>;
  sceneId: string;
  /** Pixels above Mimo's origin for the speech bubble tail. */
  headOffsetY?: number;
}

export interface GameSystems extends Systems {
  companion: CompanionSystem;
  reward: RewardSystem;
  progress: ProgressSystem;
  analytics: AnalyticsSystem;
  audio: AudioSystem;
  /** Not part of the Systems contract - the scene reads the policy from here. */
  adaptation: AdaptationSystem;
  /**
   * The live policy object for EngineContext.policy. It is mutated in place on
   * refresh, so a captured reference stays current.
   */
  policy(): RuntimePolicy;
  attachScene(binding: SceneBinding): void;
  detachScene(): void;
  destroy(): Promise<void>;
}

export function createSystems(opts: CreateSystemsOptions): GameSystems {
  const { childId, story } = opts;

  const audio = new AudioSystem({ muted: opts.muted });

  const analytics = new AnalyticsSystem({
    childId,
    storyId: story.id,
    sessionId: opts.sessionId,
    endpoint: opts.endpoints?.events,
  });

  const adaptation = new AdaptationSystem({
    childId,
    endpoint: opts.endpoints?.policy,
  });

  const reward = new RewardSystem({ audio, initialStars: opts.initialStars });

  const progress = new ProgressSystem({
    childId,
    storyId: story.id,
    totalScenes: story.scenes.length,
    getStars: () => reward.total(),
    endpoint: opts.endpoints?.progress,
    completed: opts.completedScenes,
  });

  const companion = new CompanionSystem({
    getPolicy: () => adaptation.policy(),
    audio,
    analytics,
    voice: opts.voice,
  });

  if (opts.fetchPolicy !== false) void adaptation.refresh();

  return {
    companion,
    reward,
    progress,
    analytics,
    audio,
    adaptation,

    policy: () => adaptation.policy(),

    attachScene(binding: SceneBinding) {
      analytics.setScene(binding.sceneId);
      progress.setCurrentScene(binding.sceneId);
      reward.attach({ scene: binding.scene, artCtx: binding.artCtx, art: binding.art });
      companion.attach({
        scene: binding.scene,
        artCtx: binding.artCtx,
        mimo: binding.mimo,
        props: binding.props,
        headOffsetY: binding.headOffsetY,
      });
    },

    detachScene() {
      companion.detach();
      reward.detach();
    },

    async destroy() {
      companion.detach();
      reward.detach();
      progress.destroy();
      await analytics.destroy();
      audio.destroy();
    },
  };
}
