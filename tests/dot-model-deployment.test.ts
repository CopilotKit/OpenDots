import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it.each([
  ['DOT_MODEL_API', 'chat-completions'],
  ['DOT_MAX_OUTPUT_TOKENS', '2200'],
  ['DOT_REASONING_EFFORT', ''],
])('forwards %s with its default into the Docker app', async (name, value) => {
  const compose = await readFile(
    new URL('../compose.yml', import.meta.url),
    'utf8',
  );
  const app = compose
    .split(/^ {2}(?=\S)/m)
    .find((section) => section.startsWith('app:\n'));
  const appEnvironment = app?.match(/^ {4}environment:\n((?: {6}.*\n)+)/m)?.[1];

  expect(appEnvironment).toContain(`      ${name}: \${${name}:-${value}}\n`);
});
