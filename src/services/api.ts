/**
 * Typed browser client for every `/api` route this server exposes.
 *
 * TRUTHFULNESS CONTRACT
 * ---------------------
 * This file NEVER invents data. Every function performs a real HTTP request
 * and either resolves with the server's own body or rejects with an ApiError
 * carrying the real status and the real error text. There is no mock mode, no
 * sample payload, and no "optimistic" value anywhere in here. When the API is
 * not running the callers get a rejected promise and must say so on screen.
 *
 * Analytics/profile bodies answer 200 even when their backing store is down;
 * they carry `hasData: false` plus a `reason`. Consumers must branch on that
 * flag rather than rendering the zeroed numbers.
 *
 * Vite proxies /api -> http://localhost:8797 (see vite.config.ts), so all
 * paths here are relative and work from the dev server and a static build
 * served behind the same origin.
 */

import type {
  AdaptationPlan,
  ChildProfile,
  GameEvent,
  GameStory,
  InteractionType,
  SystemStatus,
} from '../shared/types';
import type {
  AnalyticsHealthResponse,
  AnalyticsStatus,
  EngagementResponse,
  FlushResponse,
  HintsResponse,
  IngestResponse,
  LiveResponse,
  PatternsResponse,
  RecentEventsResponse,
  StoryScenesResponse,
  StoryWordsResponse,
} from '../shared/analyticsTypes';
import type { ValidationIssue } from '../shared/storySchema';
import type { WordScore } from '../shared/wordMatch';

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** A real HTTP failure, or a real network failure. Never synthesised. */
export class ApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server. */
  status: number;
  url: string;
  /** Parsed JSON body when there was one, else the raw text, else null. */
  body: unknown;

  constructor(message: string, status: number, url: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
    this.body = body;
  }

  /** True when the request never got an answer at all (API not running). */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

/** Pulls the most specific message the server gave us. */
function messageFrom(body: unknown, res: Response, url: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.error === 'string' && b.error) return b.error;
    if (typeof b.detail === 'string' && b.detail) return b.detail;
    if (typeof b.message === 'string' && b.message) return b.message;
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 400);
  return `${res.status} ${res.statusText || 'error'} from ${url}`;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Milliseconds before the request is aborted. Omit for no client timeout. */
  timeoutMs?: number;
}

async function request<T>(
  path: string,
  init?: RequestInit,
  opts?: RequestOptions,
): Promise<T> {
  const controller = new AbortController();
  const timer =
    opts?.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(new Error(`timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs)
      : null;
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason);
    else opts.signal.addEventListener('abort', () => controller.abort(opts.signal?.reason), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(path, { ...init, signal: controller.signal });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      `could not reach ${path} - ${reason}`,
      0,
      path,
      null,
    );
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  const body = await parseBody(res);
  if (!res.ok) throw new ApiError(messageFrom(body, res, path), res.status, path, body);
  return body as T;
}

function get<T>(path: string, opts?: RequestOptions): Promise<T> {
  return request<T>(path, { headers: { accept: 'application/json' } }, opts);
}

function post<T>(path: string, payload?: unknown, opts?: RequestOptions): Promise<T> {
  return request<T>(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    },
    opts,
  );
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/* ------------------------------------------------------------------ */
/* GET /api/status                                                     */
/* ------------------------------------------------------------------ */

/**
 * The server returns the richer ClickHouse status (it includes the database,
 * table and durable-queue depth) than the minimum the shared contract demands.
 */
export interface StatusResponse extends SystemStatus {
  clickhouse: AnalyticsStatus;
}

export function getStatus(opts?: RequestOptions): Promise<StatusResponse> {
  return get<StatusResponse>('/api/status', opts);
}

/* ------------------------------------------------------------------ */
/* Stories                                                             */
/* ------------------------------------------------------------------ */

export interface StorySummary {
  id: string;
  title: string;
  source: string;
}

export function listStories(opts?: RequestOptions): Promise<{ stories: StorySummary[] }> {
  return get<{ stories: StorySummary[] }>('/api/story/list', opts);
}

export function getStory(id: string, opts?: RequestOptions): Promise<GameStory> {
  return get<GameStory>(`/api/story/${encodeURIComponent(id)}`, opts);
}

/** Mirror of the body served by GET /api/story/capabilities. */
export interface StoryCapabilities {
  llmConfigured: boolean;
  provider: string;
  model: string;
  endpoint: string;
  /** Plain-language reason, safe to show verbatim. */
  detail: string;
  interactionTypes: InteractionType[];
}

export function getStoryCapabilities(opts?: RequestOptions): Promise<StoryCapabilities> {
  return get<StoryCapabilities>('/api/story/capabilities', opts);
}

/** Mirror of server/services/storyGen.ts GenerationMeta. */
export interface GenerationAttempt {
  attempt: number;
  kind: 'initial' | 'repair';
  ok: boolean;
  issues: ValidationIssue[];
  ms: number;
}

export interface GenerationMeta {
  model: string;
  beats: number;
  attempts: GenerationAttempt[];
  repairs: number;
  usage: { inputTokens?: number; outputTokens?: number; [k: string]: unknown };
  totalMs: number;
}

export interface GenerateStoryInput {
  text: string;
  title?: string;
  adapt?: { targetPattern?: string; preferredInteraction?: InteractionType };
}

/**
 * Every outcome the generate route can actually produce, as a union, so the UI
 * can say the true thing in each case instead of collapsing them into "error".
 */
export type GenerateStoryResult =
  | { status: 'ok'; story: GameStory; meta: GenerationMeta }
  /** 422 - the model answered but its story never validated. */
  | { status: 'invalid'; error: string; issues: ValidationIssue[]; meta: GenerationMeta | null }
  /** 503 - no API key on the server, so no model was called. */
  | { status: 'not_configured'; detail: string }
  /** 400 - our request or the pasted text was rejected before any model call. */
  | { status: 'bad_input'; error: string; issues: ValidationIssue[] }
  /** Upstream/model/network failure. `httpStatus` is 0 when unreachable. */
  | { status: 'failed'; error: string; detail: string | null; httpStatus: number };

export async function generateStory(
  input: GenerateStoryInput,
  opts?: RequestOptions,
): Promise<GenerateStoryResult> {
  try {
    const body = await post<{ story: GameStory; meta: GenerationMeta }>(
      '/api/story/generate',
      input,
      opts,
    );
    return { status: 'ok', story: body.story, meta: body.meta };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    const b = (err.body ?? {}) as Record<string, unknown>;
    const issues = Array.isArray(b.issues) ? (b.issues as ValidationIssue[]) : [];
    if (err.status === 422) {
      return {
        status: 'invalid',
        error: err.message,
        issues,
        meta: (b.meta as GenerationMeta | undefined) ?? null,
      };
    }
    if (err.status === 503) {
      return { status: 'not_configured', detail: typeof b.detail === 'string' ? b.detail : err.message };
    }
    if (err.status === 400) {
      return { status: 'bad_input', error: err.message, issues };
    }
    return {
      status: 'failed',
      error: err.message,
      detail: typeof b.detail === 'string' ? b.detail : null,
      httpStatus: err.status,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export function postEvents(events: GameEvent[], opts?: RequestOptions): Promise<IngestResponse> {
  return post<IngestResponse>('/api/events', { events }, opts);
}

export function getEventsStatus(opts?: RequestOptions): Promise<AnalyticsStatus> {
  return get<AnalyticsStatus>('/api/events/status', opts);
}

export function getRecentEvents(
  params: { childId?: string; limit?: number } = {},
  opts?: RequestOptions,
): Promise<RecentEventsResponse> {
  return get<RecentEventsResponse>(`/api/events/recent${qs(params)}`, opts);
}

export function flushEvents(opts?: RequestOptions): Promise<FlushResponse> {
  return post<FlushResponse>('/api/events/flush', undefined, opts);
}

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

export function getChildPatterns(
  childId: string,
  evidenceLimit?: number,
  opts?: RequestOptions,
): Promise<PatternsResponse> {
  return get<PatternsResponse>(
    `/api/analytics/child/${encodeURIComponent(childId)}/patterns${qs({ evidenceLimit })}`,
    opts,
  );
}

export function getChildEngagement(childId: string, opts?: RequestOptions): Promise<EngagementResponse> {
  return get<EngagementResponse>(`/api/analytics/child/${encodeURIComponent(childId)}/engagement`, opts);
}

export function getChildHints(childId: string, opts?: RequestOptions): Promise<HintsResponse> {
  return get<HintsResponse>(`/api/analytics/child/${encodeURIComponent(childId)}/hints`, opts);
}

export function getStoryScenes(storyId: string, opts?: RequestOptions): Promise<StoryScenesResponse> {
  return get<StoryScenesResponse>(`/api/analytics/story/${encodeURIComponent(storyId)}/scenes`, opts);
}

export function getStoryWords(
  storyId: string,
  limit?: number,
  opts?: RequestOptions,
): Promise<StoryWordsResponse> {
  return get<StoryWordsResponse>(
    `/api/analytics/story/${encodeURIComponent(storyId)}/words${qs({ limit })}`,
    opts,
  );
}

export function getLiveEvents(
  childId: string,
  limit?: number,
  opts?: RequestOptions,
): Promise<LiveResponse> {
  return get<LiveResponse>(
    `/api/analytics/live/${encodeURIComponent(childId)}${qs({ limit })}`,
    opts,
  );
}

export function getAnalyticsHealth(opts?: RequestOptions): Promise<AnalyticsHealthResponse> {
  return get<AnalyticsHealthResponse>('/api/analytics/health', opts);
}

/** The literal SQL behind every analytics endpoint, for the judge view. */
export interface AnalyticsSqlResponse {
  note: string;
  queries: Record<string, string>;
}

export function getAnalyticsSql(opts?: RequestOptions): Promise<AnalyticsSqlResponse> {
  return get<AnalyticsSqlResponse>('/api/analytics/sql', opts);
}

/** Replays anything stranded in the durable on-disk queue. */
export function flushAnalytics(opts?: RequestOptions): Promise<FlushResponse> {
  return post<FlushResponse>('/api/analytics/flush', undefined, opts);
}

/* ------------------------------------------------------------------ */
/* Speech                                                              */
/* ------------------------------------------------------------------ */

export interface SpeechCapabilities {
  serverRecognition: { configured: false; provider: null; detail: string };
  serverSynthesis: { configured: false; provider: null; detail: string };
  scoring: {
    available: true;
    algorithm: string;
    endpoint: string;
    tiers: string[];
    detail: string;
  };
  browser: { recognition: string; synthesis: string; fallback: string };
}

export function getSpeechCapabilities(opts?: RequestOptions): Promise<SpeechCapabilities> {
  return get<SpeechCapabilities>('/api/speech/capabilities', opts);
}

/** The shared scoring verdict, plus an echo of the inputs that produced it. */
export interface SpeechScoreResponse extends WordScore {
  input: { word: string; heard: string; decoys: string[] };
  algorithm: string;
}

export function scoreSpokenWord(
  payload: { word: string; heard: string; decoys?: string[] },
  opts?: RequestOptions,
): Promise<SpeechScoreResponse> {
  return post<SpeechScoreResponse>('/api/speech/score', payload, opts);
}

/* ------------------------------------------------------------------ */
/* Child profile + adaptation                                          */
/* ------------------------------------------------------------------ */
/*
 * These two routes live under /api/profile and are owned by the profile
 * module, not by this shell. The helpers exist so views have one typed way in;
 * until that module registers the routes the calls reject with a real 404
 * ApiError. Nothing here fabricates a profile in the meantime.
 */

export function getChildProfile(childId: string, opts?: RequestOptions): Promise<ChildProfile> {
  return get<ChildProfile>(`/api/profile/${encodeURIComponent(childId)}`, opts);
}

export function getAdaptationPlan(
  childId: string,
  params: { storyId?: string } = {},
  opts?: RequestOptions,
): Promise<AdaptationPlan> {
  return get<AdaptationPlan>(
    `/api/profile/${encodeURIComponent(childId)}/adaptation${qs(params)}`,
    opts,
  );
}

/* ------------------------------------------------------------------ */
/* In-memory story cache                                               */
/* ------------------------------------------------------------------ */
/*
 * A story the child just made is handed straight to the play route instead of
 * being re-fetched. This is a cache of objects we already hold in this tab -
 * never a stand-in for a story we failed to load.
 */

const storyCache = new Map<string, GameStory>();

export function cacheStory(story: GameStory): void {
  if (story && typeof story.id === 'string') storyCache.set(story.id, story);
}

export function getCachedStory(id: string): GameStory | undefined {
  return storyCache.get(id);
}
