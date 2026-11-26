import type { WorkspaceStore } from './workspace.js';

export interface SearchPageHit {
  kind: 'page';
  id: string;
  spaceId: string;
  spaceName: string;
  title: string;
  excerpt: string;
  updatedAt: number;
  score: number;
}

export interface SearchSpaceHit {
  kind: 'space';
  id: string;
  name: string;
  description: string;
  score: number;
}

export interface SearchDotHit {
  kind: 'dot';
  id: string;
  name: string;
  instructions: string;
  score: number;
}

export interface SearchResults {
  query: string;
  pages: SearchPageHit[];
  spaces: SearchSpaceHit[];
  dots: SearchDotHit[];
}

export function tokenize(query: string): string[] {
  return query
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 8);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function subsequenceBonus(text: string, token: string): number {
  // Cheap fuzzy path: rewards in-order letters (e.g. "pln" ~ "plan").
  let position = 0;
  let matched = 0;
  for (const char of token) {
    const found = text.indexOf(char, position);
    if (found === -1) return 0;
    matched += 1;
    position = found + 1;
  }
  return matched === token.length ? token.length * 0.5 : 0;
}

export function scoreText(
  title: string,
  body: string,
  tokens: string[],
): { score: number; matched: number } {
  const lowerTitle = title.toLocaleLowerCase();
  const lowerBody = body.toLocaleLowerCase().slice(0, 20000);
  let score = 0;
  let matched = 0;
  for (const token of tokens) {
    const inTitle = countOccurrences(lowerTitle, token);
    const inBody = countOccurrences(lowerBody, token);
    if (inTitle > 0) {
      matched += 1;
      score += 12 * inTitle;
      if (lowerTitle.startsWith(token)) score += 8;
      else if (lowerTitle.split(/\s+/).some((word) => word.startsWith(token)))
        score += 4;
    } else if (inBody > 0) {
      matched += 1;
      score += Math.min(inBody, 5);
    } else {
      score += subsequenceBonus(lowerTitle, token);
    }
  }
  return { score, matched };
}

export function excerpt(
  content: string,
  tokens: string[],
  length = 160,
): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const lower = text.toLocaleLowerCase();
  let at = -1;
  for (const token of tokens) {
    const found = lower.indexOf(token);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  const start = at === -1 ? 0 : Math.max(0, at - Math.floor(length / 3));
  const slice = text.slice(start, start + length);
  return (
    (start > 0 ? '… ' : '') + slice + (start + length < text.length ? ' …' : '')
  );
}

export function searchWorkspace(
  workspace: WorkspaceStore,
  query: string,
  limit = 20,
): SearchResults {
  const trimmed = query.trim().slice(0, 200);
  const tokens = tokenize(trimmed);
  const spaces = workspace.spaces();
  const spaceNames = new Map(spaces.map((space) => [space.id, space.name]));
  const dots = workspace.dots();

  if (!tokens.length)
    return { query: trimmed, pages: [], spaces: [], dots: [] };

  const capped = Math.min(Math.max(limit, 1), 50);

  const pageHits: SearchPageHit[] = [];
  const listPages = (spaceId: string) => {
    try {
      return workspace.pages.list(spaceId);
    } catch {
      return [];
    }
  };
  for (const space of spaces) {
    for (const page of listPages(space.id)) {
      const { score, matched } = scoreText(
        page.title,
        `${space.name} ${page.content}`,
        tokens,
      );
      if (matched === 0) continue;
      // Require multi-token queries to match at least half the tokens.
      if (tokens.length > 1 && matched < Math.ceil(tokens.length / 2)) continue;
      pageHits.push({
        kind: 'page',
        id: page.id,
        spaceId: space.id,
        spaceName: space.name,
        title: page.title,
        excerpt: excerpt(page.content, tokens),
        updatedAt: page.updatedAt,
        score: score + page.updatedAt / 1e13,
      });
    }
  }

  const spaceHits: SearchSpaceHit[] = [];
  for (const space of spaces) {
    const { score, matched } = scoreText(space.name, space.description, tokens);
    if (matched === 0) continue;
    spaceHits.push({
      kind: 'space',
      id: space.id,
      name: space.name,
      description: space.description.slice(0, 200),
      score,
    });
  }

  const dotHits: SearchDotHit[] = [];
  for (const dot of dots) {
    const spaceName = spaceNames.get(dot.spaceId) ?? '';
    const { score, matched } = scoreText(
      dot.name,
      `${dot.instructions} ${spaceName}`,
      tokens,
    );
    if (matched === 0) continue;
    dotHits.push({
      kind: 'dot',
      id: dot.id,
      name: dot.name,
      instructions: dot.instructions.slice(0, 200),
      score,
    });
  }

  pageHits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  spaceHits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  dotHits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return {
    query: trimmed,
    pages: pageHits.slice(0, capped),
    spaces: spaceHits.slice(0, Math.min(10, capped)),
    dots: dotHits.slice(0, Math.min(10, capped)),
  };
}
