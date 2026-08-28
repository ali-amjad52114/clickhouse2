import type { AdaptationPlan, InteractionType } from '../../shared/types';
import { DEFAULT_POLICY, type RuntimePolicy } from '../engineContract';

/**
 * Pulls the behavioural policy the server derived from stored ClickHouse
 * evidence and applies it to the running game.
 *
 * Truth rules:
 *  - `source` is only ever 'clickhouse' when the server says the policy is
 *    backed by real rows. A default policy is never dressed up as a learned one.
 *  - Nothing here invents thresholds. If the endpoint is missing, unreachable
 *    or returns a shape we do not recognise, we fall back to DEFAULT_POLICY and
 *    say so in `status().detail`.
 *
 * The policy object is MUTATED IN PLACE on refresh, so anything holding a
 * reference (EngineContext.policy, CompanionSystem) sees the new values
 * without being rebuilt. This is the adaptation seam.
 */

export type AdaptationState = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface AdaptationStatus {
  state: AdaptationState;
  source: 'default' | 'clickhouse';
  detail: string;
  fetchedAt: string | null;
  endpoint: string;
}

export interface AdaptationOptions {
  childId: string;
  /** Defaults to `/api/profile/:childId/policy`. */
  endpoint?: string;
}

const STYLES = ['visual_hint', 'spoken_hint', 'none'] as const;
const INTERACTIONS: InteractionType[] = [
  'tap_target', 'choose_object', 'drag_drop', 'collect_items',
  'path_choice', 'reading_choice', 'simple_character_action',
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asStyle(v: unknown): RuntimePolicy['interventionStyle'] | null {
  return typeof v === 'string' && (STYLES as readonly string[]).includes(v)
    ? (v as RuntimePolicy['interventionStyle'])
    : null;
}

function asInteraction(v: unknown): InteractionType | null {
  return typeof v === 'string' && (INTERACTIONS as string[]).includes(v) ? (v as InteractionType) : null;
}

function asPlan(v: unknown): AdaptationPlan | null {
  if (!isRecord(v)) return null;
  if (typeof v.applied !== 'boolean') return null;
  const words = Array.isArray(v.injectedWords) ? v.injectedWords : [];
  return {
    applied: v.applied,
    reason: typeof v.reason === 'string' ? v.reason : '',
    targetPattern: typeof v.targetPattern === 'string' ? v.targetPattern : null,
    preferredInteraction: asInteraction(v.preferredInteraction),
    helpAfterAttempt:
      typeof v.helpAfterAttempt === 'number' && Number.isFinite(v.helpAfterAttempt)
        ? Math.min(6, Math.max(1, Math.round(v.helpAfterAttempt)))
        : DEFAULT_POLICY.helpAfterAttempt,
    rewrittenNarration: typeof v.rewrittenNarration === 'string' ? v.rewrittenNarration : null,
    injectedWords: words.filter(
      (w): w is { word: string; pattern: string; decoys?: string[] } =>
        isRecord(w) && typeof w.word === 'string' && typeof w.pattern === 'string',
    ),
  };
}

export class AdaptationSystem {
  private childId: string;
  private endpoint: string;
  private live: RuntimePolicy;
  private state: AdaptationState = 'idle';
  private detail = 'using built-in defaults - no policy fetched yet';
  private fetchedAt: string | null = null;
  private listeners = new Set<(p: RuntimePolicy) => void>();
  private inflight: Promise<RuntimePolicy> | null = null;

  constructor(opts: AdaptationOptions) {
    this.childId = opts.childId;
    this.endpoint = opts.endpoint ?? `/api/profile/${encodeURIComponent(opts.childId)}/policy`;
    this.live = { ...DEFAULT_POLICY, plan: null };
  }

  /** The live object. Held by reference across refreshes - never replaced. */
  policy(): RuntimePolicy {
    return this.live;
  }

  plan(): AdaptationPlan | null {
    return this.live.plan;
  }

  status(): AdaptationStatus {
    return {
      state: this.state,
      source: this.live.source,
      detail: this.detail,
      fetchedAt: this.fetchedAt,
      endpoint: this.endpoint,
    };
  }

  onChange(cb: (p: RuntimePolicy) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  async refresh(): Promise<RuntimePolicy> {
    if (this.inflight) return this.inflight;
    this.state = 'loading';
    this.inflight = (async () => {
      try {
        const res = await fetch(this.endpoint, { headers: { accept: 'application/json' } });
        if (!res.ok) {
          this.fallback(
            res.status === 404
              ? `${this.endpoint} is not implemented on the API - using built-in defaults`
              : `policy request failed (HTTP ${res.status}) - using built-in defaults`,
          );
          return this.live;
        }
        const body: unknown = await res.json();
        this.apply(body);
      } catch (err) {
        this.fallback(
          `policy unavailable (${err instanceof Error ? err.message : String(err)}) - using built-in defaults`,
        );
      } finally {
        this.inflight = null;
      }
      return this.live;
    })();
    return this.inflight;
  }

  /** For tests and the dev view: apply a payload without a network call. */
  apply(body: unknown): RuntimePolicy {
    if (!isRecord(body)) {
      this.fallback('policy response was not an object - using built-in defaults');
      return this.live;
    }

    // Accept either the policy itself or an envelope: { policy, profile, ... }.
    const raw = isRecord(body.policy) ? body.policy : body;
    const envelope = body;

    const help = raw.helpAfterAttempt;
    const style = asStyle(raw.interventionStyle);
    const plan = asPlan(raw.plan ?? envelope.plan);

    if (typeof help !== 'number' && style === null && plan === null) {
      this.fallback('policy response had no usable fields - using built-in defaults');
      return this.live;
    }

    // Evidence gate: 'clickhouse' is only claimed when the server claims it AND
    // does not tell us the profile is empty.
    const claimed = raw.source ?? envelope.source;
    const evidence =
      envelope.hasEvidence ?? (isRecord(envelope.profile) ? envelope.profile.hasEvidence : undefined);
    const backed = claimed === 'clickhouse' && evidence !== false;

    this.live.helpAfterAttempt =
      typeof help === 'number' && Number.isFinite(help)
        ? Math.min(6, Math.max(1, Math.round(help)))
        : DEFAULT_POLICY.helpAfterAttempt;
    this.live.interventionStyle = style ?? DEFAULT_POLICY.interventionStyle;
    this.live.plan = plan;
    this.live.source = backed ? 'clickhouse' : 'default';

    this.state = 'ready';
    this.fetchedAt = new Date().toISOString();
    const serverDetail = typeof envelope.detail === 'string' ? envelope.detail : null;
    this.detail =
      serverDetail ??
      (backed
        ? `policy derived from ClickHouse evidence for ${this.childId}`
        : 'server returned a default policy - not enough evidence yet');

    this.notify();
    return this.live;
  }

  private fallback(detail: string): void {
    this.live.helpAfterAttempt = DEFAULT_POLICY.helpAfterAttempt;
    this.live.interventionStyle = DEFAULT_POLICY.interventionStyle;
    this.live.source = 'default';
    this.live.plan = null;
    this.state = 'unavailable';
    this.detail = detail;
    this.notify();
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try { cb(this.live); } catch { /* a listener must not break adaptation */ }
    }
  }
}
