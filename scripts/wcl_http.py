"""Shared HTTP resilience for the WCL scrapers.

The WCL scrapers fetch wclstats.com directly with a plain requests.Session,
so a single transient blip (connection reset, read timeout, a 502/503 from
the host) used to fail the whole GitHub Actions run and email Nate. This
mounts a urllib3 Retry adapter on a session so every `session.get(...)`
automatically retries with exponential backoff on connection errors,
timeouts, and 5xx/429 responses — no call-site changes needed.

Usage:
    from wcl_http import mount_retries
    s = requests.Session()
    s.headers.update({...})
    mount_retries(s)
"""
from requests.adapters import HTTPAdapter

try:
    # urllib3 ships with requests; Retry lives here.
    from urllib3.util.retry import Retry
except ImportError:  # pragma: no cover - very old urllib3
    from requests.packages.urllib3.util.retry import Retry


def mount_retries(session, total=4, backoff_factor=1.5):
    """Mount a retrying HTTPAdapter on `session` for http:// and https://.

    total=4 + backoff_factor=1.5 → waits ~0s, 1.5s, 3s, 6s, 12s between the
    5 attempts, so a brief host hiccup self-heals instead of failing the run.
    Retries connection errors, read timeouts, and 429/5xx status codes.
    """
    retry = Retry(
        total=total,
        connect=total,
        read=total,
        status=total,
        backoff_factor=backoff_factor,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(["GET", "HEAD"]),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session
