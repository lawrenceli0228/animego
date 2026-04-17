import axios from 'axios';

// Mock axios before importing the client. Use vi.hoisted so handles stay live
// across the factory and the test body.
const { axiosPost, requestHandlers, responseHandlers } = vi.hoisted(() => ({
  axiosPost: vi.fn(),
  requestHandlers: { fn: null },
  responseHandlers: { ok: null, err: null },
}));

vi.mock('axios', () => {
  const instance = {
    get: vi.fn(),
    interceptors: {
      request: { use: (fn) => { requestHandlers.fn = fn; } },
      response: { use: (ok, err) => { responseHandlers.ok = ok; responseHandlers.err = err; } },
    },
  };
  return {
    default: {
      create: () => instance,
      post: axiosPost,
    },
  };
});

describe('axiosClient 401 refresh flow', () => {
  let setAccessToken;
  let dispatchSpy;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const mod = await import('../api/axiosClient');
    setAccessToken = mod.setAccessToken;
  });

  afterEach(() => {
    dispatchSpy.mockRestore();
  });

  it('defers auth:expired dispatch to a microtask so it does not fire inside the reject stack', async () => {
    setAccessToken('old-token');
    // Refresh itself fails with 401
    axiosPost.mockRejectedValue({ response: { status: 401 } });

    const original = {
      url: '/dandanplay/comments/1',
      headers: {},
    };

    const handler = responseHandlers.err;
    const rejection = handler({
      response: { status: 401 },
      config: original,
    });

    // At this point the rejection handler has returned but the microtask queue
    // has not drained yet — so no dispatchEvent should have fired synchronously.
    expect(dispatchSpy).not.toHaveBeenCalled();

    // Let the microtask queue drain
    await expect(rejection).rejects.toBeDefined();
    await Promise.resolve();

    const calls = dispatchSpy.mock.calls.filter(
      ([ev]) => ev && ev.type === 'auth:expired'
    );
    expect(calls.length).toBe(1);
  });

  it('passes through non-401 errors without calling refresh', async () => {
    axiosPost.mockClear();
    const handler = responseHandlers.err;
    const original = { url: '/anime', headers: {} };

    await expect(
      handler({ response: { status: 500 }, config: original })
    ).rejects.toEqual({ response: { status: 500 }, config: original });

    expect(axiosPost).not.toHaveBeenCalled();
  });

  it('skips retry when the failing request IS the refresh endpoint', async () => {
    axiosPost.mockClear();
    const handler = responseHandlers.err;
    const original = { url: '/api/auth/refresh', headers: {} };

    await expect(
      handler({ response: { status: 401 }, config: original })
    ).rejects.toBeDefined();

    expect(axiosPost).not.toHaveBeenCalled();
  });
});
