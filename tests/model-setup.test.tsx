import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ModelCheck, SetupStatus } from '../src/shared/types';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));
import { ModelSetup } from '../src/client/ModelSetup';

const setup: SetupStatus = {
  intelligence: false,
  model: false,
  modelProvider: 'openai',
  browser: false,
  voice: false,
  composio: false,
  slack: 'not_configured',
  missing: ['OPENAI_API_KEY', 'OPENAI_MODEL'],
};
const ollama: SetupStatus = {
  ...setup,
  model: true,
  modelProvider: 'ollama',
  modelBaseUrl: 'http://localhost:11434/v1',
  missing: [],
};
const notRunning: ModelCheck = {
  ok: false,
  provider: 'ollama',
  models: [],
  message: "Ollama isn't running at http://localhost:11434/v1.",
  hint: 'Start it (open the Ollama app or run `ollama serve`), then check again.',
};
async function render(status: SetupStatus) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ModelSetup, { setup: status }));
  });
  return renderer;
}
const button = (renderer: ReactTestRenderer) =>
  renderer.root.findByType('button');
const label = (renderer: ReactTestRenderer) =>
  button(renderer).children.filter((child) => typeof child === 'string');
const status = (renderer: ReactTestRenderer) =>
  renderer.root.findByProps({ role: 'status' });
// The status block's text with inline code flattened, one entry per line.
const lines = (renderer: ReactTestRenderer) =>
  status(renderer)
    .findAllByType('p')
    .map((p) =>
      p.children
        .map((child) =>
          typeof child === 'string'
            ? child
            : child
                .findAll((node) => typeof node.type === 'string')
                .flatMap((node) =>
                  node.children.filter((c) => typeof c === 'string'),
                )
                .join(''),
        )
        .join(''),
    );
beforeEach(() => {
  api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

it('offers OpenAI or a keyless Ollama model when no model is configured', () => {
  const html = renderToStaticMarkup(<ModelSetup setup={setup} />);
  expect(html).toContain('Model provider: OpenAI');
  expect(html).toContain('<code>OPENAI_API_KEY</code>');
  expect(html).toContain('<code>MODEL_PROVIDER=ollama</code>');
  expect(html).toContain('<code>OLLAMA_MODEL</code>');
  // Without a key there is nothing to check yet.
  expect(html).not.toContain('<button');
});

it('shows the selected Ollama endpoint and an outlined check button', () => {
  const html = renderToStaticMarkup(<ModelSetup setup={ollama} />);
  expect(html).toContain('Ollama (local)');
  expect(html).toContain('<code>http://localhost:11434/v1</code>, no API key');
  expect(html).toContain('class="model-check-button"');
  expect(html).toContain('>Check Ollama</button>');
  expect(html).not.toContain('text-button');
  expect(html).not.toContain('OPENAI_API_KEY');
  expect(
    renderToStaticMarkup(
      <ModelSetup
        setup={{ ...ollama, model: false, missing: ['OLLAMA_MODEL'] }}
      />,
    ),
  ).toContain('Check Ollama');
});

it('announces the result in a status region the button describes', async () => {
  const renderer = await render(ollama);
  // The live region exists before any result so screen readers announce it.
  expect(status(renderer).props['aria-live']).toBe('polite');
  expect(status(renderer).children).toEqual([]);
  expect(button(renderer).props['aria-describedby']).toBe(
    status(renderer).props.id,
  );
  expect(button(renderer).props.type).toBe('button');
});

it('confirms success once and lists only the other models', async () => {
  api.mockResolvedValue({
    ok: true,
    provider: 'ollama',
    models: ['qwen3:4b'],
    message: 'Ollama is running and has llama3.2:1b.',
  } satisfies ModelCheck);
  const renderer = await render(ollama);
  await act(async () => button(renderer).props.onClick());
  expect(api).toHaveBeenCalledWith('/setup/model');
  expect(status(renderer).props.className).toBe('model-check ok');
  expect(lines(renderer)).toEqual([
    'Ollama is running and has llama3.2:1b.',
    'Also available: qwen3:4b',
  ]);
  expect(label(renderer)).toEqual(['Check again']);
});

it('shows only the headline when Ollama has no other models', async () => {
  api.mockResolvedValue({
    ok: true,
    provider: 'ollama',
    models: [],
    message: 'Ollama is running and has llama3.2:1b.',
  } satisfies ModelCheck);
  const renderer = await render(ollama);
  await act(async () => button(renderer).props.onClick());
  expect(lines(renderer)).toEqual(['Ollama is running and has llama3.2:1b.']);
});

it('pairs a not-running headline with one next step and an icon', async () => {
  api.mockResolvedValue(notRunning);
  const renderer = await render(ollama);
  await act(async () => button(renderer).props.onClick());
  expect(status(renderer).props.className).toBe('model-check problem');
  expect(lines(renderer)).toEqual([
    "Ollama isn't running at http://localhost:11434/v1.",
    'Start it (open the Ollama app or run ollama serve), then check again.',
  ]);
  expect(status(renderer).findByType('code').children).toEqual([
    'ollama serve',
  ]);
  // Status is never conveyed by colour alone.
  expect(
    status(renderer).findAll(
      (node) =>
        typeof node.props.className === 'string' &&
        node.props.className.includes('model-check-icon'),
    ).length,
  ).toBeGreaterThan(0);
});

it('offers the available models when the configured model is not pulled', async () => {
  api.mockResolvedValue({
    ok: false,
    provider: 'ollama',
    models: ['llama3.2:1b'],
    message: "Ollama doesn't have llama3.2 yet.",
    hint: 'Run `ollama pull llama3.2`, then check again.',
  } satisfies ModelCheck);
  const renderer = await render(ollama);
  await act(async () => button(renderer).props.onClick());
  expect(lines(renderer)).toEqual([
    "Ollama doesn't have llama3.2 yet.",
    'Run ollama pull llama3.2, then check again.',
    'Available models: llama3.2:1b',
  ]);
});

it('keeps focus on the busy button and ignores repeat presses', async () => {
  let finish!: (value: ModelCheck) => void;
  api.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const renderer = await render(ollama);
  await act(async () => {
    button(renderer).props.onClick();
    button(renderer).props.onClick();
  });
  expect(api).toHaveBeenCalledTimes(1);
  expect(button(renderer).props).toMatchObject({
    'aria-busy': true,
    'aria-disabled': true,
  });
  expect(button(renderer).props.disabled).toBeUndefined();
  expect(label(renderer)).toEqual(['Checking…']);
  await act(async () => finish(notRunning));
  expect(button(renderer).props['aria-busy']).toBe(false);
  expect(label(renderer)).toEqual(['Check again']);
});

it('reports a failed request instead of leaving the check pending', async () => {
  api.mockRejectedValue(new Error('Enter your owner access token.'));
  const renderer = await render(ollama);
  await act(async () => button(renderer).props.onClick());
  expect(lines(renderer)).toEqual(['Enter your owner access token.']);
  expect(status(renderer).props.className).toBe('model-check problem');
});
