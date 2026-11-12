import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parallelSources } from '../src/server/parallel.js';

const version = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    version: string;
  }
).version;
const userAgent = `opendots/${version}`;
const page = {
  title: 'Evidence',
  url: 'https://example.com',
  excerpts: ['Verified evidence.'],
};

async function captureParallelRequests() {
  const requests: { headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ headers: request.headers, body });
    const message = JSON.parse(body) as { id?: number; method?: string };
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1.0.0' },
          }
        : {
            content: [
              { type: 'text', text: JSON.stringify({ results: [page] }) },
            ],
            structuredContent: { results: [page] },
          };
    response.writeHead(200, {
      'content-type': 'application/json',
      'mcp-session-id': 'session-1',
    });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('The mock Parallel server has no port.');
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', (async (
    url: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const target = url instanceof Request ? url.url : String(url);
    if (target === 'https://search.parallel.ai/mcp')
      return original(`http://127.0.0.1:${address.port}/mcp`, init);
    return original(url, init);
  }) as typeof fetch);
  return {
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Parallel User-Agent', () => {
  it('sends opendots/<package version> on MCP requests without a key', async () => {
    const captured = await captureParallelRequests();
    try {
      const sources = await parallelSources(
        {
          objective: 'Read',
          urls: ['https://example.com'],
          sessionId: 'conversation-1',
        },
        {},
        new AbortController().signal,
      );
      expect(sources).toEqual([
        {
          title: 'Evidence',
          url: 'https://example.com',
          text: 'Verified evidence.',
        },
      ]);
      const calls = captured.requests.map((request) => ({
        userAgent: request.headers['user-agent'],
        authorization: request.headers.authorization,
        message: JSON.parse(request.body) as {
          method?: string;
          params?: { clientInfo?: { name: string; version: string } };
        },
      }));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.map((call) => call.userAgent)).toEqual(
        calls.map(() => userAgent),
      );
      expect(calls.map((call) => call.authorization)).toEqual(
        calls.map(() => undefined),
      );
      expect(
        calls.find((call) => call.message.method === 'initialize')?.message
          .params?.clientInfo,
      ).toEqual({ name: 'opendots', version });
      expect(calls.some((call) => call.message.method === 'tools/call')).toBe(
        true,
      );
    } finally {
      await captured.close();
    }
  });

  it('keeps the same User-Agent when a Parallel API key is configured', async () => {
    const captured = await captureParallelRequests();
    try {
      await parallelSources(
        {
          objective: 'Read',
          urls: ['https://example.com'],
          sessionId: 'conversation-1',
        },
        { parallelApiKey: 'test-key' },
        new AbortController().signal,
      );
      expect(captured.requests.length).toBeGreaterThan(0);
      for (const request of captured.requests) {
        expect(request.headers['user-agent']).toBe(userAgent);
        expect(request.headers.authorization).toBe('Bearer test-key');
      }
    } finally {
      await captured.close();
    }
  });
});
