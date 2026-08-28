import type { InteractionType } from '../../shared/types';
import type { InteractionModule } from '../engineContract';
import { ChooseObject } from './ChooseObject';
import { CollectItems } from './CollectItems';
import { DragDrop } from './DragDrop';
import { PathChoice } from './PathChoice';
import { ReadingChoice } from './ReadingChoice';
import { SimpleCharacterAction } from './SimpleCharacterAction';
import { TapTarget } from './TapTarget';

/**
 * THE INTERACTION PRIMITIVE LIBRARY
 *
 * These seven mechanics are the complete set of things an LLM is allowed to
 * choose from when it turns a book into a game. The model picks a type and
 * fills in content; it never writes gameplay code. Everything here shares the
 * same three promises:
 *
 *   1. A wrong choice is playful. Props wobble, Mimo says something warm, the
 *      child tries again. There is no failure state anywhere in this folder.
 *   2. Help is never decided locally. Every primitive asks
 *      companion.shouldOfferHelp(), which is where the ClickHouse-derived
 *      policy actually reaches into gameplay.
 *   3. Every event emitted is something that really happened, with real
 *      timings measured from when the child could first act.
 */

type Factory = () => InteractionModule;

const REGISTRY: Record<InteractionType, Factory> = {
  tap_target: () => new TapTarget(),
  choose_object: () => new ChooseObject(),
  drag_drop: () => new DragDrop(),
  collect_items: () => new CollectItems(),
  path_choice: () => new PathChoice(),
  reading_choice: () => new ReadingChoice(),
  simple_character_action: () => new SimpleCharacterAction(),
};

/** Every type the story generator is allowed to emit. */
export const INTERACTION_TYPES = Object.keys(REGISTRY) as InteractionType[];

export function isInteractionType(value: string): value is InteractionType {
  return Object.prototype.hasOwnProperty.call(REGISTRY, value);
}

/**
 * Build a fresh module for one beat. Modules are stateful (they own tweens,
 * listeners and a clock), so every scene gets its own instance and must call
 * destroy() when the beat ends - including on early exit.
 */
export function getInteraction(type: InteractionType): InteractionModule {
  const factory = REGISTRY[type];
  if (!factory) {
    // Stories are zod-validated before they reach a screen, so this can only
    // mean the primitive library and the schema have drifted apart. Say so
    // loudly rather than silently playing something else.
    throw new Error(
      `Unknown interaction type "${type}". Known types: ${INTERACTION_TYPES.join(', ')}`,
    );
  }
  return factory();
}

export {
  ChooseObject, CollectItems, DragDrop, PathChoice,
  ReadingChoice, SimpleCharacterAction, TapTarget,
};
