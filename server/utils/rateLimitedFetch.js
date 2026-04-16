/**
 * Generic rate-limited fetch factory.
 * Each call to createRateLimitedFetch returns an independent instance
 * with its own timing state, so Bangumi and dandanplay queues stay separate.
 */
function createRateLimitedFetch(interval = 800, defaultHeaders = {}) {
  let lastCallAt = 0;

  return async function rateLimitedFetch(url, options = {}) {
    const wait = interval - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();

    return fetch(url, {
      ...options,
      headers: { ...defaultHeaders, ...options.headers },
      signal: options.signal || AbortSignal.timeout(8000),
    });
  };
}

module.exports = { createRateLimitedFetch };
