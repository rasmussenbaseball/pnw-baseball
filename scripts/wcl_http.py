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
import logging
import os
import time

from requests.adapters import HTTPAdapter

try:
    # urllib3 ships with requests; Retry lives here.
    from urllib3.util.retry import Retry
except ImportError:  # pragma: no cover - very old urllib3
    from requests.packages.urllib3.util.retry import Retry


_log = logging.getLogger("wcl_http")

SCRAPER_API_BASE = "https://api.scraperapi.com"


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


def fetch(session, url, timeout=45, min_bytes=5000, must_contain=None, **kwargs):
    """GET a wclstats.com URL, returning a requests.Response.

    wclstats.com's edge (Presto / its CDN) returns HTTP 405 "Not Allowed" to
    datacenter IPs — both the GitHub Actions runners and the DigitalOcean
    server are blocked, which is why the daily WCL cron silently failed at its
    very first step. The fix mirrors the NWAC scrapers: when SCRAPER_API_KEY is
    set we proxy through ScraperAPI's residential pool (escalating proxy tiers
    if a request comes back blocked, short, or missing the expected content);
    when it isn't set we fetch directly, which still works from a residential
    IP (a dev's Mac) for local runs and dry-runs.

    ScraperAPI's cheaper proxy tiers intermittently return a small shell /
    challenge page with a 200 status — bigger than a bare error body but with
    none of the real content. A pure byte threshold isn't enough to catch that
    (it once let a contentless page through and the schedule parsed 0 games),
    so `min_bytes` defaults to 5 KB (a real wclstats page is far larger) and
    callers that know a sentinel substring of the real page (e.g. the schedule's
    "event-row" cards) can pass `must_contain` to force escalation until the
    actual content arrives.

    The returned object is a normal requests.Response, so existing call sites
    keep working unchanged (.text / .content / .status_code /
    .raise_for_status()).
    """
    import scraperapi_client as _sapi
    r = _sapi.get_response(url, min_size=min_bytes, must_contain=must_contain,
                           timeout=timeout, session=session, reject_captcha=False,
                           headers=kwargs.get("headers"))
    if r is not None:
        return r
    # Blocked everywhere, missing, or the credit floor was reached: hand back a
    # direct Response so the caller's raise_for_status()/length checks fail
    # loudly as before (never None).
    return session.get(url, timeout=timeout, **kwargs)
