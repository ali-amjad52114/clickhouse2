import Phaser from 'phaser';
import type { CollectItemsInteraction, Interaction } from '../../shared/types';
import type { EngineContext, InteractionModule, InteractionResult } from '../engineContract';
import type { PropView } from '../art/contract';
import {
  Beat, Cleanup, DEPTH, STORY_FONT, css, makeTappable, normalizer, offerHelpIfPolicySays,
  promptBanner, ripple, saySafely, scoreHint, tweenNow, wait, worldXY,
} from './base';

/** Where the stepping stones land, as normalised x across the water. */
const CROSSING_X = [0.32, 0.5, 0.68, 0.84, 0.9];
/** The water line the fox hops along. */
const CROSSING_Y = 0.76;

/**
 * COLLECT ITEMS - "find them all".
 *
 * Scene 2: three stones. Each one found arcs into the river, splashes, and
 * fills the next pip. When the last pip lights up the fox hops stone to stone
 * and Mimo scrambles after him. Order does not matter and nothing is ever
 * taken away once found.
 */
export class CollectItems implements InteractionModule {
  readonly type = 'collect_items' as const;

  private cleanup = new Cleanup();
  private beat: Beat | null = null;
  private collected = new Set<string>();
  private pips: Phaser.GameObjects.Graphics[] = [];
  private pipLabel: Phaser.GameObjects.Text | null = null;
  private landings: Array<{ x: number; y: number }> = [];
  private busy = false;
  private needed = 0;
  private finish: ((r: InteractionResult) => void) | null = null;

  async run(ctx: EngineContext, config: Interaction): Promise<InteractionResult> {
    const cfg = config as CollectItemsInteraction;
    const beat = new Beat(ctx, this.type);
    this.beat = beat;

    const targets = cfg.targets.filter((id) => ctx.props.has(id));
    this.needed = Math.min(cfg.count, targets.length);

    beat.emit('interaction_started', {
      metadata: { targets: cfg.targets, count: cfg.count, found_in_scene: targets.length },
    });

    if (this.needed <= 0) {
      console.warn('[collect_items] none of the target props exist in this scene');
      beat.emit('interaction_completed', {
        correct: null,
        metadata: { reason: 'missing_target_props', targets: cfg.targets },
      });
      return beat.result();
    }

    promptBanner(ctx, this.cleanup, cfg.prompt);
    this.buildPips(ctx);

    const targetSet = new Set(targets);

    return new Promise<InteractionResult>((resolve) => {
      this.finish = resolve;
      for (const [id, view] of ctx.props) {
        const isTarget = targetSet.has(id);
        makeTappable(view, this.cleanup, () => {
          if (isTarget) void this.onCollect(ctx, beat, view);
          else void this.onWrong(ctx, beat, view, targets);
        });
      }
    });
  }

  /* --------------------------- progress pips --------------------------- */

  private buildPips(ctx: EngineContext): void {
    const { width, height, palette } = ctx.artCtx;
    const size = Math.max(14, Math.round(width * 0.014));
    const gap = size * 3;
    const totalW = gap * (this.needed - 1);
    const baseX = width / 2 - totalW / 2;
    const y = height * 0.175;

    for (let i = 0; i < this.needed; i++) {
      const g = this.cleanup.own(ctx.scene.add.graphics());
      g.setDepth(DEPTH.ui);
      g.setPosition(baseX + gap * i, y);
      this.drawPip(g, size, palette.scrim, palette.accent, false);
      this.pips.push(g);
    }

    this.pipLabel = this.cleanup.own(ctx.scene.add.text(
      width / 2, y + size * 2.4, `0/${this.needed}`,
      {
        fontFamily: STORY_FONT,
        fontSize: `${Math.round(size * 1.5)}px`,
        color: css(palette.ink),
        fontStyle: 'bold',
      },
    ).setOrigin(0.5).setDepth(DEPTH.ui));
  }

  private drawPip(
    g: Phaser.GameObjects.Graphics, size: number,
    empty: number, filled: number, on: boolean,
  ): void {
    g.clear();
    g.fillStyle(on ? filled : empty, on ? 1 : 0.55);
    g.fillCircle(0, 0, size);
    g.lineStyle(3, filled, on ? 1 : 0.5);
    g.strokeCircle(0, 0, size);
  }

  private fillNextPip(ctx: EngineContext): void {
    const index = this.collected.size - 1;
    const pip = this.pips[index];
    const { width, palette } = ctx.artCtx;
    const size = Math.max(14, Math.round(width * 0.014));
    if (pip) {
      this.drawPip(pip, size, palette.scrim, palette.accent, true);
      tweenNow(ctx.scene, this.cleanup, {
        targets: pip, scale: 1.5, duration: 180, yoyo: true, ease: 'Back.easeOut',
      });
    }
    this.pipLabel?.setText(`${this.collected.size}/${this.needed}`);
    if (this.pipLabel) {
      tweenNow(ctx.scene, this.cleanup, {
        targets: this.pipLabel, scale: 1.35, duration: 200, yoyo: true, ease: 'Back.easeOut',
      });
    }
  }

  /* ----------------------------- gameplay ------------------------------ */

  private async onCollect(ctx: EngineContext, beat: Beat, view: PropView): Promise<void> {
    if (this.busy || beat.completed || this.collected.has(view.id)) return;
    this.busy = true;

    beat.attempts += 1;
    this.collected.add(view.id);

    beat.emit('object_tapped', { correct: true, metadata: { prop_id: view.id } });
    scoreHint(beat, view.id);
    beat.emit('correct_choice', {
      correct: true,
      metadata: { prop_id: view.id, collected: this.collected.size, of: this.needed },
    });

    ctx.systems.audio.play('collect');
    ctx.mimo.setMood('happy');
    this.fillNextPip(ctx);
    await this.arcIntoRiver(ctx, view, this.collected.size - 1);

    if (this.collected.size >= this.needed) {
      beat.completed = true;
      await this.crossTheRiver(ctx);
      beat.emit('interaction_completed', {
        correct: true,
        metadata: { collected: this.collected.size, wrong_choices: beat.wrongChoices },
      });
      this.finish?.(beat.result());
      this.finish = null;
      return;
    }

    this.busy = false;
    void this.remindWhatIsLeft(ctx);
  }

  private async remindWhatIsLeft(ctx: EngineContext): Promise<void> {
    const left = this.needed - this.collected.size;
    if (left <= 0) return;
    await saySafely(ctx, left === 1 ? 'One more!' : `${left} more to go!`, 'happy');
  }

  private async onWrong(
    ctx: EngineContext, beat: Beat, view: PropView, targets: string[],
  ): Promise<void> {
    if (this.busy || beat.completed) return;
    this.busy = true;
    beat.attempts += 1;
    beat.wrongChoices += 1;

    beat.emit('object_tapped', { correct: false, metadata: { prop_id: view.id } });
    scoreHint(beat, view.id);
    beat.emit('wrong_choice', { correct: false, metadata: { prop_id: view.id } });

    ctx.systems.audio.play('tap');
    await view.wobble();
    await saySafely(ctx, ctx.storyScene.companion.retry, 'curious');

    const nextTarget = targets.find((id) => !this.collected.has(id)) ?? null;
    await offerHelpIfPolicySays(ctx, beat, nextTarget);
    this.busy = false;
  }

  /* ------------------------------ visuals ------------------------------ */

  /** The stone flies out on a real arc and lands where the fox will need it. */
  private async arcIntoRiver(ctx: EngineContext, view: PropView, index: number): Promise<void> {
    const { width, height } = ctx.artCtx;
    const landing = ctx.toPx(CROSSING_X[index] ?? 0.5, CROSSING_Y);
    this.landings[index] = landing;

    const from = worldXY(view.root);
    const root = view.root;
    const startX = root.x;
    const startY = root.y;
    // Work in the prop's own parent space: same delta, no parallax surprises.
    const deltaX = landing.x - from.x;
    const deltaY = landing.y - from.y;
    const peak = Math.min(height * 0.28, Math.abs(deltaX) * 0.5 + 80);

    const driver = { t: 0 };
    await new Promise<void>((resolve) => {
      if (this.cleanup.destroyed) { resolve(); return; }
      this.cleanup.track(ctx.scene.tweens.add({
        targets: driver,
        t: 1,
        duration: 620,
        ease: 'Sine.easeInOut',
        onUpdate: () => {
          const t = driver.t;
          root.setPosition(
            startX + deltaX * t,
            startY + deltaY * t - Math.sin(Math.PI * t) * peak,
          );
          root.setRotation(t * Math.PI * 1.5);
        },
        onComplete: () => resolve(),
      }));
    });

    root.setRotation(0);
    ctx.systems.audio.play('collect');
    ripple(ctx, this.cleanup, landing.x, landing.y, { radius: width * 0.09, rings: 3 });
    tweenNow(ctx.scene, this.cleanup, {
      targets: root, scaleY: (root.scaleY || 1) * 0.75, duration: 120,
      yoyo: true, ease: 'Sine.easeOut',
    });
  }

  /** Payoff: hop, hop, HOP - and Mimo trips along behind. */
  private async crossTheRiver(ctx: EngineContext): Promise<void> {
    const toNorm = normalizer(ctx);
    const stones = this.landings
      .filter(Boolean)
      .map((p) => toNorm(p.x, p.y))
      .sort((a, b) => a.x - b.x);
    if (stones.length === 0) return;

    ctx.fox.setMood('excited');
    ctx.mimo.setMood('excited');
    ctx.systems.audio.play('whoosh');

    const foxPath = [...stones, { x: 0.92, y: stones[stones.length - 1].y + 0.06 }];

    const mimoRun = (async () => {
      await wait(ctx, 420, this.cleanup);
      for (const step of foxPath) {
        if (this.cleanup.destroyed) return;
        await ctx.systems.companion.moveTo(step.x, step.y + 0.03);
        // Mimo never quite sticks the landing.
        tweenNow(ctx.scene, this.cleanup, {
          targets: ctx.mimo.root,
          rotation: Math.PI * 2,
          duration: 340,
          ease: 'Back.easeOut',
          onComplete: () => ctx.mimo.root.setRotation(0),
        });
      }
    })();

    for (const step of foxPath) {
      if (this.cleanup.destroyed) return;
      ctx.systems.audio.play('hop');
      await ctx.fox.moveTo(step.x, step.y, { hop: true, durationMs: 420 });
    }

    await mimoRun;
    ctx.systems.audio.play('celebrate');
  }

  destroy(): void {
    this.cleanup.run();
    this.pips = [];
    this.pipLabel = null;
    if (this.finish && this.beat) {
      this.finish(this.beat.result());
      this.finish = null;
    }
  }
}
