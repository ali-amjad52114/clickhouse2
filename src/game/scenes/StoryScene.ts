import * as Phaser from 'phaser';
import type {
  Interaction, StoryScene as StorySceneData,
} from '../../shared/types';
import type {
  ArtContext, CharacterView, Palette, PropView, SceneArtist,
} from '../art/contract';
import { getInteraction } from '../interactions';
import { createSystems } from '../systems';
import type { GameSystems } from '../systems';
import type {
  EngineContext, InteractionModule, InteractionResult,
} from '../engineContract';
import { REGISTRY } from '../StoryEngine';
import type { GameHooks, SceneOutcome, StoryEngine } from '../StoryEngine';
import {
  FONT, SCENE_KEYS, TEX, createArtist, createBigButton, cssColor, layoutWords,
} from './BootScene';

/**
 * StoryScene - one page of the book, made playable.
 *
 * Everything here is driven by the StoryScene JSON handed over by StoryEngine:
 * biome and time of day pick the palette, props are drawn into parallax
 * layers, narration becomes a typeset caption, and `interaction.type` selects
 * a gameplay module from the registry. Nothing in this file knows which book
 * is loaded.
 */

const ABORT = Symbol('scene-aborted');

/** Where the two characters stand once they have walked on. */
const FOX_HOME = { x: 0.19, y: 0.79 };
const MIMO_HOME = { x: 0.3, y: 0.85 };

export class StoryScene extends Phaser.Scene {
  private engine!: StoryEngine;
  private hooks: GameHooks = {};
  private page!: StorySceneData;

  private art!: SceneArtist;
  private artCtx!: ArtContext;
  private palette!: Palette;
  private backdrop: { update(deltaMs: number): void } | null = null;
  private layers: Phaser.GameObjects.Container[] = [];

  private props = new Map<string, PropView>();
  private fox!: CharacterView;
  private mimo!: CharacterView;
  private systems!: GameSystems;
  private ctx!: EngineContext;
  private module: InteractionModule | null = null;

  private caption: Phaser.GameObjects.Container | null = null;
  private alive = true;
  private abortSignal!: Promise<never>;

  constructor() {
    super(SCENE_KEYS.story);
  }

  create(): void {
    this.alive = true;
    this.props = new Map();
    this.module = null;

    this.abortSignal = new Promise<never>((_resolve, reject) => {
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => reject(ABORT));
    });
    this.abortSignal.catch(() => undefined);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.alive = false;
      this.module?.destroy();
      this.module = null;
    });

    const engine = this.registry.get(REGISTRY.engine) as StoryEngine | undefined;
    if (!engine) {
      this.showBlockingMessage(
        'No story loaded',
        'StoryScene was started without a StoryEngine in the registry.',
      );
      return;
    }
    this.engine = engine;
    this.hooks = (this.registry.get(REGISTRY.hooks) as GameHooks | undefined) ?? {};

    const data = engine.currentScene();
    if (!data) {
      this.scene.start(SCENE_KEYS.completion);
      return;
    }
    this.page = data;

    this.art = createArtist();
    this.palette = this.art.paletteFor(data.biome, data.timeOfDay);
    this.artCtx = {
      scene: this,
      width: this.scale.width,
      height: this.scale.height,
      palette: this.palette,
    };

    this.paintScene(data);
    this.createCharacters();
    this.buildRuntime(data);
    this.drawHud();

    this.cameras.main.fadeIn(600, 0, 0, 0);
    void this.play();
  }

  update(_time: number, delta: number): void {
    this.backdrop?.update(delta);

    const offset = (this.input.activePointer.x / this.scale.width - 0.5) * 2;
    this.layers.forEach((layer, i) => {
      layer.x = offset * (i + 1) * -4;
    });
  }

  /* ------------------------------------------------------- construction */

  private paintScene(data: StorySceneData): void {
    const painted = this.art.paintBackdrop(this.artCtx, data.biome, data.timeOfDay);
    this.backdrop = painted;
    this.layers = painted.layers;

    for (const prop of data.props) {
      const view = this.art.drawProp(this.artCtx, prop);
      const layer = this.layers[view.layer] ?? this.layers[1];
      // Only reparent into a parallax layer when that layer sits at the
      // origin, otherwise the artist's absolute placement would shift.
      if (layer && layer.x === 0 && layer.y === 0 && layer.scaleX === 1) {
        layer.add(view.root);
      }
      view.idle();
      this.props.set(prop.id, view);
    }
  }

  private createCharacters(): void {
    const { width, height } = this.scale;

    this.fox = this.art.createFox(this.artCtx);
    this.fox.root.setPosition(-width * 0.15, height * FOX_HOME.y).setDepth(500);
    this.fox.setFacing(1);
    this.fox.setMood('idle');

    this.mimo = this.art.createMimo(this.artCtx);
    this.mimo.root.setPosition(-width * 0.28, height * MIMO_HOME.y).setDepth(501);
    this.mimo.setFacing(1);
    this.mimo.setMood('idle');
  }

  /**
   * Systems live for the whole play session (star total, analytics session id,
   * progress record) and are re-bound to each page as it boots.
   */
  private buildRuntime(data: StorySceneData): void {
    this.systems = this.resolveSystems();
    this.systems.attachScene({
      scene: this,
      art: this.art,
      artCtx: this.artCtx,
      mimo: this.mimo,
      props: this.props,
      sceneId: data.id,
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.systems.detachScene());

    // The live policy object: the adaptation system mutates it in place when a
    // real ClickHouse profile arrives, so this reference stays current.
    const policy = this.systems.policy();
    this.engine.setPolicy(policy);

    this.ctx = {
      scene: this,
      art: this.art,
      artCtx: this.artCtx,
      props: this.props,
      fox: this.fox,
      mimo: this.mimo,
      story: this.engine.story,
      storyScene: data,
      policy,
      systems: this.systems,
      toPx: (x: number, y: number) => this.toPx(x, y),
    };
  }

  private resolveSystems(): GameSystems {
    const existing = this.registry.get(REGISTRY.systems) as GameSystems | undefined;
    if (existing) return existing;

    const created = createSystems({
      childId: this.engine.childId,
      story: this.engine.story,
      sessionId: this.engine.sessionId,
    });
    this.registry.set(REGISTRY.systems, created);
    return created;
  }

  /* ------------------------------------------------------- the page flow */

  private async play(): Promise<void> {
    try {
      await this.runPage();
    } catch (err) {
      if (err !== ABORT) console.error('[StoryScene]', err);
    }
  }

  private async runPage(): Promise<void> {
    const data = this.page;
    const analytics = this.systems.analytics;

    if (this.engine.isFirstScene()) {
      analytics.emit('story_started', {
        scene_id: data.id,
        metadata: {
          story_id: this.engine.story.id,
          title: this.engine.story.title,
          source: this.engine.story.source,
          total_scenes: this.engine.totalScenes(),
        },
      });
    }

    analytics.emit('scene_started', {
      scene_id: data.id,
      interaction_type: data.interaction.type,
      metadata: {
        biome: data.biome,
        location: data.location,
        scene_number: this.engine.sceneNumber(),
      },
    });

    await this.enterCharacters();
    await this.showNarration(data);
    await this.g(this.systems.companion.say(data.companion.intro, { mood: 'excited' }));

    this.dismissCaption();
    const result = await this.runInteraction(data.interaction);

    if (result.completed) {
      await this.succeed(data, result);
    } else {
      this.recordOutcome(data, result, false, 0);
    }

    await this.finishPage(data);
  }

  private async enterCharacters(): Promise<void> {
    this.fox.setMood('curious');
    const foxWalk = this.fox.moveTo(FOX_HOME.x, FOX_HOME.y, { durationMs: 1250 });
    await this.delay(280);
    const mimoHop = this.mimo.moveTo(MIMO_HOME.x, MIMO_HOME.y, { hop: true, durationMs: 1300 });
    await this.g(Promise.all([foxWalk, mimoHop]));
    this.mimo.setMood('curious');
  }

  /**
   * The storybook caption: a soft scrim, large bookish type, and a
   * word-by-word reveal so a 5-year-old can follow along. Emphasis words from
   * the story JSON get their own size, colour and glow.
   */
  private showNarration(data: StorySceneData): Promise<void> {
    const { width } = this.scale;
    const tokens = data.narration.split(/\s+/).filter(Boolean);
    const flags = emphasisFlags(tokens, data.emphasis ?? []);
    const inkCss = cssColor(this.palette.ink);
    const accentCss = cssColor(this.palette.accent);

    const laid = layoutWords(
      this,
      tokens.map((token, i) => ({
        text: token,
        emphasis: flags[i],
        style: flags[i]
          ? { fontFamily: FONT.story, fontSize: '44px', color: accentCss, fontStyle: 'bold' }
          : { fontFamily: FONT.story, fontSize: '34px', color: inkCss },
      })),
      { maxWidth: width * 0.76, lineSpacing: 56 },
    );

    const padX = 44;
    const padY = 28;
    const boxW = laid.width + padX * 2;
    const boxH = laid.height + padY * 2;

    const container = this.add.container(width / 2, 30 + boxH / 2).setDepth(860);
    this.caption = container;

    const scrim = this.add.graphics();
    scrim.fillStyle(0x000000, 0.16);
    scrim.fillRoundedRect(-boxW / 2, -boxH / 2 + 8, boxW, boxH, 28);
    scrim.fillStyle(this.palette.scrim, 0.88);
    scrim.fillRoundedRect(-boxW / 2, -boxH / 2, boxW, boxH, 28);
    scrim.lineStyle(3, this.palette.accent, 0.3);
    scrim.strokeRoundedRect(-boxW / 2, -boxH / 2, boxW, boxH, 28);
    container.add(scrim);

    const glows: Phaser.GameObjects.Image[] = [];
    laid.words.forEach((word, i) => {
      const delay = 220 + i * 85;

      if (word.emphasis) {
        const glow = this.add
          .image(word.x, word.y, TEX.glow)
          .setDisplaySize(word.text.width * 1.7, word.text.height * 1.9)
          .setTint(this.palette.accent)
          .setAlpha(0);
        container.add(glow);
        glows.push(glow);
        this.tweens.add({ targets: glow, alpha: 0.34, duration: 420, delay, ease: 'Sine.easeOut' });
      }

      word.text.setPosition(word.x, word.y + 14).setAlpha(0);
      if (word.emphasis) word.text.setScale(0.7);
      container.add(word.text);

      this.tweens.add({
        targets: word.text,
        y: word.y,
        alpha: 1,
        scale: 1,
        duration: word.emphasis ? 430 : 300,
        delay,
        ease: word.emphasis ? 'Back.easeOut' : 'Sine.easeOut',
      });
    });

    container.setAlpha(0).setY(container.y - 22);
    this.tweens.add({
      targets: container,
      alpha: 1,
      y: container.y + 22,
      duration: 480,
      ease: 'Cubic.easeOut',
    });

    // Impatient readers can tap the caption to finish the reveal.
    const zone = this.add
      .zone(width / 2, container.y, boxW, boxH)
      .setInteractive({ useHandCursor: true })
      .setDepth(861);

    const totalMs = 700 + tokens.length * 85;
    return this.waitFor((done) => {
      const finish = () => {
        zone.destroy();
        done();
      };
      const timer = this.time.delayedCall(totalMs, finish);
      zone.once('pointerdown', () => {
        timer.remove();
        laid.words.forEach((word) => {
          this.tweens.killTweensOf(word.text);
          word.text.setPosition(word.x, word.y).setAlpha(1).setScale(1);
        });
        glows.forEach((glow) => {
          this.tweens.killTweensOf(glow);
          glow.setAlpha(0.34);
        });
        finish();
      });
    });
  }

  /**
   * The page has been read; now it becomes playable. The caption lifts away so
   * the interaction owns the top band for its own prompt banner.
   */
  private dismissCaption(): void {
    const caption = this.caption;
    if (!caption) return;
    this.caption = null;

    this.tweens.add({
      targets: caption,
      alpha: 0,
      y: caption.y - 26,
      scale: 0.94,
      duration: 480,
      ease: 'Cubic.easeIn',
      onComplete: () => caption.destroy(),
    });
  }

  private async runInteraction(config: Interaction): Promise<InteractionResult> {
    let module: InteractionModule;
    try {
      module = getInteraction(config.type);
    } catch (err) {
      console.error('[StoryScene] interaction unavailable', err);
      return this.missingInteraction(config.type);
    }

    this.module = module;
    try {
      return await this.g(module.run(this.ctx, config));
    } finally {
      module.destroy();
      this.module = null;
    }
  }

  private async succeed(data: StorySceneData, result: InteractionResult): Promise<void> {
    this.fox.setMood('happy');
    this.mimo.setMood('proud');

    await this.g(this.systems.companion.say(data.companion.success, { mood: 'proud' }));

    // reward.celebrate() already fires the artist's burst at this point.
    const focus = this.focusPoint(data);
    this.systems.reward.celebrate(focus.x, focus.y);
    void this.fox.celebrate();
    void this.mimo.celebrate();

    await this.g(this.systems.reward.award(data.reward.stars, focus.x, focus.y));

    this.systems.progress.markSceneComplete(data.id);
    this.systems.progress.save();
    this.recordOutcome(data, result, true, data.reward.stars);
  }

  private recordOutcome(
    data: StorySceneData,
    result: InteractionResult,
    completed: boolean,
    stars: number,
  ): void {
    const outcome: SceneOutcome = {
      sceneId: data.id,
      completed,
      starsAwarded: stars,
      attempts: result.attempts,
      wrongChoices: result.wrongChoices,
      hintsOffered: result.hintsOffered,
      hintsAccepted: result.hintsAccepted,
      elapsedMs: result.elapsedMs,
    };
    this.engine.recordOutcome(outcome);
    this.hooks.onSceneComplete?.(outcome);

    this.systems.analytics.emit('scene_completed', {
      scene_id: data.id,
      interaction_type: data.interaction.type,
      correct: completed,
      attempt_number: result.attempts,
      response_time_ms: result.elapsedMs,
      hint_used: result.hintsAccepted > 0,
      metadata: {
        completed,
        stars: stars,
        wrong_choices: result.wrongChoices,
        hints_offered: result.hintsOffered,
        scene_number: this.engine.sceneNumber(),
      },
    });
  }

  private async finishPage(data: StorySceneData): Promise<void> {
    const next = this.engine.advance();

    if (!next) {
      const summary = this.engine.summary();
      this.systems.analytics.emit('story_completed', {
        scene_id: data.id,
        metadata: {
          story_id: summary.storyId,
          scenes_completed: summary.scenesCompleted,
          total_scenes: summary.totalScenes,
          stars: summary.stars,
          duration_ms: summary.durationMs,
        },
      });
      this.hooks.onStoryComplete?.(summary);
    }

    await this.g(this.systems.analytics.flush().catch(() => undefined));
    await this.fadeOut();
    if (!this.alive) return;

    if (next) this.scene.restart();
    else this.scene.start(SCENE_KEYS.completion);
  }

  /* ------------------------------------------------------- hud + panels */

  /** One pip per page: filled for pages actually completed, not just visited. */
  private drawHud(): void {
    const y = this.scale.height - 32;
    const order = this.engine.sceneOrder();
    const currentIndex = this.engine.sceneNumber() - 1;

    order.forEach((sceneId, i) => {
      const here = i === currentIndex;
      const done = this.engine.isSceneCompleted(sceneId);
      const size = here || done ? 16 : 11;

      const pip = this.add
        .image(34 + i * 26, y, TEX.dot)
        .setDisplaySize(size, size)
        .setTint(here || done ? this.palette.accent : this.palette.ink)
        .setAlpha(here ? 1 : done ? 0.9 : 0.35)
        .setDepth(8800);

      if (here) {
        this.tweens.add({
          targets: pip,
          scale: pip.scale * 1.35,
          duration: 900,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      }
    });

    this.drawMuteToggle();
  }

  private drawMuteToggle(): void {
    const x = this.scale.width - 40;
    const y = this.scale.height - 36;

    const bg = this.add
      .image(x, y, TEX.dot)
      .setDisplaySize(50, 50)
      .setTint(this.palette.scrim)
      .setAlpha(0.55)
      .setDepth(8800)
      .setInteractive({ useHandCursor: true });

    const glyph = this.add
      .text(x, y - 1, this.systems.audio.isMuted() ? '✕' : '♪', {
        fontFamily: FONT.display,
        fontSize: '24px',
        color: cssColor(this.palette.ink),
      })
      .setOrigin(0.5)
      .setDepth(8801);

    bg.on('pointerup', () => {
      const next = !this.systems.audio.isMuted();
      this.systems.audio.setMuted(next);
      glyph.setText(next ? '✕' : '♪');
    });
  }

  /**
   * Honest failure state. If a story asks for a mechanic this build does not
   * have, we say which one and let the child turn the page - we never fake
   * the gameplay or silently award the stars.
   */
  private missingInteraction(type: string): Promise<InteractionResult> {
    const { width, height } = this.scale;
    const panel = this.add.container(width / 2, height * 0.55).setDepth(1200);

    const box = this.add.graphics();
    box.fillStyle(0x0e1826, 0.92);
    box.fillRoundedRect(-330, -130, 660, 260, 24);
    box.lineStyle(3, 0xff9f43, 0.7);
    box.strokeRoundedRect(-330, -130, 660, 260, 24);
    panel.add(box);

    panel.add(
      this.add
        .text(0, -80, 'This page needs a mini-game that is not loaded', {
          fontFamily: FONT.display,
          fontSize: '25px',
          color: '#ffffff',
          fontStyle: 'bold',
          align: 'center',
          wordWrap: { width: 600 },
        })
        .setOrigin(0.5),
    );
    panel.add(
      this.add
        .text(0, -20, `interaction type: "${type}"`, {
          fontFamily: FONT.display,
          fontSize: '20px',
          color: '#ffc98a',
        })
        .setOrigin(0.5),
    );

    return this.waitFor((done) => {
      const button = createBigButton(this, {
        label: 'TURN THE PAGE',
        x: 0,
        y: 62,
        width: 400,
        height: 84,
        fill: 0xff9f43,
        ink: 0x231404,
        fontSize: 30,
        onPress: () => {
          panel.destroy();
          done();
        },
      });
      panel.add(button);
    }).then(() => ({
      completed: false,
      attempts: 0,
      wrongChoices: 0,
      hintsOffered: 0,
      hintsAccepted: 0,
      elapsedMs: 0,
    }));
  }

  private showBlockingMessage(title: string, detail: string): void {
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor('#101826');
    this.add
      .text(width / 2, height / 2 - 24, title, {
        fontFamily: FONT.display,
        fontSize: '40px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    this.add
      .text(width / 2, height / 2 + 32, detail, {
        fontFamily: FONT.display,
        fontSize: '21px',
        color: '#9fb3c8',
        align: 'center',
        wordWrap: { width: width * 0.7 },
      })
      .setOrigin(0.5);
  }

  /* ------------------------------------------------------- helpers */

  private toPx(x: number, y: number): { x: number; y: number } {
    return { x: x * this.scale.width, y: y * this.scale.height };
  }

  /** Where the celebration should happen for this scene's interaction. */
  private focusPoint(data: StorySceneData): { x: number; y: number; nx: number; ny: number } {
    const it = data.interaction;
    let propId: string | null = null;
    let normalised: { x: number; y: number } | null = null;

    if (it.type === 'tap_target') propId = it.target;
    else if (it.type === 'drag_drop') normalised = { x: it.dropZone.x, y: it.dropZone.y };
    else if (it.type === 'collect_items') propId = it.targets[0] ?? null;
    else if (it.type === 'choose_object') propId = it.choices.find((c) => c.correct)?.id ?? null;
    else if (it.type === 'path_choice') {
      const path = it.paths.find((p) => p.correct);
      if (path) normalised = { x: path.x, y: path.y };
    }

    if (propId) {
      const view = this.props.get(propId);
      if (view) {
        const m = view.root.getWorldTransformMatrix();
        return {
          x: m.tx,
          y: m.ty,
          nx: m.tx / this.scale.width,
          ny: m.ty / this.scale.height,
        };
      }
    }

    const n = normalised ?? { x: 0.5, y: 0.52 };
    const px = this.toPx(n.x, n.y);
    return { x: px.x, y: px.y, nx: n.x, ny: n.y };
  }

  /** Races a promise against scene shutdown so the page flow can never leak. */
  private g<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.abortSignal]) as Promise<T>;
  }

  private waitFor(build: (done: () => void) => void): Promise<void> {
    return this.g(
      new Promise<void>((resolve) => {
        let settled = false;
        build(() => {
          if (settled) return;
          settled = true;
          resolve();
        });
      }),
    );
  }

  private delay(ms: number): Promise<void> {
    return this.waitFor((done) => {
      this.time.delayedCall(ms, done);
    });
  }

  private fadeOut(): Promise<void> {
    const c = Phaser.Display.Color.IntegerToColor(this.palette.skyBottom);
    this.cameras.main.fadeOut(520, c.red, c.green, c.blue);
    return this.waitFor((done) => {
      this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, done);
    });
  }
}

/* ------------------------------------------------------------------ */

function normalise(word: string): string {
  return word.replace(/[^\p{L}\p{N}']/gu, '').toLowerCase();
}

/**
 * Maps `scene.emphasis` phrases onto narration word indexes so multi-word
 * phrases ("three stones") emphasise as a unit.
 */
function emphasisFlags(tokens: string[], phrases: string[]): boolean[] {
  const flags = tokens.map(() => false);
  const norm = tokens.map(normalise);

  for (const phrase of phrases) {
    const parts = phrase.split(/\s+/).map(normalise).filter(Boolean);
    if (parts.length === 0) continue;

    for (let i = 0; i + parts.length <= norm.length; i += 1) {
      let hit = true;
      for (let j = 0; j < parts.length; j += 1) {
        if (norm[i + j] !== parts[j]) {
          hit = false;
          break;
        }
      }
      if (hit) {
        for (let j = 0; j < parts.length; j += 1) flags[i + j] = true;
      }
    }
  }
  return flags;
}
