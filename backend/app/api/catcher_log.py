"""Coach catcher quick log (xlsx) for the TrackMan Suite's Catching tab.

A coach charts every live game by hand in a small workbook ("Bushnell
Catcher Quick Log"): one row per BLOCK chance, THROW (steal attempt or
between-innings throwdown) and the occasional catcher pop, with the inning,
the count, the outcome, a 1-5 grade and a note that usually carries the pop
time. TrackMan sees none of this (it has no runners, no blocks, no
throwdowns), so the log is the other half of the catcher picture.

Parsing is deliberately forgiving: Excel turns counts like 2-2 into dates
(Feb 2), catchers are typed as "First Last" or "Nick / First Last", pop
times live in the note column, and outcome spellings drift. Games inside
one file are split where the inning number resets.

Owner-scoped like the rest of the suite; re-uploading the same date
replaces that date's rows.
"""
import io
import re
from datetime import date, datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from psycopg2.extras import execute_values

from ..models.database import get_connection
from .trackman_suite import _gate, _write_gate

router = APIRouter()

EVENTS = {"block": "Block", "throw": "Throw", "catcher pop": "Pop", "pop": "Pop", "popup": "Pop"}
OUTCOMES = [
    (re.compile(r"block\s*succ|blocked|success", re.I), "Block Success"),
    (re.compile(r"block\s*miss|miss", re.I), "Block Miss"),
    (re.compile(r"passed|pb\b", re.I), "Passed Ball"),
    (re.compile(r"caught\s*steal|\bcs\b", re.I), "Caught Stealing"),
    (re.compile(r"stolen|\bsb\b", re.I), "Stolen Base"),
    (re.compile(r"throw\s*down|throwdown", re.I), "Throwdown"),
    (re.compile(r"caught", re.I), "Caught"),
]
POP_RE = re.compile(r"\b([12]\.\d{1,2})\b")


def _ensure_table(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tm_catcher_log (
            id            SERIAL PRIMARY KEY,
            owner_user_id UUID NOT NULL,
            session_date  DATE NOT NULL,
            game_no       INTEGER NOT NULL DEFAULT 1,
            row_no        INTEGER,
            inning        INTEGER,
            catcher       TEXT NOT NULL,
            count         TEXT,
            event         TEXT,
            outcome       TEXT,
            pop_time      DOUBLE PRECISION,
            grade         DOUBLE PRECISION,
            note          TEXT,
            created_at    TIMESTAMPTZ DEFAULT now()
        )
    """)
    cur.execute("ALTER TABLE tm_catcher_log ENABLE ROW LEVEL SECURITY")
    cur.execute("CREATE INDEX IF NOT EXISTS tm_catcher_log_owner_date ON tm_catcher_log (owner_user_id, session_date)")


def _count(v):
    """'2-2', 'Feb 2 datetime' (Excel ate it), 2.0 -> 'B-S' or None."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return f"{v.month}-{v.day}"
    s = str(v).strip()
    m = re.match(r"^(\d)\s*[-–/]\s*(\d)$", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    return None


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _catcher(v):
    """'Hoko / Reyn Gaspar' -> 'Reyn Gaspar' (the real name is the last part)."""
    if not v:
        return None
    s = str(v).strip()
    if "/" in s:
        s = s.split("/")[-1].strip()
    return s or None


def _outcome(v):
    if not v:
        return None
    s = str(v).strip()
    for rx, label in OUTCOMES:
        if rx.search(s):
            return label
    return s


def parse_workbook(data: bytes):
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    ws = next((w for w in wb.worksheets if "log" in w.title.lower()), wb.worksheets[0])
    rows, header_seen, prev_inning, game_no, row_no = [], False, None, 1, 0
    for raw in ws.iter_rows(values_only=True):
        cells = list(raw) + [None] * 8
        if not header_seen:
            if str(cells[0] or "").strip().lower() == "inning":
                header_seen = True
            continue
        inning, catcher = _num(cells[0]), _catcher(cells[1])
        if catcher is None and inning is None:
            continue
        if not catcher:
            continue
        event_raw = str(cells[3] or "").strip().lower()
        event = EVENTS.get(event_raw, (event_raw.title() if event_raw else None))
        if not event and cells[4] is None:
            continue   # a name with nothing logged (the coach's blank line)
        inning = int(inning) if inning is not None else None
        if prev_inning is not None and inning is not None and inning < prev_inning:
            game_no += 1   # innings reset: next game in the same sheet
        if inning is not None:
            prev_inning = inning
        note = str(cells[7]).strip() if cells[7] is not None else None
        pop = _num(cells[5])
        if pop is None and note:
            m = POP_RE.search(note)
            if m:
                pop = float(m.group(1))
        if pop is not None and not (1.5 <= pop <= 3.2):
            pop = None
        row_no += 1
        rows.append({
            "game_no": game_no, "row_no": row_no, "inning": inning, "catcher": catcher,
            "count": _count(cells[2]), "event": event, "outcome": _outcome(cells[4]),
            "pop_time": pop, "grade": _num(cells[6]), "note": note,
        })
    if not rows:
        raise HTTPException(status_code=400, detail="No log rows found (expected a 'Live Log' sheet with an Inning / Catcher / Count / Event / Outcome header).")
    return rows


@router.post("/trackman/catcher-log/upload")
async def catcher_log_upload(
    file: UploadFile = File(...),
    session_date: str | None = Form(None),
    owner: str = Depends(_write_gate),
):
    sdate = session_date or date.today().isoformat()
    rows = parse_workbook(await file.read())
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_table(cur)
        cur.execute("DELETE FROM tm_catcher_log WHERE owner_user_id = %s AND session_date = %s", (owner, sdate))
        execute_values(cur, """
            INSERT INTO tm_catcher_log (owner_user_id, session_date, game_no, row_no, inning, catcher,
                                        count, event, outcome, pop_time, grade, note)
            VALUES %s""",
            [(owner, sdate, r["game_no"], r["row_no"], r["inning"], r["catcher"], r["count"],
              r["event"], r["outcome"], r["pop_time"], r["grade"], r["note"]) for r in rows])
        conn.commit()
    games = max(r["game_no"] for r in rows)
    return {"status": "ok", "session_date": sdate, "rows": len(rows), "games": games,
            "catchers": sorted({r["catcher"] for r in rows})}


def _tm_name(name):
    """'Reyn Gaspar' -> 'Gaspar, Reyn' for matching TrackMan's catcher field."""
    parts = name.replace(",", " ").split()
    if len(parts) < 2:
        return name
    return f"{parts[-1]}, {' '.join(parts[:-1])}"


@router.get("/trackman/catcher-log")
def catcher_log(date_from: str | None = Query(None), date_to: str | None = Query(None),
                owner: str = Depends(_gate)):
    """Per-catcher rollup of the coach log plus every event, with block
    events matched to the TrackMan pitch (same date, catcher, inning, count,
    ball in the dirt / ball) when exactly one fits."""
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_table(cur)
        extra, params = "", [owner]
        if date_from:
            extra += " AND session_date >= %s"; params.append(date_from)
        if date_to:
            extra += " AND session_date <= %s"; params.append(date_to)
        cur.execute(f"""SELECT * FROM tm_catcher_log WHERE owner_user_id = %s{extra}
                        ORDER BY session_date, game_no, row_no""", params)
        rows = [dict(r) for r in cur.fetchall()]
        if not rows:
            return {"catchers": [], "events": [], "dates": []}
        dates = sorted({r["session_date"] for r in rows})
        # candidate TrackMan pitches on those dates for block matching
        # A workbook often holds several games and is uploaded under the last
        # one's date, so candidates come from every live session in the week
        # up to each log date; the match must still be unique.
        cur.execute("""SELECT p.id, s.session_date, p.catcher, p.inning, p.balls, p.strikes, p.pitch_call,
                              COALESCE(p.override_pitch_type, p.class_pitch_type, p.tagged_pitch_type, p.auto_pitch_type) AS ptype,
                              p.rel_speed, p.plate_loc_side, p.plate_loc_height, p.pitcher
                       FROM tm_pitches p JOIN tm_sessions s ON s.id = p.session_id
                       WHERE p.owner_user_id = %s AND p.catcher IS NOT NULL
                         AND s.session_type IN ('game', 'scrimmage', 'intrasquad')
                         AND s.session_date >= %s - INTERVAL '7 days' AND s.session_date <= %s""",
                    (owner, min(dates), max(dates)))
        tm = [dict(r) for r in cur.fetchall()]

    def _last(name):
        n = (name or "").strip()
        return (n.split(",")[0] if "," in n else n.split()[-1] if n else "").lower()

    by_key = {}
    for t in tm:
        key = (_last(t["catcher"]), t["inning"], f"{t['balls']}-{t['strikes']}")
        by_key.setdefault(key, []).append(t)

    events, agg = [], {}
    for r in rows:
        r["session_date"] = r["session_date"].isoformat()
        c = agg.setdefault(r["catcher"], {"catcher": r["catcher"], "games": set(), "block_opps": 0, "block_success": 0,
                                          "block_miss": 0, "pb": 0, "sb": 0, "cs": 0, "throwdowns": 0,
                                          "pops": [], "grades": [], "notes": []})
        c["games"].add((r["session_date"], r["game_no"]))
        o = r["outcome"] or ""
        if r["event"] == "Block" or o in ("Block Success", "Block Miss", "Passed Ball"):
            c["block_opps"] += 1
            if o == "Block Success":
                c["block_success"] += 1
            elif o == "Block Miss":
                c["block_miss"] += 1
            elif o == "Passed Ball":
                c["pb"] += 1
        if o == "Stolen Base":
            c["sb"] += 1
        elif o == "Caught Stealing":
            c["cs"] += 1
        elif o == "Throwdown":
            c["throwdowns"] += 1
        if r["pop_time"] is not None:
            c["pops"].append(r["pop_time"])
        if r["grade"] is not None:
            c["grades"].append(r["grade"])
        if r["note"] and r["pop_time"] is None:
            c["notes"].append(r["note"])
        # block -> TrackMan pitch match
        match = None
        if r["event"] == "Block" and r["inning"] is not None and r["count"]:
            d0 = date.fromisoformat(r["session_date"])
            cands = [t for t in by_key.get((_last(r["catcher"]), r["inning"], r["count"]), [])
                     if (d0 - t["session_date"]).days in range(0, 8)]
            dirt = [t for t in cands if t["pitch_call"] in ("BallinDirt", "BallCalled")]
            pool = dirt or cands
            if len(pool) == 1:
                t = pool[0]
                match = {"pitch_id": t["id"], "date": t["session_date"].isoformat(), "ptype": t["ptype"], "velo": round(float(t["rel_speed"]), 1) if t["rel_speed"] else None,
                         "pitcher": t["pitcher"], "call": t["pitch_call"],
                         "loc_side": round(float(t["plate_loc_side"]), 2) if t["plate_loc_side"] is not None else None,
                         "loc_height": round(float(t["plate_loc_height"]), 2) if t["plate_loc_height"] is not None else None}
        events.append({**r, "tm": match})

    catchers = []
    for c in agg.values():
        opps = c["block_opps"]
        steals = c["sb"] + c["cs"]
        catchers.append({
            "catcher": c["catcher"], "games": len(c["games"]),
            "block_opps": opps, "block_success": c["block_success"], "block_miss": c["block_miss"], "pb": c["pb"],
            "block_pct": round(100 * c["block_success"] / opps, 1) if opps else None,
            "sb": c["sb"], "cs": c["cs"], "cs_pct": round(100 * c["cs"] / steals, 1) if steals else None,
            "throwdowns": c["throwdowns"],
            "avg_pop": round(sum(c["pops"]) / len(c["pops"]), 2) if c["pops"] else None,
            "best_pop": round(min(c["pops"]), 2) if c["pops"] else None,
            "pops_n": len(c["pops"]),
            "avg_grade": round(sum(c["grades"]) / len(c["grades"]), 2) if c["grades"] else None,
            "grades_n": len(c["grades"]),
            "notes": c["notes"][:6],
        })
    catchers.sort(key=lambda c: -(c["block_opps"] + c["sb"] + c["cs"] + c["throwdowns"]))
    return {"catchers": catchers, "events": events, "dates": [d.isoformat() for d in dates]}


@router.delete("/trackman/catcher-log/{session_date}")
def catcher_log_delete(session_date: str, owner: str = Depends(_write_gate)):
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_table(cur)
        cur.execute("DELETE FROM tm_catcher_log WHERE owner_user_id = %s AND session_date = %s", (owner, session_date))
        n = cur.rowcount
        conn.commit()
    return {"status": "ok", "deleted": n}
