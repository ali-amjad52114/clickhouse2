import Phaser from 'phaser';
import type { GameEventType, InteractionType } from '../../shared/types';
import type { AnalyticsFields, EngineContext, InteractionResult } from '../engineContract';
import type { PropView } from '../art/contract';
import { MIN_TOUCH_RADIUS } from '../art/contract';

/**
 * Shared kernel for the interaction primitives.
 *
 * Every primitive needs the same four things: honest timing, honest event
 * emission, the policy-driven help handshake, and total teardown. Duplicating
 * that seven times would guarantee seven slightly different behaviours, so it
 * lives here. Nothing in this file knows about a specific mechanic.
 */

/** Render order for interaction-owned overlays. Props live below 500. */
export const DEPTH = { fx: 700, ui: 900, card: 940, overlay: 980 };

/** System font stack - there are no font files in this project. */
export const STORY_FONT = '"Trebuchet MS", "Segoe UI", Verdana, sans-serif';

/** Hex number -> css string, for Phaser Text styles. */
export function css(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
}

/* ------------------------------------------------------------------ */
/* Teardown                                                            */
/* ------------------------------------------------------------------ */

/** Everything an interaction creates gets registered here and dies together. */
export class Cleanup {
  private objects: Phaser.GameObjects.GameObject[] = [];
  private tweens: Phaser.Tweens.Tween[] = [];
  private timers: Phaser.Time.TimerEvent[] = [];
  private undo: Array<() => void> = [];
  private done = false;

  own<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    if (this.done) { obj.destroy(); return obj; }
    this.objects.push(obj);
    return obj;
  }

  track(tween: Phaser.Tweens.Tween | null | undefined): void {
    if (tween) this.tweens.push(tween);
  }

  time(timer: Phaser.Time.TimerEvent): Phaser.Time.TimerEvent {
    this.timers.push(timer);
    return timer;
  }

  onDestroy(fn: () => void): void {
    if (this.done) { fn(); return; }
    this.undo.push(fn);
  }

  get destroyed(): boolean { return this.done; }

  run(): void {
    if (this.done) return;
    this.done = true;
    for (const fn of this.undo) { try { fn(); } catch { /* teardown must not throw */ } }
    for (const t of this.tweens) { try { t.stop(); t.remove(); } catch { /* already gone */ } }
    for (const t of this.timers) { try { t.remove(false); } catch { /* already gone */ } }
    for (const o of this.objects) { try { o.destroy(); } catch { /* already gone */ } }
    this.undo = []; this.tweens = []; this.timers = []; this.objects = [];
  }
}

/* ------------------------------------------------------------------ */
/* Timing + analytics                                                  */
/* ------------------------------------------------------------------ */

/**
 * One playable beat. Owns the clock the analytics rows are measured against,
 * so response_time_ms is always real elapsed time from the moment the child
 * could first act - never a guess.
 */
export class Beat {
  attempts = 0;
  wrongChoices = 0;
  hintsOffered = 0;
  hintsAccepted = 0;
  /** True once Mimo has actually offered help in this beat. */
  hintUsed = false;
  /** Prop the newest un-answered hint pointed at, so we can score it. */
  pendingHintTarget: string | null = null;
  completed = false;

  private ctx: EngineContext;
  private type: InteractionType;
  private startedAt: number;
  private markedAt: number;

  constructor(ctx: EngineContext, type: InteractionType) {
    this.ctx = ctx;
    this.type = type;
    this.startedAt = now();
    this.markedAt = this.startedAt;
  }

  /** Milliseconds since the interaction actually started. */
  sinceStart(): number { return Math.round(now() - this.startedAt); }

  /** Milliseconds since the last mark() - used for per-word reading latency. */
  sinceMark(): number { return Math.round(now() - this.markedAt); }

  mark(): void { this.markedAt = now(); }

  emit(type: GameEventType, fields: Partial<AnalyticsFields> = {}): void {
    this.ctx.systems.analytics.emit(type, {
      scene_id: this.ctx.storyScene.id,
      interaction_type: this.type,
      attempt_number: this.attempts,
      response_time_ms: this.sinceStart(),
      hint_used: this.hintUsed,
      ...fields,
    });
  }

  result(): InteractionResult {
    return {
      completed: this.completed,
      attempts: this.attempts,
      wrongChoices: this.wrongChoices,
      hintsOffered: this.hintsOffered,
      hintsAccepted: this.hintsAccepted,
      elapsedMs: this.sinceStart(),
    };
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/* ------------------------------------------------------------------ */
/* The help handshake                                                  */
/* ------------------------------------------------------------------ */

/**
 * The ONLY place a primitive is allowed to decide about hinting: it asks the
 * companion system, which asks the ClickHouse-derived policy. If the answer is
 * no, nothing happens and the child simply keeps playing.
 *
 * `propId` may be null for beats with no prop to point at (reading, character
 * actions); Mimo then speaks the hint instead of gesturing.
 *
 * `failures` defaults to the beat's wrong choices. Primitives with no wrong
 * answer (simple_character_action) pass their own stall count instead, so the
 * reported wrongChoices stays truthful.
 */
export async function offerHelpIfPolicySays(
  ctx: EngineContext,
  beat: Beat,
  propId: string | null,
  failures: number = beat.wrongChoices,
): Promise<boolean> {
  if (!ctx.systems.companion.shouldOfferHelp(failures)) return false;

  beat.hintsOffered += 1;
  beat.hintUsed = true;
  beat.pendingHintTarget = propId;
  beat.emit('hint_offered', {
    companion_intervention: ctx.policy.interventionStyle,
    metadata: {
      prop_id: propId,
      after_failures: failures,
      policy_source: ctx.policy.source,
      help_after_attempt: ctx.policy.helpAfterAttempt,
    },
  });

  const line = ctx.storyScene.companion.hint;
  if (line) await ctx.systems.companion.say(line, { mood: 'thinking' });
  if (propId && ctx.props.has(propId)) await ctx.systems.companion.hintAt(propId);
  return true;
}

/**
 * Was the hint followed? Called with whatever the child touched next. Produces
 * the hint_accepted / hint_ignored evidence the profile is built from.
 */
export function scoreHint(beat: Beat, chosenId: string): void {
  if (beat.pendingHintTarget === null) return;
  const followed = beat.pendingHintTarget === chosenId;
  const target = beat.pendingHintTarget;
  beat.pendingHintTarget = null;
  if (followed) beat.hintsAccepted += 1;
  beat.emit(followed ? 'hint_accepted' : 'hint_ignored', {
    metadata: { hinted: target, chose: chosenId },
  });
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const worldMatrix = new Phaser.GameObjects.Components.TransformMatrix();
const parentMatrix = new Phaser.GameObjects.Components.TransformMatrix();

/** World-space position of any transformable object, parallax layers included. */
export function worldXY(obj: Phaser.GameObjects.Container): { x: number; y: number } {
  obj.getWorldTransformMatrix(worldMatrix, parentMatrix);
  return { x: worldMatrix.tx, y: worldMatrix.ty };
}

/**
 * Inverse of ctx.toPx, derived from ctx.toPx itself so it stays correct
 * whatever mapping the engine uses.
 */
export function normalizer(ctx: EngineContext): (px: number, py: number) => { x: number; y: number } {
  const origin = ctx.toPx(0, 0);
  const unit = ctx.toPx(1, 1);
  const spanX = unit.x - origin.x || 1;
  const spanY = unit.y - origin.y || 1;
  return (px, py) => ({ x: (px - origin.x) / spanX, y: (py - origin.y) / spanY });
}

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

/** Finger-sized hit radius for a prop. Never smaller than MIN_TOUCH_RADIUS. */
export function hitRadiusFor(view: PropView): number {
  return Math.max(MIN_TOUCH_RADIUS, view.hitRadius || 0);
}

/**
 * Make a prop tappable with a generous circular hit area. Returns a disposer
 * that is also registered with the cleanup so teardown can never miss it.
 */
export function makeTappable(
  view: PropView,
  cleanup: Cleanup,
  onTap: (id: string, pointer: Phaser.Input.Pointer) => void,
): void {
  const radius = hitRadiusFor(view);
  const root = view.root;
  root.setInteractive(new Phaser.Geom.Circle(0, 0, radius), Phaser.Geom.Circle.Contains);
  const handler = (pointer: Phaser.Input.Pointer) => onTap(view.id, pointer);
  root.on('pointerdown', handler);
  cleanup.onDestroy(() => {
    root.off('pointerdown', handler);
    if (root.input) root.removeInteractive();
  });
}

/** A full-screen tap catcher, used by beats where any tap is a valid action. */
export function tapAnywhere(
  ctx: EngineContext,
  cleanup: Cleanup,
  onTap: () => void,
): Phaser.GameObjects.Zone {
  const { width, height } = ctx.artCtx;
  const zone = cleanup.own(ctx.scene.add.zone(width / 2, height / 2, width, height));
  zone.setDepth(DEPTH.fx - 1).setInteractive();
  zone.on('pointerdown', onTap);
  return zone;
}

/* ------------------------------------------------------------------ */
/* Async helpers                                                       */
/* ------------------------------------------------------------------ */

export function wait(ctx: EngineContext, ms: number, cleanup: Cleanup): Promise<void> {
  return new Promise((resolve) => {
    if (cleanup.destroyed) { resolve(); return; }
    const timer = cleanup.time(ctx.scene.time.delayedCall(ms, resolve));
    // Teardown cancels the timer, so resolve by hand or the caller hangs.
    cleanup.onDestroy(() => { timer.remove(false); resolve(); });
  });
}

/** Fire-and-forget tween that is still torn down properly. */
export function tweenNow(
  scene: Phaser.Scene,
  cleanup: Cleanup,
  config: Phaser.Types.Tweens.TweenBuilderConfig | Record<string, unknown>,
): void {
  if (cleanup.destroyed) return;
  cleanup.track(scene.tweens.add(config as Phaser.Types.Tweens.TweenBuilderConfig));
}

/**
 * Speaking must never wedge a beat: if the companion system is slow or a TTS
 * voice never fires, gameplay continues anyway.
 */
export async function saySafely(
  ctx: EngineContext,
  line: string | undefined,
  mood: string,
): Promise<void> {
  if (!line) return;
  try {
    await ctx.systems.companion.say(line, { mood });
  } catch {
    /* a silent companion is survivable; a stuck game is not */
  }
}

/* ------------------------------------------------------------------ */
/* Shared visuals                                                      */
/* ------------------------------------------------------------------ */

/** The interaction's own instruction, as a soft storybook pill at the top. */
export function promptBanner(ctx: EngineContext, cleanup: Cleanup, text: string): Phaser.GameObjects.Container {
  const { width, height, palette } = ctx.artCtx;
  const container = cleanup.own(ctx.scene.add.container(width / 2, height * 0.085));
  container.setDepth(DEPTH.ui);

  const label = ctx.scene.add.text(0, 0, text, {
    fontFamily: STORY_FONT,
    fontSize: `${Math.round(Math.min(width, height * 1.6) * 0.026)}px`,
    color: css(palette.ink),
    fontStyle: 'bold',
    align: 'center',
    wordWrap: { width: width * 0.7 },
  }).setOrigin(0.5);

  const padX = 34;
  const padY = 18;
  const w = label.width + padX * 2;
  const h = label.height + padY * 2;

  const plate = ctx.scene.add.graphics();
  plate.fillStyle(palette.scrim, 0.86);
  plate.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
  plate.lineStyle(3, palette.accent, 0.55);
  plate.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2);

  container.add([plate, label]);
  container.setAlpha(0).setScale(0.9);
  tweenNow(ctx.scene, cleanup, {
    targets: container, alpha: 1, scale: 1, duration: 340, ease: 'Back.easeOut',
  });
  return container;
}

/** Expanding ring - used for splashes, drop zones and taps. */
export function ripple(
  ctx: EngineContext,
  cleanup: Cleanup,
  x: number,
  y: number,
  opts: { color?: number; rings?: number; radius?: number; depth?: number } = {},
): void {
  const color = opts.color ?? ctx.artCtx.palette.waterHighlight;
  const rings = opts.rings ?? 3;
  const maxR = opts.radius ?? 90;
  for (let i = 0; i < rings; i++) {
    const g = cleanup.own(ctx.scene.add.graphics());
    g.setDepth(opts.depth ?? DEPTH.fx);
    g.lineStyle(4, color, 0.9);
    g.strokeEllipse(0, 0, 40, 18);
    g.setPosition(x, y);
    tweenNow(ctx.scene, cleanup, {
      targets: g,
      scaleX: maxR / 20,
      scaleY: maxR / 20,
      alpha: 0,
      delay: i * 150,
      duration: 900,
      ease: 'Cubic.easeOut',
      onComplete: () => g.destroy(),
    });
  }
}

/** A soft pulsing halo that can follow a moving object. */
export function halo(
  ctx: EngineContext,
  cleanup: Cleanup,
  radius: number,
  color: number,
): Phaser.GameObjects.Graphics {
  const g = cleanup.own(ctx.scene.add.graphics());
  g.setDepth(DEPTH.fx - 10);
  for (let i = 4; i >= 1; i--) {
    g.fillStyle(color, 0.12);
    g.fillCircle(0, 0, radius * (i / 4));
  }
  return g;
}
