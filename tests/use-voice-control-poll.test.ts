import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useVoice } from '../src/client/useVoice';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api, authHeaders: () => ({}) }));
let voice: ReturnType<typeof useVoice>;
let root: ReactTestRenderer;
let pc: FakePeer | undefined;
const track = { stop: vi.fn(), enabled: true };
class FakePeer {
  connectionState = 'new';
  onconnectionstatechange?: () => void;
  channel = { close: vi.fn(), readyState: 'open' };
  constructor() {
    // The test needs the peer created by the hook, like a browser constructor.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    pc = this;
  }
  createDataChannel() {
    return this.channel;
  }
  addTrack() {}
  async createOffer() {
    return { sdp: 'offer' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {}
  state(value: string) {
    this.connectionState = value;
    this.onconnectionstatechange?.();
  }
}
function Hook() {
  voice = useVoice('thread', () => {});
  return null;
}
function failPolls(times: number) {
  let seen = 0;
  api.mockImplementation(async (path: string) => {
    if (path === '/voice/calls') return { id: 'call', sdp: 'answer' };
    if (path === '/voice/calls/call' && seen < times) {
      seen += 1;
      throw new Error('network flap');
    }
    return { endedAt: null };
  });
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
  });
  vi.stubGlobal(
    'Audio',
    class {
      autoplay = false;
      srcObject = null;
      pause() {}
    },
  );
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
  api
    .mockReset()
    .mockImplementation(async (path: string) =>
      path === '/voice/calls'
        ? { id: 'call', sdp: 'answer' }
        : { endedAt: null },
    );
  await act(async () => {
    root = create(createElement(Hook));
  });
  await act(async () => {
    await voice.start();
    pc?.state('connected');
  });
  expect(voice.status).toBe('active');
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const ends = () => api.mock.calls.filter(([path]) => path.endsWith('/end'));
it('keeps the call alive after a single failed control poll', async () => {
  failPolls(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(ends()).toHaveLength(0);
  expect(voice.status).toBe('active');
  expect(voice.error).toBe('');
});
it('keeps the call alive when a later poll succeeds before the failure limit', async () => {
  failPolls(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(ends()).toHaveLength(0);
  failPolls(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(ends()).toHaveLength(0);
  expect(voice.status).toBe('active');
});
it('ends the call after three consecutive failed control polls', async () => {
  failPolls(3);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(ends()).toHaveLength(1);
  expect(voice.status).toBe('idle');
  expect(voice.error).toBe('Call control connection was lost.');
});
it('ends a persistently failing control poll exactly once', async () => {
  failPolls(10);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(ends()).toHaveLength(1);
});
