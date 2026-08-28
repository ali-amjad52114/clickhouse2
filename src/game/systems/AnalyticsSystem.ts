import type { GameEvent, GameEventType } from '../../shared/types';
import type { AnalyticsFields, AnalyticsSystemApi } from '../engineContract';

/**
 * The evidence pipeline.
 *
 * Every playable moment emits a row here; those rows are the only thing the
 * profile, the teacher view and the adaptation policy are ever built from.
 * Nothing is ever synthesised - if the POST fails the batch is kept and
 * retried with backoff, and the failure is visible in `stats()`.
 *
 * Emitting is fire-and-forget: no call on this class may throw into gameplay.
 */

export interface AnalyticsOptions {
  childId: string;
  storyId: string;
  /** Reuse an id to continue a session across a page transition. */
  sessionId?: string;
  endpoint?: string;
  /** Time-based flush. */
  flushIntervalMs?: number;
  /** Size-based flush. */
  maxBatch?: number;
  /** Hard cap on retained events during an outage; oldest are dropped. */
  maxQueue?: number;
}

export interface AnalyticsStats {
  sessionId: string;
  queued: number;
  sent: number;
  failedAttempts: number;
  dropped: number;
  lastError: string | null;
  lastSentAt: string | null;
  endpoint: string;
}

const MAX_UINT8 = 255;
const MAX_UINT32 = 4294967295;

/** RFC-4122 v4. The ClickHouse column is UUID, so this must be well formed. */
function uuid(): string {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function clampInt(value: unknown, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(max, Math.max(0, n));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

export class AnalyticsSystem implements AnalyticsSystemApi {
  sessionId: string;
  childId: string;

  private storyId: string;
  private sceneId = '';
  private endpoint: string;
  private flushIntervalMs: number;
  private maxBatch: number;
  private maxQueue: number;

  private queue: GameEvent[] = [];
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 0;
  private nextAttemptAt = 0;
  private destroyed = false;

  private sent = 0;
  private dropped = 0;
  private failedAttempts = 0;
  private lastError: string | null = null;
  private lastSentAt: string | null = null;

  constructor(opts: AnalyticsOptions) {
    this.childId = opts.childId;
    this.storyId = opts.storyId;
    this.sessionId = opts.sessionId ?? uuid();
    this.endpoint = opts.endpoint ?? '/api/events';
    this.flushIntervalMs = opts.flushIntervalMs ?? 1500;
    this.maxBatch = opts.maxBatch ?? 20;
    this.maxQueue = opts.maxQueue ?? 500;

    this.timer = setInterval(() => { void this.tick(); }, this.flushIntervalMs);
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.onLeave);
      document.addEventListener('visibilitychange', this.onHide);
    }
  }

  /* ---------------------------------------------------------------- */

  setScene(sceneId: string): void {
    this.sceneId = sceneId;
  }

  setStory(storyId: string): void {
    this.storyId = storyId;
  }

  currentScene(): string {
    return this.sceneId;
  }

  emit(type: GameEventType, fields: Partial<AnalyticsFields> = {}): void {
    if (this.destroyed) return;
    try {
      const event: GameEvent = {
        event_id: uuid(),
        timestamp: new Date().toISOString(),
        session_id: this.sessionId,
        child_id: this.childId,
        story_id: this.storyId,
        scene_id: fields.scene_id ?? this.sceneId,
        event_type: type,
        interaction_type: fields.interaction_type ?? '',
        word: fields.word ?? '',
        phoneme: fields.phoneme ?? '',
        correct: fields.correct === undefined ? null : fields.correct,
        attempt_number: clampInt(fields.attempt_number, MAX_UINT8),
        response_time_ms: clampInt(fields.response_time_ms, MAX_UINT32),
        hint_used: fields.hint_used ?? false,
        companion_intervention: fields.companion_intervention ?? '',
        metadata: safeJson(fields.metadata),
      };

      this.queue.push(event);
      if (this.queue.length > this.maxQueue) {
        this.dropped += this.queue.length - this.maxQueue;
        this.queue = this.queue.slice(-this.maxQueue);
      }
      if (this.queue.length >= this.maxBatch) void this.tick();
    } catch (err) {
      // Emitting must never reach gameplay, even if something above throws.
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Sends everything currently queued. Used at scene ends and story end. */
  async flush(): Promise<void> {
    if (this.destroyed) return;
    this.backoffMs = 0;
    this.nextAttemptAt = 0;
    for (let pass = 0; pass < 6; pass += 1) {
      if (this.inflight) await this.inflight;
      if (this.queue.length === 0) return;
      const before = this.queue.length;
      await this.send();
      // Stop looping if a failure put the batch straight back.
      if (this.queue.length >= before) return;
    }
  }

  stats(): AnalyticsStats {
    return {
      sessionId: this.sessionId,
      queued: this.queue.length,
      sent: this.sent,
      failedAttempts: this.failedAttempts,
      dropped: this.dropped,
      lastError: this.lastError,
      lastSentAt: this.lastSentAt,
      endpoint: this.endpoint,
    };
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.onLeave);
      document.removeEventListener('visibilitychange', this.onHide);
    }
    await this.flush().catch(() => undefined);
    this.destroyed = true;
  }

  /* ---------------------------------------------------------------- */
  /* Transport                                                         */
  /* ---------------------------------------------------------------- */

  private async tick(): Promise<void> {
    if (this.destroyed || this.inflight || this.queue.length === 0) return;
    if (Date.now() < this.nextAttemptAt) return;
    await this.send();
  }

  private send(): Promise<void> {
    if (this.inflight) return this.inflight;
    const batch = this.queue.splice(0, this.maxBatch);
    if (batch.length === 0) return Promise.resolve();

    const run = (async () => {
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ events: batch }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
        this.sent += batch.length;
        this.lastSentAt = new Date().toISOString();
        this.lastError = null;
        this.backoffMs = 0;
        this.nextAttemptAt = 0;
      } catch (err) {
        // Keep the evidence. Put it back at the front so order is preserved.
        this.queue = [...batch, ...this.queue];
        if (this.queue.length > this.maxQueue) {
          this.dropped += this.queue.length - this.maxQueue;
          this.queue = this.queue.slice(-this.maxQueue);
        }
        this.failedAttempts += 1;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.backoffMs = this.backoffMs === 0 ? 1000 : Math.min(this.backoffMs * 2, 15000);
        this.nextAttemptAt = Date.now() + this.backoffMs;
      } finally {
        this.inflight = null;
      }
    })();

    this.inflight = run;
    return run;
  }

  /** Last-chance delivery when the tab goes away; fetch would be cancelled. */
  private beacon(): void {
    if (this.queue.length === 0) return;
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
    try {
      const body = new Blob([JSON.stringify({ events: this.queue })], { type: 'application/json' });
      if (navigator.sendBeacon(this.endpoint, body)) {
        this.sent += this.queue.length;
        this.lastSentAt = new Date().toISOString();
        this.queue = [];
      }
    } catch {
      // Keep the queue; nothing else we can do on the way out.
    }
  }

  private onLeave = (): void => { this.beacon(); };

  private onHide = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.beacon();
  };
}
