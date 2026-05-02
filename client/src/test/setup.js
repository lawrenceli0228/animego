import '@testing-library/jest-dom'

// Mock localStorage for jsdom environments
const localStorageMock = (() => {
  let store = {}
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = String(value) },
    removeItem: (key) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true, configurable: true })

// IntersectionObserver shim for motion/react's useInView in jsdom. We don't
// emulate visibility — we just satisfy the API contract; tests that care
// about motion behavior should mock useReducedMotion separately.
if (typeof globalThis.IntersectionObserver === 'undefined') {
  class FakeIO {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
  }
  globalThis.IntersectionObserver = /** @type {any} */ (FakeIO)
  if (typeof window !== 'undefined') {
    /** @type {any} */ (window).IntersectionObserver = FakeIO
  }
}
