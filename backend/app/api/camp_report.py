"""Camp Report — prospect camp workspace for the coaching portal.

Coaches upload the data their camp produces (Blast Motion swing exports,
TrackMan BP + game/scrimmage CSVs), type in field-tested measurables
(60-yd dash, IF/OF throwing velo, catcher pop time) plus bio info and
development notes per attendee, and download a one-page report per
player styled like the Custom Player Card.

Private per-coach workspace (owner_user_id scoping) with the same staff
workspace sharing as the TrackMan Suite / Rapsodo Lab. Data model:

  camps        — one row per camp (name + date)
  camp_players — one row per attendee per camp: bio + manual measurables
                 + development notes (all coach-editable free text)
  camp_rows    — parsed device rows, one per swing / BBE / pitch, JSONB
                 payload keyed by (camp, kind, uid) so re-uploads dedupe.
                 kind: blast | tm_hit | tm_pitch

Attendee identity is a normalized name key; TrackMan "Last, First" names
are flipped to "First Last" for display. Blast exports carry no player
name in the data rows, so the upload endpoint requires a player name for
blast files (the UI collects it next to the file input).
"""
import csv
import hashlib
import io
import re

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from psycopg2.extras import Json
from pydantic import BaseModel

from ..models.database import get_connection
from ..stats.trackman_parse import PITCH_TYPE_MAP
from ._tracking_share import resolve_workspace
from .auth import require_tier

router = APIRouter(tags=["camp-report"])

_tier_gate = require_tier("coach")


def _gate(request: Request, owner: str = Depends(_tier_gate)) -> str:
    """Coach gate + shared-workspace resolution (staff see the coach's camps)."""
    return resolve_workspace(request, owner)


def _ensure_tables(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS camps (
            id            SERIAL PRIMARY KEY,
            owner_user_id UUID NOT NULL,
            name          TEXT NOT NULL,
            camp_date     DATE,
            created_at    TIMESTAMPTZ DEFAULT NOW()
        )""")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS camp_players (
            id            SERIAL PRIMARY KEY,
            owner_user_id UUID NOT NULL,
            camp_id       INTEGER NOT NULL REFERENCES camps(id) ON DELETE CASCADE,
            name_key      TEXT NOT NULL,
            display_name  TEXT NOT NULL,
            height TEXT, weight TEXT, school TEXT, hometown TEXT, state TEXT,
            grad_year TEXT, bats TEXT, throws TEXT, position TEXT,
            sixty_time TEXT, if_velo TEXT, of_velo TEXT, pop_time TEXT,
            notes TEXT,
            created_at    TIMESTAMPTZ DEFAULT NOW(),
            updated_at    TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (camp_id, name_key)
        )""")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS camp_rows (
            id            BIGSERIAL PRIMARY KEY,
            owner_user_id UUID NOT NULL,
            camp_id       INTEGER NOT NULL REFERENCES camps(id) ON DELETE CASCADE,
            name_key      TEXT NOT NULL,
            kind          TEXT NOT NULL,   -- blast | tm_hit | tm_pitch
            uid           TEXT NOT NULL,
            data          JSONB NOT NULL,
            created_at    TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (camp_id, kind, uid)
        )""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_camp_rows_lookup ON camp_rows(camp_id, name_key, kind)")
    # Supabase: anon has table grants; RLS (with no policies) is the gate
    # that keeps these private-coach tables private.
    for t in ("camps", "camp_players", "camp_rows"):
        cur.execute(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY")


def _name_key(name: str) -> str:
    return re.sub(r"[^a-z]", "", (name or "").lower())


def _display_name(raw: str) -> str:
    """'Last, First' -> 'First Last'; otherwise pass through cleaned."""
    n = (raw or "").strip()
    if "," in n:
        last, first = [p.strip() for p in n.split(",", 1)]
        return f"{first} {last}".strip()
    return n


def _fnum(v):
    try:
        return round(float(v), 2) if v not in (None, "", "Undefined") else None
    except (TypeError, ValueError):
        return None


def _upsert_player(cur, owner, camp_id, display):
    key = _name_key(display)
    if not key:
        return None
    cur.execute("""
        INSERT INTO camp_players (owner_user_id, camp_id, name_key, display_name)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (camp_id, name_key) DO NOTHING
    """, (owner, camp_id, key, display))
    return key


# ── Parsers ──────────────────────────────────────────────────────

def _looks_like_blast(text: str) -> bool:
    head = text[:400]
    return "Blast Motion" in head or "blastmotion.com" in head


BLAST_FIELDS = {
    "bat_speed": "Bat Speed (mph)",
    "rot_accel": "Rotational Acceleration (g)",
    "on_plane": "On Plane Efficiency (%)",
    "attack_angle": "Attack Angle (deg)",
    "early_conn": "Early Connection (deg)",
    "conn_impact": "Connection at Impact (deg)",
    "vba": "Vertical Bat Angle (deg)",
    "power": "Power (kW)",
    "ttc": "Time to Contact (sec)",
    "hand_speed": "Peak Hand Speed (mph)",
    "plane_score": "Plane Score",
    "connection_score": "Connection Score",
    "rotation_score": "Rotation Score",
}


def _parse_blast(text: str):
    """Blast Motion metrics export: preamble lines, then a Date,Equipment...
    header. Returns swing dicts."""
    lines = text.splitlines()
    start = next((i for i, ln in enumerate(lines) if ln.startswith("Date,Equipment")), None)
    if start is None:
        raise ValueError("Not a Blast Motion metrics export (no swing table header found).")
    reader = csv.DictReader(io.StringIO("\n".join(lines[start:])))
    swings = []
    for row in reader:
        swing = {k: _fnum(row.get(col)) for k, col in BLAST_FIELDS.items()}
        if swing["bat_speed"] is None:
            continue
        swing["date"] = (row.get("Date") or "")[:12]
        swing["_uid"] = hashlib.md5(
            "|".join(str(row.get(c) or "") for c in reader.fieldnames).encode()).hexdigest()[:16]
        swings.append(swing)
    return swings


def _parse_trackman(text: str):
    """TrackMan V3 CSV -> (context, hit_rows, pitch_rows). Context is 'bp'
    when the file has no pitch calls and blank pitchers (machine BP)."""
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    if not rows or "PitchUID" not in (reader.fieldnames or []):
        raise ValueError("Not a TrackMan CSV (no PitchUID column).")
    calls = {r.get("PitchCall") for r in rows}
    is_bp = calls <= {"Undefined", "", None} and not any((r.get("Pitcher") or "").strip() for r in rows)
    ctx = "bp" if is_bp else "game"
    hit, pitch = [], []
    for r in rows:
        uid = r.get("PitchUID")
        batter = (r.get("Batter") or "").strip()
        if batter:
            ev = _fnum(r.get("ExitSpeed"))
            entry = {
                "b": batter, "side": r.get("BatterSide"), "ctx": ctx,
                "call": r.get("PitchCall"), "ev": ev,
                "la": _fnum(r.get("Angle")), "dist": _fnum(r.get("Distance")),
                "_uid": uid,
            }
            # BBE (tracked contact) or, in games, any pitch (for K/BB context
            # later if we want it). Keep storage lean: BBE only.
            if ev is not None:
                hit.append(entry)
        pitcher = (r.get("Pitcher") or "").strip()
        velo = _fnum(r.get("RelSpeed"))
        if pitcher and velo is not None:
            raw_type = (r.get("TaggedPitchType") or "").strip()
            if raw_type in ("", "Undefined"):
                raw_type = (r.get("AutoPitchType") or "").strip()
            ptype = PITCH_TYPE_MAP.get(raw_type, raw_type) or "Unknown"
            pitch.append({
                "p": pitcher, "throws": r.get("PitcherThrows"), "ctx": ctx,
                "type": ptype, "velo": velo,
                "spin": _fnum(r.get("SpinRate")),
                "ivb": _fnum(r.get("InducedVertBreak")),
                "hb": _fnum(r.get("HorzBreak")),
                "ext": _fnum(r.get("Extension")),
                "call": r.get("PitchCall"),
                "_uid": uid,
            })
    return ctx, hit, pitch


# ── Camps CRUD ───────────────────────────────────────────────────

class CampCreate(BaseModel):
    name: str
    camp_date: str | None = None


@router.get("/portal/camps")
def list_camps(owner: str = Depends(_gate)):
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute("""
            SELECT c.id, c.name, c.camp_date, c.created_at::date AS created,
                   (SELECT COUNT(*) FROM camp_players cp WHERE cp.camp_id = c.id) AS players,
                   (SELECT COUNT(*) FROM camp_rows cr WHERE cr.camp_id = c.id) AS rows
            FROM camps c WHERE c.owner_user_id = %s ORDER BY c.created_at DESC
        """, (owner,))
        camps = [{**dict(r),
                  "camp_date": r["camp_date"].isoformat() if r["camp_date"] else None,
                  "created": r["created"].isoformat() if r["created"] else None}
                 for r in cur.fetchall()]
        conn.commit()
    return {"camps": camps}


@router.post("/portal/camps")
def create_camp(body: CampCreate, owner: str = Depends(_gate)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Camp name is required.")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        cur.execute(
            "INSERT INTO camps (owner_user_id, name, camp_date) VALUES (%s, %s, %s) RETURNING id",
            (owner, name, body.camp_date or None))
        cid = cur.fetchone()["id"]
        conn.commit()
    return {"id": cid, "name": name}


@router.delete("/portal/camps/{camp_id}")
def delete_camp(camp_id: int, owner: str = Depends(_gate)):
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM camps WHERE id = %s AND owner_user_id = %s", (camp_id, owner))
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Camp not found.")
        conn.commit()
    return {"status": "ok"}


def _own_camp(cur, owner, camp_id):
    cur.execute("SELECT id FROM camps WHERE id = %s AND owner_user_id = %s", (camp_id, owner))
    if not cur.fetchone():
        raise HTTPException(status_code=404, detail="Camp not found.")


# ── Upload ───────────────────────────────────────────────────────

@router.post("/portal/camps/{camp_id}/upload")
async def upload_camp_files(
    camp_id: int,
    files: list[UploadFile] = File(...),
    blast_player: str = Form(None),
    owner: str = Depends(_gate),
):
    """Upload camp CSVs. TrackMan files (BP or game) are detected and
    split per batter/pitcher automatically; Blast Motion exports carry no
    name, so blast_player names their owner. Rows dedupe on PitchUID /
    swing hash, so re-uploading a file never double-counts."""
    results, errors = [], []
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        _own_camp(cur, owner, camp_id)

        def insert_row(key, kind, uid, data):
            cur.execute("""
                INSERT INTO camp_rows (owner_user_id, camp_id, name_key, kind, uid, data)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (camp_id, kind, uid) DO NOTHING
            """, (owner, camp_id, key, kind, uid, Json(data)))
            return cur.rowcount

        for f in files:
            try:
                text = (await f.read()).decode("utf-8-sig", errors="replace")
                if _looks_like_blast(text):
                    display = _display_name(blast_player or "")
                    if not display:
                        raise ValueError("Blast Motion files need a player name — "
                                         "type the attendee's name next to the file.")
                    key = _upsert_player(cur, owner, camp_id, display)
                    swings = _parse_blast(text)
                    added = sum(insert_row(key, "blast", s.pop("_uid"), s) for s in swings)
                    results.append({"file": f.filename, "kind": "blast",
                                    "player": display, "rows": len(swings), "new": added})
                else:
                    ctx, hit, pitch = _parse_trackman(text)
                    added = 0
                    names = set()
                    for h in hit:
                        display = _display_name(h.pop("b"))
                        key = _upsert_player(cur, owner, camp_id, display)
                        names.add(display)
                        added += insert_row(key, "tm_hit", h.pop("_uid"), h)
                    for p in pitch:
                        display = _display_name(p.pop("p"))
                        key = _upsert_player(cur, owner, camp_id, display)
                        names.add(display)
                        added += insert_row(key, "tm_pitch", p.pop("_uid"), p)
                    results.append({"file": f.filename, "kind": f"trackman_{ctx}",
                                    "players": len(names), "rows": len(hit) + len(pitch), "new": added})
            except Exception as e:  # noqa: BLE001 — per-file report
                errors.append({"file": f.filename, "error": str(e)})
        conn.commit()
    return {"results": results, "errors": errors}


# ── Attendees ────────────────────────────────────────────────────

PLAYER_FIELDS = ["display_name", "height", "weight", "school", "hometown", "state",
                 "grad_year", "bats", "throws", "position",
                 "sixty_time", "if_velo", "of_velo", "pop_time", "notes"]


@router.get("/portal/camps/{camp_id}/players")
def camp_players(camp_id: int, owner: str = Depends(_gate)):
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        _own_camp(cur, owner, camp_id)
        cur.execute("""
            SELECT cp.name_key, cp.display_name, cp.position, cp.school,
                   COUNT(*) FILTER (WHERE cr.kind = 'blast') AS blast_rows,
                   COUNT(*) FILTER (WHERE cr.kind = 'tm_hit') AS hit_rows,
                   COUNT(*) FILTER (WHERE cr.kind = 'tm_pitch') AS pitch_rows
            FROM camp_players cp
            LEFT JOIN camp_rows cr ON cr.camp_id = cp.camp_id AND cr.name_key = cp.name_key
            WHERE cp.camp_id = %s
            GROUP BY cp.name_key, cp.display_name, cp.position, cp.school
            ORDER BY cp.display_name
        """, (camp_id,))
        players = [dict(r) for r in cur.fetchall()]
        conn.commit()
    return {"players": players}


class PlayerPatch(BaseModel):
    display_name: str | None = None
    height: str | None = None
    weight: str | None = None
    school: str | None = None
    hometown: str | None = None
    state: str | None = None
    grad_year: str | None = None
    bats: str | None = None
    throws: str | None = None
    position: str | None = None
    sixty_time: str | None = None
    if_velo: str | None = None
    of_velo: str | None = None
    pop_time: str | None = None
    notes: str | None = None


@router.post("/portal/camps/{camp_id}/players")
def add_camp_player(camp_id: int, body: PlayerPatch, owner: str = Depends(_gate)):
    """Manually add an attendee (no device data yet)."""
    display = (body.display_name or "").strip()
    if not display:
        raise HTTPException(status_code=400, detail="Player name is required.")
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        _own_camp(cur, owner, camp_id)
        key = _upsert_player(cur, owner, camp_id, display)
        conn.commit()
    return {"name_key": key, "display_name": display}


@router.patch("/portal/camps/{camp_id}/players/{name_key}")
def patch_camp_player(camp_id: int, name_key: str, body: PlayerPatch, owner: str = Depends(_gate)):
    sets, vals = [], []
    for f in PLAYER_FIELDS:
        v = getattr(body, f)
        if v is not None:
            sets.append(f"{f} = %s")
            vals.append(v.strip() or None)
    if not sets:
        return {"status": "ok"}
    with get_connection() as conn:
        cur = conn.cursor()
        _own_camp(cur, owner, camp_id)
        cur.execute(
            f"UPDATE camp_players SET {', '.join(sets)}, updated_at = NOW() "
            f"WHERE camp_id = %s AND name_key = %s",
            vals + [camp_id, name_key])
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Attendee not found.")
        conn.commit()
    return {"status": "ok"}


@router.delete("/portal/camps/{camp_id}/players/{name_key}")
def delete_camp_player(camp_id: int, name_key: str, owner: str = Depends(_gate)):
    with get_connection() as conn:
        cur = conn.cursor()
        _own_camp(cur, owner, camp_id)
        cur.execute("DELETE FROM camp_rows WHERE camp_id = %s AND name_key = %s", (camp_id, name_key))
        cur.execute("DELETE FROM camp_players WHERE camp_id = %s AND name_key = %s", (camp_id, name_key))
        conn.commit()
    return {"status": "ok"}


# ── Report payload ───────────────────────────────────────────────

def _avg(xs):
    xs = [x for x in xs if x is not None]
    return round(sum(xs) / len(xs), 1) if xs else None


def _mx(xs):
    xs = [x for x in xs if x is not None]
    return round(max(xs), 1) if xs else None


@router.get("/portal/camps/{camp_id}/players/{name_key}/report")
def camp_player_report(camp_id: int, name_key: str, owner: str = Depends(_gate)):
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        _own_camp(cur, owner, camp_id)
        cur.execute("SELECT name, camp_date FROM camps WHERE id = %s", (camp_id,))
        camp = cur.fetchone()
        cur.execute("SELECT * FROM camp_players WHERE camp_id = %s AND name_key = %s",
                    (camp_id, name_key))
        p = cur.fetchone()
        if not p:
            raise HTTPException(status_code=404, detail="Attendee not found.")
        cur.execute("SELECT kind, data FROM camp_rows WHERE camp_id = %s AND name_key = %s",
                    (camp_id, name_key))
        rows = cur.fetchall()
        conn.commit()

    blast = [r["data"] for r in rows if r["kind"] == "blast"]
    hits = [r["data"] for r in rows if r["kind"] == "tm_hit"]
    pitches = [r["data"] for r in rows if r["kind"] == "tm_pitch"]

    blast_summary = None
    if blast:
        blast_summary = {
            "swings": len(blast),
            "bat_speed_avg": _avg([s.get("bat_speed") for s in blast]),
            "bat_speed_max": _mx([s.get("bat_speed") for s in blast]),
            "rot_accel_avg": _avg([s.get("rot_accel") for s in blast]),
            "on_plane_avg": _avg([s.get("on_plane") for s in blast]),
            "attack_angle_avg": _avg([s.get("attack_angle") for s in blast]),
            "ttc_avg": (lambda xs: round(sum(xs) / len(xs), 3) if xs else None)(
                [s["ttc"] for s in blast if s.get("ttc") is not None]),
            "hand_speed_avg": _avg([s.get("hand_speed") for s in blast]),
            "hand_speed_max": _mx([s.get("hand_speed") for s in blast]),
            "power_avg": _avg([s.get("power") for s in blast]),
            "scores": {
                "plane": _avg([s.get("plane_score") for s in blast]),
                "connection": _avg([s.get("connection_score") for s in blast]),
                "rotation": _avg([s.get("rotation_score") for s in blast]),
            },
        }

    def hit_block(ctx):
        sub = [h for h in hits if h.get("ctx") == ctx]
        evs = [h.get("ev") for h in sub if h.get("ev") is not None]
        if not evs:
            return None
        hard = sum(1 for e in evs if e >= 90)
        return {
            "bbe": len(evs),
            "ev_avg": _avg(evs), "ev_max": _mx(evs),
            "la_avg": _avg([h.get("la") for h in sub]),
            "dist_max": _mx([h.get("dist") for h in sub]),
            "hard_hit_pct": round(hard / len(evs), 3),
        }

    hitting = {"bp": hit_block("bp"), "game": hit_block("game")} if hits else None
    # per-swing points for the EV/LA scatter (game + bp tagged)
    scatter = [{"ev": h["ev"], "la": h.get("la"), "ctx": h.get("ctx")}
               for h in hits if h.get("ev") is not None][:120]

    pitching = None
    if pitches:
        by_type = {}
        for x in pitches:
            by_type.setdefault(x.get("type") or "Unknown", []).append(x)
        arsenal = []
        for t, xs in sorted(by_type.items(), key=lambda kv: -len(kv[1])):
            strikes = sum(1 for x in xs if x.get("call") not in
                          (None, "", "Undefined", "BallCalled", "BallinDirt",
                           "BallIntentional", "HitByPitch"))
            has_calls = any(x.get("call") not in (None, "", "Undefined") for x in xs)
            arsenal.append({
                "type": t, "n": len(xs),
                "velo_avg": _avg([x.get("velo") for x in xs]),
                "velo_max": _mx([x.get("velo") for x in xs]),
                "spin_avg": (lambda s: round(s) if s is not None else None)(
                    _avg([x.get("spin") for x in xs])),
                "ivb_avg": _avg([x.get("ivb") for x in xs]),
                "hb_avg": _avg([x.get("hb") for x in xs]),
                "ext_avg": _avg([x.get("ext") for x in xs]),
                "strike_pct": round(strikes / len(xs), 3) if has_calls else None,
            })
        pitching = {"pitches": len(pitches), "arsenal": arsenal,
                    "throws": next((x.get("throws") for x in pitches if x.get("throws")), None)}

    player = {k: p.get(k) for k in ["name_key", "display_name"] + PLAYER_FIELDS if k in p}
    return {
        "camp": {"name": camp["name"],
                 "date": camp["camp_date"].isoformat() if camp["camp_date"] else None},
        "player": player,
        "blast": blast_summary,
        "hitting": hitting,
        "scatter": scatter,
        "pitching": pitching,
    }
