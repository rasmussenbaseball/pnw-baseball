"""One door to ScraperAPI for every scraper.

Why this exists (2026-11-22): the account is on a 1,000-credit monthly plan
and it ran dry four days into the November cycle. The weekly recruit scrape
alone drained it, paying for pages that load fine without a proxy, escalating
to 10-credit premium requests on pages that simply 404, and retrying a tier
the plan refuses. Every scraper had its own copy of that escalation loop.

What every caller now gets:
  * Free direct fetch first. Hosts that block us (NWAC from the server,
    wclstats from datacenters) are remembered for the rest of the run after
    one quick failed attempt, so only blocked hosts ever cost credits.
  * Cheapest tier first: standard (1 credit), one retry, then premium
    (10 credits). Ultra premium is gone; this plan answers it with a 403.
  * A missing page (404) stops immediately. A proxy cannot make a page exist.
  * A credit floor. Before every paid request the client checks the account
    meter (cached, with local spend subtracted); below SCRAPERAPI_RESERVE it
    stops paying for the rest of the run instead of hammering 403s.
  * A per-run ledger line: requests by tier and credits used, appended to
    /var/log/nwbb-scraperapi.log on the server (stdout on GitHub Actions), so
    "what used my credits?" has an answer next time.

Usage:
    from scraperapi_client import get, get_response, status_line
    html = get(url, min_size=5000, label="NWAC box 20260412_abcd")
"""
from __future__ import annotations

import atexit
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests

log = logging.getLogger("scraperapi")

API_BASE = "https://api.scraperapi.com"
ACCOUNT_URL = "https://api.scraperapi.com/account"
TIER_PARAMS = {"standard": {}, "premium": {"premium": "true"}}
TIER_COST = {"standard": 1, "premium": 10}
RESERVE = int(os.environ.get("SCRAPERAPI_RESERVE", "25"))
# Optional cap on credits one run may spend (set per workflow / cron line).
RUN_BUDGET = int(os.environ.get("SCRAPERAPI_RUN_BUDGET", "0") or 0)
ACCOUNT_TTL_S = 60
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
_REPO_ROOT = Path(__file__).resolve().parent.parent

_state = {
    "key": None, "acct": None, "acct_at": 0.0, "spent_since_check": 0,
    "start_count": None, "exhausted": False, "exhausted_logged": False,
    "paid": {"standard": 0, "premium": 0}, "not_found": 0,
    "direct_ok": 0, "blocked_hosts": set(),
}


def api_key() -> str:
    """SCRAPER_API_KEY from the environment, else the repo .env file."""
    if _state["key"] is not None:
        return _state["key"]
    key = os.environ.get("SCRAPER_API_KEY", "").strip()
    if not key:
        env = _REPO_ROOT / ".env"
        if env.exists():
            for line in env.read_text().splitlines():
                if line.strip().startswith("SCRAPER_API_KEY="):
                    key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    _state["key"] = key
    return key


def account(force: bool = False):
    """The ScraperAPI account meter (free to call), cached for a minute."""
    key = api_key()
    if not key:
        return None
    now = time.time()
    if not force and _state["acct"] is not None and now - _state["acct_at"] < ACCOUNT_TTL_S:
        return _state["acct"]
    try:
        r = requests.get(ACCOUNT_URL, params={"api_key": key}, timeout=20)
        if r.status_code == 200:
            _state["acct"], _state["acct_at"], _state["spent_since_check"] = r.json(), now, 0
            if _state["start_count"] is None:
                _state["start_count"] = _state["acct"].get("requestCount")
    except Exception as e:  # noqa: BLE001 - the meter is advisory
        log.warning("ScraperAPI account check failed: %s", e)
    return _state["acct"]


def credits_left():
    """Best estimate of credits left this cycle, or None if the meter is unreachable."""
    a = account()
    if not a:
        return None
    left = a.get("creditsLeft")
    if left is None:
        left = max(0, int(a.get("requestLimit") or 0) - int(a.get("requestCount") or 0))
    return int(left) - _state["spent_since_check"]


def status_line() -> str:
    a = account(force=True)
    if not a:
        return "ScraperAPI: no key or meter unreachable"
    nxt = (a.get("nextBillingDate") or "")[:10]
    return (f"ScraperAPI: {credits_left()} credits left of {a.get('requestLimit')} "
            f"this cycle (used {a.get('requestCount')}, resets {nxt})")


def _mark_exhausted(why: str):
    _state["exhausted"] = True
    if not _state["exhausted_logged"]:
        log.error("ScraperAPI paused for the rest of this run: %s. Pages behind a "
                  "blocking host will be skipped until credits reset.", why)
        _state["exhausted_logged"] = True


def _run_spent() -> int:
    return sum(TIER_COST[t] * n for t, n in _state["paid"].items())


def _can_spend(cost: int) -> bool:
    if _state["exhausted"]:
        return False
    # Hard off switch: SCRAPERAPI_DISABLED=1 means this run never pays for a
    # proxy (direct fetches still work). Used on the recruit cron.
    if os.environ.get("SCRAPERAPI_DISABLED", "").strip() in ("1", "true", "yes"):
        _mark_exhausted("SCRAPERAPI_DISABLED is set for this run")
        return False
    if RUN_BUDGET and _run_spent() + cost > RUN_BUDGET:
        _mark_exhausted(f"this run's budget of {RUN_BUDGET} credits is spent")
        return False
    left = credits_left()
    if left is None:
        return True  # meter unreachable: don't block a run on an advisory check
    if left - cost < RESERVE:
        _mark_exhausted(f"{left} credits left, reserve is {RESERVE}")
        return False
    return True


def _blocked(status, text, min_size, must_contain, reject_captcha) -> bool:
    if status != 200 or text is None or len(text) < min_size:
        return True
    if must_contain and must_contain not in text:
        return True
    if reject_captcha and "captcha" in text.lower():
        return True
    return False


def get_response(url, *, min_size=3000, must_contain=None, label=None, direct=True,
                 tiers=("standard", "premium"), standard_attempts=2, timeout=90,
                 session=None, headers=None, reject_captcha=True):
    """Fetch url the cheapest way that works. Returns a requests.Response whose
    body passed the checks, or None (missing page, blocked everywhere, or the
    credit floor reached). Never raises for a blocked or missing page."""
    label = label or url
    http = session or requests
    host = urlparse(url).netloc.lower()

    # 1) free direct fetch, unless this host already blocked us this run
    if direct and host not in _state["blocked_hosts"]:
        try:
            h = {"User-Agent": UA}
            h.update(headers or {})
            r = http.get(url, headers=h, timeout=min(timeout, 30))
            if r.status_code == 404:
                _state["not_found"] += 1
                log.info("%s: 404 (page does not exist), not retrying through a proxy", label)
                return None
            if not _blocked(r.status_code, r.text, min_size, must_contain, reject_captcha):
                _state["direct_ok"] += 1
                return r
            log.info("%s: direct fetch blocked (status=%s, %sB); using ScraperAPI for %s this run",
                     label, r.status_code, len(r.content), host)
        except Exception as e:  # noqa: BLE001
            log.info("%s: direct fetch failed (%s); using ScraperAPI for %s this run", label, e, host)
        _state["blocked_hosts"].add(host)

    key = api_key()
    if not key:
        log.warning("%s: blocked direct and no SCRAPER_API_KEY set", label)
        return None

    # 2) paid tiers, cheapest first
    plan = []
    for t in tiers:
        plan.extend([t] * (standard_attempts if t == "standard" else 1))
    for tier in plan:
        cost = TIER_COST[tier]
        if not _can_spend(cost):
            return None
        params = {"api_key": key, "url": url, **TIER_PARAMS[tier]}
        try:
            r = http.get(API_BASE, params=params, timeout=max(timeout, 60))
        except Exception as e:  # noqa: BLE001 - transport error, not charged
            log.warning("%s: ScraperAPI %s transport error: %s", label, tier, e)
            time.sleep(2)
            continue
        if r.status_code in (200, 404):
            # ScraperAPI bills 200 and 404 responses
            _state["paid"][tier] += 1
            _state["spent_since_check"] += cost
        if r.status_code == 404:
            _state["not_found"] += 1
            log.info("%s: 404 via %s proxy (page does not exist), stopping", label, tier)
            return None
        if r.status_code == 403:
            body = (r.text or "").lower()
            if "credit" in body or "exhaust" in body or "limit" in body:
                _mark_exhausted("ScraperAPI says the monthly credits are used up")
            else:
                log.warning("%s: ScraperAPI refused the %s tier (403); stopping", label, tier)
            return None
        if not _blocked(r.status_code, r.text, min_size, must_contain, reject_captcha):
            log.info("%s: got %s bytes via %s proxy", label, f"{len(r.content):,}", tier)
            return r
        log.warning("%s: blocked via %s proxy (status=%s, %sB)", label, tier, r.status_code, len(r.content))
        time.sleep(2)
    log.warning("%s: every tier blocked", label)
    return None


def get(url, **kw):
    """Text-returning wrapper around get_response(); None when unavailable."""
    r = get_response(url, **kw)
    return r.text if r is not None else None


def is_exhausted() -> bool:
    return _state["exhausted"]


def _ledger():
    paid = _state["paid"]
    if not (paid["standard"] or paid["premium"] or _state["exhausted"]):
        return
    a = account(force=True)
    used = None
    if a and _state["start_count"] is not None:
        used = int(a.get("requestCount") or 0) - int(_state["start_count"])
    script = Path(sys.argv[0]).name if sys.argv and sys.argv[0] else "python"
    line = (f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {script} "
            f"standard={paid['standard']} premium={paid['premium']} not_found={_state['not_found']} "
            f"direct_ok={_state['direct_ok']} credits_used={used if used is not None else '?'} "
            f"left={(a or {}).get('creditsLeft', '?')} exhausted={_state['exhausted']} "
            f"blocked_hosts={','.join(sorted(_state['blocked_hosts'])) or '-'}")
    print(f"[scraperapi] {line}", flush=True)
    if os.environ.get("GITHUB_ACTIONS"):
        return
    for path in (os.environ.get("SCRAPERAPI_LEDGER"), "/var/log/nwbb-scraperapi.log",
                 str(_REPO_ROOT / "logs" / "scraperapi_usage.log")):
        if not path:
            continue
        try:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a") as f:
                f.write(line + "\n")
            return
        except OSError:
            continue


atexit.register(_ledger)
