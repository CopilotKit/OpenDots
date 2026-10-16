import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { DemoInMemoryAuthProvider } from '@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
// A real OAuth-protected MCP server: discovery, dynamic client registration,
// PKCE, an auto-approving consent step, refresh tokens, and bearer checks.
class RefreshingProvider extends DemoInMemoryAuthProvider {
  refreshes = 0;
  private refreshTokens = new Map<string, string>();
  private issue(clientId: string) {
    const token = randomUUID();
    (this as unknown as { tokens: Map<string, unknown> }).tokens.set(token, {
      token,
      clientId,
      scopes: [],
      expiresAt: Date.now() + 3_600_000,
      type: 'access',
    });
    const refresh = randomUUID();
    this.refreshTokens.set(refresh, clientId);
    return {
      access_token: token,
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: refresh,
    };
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ) {
    await super.exchangeAuthorizationCode(client, code);
    return this.issue(client.client_id);
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ) {
    if (this.refreshTokens.get(refreshToken) !== client.client_id)
      throw new Error('Invalid refresh token');
    this.refreshTokens.delete(refreshToken);
    this.refreshes++;
    return this.issue(client.client_id);
  }
  // Expired tokens are a 401 invalid_token (the demo throws a plain Error,
  // which the middleware reports as a 500).
  async verifyAccessToken(token: string) {
    try {
      return await super.verifyAccessToken(token);
    } catch {
      throw new InvalidTokenError('Invalid or expired token');
    }
  }
  expireAccessTokens() {
    (this as unknown as { tokens: Map<string, unknown> }).tokens.clear();
  }
}
export async function oauthMcpServer(port = 0) {
  const app = express();
  const http = await new Promise<import('node:http').Server>((resolve) => {
    const server = app.listen(port, 'localhost', () => resolve(server));
  });
  const base = new URL(
    `http://localhost:${(http.address() as AddressInfo).port}`,
  );
  const mcpUrl = new URL('/mcp', base);
  const provider = new RefreshingProvider();
  const calls: string[] = [];
  app.use(
    mcpAuthRouter({ provider, issuerUrl: base, resourceServerUrl: mcpUrl }),
  );
  app.post(
    '/mcp',
    express.json(),
    requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    }),
    async (req, res) => {
      const server = new McpServer({ name: 'calendar', version: '1.0.0' });
      server.registerTool(
        'list_events',
        {
          description: 'List upcoming events.',
          inputSchema: { day: z.string() },
          annotations: { readOnlyHint: true },
        },
        async ({ day }) => {
          calls.push(day);
          return { content: [{ type: 'text', text: `Standup on ${day}` }] };
        },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );
  return {
    url: mcpUrl.toString(),
    provider,
    calls,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
