import * as Phaser from 'phaser';
import type { ArtContext, CharacterView, Palette, SceneArtist } from '../art/contract';
import { REGISTRY } from '../StoryEngine';
import type { StoryEngine } from '../StoryEngine';
import type { StoryScene as StorySceneData } from '../../shared/types';
import {
  FONT, SCENE_KEYS, TEX, createArtist, createBigButton, cssColor, layoutWords,
} from './BootScene';

/**
 * HomeScene - the cover of the book.
 *
 * The whole screen is one invitation: the story's title, the two characters
 * waiting, and a single enormous PLAY button. No menus, no settings, no back
 * button. Everything on screen comes from the loaded story, so a generated
 * book gets the same cover treatment as the builtin one.
 */
export class HomeScene extends Phaser.Scene {
  private engine!: StoryEngine;
  private art!: SceneArtist;
  private artCtx!: ArtContext;
  private backdrop: { update(deltaMs: number): void } | null = null;
  private parallax: Phaser.GameObjects.Container[] = [];
  private mimo: CharacterView | null = null;
  private fox: CharacterView | null = null;
  private hovering = false;

  constructor() {
    super(SCENE_KEYS.home);
  }

  create(): void {
    const engine = this.registry.get(REGISTRY.engine) as StoryEngine | undefined;
    if (!engine) {
      this.showNoStory();
      return;
    }
    this.engine = engine;

    const cover = engine.story.scenes[0];
    this.art = createArtist();
    const palette = this.art.paletteFor(cover.biome, cover.timeOfDay);
    this.artCtx = { scene: this, width: this.scale.width, height: this.scale.height, palette };

    this.paintCover(cover, palette);
    this.placeCharacters(palette);
    this.drawTitle(engine.story.title, palette);
    this.drawPlayButton(palette);

    this.cameras.main.fadeIn(700, 0, 0, 0);
  }

  update(_time: number, delta: number): void {
    this.backdrop?.update(delta);
    const pointer = this.input.activePointer;
    const offset = (pointer.x / this.scale.width - 0.5) * 2;
    this.parallax.forEach((layer, i) => {
      layer.x = offset * (i + 1) * -5;
    });
  }

  /* ---------------------------------------------------------------- */

  private paintCover(cover: StorySceneData, palette: Palette): void {
    const painted = this.art.paintBackdrop(this.artCtx, cover.biome, cover.timeOfDay);
    this.backdrop = painted;
    this.parallax = painted.layers;

    const { width, height } = this.scale;

    // A soft scrim so title type stays legible over any biome.
    const scrim = this.add.graphics().setDepth(100);
    scrim.fillStyle(palette.scrim, 0.28);
    scrim.fillRect(0, 0, width, height);

    this.add
      .image(width / 2, 0, TEX.fade)
      .setOrigin(0.5, 0)
      .setDisplaySize(width, height * 0.62)
      .setTint(palette.scrim)
      .setAlpha(0.42)
      .setDepth(101);

    this.add
      .particles(0, 0, TEX.spark, {
        x: { min: 0, max: width },
        y: height + 24,
        lifespan: { min: 4200, max: 7600 },
        speedY: { min: -34, max: -74 },
        speedX: { min: -16, max: 16 },
        scale: { start: 0.34, end: 0 },
        alpha: { start: 0.85, end: 0 },
        rotate: { min: 0, max: 360 },
        quantity: 1,
        frequency: 380,
        blendMode: 'ADD',
        tint: palette.accent,
      })
      .setDepth(102);
  }

  private placeCharacters(palette: Palette): void {
    const { width, height } = this.scale;

    this.fox = this.art.createFox(this.artCtx);
    this.fox.root.setPosition(width * 0.2, height * 0.78).setDepth(120);
    this.fox.setFacing(1);
    this.fox.setMood('happy');

    this.mimo = this.art.createMimo(this.artCtx);
    this.mimo.root.setPosition(width * 0.8, height * 0.76).setDepth(121);
    this.mimo.setFacing(-1);
    this.mimo.setMood('idle');

    // A pool of warmth under each character so they sit on the page.
    [this.fox.root, this.mimo.root].forEach((root) => {
      this.add
        .image(root.x, root.y + 6, TEX.glow)
        .setDisplaySize(220, 90)
        .setTint(palette.accent)
        .setAlpha(0.22)
        .setDepth(119);
    });
  }

  private drawTitle(title: string, palette: Palette): void {
    const { width, height } = this.scale;
    const container = this.add.container(width / 2, height * 0.26).setDepth(200);

    const laid = layoutWords(
      this,
      title.split(/\s+/).map((word) => ({
        text: word,
        style: {
          fontFamily: FONT.story,
          fontSize: '76px',
          color: cssColor(palette.ink),
          fontStyle: 'bold',
        },
      })),
      { maxWidth: width * 0.84, lineSpacing: 88 },
    );

    laid.words.forEach((word, i) => {
      const glow = this.add
        .image(word.x, word.y, TEX.glow)
        .setDisplaySize(word.text.width * 1.5, word.text.height * 1.7)
        .setTint(palette.dark ? palette.accent : 0xffffff)
        .setAlpha(0);
      container.add(glow);

      word.text.setPosition(word.x, word.y - 46).setAlpha(0).setAngle(-6);
      container.add(word.text);

      this.tweens.add({
        targets: word.text,
        y: word.y,
        alpha: 1,
        angle: 0,
        duration: 620,
        delay: 220 + i * 110,
        ease: 'Back.easeOut',
      });
      this.tweens.add({
        targets: glow,
        alpha: 0.3,
        duration: 900,
        delay: 320 + i * 110,
        ease: 'Sine.easeOut',
      });
    });

    this.tweens.add({
      targets: container,
      y: container.y - 10,
      duration: 3200,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    const tagline = this.add
      .text(width / 2, height * 0.26 + laid.height / 2 + 34, 'Every book deserves to be played.', {
        fontFamily: FONT.story,
        fontSize: '26px',
        color: cssColor(palette.ink),
        fontStyle: 'italic',
      })
      .setOrigin(0.5)
      .setAlpha(0)
      .setDepth(200);

    this.tweens.add({
      targets: tagline,
      alpha: 0.82,
      duration: 900,
      delay: 900,
      ease: 'Sine.easeOut',
    });
  }

  private drawPlayButton(palette: Palette): void {
    const { width, height } = this.scale;

    const button = createBigButton(this, {
      label: 'PLAY',
      x: width / 2,
      y: height * 0.66,
      width: 360,
      height: 124,
      fill: palette.accent,
      ink: palette.dark ? 0x14202e : 0xffffff,
      fontSize: 52,
      onHover: (over) => this.reactToHover(over),
      onPress: () => this.beginStory(),
    });

    button.setDepth(210).setAlpha(0).setScale(0.8);
    this.tweens.add({
      targets: button,
      alpha: 1,
      scale: 1,
      duration: 520,
      delay: 700,
      ease: 'Back.easeOut',
    });
  }

  /** Mimo notices you reaching for the button. */
  private reactToHover(over: boolean): void {
    if (!this.mimo || this.hovering === over) return;
    this.hovering = over;

    if (!over) {
      this.mimo.setMood('idle');
      return;
    }

    this.mimo.setMood('excited');
    void this.mimo.moveTo(0.8, 0.76, { hop: true, durationMs: 420 });
    this.art.burst(this.artCtx, 0.8, 0.7, {
      count: 8,
      color: this.artCtx.palette.accent,
    });
  }

  private beginStory(): void {
    this.mimo?.setMood('excited');
    void this.mimo?.celebrate();
    this.cameras.main.fadeOut(520, 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.engine.start();
      this.scene.start(SCENE_KEYS.story);
    });
  }

  /**
   * Honest empty state. If no story was handed to the game we say exactly
   * that rather than inventing a cover.
   */
  private showNoStory(): void {
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor('#101826');
    this.add
      .text(width / 2, height / 2 - 20, 'No story loaded', {
        fontFamily: FONT.display,
        fontSize: '44px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    this.add
      .text(
        width / 2,
        height / 2 + 40,
        'The game was started without story JSON.\nLoad a story, then reopen this screen.',
        {
          fontFamily: FONT.display,
          fontSize: '22px',
          color: '#9fb3c8',
          align: 'center',
          lineSpacing: 8,
        },
      )
      .setOrigin(0.5);
  }
}
