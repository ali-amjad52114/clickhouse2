import { z } from 'zod';

/**
 * Runtime validation for GameStory JSON.
 *
 * This is the contract boundary between the LLM and the game engine.
 * The LLM emits CONTENT + CONFIGURATION only. Anything that does not
 * validate here never reaches a child's screen.
 */

const biome = z.enum([
  'enchanted_forest', 'river', 'meadow', 'cave', 'night_sky', 'mountain', 'village',
]);

const timeOfDay = z.enum(['dawn', 'day', 'dusk', 'night']);

const propKind = z.enum([
  'tree', 'pine', 'bush', 'flower', 'mushroom', 'rock', 'stone',
  'star', 'butterfly', 'firefly', 'lilypad', 'reed', 'log',
  'crystal', 'stalagmite', 'footprint', 'bridge', 'cloud', 'moon',
]);

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');

export const propSchema = z.object({
  id: z.string().min(1),
  kind: propKind,
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  scale: z.number().min(0.1).max(4).optional(),
  color: hexColor.optional(),
  layer: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  label: z.string().optional(),
});

export const readingWordSchema = z.object({
  word: z.string().min(1).max(20),
  pattern: z.string().min(1).max(4),
  decoys: z.array(z.string()).max(4).optional(),
});

export const interactionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tap_target'),
    target: z.string().min(1),
    distractors: z.array(z.string()).optional(),
    prompt: z.string().min(1),
  }),
  z.object({
    type: z.literal('choose_object'),
    prompt: z.string().min(1),
    choices: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      correct: z.boolean(),
    })).min(2).max(4),
  }),
  z.object({
    type: z.literal('drag_drop'),
    prompt: z.string().min(1),
    dragId: z.string().min(1),
    dropZone: z.object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      radius: z.number().min(0.03).max(0.5),
      label: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal('collect_items'),
    prompt: z.string().min(1),
    targets: z.array(z.string().min(1)).min(1).max(6),
    count: z.number().int().min(1).max(6),
  }),
  z.object({
    type: z.literal('path_choice'),
    prompt: z.string().min(1),
    paths: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      correct: z.boolean(),
    })).min(2).max(3),
  }),
  z.object({
    type: z.literal('reading_choice'),
    prompt: z.string().min(1),
    words: z.array(readingWordSchema).min(1).max(5),
  }),
  z.object({
    type: z.literal('simple_character_action'),
    prompt: z.string().min(1),
    action: z.enum(['climb', 'jump', 'dig', 'push', 'knock', 'swim', 'fly', 'dance']),
    actor: z.enum(['fox', 'mimo']),
    effort: z.number().int().min(1).max(8),
  }),
]);

export const companionSchema = z.object({
  intro: z.string().min(1).max(160),
  success: z.string().min(1).max(160),
  retry: z.string().max(160).optional(),
  hint: z.string().max(160).optional(),
});

export const sceneSchema = z.object({
  id: z.string().min(1),
  location: z.string().min(1),
  biome,
  timeOfDay,
  narration: z.string().min(1).max(400),
  emphasis: z.array(z.string()).optional(),
  props: z.array(propSchema).max(40),
  interaction: interactionSchema,
  companion: companionSchema,
  reward: z.object({ stars: z.number().int().min(0).max(100) }),
  nextScene: z.string().nullable(),
});

export const gameStorySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  source: z.enum(['builtin', 'generated']),
  scenes: z.array(sceneSchema).min(1).max(12),
});

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/**
 * Structural validation plus cross-reference checks that zod cannot express:
 * every interaction must point at props that actually exist in its scene, and
 * every nextScene must point at a real scene. A story that fails these would
 * render an unplayable dead end, so we reject it and ask the LLM to repair.
 */
export function validateStory(input: unknown): ValidationResult {
  const parsed = gameStorySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }

  const story = parsed.data;
  const issues: ValidationIssue[] = [];
  const sceneIds = new Set(story.scenes.map((s) => s.id));

  if (sceneIds.size !== story.scenes.length) {
    issues.push({ path: 'scenes', message: 'duplicate scene ids' });
  }

  story.scenes.forEach((scene, idx) => {
    const propIds = new Set(scene.props.map((p) => p.id));
    const at = `scenes.${idx}`;

    const requireProp = (id: string, field: string) => {
      if (!propIds.has(id)) {
        issues.push({
          path: `${at}.${field}`,
          message: `references prop "${id}" which is not in scene "${scene.id}"`,
        });
      }
    };

    const it = scene.interaction;
    switch (it.type) {
      case 'tap_target':
        requireProp(it.target, 'interaction.target');
        it.distractors?.forEach((d, i) => requireProp(d, `interaction.distractors.${i}`));
        break;
      case 'drag_drop':
        requireProp(it.dragId, 'interaction.dragId');
        break;
      case 'collect_items':
        it.targets.forEach((t, i) => requireProp(t, `interaction.targets.${i}`));
        if (it.count > it.targets.length) {
          issues.push({
            path: `${at}.interaction.count`,
            message: `count ${it.count} exceeds ${it.targets.length} targets`,
          });
        }
        break;
      case 'choose_object':
        if (!it.choices.some((c) => c.correct)) {
          issues.push({ path: `${at}.interaction.choices`, message: 'no correct choice' });
        }
        it.choices.forEach((c, i) => requireProp(c.id, `interaction.choices.${i}.id`));
        break;
      case 'path_choice':
        if (!it.paths.some((p) => p.correct)) {
          issues.push({ path: `${at}.interaction.paths`, message: 'no correct path' });
        }
        break;
      case 'reading_choice':
      case 'simple_character_action':
        break;
    }

    if (scene.nextScene !== null && !sceneIds.has(scene.nextScene)) {
      issues.push({
        path: `${at}.nextScene`,
        message: `points at unknown scene "${scene.nextScene}"`,
      });
    }
  });

  const terminal = story.scenes.filter((s) => s.nextScene === null);
  if (terminal.length === 0) {
    issues.push({ path: 'scenes', message: 'no ending scene (nextScene: null)' });
  }

  return { ok: issues.length === 0, issues };
}
