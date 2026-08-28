import Phaser from 'phaser';
import type { Interaction, TapTargetInteraction } from '../../shared/types';
import type { EngineContext, InteractionModule, InteractionResult } from '../engineContract';
import type { PropView } from '../art/contract';
import {
  Beat, Cleanup, DEPTH, halo, hitRadiusFor, makeTappable, normalizer, offerHelpIfPolicySays,
  promptBanner, saySafely, scoreHint, tweenNow, worldXY,
} from './base';

/**
 * TAP TARGET - "find the thing".
 *
 * Scene 1: the star fell somewhere in the forest. The right prop sparkles and
 * pops; anything else wobbles and Mimo says something warm. There is no fail
 * state, no timer and no wrong-answer marker - only "not that one, keep going".
 */
export class TapTarget implements InteractionModule {
  readonly type = 'tap_target' as const;

  private cleanup = new Cleanup();
  private beat: Beat | null = null;
  private busy = false;
  private finish: ((r: InteractionResult) => void) | null = null;

  async run(ctx: EngineContext, config: Interaction): Promise<InteractionResult> {
    const cfg = config as TapTargetInteraction;
    const beat = new Beat(ctx, this.type);
    this.beat = beat;

    beat.emit('interaction_started', {
      metadata: { target: cfg.target, distractors: cfg.distractors ?? [] },
    });

    const target = ctx.props.get(cfg.target);
    if (!target) {
      // Honest failure: the story asked for a prop the artist never drew.
      console.warn(`[tap_target] target prop "${cfg.target}" is not in this scene`);
      beat.emit('interaction_completed', {
        correct: null,
        metadata: { reason: 'missing_target_prop', target: cfg.target },
      });
      return beat.result();
    }

    promptBanner(ctx, this.cleanup, cfg.prompt);

    // A soft breathing halo under the target keeps the scene readable for a
    // 5 year old without giving the answer away - it is barely visible until
    // the policy decides a real hint is due.
    const targetPos = worldXY(target.root);
    const glow = halo(ctx, this.cleanup, hitRadiusFor(target) * 1.4, ctx.artCtx.palette.accent);
    glow.setPosition(targetPos.x, targetPos.y).setAlpha(0.18);
    tweenNow(ctx.scene, this.cleanup, {
      targets: glow, alpha: 0.34, scale: 1.12, duration: 1400,
      yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });

    const listed = new Set(cfg.distractors ?? []);

    return new Promise<InteractionResult>((resolve) => {
      this.finish = resolve;

      // Everything on screen answers to a finger. Tapping a tree is not an
      // error the child should be told about - it is just exploring.
      for (const [id, view] of ctx.props) {
        if (id === cfg.target) continue;
        makeTappable(view, this.cleanup, (propId, pointer) => {
          void this.onWrong(ctx, beat, view, propId, pointer, target, listed.has(propId));
        });
      }
      makeTappable(target, this.cleanup, () => {
        void this.onCorrect(ctx, beat, target);
      });
    });
  }

  private async onCorrect(ctx: EngineContext, beat: Beat, target: PropView): Promise<void> {
    if (this.busy || beat.completed) return;
    this.busy = true;
    beat.attempts += 1;
    beat.completed = true;

    const at = worldXY(target.root);
    beat.emit('object_tapped', { correct: true, metadata: { prop_id: target.id } });
    scoreHint(beat, target.id);
    beat.emit('correct_choice', { correct: true, metadata: { prop_id: target.id } });

    ctx.systems.audio.play('sparkle');
    ctx.mimo.setMood('excited');

    // Pop, then sparkle burst.
    tweenNow(ctx.scene, this.cleanup, {
      targets: target.root, scale: (target.root.scale || 1) * 1.35,
      duration: 180, yoyo: true, ease: 'Back.easeOut',
    });
    const norm = normalizer(ctx)(at.x, at.y);
    ctx.art.burst(ctx.artCtx, norm.x, norm.y, { count: 22 });
    ctx.systems.audio.play('correct');
    await target.celebrate();

    beat.emit('interaction_completed', {
      correct: true,
      metadata: { prop_id: target.id, wrong_choices: beat.wrongChoices },
    });
    this.finish?.(beat.result());
    this.finish = null;
  }

  private async onWrong(
    ctx: EngineContext,
    beat: Beat,
    view: PropView,
    propId: string,
    pointer: Phaser.Input.Pointer,
    target: PropView,
    wasListed: boolean,
  ): Promise<void> {
    if (this.busy || beat.completed) return;

    // Small fingers miss. If the tap also lands inside the target's generous
    // radius, the child meant the target - give it to them.
    const t = worldXY(target.root);
    if (Phaser.Math.Distance.Between(pointer.worldX, pointer.worldY, t.x, t.y) <= hitRadiusFor(target)) {
      await this.onCorrect(ctx, beat, target);
      return;
    }

    this.busy = true;
    beat.attempts += 1;
    beat.wrongChoices += 1;

    beat.emit('object_tapped', { correct: false, metadata: { prop_id: propId, listed_distractor: wasListed } });
    scoreHint(beat, propId);
    beat.emit('wrong_choice', {
      correct: false,
      metadata: { prop_id: propId, listed_distractor: wasListed, label: view.root.name || '' },
    });

    ctx.systems.audio.play('tap');
    ctx.mimo.setMood('curious');
    this.showTapEcho(ctx, pointer.worldX, pointer.worldY);
    await view.wobble();

    await saySafely(ctx, ctx.storyScene.companion.retry, 'curious');
    await offerHelpIfPolicySays(ctx, beat, target.id);

    this.busy = false;
  }

  /** A friendly ring where the finger landed, so the tap always feels heard. */
  private showTapEcho(ctx: EngineContext, x: number, y: number): void {
    const g = this.cleanup.own(ctx.scene.add.graphics());
    g.setDepth(DEPTH.fx);
    g.lineStyle(4, ctx.artCtx.palette.accent, 0.8);
    g.strokeCircle(0, 0, 26);
    g.setPosition(x, y);
    tweenNow(ctx.scene, this.cleanup, {
      targets: g, scale: 2.1, alpha: 0, duration: 420, ease: 'Cubic.easeOut',
      onComplete: () => g.destroy(),
    });
  }

  destroy(): void {
    this.cleanup.run();
    if (this.finish && this.beat) {
      const r = this.beat.result();
      this.finish(r);
      this.finish = null;
    }
  }
}
