import Phaser from 'phaser';
import type { Interaction, ReadingChoiceInteraction, ReadingWord } from '../../shared/types';
import type { EngineContext, InteractionModule, InteractionResult } from '../engineContract';
import {
  isSpeechAvailable, listenForWord, speechSupport, stopListening,
} from '../../services/speech';
import type { SpeechAttempt, SpeechUnavailableReason } from '../../services/speech';
import {
  Beat, Cleanup, DEPTH, STORY_FONT, css, normalizer,
  offerHelpIfPolicySays, promptBanner, saySafely, tweenNow, wait,
} from './base';

/** After this many honest failures Mimo reads it WITH the child and we move on. */
const TOGETHER_AFTER = 3;
/** Speech is given this long before we stop waiting and offer tapping instead. */
const LISTEN_TIMEOUT_MS = 7000;

/**
 * Reasons that will not fix themselves by asking again. When one of these
 * comes back we stop pretending speech is an option and switch the whole
 * beat to tapping.
 */
const PERMANENT_FALLBACK: ReadonlySet<SpeechUnavailableReason> = new Set([
  'no_api', 'insecure_context', 'permission_denied', 'no_microphone', 'start_failed',
]);

type Outcome = 'succeeded' | 'failed' | 'together';

/**
 * READING CHOICE - the moment the game learns to read the child.
 *
 * Mimo asks for help with a word. The word appears big and beautiful, with the
 * phonics pattern lit up. The child says it (if speech works here) or taps it
 * among decoys. Every attempt is recorded with the word AND its pattern, which
 * is what the whole ClickHouse profile is later built from.
 *
 * It must never turn into a spelling test: nothing is timed, retries are
 * unlimited, and if a word is genuinely too hard Mimo reads it together with
 * the child and the adventure continues. That last case is logged as a failure
 * - we tell the truth about what happened, we just do not punish it.
 */
export class ReadingChoice implements InteractionModule {
  readonly type = 'reading_choice' as const;

  private cleanup = new Cleanup();
  private cancelled = false;
  private cardCleanup: Cleanup | null = null;
  private stage: Phaser.GameObjects.Container | null = null;
  private listening = new AbortController();
  /** Flips permanently once the device tells us speech is not going to work. */
  private speechDead = false;

  async run(ctx: EngineContext, config: Interaction): Promise<InteractionResult> {
    const cfg = config as ReadingChoiceInteraction;
    const beat = new Beat(ctx, this.type);

    beat.emit('interaction_started', {
      metadata: {
        words: cfg.words.map((w) => w.word),
        patterns: cfg.words.map((w) => w.pattern),
      },
    });

    if (cfg.words.length === 0) {
      beat.emit('interaction_completed', { correct: null, metadata: { reason: 'no_words' } });
      return beat.result();
    }

    promptBanner(ctx, this.cleanup, cfg.prompt);

    // Ask the speech service what is actually true on this device. We never
    // show a listening state we cannot back up.
    const support = speechSupport();
    const speechOn = isSpeechAvailable();
    beat.emit('companion_spoke', {
      companion_intervention: speechOn ? 'speech_input_available' : 'tap_input_only',
      metadata: {
        mode: speechOn ? 'speech' : 'tap',
        speech_api: support.api,
        secure_context: support.secureContext,
        detail: support.detail,
      },
    });

    let succeeded = 0;
    for (let i = 0; i < cfg.words.length; i++) {
      if (this.cancelled) break;
      const outcome = await this.playWord(ctx, beat, cfg.words[i], i, cfg.words.length, speechOn);
      if (outcome === 'succeeded') succeeded += 1;
    }

    beat.completed = !this.cancelled;
    beat.emit('interaction_completed', {
      correct: succeeded === cfg.words.length,
      metadata: {
        words_total: cfg.words.length,
        words_read: succeeded,
        wrong_choices: beat.wrongChoices,
        mode: speechOn ? 'speech' : 'tap',
      },
    });
    return beat.result();
  }

  /* ------------------------------ one word ----------------------------- */

  private async playWord(
    ctx: EngineContext,
    beat: Beat,
    entry: ReadingWord,
    index: number,
    total: number,
    speechOn: boolean,
  ): Promise<Outcome> {
    const { width, height } = ctx.artCtx;
    this.stage = this.cleanup.own(ctx.scene.add.container(width / 2, height * 0.42));
    this.stage.setDepth(DEPTH.card);

    const letters = this.showWord(ctx, this.stage, entry);

    beat.mark();
    beat.emit('word_presented', {
      word: entry.word,
      phoneme: entry.pattern,
      correct: null,
      metadata: { index, of: total, mode: speechOn ? 'speech' : 'tap' },
    });

    await saySafely(
      ctx,
      index === 0 ? 'Can you help me read this?' : 'Ooh - what about this one?',
      'curious',
    );

    let wordAttempts = 0;
    // Once the device has told us speech will not work, we never open the
    // microphone again for the rest of this beat.
    let mode: 'speech' | 'tap' = speechOn && !this.speechDead ? 'speech' : 'tap';
    let outcome: Outcome = 'failed';

    while (!this.cancelled) {
      wordAttempts += 1;
      beat.attempts += 1;

      const heard = mode === 'speech'
        ? await this.attemptBySpeech(ctx, entry, beat, wordAttempts)
        : await this.attemptByTapping(ctx, entry, beat, wordAttempts);

      if (heard === 'cancelled') { outcome = 'failed'; break; }

      if (heard === 'correct') {
        beat.emit('word_succeeded', {
          word: entry.word,
          phoneme: entry.pattern,
          correct: true,
          response_time_ms: beat.sinceMark(),
          metadata: { attempts_for_word: wordAttempts, mode, index },
        });
        ctx.systems.audio.play('correct');
        ctx.mimo.setMood('proud');
        await this.celebrateWord(ctx, letters);
        outcome = 'succeeded';
        break;
      }

      if (heard === 'no_response') {
        // Silence is not a wrong answer. Offer the tapping route instead.
        mode = 'tap';
        await saySafely(ctx, "I couldn't hear that one. Can you show me instead?", 'curious');
        continue;
      }

      // A real, honest miss.
      beat.wrongChoices += 1;
      beat.emit('word_failed', {
        word: entry.word,
        phoneme: entry.pattern,
        correct: false,
        response_time_ms: beat.sinceMark(),
        metadata: { attempts_for_word: wordAttempts, mode, index },
      });
      ctx.systems.audio.play('tap');
      ctx.mimo.setMood('curious');
      await this.wobbleWord(ctx, letters);
      await saySafely(ctx, ctx.storyScene.companion.retry, 'curious');

      const offered = await offerHelpIfPolicySays(ctx, beat, null);
      if (offered) this.lightThePattern(ctx, letters, entry);

      // Two honest speech misses is enough; tapping keeps the child moving.
      if (mode === 'speech' && (wordAttempts >= 2 || this.speechDead)) mode = 'tap';

      if (wordAttempts >= TOGETHER_AFTER) {
        await this.readTogether(ctx, beat, entry, letters, wordAttempts);
        outcome = 'together';
        break;
      }
    }

    await this.clearWord(ctx);
    return outcome;
  }

  /* ----------------------------- attempting ---------------------------- */

  private async attemptBySpeech(
    ctx: EngineContext, entry: ReadingWord, beat: Beat, attemptForWord: number,
  ): Promise<'correct' | 'wrong' | 'no_response' | 'cancelled'> {
    const pulse = this.listeningPulse(ctx);
    let attempt: SpeechAttempt | null = null;
    try {
      attempt = await Promise.race([
        listenForWord(entry.word, {
          timeoutMs: LISTEN_TIMEOUT_MS,
          // Decoys let the service score "read the wrong word" honestly
          // instead of calling it noise.
          decoys: entry.decoys,
          signal: this.listening.signal,
          onSpeechStart: () => pulse.heard(),
        }),
        // Safety net only: listenForWord is documented never to reject, but a
        // child must never be left staring at a frozen listening ring.
        this.timeout(ctx, LISTEN_TIMEOUT_MS + 4000),
      ]);
    } catch {
      attempt = null;
    } finally {
      pulse.stop();
    }

    if (this.cancelled) return 'cancelled';

    const verdict = interpretSpeech(attempt);
    const reason = attempt?.reason ?? null;
    if (reason && PERMANENT_FALLBACK.has(reason)) this.speechDead = true;

    const evidence: Record<string, unknown> = {
      mode: 'speech',
      attempts_for_word: attemptForWord,
      heard: attempt?.heard ?? '',
      match_confidence: attempt?.confidence ?? null,
      match_tier: attempt?.tier ?? null,
      edit_distance: attempt?.distance ?? null,
      recogniser_confidence: attempt?.recognitionConfidence ?? null,
      alternatives: attempt?.alternatives ?? [],
      speech_method: attempt?.method ?? 'unavailable',
      reason,
      detail: attempt?.detail ?? 'no result returned',
    };

    if (verdict === 'no_response') {
      // Logged with correct = null: an attempt whose outcome we genuinely do
      // not know. Scoring it either way would poison the reading profile.
      beat.emit('word_attempted', {
        word: entry.word,
        phoneme: entry.pattern,
        correct: null,
        response_time_ms: beat.sinceMark(),
        metadata: evidence,
      });
      return 'no_response';
    }

    beat.emit('word_attempted', {
      word: entry.word,
      phoneme: entry.pattern,
      correct: verdict === 'correct',
      response_time_ms: beat.sinceMark(),
      metadata: evidence,
    });
    return verdict;
  }

  private async attemptByTapping(
    ctx: EngineContext, entry: ReadingWord, beat: Beat, attemptForWord: number,
  ): Promise<'correct' | 'wrong' | 'cancelled'> {
    const options = Phaser.Utils.Array.Shuffle([
      entry.word,
      ...(entry.decoys ?? []).slice(0, 3),
    ]);
    if (options.length < 2) {
      // Nothing to choose between: treat the tap as the read.
      options.push(entry.word.split('').reverse().join(''));
    }

    const picked = await this.showCards(ctx, options);
    if (picked === null) return 'cancelled';

    const correct = normalise(picked) === normalise(entry.word);
    beat.emit('word_attempted', {
      word: entry.word,
      phoneme: entry.pattern,
      correct,
      response_time_ms: beat.sinceMark(),
      metadata: { mode: 'tap', attempts_for_word: attemptForWord, chose: picked, options },
    });
    return correct ? 'correct' : 'wrong';
  }

  /* ------------------------------ visuals ------------------------------ */

  /** The word, big and beautiful, with the phonics pattern lit up. */
  private showWord(
    ctx: EngineContext, stage: Phaser.GameObjects.Container, entry: ReadingWord,
  ): Phaser.GameObjects.Text[] {
    const { width, height, palette } = ctx.artCtx;
    const size = Math.round(Math.min(width * 0.085, height * 0.16));
    const patternAt = entry.word.toLowerCase().indexOf(entry.pattern.toLowerCase());

    const card = ctx.scene.add.graphics();
    stage.add(card);

    const letters: Phaser.GameObjects.Text[] = [];
    let totalWidth = 0;
    for (let i = 0; i < entry.word.length; i++) {
      const inPattern = patternAt >= 0 && i >= patternAt && i < patternAt + entry.pattern.length;
      const letter = ctx.scene.add.text(0, 0, entry.word[i], {
        fontFamily: STORY_FONT,
        fontSize: `${size}px`,
        color: css(inPattern ? palette.accent : palette.ink),
        fontStyle: 'bold',
      }).setOrigin(0.5);
      letters.push(letter);
      totalWidth += letter.width + size * 0.06;
    }

    let x = -totalWidth / 2;
    for (const letter of letters) {
      letter.setPosition(x + letter.width / 2, 0);
      x += letter.width + size * 0.06;
      letter.setScale(0).setAlpha(0);
      stage.add(letter);
    }

    const padX = size * 0.5;
    const padY = size * 0.4;
    card.fillStyle(palette.scrim, 0.9);
    card.fillRoundedRect(
      -totalWidth / 2 - padX, -size * 0.72 - padY,
      totalWidth + padX * 2, size * 1.44 + padY * 2, 28,
    );
    card.lineStyle(4, palette.accent, 0.5);
    card.strokeRoundedRect(
      -totalWidth / 2 - padX, -size * 0.72 - padY,
      totalWidth + padX * 2, size * 1.44 + padY * 2, 28,
    );

    // Letters arrive one at a time, like the word is being placed by hand.
    letters.forEach((letter, i) => {
      tweenNow(ctx.scene, this.cleanup, {
        targets: letter, scale: 1, alpha: 1, duration: 260,
        delay: 90 * i, ease: 'Back.easeOut',
      });
    });
    stage.setScale(0.94);
    tweenNow(ctx.scene, this.cleanup, {
      targets: stage, scale: 1, duration: 320, ease: 'Back.easeOut',
    });
    ctx.systems.audio.play('page');
    return letters;
  }

  /** The hint made visible: the pattern that matters starts pulsing. */
  private lightThePattern(
    ctx: EngineContext, letters: Phaser.GameObjects.Text[], entry: ReadingWord,
  ): void {
    const at = entry.word.toLowerCase().indexOf(entry.pattern.toLowerCase());
    if (at < 0) return;
    for (let i = at; i < at + entry.pattern.length && i < letters.length; i++) {
      tweenNow(ctx.scene, this.cleanup, {
        targets: letters[i], scale: 1.3, duration: 340,
        yoyo: true, repeat: 3, ease: 'Sine.easeInOut',
      });
    }
    ctx.systems.audio.play('sparkle');
  }

  private async celebrateWord(ctx: EngineContext, letters: Phaser.GameObjects.Text[]): Promise<void> {
    const toNorm = normalizer(ctx);
    letters.forEach((letter, i) => {
      tweenNow(ctx.scene, this.cleanup, {
        targets: letter, scale: 1.45, y: letter.y - 18, duration: 200,
        delay: i * 70, yoyo: true, ease: 'Back.easeOut',
      });
    });
    if (this.stage) {
      const n = toNorm(this.stage.x, this.stage.y);
      ctx.art.burst(ctx.artCtx, n.x, n.y, { count: 24 });
    }
    await wait(ctx, 200 + letters.length * 70, this.cleanup);
  }

  private async wobbleWord(ctx: EngineContext, letters: Phaser.GameObjects.Text[]): Promise<void> {
    letters.forEach((letter, i) => {
      const x = letter.x;
      tweenNow(ctx.scene, this.cleanup, {
        targets: letter, x: x - 7, duration: 70, delay: i * 25,
        yoyo: true, repeat: 2, ease: 'Sine.easeInOut',
        onComplete: () => letter.setX(x),
      });
    });
    await wait(ctx, 420, this.cleanup);
  }

  /** Nobody gets stuck. Mimo reads it with the child and the story goes on. */
  private async readTogether(
    ctx: EngineContext,
    beat: Beat,
    entry: ReadingWord,
    letters: Phaser.GameObjects.Text[],
    wordAttempts: number,
  ): Promise<void> {
    ctx.mimo.setMood('happy');
    await saySafely(ctx, `Let's read it together... ${entry.word}!`, 'happy');
    this.lightThePattern(ctx, letters, entry);
    letters.forEach((letter, i) => {
      tweenNow(ctx.scene, this.cleanup, {
        targets: letter, scale: 1.35, duration: 220, delay: i * 160, yoyo: true, ease: 'Sine.easeOut',
      });
    });
    await wait(ctx, 260 + letters.length * 160, this.cleanup);
    ctx.systems.audio.play('reveal');
    // Logged as help, not as a win: the profile has to stay honest.
    beat.emit('companion_spoke', {
      word: entry.word,
      phoneme: entry.pattern,
      correct: false,
      companion_intervention: 'read_together',
      metadata: { attempts_for_word: wordAttempts, resolution: 'read_together' },
    });
  }

  private async clearWord(ctx: EngineContext): Promise<void> {
    const stage = this.stage;
    this.stage = null;
    this.cardCleanup?.run();
    this.cardCleanup = null;
    if (!stage) return;
    await new Promise<void>((resolve) => {
      if (this.cleanup.destroyed) { stage.destroy(); resolve(); return; }
      this.cleanup.track(ctx.scene.tweens.add({
        targets: stage, alpha: 0, scale: 0.9, duration: 260, ease: 'Sine.easeIn',
        onComplete: () => { stage.destroy(); resolve(); },
      }));
    });
  }

  /* ------------------------------- cards ------------------------------- */

  /** Tap-to-read fallback. Resolves with the word chosen, or null if torn down. */
  private showCards(ctx: EngineContext, options: string[]): Promise<string | null> {
    const { width, height, palette } = ctx.artCtx;
    const local = new Cleanup();
    this.cardCleanup = local;

    return new Promise<string | null>((resolve) => {
      if (this.cleanup.destroyed) { resolve(null); return; }
      let settled = false;
      const settle = (value: string | null) => {
        if (settled) return;
        settled = true;
        local.run();
        this.cardCleanup = null;
        resolve(value);
      };
      local.onDestroy(() => { if (!settled) { settled = true; resolve(null); } });

      const cardW = Math.min(width * 0.21, 300);
      const cardH = Math.max(96, height * 0.15);
      const gap = width * 0.025;
      const totalW = options.length * cardW + (options.length - 1) * gap;
      const startX = width / 2 - totalW / 2 + cardW / 2;
      const y = height * 0.74;

      options.forEach((word, i) => {
        const card = local.own(ctx.scene.add.container(startX + i * (cardW + gap), y));
        card.setDepth(DEPTH.card);

        const plate = ctx.scene.add.graphics();
        plate.fillStyle(palette.scrim, 0.94);
        plate.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 22);
        plate.lineStyle(4, palette.accent, 0.8);
        plate.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 22);
        card.add(plate);

        const label = ctx.scene.add.text(0, 0, word, {
          fontFamily: STORY_FONT,
          fontSize: `${Math.round(cardH * 0.42)}px`,
          color: css(palette.ink),
          fontStyle: 'bold',
        }).setOrigin(0.5);
        card.add(label);

        card.setInteractive(
          new Phaser.Geom.Rectangle(-cardW / 2, -cardH / 2, cardW, cardH),
          Phaser.Geom.Rectangle.Contains,
        );
        card.on('pointerdown', () => {
          ctx.systems.audio.play('tap');
          tweenNow(ctx.scene, local, {
            targets: card, scale: 0.92, duration: 90, yoyo: true, ease: 'Sine.easeOut',
            onComplete: () => settle(word),
          });
        });

        card.setAlpha(0).setY(y + 40);
        tweenNow(ctx.scene, local, {
          targets: card, alpha: 1, y, duration: 280, delay: i * 80, ease: 'Back.easeOut',
        });
        tweenNow(ctx.scene, local, {
          targets: card, scale: 1.03, duration: 1100 + i * 130,
          delay: 400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        });
      });
    });
  }

  /** A ring that breathes while the microphone is genuinely open. */
  private listeningPulse(ctx: EngineContext): { stop: () => void; heard: () => void } {
    const { width, height, palette } = ctx.artCtx;
    const local = new Cleanup();

    const ring = local.own(ctx.scene.add.graphics());
    ring.setDepth(DEPTH.card);
    ring.lineStyle(6, palette.accent, 0.85);
    ring.strokeCircle(0, 0, 46);
    ring.setPosition(width / 2, height * 0.62);
    tweenNow(ctx.scene, local, {
      targets: ring, scale: 1.5, alpha: 0.25, duration: 780,
      yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });

    const label = local.own(ctx.scene.add.text(
      width / 2, height * 0.62 + 84, 'Mimo is listening...',
      {
        fontFamily: STORY_FONT,
        fontSize: '26px',
        color: css(palette.ink),
        fontStyle: 'bold',
      },
    ).setOrigin(0.5));
    label.setDepth(DEPTH.card);

    this.cleanup.onDestroy(() => local.run());
    return {
      stop: () => local.run(),
      // Fired by the recogniser the moment it actually detects sound, so the
      // ring only reacts to a real voice.
      heard: () => {
        if (local.destroyed) return;
        label.setText('I hear you!');
        ctx.systems.audio.play('sparkle');
        tweenNow(ctx.scene, local, {
          targets: ring, scale: 1.9, duration: 220, yoyo: true, ease: 'Sine.easeOut',
        });
      },
    };
  }

  /** Resolves with null, which reads downstream as "we heard nothing". */
  private timeout(ctx: EngineContext, ms: number): Promise<null> {
    return new Promise((resolve) => {
      if (this.cleanup.destroyed) { resolve(null); return; }
      const timer = this.cleanup.time(ctx.scene.time.delayedCall(ms, () => resolve(null)));
      this.cleanup.onDestroy(() => { timer.remove(false); resolve(null); });
    });
  }

  destroy(): void {
    this.cancelled = true;
    // The microphone must never outlive the beat that opened it.
    this.listening.abort();
    try { stopListening(); } catch { /* nothing was listening */ }
    this.cardCleanup?.run();
    this.cardCleanup = null;
    this.cleanup.run();
    this.stage = null;
  }
}

/* ------------------------------------------------------------------ */
/* Speech result interpretation                                        */
/* ------------------------------------------------------------------ */

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Turn a speech attempt into one of three honest verdicts.
 *
 * The service resolves with method 'speech' ONLY when a real transcript came
 * back, so anything else is "we did not hear an answer" - never a failure the
 * child gets charged for.
 */
export function interpretSpeech(attempt: SpeechAttempt | null): 'correct' | 'wrong' | 'no_response' {
  if (!attempt) return 'no_response';
  if (attempt.method !== 'speech') return 'no_response';
  if (normalise(attempt.heard) === '') return 'no_response';
  return attempt.matched ? 'correct' : 'wrong';
}
