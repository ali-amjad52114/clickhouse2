import type Phaser from 'phaser';
import type { Biome, PropKind, StoryProp, TimeOfDay } from '../../shared/types';

/**
 * ART CONTRACT
 *
 * There are no image assets in this project and no way to fetch any, so every
 * pixel is drawn procedurally. This file is the seam between the artist (which
 * knows how to draw) and the engine (which knows what to draw and when).
 *
 * Anything implementing SceneArtist must produce flat-vector children's-book
 * illustration: bold silhouettes, warm saturated palettes, soft rounded forms,
 * no gradients harsher than a two-stop sky, no photorealism, no text baked in.
 */

/** Resolved colours for one biome at one time of day. */
export interface Palette {
  skyTop: number;
  skyBottom: number;
  sun: number;
  hillFar: number;
  hillMid: number;
  hillNear: number;
  ground: number;
  groundShadow: number;
  water: number;
  waterHighlight: number;
  foliageDark: number;
  foliageMid: number;
  foliageLight: number;
  trunk: number;
  accent: number;
  /** Colour for narration text drawn over this biome. */
  ink: number;
  /** Panel/scrim colour behind narration so text always stays legible. */
  scrim: number;
  /** True when this palette is dark enough to need light text. */
  dark: boolean;
}

export interface ArtContext {
  scene: Phaser.Scene;
  width: number;
  height: number;
  palette: Palette;
}

/**
 * A drawn prop handed back to the engine. The engine attaches input,
 * tweens and analytics to it; the artist never knows about gameplay.
 */
export interface PropView {
  id: string;
  kind: PropKind;
  /** Root container - move/scale/tint this. */
  root: Phaser.GameObjects.Container;
  /** Parallax layer this prop was placed on. */
  layer: 0 | 1 | 2;
  /** Generous hit radius in px, sized for small fingers (never below 44px). */
  hitRadius: number;
  /** Starts the prop's idle motion (sway, bob, flutter). Safe to call twice. */
  idle(): void;
  /** A celebratory reaction: pop, sparkle, glow. Resolves when finished. */
  celebrate(): Promise<void>;
  /** A playful "not this one" wobble. Never reads as punishment. */
  wobble(): Promise<void>;
  /** Pulses a highlight ring so a hint can point at this prop. */
  highlight(on: boolean): void;
}

/** Character rigs are drawn the same way but animate as creatures. */
export interface CharacterView {
  root: Phaser.GameObjects.Container;
  /** Walk/hop to a normalised x,y. Resolves on arrival. */
  moveTo(x: number, y: number, opts?: { hop?: boolean; durationMs?: number }): Promise<void>;
  /** Emotional states drive ears, eyes, mouth, posture. */
  setMood(mood: Mood): void;
  /** Turn to face a point and raise a paw toward it. */
  pointAt(x: number, y: number): Promise<void>;
  /** Big celebratory animation. */
  celebrate(): Promise<void>;
  /** Face left or right. */
  setFacing(dir: -1 | 1): void;
  setVisible(v: boolean): void;
}

export type Mood =
  | 'idle' | 'happy' | 'excited' | 'curious' | 'surprised'
  | 'worried' | 'scared' | 'thinking' | 'proud' | 'sad';

/**
 * The artist. One instance per running StoryScene.
 */
export interface SceneArtist {
  /** Resolve the palette for a biome + time of day. */
  paletteFor(biome: Biome, time: TimeOfDay): Palette;

  /**
   * Paint sky, hills, ground, water and ambient particles for a biome.
   * Returns the parallax layers the engine parents props to.
   */
  paintBackdrop(ctx: ArtContext, biome: Biome, time: TimeOfDay): {
    layers: [Phaser.GameObjects.Container, Phaser.GameObjects.Container, Phaser.GameObjects.Container];
    /** Call each frame with a delta to drive ambient motion. */
    update(deltaMs: number): void;
  };

  /** Draw one story prop at its normalised position. */
  drawProp(ctx: ArtContext, prop: StoryProp): PropView;

  /** The protagonist. A warm, rounded, storybook fox. */
  createFox(ctx: ArtContext): CharacterView;

  /**
   * MIMO - our original companion. Small, round, big eyes, two soft antenna
   * ears with glowing tips, a stubby tail, no resemblance to any existing
   * character. Drawn from primitives only.
   */
  createMimo(ctx: ArtContext): CharacterView;

  /** Confetti / star burst at a normalised point. */
  burst(ctx: ArtContext, x: number, y: number, opts?: { count?: number; color?: number }): void;
}

/** Minimum touch target for ages 5-9, in CSS px. Never go below this. */
export const MIN_TOUCH_RADIUS = 44;

/** The design canvas. Everything positions in normalised 0..1 and scales. */
export const DESIGN_WIDTH = 1280;
export const DESIGN_HEIGHT = 720;
