// Tiny pub/sub that tracks how many API requests are in flight across
// the whole app. useApi.js bumps the counter when a fetch starts and
// decrements it when the fetch finishes (success or error). A single
// global loading indicator (GlobalRouteLoader) subscribes here and
// renders a spinner badge whenever the count stays above zero past a
// short delay, so users get visible feedback that their navigation /
// filter change registered even when the underlying endpoint is slow.

let count = 0
const subscribers = new Set()

function notify() {
  for (const fn of subscribers) {
    try { fn(count) } catch { /* swallow — one bad sub shouldn't kill others */ }
  }
}

export function bumpPending() {
  count += 1
  notify()
}

export function decrementPending() {
  count = Math.max(0, count - 1)
  notify()
}

export function getPending() {
  return count
}

/**
 * Subscribe to pending-request count changes. The subscriber is called
 * immediately with the current count, then on every subsequent change.
 * Returns an unsubscribe function for cleanup in useEffect.
 */
export function subscribeToPending(fn) {
  subscribers.add(fn)
  try { fn(count) } catch { /* ignore */ }
  return () => subscribers.delete(fn)
}
