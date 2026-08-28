import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { gameStorySchema, validateStory } from '../../src/shared/storySchema.js';
import type { ValidationIssue } from '../../src/shared/storySchema.js';
import type { GameStory, InteractionType } from '../../src/shared/types.js';
import { complete, isConfigured, llmModel, LlmNotConfiguredError } from './llm.js';
import type { LlmUsage } from './llm.js';

/**
 * Book text -> playable adventure.
 *
 * The pipeline is: chunk into narrative beats (deterministic, local) -> ask the
 * model for a GameStory (real network call) -> validate with the frozen zod
 * schema -> on failure feed the exact issues back and retry -> persist.
 *
 * The model produces CONTENT AND CONFIGURATION only. It never emits code, and
 * anything it emits that fails validateStory() never reaches a child's screen.
 * There is no canned fallback story: a run that cannot produce a valid story
 * reports the validation issues instead.
 */

const MIN_TEXT_CHARS = 120;
const MAX_TEXT_CHARS = 24_000;
const MIN_BEATS = 4;
const MAX_BEATS = 6;
const MAX_REPAIRS = 2;

export const INTERACTION_TYPES = [
  'tap_target',
  'choose_object',
  'drag_drop',
  'collect_items',
  'path_choice',
  'reading_choice',
  'simple_character_action',
] as const satisfies readonly InteractionType[];

/* ------------------------------------------------------------------ */
/* Beat chunking - deterministic, no model involved                    */
/* ------------------------------------------------------------------ */

export interface Beat {
  index: number;
  text: string;
}

/**
 * Split raw book text into 4-6 narrative beats of roughly equal weight,
 * never cutting mid-sentence. Paragraph breaks are treated as strong
 * boundaries; sentences are the atoms.
 */
export function chunkIntoBeats(raw: string): Beat[] {
  const text = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  const units = splitSentences(text);
  if (units.length === 0) return [];

  const total = units.reduce((n, u) => n + u.length, 0);
  const desired = clamp(Math.round(total / 700), MIN_BEATS, MAX_BEATS);
  const count = Math.min(desired, units.length);

  // Greedy balanced packing: fill each beat until it holds its fair share of
  // the remaining characters, always leaving enough sentences for the rest.
  const beats: string[] = [];
  let cursor = 0;
  let remaining = total;
  for (let b = 0; b < count; b += 1) {
    const slotsLeft = count - b;
    const share = remaining / slotsLeft;
    const parts: string[] = [];
    let size = 0;
    while (cursor < units.length) {
      const sentencesLeft = units.length - cursor;
      const mustKeep = slotsLeft - 1;
      if (sentencesLeft <= mustKeep) break;
      parts.push(units[cursor]);
      size += units[cursor].length;
      cursor += 1;
      if (size >= share && slotsLeft > 1) break;
    }
    if (parts.length === 0 && cursor < units.length) {
      parts.push(units[cursor]);
      size += units[cursor].length;
      cursor += 1;
    }
    remaining -= size;
    beats.push(parts.join(' ').trim());
  }
  // Anything left over (rounding) joins the final beat.
  if (cursor < units.length) {
    beats[beats.length - 1] = `${beats[beats.length - 1]} ${units.slice(cursor).join(' ')}`.trim();
  }

  return beats
    .filter((t) => t.length > 0)
    .map((t, i) => ({ index: i + 1, text: t }));
}

function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{1,}/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const pieces = trimmed.match(/[^.!?]+[.!?]+["'”’)\]]*|[^.!?]+$/g);
    if (!pieces) continue;
    for (const piece of pieces) {
      const s = piece.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

let workedExample: string | null = null;

/** The real, validated builtin story, read from disk so it can never drift. */
function foxExample(): string {
  if (workedExample === null) {
    const path = join(process.cwd(), 'src', 'stories', 'fox-and-lost-star.json');
    workedExample = JSON.stringify(JSON.parse(readFileSync(path, 'utf8')));
  }
  return workedExample;
}

const SYSTEM_PROMPT_HEAD = `You turn children's books into playable adventures for a running game engine.

You emit CONTENT AND CONFIGURATION ONLY. You never write code, expressions, formulas, CSS, or file paths.
The engine draws every visual procedurally from the prop list you supply and synthesises every sound with
oscillators. There are ZERO image and audio assets, so never reference a .png/.jpg/.mp3/.wav or any asset name.

AUDIENCE: children aged 5-9, often reading with an adult. The feeling to create is "I jumped inside my book
with my little friend" - never "I am doing homework".

THE COMPANION: an original creature called MIMO lives inside the story world beside the child. Mimo is curious,
a bit silly, brave-ish, and always on the child's side. Mimo reacts, wonders aloud, and cheers. Mimo NEVER
scolds, never says "wrong", never grades. A wrong tap is playful, never punishing.

OUTPUT CONTRACT
Return exactly ONE JSON object and nothing else: no prose, no explanation, no markdown fences.
It must satisfy this TypeScript exactly (excess properties are rejected):

type Biome = 'enchanted_forest' | 'river' | 'meadow' | 'cave' | 'night_sky' | 'mountain' | 'village';
type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';
type PropKind =
  | 'tree' | 'pine' | 'bush' | 'flower' | 'mushroom' | 'rock' | 'stone'
  | 'star' | 'butterfly' | 'firefly' | 'lilypad' | 'reed' | 'log'
  | 'crystal' | 'stalagmite' | 'footprint' | 'bridge' | 'cloud' | 'moon';
type CharacterAction = 'climb' | 'jump' | 'dig' | 'push' | 'knock' | 'swim' | 'fly' | 'dance';

interface StoryProp {
  id: string;            // unique within its scene, snake_case
  kind: PropKind;        // ONLY the kinds above - the artist knows no others
  x: number;             // 0..1, 0 = left edge
  y: number;             // 0..1, 0 = top edge
  scale?: number;        // 0.1..4
  color?: string;        // '#rrggbb' exactly six hex digits
  layer?: 0 | 1 | 2;     // 0 = far background, 1 = mid, 2 = foreground
  label?: string;        // spoken/accessible description
}

interface ReadingWord { word: string; pattern: string; decoys?: string[] }  // word <=20 chars, pattern <=4 chars, <=4 decoys

type Interaction =
  | { type: 'tap_target'; target: string; distractors?: string[]; prompt: string }
  | { type: 'choose_object'; prompt: string; choices: { id: string; label: string; correct: boolean }[] }   // 2..4 choices
  | { type: 'drag_drop'; prompt: string; dragId: string; dropZone: { x: number; y: number; radius: number; label: string } }  // radius 0.03..0.5
  | { type: 'collect_items'; prompt: string; targets: string[]; count: number }   // 1..6 targets, count <= targets.length
  | { type: 'path_choice'; prompt: string; paths: { id: string; label: string; x: number; y: number; correct: boolean }[] }   // 2..3 paths
  | { type: 'reading_choice'; prompt: string; words: ReadingWord[] }   // 1..5 words
  | { type: 'simple_character_action'; prompt: string; action: CharacterAction; actor: 'fox' | 'mimo'; effort: number };  // effort 1..8

interface StoryScene {
  id: string;                 // snake_case, unique
  location: string;           // e.g. "the whispering cave"
  biome: Biome;
  timeOfDay: TimeOfDay;
  narration: string;          // <=400 chars, read aloud, 1-2 short sentences
  emphasis?: string[];        // substrings that appear VERBATIM inside narration
  props: StoryProp[];         // <=40
  interaction: Interaction;   // exactly ONE per scene
  companion: { intro: string; success: string; retry?: string; hint?: string };  // each <=160 chars
  reward: { stars: number };  // 0..100
  nextScene: string | null;   // next scene id, or null on the final scene
}

interface GameStory { id: string; title: string; source: 'generated'; scenes: StoryScene[] }

HARD RULES (a story that breaks any of these is rejected and you will be asked to repair it)
1. 4 to 6 scenes. Scenes form ONE chain: scene[n].nextScene === scene[n+1].id, and the LAST scene has nextScene: null.
2. Exactly one interaction per scene, and it must be one of the seven types above. Vary them: never use the same
   type in three scenes, and include at least one 'reading_choice'.
3. Every prop id an interaction references MUST exist in that same scene's props array:
   - tap_target.target and every tap_target.distractors entry
   - drag_drop.dragId
   - every collect_items.targets entry
   - every choose_object.choices[].id
   ('path_choice' path ids are route labels, not props - they do not need to exist in props.)
4. choose_object must have exactly one correct:true. path_choice must have at least one correct:true.
5. Every emphasis entry must appear character-for-character inside that scene's narration.
6. 8 to 14 props per scene, spread across layers 0/1/2, x and y inside 0..1, and none stacked on the same spot.
   Put background props (tree/pine/cloud/moon) high and small, foreground props (bush/flower/mushroom/stone) low.
   Keep y between 0.05 and 0.95. Colours must fit the biome.
7. Rewards climb across the story, roughly 10 -> 40 stars.
8. Narration is storybook voice, present or simple past, short words, one idea per sentence. No instructions in
   the narration - instructions belong in interaction.prompt and in Mimo's lines.

MAPPING STORY VERBS TO PRIMITIVES - choose the primitive the sentence is already asking for:
  "climbed the beanstalk", "knocked on the door", "dug in the sand"   -> simple_character_action
  "found three keys", "gathered the acorns"                           -> collect_items
  "hid behind the red mushroom", "spotted the owl"                    -> tap_target
  "the BLUE butterfly knows the way", "picked the golden apple"       -> choose_object
  "returned the star to the sky", "put the key in the lock"           -> drag_drop
  "left path or right path?", "over the bridge or through the wood?"  -> path_choice
  a moment where words themselves are the obstacle (a sign, a spell,
  a note, a name to read aloud)                                       -> reading_choice

READING TARGETS
reading_choice words drive the reading analytics, so they must be deliberate. Favour CONSONANT BLENDS -
br, cr, tr, st, gr, fr, dr, pr, bl, cl, fl, gl, sl, sn, sp, sk, sw, tw - with 'br', 'cr', 'tr', 'st' and 'gr'
preferred. Each word's "pattern" is the blend it exercises, lowercase, e.g. { word: "BRAVE", pattern: "br" }.
Keep every word in a reading_choice scene on the SAME pattern so the evidence is clean. Decoys must be real,
readable words that differ by exactly the tricky part (BRAVE/CAVE/GRAVE, BRIDGE/FRIDGE/BADGE). Write the words in
CAPITALS and make them appear inside that scene's narration and its emphasis array.

WORKED EXAMPLE - this is a real story that passed validation in this engine. Match its shape and its energy:
`;

export function systemPrompt(): string {
  return `${SYSTEM_PROMPT_HEAD}${foxExample()}\n\nNow do the same for the book the user gives you.`;
}

export interface AdaptHint {
  targetPattern?: string;
  preferredInteraction?: InteractionType;
}

export function userPrompt(title: string, beats: Beat[], adapt?: AdaptHint): string {
  const lines: string[] = [];
  lines.push(`BOOK TITLE: ${title}`);
  lines.push('');
  lines.push(
    `I chunked the book into ${beats.length} narrative beats. Turn each beat into one scene, in this order.`,
  );
  if (beats.length < MIN_BEATS) {
    lines.push(
      `There are only ${beats.length} beats, so split the richest ones until you have at least ${MIN_BEATS} scenes.`,
    );
  }
  lines.push('');
  for (const beat of beats) {
    lines.push(`BEAT ${beat.index}:`);
    lines.push(beat.text);
    lines.push('');
  }

  if (adapt?.targetPattern || adapt?.preferredInteraction) {
    lines.push('ADAPTATION REQUEST - this child needs specific reinforcement.');
    lines.push('Weave it into the story naturally; never announce it or make it feel like a drill.');
    if (adapt.targetPattern) {
      const p = adapt.targetPattern.toLowerCase();
      lines.push(
        `- Target reading pattern "${p}". The reading_choice scene MUST use "${p}" words only, and at least two other scenes should slip "${p}" words into their narration and emphasis.`,
      );
    }
    if (adapt.preferredInteraction) {
      lines.push(
        `- This child engages most with "${adapt.preferredInteraction}". Use it for at least two scenes wherever the beats allow it, without repeating it three times.`,
      );
    }
    lines.push('');
  }

  lines.push('Return ONLY the GameStory JSON object.');
  return lines.join('\n');
}

function repairPrompt(previousJson: string, issues: ValidationIssue[]): string {
  const list = issues.map((i) => `- ${i.path || '(root)'}: ${i.message}`).join('\n');
  return [
    'The JSON you produced failed the engine\'s validator. Here it is:',
    '',
    previousJson,
    '',
    'These are the exact validation issues:',
    list,
    '',
    'Fix every one of them. Paths are indexes into the object, so "scenes.2.interaction.target" means the',
    'interaction in the third scene points at a prop id that scene does not contain - either add that prop or',
    'point at one that exists. Keep everything that was already correct.',
    '',
    'IMPORTANT: the validator runs in two stages and stops after the first that fails. The list above may be',
    'shape errors only, with cross-reference errors still hidden behind them. So before you answer, re-check',
    'ALL of these yourself, scene by scene:',
    '  - every tap_target.target, every tap_target.distractors entry, every drag_drop.dragId, every',
    '    collect_items.targets entry and every choose_object.choices[].id exists in that scene\'s own props',
    '  - collect_items.count <= collect_items.targets.length',
    '  - choose_object has exactly one correct:true; path_choice has at least one correct:true',
    '  - scene ids are unique, each nextScene names a real scene, and exactly one scene ends with null',
    '  - every emphasis string appears verbatim in that scene\'s narration',
    '',
    'Return ONLY the corrected, complete GameStory JSON object.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* JSON extraction                                                     */
/* ------------------------------------------------------------------ */

/** The model is told to return bare JSON; this survives it wrapping anyway. */
export function extractJson(text: string): unknown {
  const attempts: string[] = [];
  const trimmed = text.trim();
  attempts.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1].trim());

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(trimmed.slice(first, last + 1));

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

export interface GenerateInput {
  text: string;
  title?: string;
  adapt?: AdaptHint;
}

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
  usage: LlmUsage;
  totalMs: number;
}

export type GenerateOutcome =
  | { ok: true; story: GameStory; meta: GenerationMeta }
  | { ok: false; issues: ValidationIssue[]; meta: GenerationMeta };

export class StoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoryInputError';
  }
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'story';
}

/**
 * Real generation. Throws LlmNotConfiguredError when there is no API key and
 * LlmRequestError when the upstream call fails; returns ok:false with the
 * validator's issues when the model could not produce a playable story.
 */
export async function generateStory(input: GenerateInput): Promise<GenerateOutcome> {
  if (!isConfigured()) throw new LlmNotConfiguredError();

  const source = input.text.trim();
  if (source.length < MIN_TEXT_CHARS) {
    throw new StoryInputError(
      `need at least ${MIN_TEXT_CHARS} characters of book text to build an adventure (got ${source.length})`,
    );
  }
  if (source.length > MAX_TEXT_CHARS) {
    throw new StoryInputError(
      `book text is ${source.length} characters; paste at most ${MAX_TEXT_CHARS} (one chapter works best)`,
    );
  }

  const beats = chunkIntoBeats(source);
  if (beats.length === 0) {
    throw new StoryInputError('could not find any sentences in the pasted text');
  }

  const title = (input.title?.trim() || inferTitle(source)).slice(0, 120);
  const system = systemPrompt();
  const startedAll = Date.now();

  const attempts: GenerationAttempt[] = [];
  const usage: LlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  const storyId = `${slugify(title)}-${randomUUID().slice(0, 8)}`;
  let prompt = userPrompt(title, beats, input.adapt);
  let lastIssues: ValidationIssue[] = [];

  for (let i = 0; i <= MAX_REPAIRS; i += 1) {
    const started = Date.now();
    const result = await complete({ system, messages: [{ role: 'user', content: prompt }] });

    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    usage.cacheReadInputTokens += result.usage.cacheReadInputTokens;
    usage.cacheCreationInputTokens += result.usage.cacheCreationInputTokens;

    const parsed = extractJson(result.text);
    if (parsed === null || typeof parsed !== 'object') {
      lastIssues = [{ path: '(root)', message: 'the model did not return a JSON object' }];
      attempts.push({
        attempt: i + 1,
        kind: i === 0 ? 'initial' : 'repair',
        ok: false,
        issues: lastIssues,
        ms: Date.now() - started,
      });
      prompt = repairPrompt(result.text.slice(0, 4000), lastIssues);
      continue;
    }

    // Identity and provenance are ours, not the model's.
    const candidate: Record<string, unknown> = {
      ...(parsed as Record<string, unknown>),
      id: storyId,
      source: 'generated',
    };
    if (typeof candidate.title !== 'string' || candidate.title.trim() === '') {
      candidate.title = title;
    }

    const validation = validateStory(candidate);
    attempts.push({
      attempt: i + 1,
      kind: i === 0 ? 'initial' : 'repair',
      ok: validation.ok,
      issues: validation.issues,
      ms: Date.now() - started,
    });

    if (validation.ok) {
      // Re-parse so anything the model invented outside the schema is stripped
      // before the story is persisted or shipped to the engine.
      const story = gameStorySchema.parse(candidate) as unknown as GameStory;
      return {
        ok: true,
        story,
        meta: {
          model: result.model,
          beats: beats.length,
          attempts,
          repairs: i,
          usage,
          totalMs: Date.now() - startedAll,
        },
      };
    }

    lastIssues = validation.issues;
    prompt = repairPrompt(JSON.stringify(candidate), validation.issues);
  }

  return {
    ok: false,
    issues: lastIssues,
    meta: {
      model: llmModel(),
      beats: beats.length,
      attempts,
      repairs: MAX_REPAIRS,
      usage,
      totalMs: Date.now() - startedAll,
    },
  };
}

function inferTitle(text: string): string {
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  const cleaned = sentence.replace(/["'“”]/g, '').trim();
  return cleaned.length >= 3 && cleaned.length <= 80 ? cleaned : 'An Untitled Adventure';
}
