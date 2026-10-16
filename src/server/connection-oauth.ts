import { randomBytes } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ConnectionStore } from './connection-store.js';
export const OAUTH_CALLBACK_PATH = '/oauth/mcp/callback';
const STATE_TTL_MS = 10 * 60_000;
// Persists the MCP SDK's OAuth client state (registration, PKCE verifier,
// tokens, discovery) for one connection. The SDK runs discovery, dynamic
// client registration, PKCE, code exchange, and refresh; OpenDots stores the
// results and hands the authorization URL to the owner's browser.
export class StoredOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  constructor(
    private store: ConnectionStore,
    private id: string,
    // Only an owner-started sign-in may create a pending state; background
    // refreshes during tool calls must not replace it.
    private interactive = false,
  ) {}
  get redirectUrl() {
    return this.store.oauth(this.id).redirectUrl ?? undefined;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'OpenDots',
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    const state = randomBytes(24).toString('base64url');
    if (this.interactive)
      this.store.setState(this.id, state, Date.now() + STATE_TTL_MS);
    return state;
  }
  clientInformation() {
    return this.store.oauth(this.id).client as
      OAuthClientInformationMixed | undefined;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.store.saveOAuth(this.id, { client });
  }
  tokens() {
    return this.store.oauth(this.id).tokens as OAuthTokens | undefined;
  }
  saveTokens(tokens: OAuthTokens) {
    this.store.saveOAuth(this.id, { tokens });
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.store.saveOAuth(this.id, { verifier });
  }
  codeVerifier() {
    const verifier = this.store.oauth(this.id).verifier;
    if (!verifier) throw new Error('No sign-in is in progress.');
    return verifier;
  }
  invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ) {
    this.store.saveOAuth(this.id, {
      ...(scope === 'all' || scope === 'client' ? { client: undefined } : {}),
      ...(scope === 'all' || scope === 'tokens' ? { tokens: undefined } : {}),
      ...(scope === 'all' || scope === 'verifier' ? { verifier: null } : {}),
      ...(scope === 'all' || scope === 'discovery'
        ? { discovery: undefined }
        : {}),
    });
  }
}
