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
from psycopg2.extras import Json, execute_values
from pydantic import BaseModel

from ..models.database import get_connection
from ..stats.trackman_parse import PITCH_TYPE_MAP
from ._tracking_share import resolve_workspace, ensure_can_upload
from .auth import require_tier

router = APIRouter(tags=["camp-report"])

_tier_gate = require_tier("coach")


def _gate(request: Request, owner: str = Depends(_tier_gate)) -> str:
    """Coach gate + shared-workspace resolution (staff see the coach's camps)."""
    return resolve_workspace(request, owner)


def _write_gate(request: Request, owner: str = Depends(_gate)) -> str:
    """Like _gate, but 403s staff members whose can_upload is off."""
    ensure_can_upload(request, owner)
    return owner


_TABLES_READY = False


def _ensure_tables(cur):
    # Once per process: every statement below (incl. ADD COLUMN IF NOT
    # EXISTS and ENABLE ROW LEVEL SECURITY) takes an ACCESS EXCLUSIVE
    # lock even when it's a no-op, which stalls under live traffic.
    global _TABLES_READY
    if _TABLES_READY:
        return
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
    # Per-file registry so coaches can delete an upload. Rows cascade.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS camp_uploads (
            id            SERIAL PRIMARY KEY,
            owner_user_id UUID NOT NULL,
            camp_id       INTEGER NOT NULL REFERENCES camps(id) ON DELETE CASCADE,
            filename      TEXT NOT NULL,
            kind          TEXT,
            row_count     INTEGER DEFAULT 0,
            created_at    TIMESTAMPTZ DEFAULT NOW()
        )""")
    cur.execute("""ALTER TABLE camp_rows ADD COLUMN IF NOT EXISTS upload_id
                   INTEGER REFERENCES camp_uploads(id) ON DELETE CASCADE""")
    cur.execute("ALTER TABLE camp_uploads ENABLE ROW LEVEL SECURITY")
    # Hand-entered Blast numbers (pen-and-paper camps where the export
    # isn't available). Used by the report only when no blast rows exist.
    for c in ("blast_bat_speed", "blast_hand_speed", "blast_rot_accel",
              "blast_plane", "blast_connection", "blast_rotation"):
        cur.execute(f"ALTER TABLE camp_players ADD COLUMN IF NOT EXISTS {c} TEXT")
    # Supabase: anon has table grants; RLS (with no policies) is the gate
    # that keeps these private-coach tables private.
    for t in ("camps", "camp_players", "camp_rows"):
        cur.execute(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY")
    _TABLES_READY = True


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
                "dir": _fnum(r.get("Direction")),
                "res": r.get("PlayResult"), "htype": r.get("TaggedHitType"),
                "_uid": uid,
            }
            # Storage stays lean: BBE (tracked contact) only.
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
                "rel_h": _fnum(r.get("RelHeight")),
                "rel_s": _fnum(r.get("RelSide")),
                "px": _fnum(r.get("PlateLocSide")),
                "pz": _fnum(r.get("PlateLocHeight")),
                "no": _fnum(r.get("PitchNo")),
                "call": r.get("PitchCall"),
                "res": r.get("PlayResult"), "kbb": r.get("KorBB"),
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
def delete_camp(camp_id: int, owner: str = Depends(_write_gate)):
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
    owner: str = Depends(_write_gate),
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

        def new_upload_rec(filename, kind, n):
            # Replacing a same-named file replaces its registry entry; the
            # cascade clears that file's old rows before the fresh insert.
            cur.execute("DELETE FROM camp_uploads WHERE camp_id = %s AND filename = %s",
                        (camp_id, filename))
            cur.execute("""INSERT INTO camp_uploads (owner_user_id, camp_id, filename, kind, row_count)
                           VALUES (%s, %s, %s, %s, %s) RETURNING id""",
                        (owner, camp_id, filename, kind, n))
            return cur.fetchone()["id"]

        def insert_rows(upload_id, batch):
            # One statement for the whole file (uploads were painfully slow
            # with a round-trip per row). DO UPDATE so re-uploading a file
            # refreshes old rows with newly-parsed fields.
            if not batch:
                return 0
            execute_values(cur, """
                INSERT INTO camp_rows (owner_user_id, camp_id, name_key, kind, uid, data, upload_id)
                VALUES %s
                ON CONFLICT (camp_id, kind, uid) DO UPDATE
                    SET data = EXCLUDED.data, name_key = EXCLUDED.name_key,
                        upload_id = EXCLUDED.upload_id
            """, [b + (upload_id,) for b in batch], page_size=500)
            return len(batch)

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
                    up_id = new_upload_rec(f.filename or "blast.csv", "blast", len(swings))
                    added = insert_rows(up_id, [(owner, camp_id, key, "blast", s.pop("_uid"), Json(s))
                                                for s in swings])
                    results.append({"file": f.filename, "kind": "blast",
                                    "player": display, "rows": len(swings), "new": added})
                else:
                    ctx, hit, pitch = _parse_trackman(text)
                    batch, names, keys = [], set(), {}
                    def key_for(display):
                        if display not in keys:
                            keys[display] = _upsert_player(cur, owner, camp_id, display)
                            names.add(display)
                        return keys[display]
                    for h in hit:
                        k = key_for(_display_name(h.pop("b")))
                        batch.append((owner, camp_id, k, "tm_hit", h.pop("_uid"), Json(h)))
                    for p in pitch:
                        k = key_for(_display_name(p.pop("p")))
                        batch.append((owner, camp_id, k, "tm_pitch", p.pop("_uid"), Json(p)))
                    up_id = new_upload_rec(f.filename or "trackman.csv", f"trackman_{ctx}", len(batch))
                    added = insert_rows(up_id, batch)
                    results.append({"file": f.filename, "kind": f"trackman_{ctx}",
                                    "players": len(names), "rows": len(hit) + len(pitch), "new": added})
            except Exception as e:  # noqa: BLE001 — per-file report
                errors.append({"file": f.filename, "error": str(e)})
        conn.commit()
    return {"results": results, "errors": errors}


@router.get("/portal/camps/{camp_id}/uploads")
def camp_uploads(camp_id: int, owner: str = Depends(_gate)):
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tables(cur)
        _own_camp(cur, owner, camp_id)
        cur.execute("""
            SELECT u.id, u.filename, u.kind, u.created_at::date AS uploaded,
                   COUNT(r.id) AS rows
            FROM camp_uploads u
            LEFT JOIN camp_rows r ON r.upload_id = u.id
            WHERE u.camp_id = %s
            GROUP BY u.id ORDER BY u.created_at DESC
        """, (camp_id,))
        uploads = [{**dict(r), "uploaded": r["uploaded"].isoformat() if r["uploaded"] else None}
                   for r in cur.fetchall()]
        conn.commit()
    return {"uploads": uploads}


@router.delete("/portal/camps/{camp_id}/uploads/{upload_id}")
def delete_camp_upload(camp_id: int, upload_id: int, owner: str = Depends(_write_gate)):
    """Delete one uploaded file's rows (cascade) and prune attendees that
    were auto-created from it and have nothing else: no remaining data
    rows and no coach-typed info."""
    with get_connection() as conn:
        cur = conn.cursor()
        _own_camp(cur, owner, camp_id)
        cur.execute("DELETE FROM camp_uploads WHERE id = %s AND camp_id = %s",
                    (upload_id, camp_id))
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Upload not found.")
        manual_empty = " AND ".join(
            f"COALESCE(cp.{c}, '') = ''"
            for c in PLAYER_FIELDS if c != "display_name")
        cur.execute(f"""
            DELETE FROM camp_players cp
            WHERE cp.camp_id = %s
              AND NOT EXISTS (SELECT 1 FROM camp_rows r
                              WHERE r.camp_id = cp.camp_id AND r.name_key = cp.name_key)
              AND {manual_empty}
        """, (camp_id,))
        pruned = cur.rowcount
        conn.commit()
    return {"status": "ok", "players_pruned": pruned}


# ── Attendees ────────────────────────────────────────────────────

PLAYER_FIELDS = ["display_name", "height", "weight", "school", "hometown", "state",
                 "grad_year", "bats", "throws", "position",
                 "sixty_time", "if_velo", "of_velo", "pop_time", "notes",
                 "blast_bat_speed", "blast_hand_speed", "blast_rot_accel",
                 "blast_plane", "blast_connection", "blast_rotation"]


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
    blast_bat_speed: str | None = None
    blast_hand_speed: str | None = None
    blast_rot_accel: str | None = None
    blast_plane: str | None = None
    blast_connection: str | None = None
    blast_rotation: str | None = None


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
    if not blast and any(p.get(c) for c in (
            "blast_bat_speed", "blast_hand_speed", "blast_rot_accel",
            "blast_plane", "blast_connection", "blast_rotation")):
        # Hand-entered numbers stand in for the export.
        blast_summary = {
            "manual": True, "swings": None,
            "bat_speed_avg": p.get("blast_bat_speed"), "bat_speed_max": None,
            "hand_speed_avg": p.get("blast_hand_speed"), "hand_speed_max": None,
            "rot_accel_avg": p.get("blast_rot_accel"),
            "on_plane_avg": None, "attack_angle_avg": None,
            "ttc_avg": None, "power_avg": None,
            "scores": {"plane": _fnum(p.get("blast_plane")),
                       "connection": _fnum(p.get("blast_connection")),
                       "rotation": _fnum(p.get("blast_rotation"))},
        }
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

    def la_mix(sub):
        las = [h.get("la") for h in sub if h.get("la") is not None]
        if not las:
            return None
        n = len(las)
        return {
            "gb": round(sum(1 for a in las if a < 10) / n, 3),
            "ld": round(sum(1 for a in las if 10 <= a < 25) / n, 3),
            "fb": round(sum(1 for a in las if 25 <= a < 50) / n, 3),
            "pu": round(sum(1 for a in las if a >= 50) / n, 3),
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
            "sweet_spot_pct": (lambda las: round(
                sum(1 for a in las if 8 <= a <= 32) / len(las), 3) if las else None)(
                [h.get("la") for h in sub if h.get("la") is not None]),
            "la_mix": la_mix(sub),
        }

    hitting = {"bp": hit_block("bp"), "game": hit_block("game")} if hits else None
    # per-swing points for the EV/LA scatter + spray fan
    scatter = [{"ev": h["ev"], "la": h.get("la"), "ctx": h.get("ctx")}
               for h in hits if h.get("ev") is not None][:150]
    spray = [{"dir": h["dir"], "dist": h["dist"], "ev": h.get("ev"), "ctx": h.get("ctx")}
             for h in hits if h.get("dir") is not None and h.get("dist")][:150]
    top_bbe = sorted([h for h in hits if h.get("ev") is not None],
                     key=lambda h: -h["ev"])[:5]
    top_bbe = [{"ev": h["ev"], "la": h.get("la"), "dist": h.get("dist"),
                "res": (h.get("res") if h.get("res") not in ("Undefined", "") else None)
                       or ("BP" if h.get("ctx") == "bp" else None),
                "ctx": h.get("ctx")} for h in top_bbe]

    pitching = None
    if pitches:
        BALLS = ("BallCalled", "BallinDirt", "BallIntentional", "HitByPitch")
        SWINGS = ("StrikeSwinging", "FoulBall", "FoulBallNotFieldable",
                  "FoulBallFieldable", "InPlay")
        by_type = {}
        for x in pitches:
            by_type.setdefault(x.get("type") or "Unknown", []).append(x)
        arsenal = []
        for t, xs in sorted(by_type.items(), key=lambda kv: -len(kv[1])):
            n = len(xs)
            has_calls = any(x.get("call") not in (None, "", "Undefined") for x in xs)
            strikes = sum(1 for x in xs if x.get("call") not in
                          (None, "", "Undefined") + BALLS)
            swings = sum(1 for x in xs if x.get("call") in SWINGS)
            whiffs = sum(1 for x in xs if x.get("call") == "StrikeSwinging")
            csw = sum(1 for x in xs if x.get("call") in ("StrikeCalled", "StrikeSwinging"))
            zone_known = [x for x in xs if x.get("px") is not None and x.get("pz") is not None]
            in_zone = sum(1 for x in zone_known
                          if abs(x["px"]) <= 0.83 and 1.5 <= x["pz"] <= 3.5)
            arsenal.append({
                "type": t, "n": n, "usage": round(n / len(pitches), 3),
                "velo_avg": _avg([x.get("velo") for x in xs]),
                "velo_max": _mx([x.get("velo") for x in xs]),
                "spin_avg": (lambda s: round(s) if s is not None else None)(
                    _avg([x.get("spin") for x in xs])),
                "ivb_avg": _avg([x.get("ivb") for x in xs]),
                "hb_avg": _avg([x.get("hb") for x in xs]),
                "ext_avg": _avg([x.get("ext") for x in xs]),
                "strike_pct": round(strikes / n, 3) if has_calls else None,
                "whiff_pct": round(whiffs / swings, 3) if has_calls and swings else None,
                "csw_pct": round(csw / n, 3) if has_calls else None,
                "zone_pct": round(in_zone / len(zone_known), 3) if zone_known else None,
            })
        # Outing line — PA enders: a K/BB verdict, a play result, or an HBP.
        enders = [x for x in pitches if
                  (x.get("kbb") not in (None, "", "Undefined")) or
                  (x.get("res") not in (None, "", "Undefined")) or
                  x.get("call") == "HitByPitch"]
        ks = sum(1 for x in pitches if x.get("kbb") == "Strikeout")
        bbs = sum(1 for x in pitches if x.get("kbb") == "Walk")
        hits_allowed = sum(1 for x in pitches if x.get("res") in
                           ("Single", "Double", "Triple", "HomeRun"))
        all_strikes = sum(1 for x in pitches if x.get("call") not in
                          (None, "", "Undefined") + BALLS)
        has_any_calls = any(x.get("call") not in (None, "", "Undefined") for x in pitches)
        ordered = sorted(pitches, key=lambda x: (x.get("no") is None, x.get("no") or 0))
        pitching = {
            "pitches": len(pitches), "arsenal": arsenal,
            "throws": next((x.get("throws") for x in pitches if x.get("throws")), None),
            "outing": {
                "bf": len(enders) or None, "k": ks, "bb": bbs, "hits": hits_allowed,
                "strike_pct": round(all_strikes / len(pitches), 3) if has_any_calls else None,
                "velo_max": _mx([x.get("velo") for x in pitches]),
            },
            "movement": [{"ivb": x["ivb"], "hb": x["hb"], "t": x.get("type")}
                         for x in pitches
                         if x.get("ivb") is not None and x.get("hb") is not None][:200],
            "locations": [{"px": x["px"], "pz": x["pz"], "t": x.get("type")}
                          for x in pitches
                          if x.get("px") is not None and x.get("pz") is not None][:200],
            "velo_seq": [{"i": i + 1, "v": x["velo"], "t": x.get("type")}
                         for i, x in enumerate(ordered) if x.get("velo") is not None][:150],
            "release": [{"x": x["rel_s"], "y": x["rel_h"], "t": x.get("type")}
                        for x in pitches
                        if x.get("rel_s") is not None and x.get("rel_h") is not None][:200],
        }

    player = {k: p.get(k) for k in ["name_key", "display_name"] + PLAYER_FIELDS if k in p}
    return {
        "camp": {"name": camp["name"],
                 "date": camp["camp_date"].isoformat() if camp["camp_date"] else None},
        "player": player,
        "blast": blast_summary,
        "hitting": hitting,
        "scatter": scatter,
        "spray": spray,
        "top_bbe": top_bbe,
        "pitching": pitching,
    }
