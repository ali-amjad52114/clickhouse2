import type { Biome, TimeOfDay } from '../../shared/types';
import type { Palette } from './contract';

/**
 * Colour system for the procedural art.
 *
 * A biome owns its *materials* (foliage, rock, water, soil). A time of day owns
 * the *light* (sky, and a grade applied to every material). Combining the two
 * gives 7 x 4 palettes without hand-authoring 28 of them, and keeps dusk-forest
 * and dusk-meadow feeling like the same evening.
 */

/* ------------------------------------------------------------------ */
/* Colour maths                                                        */
/* ------------------------------------------------------------------ */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function rgb(c: number): { r: number; g: number; b: number } {
  return { r: (c >> 16) & 0xff, g: (c >> 8) & 0xff, b: c & 0xff };
}

export function pack(r: number, g: number, b: number): number {
  return (clamp(Math.round(r), 0, 255) << 16) | (clamp(Math.round(g), 0, 255) << 8) | clamp(Math.round(b), 0, 255);
}

/** Linear blend between two colours. t=0 -> a, t=1 -> b. */
export function mix(a: number, b: number, t: number): number {
  const k = clamp(t, 0, 1);
  const A = rgb(a), B = rgb(b);
  return pack(A.r + (B.r - A.r) * k, A.g + (B.g - A.g) * k, A.b + (B.b - A.b) * k);
}

/** Multiply brightness. f<1 darkens, f>1 lightens (clamped). */
export function scaleRgb(c: number, f: number): number {
  const C = rgb(c);
  return pack(C.r * f, C.g * f, C.b * f);
}

/** Push toward white. amt 0..1 */
export function lighten(c: number, amt: number): number {
  return mix(c, 0xffffff, amt);
}

/** Push toward black. amt 0..1 */
export function darken(c: number, amt: number): number {
  return mix(c, 0x000000, amt);
}

/** Increase chroma by pushing channels away from their own mean. */
export function saturate(c: number, amt: number): number {
  const C = rgb(c);
  const m = (C.r + C.g + C.b) / 3;
  return pack(m + (C.r - m) * (1 + amt), m + (C.g - m) * (1 + amt), m + (C.b - m) * (1 + amt));
}

/** Perceptual-ish luminance, 0..1. */
export function luminance(c: number): number {
  const C = rgb(c);
  return (0.299 * C.r + 0.587 * C.g + 0.114 * C.b) / 255;
}

/** '#4aa3ff' | '4aa3ff' | undefined -> int. Falls back when unparseable. */
export function parseHex(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const s = value.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) {
    if (/^[0-9a-fA-F]{3}$/.test(s)) {
      const r = s[0], g = s[1], b = s[2];
      return parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
    }
    return fallback;
  }
  return parseInt(s, 16);
}

/** Stable 0..1 hash from a string - lets props look random but never flicker. */
export function hash01(seed: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/* ------------------------------------------------------------------ */
/* Biome materials, authored in neutral midday light                   */
/* ------------------------------------------------------------------ */

interface Materials {
  hillFar: number; hillMid: number; hillNear: number;
  ground: number; groundShadow: number;
  water: number; waterHighlight: number;
  foliageDark: number; foliageMid: number; foliageLight: number;
  trunk: number; accent: number;
}

const MATERIALS: Record<Biome, Materials> = {
  enchanted_forest: {
    hillFar: 0x8fd0a8, hillMid: 0x5fb289, hillNear: 0x3f9a6d,
    ground: 0x59b877, groundShadow: 0x3a8f5e,
    water: 0x4fb4d8, waterHighlight: 0xbdeaf7,
    foliageDark: 0x2f6b4f, foliageMid: 0x3d8a63, foliageLight: 0x69b98b,
    trunk: 0x8a5a3b, accent: 0xffd166,
  },
  river: {
    hillFar: 0xa9dcc0, hillMid: 0x7cc79f, hillNear: 0x59b47f,
    ground: 0xdcc794, groundShadow: 0xb99f6d,
    water: 0x3fa8dc, waterHighlight: 0xd6f3ff,
    foliageDark: 0x357d59, foliageMid: 0x4a9d70, foliageLight: 0x7cc79b,
    trunk: 0x8a5a3b, accent: 0xffd166,
  },
  meadow: {
    hillFar: 0xc6e7ac, hillMid: 0x9bd786, hillNear: 0x7ac86c,
    ground: 0x92d772, groundShadow: 0x6cb355,
    water: 0x63c2e8, waterHighlight: 0xd6f2ff,
    foliageDark: 0x3f8f52, foliageMid: 0x5cb26a, foliageLight: 0x8ed693,
    trunk: 0x9b6a44, accent: 0xff8fc7,
  },
  cave: {
    hillFar: 0x3b3050, hillMid: 0x4a3c63, hillNear: 0x5b4b78,
    ground: 0x3a2e50, groundShadow: 0x241b35,
    water: 0x2f6fa8, waterHighlight: 0x7fd6f0,
    foliageDark: 0x2a2440, foliageMid: 0x3a3157, foliageLight: 0x53476f,
    trunk: 0x5b4a63, accent: 0x7ad7f0,
  },
  night_sky: {
    hillFar: 0x22305c, hillMid: 0x1a2650, hillNear: 0x131c3f,
    ground: 0x18234c, groundShadow: 0x0d1533,
    water: 0x1c3c6e, waterHighlight: 0x8fb8e8,
    foliageDark: 0x123024, foliageMid: 0x1b4534, foliageLight: 0x2a6a4d,
    trunk: 0x3a2c28, accent: 0xffe66d,
  },
  mountain: {
    hillFar: 0xbccbde, hillMid: 0x92a8c4, hillNear: 0x6d86a8,
    ground: 0xa3b490, groundShadow: 0x7f9070,
    water: 0x5fb6d8, waterHighlight: 0xd7f2ff,
    foliageDark: 0x2c5a45, foliageMid: 0x3d7a5b, foliageLight: 0x63a680,
    trunk: 0x7a5638, accent: 0xffe0a3,
  },
  village: {
    hillFar: 0xcbe3ab, hillMid: 0xa8d289, hillNear: 0x8ac06f,
    ground: 0x9dd373, groundShadow: 0x79ae54,
    water: 0x59b8d8, waterHighlight: 0xcdefff,
    foliageDark: 0x3d8054, foliageMid: 0x529a68, foliageLight: 0x81c58f,
    trunk: 0x9c6b41, accent: 0xff9f5a,
  },
};

/* ------------------------------------------------------------------ */
/* Light                                                               */
/* ------------------------------------------------------------------ */

interface Sky { top: number; bottom: number; sun: number }

const SKIES: Record<TimeOfDay, Sky> = {
  dawn: { top: 0x5d8fcc, bottom: 0xffd6a6, sun: 0xfff0c9 },
  day: { top: 0x4fb3ef, bottom: 0xd3f0ff, sun: 0xfff8d4 },
  dusk: { top: 0x4a3b81, bottom: 0xffab73, sun: 0xffcf8a },
  night: { top: 0x0a1130, bottom: 0x27366a, sun: 0xfff6d6 },
};

/** How the light of each hour re-tints every material. */
interface Grade { light: number; amount: number; dim: number; chroma: number }

const GRADES: Record<TimeOfDay, Grade> = {
  dawn: { light: 0xffc48a, amount: 0.20, dim: 0.97, chroma: 0.04 },
  day: { light: 0xffffff, amount: 0.05, dim: 1.0, chroma: 0.08 },
  dusk: { light: 0xff9a60, amount: 0.26, dim: 0.86, chroma: 0.06 },
  night: { light: 0x3f5cae, amount: 0.44, dim: 0.52, chroma: -0.10 },
};

/** Biomes whose own light overrides the clock. */
const FORCED_SKY: Partial<Record<Biome, Sky>> = {
  cave: { top: 0x140e26, bottom: 0x35264f, sun: 0x7ad7f0 },
  night_sky: { top: 0x05081c, bottom: 0x1b2a5c, sun: 0xfff6d6 },
};

const FORCED_GRADE: Partial<Record<Biome, TimeOfDay>> = {
  cave: 'night',
  night_sky: 'night',
};

function isDark(biome: Biome, time: TimeOfDay): boolean {
  return biome === 'cave' || biome === 'night_sky' || time === 'night';
}

const cache = new Map<string, Palette>();

/**
 * Resolve the palette for a biome at a time of day. Cached: palettes are
 * immutable and get asked for on every prop draw.
 */
export function paletteFor(biome: Biome, time: TimeOfDay): Palette {
  const key = `${biome}|${time}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const mats = MATERIALS[biome] ?? MATERIALS.enchanted_forest;
  const sky = FORCED_SKY[biome] ?? SKIES[time] ?? SKIES.day;
  const grade = GRADES[FORCED_GRADE[biome] ?? time] ?? GRADES.day;

  const g = (c: number): number =>
    saturate(scaleRgb(mix(c, grade.light, grade.amount), grade.dim), grade.chroma);

  const dark = isDark(biome, time);

  const palette: Palette = {
    skyTop: sky.top,
    skyBottom: sky.bottom,
    sun: sky.sun,
    hillFar: g(mix(mats.hillFar, sky.bottom, 0.34)),
    hillMid: g(mix(mats.hillMid, sky.bottom, 0.16)),
    hillNear: g(mats.hillNear),
    ground: g(mats.ground),
    groundShadow: g(mats.groundShadow),
    water: g(mats.water),
    waterHighlight: g(mats.waterHighlight),
    foliageDark: g(mats.foliageDark),
    foliageMid: g(mats.foliageMid),
    foliageLight: g(mats.foliageLight),
    trunk: g(mats.trunk),
    accent: mix(mats.accent, grade.light, grade.amount * 0.35),
    ink: dark ? 0xfff4e2 : 0x35240f,
    scrim: dark ? 0x121a35 : 0xfff9ec,
    dark,
  };

  cache.set(key, palette);
  return palette;
}

/**
 * Atmospheric perspective: things far away lose contrast into the sky.
 * Applied per parallax layer so a far tree never fights a near one.
 */
export function paletteForLayer(base: Palette, layer: 0 | 1 | 2): Palette {
  const t = layer === 0 ? 0.20 : layer === 1 ? 0.07 : 0;
  if (t === 0) return base;
  const haze = base.skyBottom;
  const f = (c: number) => mix(c, haze, t);
  return {
    ...base,
    hillFar: f(base.hillFar), hillMid: f(base.hillMid), hillNear: f(base.hillNear),
    ground: f(base.ground), groundShadow: f(base.groundShadow),
    water: f(base.water), waterHighlight: f(base.waterHighlight),
    foliageDark: f(base.foliageDark), foliageMid: f(base.foliageMid), foliageLight: f(base.foliageLight),
    trunk: f(base.trunk), accent: f(base.accent),
  };
}

/** Haze factor for a layer, so props can fade their own custom colours too. */
export function layerHaze(layer: 0 | 1 | 2): number {
  return layer === 0 ? 0.20 : layer === 1 ? 0.07 : 0;
}

/* ------------------------------------------------------------------ */
/* Character colours - shared by characters.ts                         */
/* ------------------------------------------------------------------ */

export const FOX_COLORS = {
  fur: 0xf2913f,
  furDark: 0xd9722a,
  furShade: 0xc2601f,
  cream: 0xfff0d8,
  creamShade: 0xf2ddbc,
  ear: 0x3a2a24,
  ink: 0x3a2118,
  eye: 0x2a1a14,
  eyeWhite: 0xfffaf0,
  nose: 0x40272a,
  blush: 0xffb08a,
};

/**
 * MIMO. Deliberately nothing like any existing mascot: mint + cream, aqua
 * glow, no yellow body, no red cheeks, no black ear tips, no bolt tail.
 */
export const MIMO_COLORS = {
  body: 0x9fe3c9,
  bodyShade: 0x7fcdb0,
  bodyLight: 0xc2f0dd,
  belly: 0xfff4de,
  bellyShade: 0xf6e4c6,
  earStalk: 0x8ed9be,
  bulb: 0xd8fbee,
  glow: 0x7ef0d8,
  eyeWhite: 0xfffdf5,
  iris: 0x214543,
  irisLight: 0x3b7a72,
  mouth: 0x2c4f4a,
  tongue: 0xffb9c7,
  paw: 0xbdefda,
};
