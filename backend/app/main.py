"""
PNW College Baseball Analytics - FastAPI Application

Main entry point. Run with:
    uvicorn app.main:app --reload --port 8000
"""

import json
import os
from decimal import Decimal
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import JSONResponse


class DecimalEncoder(json.JSONEncoder):
    """JSON encoder that handles Decimal objects from Postgres."""
    def default(self, obj):
        if isinstance(obj, Decimal):
            # Return int if no decimal part, else float
            if obj == int(obj):
                return int(obj)
            return float(obj)
        return super().default(obj)

# Load .env from project root (for SUPABASE_* vars)
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from .api.routes import router
# June 2026 split: feature blocks extracted from routes.py into their own
# routers (same /api/v1 prefix, identical paths — verified by route diff).
from .api.pitch_level import router as pitch_level_router
from .api.grid import router as grid_router
from .api.summer_leaderboards import router as summer_leaderboards_router
from .api.feature_requests import router as feature_requests_router
from .api.recruiting import router as recruiting_router
from .api.team_stats import router as team_stats_router
from .api.all_conference import router as all_conference_router
from .api.coaching_tools import router as coaching_tools_router
from .api.articles import router as articles_router
from .api.email_prefs import router as email_prefs_router
from .api.email_broadcasts import router as email_broadcasts_router
from .api.account import router as account_router
from .api.billing import router as billing_router
from .api.summer import router as summer_router
from .api.player_comps import router as player_comps_router
from .api.admin_tools import router as admin_tools_router
from .api.rapsodo import router as rapsodo_router
from .api.recruiting_boards import router as recruiting_boards_router
from .api.seo import seo_router
from .models.database import init_db, seed_divisions_and_conferences

class DecimalJSONResponse(JSONResponse):
    """JSONResponse that can serialize Decimal objects from Postgres."""
    def render(self, content) -> bytes:
        return json.dumps(content, cls=DecimalEncoder, ensure_ascii=False).encode("utf-8")


app = FastAPI(
    title="PNW College Baseball Analytics",
    description=(
        "Statistics dashboard for college baseball in the Pacific Northwest. "
        "Covers NCAA D1/D2/D3, NAIA, and NWAC programs in WA, OR, ID, and MT. "
        "Includes advanced metrics: FIP, xFIP, SIERA, wOBA, wRC+, and custom college WAR."
    ),
    version="0.1.0",
    default_response_class=DecimalJSONResponse,
)

# CORS - production frontend + local dev server.
# Most production traffic goes same-origin via Vercel's /api/v1/* rewrite,
# so CORS isn't normally exercised in prod. The exception is large file
# uploads: Vercel's free tier caps proxied request bodies at 4.5 MB and
# returns 413, so the editor uploads images directly to api.nwbaseballstats.com,
# which is a cross-origin call that needs explicit CORS allowance here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "https://nwbaseballstats.com",
        "https://www.nwbaseballstats.com",
    ],
    allow_credentials=True,
    # Narrowed from ["*"] — with allow_credentials=True a wildcard surface is
    # broader than the one cross-origin use case (image uploads) needs.
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "X-Requested-With"],
)

app.include_router(router, prefix="/api/v1")
app.include_router(pitch_level_router, prefix="/api/v1")
app.include_router(grid_router, prefix="/api/v1")
app.include_router(summer_leaderboards_router, prefix="/api/v1")
app.include_router(feature_requests_router, prefix="/api/v1")
app.include_router(recruiting_router, prefix="/api/v1")
app.include_router(team_stats_router, prefix="/api/v1")
app.include_router(all_conference_router, prefix="/api/v1")
app.include_router(coaching_tools_router, prefix="/api/v1")
app.include_router(articles_router, prefix="/api/v1")
app.include_router(email_prefs_router, prefix="/api/v1")
app.include_router(email_broadcasts_router, prefix="/api/v1")
app.include_router(account_router, prefix="/api/v1")
app.include_router(billing_router, prefix="/api/v1")
app.include_router(summer_router, prefix="/api/v1")
app.include_router(player_comps_router, prefix="/api/v1")
app.include_router(admin_tools_router, prefix="/api/v1")
app.include_router(rapsodo_router, prefix="/api/v1")
app.include_router(recruiting_boards_router, prefix="/api/v1")
app.include_router(seo_router, prefix="/api/v1")


# ── Edge cache headers ───────────────────────────────────────────
# Vercel's CDN sits in front of the API and respects s-maxage. Setting
# Cache-Control here lets the edge serve repeat requests without ever
# touching the droplet OR Supabase, compounding with the in-memory cache
# applied at the endpoint level via @cached_endpoint.
#
# Each rule maps a URL prefix to (s-maxage, stale-while-revalidate) in
# seconds. First matching rule wins, so order long-prefix-first.
CACHE_CONTROL_RULES = [
    # Live / near-live: short cache, edge can revalidate quickly
    ("/api/v1/games/live",              (60, 30)),
    ("/api/v1/games/ticker",            (60, 30)),
    ("/api/v1/games/by-date",           (300, 120)),
    ("/api/v1/games/recent",            (300, 120)),
    ("/api/v1/games/future",            (300, 120)),
    ("/api/v1/games/win-probabilities", (300, 120)),
    ("/api/v1/games/upset-of-the-day",  (1800, 600)),
    ("/api/v1/games/daily-performers",  (1800, 600)),
    ("/api/v1/games/key-matchup",       (1800, 600)),
    ("/api/v1/games/series-recap",      (1800, 600)),
    ("/api/v1/games/daily-recap",       (1800, 600)),
    # Refreshed once per daily-scrape cycle
    ("/api/v1/stats/last-updated",      (300, 60)),
    ("/api/v1/stat-leaders",            (1800, 600)),
    ("/api/v1/national-rankings",       (1800, 600)),
    ("/api/v1/team-ratings",            (1800, 600)),
    ("/api/v1/leaderboards",            (1800, 600)),
    ("/api/v1/standings",               (900, 300)),
    ("/api/v1/playoff-projections",     (1800, 600)),
    ("/api/v1/nwac-championship-odds",  (1800, 600)),
    ("/api/v1/nwac-mvp-tracker",        (1800, 600)),
    ("/api/v1/portal/nwac-tournament-sheet", (1800, 600)),
    ("/api/v1/records",                 (1800, 600)),
    ("/api/v1/all-conference",          (1800, 600)),
    ("/api/v1/seasons",                 (3600, 600)),
    ("/api/v1/site-stats",              (3600, 600)),
    ("/api/v1/league-environments",     (3600, 600)),
    ("/api/v1/divisions",               (3600, 600)),
    ("/api/v1/conferences",             (3600, 600)),
    ("/api/v1/teams",                   (1800, 600)),  # also covers /teams/{id}/*
    ("/api/v1/comps",                   (1800, 600)),  # player comparison tool
    ("/api/v1/players",                 (1800, 600)),  # also covers /players/{id}/*
    ("/api/v1/park-factors",            (3600, 600)),
]


@app.middleware("http")
async def add_cache_control_headers(request, call_next):
    """Tag cacheable read endpoints with Cache-Control so the Vercel
    edge CDN can serve repeat requests without hitting the droplet."""
    response = await call_next(request)
    # Only cache successful GETs
    if request.method != "GET" or response.status_code != 200:
        return response
    path = request.url.path
    for prefix, (max_age, swr) in CACHE_CONTROL_RULES:
        if path.startswith(prefix):
            response.headers["Cache-Control"] = (
                f"public, s-maxage={max_age}, stale-while-revalidate={swr}"
            )
            break
    return response


@app.on_event("startup")
def startup():
    import logging
    init_db()
    seed_divisions_and_conferences()
    # Surface billing-config drift (a sellable tier missing its Stripe price,
    # or the DB tier constraint rejecting a tier the app can assign) at deploy
    # time rather than at a customer's first purchase.
    try:
        from .api.billing import verify_billing_config
        problems = verify_billing_config()
        blog = logging.getLogger("nwbb.billing")
        if problems:
            for p in problems:
                blog.critical("BILLING CONFIG: %s", p)
        else:
            blog.info("billing config OK")
    except Exception:
        logging.getLogger("nwbb.billing").exception("billing config self-check failed")

    # Warm the player-comparison pools in the background so the first /comps
    # request after a restart isn't a cold ~5s load. Runs off-thread so it never
    # delays the server accepting traffic; failures are logged, not fatal.
    def _warm_player_comps():
        try:
            from .api.player_comps import _load_nw_pool, _load_mlb_pool, SEASON_DEFAULT
            for _side in ("hitter", "pitcher"):
                _load_nw_pool(_side, SEASON_DEFAULT)
                _load_mlb_pool(_side)
            logging.getLogger("nwbb.comps").info("player-comp pools warmed")
        except Exception:
            logging.getLogger("nwbb.comps").exception("player-comp pool warm failed")

    import threading
    threading.Thread(target=_warm_player_comps, daemon=True, name="comp-warm").start()


# ── Serve headshots from a persistent directory (survives deploys) ──
# On the server, headshots live in /opt/headshots/ (outside the git repo).
# Locally, fall back to frontend/public/headshots/.
HEADSHOT_DIR_SERVER = Path("/opt/headshots")
HEADSHOT_DIR_LOCAL = Path(__file__).resolve().parent.parent.parent / "frontend" / "public" / "headshots"
HEADSHOT_DIR = HEADSHOT_DIR_SERVER if HEADSHOT_DIR_SERVER.exists() else HEADSHOT_DIR_LOCAL

if HEADSHOT_DIR.exists():
    app.mount("/headshots", StaticFiles(directory=str(HEADSHOT_DIR)), name="headshots")


# ── Serve React frontend in production ──
# After building the frontend (npm run build), the static files go in frontend/dist.
# In production, FastAPI serves them so everything runs on a single server.
FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

if FRONTEND_DIR.exists():
    # Serve static assets (JS, CSS, images)
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="static-assets")

    # Serve other static files at root (favicon, etc.)
    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        """Serve the React SPA - all non-API routes return index.html."""
        file_path = FRONTEND_DIR / full_path
        # Path-traversal guard: only serve files that resolve INSIDE dist/.
        # Starlette normalizes most ../ shapes already; this makes the
        # containment explicit instead of relying on framework behavior.
        try:
            inside = file_path.resolve().is_relative_to(FRONTEND_DIR.resolve())
        except (OSError, ValueError):
            inside = False
        if inside and file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        # For all other routes (React Router), return index.html
        return FileResponse(FRONTEND_DIR / "index.html")
else:
    @app.get("/")
    def root():
        return {
            "name": "PNW College Baseball Analytics API",
            "version": "0.1.0",
            "docs": "/docs",
        }
