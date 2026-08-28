/**
 * Adaptation: turning evidence into a changed game.
 *
 *   profile -> AdaptationPlan -> a modified StoryScene that still validates
 *
 * The learning objective stays hidden inside gameplay. The child sees a new
 * bit of adventure; they never see a drill. If the evidence is thin we return
 * applied:false with the reason rather than inventing a target.
 */

import { validateStory } from '../../src/shared/storySchema';
import { getStory, saveStory } from '../db/relational';
import type {
  AdaptationPlan, GameStory, InteractionType, ReadingWord, StoryScene,
} from '../../src/shared/types';
import { buildProfile, type ProfileResult } from './profile';

/**
 * Words per phonics pattern. Discovered patterns index into this; the bank is
 * never used to *choose* a pattern, only to reinforce one the data surfaced.
 */
const WORD_BANK: Record<string, string[]> = {
  br: ['BRAVE', 'BRIDGE', 'BROWN', 'BRANCH', 'BREEZE', 'BRIGHT'],
  tr: ['TRAIL', 'TRY', 'TRUST', 'TRACK', 'TREE', 'TRAP'],
  cr: ['CROWN', 'CREEK', 'CRISP', 'CRAB', 'CROSS'],
  gr: ['GRASS', 'GREEN', 'GRIN', 'GRAB', 'GROW'],
  st: ['STONE', 'STAR', 'STREAM', 'STAND', 'STICK'],
  fl: ['FLOWER', 'FLAME', 'FLOAT', 'FLAP', 'FLASH'],
  sn: ['SNOW', 'SNAP', 'SNAIL', 'SNUG'],
  pl: ['PLANT', 'PLAY', 'PLUM', 'PLAN'],
};

/** Decoys that differ from the target by exactly the blend under practice. */
function decoysFor(word: string, pattern: string): string[] {
  const tail = word.slice(pattern.length);
  const swaps = ['c', 'd', 'f', 'g', 'p', 't'].filter((c) => !pattern.startsWith(c));
  const out = new Set<string>();
  out.add((swaps[0] + tail).toUpperCase());
  out.add(tail.toUpperCase());
  out.delete(word);
  return [...out].filter((w) => w.length > 1).slice(0, 3);
}

function wordsForPattern(pattern: string, count: number): ReadingWord[] {
  const bank = WORD_BANK[pattern];
  if (!bank) return [];
  return bank.slice(0, count).map((word) => ({
    word,
    pattern,
    decoys: decoysFor(word, pattern),
  }));
}

/**
 * Narration that carries the pattern naturally. Deterministic, so adaptation
 * works with no LLM configured; the plan records which generator was used.
 */
function narrationFor(pattern: string, words: ReadingWord[]): string | null {
  const w = words.map((x) => x.word);
  if (w.length < 2) return null;
  const templates: Record<string, string> = {
    br: `The ${w[0]} bear carried a ${w[2] ?? w[1]} basket across the ${w[1]}.`,
    tr: `They followed the ${w[0]} and had to ${w[1]} to ${w[2] ?? 'go on'}.`,
    cr: `A ${w[0]} glittered beside the ${w[1]}.`,
    gr: `The ${w[0]} was ${w[1]} where the little seeds ${w[2] ?? 'grow'}.`,
    st: `A ${w[0]} sat in the ${w[1]} beneath a single ${w[2] ?? 'star'}.`,
  };
  return templates[pattern] ?? `Look! A ${w[0]} and a ${w[1]} together.`;
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

export interface PlanResult {
  plan: AdaptationPlan;
  profile: ProfileResult;
  /** How the narration was produced, so the UI never overclaims. */
  narrationSource: 'template' | 'llm' | 'none';
}

export async function planFor(childId: string): Promise<PlanResult> {
  const profile = await buildProfile(childId);

  const none = (reason: string): PlanResult => ({
    profile,
    narrationSource: 'none',
    plan: {
      applied: false,
      reason,
      targetPattern: null,
      preferredInteraction: profile.engagement.preferredInteraction,
      helpAfterAttempt: profile.companion.helpAfterAttempt,
      rewrittenNarration: null,
      injectedWords: [],
    },
  });

  if (!profile.hasEvidence) {
    return none('no gameplay events recorded for this child yet');
  }

  const target = profile.reading.weakPatterns[0] ?? null;
  if (!target) {
    const confident = profile.reading.patternStats.filter((p) => p.confident).length;
    return none(
      confident === 0
        ? `not enough resolved reading attempts yet (need ${profile.thresholds.minResolvedForConfidence} ` +
          `across ${profile.thresholds.minDistinctWords} distinct words)`
        : 'no pattern is below the weak threshold - nothing needs reinforcing',
    );
  }

  const injected = wordsForPattern(target, 3);
  if (injected.length === 0) {
    return none(`pattern "${target}" was detected but no word bank exists for it`);
  }

  const narration = narrationFor(target, injected);

  return {
    profile,
    narrationSource: narration ? 'template' : 'none',
    plan: {
      applied: false, // becomes true once actually written to a story
      reason:
        `pattern "${target}" is weak for this child ` +
        `(${describePattern(profile, target)}), evidence from ${profile.evidenceSource}`,
      targetPattern: target,
      preferredInteraction: profile.engagement.preferredInteraction,
      helpAfterAttempt: profile.companion.helpAfterAttempt,
      rewrittenNarration: narration,
      injectedWords: injected,
    },
  };
}

function describePattern(profile: ProfileResult, pattern: string): string {
  const s = profile.reading.patternStats.find((p) => p.pattern === pattern);
  if (!s) return 'no stats';
  return `${Math.round(s.accuracy * 100)}% accuracy over ${s.attempts} attempts on ${s.wordsSeen} words`;
}

/* ------------------------------------------------------------------ */
/* Application                                                         */
/* ------------------------------------------------------------------ */

export interface ApplyResult {
  applied: boolean;
  reason: string;
  storyId: string | null;
  sceneId: string | null;
  plan: AdaptationPlan;
  diff: {
    field: string;
    before: unknown;
    after: unknown;
  }[];
  validation: { ok: boolean; issues: { path: string; message: string }[] };
}

/**
 * Rewrites the next reading scene of a story to reinforce the weak pattern.
 * Refuses to persist anything that fails validation.
 */
export async function applyPlan(childId: string, storyId: string): Promise<ApplyResult> {
  const { plan } = await planFor(childId);

  const refuse = (reason: string): ApplyResult => ({
    applied: false, reason, storyId, sceneId: null, plan,
    diff: [], validation: { ok: true, issues: [] },
  });

  if (!plan.targetPattern) return refuse(plan.reason);

  const story = getStory(storyId);
  if (!story) return refuse(`story "${storyId}" not found`);

  // Target the first reading scene; that is where reinforcement belongs.
  const idx = story.scenes.findIndex((s) => s.interaction.type === 'reading_choice');
  if (idx < 0) return refuse(`story "${storyId}" has no reading scene to adapt`);

  const before = story.scenes[idx];
  const diff: ApplyResult['diff'] = [];

  const after: StoryScene = structuredClone(before);

  if (after.interaction.type === 'reading_choice') {
    diff.push({
      field: `scenes.${idx}.interaction.words`,
      before: after.interaction.words.map((w) => w.word),
      after: plan.injectedWords.map((w) => w.word),
    });
    after.interaction.words = plan.injectedWords;
  }

  if (plan.rewrittenNarration) {
    diff.push({
      field: `scenes.${idx}.narration`,
      before: before.narration,
      after: plan.rewrittenNarration,
    });
    after.narration = plan.rewrittenNarration;
    after.emphasis = plan.injectedWords.map((w) => w.word);
  }

  const candidate: GameStory = {
    ...story,
    scenes: story.scenes.map((s, i) => (i === idx ? after : s)),
  };

  const validation = validateStory(candidate);
  if (!validation.ok) {
    return {
      applied: false,
      reason: 'the adapted scene failed validation and was NOT persisted',
      storyId, sceneId: before.id, plan, diff, validation,
    };
  }

  saveStory(candidate);

  return {
    applied: true,
    reason:
      `reinforced "${plan.targetPattern}" in scene "${before.id}" of "${story.title}"; ` +
      `Mimo will now wait until attempt ${plan.helpAfterAttempt} before offering help`,
    storyId,
    sceneId: before.id,
    plan: { ...plan, applied: true },
    diff,
    validation,
  };
}

/** The policy the running game consumes each scene. */
export async function policyFor(childId: string) {
  const { plan, profile } = await planFor(childId);
  const style = profile.companion.preferredIntervention;
  return {
    helpAfterAttempt: plan.helpAfterAttempt,
    interventionStyle: (style ?? 'visual_hint') as 'visual_hint' | 'spoken_hint' | 'none',
    source: profile.hasEvidence ? ('clickhouse' as const) : ('default' as const),
    evidenceSource: profile.evidenceSource,
    detail: profile.sourceDetail,
    plan,
  };
}

/** Interaction types we are willing to switch a scene to. */
export const SWITCHABLE: InteractionType[] = [
  'tap_target', 'choose_object', 'drag_drop', 'collect_items',
];
