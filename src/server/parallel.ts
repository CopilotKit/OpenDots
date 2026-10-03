import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import type { WebSearchProvider } from '../config/env/parallel.js';
export type { WebSearchProvider };
export interface WebConfig {
  webSearchProvider?: WebSearchProvider;
  parallelApiKey?: string;
}
const source = z.object({
  url: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    }),
  title: z.string().nullable().optional(),
  excerpts: z.array(z.string()).default([]),
});
export interface WebSource {
  title: string;
  url: string;
  text: string;
}
export function sourcesFromResult(
  result: unknown,
  warn: (message: string) => void = () => {},
): WebSource[] {
  const envelope = z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.unknown().optional(),
      content: z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .optional(),
    })
    .parse(result);
  if (envelope.isError)
    throw new Error(
      'Parallel could not complete the web request. Retry later or check the provider quota.',
    );
  let data = envelope.structuredContent;
  if (!data) {
    const text = envelope.content?.find((item) => item.type === 'text')?.text;
    try {
      data = JSON.parse(text ?? '');
    } catch {
      throw new Error('Parallel returned an invalid response.');
    }
  }
  const parsed = z
    .object({
      results: z.array(z.unknown()),
      errors: z.array(z.unknown()).optional(),
      warnings: z.array(z.unknown()).nullable().optional(),
    })
    .parse(data);
  if (parsed.errors?.length)
    warn(
      `The provider reported ${parsed.errors.length} source extraction error(s); coverage is incomplete.`,
    );
  if (parsed.warnings?.length)
    warn(
      'The provider returned warnings; some source evidence may be incomplete.',
    );
  let discarded = 0;
  const seen = new Set<string>();
  const sources = parsed.results
    .flatMap((item) => {
      const parsedSource = source.safeParse(item);
      if (!parsedSource.success) {
        discarded++;
        return [];
      }
      const value = parsedSource.data;
      if (seen.has(value.url)) return [];
      if (!value.excerpts.some((text) => text.trim())) {
        discarded++;
        return [];
      }
      seen.add(value.url);
      return [
        {
          title: value.title || value.url,
          url: value.url,
          text: value.excerpts.join('\n').slice(0, 6000),
        },
      ];
    })
    .slice(0, 5);
  if (discarded)
    warn(
      `Skipped ${discarded} malformed or empty source result(s); coverage is incomplete.`,
    );
  return sources;
}
export async function parallelSources(
  request: {
    objective: string;
    urls?: string[];
    sessionId?: string;
    searchQueries?: string[];
    onWarning?: (message: string) => void;
  },
  config: WebConfig,
  signal: AbortSignal,
): Promise<WebSource[]> {
  signal.throwIfAborted();
  if ((config.webSearchProvider ?? 'parallel') !== 'parallel')
    throw new Error('Parallel web research is disabled.');
  const client = new Client({ name: 'opendots', version: '0.1.0' });
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const transport = new StreamableHTTPClientTransport(
    new URL('https://search.parallel.ai/mcp'),
    {
      requestInit: config.parallelApiKey
        ? { headers: { Authorization: `Bearer ${config.parallelApiKey}` } }
        : undefined,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          signal: AbortSignal.any([
            boundedSignal,
            ...(init?.signal ? [init.signal] : []),
          ]),
        }),
    },
  );
  const session_id = request.sessionId ?? randomUUID();
  // Send only the requested research objective and URLs, never memories or the full transcript.
  const objective = request.objective;
  const search_queries = request.searchQueries ?? [objective];
  const warn = request.onWarning ?? (() => {});
  try {
    await client.connect(transport);
    let urls = request.urls;
    if (!urls?.length) {
      const found = sourcesFromResult(
        await client.callTool(
          {
            name: 'web_search',
            arguments: { objective, search_queries, session_id },
          },
          undefined,
          { signal: boundedSignal },
        ),
        warn,
      );
      urls = found.map((page) => page.url);
      if (!urls.length)
        throw new Error(
          'Parallel found no usable sources. Try a more specific research request.',
        );
    }
    for (const url of urls) source.shape.url.parse(url);
    const pages = sourcesFromResult(
      await client.callTool(
        {
          name: 'web_fetch',
          arguments: {
            urls: urls.slice(0, 5),
            objective:
              objective.length <= 200
                ? objective
                : 'Extract source evidence relevant to the supplied research queries.',
            search_queries,
            session_id,
          },
        },
        undefined,
        { signal: boundedSignal },
      ),
      warn,
    );
    if (urls.length > 5)
      warn('Only the first five URLs were read; coverage is limited.');
    if (pages.length < Math.min(urls.length, 5))
      warn('Some requested sources could not be read; coverage is incomplete.');
    boundedSignal.throwIfAborted();
    if (!pages.length)
      throw new Error('Parallel could not extract usable source evidence.');
    return pages;
  } finally {
    await client.close().catch(() => {});
  }
}
