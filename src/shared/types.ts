/**
 * Shared contracts. Imported by BOTH the browser bundle and the node server.
 * Keep this file dependency-free (no phaser, no express, no node builtins).
 */

/* ------------------------------------------------------------------ */
/* Story content                                                       */
/* ------------------------------------------------------------------ */

/** The visual biome a scene renders. Drives procedural art generation. */
export type Biome =
  | 'enchanted_forest'
  | 'river'
  | 'meadow'
  | 'cave'
  | 'night_sky'
  | 'mountain'
  | 'village';

export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';

/** Every prop the procedural artist knows how to draw. */
export type PropKind =
  | 'tree' | 'pine' | 'bush' | 'flower' | 'mushroom' | 'rock' | 'stone'
  | 'star' | 'butterfly' | 'firefly' | 'lilypad' | 'reed' | 'log'
  | 'crystal' | 'stalagmite' | 'footprint' | 'bridge' | 'cloud' | 'moon';

export interface StoryProp {
  id: string;
  kind: PropKind;
  /** Normalised 0..1 position within the scene. x=0 left, y=0 top. */
  x: number;
  y: number;
  /** Relative scale multiplier. 1 = the artist's natural size. */
  scale?: number;
  /** Hex tint, e.g. '#4aa3ff'. The artist blends it with the biome palette. */
  color?: string;
  /** Parallax layer. 0 = far background, 2 = foreground. */
  layer?: 0 | 1 | 2;
  /** Human label used by companion hints and accessibility text. */
  label?: string;
}

/* ------------------------------------------------------------------ */
/* Interactions - the approved primitive library.                      */
/* The LLM may ONLY emit these. It never emits executable code.        */
/* ------------------------------------------------------------------ */

export type InteractionType =
  | 'tap_target'
  | 'choose_object'
  | 'drag_drop'
  | 'collect_items'
  | 'path_choice'
  | 'reading_choice'
  | 'simple_character_action';

export interface TapTargetInteraction {
  type: 'tap_target';
  /** Prop id that is correct. */
  target: string;
  /** Distractor prop ids. Tapping these is playful, never punishing. */
  distractors?: string[];
  prompt: string;
}

export interface ChooseObjectInteraction {
  type: 'choose_object';
  prompt: string;
  choices: { id: string; label: string; correct: boolean }[];
}

export interface DragDropInteraction {
  type: 'drag_drop';
  prompt: string;
  /** Prop the child physically drags. */
  dragId: string;
  /** Normalised drop zone. */
  dropZone: { x: number; y: number; radius: number; label: string };
}

export interface CollectItemsInteraction {
  type: 'collect_items';
  prompt: string;
  /** Prop ids to gather, in any order. */
  targets: string[];
  count: number;
}

export interface PathChoiceInteraction {
  type: 'path_choice';
  prompt: string;
  paths: { id: string; label: string; x: number; y: number; correct: boolean }[];
}

/** A real spoken-or-tapped reading moment. Produces behavioural evidence. */
export interface ReadingChoiceInteraction {
  type: 'reading_choice';
  prompt: string;
  /** Words the child actually attempts. */
  words: ReadingWord[];
}

export interface ReadingWord {
  word: string;
  /** Onset/pattern this word exercises, e.g. 'br'. Drives pattern analytics. */
  pattern: string;
  /** Decoy words shown when falling back to tap-to-choose. */
  decoys?: string[];
}

/**
 * A story beat the child performs WITH the character rather than on an object:
 * "Jack climbed the beanstalk" -> hold/tap to climb. Keeps narrative verbs
 * playable without inventing new game code per book.
 */
export interface SimpleCharacterActionInteraction {
  type: 'simple_character_action';
  prompt: string;
  action: CharacterAction;
  /** Who performs it: 'fox' (protagonist) or 'mimo'. */
  actor: 'fox' | 'mimo';
  /** How many taps/holds complete the action. */
  effort: number;
}

export type CharacterAction =
  | 'climb' | 'jump' | 'dig' | 'push' | 'knock' | 'swim' | 'fly' | 'dance';

export type Interaction =
  | TapTargetInteraction
  | ChooseObjectInteraction
  | DragDropInteraction
  | CollectItemsInteraction
  | PathChoiceInteraction
  | ReadingChoiceInteraction
  | SimpleCharacterActionInteraction;

/* ------------------------------------------------------------------ */
/* Scenes and stories                                                  */
/* ------------------------------------------------------------------ */

export interface CompanionLines {
  /** Said when Mimo enters the scene. */
  intro: string;
  /** Said when the child succeeds. */
  success: string;
  /** Said on a wrong-but-harmless choice. Playful, never scolding. */
  retry?: string;
  /** Offered as help, only once the adaptation policy allows it. */
  hint?: string;
}

export interface StoryScene {
  id: string;
  location: string;
  biome: Biome;
  timeOfDay: TimeOfDay;
  /** Narration read aloud and shown as a storybook caption. */
  narration: string;
  /** Words inside `narration` to visually emphasise. */
  emphasis?: string[];
  props: StoryProp[];
  interaction: Interaction;
  companion: CompanionLines;
  reward: { stars: number };
  nextScene: string | null;
}

export interface GameStory {
  id: string;
  title: string;
  /** Where this story came from. */
  source: 'builtin' | 'generated';
  scenes: StoryScene[];
}

/* ------------------------------------------------------------------ */
/* Analytics events                                                    */
/* ------------------------------------------------------------------ */

export type GameEventType =
  | 'story_started' | 'story_completed' | 'story_abandoned'
  | 'scene_started' | 'scene_completed'
  | 'interaction_started' | 'interaction_completed'
  | 'object_tapped' | 'wrong_choice' | 'correct_choice'
  | 'word_presented' | 'word_attempted' | 'word_failed' | 'word_succeeded'
  | 'hint_offered' | 'hint_accepted' | 'hint_ignored'
  | 'companion_spoke';

/** One row of behavioural evidence. Mirrors the ClickHouse table exactly. */
export interface GameEvent {
  event_id: string;
  timestamp: string;          // ISO-8601, millisecond precision
  session_id: string;
  child_id: string;
  story_id: string;
  scene_id: string;
  event_type: GameEventType;
  interaction_type: InteractionType | '';
  word: string;
  phoneme: string;            // the pattern, e.g. 'br'
  correct: boolean | null;
  attempt_number: number;
  response_time_ms: number;
  hint_used: boolean;
  companion_intervention: string;
  metadata: string;           // JSON string
}

/* ------------------------------------------------------------------ */
/* Child profile - derived ENTIRELY from stored events                 */
/* ------------------------------------------------------------------ */

export interface PatternStat {
  pattern: string;
  attempts: number;
  successes: number;
  accuracy: number;           // 0..1
  avgAttemptsToSuccess: number;
  wordsSeen: number;
  /** Do we have enough evidence to act on this? */
  confident: boolean;
}

export interface ChildProfile {
  childId: string;
  /** True only when the profile is backed by real rows. */
  hasEvidence: boolean;
  eventCount: number;
  reading: {
    weakPatterns: string[];
    strongPatterns: string[];
    patternStats: PatternStat[];
    overallAccuracy: number;
  };
  engagement: {
    preferredInteraction: InteractionType | null;
    /** Where this child stalls or bails - drives what we stop showing them. */
    lowEngagementInteraction: InteractionType | null;
    interactionStats: { type: string; completions: number; abandons: number; avgMs: number }[];
    scenesCompleted: number;
    storiesCompleted: number;
    storiesStarted: number;
  };
  companion: {
    /** Which help style actually worked for THIS child. */
    preferredIntervention: 'visual_hint' | 'spoken_hint' | 'none' | null;
    /** How many failures to allow before Mimo offers help. */
    helpAfterAttempt: number;
    hintsOffered: number;
    hintsAccepted: number;
    /** Success rate after accepting a hint vs. after retrying unaided. */
    successRateWithHint: number | null;
    successRateWithoutHint: number | null;
  };
}

/** What the profile actually changes about the next scene. */
export interface AdaptationPlan {
  applied: boolean;
  reason: string;
  targetPattern: string | null;
  preferredInteraction: InteractionType | null;
  helpAfterAttempt: number;
  /** Narration rewritten to drill the weak pattern, when one is found. */
  rewrittenNarration: string | null;
  injectedWords: ReadingWord[];
}

/** Runtime truthfulness: what is actually wired up right now. */
export interface SystemStatus {
  clickhouse: { configured: boolean; connected: boolean; detail: string };
  llm: { configured: boolean; provider: string; model: string; detail: string };
  relational: { driver: 'postgres' | 'sqlite'; detail: string };
  tts: { available: boolean; detail: string };
}
