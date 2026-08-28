import type Phaser from 'phaser';
import type { ArtContext, SceneArtist } from '../art/contract';
import type { AudioSystemApi, RewardSystemApi } from '../engineContract';

/**
 * Stars: the only score a five-year-old needs.
 *
 * Awarding spawns real star shapes at the place the child earned them and
 * flies them along an arc into a HUD counter, each one landing with a chime
 * and bumping the running total. Nothing here is pre-rendered - the stars are
 * Phaser shapes drawn at runtime, like everything else in this project.
 */

export interface RewardBinding {
  scene: Phaser.Scene;
  artCtx: ArtContext;
  art: SceneArtist;
}

export interface RewardOptions {
  audio: AudioSystemApi;
  /** Carried over from a previous scene / saved progress. */
  initialStars?: number;
  /** Most flying stars to spawn for one award; the total is always exact. */
  maxFlyers?: number;
}

const HUD_DEPTH = 9000;
const STAR_GOLD = 0xffd75e;
const STAR_EDGE = 0xffb020;

export class RewardSystem implements RewardSystemApi {
  private audio: AudioSystemApi;
  private stars: number;
  private maxFlyers: number;

  private scene: Phaser.Scene | null = null;
  private artCtx: ArtContext | null = null;
  private art: SceneArtist | null = null;

  private hud: Phaser.GameObjects.Container | null = null;
  private hudText: Phaser.GameObjects.Text | null = null;
  private hudStar: Phaser.GameObjects.Star | null = null;
  private flyers = new Set<Phaser.GameObjects.GameObject>();
  private listeners = new Set<(total: number) => void>();

  constructor(opts: RewardOptions) {
    this.audio = opts.audio;
    this.stars = Math.max(0, opts.initialStars ?? 0);
    this.maxFlyers = Math.max(1, opts.maxFlyers ?? 10);
  }

  /** Called when a new StoryScene boots; rebuilds the HUD in that scene. */
  attach(binding: RewardBinding): void {
    this.detach();
    this.scene = binding.scene;
    this.artCtx = binding.artCtx;
    this.art = binding.art;
    this.buildHud();
  }

  detach(): void {
    for (const f of this.flyers) f.destroy();
    this.flyers.clear();
    this.hud?.destroy();
    this.hud = null;
    this.hudText = null;
    this.hudStar = null;
    this.scene = null;
    this.artCtx = null;
    this.art = null;
  }

  total(): number {
    return this.stars;
  }

  onChange(cb: (total: number) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /**
   * Award `stars`, flying them from (atX, atY) into the counter.
   * Coordinates may be normalised 0..1 or raw pixels - both are accepted so
   * interactions can pass whichever they already hold.
   */
  award(stars: number, atX: number, atY: number): Promise<void> {
    const amount = Math.max(0, Math.round(stars));
    if (amount === 0) return Promise.resolve();

    const scene = this.scene;
    if (!scene || !this.artCtx) {
      // No scene bound (headless / between scenes): still keep the score true.
      this.bump(amount);
      return Promise.resolve();
    }

    const from = this.toPixels(atX, atY);
    const target = this.hudPoint();
    const flyers = Math.min(amount, this.maxFlyers);
    const per = Math.floor(amount / flyers);
    const remainder = amount - per * flyers;

    this.audio.play('collect');

    return new Promise<void>((resolve) => {
      let landed = 0;
      for (let i = 0; i < flyers; i += 1) {
        const value = per + (i < remainder ? 1 : 0);
        const jitterX = (Math.random() - 0.5) * 46;
        const jitterY = (Math.random() - 0.5) * 34;
        this.flyOne(from.x + jitterX, from.y + jitterY, target, i * 85, value, () => {
          landed += 1;
          if (landed === flyers) resolve();
        });
      }
    });
  }

  celebrate(x: number, y: number): void {
    const scene = this.scene;
    if (!scene || !this.artCtx || !this.art) return;
    const px = this.toPixels(x, y);
    const nx = px.x / this.artCtx.width;
    const ny = px.y / this.artCtx.height;
    this.audio.play('celebrate');
    this.art.burst(this.artCtx, nx, ny, { count: 28, color: STAR_GOLD });
    this.punchHud(1.35);
  }

  /* ---------------------------------------------------------------- */

  private toPixels(x: number, y: number): { x: number; y: number } {
    const ctx = this.artCtx;
    if (!ctx) return { x, y };
    const normalised = x >= 0 && x <= 1 && y >= 0 && y <= 1;
    return normalised ? { x: x * ctx.width, y: y * ctx.height } : { x, y };
  }

  private hudPoint(): { x: number; y: number } {
    if (this.hud) return { x: this.hud.x, y: this.hud.y };
    const ctx = this.artCtx;
    return { x: (ctx?.width ?? 1280) - 96, y: 44 };
  }

  private buildHud(): void {
    const scene = this.scene;
    const ctx = this.artCtx;
    if (!scene || !ctx) return;

    const x = ctx.width - 96;
    const y = 44;
    const pill = scene.add.graphics();
    pill.fillStyle(0x000000, 0.22);
    pill.fillRoundedRect(-58, -26, 132, 52, 26);
    pill.lineStyle(3, STAR_GOLD, 0.55);
    pill.strokeRoundedRect(-58, -26, 132, 52, 26);

    const star = scene.add.star(-32, 0, 5, 8, 16, STAR_GOLD);
    star.setStrokeStyle(3, STAR_EDGE, 1);

    const text = scene.add.text(2, 0, String(this.stars), {
      fontFamily: 'Comic Sans MS, Trebuchet MS, Verdana, sans-serif',
      fontSize: '28px',
      color: '#fff6d8',
    });
    text.setOrigin(0, 0.5);
    text.setShadow(0, 2, '#00000066', 3, false, true);

    const hud = scene.add.container(x, y, [pill, star, text]);
    hud.setDepth(HUD_DEPTH);
    hud.setScrollFactor(0);

    this.hud = hud;
    this.hudStar = star;
    this.hudText = text;

    scene.tweens.add({
      targets: star,
      angle: 360,
      duration: 6000,
      repeat: -1,
      ease: 'Linear',
    });
  }

  private flyOne(
    fromX: number, fromY: number,
    to: { x: number; y: number },
    delay: number, value: number,
    done: () => void,
  ): void {
    const scene = this.scene;
    if (!scene) { this.bump(value); done(); return; }

    const star = scene.add.star(fromX, fromY, 5, 6, 14, STAR_GOLD);
    star.setStrokeStyle(2, STAR_EDGE, 1);
    star.setDepth(HUD_DEPTH - 1);
    star.setScale(0.2);
    star.setAlpha(0);
    this.flyers.add(star);

    // Arc control point: lifted above the midpoint so the star loops upward.
    const cx = (fromX + to.x) / 2 + (Math.random() - 0.5) * 90;
    const cy = Math.min(fromY, to.y) - 130 - Math.random() * 60;

    scene.tweens.add({
      targets: star,
      scale: 1,
      alpha: 1,
      duration: 180,
      delay,
      ease: 'Back.easeOut',
    });

    scene.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 620,
      delay: delay + 140,
      ease: 'Sine.easeInOut',
      onUpdate: (tw: Phaser.Tweens.Tween) => {
        const t = tw.getValue() ?? 0;
        const inv = 1 - t;
        star.x = inv * inv * fromX + 2 * inv * t * cx + t * t * to.x;
        star.y = inv * inv * fromY + 2 * inv * t * cy + t * t * to.y;
        star.angle = t * 420;
        star.setScale(1 - t * 0.45);
      },
      onComplete: () => {
        this.flyers.delete(star);
        star.destroy();
        this.bump(value);
        this.audio.play('star');
        this.punchHud(1.18);
        done();
      },
    });
  }

  private punchHud(scale: number): void {
    const scene = this.scene;
    if (!scene || !this.hud) return;
    scene.tweens.add({
      targets: this.hud,
      scaleX: scale,
      scaleY: scale,
      duration: 110,
      yoyo: true,
      ease: 'Quad.easeOut',
    });
    if (this.hudStar) {
      // Kept small: the star sits next to the number and must never cover it.
      const spin = 1 + (scale - 1) * 0.35;
      scene.tweens.add({
        targets: this.hudStar,
        scaleX: spin,
        scaleY: spin,
        duration: 140,
        yoyo: true,
        ease: 'Back.easeOut',
      });
    }
  }

  private bump(by: number): void {
    this.stars += by;
    this.hudText?.setText(String(this.stars));
    for (const cb of this.listeners) {
      try { cb(this.stars); } catch { /* a listener must not break scoring */ }
    }
  }
}
