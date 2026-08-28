/**
 * Forgiving word matching for a 5-9 year old reader.
 *
 * Imported by BOTH the browser recogniser (src/services/speech.ts) and the
 * server scoring endpoint (server/routes/speech.ts), so this file stays
 * dependency-free: no DOM, no node builtins, no packages. Every function here
 * is pure and deterministic, which is what makes it unit-testable.
 *
 * TRUTHFULNESS CONTRACT
 * ---------------------
 * This module NEVER invents a transcript. It only judges a transcript that a
 * real recogniser produced. `matched === false` with `tier === 'none'` and an
 * empty `heard` means "the microphone gave us nothing", not "the child failed".
 * The caller must branch on the recognition method before recording a failure.
 *
 * DESIGN RULE: a near miss is never marked wrong.
 * A six-year-old saying "brav" for BRAVE, or a recogniser dropping the r in a
 * blend, is a success. The one thing we refuse to accept is the child clearly
 * reading a DIFFERENT word - which is why `decoys` exist: if the transcript
 * fits a decoy better than the target, the attempt is honestly not a match.
 */

/* ------------------------------------------------------------------ */
/* Result shape                                                        */
/* ------------------------------------------------------------------ */

export type MatchTier =
  /** Transcript is the target word. */
  | 'exact'
  /** Transcript is a documented homophone ("night" for KNIGHT). */
  | 'homophone'
  /** Same phonetic skeleton ("brav", "brayve"). */
  | 'phonetic'
  /** Within the edit-distance tolerance and the onset is compatible. */
  | 'near_miss'
  /** The child read one of the decoy words instead. */
  | 'decoy'
  /** Nothing close enough, or nothing heard at all. */
  | 'none';

export interface WordScore {
  matched: boolean;
  /** 0..1. How sure we are the child said the target. Never a guess-filler. */
  confidence: number;
  /** Levenshtein distance between the target and the best candidate token. */
  distance: number;
  tier: MatchTier;
  /** Normalised target word. */
  target: string;
  /** Normalised full transcript we were given. */
  heard: string;
  /** The token (or joined tokens) inside the transcript that scored best. */
  best: string;
  /** Set when a decoy explained the transcript better than the target did. */
  decoyMatched: string | null;
  /** Plain-English explanation, safe to show in the dev view. */
  reason: string;
}

export const SCORING_ALGORITHM =
  'normalise -> tokenise (incl. joined letter-spelling) -> exact | homophone table | ' +
  'phonetic skeleton | onset-guarded normalised Levenshtein, then decoy arbitration';

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeWord(raw: string): string {
  return (raw ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_TOKENS = 12;
const MAX_JOIN = 3;

/**
 * Every string inside the transcript worth testing against the target.
 * Includes joins of adjacent tokens so "b r a v e" and "brid ge" both work.
 */
export function candidatesFrom(heard: string): string[] {
  const norm = normalizeWord(heard);
  if (!norm) return [];
  const tokens = norm.split(' ').filter(Boolean).slice(0, MAX_TOKENS);
  const out = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    let joined = '';
    for (let n = 0; n < MAX_JOIN && i + n < tokens.length; n += 1) {
      joined += tokens[i + n];
      out.add(joined);
    }
  }
  if (tokens.length > MAX_JOIN) out.add(tokens.join(''));
  return [...out];
}

/* ------------------------------------------------------------------ */
/* Edit distance                                                       */
/* ------------------------------------------------------------------ */

/** Classic Levenshtein, two-row. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length];
}

/** 1 = identical, 0 = nothing in common. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/* ------------------------------------------------------------------ */
/* Phonetics                                                           */
/* ------------------------------------------------------------------ */

/**
 * A rough consonant skeleton. Not a real metaphone - just enough to make
 * "brave"/"brayve"/"braive" collapse together while keeping "brave"/"grave"
 * apart. Uppercase letters stand in for digraph phonemes (S=sh, C=ch, T=th).
 */
export function phoneticKey(word: string): string {
  let s = normalizeWord(word).replace(/\s+/g, '');
  if (!s) return '';

  s = s.replace(/^(kn|gn|pn|ps|wr)/, (m) => m[1]);
  s = s.replace(/^wh/, 'w');
  s = s.replace(/(ough|augh)/g, 'o');
  s = s.replace(/tch/g, 'ch');
  s = s.replace(/dge/g, 'j');
  s = s.replace(/ph/g, 'f');
  s = s.replace(/gh/g, '');
  s = s.replace(/ck/g, 'k');
  s = s.replace(/sch/g, 'sk');
  s = s.replace(/sh/g, 'S');
  s = s.replace(/ch/g, 'C');
  s = s.replace(/th/g, 'T');
  s = s.replace(/c(?=[eiy])/g, 's');
  s = s.replace(/c/g, 'k');
  s = s.replace(/q/g, 'k');
  s = s.replace(/x/g, 'ks');
  s = s.replace(/z/g, 's');
  s = s.replace(/v/g, 'f');
  s = s.replace(/y/g, 'i');
  s = s.replace(/e$/, '');
  s = s.replace(/(.)\1+/g, '$1');
  if (!s) return '';

  const head = s[0];
  const tail = s.slice(1).replace(/[aeiou]/g, '');
  return head + tail;
}

/** Leading consonant cluster, lightly normalised. '' for vowel-initial words. */
export function onsetOf(word: string): string {
  const w = normalizeWord(word).replace(/\s+/g, '');
  const m = /^[^aeiou]*/.exec(w);
  let o = m ? m[0] : '';
  if (!o) return '';
  o = o.replace(/^(kn|gn|pn|ps|wr)/, (s) => s[1]);
  o = o.replace(/ck/g, 'k').replace(/ph/g, 'f').replace(/ch/g, 'C').replace(/sh/g, 'S');
  o = o.replace(/c/g, 'k').replace(/q/g, 'k').replace(/z/g, 's');
  return o;
}

/**
 * Pairs a child or a recogniser routinely swaps. Cluster reduction (br -> b,
 * star -> tar) is handled separately by the prefix rules.
 */
const CONFUSABLE_ONSETS: string[][] = [
  ['f', 'T'], ['t', 'T'], ['d', 'T'], ['s', 'T'],
  ['w', 'r'], ['b', 'v'], ['f', 'v'], ['p', 'b'], ['t', 'd'],
  ['k', 'g'], ['g', 'j'], ['S', 'C'], ['j', 'C'],
  ['h', ''], ['', 'h'],
];

export function onsetsCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  // Cluster reduction from the right: "b" for "br", "st" for "str".
  if (a && b && (a.startsWith(b) || b.startsWith(a))) return true;
  // Cluster reduction from the left: "tar" for "star", "pin" for "spin".
  const da = a.startsWith('s') ? a.slice(1) : a;
  const db = b.startsWith('s') ? b.slice(1) : b;
  if (da && db && da === db) return true;
  return CONFUSABLE_ONSETS.some(
    ([x, y]) => (a === x && b === y) || (a === y && b === x),
  );
}

/* ------------------------------------------------------------------ */
/* Homophones the recogniser hands back instead of the printed word    */
/* ------------------------------------------------------------------ */

const HOMOPHONE_GROUPS: string[][] = [
  ['to', 'too', 'two'], ['for', 'four', 'fore'], ['there', 'their', 'theyre'],
  ['night', 'knight'], ['be', 'bee'], ['see', 'sea'], ['eye', 'i', 'aye'],
  ['one', 'won'], ['no', 'know'], ['by', 'buy', 'bye'], ['here', 'hear'],
  ['flower', 'flour'], ['brake', 'break'], ['read', 'red', 'reed'],
  ['sun', 'son'], ['ate', 'eight'], ['our', 'hour'], ['bear', 'bare'],
  ['blew', 'blue'], ['made', 'maid'], ['meat', 'meet'], ['pair', 'pear', 'pare'],
  ['plain', 'plane'], ['right', 'write', 'rite'], ['some', 'sum'],
  ['tail', 'tale'], ['wait', 'weight'], ['way', 'weigh'], ['week', 'weak'],
  ['wood', 'would'], ['cell', 'sell'], ['deer', 'dear'], ['hair', 'hare'],
  ['hole', 'whole'], ['mail', 'male'], ['nose', 'knows'], ['peace', 'piece'],
  ['sale', 'sail'], ['steal', 'steel'], ['toe', 'tow'], ['war', 'wore'],
  ['new', 'knew'], ['not', 'knot'], ['through', 'threw'], ['rose', 'rows'],
  ['bored', 'board'], ['cent', 'sent', 'scent'], ['die', 'dye'],
  ['great', 'grate'], ['hi', 'high'], ['role', 'roll'],
];

const HOMOPHONE_INDEX: Map<string, number> = (() => {
  const index = new Map<string, number>();
  HOMOPHONE_GROUPS.forEach((group, i) => {
    for (const w of group) if (!index.has(w)) index.set(w, i);
  });
  return index;
})();

export function areHomophones(a: string, b: string): boolean {
  if (a === b) return true;
  const ga = HOMOPHONE_INDEX.get(a);
  const gb = HOMOPHONE_INDEX.get(b);
  return ga !== undefined && ga === gb;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

/** How many edits we forgive, by target length. */
function tolerance(len: number): number {
  if (len <= 4) return 1;
  if (len <= 7) return 2;
  return 3;
}

const TIER_CONFIDENCE: Record<'exact' | 'homophone' | 'phonetic', number> = {
  exact: 1,
  homophone: 0.95,
  phonetic: 0.85,
};

interface Judgement {
  matched: boolean;
  confidence: number;
  distance: number;
  tier: MatchTier;
}

/** Judge one candidate token against one target. Pure. */
function judge(target: string, candidate: string): Judgement {
  const distance = levenshtein(target, candidate);
  if (distance === 0) {
    return { matched: true, confidence: TIER_CONFIDENCE.exact, distance, tier: 'exact' };
  }
  if (areHomophones(target, candidate)) {
    return { matched: true, confidence: TIER_CONFIDENCE.homophone, distance, tier: 'homophone' };
  }

  const sim = similarity(target, candidate);
  const compatible = onsetsCompatible(onsetOf(target), onsetOf(candidate));
  const key = phoneticKey(target);

  // Same sound skeleton ("lite" for LIGHT, "forrest" for FOREST). Spelling may
  // differ by more than the plain tolerance, but not without limit.
  if (compatible && key.length >= 2 && key === phoneticKey(candidate)
      && distance <= tolerance(target.length) + 1) {
    return { matched: true, confidence: TIER_CONFIDENCE.phonetic, distance, tier: 'phonetic' };
  }
  if (compatible && distance <= tolerance(target.length)) {
    const confidence = Math.min(0.8, Math.max(0.55, sim));
    return { matched: true, confidence, distance, tier: 'near_miss' };
  }
  return { matched: false, confidence: Math.max(0, sim), distance, tier: 'none' };
}

/** Best judgement of any candidate token against one word. */
function bestFor(word: string, candidates: string[]): { best: string; judgement: Judgement } {
  const target = normalizeWord(word).replace(/\s+/g, '');
  let bestCandidate = '';
  let bestJudgement: Judgement = {
    matched: false,
    confidence: 0,
    distance: target.length,
    tier: 'none',
  };
  for (const c of candidates) {
    const j = judge(target, c);
    const better =
      (j.matched && !bestJudgement.matched) ||
      (j.matched === bestJudgement.matched && j.confidence > bestJudgement.confidence);
    if (better || bestCandidate === '') {
      bestCandidate = c;
      bestJudgement = j;
    }
  }
  return { best: bestCandidate, judgement: bestJudgement };
}

export interface ScoreOptions {
  /** Words shown alongside the target. A transcript that fits one of these
   *  better than the target means the child read the wrong word. */
  decoys?: string[];
}

/**
 * The one scoring function. Used by the browser after recognition and by
 * POST /api/speech/score, so client and server can never disagree.
 */
export function scoreWord(word: string, heard: string, opts: ScoreOptions = {}): WordScore {
  const target = normalizeWord(word).replace(/\s+/g, '');
  const heardNorm = normalizeWord(heard);

  if (!target) {
    return {
      matched: false, confidence: 0, distance: 0, tier: 'none',
      target, heard: heardNorm, best: '', decoyMatched: null,
      reason: 'no target word was supplied',
    };
  }
  const candidates = candidatesFrom(heardNorm);
  if (candidates.length === 0) {
    return {
      matched: false, confidence: 0, distance: target.length, tier: 'none',
      target, heard: heardNorm, best: '', decoyMatched: null,
      reason: 'nothing was heard, so there is nothing to score',
    };
  }

  const { best, judgement } = bestFor(target, candidates);

  // Decoy arbitration: did the transcript fit a distractor better?
  let decoyMatched: string | null = null;
  let decoyConfidence = 0;
  for (const raw of opts.decoys ?? []) {
    const decoy = normalizeWord(raw).replace(/\s+/g, '');
    if (!decoy || decoy === target) continue;
    const d = bestFor(decoy, candidates);
    if (d.judgement.matched && d.judgement.confidence > decoyConfidence) {
      decoyConfidence = d.judgement.confidence;
      decoyMatched = decoy;
    }
  }

  if (decoyMatched && decoyConfidence > judgement.confidence + 1e-9) {
    return {
      matched: false,
      confidence: judgement.confidence,
      distance: judgement.distance,
      tier: 'decoy',
      target,
      heard: heardNorm,
      best,
      decoyMatched,
      reason: `"${best}" fits the other word "${decoyMatched}" better than "${target}"`,
    };
  }

  return {
    matched: judgement.matched,
    confidence: judgement.confidence,
    distance: judgement.distance,
    tier: judgement.tier,
    target,
    heard: heardNorm,
    best,
    decoyMatched: null,
    reason: explain(judgement.tier, target, best),
  };
}

function explain(tier: MatchTier, target: string, best: string): string {
  switch (tier) {
    case 'exact':
      return `heard "${best}" - exactly the word`;
    case 'homophone':
      return `"${best}" is a homophone of "${target}"`;
    case 'phonetic':
      return `"${best}" has the same sound shape as "${target}"`;
    case 'near_miss':
      return `"${best}" is close enough to "${target}" for a young reader`;
    default:
      return `"${best}" is not close enough to "${target}"`;
  }
}
