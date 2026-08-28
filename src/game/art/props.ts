import Phaser from 'phaser';
import type { PropKind, StoryProp } from '../../shared/types';
import type { ArtContext, Palette, PropView } from './contract';
import { DESIGN_HEIGHT, MIN_TOUCH_RADIUS } from './contract';
import { hash01, layerHaze, mix, paletteForLayer, parseHex } from './palettes';

/**
 * Every prop in the game, drawn from primitives. No image assets exist in this
 * project, so a "tree" is a trunk polygon plus five overlapping circles in
 * three tones of green - flat-vector storybook, not photoreal.
 *
 * Layout convention:
 *   Ground-standing props (tree, bush, rock, reed...) are drawn with their
 *   BASE at local (0,0) and grow upward into negative y, so they sway from
 *   the root like a real plant.
 *   Airborne props (star, butterfly, cloud, moon...) are centred on (0,0).
 */

/* ------------------------------------------------------------------ */
/* Small geometry + drawing helpers, shared with the artist            */
/* ------------------------------------------------------------------ */

export type Pt = Phaser.Geom.Point;
export const pt = (x: number, y: number): Pt => new Phaser.Geom.Point(x, y);

const TAU = Math.PI * 2;

/** Points around an ellipse. Angles in radians, optional rotation. */
export function ellipsePoints(
  cx: number, cy: number, rx: number, ry: number,
  rot = 0, steps = 24, a0 = 0, a1 = TAU,
): Pt[] {
  const out: Pt[] = [];
  const cos = Math.cos(rot), sin = Math.sin(rot);
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
    out.push(pt(cx + x * cos - y * sin, cy + x * sin + y * cos));
  }
  return out;
}

/** Classic n-pointed star. */
export function starPoints(cx: number, cy: number, outer: number, inner: number, points = 5, rot = -Math.PI / 2): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rot + (i * Math.PI) / points;
    out.push(pt(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return out;
}

/** Quadratic bezier sampled to points - used for stems, ropes, tails. */
export function curvePoints(
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, steps = 16,
): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push(pt(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1));
  }
  return out;
}

/** A tapered blade/stalk: a curve out and back with a shrinking width. */
export function bladePoints(
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number,
  wBase: number, steps = 14,
): Pt[] {
  const spine = curvePoints(x0, y0, cx, cy, x1, y1, steps);
  const left: Pt[] = [], right: Pt[] = [];
  for (let i = 0; i < spine.length; i++) {
    const t = i / (spine.length - 1);
    const w = (wBase / 2) * (1 - t) ** 0.85;
    const p = spine[i];
    const n = spine[Math.min(i + 1, spine.length - 1)];
    const dx = n.x - p.x, dy = n.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    left.push(pt(p.x + nx * w, p.y + ny * w));
    right.push(pt(p.x - nx * w, p.y - ny * w));
  }
  return left.concat(right.reverse());
}

/** Soft contact shadow on the ground beneath a prop. */
export function contactShadow(g: Phaser.GameObjects.Graphics, w: number, alpha = 0.14): void {
  g.fillStyle(0x000000, alpha);
  g.fillEllipse(0, 0, w, w * 0.26);
}

/* ------------------------------------------------------------------ */
/* Generated textures - anything we repeat hundreds of times           */
/* ------------------------------------------------------------------ */

export const TEX = {
  soft: 'mimoart_soft',
  spark: 'mimoart_spark',
  star5: 'mimoart_star5',
  dot: 'mimoart_dot',
  confetti: 'mimoart_confetti',
  leaf: 'mimoart_leaf',
  petal: 'mimoart_petal',
} as const;

export function ensureArtTextures(scene: Phaser.Scene): void {
  const t = scene.textures;

  if (!t.exists(TEX.soft)) {
    const canvas = t.createCanvas(TEX.soft, 128, 128);
    if (canvas) {
      const c = canvas.getContext();
      const grd = c.createRadialGradient(64, 64, 0, 64, 64, 64);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.28, 'rgba(255,255,255,0.62)');
      grd.addColorStop(0.62, 'rgba(255,255,255,0.18)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = grd;
      c.fillRect(0, 0, 128, 128);
      canvas.refresh();
    }
  }

  if (!t.exists(TEX.spark)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    g.fillPoints(starPoints(32, 32, 32, 4.5, 4, -Math.PI / 2), true);
    g.generateTexture(TEX.spark, 64, 64);
    g.destroy();
  }

  if (!t.exists(TEX.star5)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    g.fillPoints(starPoints(24, 25, 23, 10, 5), true);
    g.generateTexture(TEX.star5, 48, 48);
    g.destroy();
  }

  if (!t.exists(TEX.dot)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(16, 16, 15);
    g.generateTexture(TEX.dot, 32, 32);
    g.destroy();
  }

  if (!t.exists(TEX.confetti)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(0, 0, 16, 9, 3);
    g.generateTexture(TEX.confetti, 16, 9);
    g.destroy();
  }

  if (!t.exists(TEX.leaf)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    g.fillPoints(ellipsePoints(14, 10, 13, 6.5, 0.5, 20), true);
    g.generateTexture(TEX.leaf, 28, 20);
    g.destroy();
  }

  if (!t.exists(TEX.petal)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    g.fillPoints(ellipsePoints(9, 12, 7, 11.5, 0, 20), true);
    g.generateTexture(TEX.petal, 18, 24);
    g.destroy();
  }
}

/**
 * A soft additive halo, wrapped in a container so `scale` stays relative:
 * tweening the returned object from 0.9 to 1.2 pulses the glow instead of
 * resetting it to the raw 128px texture size.
 */
export function softGlow(
  scene: Phaser.Scene, radius: number, color: number, alpha = 0.5,
): Phaser.GameObjects.Container {
  ensureArtTextures(scene);
  const img = scene.add.image(0, 0, TEX.soft)
    .setDisplaySize(radius * 2, radius * 2)
    .setTint(color)
    .setBlendMode(Phaser.BlendModes.ADD);
  return scene.add.container(0, 0, [img]).setAlpha(alpha);
}

/* ------------------------------------------------------------------ */
/* Tween plumbing                                                      */
/* ------------------------------------------------------------------ */

/** Resolves when the tween finishes OR is stopped, so awaits never hang. */
export function tweenPromise(
  scene: Phaser.Scene,
  config: Phaser.Types.Tweens.TweenBuilderConfig,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    scene.tweens.add({ ...config, onComplete: done, onStop: done });
  });
}

export function wait(scene: Phaser.Scene, ms: number): Promise<void> {
  return new Promise<void>((resolve) => { scene.time.delayedCall(ms, resolve); });
}

/** Kill a container's tweens when it dies - counter tweens outlive targets. */
export function bindLifetime(
  root: Phaser.GameObjects.Container,
  tweens: (Phaser.Tweens.Tween | undefined)[],
): void {
  root.once(Phaser.GameObjects.Events.DESTROY, () => {
    for (const t of tweens) t?.remove();
    tweens.length = 0;
  });
}

/* ------------------------------------------------------------------ */
/* Prop drawing                                                        */
/* ------------------------------------------------------------------ */

interface Dc {
  scene: Phaser.Scene;
  body: Phaser.GameObjects.Container;
  pal: Palette;
  color: number;
  prop: StoryProp;
  /** Stable pseudo-random 0..1 keyed on the prop id: random but never flickers. */
  r(i: number): number;
  keep(t: Phaser.Tweens.Tween): void;
}

interface PropDrawing {
  /** Natural (pre-scale) radius of the drawn silhouette. */
  radius: number;
  startIdle(): void;
}

type Drawer = (d: Dc) => PropDrawing;

function sway(d: Dc, amp: number, duration: number): void {
  d.keep(d.scene.tweens.add({
    targets: d.body,
    rotation: { from: -amp, to: amp },
    duration,
    yoyo: true,
    repeat: -1,
    delay: d.r(7) * duration,
    ease: 'Sine.easeInOut',
  }));
}

function bob(d: Dc, amp: number, duration: number): void {
  d.keep(d.scene.tweens.add({
    targets: d.body,
    y: { from: -amp, to: amp },
    duration,
    yoyo: true,
    repeat: -1,
    delay: d.r(3) * duration,
    ease: 'Sine.easeInOut',
  }));
}

/* -------------------------- flora --------------------------------- */

const drawTree: Drawer = (d) => {
  const g = d.scene.add.graphics();
  d.body.add(g);
  const dark = mix(d.color, 0x0a2a1c, 0.34);
  const mid = d.color;
  const light = mix(d.color, 0xfff3b0, 0.30);
  const trunk = d.pal.trunk;

  contactShadow(g, 104, 0.13);

  g.fillStyle(mix(trunk, 0x000000, 0.22), 1);
  g.fillPoints([pt(-19, 2), pt(-12, -50), pt(-9, -104), pt(10, -104), pt(13, -50), pt(20, 2)], true);
  g.fillStyle(trunk, 1);
  g.fillPoints([pt(-13, 2), pt(-8, -50), pt(-6, -104), pt(8, -104), pt(10, -50), pt(15, 2)], true);
  g.fillStyle(mix(trunk, 0xffffff, 0.18), 1);
  g.fillPoints([pt(-13, 2), pt(-8, -50), pt(-6, -104), pt(-1, -104), pt(-3, -50), pt(-6, 2)], true);

  const blobs: [number, number, number][] = [
    [-42, -122, 44], [40, -128, 42], [-8, -108, 46], [22, -104, 38], [-2, -164, 50], [-30, -150, 38], [26, -152, 36],
  ];
  g.fillStyle(dark, 1);
  for (const [x, y, r] of blobs) g.fillCircle(x + 5, y + 7, r);
  g.fillStyle(mid, 1);
  for (const [x, y, r] of blobs) g.fillCircle(x, y, r);
  g.fillStyle(light, 1);
  g.fillCircle(-24, -172, 24);
  g.fillCircle(-46, -136, 18);
  g.fillCircle(6, -180, 15);
  g.fillStyle(mix(light, 0xffffff, 0.4), 0.85);
  g.fillCircle(-30, -180, 8);

  return {
    radius: 62,
    startIdle: () => sway(d, 0.022, 2600 + d.r(1) * 900),
  };
};

const drawPine: Drawer = (d) => {
  const g = d.scene.add.graphics();
  d.body.add(g);
  const dark = mix(d.color, 0x06231a, 0.36);
  const light = mix(d.color, 0xd8f5c0, 0.26);

  contactShadow(g, 88, 0.13);

  g.fillStyle(mix(d.pal.trunk, 0x000000, 0.28), 1);
  g.fillRoundedRect(-8, -60, 16, 62, 5);

  const tiers: [number, number, number][] = [[-42, 54, 70], [-96, 44, 58], [-142, 33, 44]];
  tiers.forEach(([y, half, h], i) => {
    const skirt: Pt[] = [pt(0, y - h)];
    const notches = 5;
    for (let s = 0; s <= notches; s++) {
      const t = s / notches;
      const x = -half + half * 2 * t;
      const dip = s % 2 === 0 ? 0 : 9;
      skirt.push(pt(x, y + dip - (Math.abs(x) / half) * 6));
    }
    g.fillStyle(dark, 1);
    g.fillPoints([pt(4, y - h + 6), ...skirt.slice(1).map((p) => pt(p.x + 4, p.y + 6))], true);
    g.fillStyle(i === 2 ? light : mix(d.color, 0xffffff, i * 0.06), 1);
    g.fillPoints(skirt, true);
    g.fillStyle(light, 0.55);
    g.fillPoints([pt(0, y - h), pt(-half * 0.55, y + 2), pt(-half * 0.12, y - 2)], true);
  });

  return {
    radius: 56,
    startIdle: () => sway(d, 0.018, 3000 + d.r(2) * 900),
  };
};

const drawBush: Drawer = (d) => {
  const g = d.scene.add.graphics();
  d.body.add(g);
  const dark = mix(d.color, 0x0a2a1c, 0.32);
  const light = mix(d.color, 0xfff3b0, 0.28);

  contactShadow(g, 96, 0.15);

  const blobs: [number, number, number][] = [[-30, -22, 30], [30, -26, 28], [0, -38, 34], [-14, -16, 26], [16, -14, 24]];
  g.fillStyle(dark, 1);
  for (const [x, y, r] of blobs) g.fillCircle(x, y + 6, r);
  g.fillStyle(d.color, 1);
  for (const [x, y, r] of blobs) g.fillCircle(x, y, r);
  g.fillStyle(light, 1);
  g.fillCircle(-12, -50, 16);
  g.fillCircle(-34, -32, 11);
  g.fillStyle(d.pal.accent, 1);
  g.fillCircle(22, -40, 5.5);
  g.fillCircle(-4, -56, 4.5);
  g.fillCircle(34, -20, 4);

  return {
    radius: 52,
    startIdle: () => sway(d, 0.03, 2200 + d.r(4) * 700),
  };
};

const drawFlower: Drawer = (d) => {
  const g = d.scene.add.graphics();
  d.body.add(g);
  const stem = mix(d.pal.foliageMid, 0x2a6b3f, 0.2);
  const petal = d.color;
  const petalDark = mix(petal, 0x7a2c50, 0.22);

  g.fillStyle(0x000000, 0.10);
  g.fillEllipse(2, 0, 34, 10);

  g.fillStyle(stem, 1);
  g.fillPoints(bladePoints(0, 0, -7, -30, -1, -58, 9), true);
  g.fillStyle(mix(stem, 0xffffff, 0.12), 1);
  g.fillPoints(ellipsePoints(-16, -26, 13, 6, -0.55, 18), true);
  g.fillPoints(ellipsePoints(13, -38, 11, 5, 0.5, 18), true);

  const cx = -1, cy = -62;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const px = cx + Math.cos(a) * 13, py = cy + Math.sin(a) * 13;
    g.fillStyle(petalDark, 1);
    g.fillPoints(ellipsePoints(px + 1, py + 2, 12, 9, a, 18), true);
    g.fillStyle(petal, 1);
    g.fillPoints(ellipsePoints(px, py, 11.5, 8.5, a, 18), true);
  }
  g.fillStyle(mix(d.pal.accent, 0xffffff, 0.15), 1);
  g.fillCircle(cx, cy, 9);
  g.fillStyle(mix(d.pal.accent, 0x8a5a10, 0.35), 0.7);
  g.fillCircle(cx + 2, cy + 2, 4);

  return {
    radius: 30,
    startIdle: () => sway(d, 0.06, 1800 + d.r(5) * 800),
  };
};

const drawMushroom: Drawer = (d) => {
  const g = d.scene.add.graphics();
  d.body.add(g);
  const cap = d.color;
  const capDark = mix(cap, 0x5a1010, 0.28);
  const cream = 0xfff2dc;

  contactShadow(g, 54, 0.16);

  g.fillStyle(mix(cream, 0xb99a76, 0.25), 1);
  g.fillPoints(bladePoints(0, 0, 3, -18, 2, -38, 22), true);
  g.fillStyle(cream, 1);
  g.fillPoints(bladePoints(-2, -1, 1, -18, 1, -38, 17), true);

  const top = ellipsePoints(0, -42, 32, 27, 0, 22, Math.PI, TAU);
  const brim: Pt[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const x = 32 - 64 * t;
    brim.push(pt(x, -42 + Math.sin(t * Math.PI) * 7));
  }
  g.fillStyle(capDark, 1);
  g.fillPoints([...top, ...brim], true);
  g.fillStyle(cap, 1);
  g.fillPoints([...ellipsePoints(0, -45, 31, 26, 0, 22, Math.PI, TAU), ...brim.map((p) => pt(p.x * 0.97, p.y - 3))], true);
  g.fillStyle(mix(cap, 0xffffff, 0.35), 0.6);
  g.fillPoints(ellipsePoints(-12, -58, 12, 6, -0.4, 18), true);
  g.fillStyle(cream, 1);
  g.fillCircle(-15, -50, 6);
  g.fillCircle(9, -56, 5);
  g.fillCircle(19, -44, 4);
  g.fillStyle(mix(cream, 0xc9a87f, 0.4), 1);
  g.fillPoints([...brim.map((p) => pt(p.x * 0.97, p.y - 2)), ...brim.slice().reverse()], true);

  return {
    radius: 36,
    startIdle: () => {
      d.keep(d.scene.tweens.add({
        targets: d.body,
        scaleY: { from: 1, to: 1.045 },
        duration: 1700 + d.r(6) * 600,
        yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      }));
    },
  };
};

/* -------------------------- mineral ------------------------------- */

const drawRock: Drawer = (d) => {
  const g = d.scene.add.graphics();
  d.body.add(g);
  const base = d.color;
  const light = mix(base, 0xffffff, 0.30);
  const dark = mix(base, 0x1b2430, 0.36);

  contactShadow(g, 96, 0.16);

  const shell: Pt[] = [];
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = Math.PI + (i / (n - 1)) * Math.PI;
    const j = 0.82 + d.r(i) * 0.28;
    shell.push(pt(Math.cos(a) * 44 * j, Math.min(0, Math.sin(a) * 40 * j)));
  }
  g.fillStyle(dark, 1);
  g.fillPoints([...shell, pt(44, 2), pt(-44, 2)], true);
  g.fillStyle(base, 1);
  g.fillPoints([...shell.map((p) => pt(p.x * 0.94, p.y * 0.94 - 3)), pt(41, 0), pt(-41, 0)], true);
  g.fillStyle(light, 1);
  g.fillPoints([pt(-30, -18), pt(-12, -37), pt(6, -30), pt(-6, -14)], true);
  g.fillStyle(mix(base, 0xffffff, 0.12), 1);
  g.fillCircle(22, -14, 4);
  g.fillCircle(12, -6, 3);

  return {
    radius: 46,
    startIdle: () => {
      d.keep(d.scene.tweens.add({
        targets: d.body, scaleY: { from: 1, to: 1.02 },
        duration: 2600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: d.r(2) * 1200,
      }));
    },
  };
};

const drawStone: Drawer = (d) => {
  const g = d.scene.add.graphics();
  d.body.add(g);
  const base = d.color;
  const light = mix(base, 0xffffff, 0.38);
  const dark = mix(base, 0x263041, 0.34);

  contactShadow(g, 72, 0.18);

  const shell = ellipsePoints(0, -17, 34, 19, 0.06, 20).map((p, i) => {
    const j = 0.94 + d.r(i) * 0.11;
    return pt(p.x * j, p.y * j);
  });
  g.fillStyle(dark, 1);
  g.fillPoints(shell.map((p) => pt(p.x, p.y + 4)), true);
  g.fillStyle(base, 1);
  g.fillPoints(shell, true);
  g.fillStyle(light, 0.9);
  g.fillPoints(ellipsePoints(-8, -25, 17, 7, -0.22, 18), true);
  g.fillStyle(mix(base, 0xffffff, 0.16), 1);
  g.fillCircle(14, -12, 3.4);

  return {
    radius: 36,
    startIdle: () => {
      d.keep(d.scene.tweens.add({
        targets: d.body, scaleX: { from: 1, to: 1.03 },
        duration: 2400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: d.r(8) * 1400,
      }));
    },
  };
};

const drawCrystal: Drawer = (d) => {
  const glow = softGlow(d.scene, 82, mix(d.color, 0xffffff, 0.25), 0.5);
  glow.setPosition(0, -6);
  d.body.add(glow);

  const g = d.scene.add.graphics();
  d.body.add(g);
  const face = d.color;
  const bright = mix(face, 0xffffff, 0.45);
  const shade = mix(face, 0x1b1035, 0.45);

  const shard = (x: number, y: number, w: number, h: number, tilt: number) => {
    const p = (px: number, py: number): Pt => {
      const c = Math.cos(tilt), s = Math.sin(tilt);
      return pt(x + px * c - py * s, y + px * s + py * c);
    };
    g.fillStyle(shade, 1);
    g.fillPoints([p(-w, 6), p(-w * 0.7, -h * 0.72), p(0, -h), p(w * 0.7, -h * 0.72), p(w, 6), p(0, 14)], true);
    g.fillStyle(face, 1);
    g.fillPoints([p(-w * 0.82, 4), p(-w * 0.58, -h * 0.7), p(0, -h * 0.97), p(w * 0.55, -h * 0.68), p(w * 0.8, 4), p(0, 11)], true);
    g.fillStyle(bright, 0.92);
    g.fillPoints([p(-w * 0.34, 2), p(-w * 0.3, -h * 0.66), p(0, -h * 0.95), p(w * 0.06, -h * 0.6), p(w * 0.02, 3)], true);
    g.fillStyle(0xffffff, 0.55);
    g.fillPoints([p(-w * 0.16, -h * 0.3), p(-w * 0.1, -h * 0.72), p(w * 0.02, -h * 0.68), p(w * 0.0, -h * 0.26)], true);
  };

  shard(-19, 6, 13, 40, -0.24);
  shard(18, 10, 11, 30, 0.28);
  shard(0, 12, 17, 56, 0.02);

  const spark = d.scene.add.image(12, -34, TEX.spark).setTint(0xffffff)
    .setBlendMode(Phaser.BlendModes.ADD).setScale(0.32).setAlpha(0.9);
  d.body.add(spark);

  return {
    radius: 46,
    startIdle: () => {
      d.keep(d.scene.tweens.add({
        targets: glow, alpha: { from: 0.32, to: 0.72 }, scale: { from: 0.92, to: 1.1 },
        duration: 1500 + d.r(1) * 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      }));
      d.keep(d.scene.tweens.add({
        targets: spark, angle: 180, scale: { from: 0.16, to: 0.4 }, alpha: { from: 0.35, to: 1 },
        duration: 1300, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: d.r(9) * 900,
      }));
    },
  };
};

const drawStalagmite: Drawer = (d) => {
  const g = d.scene.add.graphics();
  d.body.add(g);
  const base = d.color;
  const light = mix(base, 0xd6c9ee, 0.3);
  const dark = mix(base, 0x0e0a1c, 0.4);

  contactShadow(g, 86, 0.2);

  const left: Pt[] = [], right: Pt[] = [];
  const H = 132;
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const y = -H * t;
    const w = 30 * (1 - t) ** 1.25 + 3;
    left.push(pt(-w * (0.9 + d.r(i) * 0.22), y));
    right.push(pt(w * (0.9 + d.r(i + 6) * 0.22), y));
  }
  g.fillStyle(dark, 1);
  g.fillPoints([...left.map((p) => pt(p.x - 3, p.y)), ...right.slice().reverse().map((p) => pt(p.x + 3, p.y))], true);
  g.fillStyle(base, 1);
  g.fillPoints([...left, ...right.slice().reverse()], true);
  g.fillStyle(light, 0.85);
  g.fillPoints([...left.map((p) => pt(p.x * 0.98, p.y)), ...left.slice().reverse().map((p) => pt(p.x * 0.34, p.y))], true);
  g.fillStyle(mix(d.pal.accent, 0xffffff, 0.2), 0.5);
  g.fillCircle(0, -H + 4, 3.4);

  return {
    radius: 46,
    startIdle: () => {
      d.keep(d.scene.tweens.add({
        targets: d.body, scaleY: { from: 1, to: 1.015 },
        duration: 3200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: d.r(3) * 1500,
      }));
    },
  };
};

/* -------------------------- water --------------------------------- */

const drawLilypad: Drawer = (d) => {
  const g = d.scene.add.graphics();
  d.body.add(g);
  const base = d.color;
  const dark = mix(base, 0x11402a, 0.32);
  const light = mix(base, 0xe8ffcf, 0.28);

  g.fillStyle(d.pal.waterHighlight, 0.28);
  g.fillEllipse(0, 8, 108, 30);

  const pad = ellipsePoints(0, 0, 46, 20, 0, 26, 0.42, TAU - 0.42);
  g.fillStyle(dark, 1);
  g.fillPoints([...pad.map((p) => pt(p.x, p.y + 4)), pt(0, 4)], true);
  g.fillStyle(base, 1);
  g.fillPoints([...pad, pt(0, 0)], true);
  g.lineStyle(2, light, 0.55);
  for (let i = 0; i < 7; i++) {
    const a = 0.6 + (i / 6) * (TAU - 1.2);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(Math.cos(a) * 40, Math.sin(a) * 17);
    g.strokePath();
  }
  g.fillStyle(light, 0.5);
  g.fillPoints(ellipsePoints(-16, -7, 15, 5, -0.15, 18), true);

  const flower = d.scene.add.graphics();
  d.body.add(flower);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    flower.fillStyle(0xfff0f6, 1);
    flower.fillPoints(ellipsePoints(22 + Math.cos(a) * 6, -9 + Math.sin(a) * 4, 6, 3.6, a, 14), true);
  }
  flower.fillStyle(d.pal.accent, 1);
  flower.fillCircle(22, -9, 3.6);

  return {
    radius: 48,
    startIdle: () => {
      bob(d, 2.6, 2200 + d.r(2) * 700);
      d.keep(d.scene.tweens.add({
        targets: d.body, rotation: { from: -0.02, to: 0.02 },
        duration: 3000, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: d.r(5) * 1200,
      }));
    },
  };
};

const drawReed: Drawer = (d) => {
  const blades: Phaser.GameObjects.Container[] = [];
  const base = d.color;

  const shadow = d.scene.add.graphics();
  d.body.add(shadow);
  contactShadow(shadow, 70, 0.12);

  const specs: [number, number, number, number][] = [
    [-20, -78, -34, 12], [-8, -104, -20, 13], [4, -118, 10, 13], [16, -96, 30, 12], [26, -70, 40, 11],
  ];
  specs.forEach((s, i) => {
    const c = d.scene.add.container(0, 0);
    const g = d.scene.add.graphics();
    const tone = mix(base, i % 2 === 0 ? 0x1f5c3a : 0xe6ffb8, 0.18);
    g.fillStyle(mix(tone, 0x000000, 0.2), 1);
    g.fillPoints(bladePoints(1, 0, s[0] + 2, s[1] * 0.55, s[2] + 2, s[1], s[3]), true);
    g.fillStyle(tone, 1);
    g.fillPoints(bladePoints(0, 0, s[0], s[1] * 0.55, s[2], s[1], s[3] - 1.5), true);
    c.add(g);
    d.body.add(c);
    blades.push(c);
  });

  const cat = d.scene.add.graphics();
  d.body.add(cat);
  const catTone = mix(d.pal.trunk, 0x3a2314, 0.3);
  [[-14, -96], [10, -112]].forEach(([x, y]) => {
    cat.fillStyle(mix(catTone, 0x000000, 0.2), 1);
    cat.fillRoundedRect(x - 5, y - 26, 10, 34, 5);
    cat.fillStyle(catTone, 1);
    cat.fillRoundedRect(x - 4, y - 27, 8, 32, 4);
    cat.fillStyle(mix(catTone, 0xffffff, 0.25), 0.7);
    cat.fillRoundedRect(x - 3.4, y - 24, 3, 22, 1.5);
  });

  return {
    radius: 48,
    startIdle: () => {
      blades.forEach((b, i) => {
        d.keep(d.scene.tweens.add({
          targets: b,
          rotation: { from: -0.05 - i * 0.004, to: 0.06 + i * 0.004 },
          duration: 1700 + i * 190,
          yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: i * 130 + d.r(i) * 400,
        }));
      });
      d.keep(d.scene.tweens.add({
        targets: cat, rotation: { from: -0.03, to: 0.04 },
        duration: 2100, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      }));
    },
  };
};

const drawLog: Drawer = (d) => {
  const g = d.scene.add.graphics();
  d.body.add(g);
  const bark = d.color;
  const barkDark = mix(bark, 0x2b170a, 0.35);
  const inner = mix(bark, 0xffd9a8, 0.45);
  const moss = mix(d.pal.foliageMid, 0x2e6b42, 0.15);

  contactShadow(g, 132, 0.16);

  g.fillStyle(barkDark, 1);
  g.fillRoundedRect(-62, -34, 124, 34, 17);
  g.fillStyle(bark, 1);
  g.fillRoundedRect(-62, -38, 120, 32, 16);
  g.lineStyle(2, barkDark, 0.55);
  for (let i = 0; i < 4; i++) {
    const y = -32 + i * 7;
    g.beginPath(); g.moveTo(-40 + i * 6, y); g.lineTo(26 - i * 4, y - 1); g.strokePath();
  }
  g.fillStyle(barkDark, 1);
  g.fillEllipse(58, -22, 26, 32);
  g.fillStyle(inner, 1);
  g.fillEllipse(58, -22, 21, 27);
  g.lineStyle(2, mix(inner, 0x8a5a2a, 0.45), 0.9);
  g.strokeEllipse(58, -22, 13, 17);
  g.strokeEllipse(58, -22, 6, 8);
  g.fillStyle(moss, 1);
  g.fillCircle(-34, -38, 13);
  g.fillCircle(-18, -42, 10);
  g.fillCircle(6, -39, 8);
  g.fillStyle(mix(moss, 0xd8ff9e, 0.3), 1);
  g.fillCircle(-36, -43, 6);
  g.fillCircle(-16, -46, 4.5);

  return {
    radius: 64,
    startIdle: () => {
      d.keep(d.scene.tweens.add({
        targets: d.body, rotation: { from: -0.008, to: 0.008 },
        duration: 3400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: d.r(4) * 1000,
      }));
    },
  };
};

/* -------------------------- sky / light --------------------------- */

const drawStar: Drawer = (d) => {
  const glow = softGlow(d.scene, 96, mix(d.color, 0xffffff, 0.3), 0.55);
  d.body.add(glow);

  const g = d.scene.add.graphics();
  d.body.add(g);
  const core = mix(d.color, 0xffffff, 0.2);
  g.fillStyle(mix(d.color, 0xd88a1c, 0.35), 1);
  g.fillPoints(starPoints(0, 3, 38, 16.5), true);
  g.fillStyle(d.color, 1);
  g.fillPoints(starPoints(0, 0, 36, 15.5), true);
  g.fillStyle(core, 1);
  g.fillPoints(starPoints(0, -2, 22, 9.5), true);
  g.fillStyle(0xffffff, 0.85);
  g.fillCircle(-7, -8, 5.5);

  const s1 = d.scene.add.image(26, -22, TEX.spark).setTint(0xffffff).setBlendMode(Phaser.BlendModes.ADD).setScale(0.3);
  const s2 = d.scene.add.image(-24, 20, TEX.spark).setTint(0xfff3c4).setBlendMode(Phaser.BlendModes.ADD).setScale(0.2);
  d.body.add([s1, s2]);

  return {
    radius: 46,
    startIdle: () => {
      bob(d, 4.5, 2000);
      d.keep(d.scene.tweens.add({
        targets: glow, alpha: { from: 0.35, to: 0.85 }, scale: { from: 0.9, to: 1.18 },
        duration: 1150, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      }));
      d.keep(d.scene.tweens.add({
        targets: g, rotation: { from: -0.05, to: 0.05 },
        duration: 2600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      }));
      d.keep(d.scene.tweens.add({
        targets: [s1, s2], scale: { from: 0.06, to: 0.34 }, alpha: { from: 0.2, to: 1 },
        duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: 260,
      }));
    },
  };
};

const drawButterfly: Drawer = (d) => {
  const wingColor = d.color;
  const wingDark = mix(wingColor, 0x1b1b3a, 0.3);
  const wingLight = mix(wingColor, 0xffffff, 0.42);
  const bodyColor = mix(0x3a2b3f, wingDark, 0.35);

  const mkWing = (side: 1 | -1): Phaser.GameObjects.Container => {
    const c = d.scene.add.container(side * 3, -2);
    const g = d.scene.add.graphics();
    g.fillStyle(wingDark, 1);
    g.fillPoints(ellipsePoints(side * 20, -13, 23, 17, side * -0.42, 22), true);
    g.fillPoints(ellipsePoints(side * 15, 11, 17, 14, side * 0.34, 22), true);
    g.fillStyle(wingColor, 1);
    g.fillPoints(ellipsePoints(side * 19, -14, 21, 15.4, side * -0.42, 22), true);
    g.fillPoints(ellipsePoints(side * 14.4, 10, 15.4, 12.6, side * 0.34, 22), true);
    g.fillStyle(wingLight, 0.95);
    g.fillPoints(ellipsePoints(side * 24, -18, 8.4, 6, side * -0.42, 16), true);
    g.fillPoints(ellipsePoints(side * 16, 12, 5.4, 4.4, side * 0.34, 14), true);
    g.fillStyle(mix(wingLight, 0xffffff, 0.5), 0.8);
    g.fillCircle(side * 13, -9, 3);
    c.add(g);
    return c;
  };

  const left = mkWing(-1);
  const right = mkWing(1);
  d.body.add([left, right]);

  const g2 = d.scene.add.graphics();
  d.body.add(g2);
  g2.fillStyle(bodyColor, 1);
  g2.fillPoints(ellipsePoints(0, 2, 4.6, 16, 0, 20), true);
  g2.fillCircle(0, -16, 5.4);
  g2.lineStyle(2, bodyColor, 1);
  g2.strokePoints(curvePoints(-2, -19, -8, -29, -12, -31, 10), false);
  g2.strokePoints(curvePoints(2, -19, 8, -29, 12, -31, 10), false);
  g2.fillStyle(mix(wingLight, 0xffffff, 0.4), 1);
  g2.fillCircle(-12, -31, 2.6);
  g2.fillCircle(12, -31, 2.6);

  return {
    radius: 44,
    startIdle: () => {
      d.keep(d.scene.tweens.add({
        targets: left, scaleX: { from: 1, to: 0.3 }, duration: 190,
        yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      }));
      d.keep(d.scene.tweens.add({
        targets: right, scaleX: { from: 1, to: 0.3 }, duration: 190,
        yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      }));
      const wander = { t: 0 };
      const ox = d.r(1) * TAU, oy = d.r(2) * TAU;
      d.keep(d.scene.tweens.addCounter({
        from: 0, to: TAU, duration: 6200 + d.r(3) * 2600, repeat: -1,
        onUpdate: (tw) => {
          wander.t = tw.getValue() ?? 0;
          d.body.x = Math.sin(wander.t + ox) * 26;
          d.body.y = Math.sin(wander.t * 1.6 + oy) * 16;
          d.body.rotation = Math.cos(wander.t + ox) * 0.12;
        },
      }));
    },
  };
};

const drawFirefly: Drawer = (d) => {
  const glow = softGlow(d.scene, 46, d.color, 0.7);
  const glow2 = softGlow(d.scene, 16, mix(d.color, 0xffffff, 0.6), 0.95);
  const g = d.scene.add.graphics();
  g.fillStyle(mix(d.color, 0xffffff, 0.75), 1);
  g.fillCircle(0, 0, 4.2);
  g.fillStyle(mix(d.color, 0x6b4a12, 0.5), 0.9);
  g.fillEllipse(-4, -1, 6, 4);
  d.body.add([glow, glow2, g]);

  return {
    radius: 26,
    startIdle: () => {
      const ox = d.r(1) * TAU, oy = d.r(2) * TAU;
      d.keep(d.scene.tweens.addCounter({
        from: 0, to: TAU, duration: 7400 + d.r(3) * 3000, repeat: -1,
        onUpdate: (tw) => {
          const t = tw.getValue() ?? 0;
          d.body.x = Math.sin(t + ox) * 44 + Math.sin(t * 2.3) * 10;
          d.body.y = Math.cos(t * 1.4 + oy) * 30 + Math.cos(t * 3.1) * 6;
        },
      }));
      d.keep(d.scene.tweens.add({
        targets: [glow, glow2], alpha: { from: 0.12, to: 1 },
        duration: 780 + d.r(4) * 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        delay: d.r(5) * 900,
      }));
    },
  };
};

const drawCloud: Drawer = (d) => {
  const g = d.scene.add.graphics();
  d.body.add(g);
  const white = d.color;
  const shade = mix(white, d.pal.skyTop, 0.24);

  const puffs: [number, number, number][] = [[-46, 2, 26], [-16, -10, 34], [18, -4, 28], [46, 6, 22], [2, 8, 26]];
  g.fillStyle(shade, 1);
  for (const [x, y, r] of puffs) g.fillCircle(x, y + 7, r);
  g.fillRoundedRect(-62, 4, 124, 20, 10);
  g.fillStyle(white, 1);
  for (const [x, y, r] of puffs) g.fillCircle(x, y, r);
  g.fillRoundedRect(-60, -2, 120, 18, 9);
  g.fillStyle(mix(white, 0xffffff, 0.6), 0.8);
  g.fillCircle(-20, -18, 13);
  g.fillCircle(6, -14, 9);

  return {
    radius: 68,
    startIdle: () => {
      d.keep(d.scene.tweens.add({
        targets: d.body, x: { from: -14, to: 14 },
        duration: 9000 + d.r(1) * 4000, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      }));
      d.keep(d.scene.tweens.add({
        targets: d.body, scaleX: { from: 1, to: 1.035 }, y: { from: -3, to: 3 },
        duration: 5200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      }));
    },
  };
};

const drawMoon: Drawer = (d) => {
  const glow = softGlow(d.scene, 130, mix(d.color, 0xffffff, 0.4), 0.42);
  d.body.add(glow);
  const g = d.scene.add.graphics();
  d.body.add(g);
  const face = d.color;
  g.fillStyle(mix(face, 0xffffff, 0.25), 0.35);
  g.fillCircle(0, 0, 54);
  g.fillStyle(face, 1);
  g.fillCircle(0, 0, 46);
  g.fillStyle(mix(face, 0xb9a879, 0.28), 0.75);
  g.fillCircle(-14, -12, 9);
  g.fillCircle(12, 8, 12);
  g.fillCircle(16, -18, 6);
  g.fillStyle(mix(face, 0xffffff, 0.6), 0.6);
  g.fillCircle(-18, 16, 7);

  return {
    radius: 56,
    startIdle: () => {
      d.keep(d.scene.tweens.add({
        targets: glow, alpha: { from: 0.28, to: 0.58 }, scale: { from: 0.95, to: 1.08 },
        duration: 3600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      }));
      bob(d, 2.4, 5200);
    },
  };
};

/* -------------------------- structures ---------------------------- */

const drawFootprint: Drawer = (d) => {
  const g = d.scene.add.graphics();
  d.body.add(g);
  const c = d.color;
  g.fillStyle(mix(c, 0x000000, 0.25), 0.30);
  g.fillPoints(ellipsePoints(1, -7, 19, 12, 0.1, 20), true);
  g.fillStyle(c, 0.62);
  g.fillPoints(ellipsePoints(0, -9, 17.5, 11, 0.1, 20), true);
  const toes: [number, number, number][] = [[-14, -25, 5.4], [-5, -29, 6], [5, -28, 5.6], [14, -22, 5]];
  for (const [x, y, r] of toes) {
    g.fillStyle(mix(c, 0x000000, 0.25), 0.3);
    g.fillCircle(x + 1, y + 2, r);
    g.fillStyle(c, 0.62);
    g.fillCircle(x, y, r);
  }

  return {
    radius: 30,
    startIdle: () => {
      d.keep(d.scene.tweens.add({
        targets: d.body, alpha: { from: 0.72, to: 1 },
        duration: 1500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: d.r(1) * 900,
      }));
    },
  };
};

const drawBridge: Drawer = (d) => {
  const g = d.scene.add.graphics();
  d.body.add(g);
  const wood = d.color;
  const woodDark = mix(wood, 0x2b170a, 0.4);
  const rope = mix(wood, 0xf3e2c4, 0.5);

  const span = 130, sag = 30;
  const sagY = (t: number) => Math.sin(t * Math.PI) * sag;

  g.fillStyle(woodDark, 1);
  g.fillRoundedRect(-span - 12, -78, 14, 88, 5);
  g.fillRoundedRect(span - 2, -78, 14, 88, 5);
  g.fillStyle(mix(wood, 0xffffff, 0.12), 1);
  g.fillRoundedRect(-span - 10, -80, 10, 86, 4);
  g.fillRoundedRect(span, -80, 10, 86, 4);

  g.lineStyle(4, rope, 0.95);
  for (const off of [-46, -6]) {
    g.beginPath();
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const x = -span + span * 2 * t, y = off + sagY(t);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokePath();
  }
  g.lineStyle(2, rope, 0.6);
  for (let i = 1; i < 8; i++) {
    const t = i / 8;
    const x = -span + span * 2 * t;
    g.beginPath(); g.moveTo(x, -46 + sagY(t)); g.lineTo(x, -8 + sagY(t)); g.strokePath();
  }

  for (let i = 0; i <= 9; i++) {
    const t = i / 9;
    const x = -span + 8 + (span * 2 - 16) * t;
    const y = -6 + sagY(t);
    const tilt = Math.cos(t * Math.PI) * -0.32;
    const c = Math.cos(tilt), s = Math.sin(tilt);
    const p = (px: number, py: number): Pt => pt(x + px * c - py * s, y + px * s + py * c);
    g.fillStyle(woodDark, 1);
    g.fillPoints([p(-15, -3), p(15, -3), p(15, 9), p(-15, 9)], true);
    g.fillStyle(i % 2 === 0 ? wood : mix(wood, 0xffffff, 0.08), 1);
    g.fillPoints([p(-15, -6), p(15, -6), p(15, 5), p(-15, 5)], true);
  }

  return {
    radius: 96,
    startIdle: () => {
      d.keep(d.scene.tweens.add({
        targets: d.body, y: { from: -2, to: 2 }, rotation: { from: -0.006, to: 0.006 },
        duration: 3600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      }));
    },
  };
};

const DRAWERS: Record<PropKind, Drawer> = {
  tree: drawTree,
  pine: drawPine,
  bush: drawBush,
  flower: drawFlower,
  mushroom: drawMushroom,
  rock: drawRock,
  stone: drawStone,
  star: drawStar,
  butterfly: drawButterfly,
  firefly: drawFirefly,
  lilypad: drawLilypad,
  reed: drawReed,
  log: drawLog,
  crystal: drawCrystal,
  stalagmite: drawStalagmite,
  footprint: drawFootprint,
  bridge: drawBridge,
  cloud: drawCloud,
  moon: drawMoon,
};

/**
 * Local y of each prop's visual centre. Ground props are drawn from their base
 * at (0,0) upward, so their touch target and highlight ring must be lifted.
 */
const ANCHOR_Y: Record<PropKind, number> = {
  tree: -120, pine: -116, bush: -30, flower: -50, mushroom: -40,
  rock: -20, stone: -16, star: 0, butterfly: 0, firefly: 0,
  lilypad: 0, reed: -62, log: -22, crystal: -20, stalagmite: -62,
  footprint: -14, bridge: -28, cloud: 0, moon: 0,
};

function defaultColor(kind: PropKind, pal: Palette): number {
  switch (kind) {
    case 'tree': case 'bush': case 'lilypad': return pal.foliageMid;
    case 'pine': return pal.foliageDark;
    case 'reed': return pal.foliageLight;
    case 'flower': return pal.accent;
    case 'mushroom': return 0xef6f6c;
    case 'rock': case 'stone': return mix(0xb9c3cd, pal.skyBottom, 0.18);
    case 'star': return 0xffe66d;
    case 'butterfly': return 0x4aa3ff;
    case 'firefly': return 0xfff3a3;
    case 'log': case 'bridge': return pal.trunk;
    case 'crystal': return pal.accent;
    case 'stalagmite': return pal.hillNear;
    case 'footprint': return mix(pal.trunk, 0x000000, 0.25);
    case 'cloud': return 0xffffff;
    case 'moon': return 0xfff6d6;
    default: return pal.foliageMid;
  }
}

/**
 * Draw one story prop. The returned view is what the engine attaches input,
 * gameplay and analytics to - it never needs to know how a mushroom is made.
 */
export function drawProp(ctx: ArtContext, prop: StoryProp): PropView {
  const { scene } = ctx;
  ensureArtTextures(scene);

  const layer: 0 | 1 | 2 = prop.layer ?? 1;
  const unit = ctx.height / DESIGN_HEIGHT;
  const pal = paletteForLayer(ctx.palette, layer);
  const kind: PropKind = (DRAWERS[prop.kind] ? prop.kind : 'rock');
  const rawColor = parseHex(prop.color, defaultColor(kind, ctx.palette));
  const color = mix(rawColor, ctx.palette.skyBottom, layerHaze(layer));

  const root = scene.add.container(prop.x * ctx.width, prop.y * ctx.height);
  const halo = scene.add.graphics();
  const wobbler = scene.add.container(0, 0);
  const body = scene.add.container(0, 0);
  wobbler.add(body);
  root.add([halo, wobbler]);
  root.setScale((prop.scale ?? 1) * unit);

  const tweens: (Phaser.Tweens.Tween | undefined)[] = [];
  const d: Dc = {
    scene, body, pal, color, prop,
    r: (i: number) => hash01(prop.id, i * 977 + 13),
    keep: (t) => { tweens.push(t); },
  };

  const drawing = DRAWERS[kind](d);
  bindLifetime(root, tweens);

  const natural = drawing.radius;
  const worldScale = (prop.scale ?? 1) * unit;
  const hitRadius = Math.max(MIN_TOUCH_RADIUS, natural * worldScale);
  const anchorY = ANCHOR_Y[kind];
  /** Radius in local space that lands on `hitRadius` once the root is scaled. */
  const localHit = hitRadius / (worldScale || 1);

  // Pre-arm a generous, correctly-centred touch target. The engine can replace
  // this with its own shape; small fingers get a fair target either way.
  root.setSize(localHit * 2, localHit * 2);
  root.setInteractive(new Phaser.Geom.Circle(0, anchorY, localHit), Phaser.Geom.Circle.Contains);

  halo.setVisible(false);
  halo.lineStyle(5, pal.accent, 0.95);
  halo.strokeCircle(0, anchorY, natural + 12);
  halo.lineStyle(3, mix(pal.accent, 0xffffff, 0.5), 0.6);
  halo.strokeCircle(0, anchorY, natural + 22);

  let idleStarted = false;
  let haloTween: Phaser.Tweens.Tween | undefined;

  const view: PropView = {
    id: prop.id,
    kind,
    root,
    layer,
    hitRadius,

    idle() {
      if (idleStarted) return;
      idleStarted = true;
      drawing.startIdle();
    },

    async celebrate() {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + 0.3;
        const s = scene.add.image(0, anchorY, TEX.spark)
          .setTint(i % 2 === 0 ? pal.accent : 0xffffff)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setScale(0.1);
        wobbler.add(s);
        scene.tweens.add({
          targets: s,
          x: Math.cos(a) * (natural + 36),
          y: anchorY + Math.sin(a) * (natural + 36),
          scale: { from: 0.36, to: 0 },
          alpha: { from: 1, to: 0 },
          angle: 200,
          duration: 640, ease: 'Cubic.easeOut',
          onComplete: () => s.destroy(),
        });
      }
      const ring = scene.add.image(0, anchorY, TEX.soft)
        .setTint(mix(pal.accent, 0xffffff, 0.4))
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(natural * 1.4, natural * 1.4);
      wobbler.add(ring);
      scene.tweens.add({
        targets: ring, scale: { from: ring.scale * 0.5, to: ring.scale * 2.2 },
        alpha: { from: 0.75, to: 0 }, duration: 620, ease: 'Cubic.easeOut',
        onComplete: () => ring.destroy(),
      });

      await tweenPromise(scene, {
        targets: wobbler,
        scaleX: { from: 1, to: 1.3 },
        scaleY: { from: 1, to: 1.3 },
        y: { from: 0, to: -natural * 0.16 },
        duration: 230,
        yoyo: true,
        hold: 90,
        ease: 'Back.easeOut',
      } as Phaser.Types.Tweens.TweenBuilderConfig);
      wobbler.setScale(1);
      wobbler.setY(0);
    },

    async wobble() {
      await tweenPromise(scene, {
        targets: wobbler,
        rotation: { from: -0.15, to: 0.15 },
        duration: 80,
        yoyo: true,
        repeat: 2,
        ease: 'Sine.easeInOut',
      } as Phaser.Types.Tweens.TweenBuilderConfig);
      wobbler.setRotation(0);
    },

    highlight(on: boolean) {
      haloTween?.remove();
      haloTween = undefined;
      if (!on) {
        halo.setVisible(false);
        halo.setScale(1);
        return;
      }
      halo.setVisible(true).setAlpha(0.9).setScale(0.86);
      haloTween = scene.tweens.add({
        targets: halo,
        scale: { from: 0.86, to: 1.14 },
        alpha: { from: 0.95, to: 0.28 },
        duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
      tweens.push(haloTween);
    },
  };

  return view;
}
