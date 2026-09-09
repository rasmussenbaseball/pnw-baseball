"""Blast Lab — coach-portal workspace for Blast Motion swing-sensor exports.

Blast's team dashboard exports two per-player aggregate CSVs: an AVERAGE
performance file and a PEAK (95th percentile) file, both with the same
columns (bat speed, hand speed, rotational acceleration, power, on-plane
efficiency, attack/vertical bat angle, time to contact, commit time, and
the connection angles). Coaches upload both; the board merges them per
hitter and per testing date so avg-vs-peak gaps and trends read cleanly.

Owner-scoped exactly like the TrackMan suite (same gate + staff workspace
resolution). Re-uploads upsert on (owner, player, kind, session_date).
"""
import csv
import io
from datetime import date

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi import Query
from psycopg2.extras import execute_values

from ..models.database import get_connection
from .trackman_suite import _gate, _write_gate

router = APIRouter()

# CSV header -> column. OPE arrives as a 0-1 fraction; stored as a percent.
_METRICS = [
    ("Bat Speed (MPH)", "bat_speed"),
    ("Peak Hand Speed (MPH)", "hand_speed"),
    ("Rotational Acceleration (G's)", "rot_accel"),
    ("Power (kW)", "power_kw"),
    ("On Plane Efficiency (%)", "ope"),
    ("Attack Angle (°'s)", "attack_angle"),
    ("Vert. Bat Angle (°'s)", "vert_bat_angle"),
    ("Time to Contact (s)", "ttc"),
    ("Commit Time (s)", "commit_time"),
    ("Early Connection (°'s)", "early_connection"),
    ("Hinge Angle at Impact (°'s)", "hinge_angle"),
    ("Connection at Impact (°'s)", "connection_impact"),
    ("Body Tilt Angle (°'s)", "body_tilt"),
]
_COLS = [c for _, c in _METRICS]


def _ensure_table(cur):
    cur.execute(f"""
        CREATE TABLE IF NOT EXISTS blast_stats (
            id            SERIAL PRIMARY KEY,
            owner_user_id UUID NOT NULL,
            player        TEXT NOT NULL,
            kind          TEXT NOT NULL,          -- avg | p95
            session_date  DATE NOT NULL,
            swings        INTEGER,
            {", ".join(f"{c} DOUBLE PRECISION" for c in _COLS)},
            created_at    TIMESTAMPTZ DEFAULT now(),
            UNIQUE (owner_user_id, player, kind, session_date)
        )
    """)
    cur.execute("ALTER TABLE blast_stats ENABLE ROW LEVEL SECURITY")


def _parse(text, filename):
    reader = csv.DictReader(io.StringIO(text))
    heads = reader.fieldnames or []
    if "first_name" not in heads or "Bat Speed (MPH)" not in heads:
        raise HTTPException(status_code=400,
                            detail=f"{filename}: not a Blast team export (expected "
                                   "first_name/last_name + Bat Speed columns).")
    rows = []
    for r in reader:
        name = f"{(r.get('first_name') or '').strip()} {(r.get('last_name') or '').strip()}".strip()
        if not name:
            continue
        out = {"player": name}
        try:
            out["swings"] = int(float(r.get("Swing Count") or 0)) or None
        except ValueError:
            out["swings"] = None
        for head, col in _METRICS:
            v = (r.get(head) or "").strip()
            try:
                x = float(v)
            except ValueError:
                out[col] = None
                continue
            if col == "ope" and x <= 1.5:   # fraction -> percent
                x *= 100.0
            out[col] = x
        rows.append(out)
    if not rows:
        raise HTTPException(status_code=400, detail=f"{filename}: no player rows found.")
    return rows


@router.post("/portal/blast/upload")
async def blast_upload(
    file: UploadFile = File(...),
    kind: str = Form(...),                    # 'avg' | 'p95'
    session_date: str | None = Form(None),    # YYYY-MM-DD; defaults to today
    owner: str = Depends(_write_gate),
):
    if kind not in ("avg", "p95"):
        raise HTTPException(status_code=400, detail="kind must be 'avg' or 'p95'.")
    sdate = session_date or date.today().isoformat()
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    rows = _parse(text, file.filename or "blast.csv")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_table(cur)
        execute_values(cur, f"""
            INSERT INTO blast_stats (owner_user_id, player, kind, session_date, swings, {", ".join(_COLS)})
            VALUES %s
            ON CONFLICT (owner_user_id, player, kind, session_date) DO UPDATE SET
                swings = EXCLUDED.swings,
                {", ".join(f"{c} = EXCLUDED.{c}" for c in _COLS)}
        """, [tuple([owner, r["player"], kind, sdate, r["swings"]] + [r[c] for c in _COLS])
              for r in rows], page_size=200)
        conn.commit()
    return {"status": "ok", "kind": kind, "session_date": sdate, "players": len(rows)}


@router.get("/portal/blast/board")
def blast_board(date_sel: str | None = Query(None, alias="date"),
                owner: str = Depends(_gate)):
    """The team swing board: per-hitter avg + p95 metrics for one testing
    date (default latest), plus every testing date and per-player bat-speed
    history for trend sparklines."""
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_table(cur)
        cur.execute("""SELECT DISTINCT session_date FROM blast_stats
                       WHERE owner_user_id = %s ORDER BY session_date DESC""", (owner,))
        dates = [r["session_date"].isoformat() for r in cur.fetchall()]
        if not dates:
            return {"dates": [], "players": [], "history": {}}
        active = date_sel if date_sel in dates else dates[0]
        cur.execute("""SELECT * FROM blast_stats
                       WHERE owner_user_id = %s AND session_date = %s""", (owner, active))
        rows = [dict(r) for r in cur.fetchall()]
        cur.execute("""SELECT player, kind, session_date, bat_speed FROM blast_stats
                       WHERE owner_user_id = %s ORDER BY session_date""", (owner,))
        hist_rows = cur.fetchall()
        conn.commit()

    merged = {}
    for r in rows:
        m = merged.setdefault(r["player"], {"player": r["player"], "swings": None,
                                            "avg": None, "p95": None})
        vals = {c: r[c] for c in _COLS}
        m[r["kind"] if r["kind"] in ("avg", "p95") else "avg"] = vals
        if r["kind"] == "avg" and r["swings"]:
            m["swings"] = r["swings"]
        elif m["swings"] is None and r["swings"]:
            m["swings"] = r["swings"]

    history = {}
    for r in hist_rows:
        if r["kind"] != "avg" or r["bat_speed"] is None:
            continue
        history.setdefault(r["player"], []).append(
            {"date": r["session_date"].isoformat(), "bat_speed": round(r["bat_speed"], 1)})

    players = sorted(merged.values(),
                     key=lambda m: -((m["avg"] or {}).get("bat_speed") or 0))
    return {"dates": dates, "date": active, "players": players, "history": history}


@router.delete("/portal/blast/sessions/{session_date}")
def blast_delete_session(session_date: str, owner: str = Depends(_write_gate)):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM blast_stats WHERE owner_user_id = %s AND session_date = %s",
                    (owner, session_date))
        n = cur.rowcount
        conn.commit()
    return {"status": "ok", "deleted": n}
