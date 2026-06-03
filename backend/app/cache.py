"""Process-local TTL cache for FastAPI read endpoints.

Caching drops Supabase queries from O(requests) to O(time / ttl), which on a
read-heavy site is a 1-2 order of magnitude reduction once traffic hits the
homepage / leaderboard / player endpoints.

Single-flight (stampede protection)
-----------------------------------
A plain TTL cache has a fatal failure mode under load: when an entry is cold or
expires, EVERY concurrent request for that key recomputes it at once. For an
expensive query (a full game_events aggregation, site-stats, standings) that
turns one 2s query into N identical 30-60s queries all fighting for the
database's CPU — none finish, and the DB falls over. This is exactly what
happened during a traffic spike (17 active queries, several duplicates of the
same aggregation, all crawling).

So each cache key now has its own lock and behaves like a single-flight:
  • Fresh hit  → return cached value immediately (no lock).
  • Expired but present → ONE caller refreshes; everyone else gets the slightly
    stale value instantly (stale-while-revalidate — safe for read-only stats).
  • Cold (never computed) → ONE caller computes while the rest wait on the lock,
    then reuse the freshly-computed value. The DB sees ONE query, not N.

The store is process-local. With multiple uvicorn workers each worker keeps its
own copy, so a key is computed at most once-per-worker rather than once total —
still a massive reduction vs. the per-request stampede. Swap the store for Redis
behind this same interface if a single shared cache across workers is needed.
"""

import time
import threading
from functools import wraps
from typing import Callable


def cached_endpoint(ttl_seconds: int, max_entries: int = 1024):
    """Cache a FastAPI endpoint's return value by its argument tuple, with
    single-flight stampede protection.

    Cache key is `(args, sorted(kwargs.items()))`. All FastAPI-passed args
    (path params, query params, dependencies) are hashable, so no extra work is
    needed at call sites. `functools.wraps` preserves the signature so FastAPI's
    dependency injection and query-param parsing keep working.
    """
    def decorator(fn: Callable):
        store: dict = {}            # key -> (value, expires_at)
        key_locks: dict = {}        # key -> threading.Lock (one in-flight compute per key)
        locks_guard = threading.Lock()

        def _key_lock(key):
            lock = key_locks.get(key)
            if lock is None:
                with locks_guard:
                    lock = key_locks.get(key)
                    if lock is None:
                        lock = threading.Lock()
                        key_locks[key] = lock
            return lock

        @wraps(fn)
        def wrapper(*args, **kwargs):
            key = (args, tuple(sorted(kwargs.items())))
            now = time.time()
            hit = store.get(key)
            if hit is not None and hit[1] > now:
                return hit[0]                       # fresh — fast path, no lock

            lock = _key_lock(key)

            if hit is not None:
                # Expired but present: don't block. If another thread is already
                # refreshing this key, serve the stale value rather than pile on.
                if not lock.acquire(blocking=False):
                    return hit[0]
            else:
                # Cold key: wait for the single in-flight computation to finish,
                # then reuse its result instead of launching a duplicate query.
                lock.acquire()

            try:
                # Re-check under the lock — another thread may have just computed
                # or refreshed this key while we were waiting for the lock.
                hit2 = store.get(key)
                now = time.time()
                if hit2 is not None and hit2[1] > now:
                    return hit2[0]

                value = fn(*args, **kwargs)
                store[key] = (value, now + ttl_seconds)

                if len(store) > max_entries:
                    # Bounded, best-effort eviction: drop the soonest-to-expire
                    # 25%. Guarded against concurrent mutation (other keys insert
                    # under their own locks) — skip this round if it races.
                    cutoff_n = max_entries // 4
                    try:
                        victims = sorted(list(store.items()), key=lambda kv: kv[1][1])[:cutoff_n]
                        for k, _ in victims:
                            store.pop(k, None)
                            key_locks.pop(k, None)
                    except RuntimeError:
                        pass
                return value
            finally:
                lock.release()

        # Expose internals for tests / manual flush (unchanged public API).
        wrapper._cache_store = store
        wrapper._ttl_seconds = ttl_seconds
        wrapper._cache_clear = store.clear
        return wrapper

    return decorator
