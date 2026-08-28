import Phaser from 'phaser';
import type { ChooseObjectInteraction, Interaction } from '../../shared/types';
import type { EngineContext, InteractionModule, InteractionResult } from '../engineContract';
import type { PropView } from '../art/contract';
import {
  Beat, Cleanup, makeTappable, normalizer, offerHelpIfPolicySays,
  promptBanner, saySafely, scoreHint, worldXY,
} from './base';

interface Flyer {
  view: PropView;
  correct: boolean;
  label: string;
  /** Drives the object's own bezier loop. */
  path: Phaser.Curves.CubicBezier;
  driver: { t: number };
  tween: Phaser.Tweens.Tween | null;
  home: { x: number; y: number };
}

/**
 * CHOOSE OBJECT - "which one is it?".
 *
 * Scene 3: four butterflies drift along their own bezier loops and the child
 * picks the blue one. The right one sparkles and leaves toward the exit; the
 * others do a comedy barrel roll. Picking a wrong one costs nothing but a
 * giggle - the butterflies keep flying and the child tries again.
 */
export class ChooseObject implements InteractionModule {
  readonly type = 'choose_object' as const;

  private cleanup = new Cleanup();
  private beat: Beat | null = null;
  private flyers: Flyer[] = [];
  private busy = false;
  private finish: ((r: InteractionResult) => void) | null = null;

  async run(ctx: EngineContext, config: Interaction): Promise<InteractionResult> {
    const cfg = config as ChooseObjectInteraction;
    const beat = new Beat(ctx, this.type);
    this.beat = beat;

    beat.emit('interaction_started', {
      metadata: { choices: cfg.choices.map((c) => c.id) },
    });

    for (const choice of cfg.choices) {
      const view = ctx.props.get(choice.id);
      if (!view) {
        console.warn(`[choose_object] choice prop "${choice.id}" is not in this scene`);
        continue;
      }
      this.flyers.push({
        view,
        correct: choice.correct,
        label: choice.label,
        path: this.buildPath(ctx, view),
        driver: { t: 0 },
        tween: null,
        home: { x: view.root.x, y: view.root.y },
      });
    }

    if (this.flyers.length < 2 || !this.flyers.some((f) => f.correct)) {
      beat.emit('interaction_completed', {
        correct: null,
        metadata: { reason: 'not_enough_valid_choices', found: this.flyers.length },
      });
      return beat.result();
    }

    promptBanner(ctx, this.cleanup, cfg.prompt);

    for (const flyer of this.flyers) {
      this.startFlight(ctx, flyer);
      makeTappable(flyer.view, this.cleanup, () => {
        void this.onPick(ctx, beat, flyer);
      });
    }

    return new Promise<InteractionResult>((resolve) => { this.finish = resolve; });
  }

  /**
   * A loop in the prop's own parent space, so parallax offsets and layer
   * scaling stay correct without the interaction knowing about them.
   */
  private buildPath(ctx: EngineContext, view: PropView): Phaser.Curves.CubicBezier {
    const { width, height } = ctx.artCtx;
    const spread = width * (0.07 + Math.random() * 0.06);
    const lift = height * (0.06 + Math.random() * 0.07);
    const dir = Math.random() < 0.5 ? -1 : 1;
    const x = view.root.x;
    const y = view.root.y;
    return new Phaser.Curves.CubicBezier(
      new Phaser.Math.Vector2(x, y),
      new Phaser.Math.Vector2(x + spread * dir, y - lift),
      new Phaser.Math.Vector2(x - spread * dir * 1.3, y + lift * 0.6),
      new Phaser.Math.Vector2(x, y),
    );
  }

  private startFlight(ctx: EngineContext, flyer: Flyer): void {
    // The artist's idle tween and our flight path would fight over x/y, so we
    // take ownership of the position for the duration of the beat.
    flyer.view.idle();
    ctx.scene.tweens.killTweensOf(flyer.view.root);

    const point = new Phaser.Math.Vector2();
    flyer.driver.t = Math.random();
    flyer.tween = ctx.scene.tweens.add({
      targets: flyer.driver,
      t: flyer.driver.t + 1,
      duration: 5200 + Math.random() * 2600,
      repeat: -1,
      ease: 'Sine.easeInOut',
      onUpdate: () => {
        const t = flyer.driver.t % 1;
        flyer.path.getPoint(t, point);
        flyer.view.root.setPosition(point.x, point.y);
        // Flutter: a shallow wing-beat wobble on top of the path.
        flyer.view.root.setRotation(Math.sin(flyer.driver.t * Math.PI * 8) * 0.12);
      },
    });
    this.cleanup.track(flyer.tween);
    this.cleanup.onDestroy(() => {
      flyer.view.root.setRotation(0);
    });
  }

  private async onPick(ctx: EngineContext, beat: Beat, flyer: Flyer): Promise<void> {
    if (this.busy || beat.completed) return;
    this.busy = true;
    beat.attempts += 1;

    beat.emit('object_tapped', {
      correct: flyer.correct,
      metadata: { prop_id: flyer.view.id, label: flyer.label },
    });
    scoreHint(beat, flyer.view.id);

    if (flyer.correct) {
      beat.completed = true;
      beat.emit('correct_choice', {
        correct: true,
        metadata: { prop_id: flyer.view.id, label: flyer.label },
      });
      ctx.systems.audio.play('correct');
      ctx.mimo.setMood('excited');
      await this.exitStageRight(ctx, flyer);
      beat.emit('interaction_completed', {
        correct: true,
        metadata: { prop_id: flyer.view.id, wrong_choices: beat.wrongChoices },
      });
      this.finish?.(beat.result());
      this.finish = null;
      return;
    }

    beat.wrongChoices += 1;
    beat.emit('wrong_choice', {
      correct: false,
      metadata: { prop_id: flyer.view.id, label: flyer.label },
    });
    ctx.systems.audio.play('tap');
    ctx.mimo.setMood('curious');
    await this.funnyLoop(ctx, flyer, 1);
    await saySafely(ctx, ctx.storyScene.companion.retry, 'curious');

    const correct = this.flyers.find((f) => f.correct);
    await offerHelpIfPolicySays(ctx, beat, correct ? correct.view.id : null);
    this.busy = false;
  }

  /** The barrel roll. Pure slapstick - it reads as "whoops!", never as "no". */
  private async funnyLoop(ctx: EngineContext, flyer: Flyer, spins: number): Promise<void> {
    const root = flyer.view.root;
    flyer.tween?.pause();
    const startScale = root.scale || 1;
    await new Promise<void>((resolve) => {
      if (this.cleanup.destroyed) { resolve(); return; }
      this.cleanup.track(ctx.scene.tweens.add({
        targets: root,
        rotation: root.rotation + Math.PI * 2 * spins,
        scale: { value: startScale * 1.2, yoyo: true, duration: 320 },
        y: { value: root.y - 26, yoyo: true, duration: 320, ease: 'Sine.easeOut' },
        duration: 640,
        ease: 'Cubic.easeInOut',
        onComplete: () => { root.setScale(startScale); resolve(); },
      }));
    });
    flyer.tween?.resume();
  }

  /** The chosen one sparkles, then leads the way off toward the exit. */
  private async exitStageRight(ctx: EngineContext, flyer: Flyer): Promise<void> {
    const at = worldXY(flyer.view.root);
    const norm = normalizer(ctx)(at.x, at.y);
    ctx.art.burst(ctx.artCtx, norm.x, norm.y, { count: 20 });
    ctx.systems.audio.play('sparkle');
    await flyer.view.celebrate();

    // Everyone else reacts before the winner leaves.
    for (const other of this.flyers) {
      if (other === flyer) continue;
      void this.funnyLoop(ctx, other, 1);
    }

    flyer.tween?.stop();
    flyer.tween = null;
    ctx.systems.audio.play('whoosh');
    await new Promise<void>((resolve) => {
      if (this.cleanup.destroyed) { resolve(); return; }
      this.cleanup.track(ctx.scene.tweens.add({
        targets: flyer.view.root,
        x: flyer.home.x + ctx.artCtx.width * 0.55,
        y: flyer.home.y - ctx.artCtx.height * 0.3,
        rotation: 0,
        duration: 1100,
        ease: 'Sine.easeIn',
        onComplete: () => resolve(),
      }));
    });
  }

  destroy(): void {
    this.cleanup.run();
    this.flyers = [];
    if (this.finish && this.beat) {
      this.finish(this.beat.result());
      this.finish = null;
    }
  }
}
