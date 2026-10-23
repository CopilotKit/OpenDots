import { safeParseJSON } from './json';
import { timingSafeEqual } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import http from 'node:http';
import { z } from 'zod';
import { LoginServiceError, type LoginService } from './login-service';

// The agent runs in a separate local server process. This is the one narrow
// door between it and the vault: a Unix socket in a private folder, guarded by
// a random token, offering three things that never return a password.
export type BridgeService = Pick<
  LoginService,
  'listForAgent' | 'signInForAgent' | 'readPageForAgent'
>;

const MAX_BODY_BYTES = 16 * 1024;

const signInBody = z.object({
  site: z.string().min(1),
  username: z.string().min(1),
});
const readPageBody = signInBody.extend({ url: z.string().min(1) });

class BadRequestError extends Error {}

export async function startBridge(options: {
  socketPath: string;
  token: string;
  service: BridgeService;
}): Promise<{ close(): Promise<void> }> {
  const expected = Buffer.from(`Bearer ${options.token}`);

  const server = http.createServer((request, response) => {
    handle(request, response).catch(error => {
      if (error instanceof LoginServiceError) {
        send(response, error.status, { error: error.message });
      } else if (error instanceof BadRequestError) {
        send(response, 400, { error: error.message });
      } else {
        send(response, 500, { error: 'ploop could not do that.' });
      }
    });
  });

  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) {
    const given = Buffer.from(request.headers.authorization ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      send(response, 401, { error: 'Unauthorized.' });
      return;
    }

    const { method, url } = request;
    if (method === 'GET' && url === '/v1/logins') {
      send(response, 200, { logins: await options.service.listForAgent() });
      return;
    }
    if (method === 'POST' && url === '/v1/sign-in') {
      const body = await readBody(request, signInBody);
      send(
        response,
        200,
        await options.service.signInForAgent(body.site, body.username),
      );
      return;
    }
    if (method === 'POST' && url === '/v1/read-page') {
      const body = await readBody(request, readPageBody);
      send(
        response,
        200,
        await options.service.readPageForAgent(
          body.site,
          body.username,
          body.url,
        ),
      );
      return;
    }
    send(response, 404, { error: 'Not found.' });
  }

  await rm(options.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, resolve);
  });
  await chmod(options.socketPath, 0o600);

  return {
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function send(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody<T>(
  request: http.IncomingMessage,
  schema: z.ZodType<T>,
): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequestError('Request too large.');
    chunks.push(chunk as Buffer);
  }

  const parsed = await safeParseJSON({
    text: Buffer.concat(chunks).toString('utf8'),
    schema,
  });
  if (!parsed.success) throw new BadRequestError('Invalid request.');
  return parsed.value;
}
