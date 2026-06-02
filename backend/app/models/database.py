"""
Database connection for PNW College Baseball Analytics.

Connects to Supabase Postgres (transaction pooler, port 6543). Uses the
DATABASE_URL environment variable.

Connection pooling
-------------------
Previously this opened a brand-new psycopg2 connection (full TCP + TLS +
pgBouncer auth handshake to us-west-2) on EVERY query — for a server sitting in
SFO that is a flat ~80-120ms tax on every request, and it showed up as ~280k
`pgbouncer.get_auth` calls in pg_stat_statements (pure connection churn).

We now keep a small client-side pool of warm connections and reuse them. To stay
robust against the transaction pooler silently dropping idle connections, each
checkout is validated with a cheap `SELECT 1` (test-on-borrow) — one ~30ms
round-trip instead of a ~4-round-trip reconnect, and dead connections are
transparently replaced. If the pool is ever exhausted under a burst, we fall back
to a one-off direct connection rather than erroring.

Kill switch: set DB_POOL_MAX=0 in the environment to disable pooling entirely and
revert to the old per-request-connection behavior (no redeploy/code change
needed — just restart). The public interface (`with get_connection() as conn:`,
RealDictCursor rows) is unchanged.
"""

import atexit
import os
import threading
from contextlib import contextmanager

import psycopg2
import psycopg2.extras
import psycopg2.pool


DATABASE_URL = os.environ.get("DATABASE_URL")

if not DATABASE_URL:
    # Load from .env file if not set as an environment variable
    from dotenv import load_dotenv
    from pathlib import Path
    load_dotenv(Path(__file__).resolve().parent.parent.parent.parent / ".env")
    DATABASE_URL = os.environ.get("DATABASE_URL")


def _build_dsn(url):
    """Append sslmode + TCP keepalives if absent. Keepalives make Supabase /
    pgBouncer far less likely to drop our pooled connections out from under us."""
    if not url:
        return url
    extras = []
    if "sslmode" not in url:
        extras.append("sslmode=require")
    if "keepalives" not in url:
        extras += ["keepalives=1", "keepalives_idle=30", "keepalives_interval=10", "keepalives_count=5"]
    if not extras:
        return url
    sep = "&" if "?" in url else "?"
    return url + sep + "&".join(extras)


_DSN = _build_dsn(DATABASE_URL)

# Pool size. Default 8 warm connections (well under the 60-connection pooler
# limit, with headroom for scrapers/crons that share the same pooler). 0 = off.
try:
    _POOL_MAX = int(os.environ.get("DB_POOL_MAX", "8"))
except ValueError:
    _POOL_MAX = 8

_pool = None
_pool_lock = threading.Lock()


def _new_conn():
    return psycopg2.connect(_DSN, cursor_factory=psycopg2.extras.RealDictCursor)


def _get_pool():
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = psycopg2.pool.ThreadedConnectionPool(
                    1, _POOL_MAX, dsn=_DSN,
                    cursor_factory=psycopg2.extras.RealDictCursor,
                )
    return _pool


def _alive(conn):
    """Cheap test-on-borrow. Returns True if the connection answers a SELECT 1."""
    if conn.closed:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        conn.rollback()  # leave the connection in a clean, idle state
        return True
    except Exception:
        return False


@contextmanager
def get_connection():
    """Context manager yielding a psycopg2 connection with RealDictCursor.

    Commits on clean exit, rolls back on exception. With pooling enabled the
    connection is borrowed (validated) and returned to the pool; broken
    connections are discarded so they never poison a later request.
    """
    # Pooling disabled (kill switch) → original per-request behavior.
    if _POOL_MAX <= 0:
        conn = _new_conn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
        return

    pool = _get_pool()
    conn = None
    from_pool = True
    ok = False
    try:
        try:
            conn = pool.getconn()
        except psycopg2.pool.PoolError:
            # Burst exceeded the pool — overflow to a one-off direct connection.
            conn, from_pool = _new_conn(), False

        # Replace a dead/dropped connection (test-on-borrow).
        if from_pool and not _alive(conn):
            try:
                pool.putconn(conn, close=True)
            except Exception:
                pass
            conn, from_pool = _new_conn(), False

        yield conn
        conn.commit()
        ok = True
    except Exception:
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
        raise
    finally:
        if conn is not None:
            if from_pool:
                # Discard any connection that errored this turn so it can't
                # return to the pool in a bad state.
                try:
                    pool.putconn(conn, close=(not ok or conn.closed))
                except Exception:
                    try:
                        conn.close()
                    except Exception:
                        pass
            else:
                try:
                    conn.close()
                except Exception:
                    pass


@atexit.register
def _close_pool():
    global _pool
    if _pool is not None:
        try:
            _pool.closeall()
        except Exception:
            pass
        _pool = None


def init_db():
    """No-op for Postgres - tables are created via migration script."""
    print(f"Database: using Supabase Postgres (pool max={_POOL_MAX or 'off'})")


def seed_divisions_and_conferences():
    """No-op for Postgres - data is already migrated."""
    pass
