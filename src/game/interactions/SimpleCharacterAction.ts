import Phaser from 'phaser';
import type {
  CharacterAction, Interaction, SimpleCharacterActionInteraction,
} from '../../shared/types';
import type { CharacterView, Mood } from '../art/contract';
import type {
  AudioCue, EngineContext, InteractionModule, InteractionResult,
} from '../engineContract';
import {
  Beat, Cleanup, DEPTH, normalizer, offerHelpIfPolicySays,
  promptBanner, ripple, saySafely, tapAnywhere, tweenNow, worldXY,
} from './base';

/** How long a child may sit still before Mimo checks in. */
const STALL_MS = 6500;

interface Step {
  /** Normalised movement applied per tap. */
  dx: number;
  dy: number;
  hop: boolean;
  cue: AudioCue;
  mood: Mood;
  /** Extra flourish drawn at the actor's feet. */
  flourish: 'none' | 'dust' | 'ring' | 'sparkle';
}

const STEPS: Record<CharacterAction, Step> = {
  climb: { dx: 0.004, dy: -0.075, hop: true, cue: 'hop', mood: 'excited', flourish: 'dust' },
  jump: { dx: 0.03, dy: -0.02, hop: true, cue: 'hop', mood: 'excited', flourish: 'dust' },
  dig: { dx: 0, dy: 0.012, hop: false, cue: 'tap', mood: 'thinking', flourish: 'dust' },
  push: { dx: 0.055, dy: 0, hop: false, cue: 'tap', mood: 'thinking', flourish: 'dust' },
  knock: { dx: 0, dy: 0, hop: false, cue: 'tap', mood: 'curious', flourish: 'ring' },
  swim: { dx: 0.06, dy: 0.004, hop: false, cue: 'whoosh', mood: 'happy', flourish: 'ring' },
  fly: { dx: 0.035, dy: -0.055, hop: false, cue: 'whoosh', mood: 'excited', flourish: 'sparkle' },
  dance: { dx: 0.018, dy: 0, hop: true, cue: 'tap', mood: 'happy', flourish: 'sparkle' },
};

/**
 * SIMPLE CHARACTER ACTION - "do it WITH them".
 *
 * "Jack climbed the beanstalk" becomes: tap, and he climbs a bit. Tap again,
 * a bit more. The effort count comes from the story, so any narrative verb is
 * playable without new game code.
 *
 * This primitive has no wrong answer by construction - every tap is progress.
 * The only thing it watches for is a child who has stopped, and even then it
 * asks the policy before Mimo says a word.
 */
export class SimpleCharacterAction implements InteractionModule {
  readonly type = 'simple_character_action' as const;

  private cleanup = new Cleanup();
  private beat: Beat | null = null;
  private progress = 0;
  private effort = 1;
  private busy = false;
  private lastTapAt = 0;
  private stallTimer: Phaser.Time.TimerEvent | null = null;
  private pips: Phaser.GameObjects.Graphics | null = null;
  private ring: Phaser.GameObjects.Graphics | null = null;
  private finish: ((r: InteractionResult) => void) | null = null;

  async run(ctx: EngineContext, config: Interaction): Promise<InteractionResult> {
    const cfg = config as SimpleCharacterActionInteraction;
    const beat = new Beat(ctx, this.type);
    this.beat = beat;
    this.effort = Math.max(1, Math.round(cfg.effort));

    beat.emit('interaction_started', {
      metadata: { action: cfg.action, actor: cfg.actor, effort: this.effort },
    });

    const actor: CharacterView = cfg.actor === 'mimo' ? ctx.mimo : ctx.fox;
    const step = STEPS[cfg.action] ?? STEPS.jump;

    promptBanner(ctx, this.cleanup, cfg.prompt);
    this.drawPips(ctx);
    this.drawInviteRing(ctx, actor);

    actor.setMood(step.mood);
    this.lastTapAt = Date.now();
    this.watchForStall(ctx, beat, cfg);

    return new Promise<InteractionResult>((resolve) => {
      this.finish = resolve;
      // The whole screen is the button. A five year old should not have to aim.
      tapAnywhere(ctx, this.cleanup, () => {
        void this.onTap(ctx, beat, actor, step, cfg);
      });
    });
  }

  /* ----------------------------- the effort ---------------------------- */

  private async onTap(
    ctx: EngineContext,
    beat: Beat,
    actor: CharacterView,
    step: Step,
    cfg: SimpleCharacterActionInteraction,
  ): Promise<void> {
    if (this.busy || beat.completed) return;
    this.busy = true;
    this.lastTapAt = Date.now();

    this.progress += 1;
    beat.attempts += 1;

    // Every tap is progress, so every tap is a correct choice. There is no
    // wrong_choice event in this primitive because there is no wrong move.
    beat.emit('object_tapped', {
      correct: true,
      metadata: {
        action: cfg.action, actor: cfg.actor,
        progress: this.progress, effort: this.effort,
      },
    });

    ctx.systems.audio.play(step.cue);
    this.updatePips(ctx);
    await this.advance(ctx, actor, step);

    if (this.progress >= this.effort) {
      beat.completed = true;
      beat.emit('correct_choice', {
        correct: true,
        metadata: { action: cfg.action, actor: cfg.actor, taps: this.progress },
      });
      await this.finale(ctx, actor, cfg.action);
      beat.emit('interaction_completed', {
        correct: true,
        metadata: { action: cfg.action, actor: cfg.actor, taps: this.progress },
      });
      this.finish?.(beat.result());
      this.finish = null;
      return;
    }

    this.busy = false;
  }

  /** One tap of movement, in the actor's own rig. */
  private async advance(ctx: EngineContext, actor: CharacterView, step: Step): Promise<void> {
    const toNorm = normalizer(ctx);
    const at = worldXY(actor.root);
    const here = toNorm(at.x, at.y);

    this.flourish(ctx, at.x, at.y, step.flourish);

    if (step.dx === 0 && step.dy === 0) {
      // In-place effort: a lean and a bounce rather than a move.
      await new Promise<void>((resolve) => {
        if (this.cleanup.destroyed) { resolve(); return; }
        this.cleanup.track(ctx.scene.tweens.add({
          targets: actor.root,
          scaleY: (actor.root.scaleY || 1) * 0.88,
          duration: 130, yoyo: true, ease: 'Sine.easeOut',
          onComplete: () => resolve(),
        }));
      });
      return;
    }

    const target = {
      x: Phaser.Math.Clamp(here.x + step.dx, 0.06, 0.94),
      y: Phaser.Math.Clamp(here.y + step.dy, 0.08, 0.95),
    };
    if (step.dx !== 0) actor.setFacing(step.dx > 0 ? 1 : -1);
    await actor.moveTo(target.x, target.y, { hop: step.hop, durationMs: 320 });
    this.moveRing(ctx, actor);
  }

  private flourish(ctx: EngineContext, x: number, y: number, kind: Step['flourish']): void {
    const { palette } = ctx.artCtx;
    if (kind === 'none') return;
    if (kind === 'ring') {
      ripple(ctx, this.cleanup, x, y, { radius: 120, rings: 2, color: palette.accent });
      return;
    }
    if (kind === 'sparkle') {
      const n = normalizer(ctx)(x, y);
      ctx.art.burst(ctx.artCtx, n.x, n.y, { count: 10 });
      return;
    }
    // Dust: a few little puffs kicked out sideways.
    for (let i = 0; i < 6; i++) {
      const puff = this.cleanup.own(ctx.scene.add.circle(
        x, y + 12, 4 + Math.random() * 5, palette.groundShadow, 0.7,
      ));
      puff.setDepth(DEPTH.fx - 60);
      tweenNow(ctx.scene, this.cleanup, {
        targets: puff,
        x: x + (Math.random() - 0.5) * 130,
        y: y + 14 - Math.random() * 40,
        alpha: 0,
        scale: 1.8,
        duration: 500 + Math.random() * 260,
        ease: 'Cubic.easeOut',
        onComplete: () => puff.destroy(),
      });
    }
  }

  private async finale(ctx: EngineContext, actor: CharacterView, action: CharacterAction): Promise<void> {
    ctx.systems.audio.play('celebrate');
    const at = worldXY(actor.root);
    const n = normalizer(ctx)(at.x, at.y);
    ctx.art.burst(ctx.artCtx, n.x, n.y, { count: 26 });
    this.ring?.destroy();
    this.ring = null;
    if (action === 'dance') {
      tweenNow(ctx.scene, this.cleanup, {
        targets: actor.root, rotation: Math.PI * 2, duration: 700, ease: 'Back.easeOut',
        onComplete: () => actor.root.setRotation(0),
      });
    }
    await actor.celebrate();
  }

  /* ------------------------------ guidance ----------------------------- */

  /**
   * Not a failure check - a stalled-child check. Even here the decision to
   * speak belongs to the policy, never to this file.
   */
  private watchForStall(
    ctx: EngineContext, beat: Beat, cfg: SimpleCharacterActionInteraction,
  ): void {
    let stalls = 0;
    this.stallTimer = this.cleanup.time(ctx.scene.time.addEvent({
      delay: 1000,
      loop: true,
      callback: () => {
        if (beat.completed || this.busy) return;
        if (Date.now() - this.lastTapAt < STALL_MS) return;
        this.lastTapAt = Date.now();
        stalls += 1;
        // A stall is the closest honest equivalent of "stuck" here, so it is
        // what we hand the policy - without pretending the child chose wrongly.
        void (async () => {
          const offered = await offerHelpIfPolicySays(ctx, beat, null, stalls);
          if (!offered) {
            await saySafely(ctx, `Keep going! Tap to ${cfg.action}!`, 'happy');
          }
          this.pulseRing(ctx);
        })();
      },
    }));
  }

  /* ------------------------------ chrome ------------------------------- */

  private drawPips(ctx: EngineContext): void {
    const { width, height } = ctx.artCtx;
    this.pips = this.cleanup.own(ctx.scene.add.graphics());
    this.pips.setDepth(DEPTH.ui);
    this.pips.setPosition(width / 2, height * 0.17);
    this.renderPips(ctx);
  }

  private renderPips(ctx: EngineContext): void {
    if (!this.pips) return;
    const { width, palette } = ctx.artCtx;
    const size = Math.max(9, Math.round(width * 0.008));
    const gap = size * 3.2;
    const total = gap * (this.effort - 1);
    this.pips.clear();
    for (let i = 0; i < this.effort; i++) {
      const x = -total / 2 + gap * i;
      const done = i < this.progress;
      this.pips.fillStyle(done ? palette.accent : palette.scrim, done ? 1 : 0.5);
      this.pips.fillCircle(x, 0, size);
      this.pips.lineStyle(2, palette.accent, done ? 1 : 0.45);
      this.pips.strokeCircle(x, 0, size);
    }
  }

  private updatePips(ctx: EngineContext): void {
    this.renderPips(ctx);
    if (this.pips) {
      tweenNow(ctx.scene, this.cleanup, {
        targets: this.pips, scale: 1.18, duration: 130, yoyo: true, ease: 'Back.easeOut',
      });
    }
  }

  /** A pulsing ring on the actor: "tap here, keep going". */
  private drawInviteRing(ctx: EngineContext, actor: CharacterView): void {
    const { palette } = ctx.artCtx;
    const at = worldXY(actor.root);
    const ring = this.cleanup.own(ctx.scene.add.graphics());
    ring.setDepth(DEPTH.fx - 70);
    ring.lineStyle(5, palette.accent, 0.55);
    ring.strokeCircle(0, 0, 66);
    ring.setPosition(at.x, at.y);
    this.ring = ring;
    tweenNow(ctx.scene, this.cleanup, {
      targets: ring, scale: 1.25, alpha: 0.3, duration: 900,
      yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
  }

  private moveRing(ctx: EngineContext, actor: CharacterView): void {
    if (!this.ring) return;
    const at = worldXY(actor.root);
    tweenNow(ctx.scene, this.cleanup, {
      targets: this.ring, x: at.x, y: at.y, duration: 220, ease: 'Sine.easeOut',
    });
  }

  private pulseRing(ctx: EngineContext): void {
    if (!this.ring) return;
    tweenNow(ctx.scene, this.cleanup, {
      targets: this.ring, scale: 1.9, duration: 300, yoyo: true, repeat: 2, ease: 'Sine.easeOut',
    });
    ctx.systems.audio.play('sparkle');
  }

  destroy(): void {
    this.stallTimer?.remove(false);
    this.stallTimer = null;
    this.cleanup.run();
    this.pips = null;
    this.ring = null;
    if (this.finish && this.beat) {
      this.finish(this.beat.result());
      this.finish = null;
    }
  }
}
