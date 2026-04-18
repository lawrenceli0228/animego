const { createRateLimitedFetch } = require('../utils/rateLimitedFetch');

describe('rateLimitedFetch', () => {
  let originalFetch;
  let originalTimeout;
  let fetchMock;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalTimeout = AbortSignal.timeout;
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
    AbortSignal.timeout = jest.fn((ms) => ({ __timeout: ms }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  });

  it('returns an independent function per call', () => {
    const a = createRateLimitedFetch();
    const b = createRateLimitedFetch();
    expect(a).not.toBe(b);
    expect(typeof a).toBe('function');
  });

  it('calls fetch through for the first request without waiting', async () => {
    const rl = createRateLimitedFetch(500);
    const start = Date.now();
    await rl('https://example.com');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('delays the second call by the interval', async () => {
    const rl = createRateLimitedFetch(200);
    await rl('https://example.com/one');
    const start = Date.now();
    await rl('https://example.com/two');
    const elapsed = Date.now() - start;
    // Allow for small timing slack
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(400);
  });

  it('merges default headers with per-request headers', async () => {
    const rl = createRateLimitedFetch(0, { 'User-Agent': 'test-agent' });
    await rl('https://example.com', { headers: { 'X-Extra': '1' } });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers).toEqual({
      'User-Agent': 'test-agent',
      'X-Extra': '1',
    });
  });

  it('per-request header overrides default header of the same name', async () => {
    const rl = createRateLimitedFetch(0, { 'User-Agent': 'default' });
    await rl('https://example.com', { headers: { 'User-Agent': 'override' } });
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers['User-Agent']).toBe('override');
  });

  it('applies a default 8s AbortSignal.timeout when no signal provided', async () => {
    const rl = createRateLimitedFetch(0);
    await rl('https://example.com');
    expect(AbortSignal.timeout).toHaveBeenCalledWith(8000);
    const [, options] = fetchMock.mock.calls[0];
    expect(options.signal).toEqual({ __timeout: 8000 });
  });

  it('respects a caller-provided signal over the default timeout', async () => {
    const rl = createRateLimitedFetch(0);
    const externalSignal = { custom: true };
    await rl('https://example.com', { signal: externalSignal });
    // Because a signal was supplied, AbortSignal.timeout should NOT be called
    expect(AbortSignal.timeout).not.toHaveBeenCalled();
    const [, options] = fetchMock.mock.calls[0];
    expect(options.signal).toBe(externalSignal);
  });

  it('forwards other request options (method, body)', async () => {
    const rl = createRateLimitedFetch(0);
    await rl('https://example.com', { method: 'POST', body: '{"x":1}' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com');
    expect(options.method).toBe('POST');
    expect(options.body).toBe('{"x":1}');
  });
});
