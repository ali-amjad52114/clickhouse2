import Phaser from 'phaser';
import type { Interaction, PathChoiceInteraction } from '../../shared/types';
import type { EngineContext, InteractionModule, InteractionResult } from '../engineContract';
import {
  Beat, Cleanup, DEPTH, STORY_FONT, css, normalizer, offerHelpIfPolicySays,
  promptBanner, saySafely, scoreHint, tweenNow, wait, worldXY,
} from './base';

interface Trail {
  id: string;
  label: string;
  correct: boolean;
  end: { x: number; y: number };
  curve: Phaser.Curves.QuadraticBezier;
  dots: Phaser.GameObjects.Arc[];
  marker: Phaser.GameObjects.Container;
  text: Phaser.GameObjects.Text;
}

/** Finger-sized, then some - these are destinations, not buttons. */
const MARKER_RADIUS = 62;

/**
 * PATH CHOICE - "which way do we go?".
 *
 * Two or three glowing trails of light lead away from the fox. The child picks
 * one and the pair actually walks it. When the story marks no path as correct,
 * every path is correct: this is a fork in the adventure, not a quiz.
 */
export class PathChoice implements InteractionModule {
  readonly type = 'path_choice' as const;

  private cleanup = new Cleanup();
  private beat: Beat | null = null;
  private trails: Trail[] = [];
  private busy = false;
  private finish: ((r: InteractionResult) => void) | null = null;

  async run(ctx: EngineContext, config: Interaction): Promise<InteractionResult> {
    const cfg = config as PathChoiceInteraction;
    const beat = new Beat(ctx, this.type);
    this.beat = beat;

    // A branch with no "correct" path is a real choice, not a mistake.
    const freeChoice = !cfg.paths.some((p) => p.correct);

    beat.emit('interaction_started', {
      metadata: { paths: cfg.paths.map((p) => p.id), free_choice: freeChoice },
    });

    if (cfg.paths.length === 0) {
      console.warn('[path_choice] no paths defined');
      beat.emit('interaction_completed', { correct: null, metadata: { reason: 'no_paths' } });
      return beat.result();
    }

    promptBanner(ctx, this.cleanup, cfg.prompt);

    const start = worldXY(ctx.fox.root);
    for (const path of cfg.paths) {
      this.trails.push(this.buildTrail(ctx, start, path, freeChoice));
    }

    return new Promise<InteractionResult>((resolve) => {
      this.finish = resolve;
      for (const trail of this.trails) {
        const handler = () => { void this.onPick(ctx, beat, trail, freeChoice); };
        trail.marker.on('pointerdown', handler);
        this.cleanup.onDestroy(() => trail.marker.off('pointerdown', handler));
      }
    });
  }

  /* ------------------------------ drawing ------------------------------ */

  private buildTrail(
    ctx: EngineContext,
    start: { x: number; y: number },
    path: PathChoiceInteraction['paths'][number],
    freeChoice: boolean,
  ): Trail {
    const { palette } = ctx.artCtx;
    const end = ctx.toPx(path.x, path.y);

    // Bow the trail away from the straight line so two paths never overlap.
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const bow = (end.x - start.x) * 0.18;
    const curve = new Phaser.Curves.QuadraticBezier(
      new Phaser.Math.Vector2(start.x, start.y),
      new Phaser.Math.Vector2(midX + bow, midY - Math.abs(bow) - 40),
      new Phaser.Math.Vector2(end.x, end.y),
    );

    const dots: Phaser.GameObjects.Arc[] = [];
    const steps = 16;
    const point = new Phaser.Math.Vector2();
    for (let i = 1; i <= steps; i++) {
      curve.getPoint(i / (steps + 1), point);
      const dot = this.cleanup.own(
        ctx.scene.add.circle(point.x, point.y, 7, palette.accent, 0.85),
      );
      dot.setDepth(DEPTH.fx - 50);
      dots.push(dot);
      // Light runs along the trail, so it reads as "this way".
      tweenNow(ctx.scene, this.cleanup, {
        targets: dot,
        scale: 1.6,
        alpha: 0.35,
        duration: 620,
        delay: i * 90,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    const marker = this.cleanup.own(ctx.scene.add.container(end.x, end.y));
    marker.setDepth(DEPTH.ui - 10);

    const ring = ctx.scene.add.graphics();
    ring.fillStyle(palette.scrim, 0.7);
    ring.fillCircle(0, 0, MARKER_RADIUS);
    ring.lineStyle(5, palette.accent, 0.9);
    ring.strokeCircle(0, 0, MARKER_RADIUS);
    marker.add(ring);

    const text = ctx.scene.add.text(0, MARKER_RADIUS + 22, path.label, {
      fontFamily: STORY_FONT,
      fontSize: '26px',
      color: css(palette.ink),
      fontStyle: 'bold',
      align: 'center',
      wordWrap: { width: 240 },
    }).setOrigin(0.5, 0);
    marker.add(text);

    marker.setInteractive(
      new Phaser.Geom.Circle(0, 0, MARKER_RADIUS + 12),
      Phaser.Geom.Circle.Contains,
    );

    tweenNow(ctx.scene, this.cleanup, {
      targets: marker, scale: 1.07, duration: 900 + Math.random() * 400,
      yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });

    return {
      id: path.id,
      label: path.label,
      correct: freeChoice ? true : path.correct,
      end,
      curve,
      dots,
      marker,
      text,
    };
  }

  /* ----------------------------- gameplay ------------------------------ */

  private async onPick(
    ctx: EngineContext, beat: Beat, trail: Trail, freeChoice: boolean,
  ): Promise<void> {
    if (this.busy || beat.completed) return;
    this.busy = true;
    beat.attempts += 1;

    beat.emit('object_tapped', {
      correct: trail.correct,
      metadata: { path_id: trail.id, label: trail.label, free_choice: freeChoice },
    });
    scoreHint(beat, trail.id);

    if (!trail.correct) {
      beat.wrongChoices += 1;
      beat.emit('wrong_choice', {
        correct: false,
        metadata: { path_id: trail.id, label: trail.label },
      });
      ctx.systems.audio.play('tap');
      ctx.mimo.setMood('worried');
      await this.shakeTrail(ctx, trail);
      await saySafely(ctx, ctx.storyScene.companion.retry, 'curious');
      const right = this.trails.find((t) => t.correct);
      await offerHelpIfPolicySays(ctx, beat, right ? right.id : null);
      if (right) this.pulse(ctx, right);
      this.busy = false;
      return;
    }

    beat.completed = true;
    beat.emit('correct_choice', {
      correct: true,
      metadata: { path_id: trail.id, label: trail.label, free_choice: freeChoice },
    });

    ctx.systems.audio.play('correct');
    ctx.mimo.setMood('excited');
    ctx.fox.setMood('happy');
    await this.travel(ctx, trail);

    beat.emit('interaction_completed', {
      correct: true,
      metadata: { path_id: trail.id, wrong_choices: beat.wrongChoices },
    });
    this.finish?.(beat.result());
    this.finish = null;
  }

  /** Not-this-way reads as the trail shrugging. */
  private async shakeTrail(ctx: EngineContext, trail: Trail): Promise<void> {
    const x = trail.marker.x;
    await new Promise<void>((resolve) => {
      if (this.cleanup.destroyed) { resolve(); return; }
      this.cleanup.track(ctx.scene.tweens.add({
        targets: trail.marker,
        x: { value: x - 14, duration: 70, yoyo: true, repeat: 3 },
        onComplete: () => { trail.marker.setX(x); resolve(); },
      }));
    });
  }

  private pulse(ctx: EngineContext, trail: Trail): void {
    for (const dot of trail.dots) {
      tweenNow(ctx.scene, this.cleanup, {
        targets: dot, scale: 2.2, duration: 260, yoyo: true, repeat: 2, ease: 'Sine.easeOut',
      });
    }
  }

  /** The characters actually walk the path the child chose. */
  private async travel(ctx: EngineContext, chosen: Trail): Promise<void> {
    const toNorm = normalizer(ctx);

    for (const other of this.trails) {
      if (other === chosen) continue;
      tweenNow(ctx.scene, this.cleanup, {
        targets: [other.marker, ...other.dots], alpha: 0, duration: 320, ease: 'Sine.easeIn',
      });
    }
    tweenNow(ctx.scene, this.cleanup, {
      targets: chosen.text, alpha: 0, duration: 320,
    });

    // Light rushes down the chosen trail ahead of the travellers.
    chosen.dots.forEach((dot, i) => {
      ctx.scene.tweens.killTweensOf(dot);
      tweenNow(ctx.scene, this.cleanup, {
        targets: dot, scale: 2.4, alpha: 0, duration: 380, delay: i * 55, ease: 'Cubic.easeOut',
      });
    });
    ctx.systems.audio.play('whoosh');

    // Walk two or three waypoints along the real curve so the movement follows
    // the trail the child looked at, not a straight line through the scenery.
    const point = new Phaser.Math.Vector2();
    const stops = [0.45, 0.78, 1];
    const mimoWalk = (async () => {
      await wait(ctx, 260, this.cleanup);
      for (const t of stops) {
        if (this.cleanup.destroyed) return;
        chosen.curve.getPoint(t, point);
        const n = toNorm(point.x, point.y);
        await ctx.systems.companion.moveTo(n.x + 0.05, n.y + 0.03);
      }
    })();

    for (const t of stops) {
      if (this.cleanup.destroyed) return;
      chosen.curve.getPoint(t, point);
      const n = toNorm(point.x, point.y);
      await ctx.fox.moveTo(n.x, n.y, { hop: false });
    }
    await mimoWalk;

    tweenNow(ctx.scene, this.cleanup, {
      targets: chosen.marker, scale: 0, alpha: 0, duration: 300, ease: 'Back.easeIn',
    });
  }

  destroy(): void {
    this.cleanup.run();
    this.trails = [];
    if (this.finish && this.beat) {
      this.finish(this.beat.result());
      this.finish = null;
    }
  }
}
