import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { VoiceService } from '../src/server/voice.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
const resources: (() => void)[] = [];
afterEach(() => {
  resources.splice(0).forEach((close) => close());
  vi.useRealTimers();
});
function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  workspace.bindThread('thread', workspace.dots()[0].id, 'A conversation');
  resources.push(() => {
    store.close();
    workspace.close();
  });
  const config: PlatformConfig = {
    baseUrl: 'https://example.com',
    voiceKey: 'test-secret',
    voiceModel: 'voice-model',
    voiceName: 'marin',
    runtimeUrl: '',
    slackUsers: [],
  };
  const turn = vi.fn(
    async (_thread: string, _prompt: string, _signal: AbortSignal) =>
      'Current answer',
  );
  const history = vi.fn(async () => 'user: Earlier topic');
  const transport = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/hangup')
      ? new Response(null, { status: 200 })
      : new Response('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111', {
          headers: { location: '/v1/realtime/calls/rtc_test' },
        }),
  );
  const voice = new VoiceService(
    {
      workspace,
      store,
      config,
      turn,
      history,
      requireReady() {},
      setup: () => ({
        voice: true,
        intelligence: true,
        model: true,
        browser: false,
        slack: 'not_configured',
        sendblue: 'not_configured',
        missing: [],
      }),
    },
    transport,
  );
  return { voice, transport, workspace, store, turn, history };
}
const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111';
it('binds voice history and compute to the existing thread, deduplicates tools and hangs up remotely', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  expect(f.history).toHaveBeenCalledWith('thread');
  const body = f.transport.mock.calls[0][1]?.body;
  expect(body).toBeInstanceOf(FormData);
  expect(String((body as FormData).get('session'))).toContain('Earlier topic');
  f.voice.activate(call.id);
  await Promise.all([
    f.voice.compute(call.id, 'tool-1', 'Research'),
    f.voice.compute(call.id, 'tool-1', 'Research'),
  ]);
  expect(f.turn).toHaveBeenCalledTimes(1);
  expect(f.turn.mock.calls[0]?.[0]).toBe('thread');
  await f.voice.end(call.id, 'Confirmed discussion');
  expect(
    f.transport.mock.calls.some(([url]) =>
      String(url).endsWith('/rtc_test/hangup'),
    ),
  ).toBe(true);
  expect(f.workspace.call(call.id).status).toBe('ended');
  expect(f.turn).toHaveBeenLastCalledWith(
    'thread',
    expect.stringContaining('Record a short call receipt'),
    expect.any(AbortSignal),
    { opendotsSource: 'voice_receipt' },
  );
  await expect(f.voice.compute(call.id, 'late', 'Research')).rejects.toThrow(
    'ended',
  );
});
it('rejects unowned threads before provider contact and expires unactivated peers', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await expect(
    f.voice.begin('foreign', offer, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.transport).not.toHaveBeenCalled();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(30_001);
  expect(f.workspace.call(call.id).status).toBe('failed');
  expect(
    f.transport.mock.calls.some(([url]) => String(url).endsWith('/hangup')),
  ).toBe(true);
});
it('aborts a pending history lookup without starting a provider session', async () => {
  const f = fixture();
  f.history.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = f.voice.begin('thread', offer, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  expect(f.transport).not.toHaveBeenCalled();
});
it('fails visibly for provider errors and does not claim an active call', async () => {
  const f = fixture();
  f.transport.mockResolvedValue(
    new Response('provider error', { status: 429 }),
  );
  await expect(
    f.voice.begin('thread', offer, new AbortController().signal),
  ).rejects.toThrow('429');
  expect(f.workspace.calls()[0].status).toBe('failed');
});
it('hangs up a provisioned peer whose SDP is invalid', async () => {
  const f = fixture();
  f.transport.mockResolvedValueOnce(
    new Response('invalid SDP', {
      headers: { location: '/v1/realtime/calls/rtc_test' },
    }),
  );
  await expect(
    f.voice.begin('thread', offer, new AbortController().signal),
  ).rejects.toThrow('invalid SDP');
  expect(
    f.transport.mock.calls.some(([url]) =>
      String(url).endsWith('/rtc_test/hangup'),
    ),
  ).toBe(true);
});
it('saves a late transcript after expiry without changing the ended status or duration', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(30_001);
  const expired = f.workspace.call(call.id);
  await f.voice.end(call.id, 'Buffered speech at disconnect');
  await f.voice.end(call.id, 'Buffered speech at disconnect');
  expect(f.workspace.call(call.id)).toMatchObject({
    status: 'failed',
    endedAt: expired.endedAt,
    transcript: 'Buffered speech at disconnect',
  });
  expect(f.turn).toHaveBeenCalledTimes(1);
});
it('defers paused transcript synchronization and resumes it once without a duplicate turn', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.store.updateSettings({ paused: true });
  f.voice.abortAll();
  await f.voice.end(call.id, 'Speech saved while paused');
  expect(f.turn).not.toHaveBeenCalled();
  expect(f.workspace.call(call.id).transcript).toBe(
    'Speech saved while paused',
  );
  expect(f.workspace.call(call.id).error).toContain(
    'pending Intelligence sync',
  );
  f.store.updateSettings({ paused: false });
  await f.voice.resumePending();
  await f.voice.resumePending();
  expect(f.turn).toHaveBeenCalledTimes(1);
  expect(f.workspace.call(call.id).status).toBe('failed');
});

it('reports rejected provider hangup status without exposing its response body', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.transport.mockResolvedValueOnce(
    new Response('sensitive provider details', { status: 409 }),
  );
  const ended = await f.voice.end(call.id, 'Confirmed discussion');
  expect(ended.status).toBe('ended');
  expect(ended.error).toContain('HTTP 409');
  expect(ended.error).not.toContain('sensitive provider details');
});
it('reports transport hangup failures without exposing transport errors', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.transport.mockRejectedValueOnce(new Error('sensitive transport details'));
  const ended = await f.voice.end(call.id, 'Confirmed discussion');
  expect(ended.error).toBe(
    'The local call stopped, but provider hangup failed (Error).',
  );
});

it('distinguishes provider hangup timeout from transport failure', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.transport.mockRejectedValueOnce(
    new DOMException('sensitive timeout details', 'TimeoutError'),
  );
  const ended = await f.voice.end(call.id, 'Confirmed discussion');
  expect(ended.error).toBe(
    'The local call stopped, but provider hangup timed out.',
  );
});
it('sanitizes custom provider transport error names', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  const error = new Error('sensitive transport details');
  error.name = 'sensitive provider identifier';
  f.transport.mockRejectedValueOnce(error);
  const ended = await f.voice.end(call.id, 'Confirmed discussion');
  expect(ended.error).toBe(
    'The local call stopped, but provider hangup failed (transport error).',
  );
});
it('allows a rejected compute call to be retried with the same tool ID', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.voice.activate(call.id);
  f.turn.mockRejectedValueOnce(new Error('Provider unavailable'));
  await expect(f.voice.compute(call.id, 'retry', 'Research')).rejects.toThrow(
    'Provider unavailable',
  );
  await expect(f.voice.compute(call.id, 'retry', 'Research')).resolves.toBe(
    'Current answer',
  );
  expect(f.turn).toHaveBeenCalledTimes(2);
  await f.voice.end(call.id, '');
});
it('counts failed compute attempts toward the six-turn limit', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.voice.activate(call.id);
  for (let i = 0; i < 6; i++) {
    f.turn.mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(
      f.voice.compute(call.id, `failed-${i}`, 'Research'),
    ).rejects.toThrow('Provider unavailable');
  }
  await expect(f.voice.compute(call.id, 'success', 'Research')).rejects.toThrow(
    'six compute-turn limit',
  );
  expect(f.turn).toHaveBeenCalledTimes(6);
  await f.voice.end(call.id, '');
});
it('counts a retry of the same tool ID as another attempt', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.voice.activate(call.id);
  for (let i = 0; i < 6; i++) {
    f.turn.mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(f.voice.compute(call.id, 'same', 'Research')).rejects.toThrow(
      'Provider unavailable',
    );
  }
  await expect(f.voice.compute(call.id, 'same', 'Research')).rejects.toThrow(
    'six compute-turn limit',
  );
  expect(f.turn).toHaveBeenCalledTimes(6);
  await f.voice.end(call.id, '');
});
it('keeps successful compute turns cached and enforces the six-turn cap', async () => {
  const f = fixture();
  const call = await f.voice.begin(
    'thread',
    offer,
    new AbortController().signal,
  );
  f.voice.activate(call.id);
  for (let i = 0; i < 6; i++) {
    await expect(f.voice.compute(call.id, String(i), 'Research')).resolves.toBe(
      'Current answer',
    );
  }
  await expect(f.voice.compute(call.id, '0', 'Research')).resolves.toBe(
    'Current answer',
  );
  expect(f.turn).toHaveBeenCalledTimes(6);
  await expect(f.voice.compute(call.id, 'extra', 'Research')).rejects.toThrow(
    'six compute-turn limit',
  );
  await f.voice.end(call.id, '');
});
