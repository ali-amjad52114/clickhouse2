import Phaser from 'phaser';
import type { DragDropInteraction, Interaction } from '../../shared/types';
import type { EngineContext, InteractionModule, InteractionResult } from '../engineContract';
import type { PropView } from '../art/contract';
import {
  Beat, Cleanup, DEPTH, hitRadiusFor, normalizer, offerHelpIfPolicySays,
  promptBanner, saySafely, tweenNow, wait, worldXY,
} from './base';

/**
 * DRAG DROP - "put it back where it belongs".
 *
 * Scene 5: the star goes home. The closer the star gets to its place in the
 * sky the brighter it burns - that is a real distance interpolation running on
 * every drag event, not a scripted animation. Let go too early and the star
 * simply floats back down; nothing is lost.
 */
export class DragDrop implements InteractionModule {
  readonly type = 'drag_drop' as const;

  private cleanup = new Cleanup();
  private beat: Beat | null = null;
  private finish: ((r: InteractionResult) => void) | null = null;
  private glow: Phaser.GameObjects.Graphics | null = null;
  private zoneRing: Phaser.GameObjects.Graphics | null = null;
  private highlighted = false;
  private baseScale = 1;

  async run(ctx: EngineContext, config: Interaction): Promise<InteractionResult> {
    const cfg = config as DragDropInteraction;
    const beat = new Beat(ctx, this.type);
    this.beat = beat;

    beat.emit('interaction_started', {
      metadata: { drag_id: cfg.dragId, drop_zone: cfg.dropZone.label },
    });

    const star = ctx.props.get(cfg.dragId);
    if (!star) {
      console.warn(`[drag_drop] drag prop "${cfg.dragId}" is not in this scene`);
      beat.emit('interaction_completed', {
        correct: null,
        metadata: { reason: 'missing_drag_prop', drag_id: cfg.dragId },
      });
      return beat.result();
    }

    promptBanner(ctx, this.cleanup, cfg.prompt);

    const { width, height, palette } = ctx.artCtx;
    const zone = ctx.toPx(cfg.dropZone.x, cfg.dropZone.y);
    // Normalised radius reads against the smaller screen axis, then gets a
    // forgiving floor - a five year old should not have to be precise.
    const zoneRadius = Math.max(90, cfg.dropZone.radius * Math.min(width, height));

    this.drawDropZone(ctx, zone.x, zone.y, zoneRadius);

    this.glow = this.cleanup.own(ctx.scene.add.graphics());
    this.glow.setDepth(DEPTH.fx - 20);
    for (let i = 5; i >= 1; i--) {
      this.glow.fillStyle(palette.accent, 0.14);
      this.glow.fillCircle(0, 0, hitRadiusFor(star) * 1.6 * (i / 5));
    }
    this.glow.setAlpha(0);

    this.baseScale = star.root.scale || 1;
    star.idle();

    return new Promise<InteractionResult>((resolve) => {
      this.finish = resolve;
      this.attachDrag(ctx, beat, star, zone, zoneRadius, cfg);
    });
  }

  /* ------------------------------ the zone ----------------------------- */

  private drawDropZone(ctx: EngineContext, x: number, y: number, radius: number): void {
    const { palette } = ctx.artCtx;
    const ring = this.cleanup.own(ctx.scene.add.graphics());
    ring.setDepth(DEPTH.fx - 30);
    ring.lineStyle(5, palette.accent, 0.55);
    ring.strokeCircle(0, 0, radius);
    ring.lineStyle(2, palette.accent, 0.3);
    ring.strokeCircle(0, 0, radius * 0.7);
    // A hollow outline of where a star should be.
    ring.fillStyle(palette.accent, 0.07);
    ring.fillCircle(0, 0, radius);
    ring.setPosition(x, y);
    this.zoneRing = ring;

    tweenNow(ctx.scene, this.cleanup, {
      targets: ring, scale: 1.08, alpha: 0.75, duration: 1200,
      yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
  }

  /* ------------------------------ dragging ----------------------------- */

  private attachDrag(
    ctx: EngineContext,
    beat: Beat,
    star: PropView,
    zone: { x: number; y: number },
    zoneRadius: number,
    cfg: DragDropInteraction,
  ): void {
    const root = star.root;
    const home = { x: root.x, y: root.y };
    const radius = Math.max(hitRadiusFor(star), 56);
    root.setInteractive(new Phaser.Geom.Circle(0, 0, radius), Phaser.Geom.Circle.Contains);
    ctx.scene.input.setDraggable(root);

    // Reach: the distance at which the star starts to feel the sky.
    const reach = zoneRadius * 2.6;

    const onStart = () => {
      if (beat.completed) return;
      beat.attempts += 1;
      ctx.systems.audio.play('tap');
      ctx.scene.tweens.killTweensOf(root);
      ctx.mimo.setMood('excited');
      beat.emit('object_tapped', { correct: null, metadata: { prop_id: star.id, phase: 'pick_up' } });
    };

    const onDrag = (_p: Phaser.Input.Pointer, dragX: number, dragY: number) => {
      if (beat.completed) return;
      root.setPosition(dragX, dragY);

      const at = worldXY(root);
      const distance = Phaser.Math.Distance.Between(at.x, at.y, zone.x, zone.y);
      const proximity = Phaser.Math.Clamp(1 - distance / reach, 0, 1);

      // Real interpolation: brightness, size and halo all track the distance.
      root.setScale(this.baseScale * (1 + proximity * 0.35));
      if (this.glow) {
        this.glow.setPosition(at.x, at.y);
        this.glow.setAlpha(proximity);
        this.glow.setScale(1 + proximity * 0.7);
      }
      if (this.zoneRing) this.zoneRing.setAlpha(0.45 + proximity * 0.55);

      const near = proximity > 0.72;
      if (near !== this.highlighted) {
        this.highlighted = near;
        star.highlight(near);
        if (near) ctx.systems.audio.play('sparkle');
      }
    };

    const onEnd = () => {
      if (beat.completed) return;
      const at = worldXY(root);
      const distance = Phaser.Math.Distance.Between(at.x, at.y, zone.x, zone.y);
      if (distance <= zoneRadius) void this.onDropped(ctx, beat, star, zone);
      else void this.onMissed(ctx, beat, star, home, cfg, distance);
    };

    root.on('dragstart', onStart);
    root.on('drag', onDrag);
    root.on('dragend', onEnd);
    this.cleanup.onDestroy(() => {
      root.off('dragstart', onStart);
      root.off('drag', onDrag);
      root.off('dragend', onEnd);
      try { ctx.scene.input.setDraggable(root, false); } catch { /* scene already down */ }
      if (root.input) root.removeInteractive();
      star.highlight(false);
    });
  }

  private async onMissed(
    ctx: EngineContext,
    beat: Beat,
    star: PropView,
    home: { x: number; y: number },
    cfg: DragDropInteraction,
    distance: number,
  ): Promise<void> {
    beat.wrongChoices += 1;
    beat.emit('wrong_choice', {
      correct: false,
      metadata: {
        prop_id: star.id,
        distance_px: Math.round(distance),
        drop_zone: cfg.dropZone.label,
      },
    });

    this.highlighted = false;
    star.highlight(false);
    ctx.systems.audio.play('whoosh');
    this.glow?.setAlpha(0);

    // It floats back down. It does not fall, and it is never taken away.
    await new Promise<void>((resolve) => {
      if (this.cleanup.destroyed) { resolve(); return; }
      this.cleanup.track(ctx.scene.tweens.add({
        targets: star.root,
        x: home.x, y: home.y,
        scale: this.baseScale,
        duration: 620,
        ease: 'Back.easeOut',
        onComplete: () => resolve(),
      }));
    });
    await star.wobble();
    await saySafely(ctx, ctx.storyScene.companion.retry, 'curious');
    await offerHelpIfPolicySays(ctx, beat, star.id);
  }

  private async onDropped(
    ctx: EngineContext, beat: Beat, star: PropView, zone: { x: number; y: number },
  ): Promise<void> {
    beat.completed = true;
    beat.emit('correct_choice', { correct: true, metadata: { prop_id: star.id } });

    star.highlight(false);
    this.highlighted = false;
    ctx.systems.audio.play('star');
    ctx.mimo.setMood('proud');
    ctx.fox.setMood('proud');

    // Snap home and swell.
    const root = star.root;
    const at = worldXY(root);
    const local = { x: root.x + (zone.x - at.x), y: root.y + (zone.y - at.y) };
    await new Promise<void>((resolve) => {
      if (this.cleanup.destroyed) { resolve(); return; }
      this.cleanup.track(ctx.scene.tweens.add({
        targets: root,
        x: local.x, y: local.y,
        scale: this.baseScale * 1.7,
        duration: 520,
        ease: 'Back.easeOut',
        onComplete: () => resolve(),
      }));
    });

    this.glow?.setPosition(zone.x, zone.y).setAlpha(1).setScale(2);
    tweenNow(ctx.scene, this.cleanup, {
      targets: this.glow, scale: 5, alpha: 0, duration: 1400, ease: 'Cubic.easeOut',
    });
    if (this.zoneRing) {
      tweenNow(ctx.scene, this.cleanup, {
        targets: this.zoneRing, scale: 3, alpha: 0, duration: 900, ease: 'Cubic.easeOut',
      });
    }

    await this.bloomTheSky(ctx, zone);

    beat.emit('interaction_completed', {
      correct: true,
      metadata: { prop_id: star.id, wrong_choices: beat.wrongChoices },
    });
    this.finish?.(beat.result());
    this.finish = null;
  }

  /** The payoff: the sky fills with stars the child just switched on. */
  private async bloomTheSky(ctx: EngineContext, from: { x: number; y: number }): Promise<void> {
    const { width, height, palette } = ctx.artCtx;
    const toNorm = normalizer(ctx);

    ctx.systems.audio.play('reveal');

    const field = this.cleanup.own(ctx.scene.add.container(0, 0));
    field.setDepth(DEPTH.fx - 40);

    const dust = 110;
    for (let i = 0; i < dust; i++) {
      const x = Math.random() * width;
      const y = Math.random() * height * 0.62;
      const r = 1 + Math.random() * 2.4;
      const dot = ctx.scene.add.circle(x, y, r, 0xffffff, 0.9);
      dot.setScale(0);
      field.add(dot);
      // Stars bloom outward from the one the child put back.
      const delay = Phaser.Math.Distance.Between(x, y, from.x, from.y) * 0.55;
      tweenNow(ctx.scene, this.cleanup, {
        targets: dot, scale: 1, duration: 420, delay, ease: 'Back.easeOut',
      });
      tweenNow(ctx.scene, this.cleanup, {
        targets: dot, alpha: 0.28, duration: 900 + Math.random() * 1400,
        delay: delay + 500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
    }

    for (let i = 0; i < 14; i++) {
      const x = Math.random() * width;
      const y = Math.random() * height * 0.5;
      const big = ctx.scene.add.star(x, y, 5, 3, 9, palette.sun, 1);
      big.setScale(0);
      field.add(big);
      const delay = Phaser.Math.Distance.Between(x, y, from.x, from.y) * 0.55;
      tweenNow(ctx.scene, this.cleanup, {
        targets: big, scale: 1, angle: 180, duration: 620, delay, ease: 'Back.easeOut',
      });
    }

    // Confetti, in the artist's own hand.
    const origin = toNorm(from.x, from.y);
    ctx.art.burst(ctx.artCtx, origin.x, origin.y, { count: 30, color: palette.sun });
    await wait(ctx, 260, this.cleanup);
    ctx.systems.audio.play('celebrate');
    ctx.art.burst(ctx.artCtx, 0.25, 0.4, { count: 18 });
    ctx.art.burst(ctx.artCtx, 0.75, 0.36, { count: 18 });
    ctx.systems.reward.celebrate(from.x, from.y);

    await wait(ctx, 700, this.cleanup);
  }

  destroy(): void {
    this.cleanup.run();
    this.glow = null;
    this.zoneRing = null;
    if (this.finish && this.beat) {
      this.finish(this.beat.result());
      this.finish = null;
    }
  }
}
