import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  PageTitleField,
  singleLineTitle,
} from '../src/client/editor/PageTitleField';

it('renders the page title as a wrapping textarea so long titles are not clipped', () => {
  const html = renderToStaticMarkup(
    <PageTitleField
      value="AI Coworkers: OpenAI Dots vs Meta Muse vs OpenDots"
      onChange={() => {}}
    />,
  );
  expect(html).toContain('<textarea');
  expect(html).toContain('aria-label="Page title"');
  expect(html).toContain('rows="1"');
  expect(html).toContain('maxLength="160"');
  expect(html).toContain('AI Coworkers: OpenAI Dots vs Meta Muse vs OpenDots');
});

it('keeps the title on a single logical line when text with line breaks is pasted', () => {
  expect(singleLineTitle('First\nSecond\r\nThird')).toBe('First Second Third');
  expect(singleLineTitle('Plain title')).toBe('Plain title');
});
