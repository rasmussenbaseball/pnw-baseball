"""Process-local TTL cache for FastAPI read endpoints.

The nwbb service runs as a single uvicorn worker (per the systemd unit),
so a plain in-memory dict here covers every request. If we ever scale to
multiple workers, swap the storage for Redis behind the same decorator
interface — the public API of `cached_endpoint` doesn't change.

Why this exists: Supabase egress is metered on the free tier (5 GB / mo).
Every uncached request to a read-heavy endpoint fires SQL queries from
the droplet to Supabase and the results count against the egress budget.
Caching a result for 5-30 minutes drops Supabase queries from O(requests)
to O(time / ttl), which on this site is a 1-2 orders of magnitude
reduction once traffic hits the homepage and leaderboard endpoints.
"""

import time
from functools import wraps
from typing import Callable


def cached_endpoint(ttl_seconds: int, max_entries: int = 1024):
    """Cache a FastAPI endpoint's return value by its argument tuple.

    Usage:
        @router.get("/site-stats")
        @cached_endpoint(ttl_seconds=3600)
        def site_stats():
            ...

    The decorator preserves the wrapped function's signature via
    `functools.wraps`, so FastAPI's dependency injection and query-param
    parsing keep working — FastAPI introspects the underlying function.

    Cache key is `(args, sorted(kwargs.items()))`. All FastAPI-passed
    args (path params, query params, dependencies) are hashable, so no
    extra work needed at call sites.

    When the cache grows past `max_entries`, the soonest-to-expire 25%
    of entries are evicted. Simple, no LRU bookkeeping needed.
    """
    def decorator(fn: Callable):
        store: dict = {}

        @wraps(fn)
        def wrapper(*args, **kwargs):
            key = (args, tuple(sorted(kwargs.items())))
            now = time.time()
            hit = store.get(key)
            if hit is not None and hit[1] > now:
                return hit[0]
            value = fn(*args, **kwargs)
            store[key] = (value, now + ttl_seconds)
            if len(store) > max_entries:
                # Bounded eviction: drop the entries that will expire soonest.
                cutoff_n = max_entries // 4
                victims = sorted(store.keys(), key=lambda k: store[k][1])[:cutoff_n]
                for k in victims:
                    store.pop(k, None)
            return value

        # Expose internals for tests / manual flush
        wrapper._cache_store = store
        wrapper._ttl_seconds = ttl_seconds
        wrapper._cache_clear = store.clear
        return wrapper

    return decorator
