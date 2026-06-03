#!/usr/bin/env python3
"""
Sentry digest — pull every open issue from Sentry's API and print one ranked
summary, so we don't have to forward alerts one at a time.

Auth: reads SENTRY_AUTH_TOKEN from the environment (a token with
"Issues & Events: Read" scope — the same one used for sourcemap uploads works).
The token is NEVER printed. Org + projects are auto-discovered from the token,
so nothing else is required; you can still pin them with SENTRY_ORG /
SENTRY_PROJECT or --org / --project.

Usage:
    SENTRY_AUTH_TOKEN=... python3 scripts/sentry_digest.py
    python3 scripts/sentry_digest.py --days 7 --status unresolved
    python3 scripts/sentry_digest.py --project javascript-react --limit 100
"""
import argparse
import os
import sys
from datetime import datetime

import requests

BASE = "https://sentry.io/api/0"


def auth_headers():
    tok = os.environ.get("SENTRY_AUTH_TOKEN")
    if not tok:
        sys.exit("ERROR: set SENTRY_AUTH_TOKEN (a Sentry token with Issues & Events: Read). "
                 "Not printing it; it's read from the environment only.")
    return {"Authorization": f"Bearer {tok}"}


def get(url, params=None):
    r = requests.get(url, headers=auth_headers(), params=params, timeout=30)
    r.raise_for_status()
    return r


def discover_orgs():
    return [o["slug"] for o in get(f"{BASE}/organizations/").json()]


def discover_projects(org):
    return [p["slug"] for p in get(f"{BASE}/organizations/{org}/projects/").json()]


def issues(org, project, status, days, limit):
    """List issues for org/project, newest-activity / most-frequent first."""
    out, cursor = [], None
    query = f"is:{status}" if status != "all" else ""
    while len(out) < limit:
        params = {"query": query, "statsPeriod": f"{days}d", "sort": "freq", "limit": 100}
        if cursor:
            params["cursor"] = cursor
        r = get(f"{BASE}/projects/{org}/{project}/issues/", params)
        batch = r.json()
        if not batch:
            break
        out.extend(batch)
        link = r.headers.get("Link", "")
        if 'rel="next"; results="true"' in link:
            cursor = link.split('cursor="')[-1].split('"')[0]
        else:
            break
    return out[:limit]


def fmt_when(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).strftime("%b %d %H:%M")
    except Exception:
        return s or "?"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--org", default=os.environ.get("SENTRY_ORG"))
    ap.add_argument("--project", default=os.environ.get("SENTRY_PROJECT"))
    ap.add_argument("--status", default="unresolved", choices=["unresolved", "resolved", "ignored", "all"])
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--limit", type=int, default=100)
    args = ap.parse_args()

    orgs = [args.org] if args.org else discover_orgs()
    if not orgs:
        sys.exit("No organizations visible to this token.")

    grand_events = grand_issues = 0
    for org in orgs:
        projects = [args.project] if args.project else discover_projects(org)
        for project in projects:
            try:
                rows = issues(org, project, args.status, args.days, args.limit)
            except requests.HTTPError as e:
                print(f"[{org}/{project}] skipped ({e})")
                continue
            if not rows:
                continue
            total_events = sum(int(i.get("count") or 0) for i in rows)
            print("\n" + "=" * 78)
            print(f"  {org} / {project}  —  {len(rows)} {args.status} issues, "
                  f"{total_events:,} events in last {args.days}d  (top by frequency)")
            print("=" * 78)
            for n, i in enumerate(rows, 1):
                title = (i.get("title") or "").strip().replace("\n", " ")[:74]
                culprit = (i.get("culprit") or i.get("metadata", {}).get("filename") or "").strip()[:70]
                cnt = int(i.get("count") or 0)
                users = i.get("userCount") or 0
                lvl = i.get("level") or ""
                last = fmt_when(i.get("lastSeen"))
                print(f"\n{n:>3}. [{cnt:>5} ev · {users:>3} users · {lvl}]  {title}")
                if culprit:
                    print(f"     {culprit}")
                print(f"     last seen {last}   {i.get('permalink','')}")
            grand_events += total_events
            grand_issues += len(rows)

    print("\n" + "-" * 78)
    print(f"TOTAL: {grand_issues} open issues, {grand_events:,} events across all projects "
          f"(last {args.days} days).")


if __name__ == "__main__":
    main()
