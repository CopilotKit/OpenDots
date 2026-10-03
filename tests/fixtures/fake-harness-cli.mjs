/* global fetch, AbortSignal */
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { setInterval, setTimeout } from 'node:timers';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

// Only synthetic test metadata is recorded. Never record environment values.
const config = JSON.parse(
  readFileSync(process.env.OPENDOTS_TEST_HARNESS_FIXTURE, 'utf8'),
);
const provider = process.argv[2];
const args = process.argv.slice(3);
const auth =
  provider === 'claude-code' ? args[0] === 'auth' : args[0] === 'login';
appendFileSync(
  config.receipts,
  JSON.stringify({
    provider,
    phase: auth ? 'auth' : 'turn',
    args: args.map((arg) =>
      arg.replace(/Bearer [^"}]+/g, 'Bearer [test bridge token]'),
    ),
    cwd: process.cwd(),
    pid: process.pid,
    homePresent: process.env.HOME !== undefined,
    home: process.env.HOME === config.testHome ? config.testHome : undefined,
    present: config.scrubKeys.filter((key) => key in process.env),
  }) + '\n',
);

if (auth) {
  if (config.auth === 'hang') {
    // A valid partial response must not be accepted after the owner cancels.
    if (provider === 'claude-code')
      console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
    else console.error('Logged in using ChatGPT');
    setTimeout(() => process.exit(2), 15_000).unref();
    setInterval(() => writeFileSync(config.heartbeat, String(Date.now())), 40);
    await new Promise(() => {});
  }
  if (config.auth === 'missing') {
    console.error(`${provider}: command not found`);
    process.exit(127);
  }
  if (provider === 'claude-code') {
    console.log(
      JSON.stringify({
        loggedIn: config.auth !== 'logged-out',
        authMethod: config.auth === 'api-key' ? 'api_key' : 'claude.ai',
      }),
    );
  } else {
    console.error(
      config.auth === 'api-key'
        ? 'Logged in using an API key'
        : config.auth === 'logged-out'
          ? 'Not logged in'
          : 'Logged in using ChatGPT',
    );
  }
  process.exit(config.auth === 'logged-out' ? 1 : 0);
}

const emit = (event) => console.log(JSON.stringify(event));
if (config.turn === 'tools') {
  let url, authorization;
  if (provider === 'claude-code') {
    const index = args.indexOf('--mcp-config');
    const mcp = JSON.parse(readFileSync(args[index + 1], 'utf8'));
    const bridge = Object.values(mcp.mcpServers)[0];
    url = bridge.url;
    authorization = bridge.headers.Authorization;
  } else {
    url = args
      .find((arg) => /^mcp_servers\..*\.url=/.test(arg))
      ?.split('=')[1]
      .replaceAll('"', '');
    authorization = args
      .find((arg) => /^mcp_servers\..*\.http_headers=/.test(arg))
      ?.match(/Bearer [^"}]+/)?.[0];
  }
  if (
    !url ||
    !authorization ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
  ) {
    throw new Error('The test must only contact its loopback tool bridge');
  }
  const call = async (id, name, input) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: authorization,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: input },
      }),
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    const data = text.split('\n').find((line) => line.startsWith('data: '));
    return JSON.parse(data ? data.slice(6) : text);
  };
  const denied = await call(1, 'create_space_page', {
    title: 'Forbidden page',
    content: 'Forbidden',
    spaceId: 'unowned-space',
  });
  const allowed = await call(2, 'create_space_page', {
    title: 'Bridge-created page',
    content: '# From a real CLI subprocess',
  });
  writeFileSync(config.bridgeReceipts, JSON.stringify({ denied, allowed }));
}
if (provider === 'claude-code') {
  emit({
    type: 'system',
    subtype: 'init',
    session_id: 'fake-claude-session',
    model: 'fixture-model',
    tools: [],
    cwd: process.cwd(),
  });
} else {
  emit({ type: 'thread.started', thread_id: 'fake-codex-session' });
  emit({ type: 'turn.started' });
}

if (config.turn === 'hang') {
  // Bound the fixture's lifetime even if a regression breaks every teardown path.
  setTimeout(() => process.exit(2), 15_000).unref();
  setInterval(() => writeFileSync(config.heartbeat, String(Date.now())), 40);
} else {
  // Drain stdin so the real SDK's prompt writer can complete before CLI exit.
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once('end', resolve));
  if (config.turn === 'error') {
    emit(
      provider === 'claude-code'
        ? {
            type: 'result',
            subtype: 'error_during_execution',
            errors: ['Synthetic CLI turn failed: synthetic-api-key'],
          }
        : {
            type: 'turn.failed',
            error: { message: 'Synthetic CLI turn failed: synthetic-api-key' },
          },
    );
  } else if (provider === 'claude-code') {
    emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'fake-assistant',
        content: [{ type: 'text', text: 'Local subscription turn completed.' }],
      },
    });
    emit({
      type: 'result',
      subtype: 'success',
      result: 'Local subscription turn completed.',
    });
  } else {
    emit({
      type: 'item.completed',
      item: {
        id: 'fake-assistant',
        type: 'agent_message',
        text: 'Local subscription turn completed.',
      },
    });
    emit({
      type: 'turn.completed',
      usage: { input_tokens: 4, output_tokens: 5 },
    });
  }
}
