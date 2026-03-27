"""
PNW College Baseball Analytics — FastAPI Application

Main entry point. Run with:
    uvicorn app.main:app --reload --port 8000
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI

# Load .env from project root (for SUPABASE_* vars)
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from .api.routes import router
from .models.database import init_db, seed_divisions_and_conferences

app = FastAPI(
    title="PNW College Baseball Analytics",
    description=(
        "Statistics dashboard for college baseball in the Pacific Northwest. "
        "Covers NCAA D1/D2/D3, NAIA, and NWAC programs in WA, OR, ID, and MT. "
        "Includes advanced metrics: FIP, xFIP, SIERA, wOBA, wRC+, and custom college WAR."
    ),
    version="0.1.0",
)

# CORS — allow React dev server (local development)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api/v1")


@app.on_event("startup")
def startup():
    init_db()
    seed_divisions_and_conferences()


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
        """Serve the React SPA — all non-API routes return index.html."""
        file_path = FRONTEND_DIR / full_path
        if file_path.exists() and file_path.is_file():
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
