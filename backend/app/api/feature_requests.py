"""
Feature request submission + admin list.

Extracted from routes.py (June 2026 split). Shared helpers that still
live in routes.py are imported as `from .routes import ...` — routes.py
never imports this module, so there is no circular import.
"""

import json
import math
import os
import re
import threading
from bisect import bisect_left, bisect_right
from datetime import datetime, date, timedelta

from fastapi import APIRouter, Depends, Query, HTTPException, Body
from fastapi.responses import JSONResponse, FileResponse
from psycopg2.extras import Json
from typing import Optional
from ..models.database import get_connection
from ..cache import cached_endpoint
from ..config import CURRENT_SEASON
from .auth import require_admin, require_tier
from .leverage import compute_li
from .lineup_helper import (
    compute_team_lineup_helper,
    compute_manual_lineup,
    compute_build_lineup,
)
from .team_scouting import compute_team_scouting

# Phase E: batted-ball + spray classifier (lives in scripts/ but is
# pure Python — import via path manipulation so the API can use it.)
import sys as _sys
import pathlib as _pathlib
_sys.path.insert(
    0,
    str(_pathlib.Path(__file__).resolve().parents[3] / "scripts"),
)
try:
    from classify_batted_ball import spray_for as _spray_for  # noqa: E402
except ImportError:
    _spray_for = lambda zone, bats: None  # noqa: E731
from ..stats.advanced import (
    BattingLine, PitchingLine,
    compute_batting_advanced, compute_pitching_advanced, compute_college_war,
    normalize_position, DEFAULT_WEIGHTS,
    POSITION_ADJUSTMENTS_FULL,
    compute_fip_constant, innings_to_outs,
)
from ..stats.tiebreakers import apply_head_to_head
from ..stats.projections import (
    load_future_schedules,
    project_remaining_games,
    run_monte_carlo,
    build_projected_standings,
    determine_playoff_fields,
    elo_win_prob,
    simulate_nwac_championship_odds,
    resolve_known_nwac_results,
    pct_to_american,
    NWAC_2026_CHAMP_SEEDS,
    NWAC_2026_CHAMP_HOST_ID,
    PLAYOFF_FORMATS,
    CONFERENCE_TO_FORMAT,
)

router = APIRouter()

# FEATURE REQUESTS
# ════════════════════════════════════════════════════════════════

def _send_feature_request_email(req_id, email, category, message):
    """Notify info@nwbaseballstats.com of a new feature request / bug
    report / feedback via Resend. Sets Reply-To to the submitter so
    hitting Reply in Gmail emails the user directly. Fails silently
    (caller runs this in a background thread)."""
    # Inline import keeps the routes module light at startup — the
    # service is only loaded when a feedback form is actually submitted.
    try:
        from ..services.email_sender import send_notification
    except Exception:
        return

    cat_display = (category or "feedback").replace("_", " ").title()
    from_label = email or "Anonymous"

    # Subject: short enough to read in the Gmail list view.
    snippet = message[:60].strip()
    if len(message) > 60:
        snippet += "…"
    subject = f"[NWBB] {cat_display} #{req_id}: {snippet}"

    # Plain-text fallback (everything important; clients without HTML
    # support still get a fully readable email).
    body_text = (
        f"New {cat_display} submitted on NW Baseball Stats\n"
        f"{'=' * 50}\n\n"
        f"From: {from_label}\n"
        f"Category: {cat_display}\n"
        f"Request ID: #{req_id}\n\n"
        f"Message:\n{message}\n\n"
        f"{'=' * 50}\n"
        f"Reply to this email to respond directly to the user.\n"
    )

    # Tiny HTML version. Inline styles so Gmail renders consistently;
    # no external CSS / images so it loads instantly.
    def _esc(s):
        return (str(s or "")
                .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    body_html = f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="background:#fff;border-radius:12px;max-width:560px;width:100%;">
        <tr><td style="padding:20px 24px;border-bottom:1px solid #e5e7eb;">
          <div style="font-size:11px;font-weight:800;letter-spacing:0.1em;color:#0f766e;text-transform:uppercase;">NW Baseball Stats</div>
          <div style="font-size:13px;color:#6b7280;margin-top:2px;">New {_esc(cat_display)} from the website</div>
        </td></tr>
        <tr><td style="padding:18px 24px;font-size:14px;color:#1f2937;">
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13px;">
            <tr><td style="padding:3px 0;color:#6b7280;width:90px;">From</td>
                <td style="padding:3px 0;font-weight:600;color:#111;">{_esc(from_label)}</td></tr>
            <tr><td style="padding:3px 0;color:#6b7280;">Category</td>
                <td style="padding:3px 0;font-weight:600;color:#111;">{_esc(cat_display)}</td></tr>
            <tr><td style="padding:3px 0;color:#6b7280;">Request ID</td>
                <td style="padding:3px 0;font-weight:600;color:#111;">#{_esc(req_id)}</td></tr>
          </table>
          <div style="margin-top:14px;padding:14px 16px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;white-space:pre-wrap;line-height:1.55;">{_esc(message)}</div>
        </td></tr>
        <tr><td style="padding:14px 24px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
          Reply to this email to respond directly to the user.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""

    send_notification(
        to_email="info@nwbaseballstats.com",
        subject=subject,
        body_text=body_text,
        body_html=body_html,
        # Reply-To is the submitter's email if they were logged in.
        # If anonymous, omit so Reply goes back to info@ (where the
        # admin can then craft a real outbound reply if they want).
        reply_to=email or None,
    )


@router.post("/feature-requests")
def submit_feature_request(data: dict = Body(...)):
    """Submit a feature request or feedback."""
    message = (data.get("message") or "").strip()
    email = (data.get("email") or "").strip()
    category = (data.get("category") or "feature").strip()

    if not message:
        raise HTTPException(status_code=400, detail="Message is required")
    if len(message) > 2000:
        raise HTTPException(status_code=400, detail="Message too long (max 2000 chars)")

    with get_connection() as conn:
        cur = conn.cursor()
        # Create table if it doesn't exist
        cur.execute("""
            CREATE TABLE IF NOT EXISTS feature_requests (
                id SERIAL PRIMARY KEY,
                email TEXT,
                category TEXT DEFAULT 'feature',
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cur.execute(
            """INSERT INTO feature_requests (email, category, message)
               VALUES (%s, %s, %s) RETURNING id""",
            (email or None, category, message),
        )
        req_id = list(cur.fetchone().values())[0]

    # Send notification email in background thread so it doesn't block the response
    threading.Thread(
        target=_send_feature_request_email,
        args=(req_id, email, category, message),
        daemon=True,
    ).start()

    return {"id": req_id, "status": "received"}


@router.get("/feature-requests")
def list_feature_requests(_admin: str = Depends(require_admin)):
    """List all feature requests (admin only — rows include submitter emails)."""
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT id, email, category, message, created_at
            FROM feature_requests
            ORDER BY created_at DESC
            LIMIT 100
        """)
        return [dict(r) for r in cur.fetchall()]


