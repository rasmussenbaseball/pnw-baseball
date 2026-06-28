"""SEO / GEO (AI-answer-engine) support.

A React SPA ships one index.html, so search-engine and AI crawlers that don't run
JS see nothing page-specific. Two pieces fix that:

  1. Sitemaps  — so Google/Bing discover all ~7.6k player + team pages.
  2. /seo/meta — per-entity <title>, meta description, canonical and schema.org
                 JSON-LD that the Vercel edge middleware injects into the shell for
                 EVERY page request (so crawlers and AI answer engines get real,
                 entity-specific, data-rich HTML without running our JS).

GEO notes baked in: descriptions lead with a concrete, data-bearing sentence (AI
engines extract the first 1-2 sentences), and every entity carries JSON-LD so the
ChatGPT/Perplexity/Gemini/AI-Overview crawlers can resolve the entity cleanly.
"""
from fastapi import APIRouter, Query, Response

from ..config import CURRENT_SEASON
from ..models.database import get_connection
from ..cache import cached_endpoint

seo_router = APIRouter(tags=["seo"])

SITE = "https://nwbaseballstats.com"
_LEVEL_LABEL = {"D1": "NCAA Division I", "D2": "NCAA Division II", "D3": "NCAA Division III",
                "NAIA": "NAIA", "JUCO": "NWAC / JUCO"}


def _xml(s):
    s = "" if s is None else str(s)
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;").replace("'", "&apos;"))


def _xml_response(body: str) -> Response:
    return Response(content=body, media_type="application/xml",
                    headers={"Cache-Control": "public, max-age=3600, s-maxage=86400"})


def _urlset(urls):
    """urls: list of (loc, changefreq, priority)."""
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for loc, freq, pri in urls:
        out.append(f"<url><loc>{_xml(loc)}</loc>"
                   f"<changefreq>{freq}</changefreq><priority>{pri}</priority></url>")
    out.append("</urlset>")
    return "\n".join(out)


# ── Sitemaps ──────────────────────────────────────────────────────────────────
@seo_router.get("/seo/sitemap.xml")
@cached_endpoint(ttl_seconds=86400)
def sitemap_index():
    maps = ["sitemap-pages.xml", "sitemap-teams.xml", "sitemap-players.xml"]
    body = ['<?xml version="1.0" encoding="UTF-8"?>',
            '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for m in maps:
        body.append(f"<sitemap><loc>{SITE}/{m}</loc></sitemap>")
    body.append("</sitemapindex>")
    return _xml_response("\n".join(body))


@seo_router.get("/seo/sitemap-pages.xml")
@cached_endpoint(ttl_seconds=86400)
def sitemap_pages():
    pages = [("", "daily", "1.0"), ("teams", "weekly", "0.8"),
             ("leaderboards", "daily", "0.8"), ("recruiting", "weekly", "0.7"),
             ("articles", "daily", "0.7"), ("draft-board", "weekly", "0.6"),
             ("percentiles", "weekly", "0.6"), ("about", "monthly", "0.4")]
    return _xml_response(_urlset([(f"{SITE}/{p}".rstrip("/"), f, pr) for p, f, pr in pages]))


@seo_router.get("/seo/sitemap-teams.xml")
@cached_endpoint(ttl_seconds=86400)
def sitemap_teams():
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM teams WHERE is_active = 1 ORDER BY id")
        ids = [r["id"] for r in cur.fetchall()]
    return _xml_response(_urlset([(f"{SITE}/team/{i}", "weekly", "0.8") for i in ids]))


@seo_router.get("/seo/sitemap-players.xml")
@cached_endpoint(ttl_seconds=86400)
def sitemap_players():
    # Canonical, non-phantom players who have at least one stat line (worth indexing).
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT p.id FROM players p
            WHERE COALESCE(p.is_phantom, false) = false
              AND p.id NOT IN (SELECT linked_id FROM player_links)
              AND (EXISTS (SELECT 1 FROM batting_stats b WHERE b.player_id = p.id)
                OR EXISTS (SELECT 1 FROM pitching_stats s WHERE s.player_id = p.id))
            ORDER BY p.id
        """)
        ids = [r["id"] for r in cur.fetchall()]
    return _xml_response(_urlset([(f"{SITE}/player/{i}", "weekly", "0.6") for i in ids]))


# ── Per-entity meta (consumed by the Vercel edge middleware) ──────────────────
def _player_meta(cur, pid):
    cur.execute("""
        SELECT p.id, p.first_name, p.last_name, p.position, p.bats, p.throws,
               t.short_name AS team, t.school_name, d.level
        FROM players p
        LEFT JOIN teams t ON t.id = p.team_id
        LEFT JOIN conferences c ON t.conference_id = c.id
        LEFT JOIN divisions d ON c.division_id = d.id
        WHERE p.id = %s
    """, (pid,))
    p = cur.fetchone()
    if not p:
        return None
    name = f"{p['first_name'] or ''} {p['last_name'] or ''}".strip() or "Player"
    pos = (p["position"] or "").strip()
    team = p["team"]
    level = _LEVEL_LABEL.get(p["level"], p["level"] or "college")
    # headline line: most recent season, prefer the side with more usage
    cur.execute("""SELECT season, plate_appearances pa, batting_avg avg, on_base_pct obp,
                          slugging_pct slg, home_runs hr, ops FROM batting_stats
                   WHERE player_id = %s ORDER BY season DESC LIMIT 1""", (pid,))
    bat = cur.fetchone()
    cur.execute("""SELECT season, innings_pitched ip, era, k_pct, fip FROM pitching_stats
                   WHERE player_id = %s ORDER BY season DESC LIMIT 1""", (pid,))
    pit = cur.fetchone()
    head = ""
    is_pitcher = pos in ("P", "RHP", "LHP", "SP", "RP")
    if pit and (is_pitcher or not bat):
        era = f"{float(pit['era']):.2f}" if pit["era"] is not None else None
        head = f"{pit['season']} stats: {pit['ip']} IP" + (f", {era} ERA" if era else "")
    elif bat:
        avg = f"{float(bat['avg']):.3f}".lstrip("0") if bat["avg"] is not None else None
        ops = f"{float(bat['ops']):.3f}".lstrip("0") if bat["ops"] is not None else None
        bits = [b for b in [f"{avg} AVG" if avg else None, f"{ops} OPS" if ops else None,
                            f"{bat['hr']} HR" if bat["hr"] is not None else None] if b]
        head = f"{bat['season']} stats: " + ", ".join(bits) if bits else ""

    where = f"{team} ({level})" if team else level
    title = f"{name} — {team + ' ' if team else ''}Baseball Stats & Profile | NW Baseball Stats"
    desc = (f"{name}{f', {pos},' if pos else ''} baseball player for {where}. "
            f"{head + '. ' if head else ''}"
            f"Full career stats, advanced metrics (wOBA, wRC+, FIP, WAR), splits and "
            f"game logs on NW Baseball Stats.").replace("  ", " ").strip()
    jsonld = {
        "@context": "https://schema.org", "@type": "Person", "name": name,
        "url": f"{SITE}/player/{pid}", "jobTitle": "Baseball Player",
    }
    if team:
        jsonld["memberOf"] = {"@type": "SportsTeam", "name": p["school_name"] or team,
                              "sport": "Baseball"}
    if head:
        jsonld["description"] = desc
    return {"title": title, "description": desc[:300], "canonical": f"{SITE}/player/{pid}",
            "jsonld": jsonld, "ok": True}


def _team_meta(cur, tid):
    cur.execute("""
        SELECT t.id, t.short_name, t.school_name, t.city, t.state, t.logo_url,
               c.name AS conf, d.level
        FROM teams t
        LEFT JOIN conferences c ON t.conference_id = c.id
        LEFT JOIN divisions d ON c.division_id = d.id
        WHERE t.id = %s
    """, (tid,))
    t = cur.fetchone()
    if not t:
        return None
    name = t["school_name"] or t["short_name"] or "Team"
    short = t["short_name"] or name
    level = _LEVEL_LABEL.get(t["level"], t["level"] or "college")
    conf = t["conf"]
    loc = ", ".join([x for x in [t["city"], t["state"]] if x])
    title = f"{name} Baseball — Roster, Stats & Schedule | NW Baseball Stats"
    desc = (f"{name} ({short}) {level} baseball" + (f" in the {conf}" if conf else "")
            + (f", {loc}" if loc else "") + ". Team roster, batting and pitching stats, "
            "advanced metrics, schedule, and returning-player projections on NW Baseball Stats.")
    jsonld = {
        "@context": "https://schema.org", "@type": "SportsTeam", "name": name,
        "sport": "Baseball", "url": f"{SITE}/team/{tid}",
    }
    if conf:
        jsonld["memberOf"] = {"@type": "SportsOrganization", "name": conf}
    if loc:
        jsonld["location"] = {"@type": "Place", "address": {
            "@type": "PostalAddress",
            **({"addressLocality": t["city"]} if t["city"] else {}),
            **({"addressRegion": t["state"]} if t["state"] else {})}}
    if t["logo_url"]:
        lg = t["logo_url"]
        jsonld["logo"] = lg if lg.startswith("http") else f"{SITE}{lg if lg.startswith('/') else '/' + lg}"
    return {"title": title, "description": desc[:300], "canonical": f"{SITE}/team/{tid}",
            "jsonld": jsonld, "ok": True}


@seo_router.get("/seo/meta")
@cached_endpoint(ttl_seconds=21600)
def seo_meta(type: str = Query(...), id: int = Query(...)):
    """Per-entity SEO metadata for the edge middleware. Cached 6h."""
    with get_connection() as conn:
        cur = conn.cursor()
        meta = _player_meta(cur, id) if type == "player" else _team_meta(cur, id) if type == "team" else None
    if not meta:
        return {"ok": False}
    return meta
