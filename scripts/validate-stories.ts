/**
 * Validates every story JSON in src/stories against the engine schema.
 * Run: npm run validate:stories
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateStory } from '../src/shared/storySchema';

const dir = join(process.cwd(), 'src', 'stories');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

let failed = 0;
for (const file of files) {
  const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const result = validateStory(raw);
  if (result.ok) {
    console.log(`PASS  ${file}  (${raw.scenes.length} scenes)`);
  } else {
    failed++;
    console.log(`FAIL  ${file}`);
    for (const issue of result.issues) {
      console.log(`      ${issue.path}: ${issue.message}`);
    }
  }
}

if (files.length === 0) {
  console.log('No stories found.');
}
process.exit(failed > 0 ? 1 : 0);
