import type Phaser from 'phaser';
import type { ArtContext, CharacterView, Mood, PropView } from '../art/contract';
import type {
  AnalyticsSystemApi, AudioSystemApi, CompanionSystemApi, RuntimePolicy,
} from '../engineContract';

/**
 * MIMO's brain.
 *
 * Everything that makes the companion feel like a friend rather than a UI
 * label lives here: the speech bubble that pops out of its head and types
 * itself, the mood changes, the little hop-and-point when it helps, and the
 * decision about WHETHER to help at all.
 *
 * That last one is the adaptation seam: `shouldOfferHelp` reads the live
 * policy object every time it is called, so when ClickHouse-derived evidence
 * changes `helpAfterAttempt` mid-story, Mimo's behaviour changes with it.
 */

export interface CompanionBinding {
  scene: Phaser.Scene;
  artCtx: ArtContext;
  mimo: CharacterView;
  props: Map<string, PropView>;
  /** Pixels above Mimo's origin where the bubble tail sits. */
  headOffsetY?: number;
}

export interface CompanionOptions {
  /** Read live - never snapshot the policy. */
  getPolicy: () => RuntimePolicy;
  audio: AudioSystemApi;
  analytics: AnalyticsSystemApi;
  /** Set false to force subtitles-only. */
  voice?: boolean;
}

/** Whatever the speech lane exports; called defensively. */
type SpeakFn = (text: string, opts?: Record<string, unknown>) => unknown;

const MOODS: Mood[] = [
  'idle', 'happy', 'excited', 'curious', 'surprised',
  'worried', 'scared', 'thinking', 'proud', 'sad',
];

const FONT = 'Comic Sans MS, Trebuchet MS, Verdana, sans-serif';
const BUBBLE_DEPTH = 9500;
const REVEAL_MS_PER_CHAR = 26;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function inferMood(line: string): Mood {
  if (line.includes('!')) return 'excited';
  if (line.includes('?')) return 'curious';
  if (line.includes('...')) return 'thinking';
  return 'happy';
}

/**
 * The TTS service (`src/services/tts.ts`, owned by the speech lane) is looked
 * up through import.meta.glob rather than a direct import: a glob that matches
 * nothing yields an empty map, so the game still runs - subtitles only - if
 * that module is absent. Any failure degrades silently; Mimo always gets a
 * bubble, the voice is a bonus.
 */
const TTS_MODULES = import.meta.glob([
  '../../services/tts.{ts,tsx,js}',
  '../../services/tts/index.{ts,tsx,js}',
]) as Record<string, () => Promise<unknown>>;

let injectedSpeak: SpeakFn | null = null;
let speakLoader: Promise<SpeakFn | null> | null = null;

/** Escape hatch: the speech lane can register its speaker directly. */
export function setSpeaker(fn: SpeakFn | null): void {
  injectedSpeak = fn;
  speakLoader = null;
}

function loadSpeak(): Promise<SpeakFn | null> {
  if (injectedSpeak) return Promise.resolve(injectedSpeak);
  if (!speakLoader) {
    speakLoader = (async () => {
      try {
        const key = Object.keys(TTS_MODULES)[0];
        if (!key) return null;
        const mod = await TTS_MODULES[key]();
        const fn = (mod as { speak?: unknown } | null)?.speak;
        return typeof fn === 'function' ? (fn as SpeakFn) : null;
      } catch {
        return null;
      }
    })();
  }
  return speakLoader;
}

interface ActiveLine {
  root: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Container;
  width: number;
  timers: Phaser.Time.TimerEvent[];
  close: () => void;
  closed: boolean;
}

export class CompanionSystem implements CompanionSystemApi {
  private getPolicy: () => RuntimePolicy;
  private audio: AudioSystemApi;
  private analytics: AnalyticsSystemApi;
  private voice: boolean;

  private scene: Phaser.Scene | null = null;
  private artCtx: ArtContext | null = null;
  private mimo: CharacterView | null = null;
  private props: Map<string, PropView> = new Map();
  private headOffsetY = -78;

  private active: ActiveLine | null = null;
  private followBound = false;
  private highlighted: PropView | null = null;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  private mood: Mood = 'idle';
  private ttsChecked = false;
  private ttsAvailable = false;

  constructor(opts: CompanionOptions) {
    this.getPolicy = opts.getPolicy;
    this.audio = opts.audio;
    this.analytics = opts.analytics;
    this.voice = opts.voice ?? true;
  }

  attach(binding: CompanionBinding): void {
    this.detach();
    this.scene = binding.scene;
    this.artCtx = binding.artCtx;
    this.mimo = binding.mimo;
    this.props = binding.props;
    this.headOffsetY = binding.headOffsetY ?? -78;
    this.scene.events.on('update', this.follow);
    this.followBound = true;
  }

  detach(): void {
    this.closeBubble();
    this.clearHighlight();
    if (this.scene && this.followBound) this.scene.events.off('update', this.follow);
    this.followBound = false;
    this.scene = null;
    this.artCtx = null;
    this.mimo = null;
    this.props = new Map();
  }

  /** Honest reporting for the dev view: is a voice actually available? */
  voiceStatus(): { enabled: boolean; available: boolean; detail: string } {
    if (!this.voice) return { enabled: false, available: false, detail: 'voice disabled - subtitles only' };
    if (!this.ttsChecked) return { enabled: true, available: false, detail: 'speech service not probed yet' };
    return {
      enabled: true,
      available: this.ttsAvailable,
      detail: this.ttsAvailable
        ? 'speech service loaded - Mimo speaks aloud'
        : 'no speech service available - subtitles only',
    };
  }

  /* ---------------------------------------------------------------- */
  /* Speaking                                                          */
  /* ---------------------------------------------------------------- */

  async say(line: string, opts?: { mood?: string; durationMs?: number }): Promise<void> {
    const text = (line ?? '').trim();
    if (!text) return;

    const mood = this.normaliseMood(opts?.mood) ?? inferMood(text);
    this.setMood(mood);

    this.analytics.emit('companion_spoke', {
      companion_intervention: mood,
      metadata: { line: text, voice: this.voice },
    });

    const holdMs = opts?.durationMs ?? Math.min(5200, Math.max(1500, 1100 + text.length * 55));
    const spoken = this.speakAloud(text, mood);

    // The bubble waits for the voice when there is one, but never past a cap:
    // a stuck speech engine must not stall the game.
    const held = Promise.race([
      Promise.all([delay(holdMs), spoken]).then(() => undefined),
      delay(holdMs + 2500),
    ]);

    await this.showBubble(text, held);
  }

  private speakAloud(text: string, mood: Mood): Promise<void> {
    if (!this.voice) return Promise.resolve();
    return (async () => {
      try {
        const speak = await loadSpeak();
        this.ttsChecked = true;
        this.ttsAvailable = speak !== null;
        if (!speak) return;
        await Promise.resolve(speak(text, { mood, voice: 'mimo' }));
      } catch {
        this.ttsAvailable = false;
      }
    })();
  }

  private showBubble(text: string, held: Promise<unknown>): Promise<void> {
    const scene = this.scene;
    const ctx = this.artCtx;
    if (!scene || !ctx) return held.then(() => undefined);

    this.closeBubble();

    const maxWidth = Math.min(430, Math.max(220, ctx.width * 0.34));
    const inkColor = '#2b2118';

    const label = scene.add.text(0, 0, text, {
      fontFamily: FONT,
      fontSize: '23px',
      color: inkColor,
      align: 'center',
      wordWrap: { width: maxWidth },
      lineSpacing: 5,
    });
    label.setOrigin(0.5, 0.5);

    // Size the bubble from the FULL line before revealing it, so the shape
    // never grows while the child is reading.
    const padX = 20;
    const padY = 15;
    const bw = Math.ceil(label.width) + padX * 2;
    const bh = Math.ceil(label.height) + padY * 2;
    label.setText('');

    const bubble = scene.add.graphics();
    bubble.fillStyle(0x000000, 0.16);
    bubble.fillRoundedRect(-bw / 2 + 3, -bh / 2 + 6, bw, bh, 20);
    bubble.fillStyle(0xfffaf0, 1);
    bubble.fillRoundedRect(-bw / 2, -bh / 2, bw, bh, 20);
    bubble.lineStyle(4, ctx.palette.accent, 1);
    bubble.strokeRoundedRect(-bw / 2, -bh / 2, bw, bh, 20);

    const body = scene.add.container(0, -20 - bh / 2, [bubble, label]);

    // The tail lives in the root container so it stays pinned to Mimo's head
    // even when the bubble body slides sideways to stay on screen.
    const tail = scene.add.graphics();
    tail.fillStyle(0xfffaf0, 1);
    tail.fillTriangle(0, 0, -14, -22, 14, -22);
    tail.lineStyle(4, ctx.palette.accent, 1);
    tail.beginPath();
    tail.moveTo(-14, -21);
    tail.lineTo(0, 0);
    tail.lineTo(14, -21);
    tail.strokePath();

    const anchor = this.anchorPoint();
    const root = scene.add.container(anchor.x, anchor.y, [tail, body]);
    root.setDepth(BUBBLE_DEPTH);
    root.setScale(0.15);
    root.setAlpha(0);

    const timers: Phaser.Time.TimerEvent[] = [];
    let settled = false;
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });

    const line: ActiveLine = {
      root,
      body,
      width: bw,
      timers,
      closed: false,
      close: () => {
        if (line.closed) return;
        line.closed = true;
        for (const t of timers) t.remove(false);
        if (this.active === line) this.active = null;
        if (root.scene) {
          scene.tweens.add({
            targets: root,
            scale: 0.85,
            alpha: 0,
            duration: 170,
            ease: 'Quad.easeIn',
            onComplete: () => root.destroy(),
          });
        }
        if (!settled) { settled = true; resolveDone(); }
      },
    };
    this.active = line;
    this.positionBubble(line);

    this.audio.play('tap');
    scene.tweens.add({
      targets: root,
      scale: 1,
      alpha: 1,
      duration: 300,
      ease: 'Back.easeOut',
    });

    // Progressive reveal - the line "types" itself as Mimo talks.
    const chars = Array.from(text);
    let shown = 0;
    timers.push(scene.time.addEvent({
      delay: REVEAL_MS_PER_CHAR,
      repeat: chars.length - 1,
      callback: () => {
        shown += 1;
        if (label.scene) label.setText(chars.slice(0, shown).join(''));
      },
    }));

    void held.then(() => {
      if (label.scene && shown < chars.length) label.setText(text);
      line.close();
    });

    return done;
  }

  private anchorPoint(): { x: number; y: number } {
    const mimo = this.mimo;
    const ctx = this.artCtx;
    if (!mimo) return { x: (ctx?.width ?? 1280) / 2, y: (ctx?.height ?? 720) / 2 };
    return { x: mimo.root.x, y: mimo.root.y + this.headOffsetY };
  }

  /** Keeps the tail on Mimo while sliding the body to stay fully on screen. */
  private positionBubble(line: ActiveLine): void {
    const ctx = this.artCtx;
    if (!ctx) return;
    const anchor = this.anchorPoint();
    line.root.x = anchor.x;
    line.root.y = anchor.y;

    const half = line.width / 2;
    const margin = 16;
    const clampedCentre = Math.min(ctx.width - margin - half, Math.max(margin + half, anchor.x));
    const maxShift = Math.max(0, half - 26);
    line.body.x = Math.min(maxShift, Math.max(-maxShift, clampedCentre - anchor.x));
  }

  private follow = (): void => {
    if (this.active && !this.active.closed) this.positionBubble(this.active);
  };

  private closeBubble(): void {
    this.active?.close();
    this.active = null;
  }

  /* ---------------------------------------------------------------- */
  /* Helping                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * THE ADAPTATION SEAM. Reads the live policy every call - never a constant.
   */
  shouldOfferHelp(attempts: number): boolean {
    const policy = this.getPolicy();
    if (policy.interventionStyle === 'none') return false;
    return attempts >= policy.helpAfterAttempt;
  }

  async hintAt(propId: string): Promise<void> {
    const policy = this.getPolicy();
    const prop = this.props.get(propId);
    const ctx = this.artCtx;
    const mimo = this.mimo;

    this.analytics.emit('hint_offered', {
      companion_intervention: policy.interventionStyle,
      metadata: { prop_id: propId, found: Boolean(prop), source: policy.source },
    });

    if (!prop || !ctx || !mimo) return;

    const px = prop.root.x;
    const py = prop.root.y;
    const nx = px / ctx.width;
    const ny = py / ctx.height;

    // Stand on whichever side keeps Mimo inside the frame.
    const side = nx > 0.5 ? -1 : 1;
    const standX = Math.min(0.92, Math.max(0.08, nx + side * 0.12));
    const standY = Math.min(0.9, Math.max(0.25, ny + 0.08));

    this.setMood('curious');
    this.audio.play('hop');
    await mimo.moveTo(standX, standY, { hop: true });
    mimo.setFacing(side === 1 ? 1 : -1);
    await mimo.pointAt(nx, ny);

    this.clearHighlight();
    prop.highlight(true);
    this.highlighted = prop;
    this.audio.play('sparkle');
    this.highlightTimer = setTimeout(() => this.clearHighlight(), 2800);
  }

  private clearHighlight(): void {
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = null;
    this.highlighted?.highlight(false);
    this.highlighted = null;
  }

  /* ---------------------------------------------------------------- */
  /* Movement and mood                                                 */
  /* ---------------------------------------------------------------- */

  async moveTo(x: number, y: number): Promise<void> {
    if (!this.mimo) return;
    this.audio.play('hop');
    await this.mimo.moveTo(x, y, { hop: true });
  }

  setMood(mood: string): void {
    const m = this.normaliseMood(mood) ?? 'happy';
    this.mood = m;
    this.mimo?.setMood(m);
  }

  currentMood(): Mood {
    return this.mood;
  }

  private normaliseMood(mood: string | undefined): Mood | null {
    if (!mood) return null;
    return MOODS.includes(mood as Mood) ? (mood as Mood) : null;
  }
}
