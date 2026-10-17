import { siteHost } from './origin';

type Matchable = {
  label: string;
  url: string;
  username: string;
  agentAccess: boolean;
};

export type Resolution<T> =
  | { ok: true; login: T }
  | {
      ok: false;
      reason: 'not-found' | 'ambiguous' | 'no-agent-access';
      message: string;
    };

function normalizeSite(site: string) {
  const trimmed = site.trim().toLowerCase();
  const host = siteHost(
    trimmed.includes('://') ? trimmed : `https://${trimmed}`,
  );
  return host === '' ? trimmed : host;
}

// Finds the saved login the agent means by a site name ("github.com", "GitHub",
// or a full address) and a username. Never guesses between two accounts.
export function resolveLogin<T extends Matchable>(
  logins: T[],
  site: string,
  username: string,
): Resolution<T> {
  const wanted = normalizeSite(site);
  const matches = logins.filter(login => {
    const host = siteHost(login.url);
    return (
      login.label.trim().toLowerCase() === wanted ||
      host === wanted ||
      // "example.com" also means "login.example.com", but a bare word such as
      // "com" never means every site under it.
      (wanted.includes('.') && host.endsWith(`.${wanted}`))
    );
  });

  if (matches.length === 0) {
    return {
      ok: false,
      reason: 'not-found',
      message: `There is no saved login for ${site}. Ask the user to add it in the Vault.`,
    };
  }

  const byUser = matches.filter(
    login => login.username.toLowerCase() === username.trim().toLowerCase(),
  );
  if (byUser.length === 0) {
    return {
      ok: false,
      reason: 'not-found',
      message: `There is no saved login for ${site} with that username. Call list_logins to see the accounts that exist.`,
    };
  }
  if (byUser.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: `More than one saved login matches ${site} and that username. Ask the user which one to use.`,
    };
  }

  const login = byUser[0];
  if (!login.agentAccess) {
    return {
      ok: false,
      reason: 'no-agent-access',
      message: `The user has not allowed ploop to use the ${site} login. They can turn on Agent access for it in the Vault.`,
    };
  }
  return { ok: true, login };
}
