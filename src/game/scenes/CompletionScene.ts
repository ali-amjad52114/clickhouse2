import * as Phaser from 'phaser';
import type { ArtContext, CharacterView, Palette, SceneArtist } from '../art/contract';
import { REGISTRY } from '../StoryEngine';
import type { RunSummary, StoryEngine } from '../StoryEngine';
import {
  FONT, SCENE_KEYS, TEX, createArtist, createBigButton, cssColor, layoutWords,
} from './BootScene';

const CONFETTI_TINTS = [0xff6b6b, 0xffd93d, 0x6bcb77, 0x4aa3ff, 0xc792ff, 0xff8fc7];

/**
 * CompletionScene - the last page.
 *
 * A celebration first and a report second: what the child actually did this
 * run, read straight off the engine's recorded outcomes. Nothing here is
 * decorative-but-invented; every number is a real count.
 */
export class CompletionScene extends Phaser.Scene {
  private engine!: StoryEngine;
  private art!: SceneArtist;
  private artCtx!: ArtContext;
  private backdrop: { update(deltaMs: number): void } | null = null;
  private fox: CharacterView | null = null;
  private mimo: CharacterView | null = null;

  constructor() {
    super(SCENE_KEYS.completion);
  }

  create(): void {
    const engine = this.registry.get(REGISTRY.engine) as StoryEngine | undefined;
    if (!engine) {
      this.scene.start(SCENE_KEYS.home);
      return;
    }
    this.engine = engine;

    const finale = engine.story.scenes[engine.story.scenes.length - 1];
    this.art = createArtist();
    const palette = this.art.paletteFor(finale.biome, finale.timeOfDay);
    this.artCtx = { scene: this, width: this.scale.width, height: this.scale.height, palette };

    const painted = this.art.paintBackdrop(this.artCtx, finale.biome, finale.timeOfDay);
    this.backdrop = painted;

    this.dim(palette);
    this.confetti();
    this.characters(palette);

    const summary = engine.summary();
    this.banner(palette);
    this.subtitle(engine.story.title, palette);
    this.stats(summary, palette);
    this.buttons(palette);

    this.cameras.main.fadeIn(600, 0, 0, 0);
    this.firstBurst(palette);
  }

  update(_time: number, delta: number): void {
    this.backdrop?.update(delta);
  }

  /* ---------------------------------------------------------------- */

  private dim(palette: Palette): void {
    const { width, height } = this.scale;
    const scrim = this.add.graphics().setDepth(100);
    scrim.fillStyle(palette.scrim, 0.42);
    scrim.fillRect(0, 0, width, height);
  }

  private confetti(): void {
    const { width } = this.scale;
    this.add
      .particles(0, -40, TEX.confetti, {
        x: { min: 0, max: width },
        y: -40,
        lifespan: 4600,
        speedY: { min: 90, max: 190 },
        speedX: { min: -50, max: 50 },
        rotate: { start: 0, end: 540 },
        scale: { min: 0.55, max: 1.05 },
        alpha: { start: 1, end: 0.9 },
        quantity: 2,
        frequency: 130,
        tint: CONFETTI_TINTS,
      })
      .setDepth(110);
  }

  private characters(palette: Palette): void {
    const { width, height } = this.scale;

    this.fox = this.art.createFox(this.artCtx);
    this.fox.root.setPosition(width * 0.17, height * 0.8).setDepth(500);
    this.fox.setFacing(1);
    this.fox.setMood('happy');

    this.mimo = this.art.createMimo(this.artCtx);
    this.mimo.root.setPosition(width * 0.83, height * 0.78).setDepth(501);
    this.mimo.setFacing(-1);
    this.mimo.setMood('proud');

    [this.fox.root, this.mimo.root].forEach((root) => {
      this.add
        .image(root.x, root.y + 8, TEX.glow)
        .setDisplaySize(240, 100)
        .setTint(palette.accent)
        .setAlpha(0.26)
        .setDepth(499);
    });

    const cheer = () => {
      void this.fox?.celebrate();
      void this.mimo?.celebrate();
    };
    cheer();
    this.time.addEvent({ delay: 2800, loop: true, callback: cheer });
  }

  private banner(palette: Palette): void {
    const { width, height } = this.scale;
    const container = this.add.container(width / 2, height * 0.2).setDepth(900);

    const laid = layoutWords(
      this,
      'ADVENTURE COMPLETE!'.split(' ').map((word) => ({
        text: word,
        style: {
          fontFamily: FONT.display,
          fontSize: '82px',
          color: cssColor(palette.dark ? 0xfff3c4 : 0xffffff),
          fontStyle: 'bold',
          stroke: cssColor(palette.dark ? 0x2a1c48 : 0x1d3557),
          strokeThickness: 10,
        },
      })),
      { maxWidth: width * 0.88, lineSpacing: 92 },
    );

    laid.words.forEach((word, i) => {
      word.text.setPosition(word.x, word.y - 120).setAlpha(0).setScale(0.5);
      container.add(word.text);
      this.tweens.add({
        targets: word.text,
        y: word.y,
        alpha: 1,
        scale: 1,
        duration: 760,
        delay: 180 + i * 180,
        ease: 'Bounce.easeOut',
      });
    });

    this.tweens.add({
      targets: container,
      angle: { from: -1.2, to: 1.2 },
      duration: 2600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  private subtitle(title: string, palette: Palette): void {
    const { width, height } = this.scale;
    const text = this.add
      .text(width / 2, height * 0.33, title, {
        fontFamily: FONT.story,
        fontSize: '30px',
        color: cssColor(palette.ink),
        fontStyle: 'italic',
      })
      .setOrigin(0.5)
      .setAlpha(0)
      .setDepth(900);

    this.tweens.add({ targets: text, alpha: 0.9, duration: 700, delay: 800 });
  }

  /** Real counts from the run. No number on this screen is invented. */
  private stats(summary: RunSummary, palette: Palette): void {
    const { width, height } = this.scale;
    const cards: { icon: string; value: string; label: string; tint: number }[] = [
      { icon: TEX.star, value: `${summary.stars}`, label: 'stars', tint: 0xffd93d },
      {
        icon: TEX.dot,
        value: `${summary.scenesCompleted}/${summary.totalScenes}`,
        label: 'pages played',
        tint: 0x6bcb77,
      },
      { icon: TEX.spark, value: formatDuration(summary.durationMs), label: 'time', tint: 0x4aa3ff },
    ];

    const cardW = 220;
    const gap = 26;
    const totalW = cards.length * cardW + (cards.length - 1) * gap;
    const startX = width / 2 - totalW / 2 + cardW / 2;

    cards.forEach((card, i) => {
      const container = this.add
        .container(startX + i * (cardW + gap), height * 0.5)
        .setDepth(900)
        .setAlpha(0)
        .setScale(0.8);

      const box = this.add.graphics();
      box.fillStyle(palette.scrim, 0.85);
      box.fillRoundedRect(-cardW / 2, -66, cardW, 132, 22);
      box.lineStyle(3, card.tint, 0.55);
      box.strokeRoundedRect(-cardW / 2, -66, cardW, 132, 22);
      container.add(box);

      const icon = this.add.image(-cardW / 2 + 44, -14, card.icon).setTint(card.tint);
      icon.setDisplaySize(38, 38);
      container.add(icon);

      container.add(
        this.add
          .text(14, -18, card.value, {
            fontFamily: FONT.display,
            fontSize: '44px',
            color: cssColor(palette.ink),
            fontStyle: 'bold',
          })
          .setOrigin(0.5),
      );
      container.add(
        this.add
          .text(0, 36, card.label, {
            fontFamily: FONT.display,
            fontSize: '20px',
            color: cssColor(palette.ink),
          })
          .setOrigin(0.5)
          .setAlpha(0.75),
      );

      this.tweens.add({
        targets: container,
        alpha: 1,
        scale: 1,
        duration: 480,
        delay: 1100 + i * 150,
        ease: 'Back.easeOut',
      });
    });
  }

  private buttons(palette: Palette): void {
    const { width, height } = this.scale;

    const again = createBigButton(this, {
      label: 'PLAY AGAIN',
      x: width / 2,
      y: height * 0.75,
      width: 400,
      height: 108,
      fill: palette.accent,
      ink: palette.dark ? 0x161f2e : 0xffffff,
      fontSize: 42,
      onPress: () => this.leave(SCENE_KEYS.story, true),
    });
    again.setDepth(920).setAlpha(0);
    this.tweens.add({ targets: again, alpha: 1, duration: 500, delay: 1500 });

    const cover = this.add
      .text(width / 2, height * 0.88, 'back to the cover', {
        fontFamily: FONT.display,
        fontSize: '22px',
        color: cssColor(palette.ink),
      })
      .setOrigin(0.5)
      .setAlpha(0)
      .setDepth(920)
      .setInteractive({ useHandCursor: true });

    cover.on('pointerover', () => cover.setAlpha(1));
    cover.on('pointerout', () => cover.setAlpha(0.7));
    cover.on('pointerup', () => this.leave(SCENE_KEYS.home, false));
    this.tweens.add({ targets: cover, alpha: 0.7, duration: 500, delay: 1700 });
  }

  private firstBurst(palette: Palette): void {
    [0.3, 0.5, 0.7].forEach((x, i) => {
      this.time.delayedCall(320 + i * 260, () => {
        this.art.burst(this.artCtx, x, 0.42, { count: 26, color: palette.accent });
      });
    });
  }

  private leave(key: string, restart: boolean): void {
    this.cameras.main.fadeOut(420, 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      if (restart) this.engine.start();
      this.scene.start(key);
    });
  }
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
