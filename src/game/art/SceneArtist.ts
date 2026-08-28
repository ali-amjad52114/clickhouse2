import Phaser from 'phaser';
import type { Biome, StoryProp, TimeOfDay } from '../../shared/types';
import type { ArtContext, CharacterView, Palette, PropView, SceneArtist } from './contract';
import { hash01, mix, paletteFor } from './palettes';
import { createFox, createMimo } from './characters';
import {
  TEX, ellipsePoints, ensureArtTextures, pt, softGlow, drawProp as drawPropImpl,
} from './props';

/**
 * The procedural scene artist.
 *
 * Nothing here loads a file. A forest at dusk is: sixty gradient bands, three
 * rolling hill silhouettes, a hand-placed tree line, a wavy ground shape, two
 * particle emitters and a corner of foreground leaves - all generated at
 * runtime from the biome palette.
 *
 * Depth budget (so other lanes can slot in):
 *   -20 backdrop        10 layer 0 (far)     20 layer 1 (mid)
 *    25 ambient motes   30 layer 2 (near)    40 foreground frame
 *    80 bursts
 */

const TAU = Math.PI * 2;

type Animator = (t: number, dt: number) => void;

interface Backdrop {
  layers: [Phaser.GameObjects.Container, Phaser.GameObjects.Container, Phaser.GameObjects.Container];
  update(deltaMs: number): void;
}

/* ------------------------------------------------------------------ */
/* Backdrop pieces                                                     */
/* ------------------------------------------------------------------ */

/** A two-stop sky painted as bands - renderer independent, no harsh ramp. */
function paintSky(g: Phaser.GameObjects.Graphics, w: number, h: number, pal: Palette): void {
  const bands = 64;
  const bh = Math.ceil(h / bands) + 1;
  for (let i = 0; i < bands; i++) {
    const t = i / (bands - 1);
    g.fillStyle(mix(pal.skyTop, pal.skyBottom, Math.pow(t, 1.45)), 1);
    g.fillRect(0, (h / bands) * i - 0.5, w + 1, bh);
  }
}

/** Rolling hills: a sum of two sines sampled across the width. */
function hillPoints(w: number, h: number, baseY: number, amp: number, bumps: number, phase: number): Phaser.Geom.Point[] {
  const pts: Phaser.Geom.Point[] = [];
  const steps = 56;
  for (let i = 0; i <= steps; i++) {
    const x = (w * i) / steps;
    const u = x / w;
    const y = baseY
      - (Math.sin(u * Math.PI * bumps + phase) * 0.5 + 0.5) * amp
      - Math.sin(u * 7.4 + phase * 1.7) * amp * 0.16;
    pts.push(pt(x, y));
  }
  pts.push(pt(w, h + 4), pt(0, h + 4));
  return pts;
}

/** Jagged peaks for the mountain biome. */
function peakPoints(w: number, h: number, baseY: number, amp: number, count: number, seed: string): Phaser.Geom.Point[] {
  const pts: Phaser.Geom.Point[] = [pt(0, baseY)];
  for (let i = 0; i < count; i++) {
    const x0 = (w * i) / count, x1 = (w * (i + 1)) / count;
    const peak = amp * (0.55 + hash01(seed, i) * 0.6);
    pts.push(pt((x0 + x1) / 2, baseY - peak));
    pts.push(pt(x1, baseY - amp * 0.12 * hash01(seed, i + 40)));
  }
  pts.push(pt(w, h + 4), pt(0, h + 4));
  return pts;
}

/** A row of tiny tree silhouettes sitting on a hill crest. */
function treeLine(
  g: Phaser.GameObjects.Graphics, w: number, baseY: number, amp: number, bumps: number,
  phase: number, color: number, count: number, size: number, seed: string,
): void {
  g.fillStyle(color, 1);
  for (let i = 0; i < count; i++) {
    const u = (i + 0.5) / count;
    const x = u * w + (hash01(seed, i) - 0.5) * (w / count) * 0.6;
    const y = baseY
      - (Math.sin(u * Math.PI * bumps + phase) * 0.5 + 0.5) * amp
      - Math.sin(u * 7.4 + phase * 1.7) * amp * 0.16 + 2;
    const s = size * (0.7 + hash01(seed, i + 90) * 0.65);
    if (hash01(seed, i + 200) > 0.45) {
      g.fillPoints([pt(x - s * 0.42, y), pt(x, y - s * 1.7), pt(x + s * 0.42, y)], true);
      g.fillPoints([pt(x - s * 0.55, y - s * 0.35), pt(x, y - s * 1.3), pt(x + s * 0.55, y - s * 0.35)], true);
    } else {
      g.fillCircle(x, y - s * 0.95, s * 0.62);
      g.fillRect(x - s * 0.1, y - s, s * 0.2, s);
    }
  }
}

function grassTufts(
  g: Phaser.GameObjects.Graphics, w: number, edgeY: (x: number) => number,
  color: number, count: number, seed: string, height: number,
): void {
  g.fillStyle(color, 1);
  for (let i = 0; i < count; i++) {
    const x = hash01(seed, i) * w;
    const y = edgeY(x);
    const hh = height * (0.6 + hash01(seed, i + 11) * 0.9);
    const lean = (hash01(seed, i + 23) - 0.5) * hh * 0.7;
    g.fillPoints([pt(x - 3, y + 2), pt(x + lean, y - hh), pt(x + 3, y + 2)], true);
  }
}

/* ------------------------------------------------------------------ */

export default class ProceduralSceneArtist implements SceneArtist {
  paletteFor(biome: Biome, time: TimeOfDay): Palette {
    return paletteFor(biome, time);
  }

  drawProp(ctx: ArtContext, prop: StoryProp): PropView {
    return drawPropImpl(ctx, prop);
  }

  createFox(ctx: ArtContext): CharacterView {
    return createFox(ctx);
  }

  createMimo(ctx: ArtContext): CharacterView {
    return createMimo(ctx);
  }

  paintBackdrop(ctx: ArtContext, biome: Biome, time: TimeOfDay): Backdrop {
    const scene = ctx.scene;
    const W = ctx.width, H = ctx.height;
    const pal = ctx.palette ?? paletteFor(biome, time);
    ensureArtTextures(scene);

    const back = scene.add.container(0, 0).setDepth(-20);
    const front = scene.add.container(0, 0).setDepth(40);
    const animators: Animator[] = [];
    const isCave = biome === 'cave';
    const night = pal.dark;

    /* ---------------- sky ---------------- */
    const sky = scene.add.graphics();
    paintSky(sky, W, H, pal);
    back.add(sky);

    if (!isCave) {
      // Horizon haze: the single cheapest trick for depth.
      const haze = scene.add.graphics();
      const hazeY = H * 0.52;
      for (let i = 0; i < 22; i++) {
        const t = i / 21;
        haze.fillStyle(mix(pal.skyBottom, 0xffffff, night ? 0.05 : 0.35), (1 - t) * 0.32);
        haze.fillRect(0, hazeY + t * H * 0.16, W, H * 0.011 + 1);
      }
      back.add(haze);
    }

    /* ---------------- stars ---------------- */
    if (night) {
      const stars = scene.add.graphics();
      const count = biome === 'night_sky' ? 190 : 110;
      for (let i = 0; i < count; i++) {
        const x = hash01('st', i * 3 + 1) * W;
        const y = hash01('st', i * 3 + 2) * H * (isCave ? 0.0 : 0.7);
        const r = 0.6 + hash01('st', i * 3 + 3) * 1.9;
        stars.fillStyle(0xffffff, 0.28 + hash01('st', i * 7) * 0.62);
        stars.fillCircle(x, y, r);
      }
      back.add(stars);

      if (biome === 'night_sky') {
        const band = softGlow(scene, W * 0.55, 0xbcd0ff, 0.11);
        band.setPosition(W * 0.45, H * 0.26).setScale(1.45, 0.3).setRotation(-0.22);
        back.add(band);
      }

      for (let i = 0; i < 9; i++) {
        const s = scene.add.image(
          hash01('tw', i * 5 + 1) * W, hash01('tw', i * 5 + 2) * H * 0.55, TEX.spark,
        ).setTint(0xffffff).setBlendMode(Phaser.BlendModes.ADD).setScale(0.14).setAlpha(0.5);
        back.add(s);
        scene.tweens.add({
          targets: s, alpha: { from: 0.15, to: 1 }, scale: { from: 0.07, to: 0.24 },
          duration: 1100 + hash01('tw', i) * 1600, yoyo: true, repeat: -1,
          ease: 'Sine.easeInOut', delay: hash01('tw', i + 50) * 2400,
        });
      }

      if (biome === 'night_sky') {
        scene.time.addEvent({
          delay: 5200, loop: true, callback: () => {
            const shot = scene.add.image(W * (0.1 + Math.random() * 0.5), H * 0.1, TEX.soft)
              .setTint(0xffffff).setBlendMode(Phaser.BlendModes.ADD)
              .setDisplaySize(120, 5).setRotation(0.42).setAlpha(0);
            back.add(shot);
            scene.tweens.add({
              targets: shot, x: shot.x + W * 0.34, y: shot.y + H * 0.24,
              alpha: { from: 0.95, to: 0 }, duration: 950, ease: 'Sine.easeIn',
              onComplete: () => shot.destroy(),
            });
          },
        });
      }
    }

    /* ---------------- sun / moon ---------------- */
    if (!isCave && biome !== 'night_sky') {
      const cx = time === 'dawn' ? W * 0.22 : W * 0.78;
      const cy = time === 'day' ? H * 0.15 : H * 0.24;
      const glow = softGlow(scene, night ? 130 : 190, pal.sun, night ? 0.4 : 0.55);
      glow.setPosition(cx, cy);
      const disc = scene.add.graphics();
      disc.fillStyle(mix(pal.sun, 0xffffff, 0.35), 1);
      disc.fillCircle(cx, cy, night ? 34 : 44);
      if (night) {
        disc.fillStyle(mix(pal.sun, 0x9a8e6a, 0.22), 0.7);
        disc.fillCircle(cx - 10, cy - 8, 7);
        disc.fillCircle(cx + 9, cy + 6, 9);
      }
      back.add([glow, disc]);
      const glowBase = night ? 0.4 : 0.55;
      animators.push((t) => {
        glow.setScale(1 + Math.sin(t * 0.6) * 0.06);
        glow.setAlpha(glowBase + Math.sin(t * 0.9) * 0.07);
      });

      if (time === 'dawn' || time === 'dusk') {
        const rays = scene.add.graphics();
        rays.fillStyle(mix(pal.sun, 0xffffff, 0.3), 0.075);
        for (let i = -2; i <= 2; i++) {
          const a = 1.25 + i * 0.16;
          rays.fillPoints([
            pt(cx, cy), pt(cx + Math.cos(a - 0.05) * H, cy + Math.sin(a - 0.05) * H),
            pt(cx + Math.cos(a + 0.05) * H, cy + Math.sin(a + 0.05) * H),
          ], true);
        }
        rays.setBlendMode(Phaser.BlendModes.ADD);
        back.add(rays);
        animators.push((t) => { rays.setAlpha(0.7 + Math.sin(t * 0.5) * 0.3); });
      }
    }

    /* ---------------- drifting clouds ---------------- */
    if (!isCave && !night) {
      for (let i = 0; i < 5; i++) {
        const c = scene.add.container(hash01('cl', i) * W, H * (0.08 + hash01('cl', i + 30) * 0.22));
        const g = scene.add.graphics();
        const tone = mix(0xffffff, pal.skyBottom, 0.12);
        const s = 0.55 + hash01('cl', i + 60) * 0.7;
        g.fillStyle(mix(tone, pal.skyTop, 0.18), 0.9);
        g.fillCircle(-30 * s, 8 * s, 22 * s);
        g.fillCircle(10 * s, 10 * s, 26 * s);
        g.fillStyle(tone, 0.95);
        g.fillCircle(-34 * s, 0, 20 * s);
        g.fillCircle(-6 * s, -10 * s, 27 * s);
        g.fillCircle(26 * s, 2 * s, 21 * s);
        g.fillRoundedRect(-46 * s, -2 * s, 78 * s, 16 * s, 8 * s);
        c.add(g);
        c.setAlpha(0.55 + hash01('cl', i + 90) * 0.35);
        back.add(c);
        const speed = 5 + hash01('cl', i + 120) * 9;
        animators.push((_t, dt) => {
          c.x += speed * dt;
          if (c.x > W + 130) c.x = -130;
        });
      }
    }

    /* ---------------- terrain ---------------- */
    const groundY = biome === 'river' ? H * 0.86 : isCave ? H * 0.80 : H * 0.78;

    if (isCave) {
      this.paintCave(scene, back, W, H, pal, animators);
    } else {
      const far = scene.add.graphics();
      const mid = scene.add.graphics();
      const near = scene.add.graphics();
      back.add([far, mid, near]);

      if (biome === 'mountain') {
        far.fillStyle(pal.hillFar, 1);
        far.fillPoints(peakPoints(W, H, H * 0.56, H * 0.30, 4, 'pk1'), true);
        far.fillStyle(mix(pal.hillFar, 0xffffff, 0.5), 1);
        far.fillPoints([pt(W * 0.26, H * 0.30), pt(W * 0.33, H * 0.38), pt(W * 0.19, H * 0.38)], true);
        mid.fillStyle(pal.hillMid, 1);
        mid.fillPoints(peakPoints(W, H, H * 0.66, H * 0.22, 5, 'pk2'), true);
      } else {
        far.fillStyle(pal.hillFar, 1);
        far.fillPoints(hillPoints(W, H, H * 0.60, H * 0.10, 2.2, 0.4), true);
        mid.fillStyle(pal.hillMid, 1);
        mid.fillPoints(hillPoints(W, H, H * 0.68, H * 0.085, 3.1, 2.1), true);
      }

      if (biome === 'enchanted_forest' || biome === 'meadow' || biome === 'village' || biome === 'night_sky') {
        treeLine(far, W, H * 0.60, H * 0.10, 2.2, 0.4, mix(pal.hillFar, pal.foliageDark, 0.55), 18, H * 0.036, 'tl1');
        treeLine(mid, W, H * 0.68, H * 0.085, 3.1, 2.1, mix(pal.hillMid, pal.foliageDark, 0.62), 14, H * 0.05, 'tl2');
      }

      near.fillStyle(pal.hillNear, 1);
      near.fillPoints(hillPoints(W, H, H * 0.745, H * 0.05, 2.6, 4.2), true);

      if (biome === 'river') {
        this.paintRiver(scene, back, W, H, pal, animators);
      }

      /* main ground shelf */
      const ground = scene.add.graphics();
      back.add(ground);
      const edgeY = (x: number): number => groundY - Math.sin((x / W) * 6.1 + 1.2) * H * 0.012 - Math.sin((x / W) * 2.3) * H * 0.008;
      const gpts: Phaser.Geom.Point[] = [];
      for (let i = 0; i <= 60; i++) {
        const x = (W * i) / 60;
        gpts.push(pt(x, edgeY(x)));
      }
      ground.fillStyle(pal.groundShadow, 1);
      ground.fillPoints([...gpts.map((p) => pt(p.x, p.y + 6)), pt(W, H + 4), pt(0, H + 4)], true);
      ground.fillStyle(pal.ground, 1);
      ground.fillPoints([...gpts, pt(W, H + 4), pt(0, H + 4)], true);
      ground.fillStyle(mix(pal.ground, 0xffffff, 0.22), 0.85);
      ground.fillPoints([...gpts, ...gpts.slice().reverse().map((p) => pt(p.x, p.y + 7))], true);
      grassTufts(ground, W, edgeY, mix(pal.foliageMid, pal.ground, 0.3), 46, 'gt1', H * 0.028);
      grassTufts(ground, W, (x) => edgeY(x) + H * 0.06, mix(pal.foliageDark, pal.ground, 0.45), 26, 'gt2', H * 0.022);
      ground.fillStyle(pal.groundShadow, 0.5);
      for (let i = 0; i < 14; i++) {
        const x = hash01('pb', i) * W;
        ground.fillEllipse(x, edgeY(x) + H * (0.03 + hash01('pb', i + 9) * 0.16), 12 + hash01('pb', i + 3) * 16, 6);
      }
    }

    /* ---------------- ambient particles ---------------- */
    this.paintAmbience(scene, biome, W, H, pal, groundY);

    /* ---------------- vignette ---------------- */
    const vig = scene.add.graphics().setDepth(38);
    const vTop = mix(pal.skyTop, 0x000000, 0.55);
    const vBot = mix(pal.groundShadow, 0x000000, 0.55);
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      vig.fillStyle(vTop, (1 - t) * (isCave ? 0.34 : 0.13));
      vig.fillRect(0, t * H * 0.14 - 1, W, H * 0.011 + 1);
      vig.fillStyle(vBot, (1 - t) * (isCave ? 0.36 : 0.16));
      vig.fillRect(0, H - t * H * 0.16, W, H * 0.012 + 1);
      vig.fillStyle(vTop, (1 - t) * (isCave ? 0.3 : 0.10));
      vig.fillRect(t * W * 0.1 - 1, 0, W * 0.008 + 1, H);
      vig.fillRect(W - t * W * 0.1, 0, W * 0.008 + 1, H);
    }

    /* ---------------- foreground frame ---------------- */
    if (biome !== 'mountain') {
      const frameColor = mix(pal.foliageDark, 0x000000, night ? 0.45 : 0.3);
      for (const side of [-1, 1] as const) {
        const c = scene.add.container(side < 0 ? 0 : W, H);
        const g = scene.add.graphics();
        g.fillStyle(frameColor, 0.92);
        for (let i = 0; i < 5; i++) {
          const r = H * (0.075 + hash01('fg', i + (side > 0 ? 20 : 0)) * 0.075);
          g.fillCircle(side * (10 + i * H * 0.075), -(H * 0.02) - hash01('fg', i + 40) * H * 0.075, r);
        }
        g.fillStyle(mix(frameColor, pal.foliageMid, 0.25), 0.9);
        g.fillPoints(ellipsePoints(side * H * 0.08, -H * 0.14, H * 0.055, H * 0.026, side * -0.5, 20), true);
        c.add(g);
        front.add(c);
        scene.tweens.add({
          targets: c, rotation: { from: -0.014 * side, to: 0.014 * side },
          duration: 4200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        });
      }
    }

    /* ---------------- parallax layers ---------------- */
    const l0 = scene.add.container(0, 0).setDepth(10);
    const l1 = scene.add.container(0, 0).setDepth(20);
    const l2 = scene.add.container(0, 0).setDepth(30);

    let elapsed = 0;
    return {
      layers: [l0, l1, l2],
      update(deltaMs: number) {
        const dt = Math.min(deltaMs, 80) / 1000;
        elapsed += dt;
        for (const a of animators) a(elapsed, dt);
      },
    };
  }

  /* ---------------------------------------------------------------- */

  private paintRiver(
    scene: Phaser.Scene, back: Phaser.GameObjects.Container,
    W: number, H: number, pal: Palette, animators: Animator[],
  ): void {
    const top = H * 0.60, bottom = H * 0.88;
    const water = scene.add.graphics();
    back.add(water);

    water.fillStyle(mix(pal.water, pal.skyBottom, 0.35), 1);
    water.fillRect(0, top, W, bottom - top);
    for (let i = 0; i < 26; i++) {
      const t = i / 25;
      water.fillStyle(mix(pal.water, mix(pal.water, 0x000000, 0.25), t), 1);
      water.fillRect(0, top + t * (bottom - top), W, (bottom - top) / 26 + 1);
    }
    water.fillStyle(mix(pal.waterHighlight, pal.water, 0.35), 0.5);
    water.fillRect(0, top, W, H * 0.014);

    const waves: Phaser.GameObjects.Graphics[] = [];
    for (let row = 0; row < 7; row++) {
      const g = scene.add.graphics();
      const y = top + (bottom - top) * (0.12 + row * 0.13);
      const alpha = 0.55 - row * 0.045;
      g.fillStyle(pal.waterHighlight, alpha);
      for (let i = 0; i < 9; i++) {
        const x = hash01('wv', row * 20 + i) * W;
        const len = 26 + hash01('wv', row * 20 + i + 7) * 66;
        g.fillRoundedRect(x, y, len, 4 + row * 0.4, 3);
      }
      back.add(g);
      waves.push(g);
      animators.push((t) => {
        g.x = Math.sin(t * (0.32 + row * 0.07) + row) * (14 + row * 5);
        g.y = Math.sin(t * 0.9 + row * 1.3) * 2.2;
        g.setAlpha(0.6 + Math.sin(t * 1.4 + row) * 0.32);
      });
    }

    const shine = softGlow(scene, W * 0.34, pal.waterHighlight, 0.16);
    shine.setPosition(W * 0.5, (top + bottom) / 2).setScale(1.5, 0.3);
    back.add(shine);
    animators.push((t) => { shine.setAlpha(0.12 + Math.sin(t * 0.7) * 0.06); });

    scene.add.particles(0, 0, TEX.spark, {
      x: { min: 0, max: W },
      y: { min: top + 6, max: bottom - 6 },
      lifespan: 1500,
      scale: { start: 0.22, end: 0 },
      alpha: { start: 1, end: 0 },
      quantity: 1,
      frequency: 130,
      tint: [0xffffff, pal.waterHighlight],
      blendMode: 'ADD',
    }).setDepth(24);
  }

  private paintCave(
    scene: Phaser.Scene, back: Phaser.GameObjects.Container,
    W: number, H: number, pal: Palette, animators: Animator[],
  ): void {
    const deep = softGlow(scene, W * 0.34, mix(pal.accent, 0xffffff, 0.2), 0.13);
    deep.setPosition(W * 0.5, H * 0.52).setScale(1.4, 1.05);
    back.add(deep);
    animators.push((t) => { deep.setAlpha(0.10 + Math.sin(t * 0.5) * 0.035); });

    const ceilY = (x: number): number => H * 0.24 - Math.sin((x / W) * Math.PI) * H * 0.13 + Math.sin((x / W) * 9) * H * 0.014;
    const ceiling = scene.add.graphics();
    const cpts: Phaser.Geom.Point[] = [];
    for (let i = 0; i <= 48; i++) {
      const x = (W * i) / 48;
      cpts.push(pt(x, ceilY(x)));
    }
    ceiling.fillStyle(mix(pal.hillFar, 0x000000, 0.25), 1);
    ceiling.fillPoints([pt(0, -4), ...cpts, pt(W, -4)], true);
    ceiling.fillStyle(mix(pal.hillMid, 0x000000, 0.1), 1);
    ceiling.fillPoints([pt(0, -4), ...cpts.map((p) => pt(p.x, p.y - 8)), pt(W, -4)], true);
    // stalactites
    ceiling.fillStyle(mix(pal.hillFar, 0x000000, 0.2), 1);
    for (let i = 0; i < 13; i++) {
      const x = (i + 0.5) * (W / 13) + (hash01('sc', i) - 0.5) * 22;
      const y = ceilY(x);
      const len = H * (0.03 + hash01('sc', i + 30) * 0.075);
      const wdt = 9 + hash01('sc', i + 60) * 13;
      ceiling.fillPoints([pt(x - wdt, y - 4), pt(x + wdt, y - 4), pt(x + wdt * 0.2, y + len)], true);
    }
    back.add(ceiling);

    const walls = scene.add.graphics();
    for (const side of [-1, 1] as const) {
      const baseX = side < 0 ? 0 : W;
      const pts: Phaser.Geom.Point[] = [pt(baseX, 0)];
      for (let i = 0; i <= 12; i++) {
        const y = (H * i) / 12;
        const inset = W * (0.05 + Math.sin(i * 0.9 + (side < 0 ? 0 : 1.7)) * 0.022 + (i / 12) * 0.045);
        pts.push(pt(baseX + side * inset, y));
      }
      pts.push(pt(baseX, H));
      walls.fillStyle(mix(pal.hillNear, 0x000000, 0.28), 1);
      walls.fillPoints(pts, true);
      walls.fillStyle(mix(pal.hillNear, pal.accent, 0.08), 1);
      walls.fillPoints(pts.map((p) => pt(p.x - side * 7, p.y)), true);
    }
    back.add(walls);

    // wall crystals
    const crystalSpots: [number, number, number][] = [
      [0.11, 0.44, 1], [0.07, 0.66, 0.7], [0.9, 0.4, 0.9], [0.94, 0.62, 0.72],
      [0.22, 0.26, 0.6], [0.78, 0.24, 0.66],
    ];
    for (let i = 0; i < crystalSpots.length; i++) {
      const [ux, uy, s] = crystalSpots[i];
      const x = ux * W, y = uy * H;
      const tint = i % 2 === 0 ? pal.accent : mix(pal.accent, 0xc79bff, 0.6);
      const glow = softGlow(scene, 62 * s, tint, 0.45);
      glow.setPosition(x, y);
      const g = scene.add.graphics();
      const h = 34 * s, w2 = 10 * s;
      g.fillStyle(mix(tint, 0x1b1035, 0.45), 1);
      g.fillPoints([pt(x - w2, y + 6), pt(x, y - h), pt(x + w2, y + 6), pt(x, y + 12)], true);
      g.fillStyle(tint, 1);
      g.fillPoints([pt(x - w2 * 0.7, y + 4), pt(x, y - h * 0.94), pt(x + w2 * 0.6, y + 4), pt(x, y + 9)], true);
      g.fillStyle(mix(tint, 0xffffff, 0.55), 0.9);
      g.fillPoints([pt(x - w2 * 0.24, y + 2), pt(x, y - h * 0.9), pt(x + w2 * 0.1, y + 2)], true);
      back.add([glow, g]);
      animators.push((t) => {
        glow.setAlpha(0.3 + Math.sin(t * (0.8 + i * 0.17) + i) * 0.22);
        glow.setScale(1 + Math.sin(t * 0.7 + i) * 0.07);
      });
    }

    // light shaft from a crack in the ceiling
    const shaft = scene.add.graphics();
    shaft.fillStyle(mix(pal.accent, 0xffffff, 0.55), 0.075);
    shaft.fillPoints([pt(W * 0.34, H * 0.06), pt(W * 0.44, H * 0.06), pt(W * 0.68, H * 0.92), pt(W * 0.4, H * 0.92)], true);
    shaft.setBlendMode(Phaser.BlendModes.ADD);
    back.add(shaft);
    animators.push((t) => { shaft.setAlpha(0.55 + Math.sin(t * 0.42) * 0.45); });

    // floor
    const floorY = (x: number): number => H * 0.80 + Math.sin((x / W) * 5.4) * H * 0.018;
    const floor = scene.add.graphics();
    const fpts: Phaser.Geom.Point[] = [];
    for (let i = 0; i <= 48; i++) {
      const x = (W * i) / 48;
      fpts.push(pt(x, floorY(x)));
    }
    floor.fillStyle(mix(pal.groundShadow, 0x000000, 0.2), 1);
    floor.fillPoints([...fpts.map((p) => pt(p.x, p.y - 5)), pt(W, H + 4), pt(0, H + 4)], true);
    floor.fillStyle(pal.ground, 1);
    floor.fillPoints([...fpts, pt(W, H + 4), pt(0, H + 4)], true);
    floor.fillStyle(mix(pal.ground, pal.accent, 0.16), 0.6);
    floor.fillPoints([...fpts, ...fpts.slice().reverse().map((p) => pt(p.x, p.y + 6))], true);
    floor.fillStyle(mix(pal.groundShadow, 0x000000, 0.25), 0.8);
    for (let i = 0; i < 18; i++) {
      const x = hash01('rb', i) * W;
      const y = floorY(x) + H * (0.02 + hash01('rb', i + 20) * 0.15);
      floor.fillPoints(ellipsePoints(x, y, 9 + hash01('rb', i + 5) * 15, 5 + hash01('rb', i + 8) * 5, 0, 12), true);
    }
    back.add(floor);
  }

  private paintAmbience(
    scene: Phaser.Scene, biome: Biome, W: number, H: number, pal: Palette, groundY: number,
  ): void {
    const moteTint = biome === 'cave'
      ? [pal.accent, 0xffffff]
      : pal.dark ? [0xfff3a3, 0xffffff, pal.accent] : [0xffffff, pal.accent, mix(pal.foliageLight, 0xffffff, 0.5)];

    scene.add.particles(0, 0, TEX.soft, {
      x: { min: -20, max: W + 20 },
      y: { min: H * 0.18, max: groundY + H * 0.1 },
      lifespan: { min: 5200, max: 9000 },
      speedX: { min: -12, max: 12 },
      speedY: biome === 'cave' ? { min: -22, max: -8 } : { min: -9, max: 4 },
      scale: { start: 0.16, end: 0.04 },
      alpha: { start: 0.75, end: 0 },
      quantity: 1,
      frequency: 220,
      tint: moteTint,
      blendMode: 'ADD',
    }).setDepth(25);

    if (biome === 'enchanted_forest' || biome === 'meadow' || biome === 'village') {
      scene.add.particles(0, 0, biome === 'meadow' ? TEX.petal : TEX.leaf, {
        x: { min: 0, max: W },
        y: -20,
        lifespan: 9500,
        speedX: { min: -26, max: 14 },
        speedY: { min: 14, max: 34 },
        rotate: { min: -180, max: 180 },
        scale: { min: 0.4, max: 0.85 },
        alpha: { start: 0.9, end: 0.25 },
        quantity: 1,
        frequency: 1500,
        tint: biome === 'meadow'
          ? [0xff8fc7, 0xffd166, 0xffffff]
          : [mix(pal.foliageLight, 0xffcb6b, 0.5), pal.foliageMid, mix(pal.foliageDark, 0xffa94d, 0.4)],
      }).setDepth(35);
    }

    if (pal.dark && biome !== 'cave') {
      scene.add.particles(0, 0, TEX.spark, {
        x: { min: 0, max: W },
        y: { min: H * 0.3, max: groundY },
        lifespan: 2400,
        scale: { start: 0.24, end: 0 },
        alpha: { start: 1, end: 0 },
        speedY: { min: -14, max: -2 },
        quantity: 1,
        frequency: 420,
        tint: [0xfff3a3, 0xffffff],
        blendMode: 'ADD',
      }).setDepth(26);
    }
  }

  /* ---------------------------------------------------------------- */

  burst(ctx: ArtContext, x: number, y: number, opts?: { count?: number; color?: number }): void {
    const scene = ctx.scene;
    ensureArtTextures(scene);
    const px = x * ctx.width, py = y * ctx.height;
    const count = opts?.count ?? 28;
    const base = opts?.color;
    const tints = base !== undefined
      ? [base, mix(base, 0xffffff, 0.5), mix(base, 0xffffff, 0.85)]
      : [ctx.palette.accent, 0xffe66d, 0xffffff, 0x7ef0d8, 0xff8fc7, 0x8ecbff];

    const stars = scene.add.particles(px, py, TEX.star5, {
      speed: { min: 130, max: 380 },
      angle: { min: 0, max: 360 },
      gravityY: 320,
      lifespan: { min: 650, max: 1250 },
      scale: { start: 0.62, end: 0 },
      alpha: { start: 1, end: 0.1 },
      rotate: { start: 0, end: 320 },
      tint: tints,
      blendMode: 'ADD',
      emitting: false,
    }).setDepth(80);
    stars.explode(count);

    const confetti = scene.add.particles(px, py, TEX.confetti, {
      speed: { min: 90, max: 300 },
      angle: { min: 190, max: 350 },
      gravityY: 420,
      lifespan: { min: 900, max: 1600 },
      scale: { min: 0.6, max: 1.15 },
      alpha: { start: 1, end: 0.6 },
      rotate: { min: -260, max: 260 },
      tint: tints,
      emitting: false,
    }).setDepth(80);
    confetti.explode(Math.round(count * 0.7));

    const ring = scene.add.image(px, py, TEX.soft)
      .setTint(base ?? ctx.palette.accent)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(90, 90)
      .setDepth(79);
    scene.tweens.add({
      targets: ring,
      scale: { from: ring.scale * 0.4, to: ring.scale * 2.6 },
      alpha: { from: 0.85, to: 0 },
      duration: 620, ease: 'Cubic.easeOut',
      onComplete: () => ring.destroy(),
    });

    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + Math.random();
      const s = scene.add.image(px, py, TEX.spark)
        .setTint(0xffffff).setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.1).setDepth(81);
      scene.tweens.add({
        targets: s,
        x: px + Math.cos(a) * 96, y: py + Math.sin(a) * 96,
        scale: { from: 0.5, to: 0 }, alpha: { from: 1, to: 0 }, angle: 180,
        duration: 700, delay: i * 40, ease: 'Cubic.easeOut',
        onComplete: () => s.destroy(),
      });
    }

    scene.time.delayedCall(1800, () => { stars.destroy(); confetti.destroy(); });
  }
}

/** Convenience for lanes that just want a ready artist. */
export const sceneArtist = new ProceduralSceneArtist();
