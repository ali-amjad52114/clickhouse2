import type { ProgressSystemApi } from '../engineContract';

/**
 * "How far has this child got in this book" - the relational half of the data
 * story (ClickHouse answers what happened, this answers what is true now).
 *
 * Saving is fire-and-forget and debounced. A failed save is recorded honestly
 * in `status()` so the dev view can say "progress is not persisting" instead
 * of pretending it saved.
 */

export interface ProgressOptions {
  childId: string;
  storyId: string;
  totalScenes: number;
  /** Running star total, read at save time. */
  getStars: () => number;
  endpoint?: string;
  /** Scene ids already completed in an earlier session. */
  completed?: string[];
  debounceMs?: number;
}

export type ProgressSaveState = 'idle' | 'saving' | 'saved' | 'endpoint_missing' | 'error';

export interface ProgressStatus {
  state: ProgressSaveState;
  detail: string;
  lastSavedAt: string | null;
  endpoint: string;
  scenesCompleted: number;
  totalScenes: number;
}

export interface ProgressSnapshot {
  childId: string;
  storyId: string;
  currentScene: string | null;
  scenesDone: number;
  stars: number;
  completedScenes: string[];
}

export class ProgressSystem implements ProgressSystemApi {
  private childId: string;
  private storyId: string;
  private total: number;
  private getStars: () => number;
  private endpoint: string;
  private debounceMs: number;

  private completed: string[];
  private current: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private pending = false;

  private state: ProgressSaveState = 'idle';
  private detail = 'no progress saved yet this session';
  private lastSavedAt: string | null = null;

  constructor(opts: ProgressOptions) {
    this.childId = opts.childId;
    this.storyId = opts.storyId;
    this.total = Math.max(0, opts.totalScenes);
    this.getStars = opts.getStars;
    this.endpoint = opts.endpoint ?? '/api/progress';
    this.debounceMs = opts.debounceMs ?? 400;
    this.completed = [...new Set(opts.completed ?? [])];
  }

  markSceneComplete(sceneId: string): void {
    if (!sceneId) return;
    if (!this.completed.includes(sceneId)) this.completed.push(sceneId);
    this.current = sceneId;
    this.save();
  }

  setCurrentScene(sceneId: string): void {
    this.current = sceneId;
  }

  currentScene(): string | null {
    return this.current;
  }

  scenesCompleted(): number {
    return this.completed.length;
  }

  totalScenes(): number {
    return this.total;
  }

  completedScenes(): string[] {
    return [...this.completed];
  }

  /** 0..1, for progress dots / the storybook spine. */
  fraction(): number {
    return this.total === 0 ? 0 : Math.min(1, this.completed.length / this.total);
  }

  snapshot(): ProgressSnapshot {
    return {
      childId: this.childId,
      storyId: this.storyId,
      currentScene: this.current,
      scenesDone: this.completed.length,
      stars: this.getStars(),
      completedScenes: this.completedScenes(),
    };
  }

  /** Debounced, never blocks play, never throws. */
  save(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.post();
    }, this.debounceMs);
  }

  /** Awaitable variant for story end / unmount. */
  async saveNow(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.post();
  }

  status(): ProgressStatus {
    return {
      state: this.state,
      detail: this.detail,
      lastSavedAt: this.lastSavedAt,
      endpoint: this.endpoint,
      scenesCompleted: this.completed.length,
      totalScenes: this.total,
    };
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async post(): Promise<void> {
    if (this.inflight) { this.pending = true; return; }
    this.inflight = true;
    this.state = 'saving';
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.snapshot()),
      });
      if (res.status === 404) {
        this.state = 'endpoint_missing';
        this.detail = `${this.endpoint} is not implemented on the API - progress is in memory only`;
      } else if (!res.ok) {
        this.state = 'error';
        this.detail = `save failed: HTTP ${res.status}`;
      } else {
        this.state = 'saved';
        this.lastSavedAt = new Date().toISOString();
        this.detail = `saved ${this.completed.length}/${this.total} scenes`;
      }
    } catch (err) {
      this.state = 'error';
      this.detail = `save failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.inflight = false;
      if (this.pending) {
        this.pending = false;
        this.save();
      }
    }
  }
}
