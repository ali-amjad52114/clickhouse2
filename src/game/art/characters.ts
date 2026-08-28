import Phaser from 'phaser';
import type { ArtContext, CharacterView, Mood } from './contract';
import { DESIGN_HEIGHT } from './contract';
import { FOX_COLORS, MIMO_COLORS, clamp, mix } from './palettes';
import {
  TEX, bladePoints, ellipsePoints, ensureArtTextures,
  pt, softGlow, tweenPromise, wait,
} from './props';

/**
 * The two creatures. Both are containers of primitives - no sprite sheets
 * exist - and both animate as rigs: parts move, nothing is pre-baked.
 *
 * Rig stack (outermost first), so animations never fight each other:
 *   root     - world position, moved by moveTo
 *   flipper  - facing (scaleX = -1 flips the whole creature)
 *   hopper   - hop arc + squash-and-stretch
 *   spinner  - celebration spin around the body centre
 *   floater  - idle breathing bob
 *   rig      - mood posture (tilt, slump, lift)
 */

const TAU = Math.PI * 2;

interface RigStack {
  root: Phaser.GameObjects.Container;
  shadow: Phaser.GameObjects.Graphics;
  flipper: Phaser.GameObjects.Container;
  hopper: Phaser.GameObjects.Container;
  spinner: Phaser.GameObjects.Container;
  floater: Phaser.GameObjects.Container;
  rig: Phaser.GameObjects.Container;
  unit: number;
  keep(t: Phaser.Tweens.Tween | Phaser.Time.TimerEvent): void;
  kill(): void;
}

function buildRig(ctx: ArtContext, pivotY: number, shadowW: number): RigStack {
  const scene = ctx.scene;
  ensureArtTextures(scene);
  const unit = ctx.height / DESIGN_HEIGHT;

  const root = scene.add.container(ctx.width * 0.5, ctx.height * 0.8);
  root.setScale(unit);

  const shadow = scene.add.graphics();
  shadow.fillStyle(0x000000, ctx.palette.dark ? 0.26 : 0.18);
  shadow.fillEllipse(0, 0, shadowW, shadowW * 0.26);

  const flipper = scene.add.container(0, 0);
  const hopper = scene.add.container(0, 0);
  const spinner = scene.add.container(0, pivotY);
  const floater = scene.add.container(0, -pivotY);
  const rig = scene.add.container(0, 0);

  floater.add(rig);
  spinner.add(floater);
  hopper.add(spinner);
  flipper.add(hopper);
  root.add([shadow, flipper]);

  const live: (Phaser.Tweens.Tween | Phaser.Time.TimerEvent)[] = [];
  const stack: RigStack = {
    root, shadow, flipper, hopper, spinner, floater, rig, unit,
    keep: (t) => { live.push(t); },
    kill: () => { for (const t of live) t.remove(); live.length = 0; },
  };
  root.once(Phaser.GameObjects.Events.DESTROY, stack.kill);
  return stack;
}

/** One eye: sclera, iris, animated highlights, and a real eyelid. */
interface Eye {
  container: Phaser.GameObjects.Container;
  iris: Phaser.GameObjects.Container;
  lid: Phaser.GameObjects.Graphics;
  glint: Phaser.GameObjects.Image;
  openY: number;
  closedY: number;
}

function makeEye(
  scene: Phaser.Scene, x: number, y: number, rx: number, ry: number,
  white: number, irisColor: number, irisR: number, lidColor: number, creaseColor: number,
): Eye {
  const container = scene.add.container(x, y);

  const sclera = scene.add.graphics();
  sclera.fillStyle(mix(white, 0x000000, 0.10), 1);
  sclera.fillEllipse(0, 1.5, rx * 2, ry * 2);
  sclera.fillStyle(white, 1);
  sclera.fillEllipse(0, 0, rx * 2, ry * 2);

  const iris = scene.add.container(0, 0);
  const irisG = scene.add.graphics();
  irisG.fillStyle(irisColor, 1);
  irisG.fillCircle(0, 0, irisR);
  irisG.fillStyle(mix(irisColor, 0xffffff, 0.28), 1);
  irisG.fillCircle(0, irisR * 0.28, irisR * 0.62);
  irisG.fillStyle(0xffffff, 0.96);
  irisG.fillCircle(-irisR * 0.34, -irisR * 0.42, irisR * 0.36);
  irisG.fillStyle(0xffffff, 0.72);
  irisG.fillCircle(irisR * 0.36, irisR * 0.34, irisR * 0.17);
  iris.add(irisG);

  const glint = scene.add.image(-irisR * 0.2, -irisR * 0.75, TEX.soft)
    .setDisplaySize(irisR * 1.5, irisR * 1.5)
    .setBlendMode(Phaser.BlendModes.ADD)
    .setAlpha(0.55);
  iris.add(glint);

  const lidH = ry * 2 + 8;
  const lid = scene.add.graphics();
  lid.fillStyle(lidColor, 1);
  lid.fillRect(-rx - 2.5, -lidH, rx * 2 + 5, lidH);
  lid.fillStyle(creaseColor, 1);
  lid.fillRect(-rx - 2.5, -2.6, rx * 2 + 5, 2.6);

  container.add([sclera, iris, lid]);

  const openY = -ry - 2;
  const closedY = ry + 1.5;
  lid.y = openY;

  return { container, iris, lid, glint, openY, closedY };
}

function setLid(eyes: Eye[], amount: number, scene?: Phaser.Scene, duration = 0): void {
  for (const e of eyes) {
    const y = e.openY + (e.closedY - e.openY) * clamp(amount, 0, 1);
    if (scene && duration > 0) {
      scene.tweens.add({ targets: e.lid, y, duration, ease: 'Sine.easeOut' });
    } else {
      e.lid.y = y;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Shared motion                                                       */
/* ------------------------------------------------------------------ */

interface MoveOpts { hop?: boolean; durationMs?: number }

/**
 * A hop with real squash-and-stretch: compressed at take-off and landing,
 * stretched at the apex, with the shadow shrinking underneath.
 */
function hopArc(
  stack: RigStack, hops: number, duration: number, height: number,
  onPhase?: (p: number, arc: number) => void,
): Phaser.Tweens.Tween {
  const baseAlpha = stack.shadow.alpha;
  const t = stack.root.scene.tweens.addCounter({
    from: 0, to: hops, duration, ease: 'Linear',
    onUpdate: (tw) => {
      const v = Number(tw.getValue());
      const p = v >= hops ? 1 : v % 1;
      const arc = Math.sin(p * Math.PI);
      const k = Math.cos(p * TAU);            // +1 on the ground, -1 at the apex
      stack.hopper.y = -height * arc;
      stack.hopper.scaleY = 1 - 0.15 * k;
      stack.hopper.scaleX = 1 + 0.13 * k;
      stack.shadow.setScale(1 - 0.34 * arc);
      stack.shadow.setAlpha(baseAlpha * (1 - 0.5 * arc));
      onPhase?.(p, arc);
    },
    onComplete: () => {
      stack.hopper.y = 0;
      stack.hopper.setScale(1);
      stack.shadow.setScale(1).setAlpha(baseAlpha);
      onPhase?.(0, 0);
    },
  });
  stack.keep(t);
  return t;
}

/* ================================================================== */
/* FOX                                                                 */
/* ================================================================== */

interface FoxMoodSpec {
  ear: number; lid: number; mouth: 'smile' | 'open' | 'flat' | 'frown' | 'o';
  tilt: number; lift: number; tail: number; squash: number;
}

const FOX_MOODS: Record<Mood, FoxMoodSpec> = {
  idle: { ear: 0, lid: 0.05, mouth: 'smile', tilt: 0, lift: 0, tail: 1, squash: 1 },
  happy: { ear: -0.12, lid: 0.10, mouth: 'smile', tilt: 0.02, lift: -2, tail: 1.8, squash: 1.02 },
  excited: { ear: -0.2, lid: 0, mouth: 'open', tilt: 0.05, lift: -4, tail: 2.6, squash: 1.04 },
  curious: { ear: 0.28, lid: 0.04, mouth: 'o', tilt: 0.12, lift: 0, tail: 1.2, squash: 1 },
  surprised: { ear: -0.3, lid: 0, mouth: 'o', tilt: 0, lift: -3, tail: 0.6, squash: 0.98 },
  worried: { ear: 0.5, lid: 0.32, mouth: 'flat', tilt: -0.04, lift: 1, tail: 0.5, squash: 0.98 },
  scared: { ear: 0.85, lid: 0.05, mouth: 'o', tilt: -0.06, lift: 2, tail: 0.3, squash: 0.93 },
  thinking: { ear: 0.4, lid: 0.28, mouth: 'flat', tilt: 0.09, lift: 0, tail: 0.7, squash: 1 },
  proud: { ear: -0.14, lid: 0.5, mouth: 'smile', tilt: -0.03, lift: -3, tail: 1.6, squash: 1.05 },
  sad: { ear: 0.72, lid: 0.42, mouth: 'frown', tilt: 0.03, lift: 2, tail: 0.3, squash: 0.94 },
};

export function createFox(ctx: ArtContext): CharacterView {
  const scene = ctx.scene;
  const C = FOX_COLORS;
  const stack = buildRig(ctx, -72, 96);
  const { rig } = stack;

  /* ---- tail ---- */
  const tail = scene.add.container(-40, -66);
  {
    const g = scene.add.graphics();
    g.fillStyle(C.furShade, 1);
    g.fillPoints(bladePoints(2, 4, -30, -4, -58, -40, 46), true);
    g.fillStyle(C.furDark, 1);
    g.fillPoints(bladePoints(0, 0, -32, -8, -56, -44, 42), true);
    g.fillStyle(C.fur, 1);
    g.fillPoints(bladePoints(-2, -4, -30, -14, -52, -46, 30), true);
    g.fillStyle(C.cream, 1);
    g.fillCircle(-56, -46, 16);
    g.fillStyle(C.creamShade, 0.5);
    g.fillCircle(-52, -40, 9);
    tail.add(g);
  }
  rig.add(tail);

  /* ---- back legs ---- */
  const mkLeg = (x: number, color: number, len: number): Phaser.GameObjects.Container => {
    const c = scene.add.container(x, -62);
    const g = scene.add.graphics();
    g.fillStyle(color, 1);
    g.fillRoundedRect(-7.5, -4, 15, len, 7);
    g.fillStyle(C.ink, 1);
    g.fillEllipse(0, len - 6, 18, 11);
    g.fillStyle(mix(color, 0xffffff, 0.1), 1);
    g.fillEllipse(0, len - 8, 15, 8);
    c.add(g);
    return c;
  };
  const legBackFar = mkLeg(-26, C.furShade, 60);
  const legFrontFar = mkLeg(24, C.furShade, 60);
  rig.add([legBackFar, legFrontFar]);

  /* ---- body ---- */
  const bodyG = scene.add.graphics();
  bodyG.fillStyle(C.furDark, 1);
  bodyG.fillPoints(ellipsePoints(0, -66, 56, 33, -0.05, 30), true);
  bodyG.fillStyle(C.fur, 1);
  bodyG.fillPoints(ellipsePoints(0, -70, 54, 31, -0.05, 30), true);
  bodyG.fillStyle(C.cream, 1);
  bodyG.fillPoints(ellipsePoints(26, -62, 28, 22, 0.1, 26), true);
  bodyG.fillStyle(mix(C.fur, 0xffffff, 0.16), 0.85);
  bodyG.fillPoints(ellipsePoints(-10, -86, 30, 10, -0.08, 24), true);
  rig.add(bodyG);

  const legBackNear = mkLeg(-12, C.fur, 62);
  const legFrontNear = mkLeg(34, C.fur, 62);
  rig.add([legBackNear, legFrontNear]);

  /* ---- head ---- */
  const head = scene.add.container(44, -100);
  const earL = scene.add.container(-16, -22);
  const earR = scene.add.container(14, -26);
  for (const [ear, flip] of [[earL, -1], [earR, 1]] as const) {
    const g = scene.add.graphics();
    g.fillStyle(C.furDark, 1);
    g.fillPoints([pt(-14 * flip, 6), pt(2 * flip, -34), pt(15 * flip, 4)], true);
    g.fillStyle(C.fur, 1);
    g.fillPoints([pt(-12 * flip, 5), pt(2 * flip, -30), pt(13 * flip, 3)], true);
    g.fillStyle(C.ear, 0.85);
    g.fillPoints([pt(-6 * flip, 2), pt(2 * flip, -21), pt(8 * flip, 1)], true);
    ear.add(g);
  }
  head.add([earL, earR]);

  const headG = scene.add.graphics();
  headG.fillStyle(C.furDark, 1);
  headG.fillPoints(ellipsePoints(0, 2, 33, 30, 0, 28), true);
  headG.fillStyle(C.fur, 1);
  headG.fillPoints(ellipsePoints(0, 0, 32, 29, 0, 28), true);
  headG.fillStyle(C.fur, 1);
  headG.fillPoints([pt(-26, -6), pt(-40, 6), pt(-24, 12)], true);
  headG.fillStyle(C.cream, 1);
  headG.fillPoints(ellipsePoints(20, 12, 24, 17, 0.06, 26), true);
  headG.fillPoints(ellipsePoints(-6, 20, 16, 10, 0, 20), true);
  headG.fillStyle(mix(C.fur, 0xffffff, 0.2), 0.7);
  headG.fillPoints(ellipsePoints(-4, -18, 20, 8, -0.1, 20), true);
  head.add(headG);

  const eyeL = makeEye(scene, 2, -4, 8.5, 10, C.eyeWhite, C.eye, 6, C.fur, C.furShade);
  const eyeR = makeEye(scene, 24, -2, 8, 9.5, C.eyeWhite, C.eye, 5.6, C.fur, C.furShade);
  head.add([eyeL.container, eyeR.container]);
  const eyes = [eyeL, eyeR];

  const faceG = scene.add.graphics();
  head.add(faceG);
  const drawFoxFace = (mouth: FoxMoodSpec['mouth']): void => {
    faceG.clear();
    faceG.fillStyle(C.nose, 1);
    faceG.fillPoints([pt(34, 6), pt(44, 6), pt(39, 13)], true);
    faceG.fillStyle(mix(C.nose, 0xffffff, 0.35), 0.8);
    faceG.fillCircle(37, 7.5, 2);
    faceG.lineStyle(2.6, C.ink, 0.9);
    if (mouth === 'smile') {
      faceG.beginPath(); faceG.arc(32, 15, 7, 0.15 * Math.PI, 0.85 * Math.PI); faceG.strokePath();
    } else if (mouth === 'open') {
      faceG.fillStyle(C.ink, 1);
      faceG.fillPoints(ellipsePoints(32, 20, 8, 7, 0, 18), true);
      faceG.fillStyle(C.blush, 1);
      faceG.fillPoints(ellipsePoints(32, 23, 5, 3.4, 0, 14), true);
    } else if (mouth === 'o') {
      faceG.fillStyle(C.ink, 1);
      faceG.fillPoints(ellipsePoints(33, 18, 4.4, 5, 0, 16), true);
    } else if (mouth === 'frown') {
      faceG.beginPath(); faceG.arc(32, 24, 7, 1.15 * Math.PI, 1.85 * Math.PI); faceG.strokePath();
    } else {
      faceG.beginPath(); faceG.moveTo(26, 18); faceG.lineTo(38, 18); faceG.strokePath();
    }
  };
  drawFoxFace('smile');
  rig.add(head);

  /* ---- state ---- */
  let mood: Mood = 'idle';
  let facing: 1 | -1 = 1;
  let gait: Phaser.Tweens.Tween | undefined;
  let tailTween: Phaser.Tweens.Tween | undefined;
  const legs: [Phaser.GameObjects.Container, number][] = [
    [legBackFar, 0], [legFrontFar, Math.PI], [legBackNear, Math.PI], [legFrontNear, 0],
  ];

  const setTailSpeed = (speed: number): void => {
    tailTween?.remove();
    tailTween = scene.tweens.add({
      targets: tail,
      rotation: { from: -0.14 * speed, to: 0.16 * speed },
      duration: Math.max(260, 1500 / Math.max(0.3, speed)),
      yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
    stack.keep(tailTween);
  };

  const breathe = scene.tweens.add({
    targets: stack.floater,
    y: { from: 72, to: 69 },
    duration: 1900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
  });
  stack.keep(breathe);
  stack.keep(scene.tweens.add({
    targets: [eyeL.glint, eyeR.glint],
    alpha: { from: 0.3, to: 0.75 }, scale: { from: 0.9, to: 1.15 },
    duration: 1600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
  }));

  const blinkTimer = scene.time.addEvent({
    delay: 2400, loop: true,
    callback: () => {
      if (Math.random() > 0.55) return;
      const rest = FOX_MOODS[mood].lid;
      setLid(eyes, 1, scene, 70);
      scene.time.delayedCall(150, () => setLid(eyes, rest, scene, 110));
    },
  });
  stack.keep(blinkTimer);

  const startGait = (speed: number): void => {
    if (gait) return;
    gait = scene.tweens.addCounter({
      from: 0, to: TAU, duration: Math.round(640 / speed), repeat: -1,
      onUpdate: (tw) => {
        const t = Number(tw.getValue());
        for (const [leg, phase] of legs) leg.rotation = Math.sin(t + phase) * 0.55;
        stack.floater.y = 72 - Math.abs(Math.sin(t)) * 5;
        head.rotation = Math.sin(t * 2) * 0.05;
        tail.rotation = Math.sin(t * 0.5) * 0.2;
      },
    });
    stack.keep(gait);
    breathe.pause();
    tailTween?.pause();
  };

  const stopGait = (): void => {
    gait?.remove();
    gait = undefined;
    scene.tweens.add({
      targets: legs.map(([l]) => l), rotation: 0, duration: 180, ease: 'Sine.easeOut',
    });
    scene.tweens.add({ targets: head, rotation: 0, duration: 180 });
    stack.floater.y = 72;
    breathe.resume();
    tailTween?.resume();
  };

  const applyMood = (m: Mood): void => {
    mood = m;
    const s = FOX_MOODS[m] ?? FOX_MOODS.idle;
    scene.tweens.add({ targets: earL, rotation: s.ear, duration: 260, ease: 'Back.easeOut' });
    scene.tweens.add({ targets: earR, rotation: -s.ear, duration: 260, ease: 'Back.easeOut' });
    scene.tweens.add({ targets: rig, rotation: s.tilt, y: s.lift, scaleY: s.squash, duration: 300, ease: 'Sine.easeOut' });
    setLid(eyes, s.lid, scene, 200);
    drawFoxFace(s.mouth);
    setTailSpeed(s.tail);
  };

  setTailSpeed(1);
  applyMood('idle');

  const view: CharacterView = {
    root: stack.root,

    async moveTo(x: number, y: number, opts?: MoveOpts) {
      const tx = x * ctx.width, ty = y * ctx.height;
      const dx = tx - stack.root.x;
      const dist = Math.hypot(dx, ty - stack.root.y);
      if (dist < 2) return;
      if (Math.abs(dx) > 6) view.setFacing(dx > 0 ? 1 : -1);
      const duration = opts?.durationMs ?? clamp((dist / (320 * stack.unit)) * 1000, 380, 3000);
      const speed = clamp(dist / stack.unit / duration * 900, 0.7, 2.2);
      startGait(speed);
      const arrival = tweenPromise(scene, {
        targets: stack.root, x: tx, y: ty, duration,
        ease: opts?.hop ? 'Linear' : 'Sine.easeInOut',
      } as Phaser.Types.Tweens.TweenBuilderConfig);
      if (opts?.hop) hopArc(stack, Math.max(1, Math.round(duration / 460)), duration, 46);
      await arrival;
      stopGait();
    },

    setMood(m: Mood) { applyMood(m); },

    async pointAt(x: number, y: number) {
      const tx = x * ctx.width;
      if (Math.abs(tx - stack.root.x) > 6) view.setFacing(tx > stack.root.x ? 1 : -1);
      const up = y * ctx.height < stack.root.y - 120 ? -2.5 : -1.9;
      await tweenPromise(scene, {
        targets: legFrontNear, rotation: up, duration: 260, ease: 'Back.easeOut',
      } as Phaser.Types.Tweens.TweenBuilderConfig);
      await wait(scene, 480);
      await tweenPromise(scene, {
        targets: legFrontNear, rotation: 0, duration: 240, ease: 'Sine.easeInOut',
      } as Phaser.Types.Tweens.TweenBuilderConfig);
    },

    async celebrate() {
      applyMood('excited');
      const spin = scene.tweens.addCounter({
        from: 0, to: TAU, duration: 620, ease: 'Cubic.easeInOut',
        onUpdate: (tw) => { stack.flipper.scaleX = facing * Math.cos(Number(tw.getValue())); },
        onComplete: () => { stack.flipper.scaleX = facing; },
      });
      stack.keep(spin);
      hopArc(stack, 2, 900, 74);
      await wait(scene, 940);
      applyMood('happy');
    },

    setFacing(dir: -1 | 1) {
      if (dir === facing) return;
      facing = dir;
      scene.tweens.add({ targets: stack.flipper, scaleX: dir, duration: 160, ease: 'Sine.easeInOut' });
    },

    setVisible(v: boolean) { stack.root.setVisible(v); },
  };

  return view;
}

/* ================================================================== */
/* MIMO - the companion                                                */
/* ================================================================== */

type MouthShape = 'smile' | 'bigSmile' | 'openHappy' | 'flat' | 'o' | 'wavy' | 'frown' | 'smirk';

interface MimoMoodSpec {
  earL: number; earR: number; earScale: number;
  lid: number; eyeScale: number; irisY: number;
  mouth: MouthShape;
  tilt: number; squash: number; lift: number;
  glow: number; bounce: number; tremble: boolean;
}

const MIMO_MOODS: Record<Mood, MimoMoodSpec> = {
  idle: { earL: -0.30, earR: 0.30, earScale: 1, lid: 0.06, eyeScale: 1, irisY: 0, mouth: 'smile', tilt: 0, squash: 1, lift: 0, glow: 0.55, bounce: 1, tremble: false },
  happy: { earL: -0.20, earR: 0.20, earScale: 1.05, lid: 0.10, eyeScale: 1, irisY: 0, mouth: 'bigSmile', tilt: 0, squash: 1.02, lift: -1, glow: 0.72, bounce: 1.3, tremble: false },
  excited: { earL: -0.10, earR: 0.10, earScale: 1.14, lid: 0, eyeScale: 1.08, irisY: -1, mouth: 'openHappy', tilt: 0.06, squash: 1.05, lift: -3, glow: 0.98, bounce: 1.8, tremble: false },
  curious: { earL: -0.62, earR: 0.10, earScale: 1, lid: 0.05, eyeScale: 1.04, irisY: -1, mouth: 'o', tilt: 0.14, squash: 1, lift: 0, glow: 0.6, bounce: 0.9, tremble: false },
  surprised: { earL: -0.04, earR: 0.04, earScale: 1.18, lid: 0, eyeScale: 1.2, irisY: 0, mouth: 'o', tilt: 0, squash: 0.97, lift: -2, glow: 0.88, bounce: 0.6, tremble: false },
  worried: { earL: -0.84, earR: 0.84, earScale: 0.94, lid: 0.34, eyeScale: 0.98, irisY: 1, mouth: 'wavy', tilt: -0.05, squash: 0.97, lift: 1, glow: 0.4, bounce: 0.7, tremble: false },
  scared: { earL: -1.24, earR: 1.24, earScale: 0.88, lid: 0.02, eyeScale: 1.14, irisY: 2, mouth: 'wavy', tilt: 0, squash: 0.9, lift: 3, glow: 0.3, bounce: 0.5, tremble: true },
  thinking: { earL: -0.74, earR: 0.16, earScale: 0.96, lid: 0.3, eyeScale: 1, irisY: -2, mouth: 'smirk', tilt: 0.1, squash: 1, lift: 0, glow: 0.5, bounce: 0.6, tremble: false },
  proud: { earL: -0.16, earR: 0.16, earScale: 1.1, lid: 0.55, eyeScale: 1, irisY: 0, mouth: 'bigSmile', tilt: 0, squash: 1.06, lift: -2, glow: 0.9, bounce: 1.1, tremble: false },
  sad: { earL: -1.32, earR: 1.32, earScale: 0.86, lid: 0.46, eyeScale: 0.95, irisY: 2, mouth: 'frown', tilt: 0, squash: 0.92, lift: 3, glow: 0.22, bounce: 0.45, tremble: false },
};

export function createMimo(ctx: ArtContext): CharacterView {
  const scene = ctx.scene;
  const M = MIMO_COLORS;
  const stack = buildRig(ctx, -46, 74);
  const { rig } = stack;

  /* ---- aura ---- */
  const aura = softGlow(scene, 62, M.glow, 0.55);
  aura.setPosition(0, -46);
  rig.add(aura);

  /* ---- tail ---- */
  const tail = scene.add.container(-30, -30);
  const tailGlow = softGlow(scene, 15, M.glow, 0.8);
  {
    const g = scene.add.graphics();
    g.fillStyle(M.bodyShade, 1);
    g.fillPoints(bladePoints(2, 2, -14, -4, -26, -16, 20), true);
    g.fillStyle(M.body, 1);
    g.fillPoints(bladePoints(0, 0, -14, -6, -25, -18, 17), true);
    tailGlow.setPosition(-25, -18);
    const tip = scene.add.graphics();
    tip.fillStyle(M.bulb, 1);
    tip.fillCircle(-25, -18, 7);
    tail.add([g, tailGlow, tip]);
  }
  rig.add(tail);

  /* ---- antenna-ears ---- */
  const mkEar = (side: 1 | -1): { c: Phaser.GameObjects.Container; glow: Phaser.GameObjects.Container } => {
    const c = scene.add.container(side * 15, -74);
    const g = scene.add.graphics();
    g.fillStyle(M.bodyShade, 1);
    g.fillPoints(bladePoints(side * 1, 2, side * 9, -20, side * 15, -44, 15), true);
    g.fillStyle(M.earStalk, 1);
    g.fillPoints(bladePoints(0, 0, side * 8, -21, side * 14, -45, 13), true);
    g.fillStyle(mix(M.bodyLight, 0xffffff, 0.2), 0.75);
    g.fillPoints(bladePoints(side * -1, -2, side * 6, -22, side * 12, -44, 5), true);
    const glow = softGlow(scene, 22, M.glow, 0.75);
    glow.setPosition(side * 14, -46);
    const bulb = scene.add.graphics();
    bulb.fillStyle(M.bulb, 1);
    bulb.fillCircle(side * 14, -46, 9);
    bulb.fillStyle(0xffffff, 0.9);
    bulb.fillCircle(side * 12, -49, 3.4);
    c.add([g, glow, bulb]);
    return { c, glow };
  };
  const ear1 = mkEar(-1);
  const ear2 = mkEar(1);
  rig.add([ear1.c, ear2.c]);

  /* ---- arms ---- */
  const mkArm = (side: 1 | -1): Phaser.GameObjects.Container => {
    const c = scene.add.container(side * 36, -50);
    const g = scene.add.graphics();
    g.fillStyle(M.bodyShade, 1);
    g.fillPoints(bladePoints(0, 0, side * 6, 10, side * 7, 20, 15), true);
    g.fillStyle(M.body, 1);
    g.fillPoints(bladePoints(side * -1, -1, side * 5, 9, side * 6, 19, 13), true);
    g.fillStyle(M.paw, 1);
    g.fillCircle(side * 7, 21, 8);
    g.fillStyle(mix(M.paw, 0xffffff, 0.35), 0.8);
    g.fillCircle(side * 5, 19, 3.2);
    c.add(g);
    return c;
  };
  const armL = mkArm(-1);
  const armR = mkArm(1);

  /* ---- feet ---- */
  const feet = scene.add.graphics();
  feet.fillStyle(M.bodyShade, 1);
  feet.fillPoints(ellipsePoints(-16, -5, 14, 9, -0.1, 20), true);
  feet.fillPoints(ellipsePoints(16, -5, 14, 9, 0.1, 20), true);
  feet.fillStyle(M.paw, 1);
  feet.fillPoints(ellipsePoints(-16, -7, 13, 8, -0.1, 20), true);
  feet.fillPoints(ellipsePoints(16, -7, 13, 8, 0.1, 20), true);
  rig.add(feet);
  rig.add([armL, armR]);

  /* ---- body ---- */
  const bodyG = scene.add.graphics();
  bodyG.fillStyle(M.bodyShade, 1);
  bodyG.fillPoints(ellipsePoints(0, -42, 43, 41, 0, 34), true);
  bodyG.fillStyle(M.body, 1);
  bodyG.fillPoints(ellipsePoints(0, -46, 42, 40, 0, 34), true);
  bodyG.fillStyle(M.bellyShade, 1);
  bodyG.fillPoints(ellipsePoints(0, -32, 27, 23, 0, 28), true);
  bodyG.fillStyle(M.belly, 1);
  bodyG.fillPoints(ellipsePoints(0, -34, 26, 22, 0, 28), true);
  bodyG.fillStyle(mix(M.bodyLight, 0xffffff, 0.25), 0.7);
  bodyG.fillPoints(ellipsePoints(-16, -68, 17, 8, -0.35, 22), true);
  rig.add(bodyG);

  /* ---- face ---- */
  const face = scene.add.container(0, -58);
  const eyeL = makeEye(scene, -17, 0, 12.5, 14.5, M.eyeWhite, M.iris, 9, M.body, M.bodyShade);
  const eyeR = makeEye(scene, 17, 0, 12.5, 14.5, M.eyeWhite, M.iris, 9, M.body, M.bodyShade);
  const eyes = [eyeL, eyeR];
  const mouthG = scene.add.graphics();
  face.add([eyeL.container, eyeR.container, mouthG]);
  rig.add(face);

  const drawMouth = (shape: MouthShape): void => {
    mouthG.clear();
    mouthG.lineStyle(3.4, M.mouth, 1);
    switch (shape) {
      case 'smile':
        mouthG.beginPath(); mouthG.arc(0, 20, 8, 0.18 * Math.PI, 0.82 * Math.PI); mouthG.strokePath();
        break;
      case 'bigSmile':
        mouthG.lineStyle(4, M.mouth, 1);
        mouthG.beginPath(); mouthG.arc(0, 17, 12, 0.12 * Math.PI, 0.88 * Math.PI); mouthG.strokePath();
        break;
      case 'openHappy':
        mouthG.fillStyle(M.mouth, 1);
        mouthG.fillPoints(ellipsePoints(0, 24, 11, 9, 0, 20, 0, Math.PI).concat([pt(-11, 24)]), true);
        mouthG.fillStyle(M.tongue, 1);
        mouthG.fillPoints(ellipsePoints(0, 30, 6, 4, 0, 16), true);
        break;
      case 'o':
        mouthG.fillStyle(M.mouth, 1);
        mouthG.fillPoints(ellipsePoints(0, 22, 5.4, 6.4, 0, 18), true);
        break;
      case 'wavy':
        mouthG.beginPath();
        mouthG.strokePoints([pt(-10, 22), pt(-5, 18), pt(0, 23), pt(5, 18), pt(10, 22)], false);
        break;
      case 'frown':
        mouthG.beginPath(); mouthG.arc(0, 30, 9, 1.16 * Math.PI, 1.84 * Math.PI); mouthG.strokePath();
        break;
      case 'smirk':
        mouthG.beginPath(); mouthG.moveTo(-4, 22); mouthG.lineTo(9, 20); mouthG.strokePath();
        break;
      default:
        mouthG.beginPath(); mouthG.moveTo(-8, 21); mouthG.lineTo(8, 21); mouthG.strokePath();
    }
  };

  /* ---- state ---- */
  let mood: Mood = 'idle';
  let facing: 1 | -1 = 1;
  let bounce: Phaser.Tweens.Tween | undefined;
  let earGlowTween: Phaser.Tweens.Tween | undefined;
  let tremble: Phaser.Tweens.Tween | undefined;

  const setBounce = (amount: number): void => {
    bounce?.remove();
    bounce = scene.tweens.add({
      targets: stack.floater,
      y: { from: 46, to: 46 - 4.5 * amount },
      duration: Math.round(1500 / clamp(amount, 0.4, 2)),
      yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
    stack.keep(bounce);
  };

  const setEarGlow = (level: number): void => {
    earGlowTween?.remove();
    earGlowTween = scene.tweens.add({
      targets: [ear1.glow, ear2.glow, tailGlow],
      alpha: { from: level * 0.45, to: level },
      scale: { from: 0.88, to: 1.16 },
      duration: 1250, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
    stack.keep(earGlowTween);
  };

  stack.keep(scene.tweens.add({
    targets: aura, scale: { from: 0.92, to: 1.14 },
    duration: 2200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
  }));
  stack.keep(scene.tweens.add({
    targets: [eyeL.glint, eyeR.glint],
    alpha: { from: 0.35, to: 0.85 }, scale: { from: 0.85, to: 1.2 },
    duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
  }));

  const blinkTimer = scene.time.addEvent({
    delay: 1800, loop: true,
    callback: () => {
      if (Math.random() > 0.5) return;
      const rest = MIMO_MOODS[mood].lid;
      setLid(eyes, 1, scene, 60);
      scene.time.delayedCall(130, () => setLid(eyes, rest, scene, 110));
    },
  });
  stack.keep(blinkTimer);

  const applyMood = (m: Mood): void => {
    mood = m;
    const s = MIMO_MOODS[m] ?? MIMO_MOODS.idle;
    scene.tweens.add({ targets: ear1.c, rotation: s.earL, scaleY: s.earScale, duration: 320, ease: 'Back.easeOut' });
    scene.tweens.add({ targets: ear2.c, rotation: s.earR, scaleY: s.earScale, duration: 320, ease: 'Back.easeOut' });
    scene.tweens.add({ targets: rig, rotation: s.tilt, y: s.lift, scaleY: s.squash, duration: 300, ease: 'Sine.easeOut' });
    scene.tweens.add({
      targets: [eyeL.container, eyeR.container], scale: s.eyeScale, duration: 260, ease: 'Back.easeOut',
    });
    scene.tweens.add({ targets: [eyeL.iris, eyeR.iris], y: s.irisY, duration: 260, ease: 'Sine.easeOut' });
    scene.tweens.add({ targets: aura, alpha: s.glow, duration: 320 });
    scene.tweens.add({ targets: tail, rotation: s.lift > 0 ? 0.4 : -0.1, duration: 320, ease: 'Sine.easeOut' });
    setLid(eyes, s.lid, scene, 200);
    drawMouth(s.mouth);
    setEarGlow(clamp(s.glow + 0.1, 0.2, 1));
    setBounce(s.bounce);

    tremble?.remove();
    tremble = undefined;
    if (s.tremble) {
      tremble = scene.tweens.add({
        targets: rig, x: { from: -1.6, to: 1.6 }, duration: 70, yoyo: true, repeat: -1,
      });
      stack.keep(tremble);
    } else {
      rig.x = 0;
    }
  };

  applyMood('idle');

  /** Ears and arms trail behind the hop - the detail that sells the weight. */
  const hopPhase = (p: number, arc: number): void => {
    const lag = Math.sin(p * Math.PI - 0.6) * 0.4;
    const s = MIMO_MOODS[mood];
    ear1.c.rotation = s.earL - lag;
    ear2.c.rotation = s.earR + lag;
    armL.rotation = -arc * 0.7;
    armR.rotation = arc * 0.7;
    tail.rotation = -arc * 0.5;
  };

  const view: CharacterView = {
    root: stack.root,

    async moveTo(x: number, y: number, opts?: MoveOpts) {
      const tx = x * ctx.width, ty = y * ctx.height;
      const dx = tx - stack.root.x;
      const dist = Math.hypot(dx, ty - stack.root.y);
      if (dist < 2) return;
      if (Math.abs(dx) > 6) view.setFacing(dx > 0 ? 1 : -1);
      const duration = opts?.durationMs ?? clamp((dist / (300 * stack.unit)) * 1000, 420, 3200);
      const hop = opts?.hop !== false;
      const arrival = tweenPromise(scene, {
        targets: stack.root, x: tx, y: ty, duration,
        ease: hop ? 'Linear' : 'Sine.easeInOut',
      } as Phaser.Types.Tweens.TweenBuilderConfig);
      if (hop) {
        bounce?.pause();
        hopArc(stack, Math.max(1, Math.round(duration / 420)), duration, 42, hopPhase);
      }
      await arrival;
      bounce?.resume();
      applyMood(mood);
    },

    setMood(m: Mood) { applyMood(m); },

    async pointAt(x: number, y: number) {
      const tx = x * ctx.width;
      if (Math.abs(tx - stack.root.x) > 6) view.setFacing(tx > stack.root.x ? 1 : -1);
      const high = y * ctx.height < stack.root.y - 100;
      await tweenPromise(scene, {
        targets: armR, rotation: high ? -2.5 : -1.95, duration: 260, ease: 'Back.easeOut',
      } as Phaser.Types.Tweens.TweenBuilderConfig);
      scene.tweens.add({ targets: rig, rotation: 0.1, duration: 220, ease: 'Sine.easeOut' });
      await wait(scene, 700);
      scene.tweens.add({ targets: rig, rotation: MIMO_MOODS[mood].tilt, duration: 220 });
      await tweenPromise(scene, {
        targets: armR, rotation: 0, duration: 240, ease: 'Sine.easeInOut',
      } as Phaser.Types.Tweens.TweenBuilderConfig);
    },

    async celebrate() {
      applyMood('excited');
      bounce?.pause();
      scene.tweens.add({ targets: [armL, armR], rotation: { from: 0, to: -2.2 }, duration: 220, ease: 'Back.easeOut', yoyo: true, hold: 700 });
      const spin = scene.tweens.add({
        targets: stack.spinner, rotation: { from: 0, to: TAU * facing },
        duration: 780, ease: 'Cubic.easeInOut',
        onComplete: () => stack.spinner.setRotation(0),
      });
      stack.keep(spin);

      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU;
        const s = scene.add.image(0, -46, TEX.spark)
          .setTint(i % 2 === 0 ? M.glow : 0xffffff)
          .setBlendMode(Phaser.BlendModes.ADD).setScale(0.12);
        rig.add(s);
        scene.tweens.add({
          targets: s, x: Math.cos(a) * 88, y: -46 + Math.sin(a) * 88,
          scale: { from: 0.34, to: 0 }, alpha: { from: 1, to: 0 }, angle: 180,
          duration: 820, delay: i * 26, ease: 'Cubic.easeOut',
          onComplete: () => s.destroy(),
        });
      }

      hopArc(stack, 2, 900, 66, hopPhase);
      await wait(scene, 920);
      bounce?.resume();
      applyMood('happy');
    },

    setFacing(dir: -1 | 1) {
      if (dir === facing) return;
      facing = dir;
      scene.tweens.add({ targets: stack.flipper, scaleX: dir, duration: 180, ease: 'Sine.easeInOut' });
    },

    setVisible(v: boolean) { stack.root.setVisible(v); },
  };

  return view;
}
