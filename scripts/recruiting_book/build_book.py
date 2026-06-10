"""
Build the Pacific Northwest College Baseball Program Guide (PDF book).

Front matter (cover + about + page-numbered TOC w/ PDF bookmarks), then five
level chapters (D1, D2, D3, NAIA, NWAC) each opening with a primer. Inside a
chapter, every program gets THREE pages:

  Page 1 — Snapshot: identity, color-coded stat strip, program intro paragraph,
           2026 season recap, recent-seasons win% bar chart.
  Page 2 — 2026 In Depth: top 5 hitters table, top 5 pitchers table, team
           batting + pitching aggregate lines, conference standings, national
           rankings (when available), roster snapshot.
  Page 3 — Coach & Program: head-coach bio, coaching staff, stadium /
           facilities, academic profile, cost, location, and a recruiting
           contact box.

Data: scripts/recruiting_book/book_data.json (from gather_book_data.py).
Output: scripts/recruiting_book/PNW_College_Baseball_Guide_2026.pdf
Run:    python3 scripts/recruiting_book/build_book.py
"""
import json
import re
import subprocess
from pathlib import Path

from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate, CondPageBreak, Frame, HRFlowable, Image, KeepTogether,
    PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle,
)
from reportlab.platypus.flowables import Flowable
from reportlab.platypus.tableofcontents import TableOfContents as _ReportlabTOC

HERE = Path(__file__).resolve().parent
_RAW = json.loads((HERE / "book_data.json").read_text())
# Tolerate both new ({teams,level_norms}) and old (list of teams) formats.
if isinstance(_RAW, dict) and "teams" in _RAW:
    DATA = _RAW["teams"]
    LEVEL_NORMS_DATA = _RAW.get("level_norms") or {}
else:
    DATA = _RAW
    LEVEL_NORMS_DATA = {}
CITY_INFO_PATH = HERE / "city_info.json"
CITY_INFO = json.loads(CITY_INFO_PATH.read_text()) if CITY_INFO_PATH.exists() else {}

# Per-team data overrides for known source-data issues we haven't yet fixed
# at the source. Keyed by team_id, applied to the profile at render time.
PROFILE_OVERRIDES = {
    # Bushnell University (Eugene, OR). The recruiting_programs.json has
    # campusSetting "Suburban (Springfield)" — Bushnell is in Eugene proper
    # with an urban campus.
    24: {"campusSetting": "Urban"},
    # Lewis & Clark College renamed their athletic teams from "Pioneers" to
    # "River Otters". The recruiting_programs.json still has the old name in
    # teamName. The mascot field on the team row is already correct.
    15: {"teamName": "Lewis & Clark River Otters"},
}


def _apply_profile_overrides(teams):
    for t in teams:
        ov = PROFILE_OVERRIDES.get(t["team_id"])
        if ov:
            t["profile"] = {**t["profile"], **ov}
    return teams


DATA = _apply_profile_overrides(DATA)
LOGO_CACHE = HERE / "logo_cache"
LOGO_CACHE.mkdir(exist_ok=True)
OUT = HERE / "PNW_College_Baseball_Guide_2026.pdf"

# ── Palette ─────────────────────────────────────────────────────────────────
INK = colors.HexColor("#1a1a1a")
MUTED = colors.HexColor("#5f5f5f")
LIGHT = colors.HexColor("#8a8a8a")
PAPER = colors.HexColor("#faf7f1")
HAIRLINE = colors.HexColor("#d9d2c2")
PANEL = colors.HexColor("#f1ece0")
PANEL_SOFT = colors.HexColor("#f6f1e5")

LEVELS = [
    {"key": "D1",   "title": "Division I",   "subtitle": "NCAA Division I",                                       "color": colors.HexColor("#14365c")},
    {"key": "D2",   "title": "Division II",  "subtitle": "NCAA Division II",                                      "color": colors.HexColor("#0d7d7d")},
    {"key": "D3",   "title": "Division III", "subtitle": "NCAA Division III",                                     "color": colors.HexColor("#2f7d4f")},
    {"key": "NAIA", "title": "NAIA",         "subtitle": "National Association of Intercollegiate Athletics",     "color": colors.HexColor("#b07d12")},
    {"key": "NWAC", "title": "NWAC",         "subtitle": "Northwest Athletic Conference (Junior College)",        "color": colors.HexColor("#9c1f2e")},
]
LEVEL_COLOR = {lv["key"]: lv["color"] for lv in LEVELS}


# ── 2026 Postseason results ─────────────────────────────────────────────────
# Hand-curated from the 2026 results. Keyed by team_id. Each entry has a
# short headline that appears as an accent-colored callout on the team's
# snapshot page, plus a sentence the season recap weaves into the prose.
POSTSEASON_2026 = {
    2:    {"headline": "NCAA SUPER REGIONAL  ·  Eliminated",
           "sentence": "Oregon advanced to a 2026 NCAA Super Regional before being eliminated, their second straight deep postseason run."},
    3:    {"headline": "NCAA REGIONAL",
           "sentence": "Oregon State played their way into a 2026 NCAA Regional, continuing a streak of nationally relevant seasons that few D1 programs in the country can match."},
    4:    {"headline": "NCAA REGIONAL",
           "sentence": "Washington State earned a 2026 NCAA Regional bid out of the Mountain West, a real signal of where the program is headed."},
    22:   {"headline": "NAIA WORLD SERIES",
           "sentence": "Lewis-Clark State advanced to the 2026 NAIA World Series, the latest in a long run of national-stage appearances for one of the country's elite NAIA programs."},
    5720: {"headline": "NAIA REGIONAL",
           "sentence": "UBC reached an NAIA regional in 2026, a breakthrough season for a program that has been on a clear upward trajectory."},
    13:   {"headline": "NCAA D3 NATIONAL TOURNAMENT  ·  Opening Round",
           "sentence": "Whitworth qualified for the 2026 NCAA D3 national tournament opening round, continuing the program's run of national-stage appearances."},
    9:    {"headline": "NCAA D2 SUPER REGIONAL",
           "sentence": "Northwest Nazarene won the GNAC and pushed all the way to a 2026 NCAA D2 Super Regional, the deepest postseason run the program has put together."},
    52:   {"headline": "NWAC CHAMPIONS",
           "sentence": "Lower Columbia won the 2026 NWAC championship, capping a season that established them as the league's standard-bearer."},
    43:   {"headline": "NWAC RUNNER-UP",
           "sentence": "Lane finished second at the 2026 NWAC tournament, their second straight deep postseason run."},
}

# ── Level primers ───────────────────────────────────────────────────────────
PRIMERS = {
    "D1": (
        "Division I is the highest level of college baseball and the one with the brightest "
        "spotlight. Programs operate on large budgets, recruit nationally, and send players into "
        "the MLB Draft every June. The scholarship landscape just changed in a major way. Under "
        "the House v. NCAA settlement that took effect for the 2025-26 academic year, D1 baseball "
        "moved to a 34-player roster cap, and every player on that roster is now eligible to be on "
        "a full athletic scholarship. The old 11.7 equivalency cap is gone. In practice, programs "
        "are choosing how to divide a much larger pool of money across a smaller roster, and "
        "evaluation has gotten sharper: fewer spots, but the spots are more valuable."
        "<br/><br/>"
        "The Pacific Northwest fields seven D1 programs across three states. Oregon and Oregon State "
        "have been the regional heavyweights for the better part of three years now. The Beavers "
        "have stayed at or near the top of the national polls and put together back-to-back deep "
        "postseason runs, and Oregon followed them up with a 2026 super regional appearance and a "
        "Big Ten title in their first full season in the conference. Gonzaga has quietly been the "
        "most consistent of the smaller D1 programs in the region, putting together winning seasons "
        "season after season under Mark Machtolf and showing up in the WCC race almost every year. "
        "Washington, on the other hand, has been the harder watch: the Huskies have had a tough "
        "stretch by program standards, including a sub-.500 finish in 2026, and the new staff is "
        "in the middle of a rebuild. Washington State made an NCAA regional out of the Mountain West, "
        "a real step forward for a program that's been rebuilding for a few years. Portland, Seattle "
        "U, and the rest sit in the next tier and are programs to watch for the right kind of "
        "recruit: players who want a real D1 stage but can carve out a starting role early."
        "<br/><br/>"
        "Geographically, the region's D1 programs are spread across three states and several "
        "conferences (Big Ten, West Coast, Pac-12, Mountain West, WCC), which means heavy "
        "early-season travel and a stretch of February and March games played on the road or at "
        "neutral, warm-weather sites before the Northwest thaws. For a recruit, D1 in the Northwest "
        "means the most resources and the toughest competition for a spot, at schools that range "
        "from massive public universities to selective private ones."
    ),
    "D2": (
        "Division II sits one step below D1 in scholarship money but is often a sweet spot for "
        "talented players who want to compete and develop without the all-consuming demands of the "
        "top level. A D2 program funds the equivalent of nine full scholarships, and rosters tend "
        "to be built more regionally, with a strong base of Pacific Northwest and West Coast "
        "talent. The level prizes player development: many D2 standouts arrive as projects and "
        "leave as draftable or transfer-up prospects."
        "<br/><br/>"
        "The Great Northwest Athletic Conference (GNAC) is the home for D2 baseball in this region, "
        "a compact, travel-friendly league where the schools know each other very well. Northwest "
        "Nazarene has been the program to beat for the last few seasons. The Nighthawks broke "
        "through in 2026 by winning the GNAC and advancing to a D2 super regional, the deepest "
        "postseason run the league has produced in some time. Western Oregon and Central Washington "
        "have been the steady challengers, and Central in particular saw a coaching change in 2026 "
        "after seven hundred career wins from longtime head coach Desi Storey, which means a new "
        "era for the program. Saint Martin's has spent the last few years climbing toward the middle "
        "of the league, and Montana State Billings remains the geographic outlier that travels the "
        "most and recruits hard out of the mountain west."
        "<br/><br/>"
        "Because the GNAC is so compact, weekend series matter enormously. A team can swing its "
        "season on one road set in late April. The conference tournament champion gets the "
        "league's automatic bid to D2 regionals, and the at-large path is narrow for the region "
        "because the GNAC plays a heavy intra-conference schedule. For a recruit, D2 offers real "
        "athletic money, a genuine shot at early playing time, and a balance between high-level "
        "baseball and a manageable academic and competitive load. A standout junior or senior at "
        "this level is firmly on the radar of MLB scouts and four-year transfer destinations alike."
    ),
    "D3": (
        "Division III baseball is defined by one rule above all others: there are no athletic "
        "scholarships. Players are recruited, but they pay their way through need-based and "
        "merit-based academic aid like any other student, which makes fit, major, and the "
        "financial package the center of every decision. That changes the math of recruiting "
        "entirely. D3 players choose a school for the education first and the chance to keep "
        "playing second."
        "<br/><br/>"
        "In the Northwest, the Northwest Conference (NWC) is the D3 home, a tight cluster of "
        "academically respected liberal arts colleges across Oregon and Washington. Whitworth ran "
        "away with the NWC regular season in 2026, finished inside the national top 10 of the "
        "composite rating index, and earned an NCAA D3 national tournament opening-round bid. "
        "Linfield and Puget Sound both landed in the next tier of the league standings and showed "
        "up in the regional rating systems, with Linfield in particular a perennial regional "
        "contender. Lewis and Clark tied with Puget Sound at 14-10 in league play and continues to "
        "climb. Pacific and George Fox sit in the middle of the league, with Pacific Lutheran a "
        "touch behind. Whitman and Willamette typically anchor the bottom half."
        "<br/><br/>"
        "Seasons are a touch shorter and budgets smaller than at the NCAA scholarship levels, but "
        "the baseball is genuinely competitive: Northwest Conference teams routinely beat D2 and "
        "NAIA programs in non-conference play, and the league has produced multiple draft picks "
        "and pro signings over the last few cycles. For the right recruit, D3 is the level where "
        "academics and baseball are weighted most evenly, and the experience is built around being "
        "a student-athlete in the truest sense. A strong student who can play at the D2 level often "
        "finds a better total package, financially and academically, at a top D3 program."
    ),
    "NAIA": (
        "The NAIA is college baseball's most flexible level. Programs can offer up to 12 "
        "scholarship equivalencies, more than D2 (9.0) and D3 (none), and they operate under "
        "eligibility and transfer rules that are far friendlier to junior-college transfers, late "
        "bloomers, and players taking a non-traditional path. Most NAIA schools are smaller "
        "private institutions, often faith-based, and the rosters reflect a mix of recruited "
        "high-schoolers and JUCO and four-year transfers looking for a bigger role."
        "<br/><br/>"
        "In the Pacific Northwest, the Cascade Collegiate Conference (CCC) anchors NAIA baseball "
        "across Oregon, Idaho, and British Columbia. Lewis-Clark State is the league's heavyweight "
        "and one of the elite programs in all of NAIA baseball: the Warriors won the CCC again in "
        "2026, sat at No. 1 in the country in the composite rating index, and advanced to the NAIA "
        "World Series. They produce MLB Draft picks at a rate that rivals many D1 programs and are "
        "a true national-title contender every year. British Columbia has emerged as the league's "
        "most exciting up-and-coming program, finished tied with LCSC at 30-7 in conference play, "
        "and made an NAIA regional in 2026 behind a deep, transfer-built roster. College of Idaho "
        "and Bushnell sit in the next tier and are routinely capable of beating anyone on a given "
        "weekend. Oregon Tech is the steady middle-of-the-pack program in the league and has "
        "fielded competitive teams year after year. Warner Pacific, Corban, and Eastern Oregon "
        "rounded out the bottom half of the 2026 standings, with each program in some stage of a "
        "rebuild."
        "<br/><br/>"
        "For a recruit, the NAIA can mean meaningful scholarship money, a quicker path to the "
        "field, and a landing spot that rewards players the NCAA pipeline overlooked. It is also "
        "the level most welcoming to JUCO transfers looking for the next stage. The NAIA World "
        "Series is a real stage, and a strong run there gets noticed by scouts."
    ),
    "NWAC": (
        "The NWAC is the Northwest's junior-college level, built on a develop-and-transfer model. "
        "These are two-year community colleges, and athletic aid is allowed but capped: under "
        "conference rules a program can offer up to 65 percent of in-state tuition, so even at "
        "maximum it stops well short of a full ride. Combined with low community-college tuition "
        "and open enrollment, the cost of attendance can still come in lower than four-year "
        "options for the right player."
        "<br/><br/>"
        "The league spans Washington, Oregon, Idaho, and British Columbia across four geographic "
        "conferences (North, South, East, West), and the baseball is more competitive than "
        "outsiders expect, with rosters full of players chasing the same upward move. Lower "
        "Columbia won the 2026 NWAC championship and has been the league's strongest brand for "
        "the past several seasons, producing draft picks and four-year transfers at a steady rate. "
        "Lane finished second in 2026 and has put together back-to-back deep runs at the NWAC "
        "tournament. Linn-Benton and Lower Columbia have traded the South Division title for "
        "several years running. In the North, Edmonds and Bellevue are the historical heavyweights, "
        "and Edmonds in particular has been hard to beat at home over the last few seasons. The "
        "East has been led by Spokane and Yakima Valley, both of which sent multiple players up to "
        "four-year programs after 2026. The West has been an Edmonds and Lower Columbia tug-of-war "
        "for a long time."
        "<br/><br/>"
        "For many players, an NWAC program is a launchpad: two years to add velocity, fill out "
        "physically, raise a recruiting profile, and earn credits before transferring to a "
        "four-year program at any level. The NWAC pumps players into NCAA D1, D2, D3, and NAIA "
        "programs every offseason. For a recruit who needs time, reps, or a second look after high "
        "school, the NWAC is the region's proving ground."
    ),
}

styles = getSampleStyleSheet()


def S(name, **kw):
    return ParagraphStyle(name, parent=styles["Normal"], **kw)


# ── Styles ──────────────────────────────────────────────────────────────────
BODY = S("body", fontName="Helvetica", fontSize=10.5, leading=15.5, textColor=INK,
         alignment=TA_JUSTIFY, spaceAfter=8)
LEAD = S("lead", fontName="Helvetica", fontSize=11, leading=16.5, textColor=INK,
         alignment=TA_JUSTIFY, spaceAfter=9)
SMALLBODY = S("smbody", fontName="Helvetica", fontSize=9.5, leading=13.5, textColor=INK,
              alignment=TA_JUSTIFY, spaceAfter=6)
BIO = S("bio", fontName="Helvetica", fontSize=9.5, leading=13.5, textColor=INK,
        alignment=TA_JUSTIFY, spaceAfter=7)
SECTION = S("section", fontName="Helvetica-Bold", fontSize=8.5, leading=12,
            textColor=MUTED, spaceBefore=10, spaceAfter=3, tracking=1)
SECTION_BIG = S("sectionbig", fontName="Helvetica-Bold", fontSize=10, leading=14,
                textColor=MUTED, spaceBefore=12, spaceAfter=4, tracking=1)
TEAMNAME = S("teamname", fontName="Helvetica-Bold", fontSize=20, leading=22, textColor=INK)
TEAMNAME_SM = S("teamname_sm", fontName="Helvetica-Bold", fontSize=14, leading=17, textColor=INK)
TEAMSUB = S("teamsub", fontName="Helvetica", fontSize=10.5, leading=14, textColor=MUTED)
PAGEHEAD_SUB = S("pgsub", fontName="Helvetica-Bold", fontSize=9, leading=12, textColor=MUTED, tracking=1.5)
FACTLBL = S("factlbl", fontName="Helvetica-Bold", fontSize=8, leading=11, textColor=LIGHT)
FACTVAL = S("factval", fontName="Helvetica", fontSize=9.5, leading=12.5, textColor=INK)
TILE_LBL = S("tilelbl", fontName="Helvetica-Bold", fontSize=7, leading=9,
             textColor=colors.white, alignment=TA_CENTER)
TILE_VAL = S("tileval", fontName="Helvetica-Bold", fontSize=14, leading=16,
             textColor=INK, alignment=TA_CENTER)
TABLE_HEAD = S("th", fontName="Helvetica-Bold", fontSize=7.5, leading=10,
               textColor=colors.white, alignment=TA_CENTER)
TABLE_CELL = S("tc", fontName="Helvetica", fontSize=9, leading=11.5, textColor=INK,
               alignment=TA_CENTER)
TABLE_CELL_L = S("tcl", fontName="Helvetica", fontSize=9, leading=11.5, textColor=INK,
                 alignment=TA_LEFT)
TABLE_NAME = S("tcname", fontName="Helvetica-Bold", fontSize=9, leading=11.5, textColor=INK,
               alignment=TA_LEFT)
RECRUIT_LBL = S("rl", fontName="Helvetica-Bold", fontSize=8, leading=11,
                textColor=colors.white, tracking=1.5)
RECRUIT_VAL = S("rv", fontName="Helvetica", fontSize=11, leading=14, textColor=colors.white)
CALLOUT = S("co", fontName="Helvetica-Bold", fontSize=10, leading=13, textColor=INK,
            alignment=TA_CENTER)


# ── Helpers ─────────────────────────────────────────────────────────────────
def g(profile, key, default=""):
    v = profile.get(key)
    return "" if v is None else (str(v).strip() or default)


def esc(s):
    """Escape ampersands and angle brackets so a string can be safely passed
    into a reportlab Paragraph without triggering its mini-XML parser. Team
    names like 'L&C' (Lewis & Clark) were rendering as 'L&C;' because the
    parser was trying to read '&C;' as an entity."""
    if s is None:
        return ""
    s = str(s)
    # Don't touch already-escaped entities we intentionally use (<b>, <br/>, etc.).
    # Only escape bare ampersands not followed by '#' or letters+semicolon.
    s = re.sub(r"&(?![A-Za-z#][A-Za-z0-9]*;)", "&amp;", s)
    return s


def fmt_count(v):
    """Render a number with thousands commas if it parses cleanly."""
    if v is None:
        return ""
    s = str(v).strip()
    if not s:
        return ""
    try:
        n = int(re.sub(r"\D", "", s))
        return f"{n:,}"
    except Exception:
        return s


def is_tbd(s):
    return s and re.search(r"\btbd\b|new coach", s, re.I) is not None


# A real career W-L mark is something like "243-119" or "243-119-2", optionally
# preceded by "wins:" or trailing parenthetical notes. We reject anything that
# starts with a year ("2025: 22-20") or that is just prose without a clean W-L
# token at the front, so the source data's messy single-season entries don't
# render as a coach's career record.
_CAREER_RECORD_RE = re.compile(r"^\s*\d{1,4}\s*[-–]\s*\d{1,4}(\s*[-–]\s*\d{1,3})?\b")

def valid_career_record(s):
    if not s:
        return False
    s = str(s).strip()
    if not s:
        return False
    # Reject "YYYY:" or "YYYY -" style season-record strings.
    if re.match(r"^\s*(19|20)\d{2}\s*[:\-]", s):
        return False
    return bool(_CAREER_RECORD_RE.match(s))


def scholarship_line(team):
    """Return the current scholarship rule for this level, overriding any
    stale value from the spreadsheet. The post-House v. NCAA changes hit D1
    baseball in 2025-26 and effectively retired the 11.7 equivalency cap."""
    div = team["division"]
    raw = g(team["profile"], "scholarshipInfo")
    if div == "D1":
        return "Up to 34 (roster cap, full scholarships allowed)"
    if div == "D2":
        return raw or "Up to 9.0 scholarship equivalencies"
    if div == "D3":
        return "No athletic scholarships (academic and need-based aid only)"
    if div == "NAIA":
        return raw or "Up to 12 scholarship equivalencies"
    if div == "NWAC":
        # NWAC does offer athletic aid, but it is capped at 65% of in-state
        # tuition per the conference's rules — well short of a full ride and
        # not the "no scholarships" that used to be the JUCO assumption.
        return "Athletic aid available, capped at 65% of in-state tuition (NWAC rule)"
    return raw


def logo_png(team):
    f = team.get("logo_file")
    if not f:
        return None
    p = Path(f)
    if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".gif"):
        return str(p)
    if p.suffix.lower() == ".svg":
        out = LOGO_CACHE / (p.stem + ".png")
        if not out.exists():
            try:
                subprocess.run(["qlmanage", "-t", "-s", "600", "-o", str(LOGO_CACHE), str(p)],
                               capture_output=True, timeout=30)
                produced = LOGO_CACHE / (p.name + ".png")
                if produced.exists():
                    produced.rename(out)
            except Exception:
                return None
        return str(out) if out.exists() else None
    return None


def _content_bbox(im):
    """Find the bbox of the visible content. Many rasterized SVGs leave
    large blank borders inside a 600x600 canvas, which makes different
    programs' marks render at very different visible sizes. We composite onto
    white and treat near-white as background to find the real content area."""
    rgba = im.convert("RGBA")
    bg = PILImage.new("RGBA", rgba.size, (255, 255, 255, 255))
    flat = PILImage.alpha_composite(bg, rgba).convert("RGB")
    px = flat.load()
    w, h = flat.size
    L, T, R, B = w, h, 0, 0
    found = False
    for y in range(0, h, 2):  # subsample for speed
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            if r < 245 or g < 245 or b < 245:
                if x < L:
                    L = x
                if x > R:
                    R = x
                if y < T:
                    T = y
                if y > B:
                    B = y
                found = True
    if not found:
        return (0, 0, w, h)
    pad = 4
    return (max(0, L - pad), max(0, T - pad), min(w, R + pad), min(h, B + pad))


_CROP_CACHE = {}

def _cropped_logo(path):
    """Return a path to a square-padded crop of the logo's visible content.
    Cached on disk so the first build pays the cost once per logo."""
    if path in _CROP_CACHE:
        return _CROP_CACHE[path]
    src = Path(path)
    cache_path = LOGO_CACHE / ("_crop_" + src.name)
    if not cache_path.exists():
        try:
            im = PILImage.open(path)
            bbox = _content_bbox(im)
            cropped = im.convert("RGBA").crop(bbox)
            side = max(cropped.size)
            sq = PILImage.new("RGBA", (side, side), (255, 255, 255, 0))
            sq.paste(cropped, ((side - cropped.size[0]) // 2,
                                (side - cropped.size[1]) // 2), cropped)
            sq.save(cache_path, "PNG")
        except Exception:
            cache_path = src
    _CROP_CACHE[path] = str(cache_path)
    return str(cache_path)


def logo_flowable(team, box_size=1.35 * inch):
    """Render the logo centered inside a fixed-size square box so that every
    program's mark takes up the same visible footprint on the page regardless
    of how much blank canvas the source SVG ships with. We auto-crop the
    rasterized PNG to just the visible content first."""
    path = logo_png(team)
    inner = None
    if path:
        path = _cropped_logo(path)
        try:
            iw, ih = PILImage.open(path).size
            target = box_size * 0.96
            scale = min(target / iw, target / ih)
            inner = Image(path, width=iw * scale, height=ih * scale)
        except Exception:
            inner = None
    if inner is None:
        inner = Spacer(box_size, box_size)
    # Wrap in a one-cell table to enforce a uniform centered footprint.
    t = Table([[inner]], colWidths=[box_size], rowHeights=[box_size])
    t.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return t


def fmt_avg(v):
    try:
        s = "%.3f" % float(v)
        return s.lstrip("0") if s.startswith("0") else s
    except Exception:
        return "—"


def fmt_rate(v, places=2):
    try:
        return ("%." + str(places) + "f") % float(v)
    except Exception:
        return "—"


def fmt_int(v):
    try:
        return str(int(v))
    except Exception:
        return "—"


def fmt_ip(v):
    """Innings pitched in baseball notation (already stored that way)."""
    try:
        return "%.1f" % float(v)
    except Exception:
        return "—"


def rec_str(s):
    if not s:
        return "—"
    w, l, t = s.get("wins") or 0, s.get("losses") or 0, s.get("ties") or 0
    return f"{w}-{l}-{t}" if t else f"{w}-{l}"


def ordinal(n):
    if n is None:
        return ""
    n = int(n)
    if 10 <= n % 100 <= 20:
        suf = "th"
    else:
        suf = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suf}"


def clean_bio(bio, max_len=2400):
    """Tidy and lightly trim a coach bio for reading on the page.

    The source data is messy: some bios run thousands of characters, some
    have ALL-CAPS section headers ("POSTSEASON:", "1582 POSTSEASON:") mashed
    against the prior sentence with no separating whitespace, and some open
    with a redundant 'AT [SCHOOL]:' header. We:
      1) collapse whitespace,
      2) split words that mash a number into ALL-CAPS,
      3) insert a space before ALL-CAPS headers stuck to the end of a sentence,
      4) drop a leading 'AT SCHOOL NAME:' tag,
      5) keep up to max_len characters, ending on the last sentence break.
    """
    if not bio:
        return ""
    s = re.sub(r"\s+", " ", bio).strip()
    # Heal "1582POSTSEASON" / "33POSTSEASON" patterns: digit-glued-to-uppercase.
    s = re.sub(r"(\d)([A-Z]{2,})", r"\1 \2", s)
    # Heal "Indians.1582POSTSEASON" pattern: period-glued-to-uppercase header.
    s = re.sub(r"\.\s*([A-Z]{4,}):", r". \1:", s)
    # Add a space before ALL-CAPS headers when fused to the previous word.
    s = re.sub(r"([a-z])([A-Z]{3,})", r"\1. \2", s)
    # Drop a leading 'AT SCHOOL NAME:' style header some bios start with.
    s = re.sub(r"^[A-Z][A-Z\s.,'&-]{2,40}:\s*", "", s)
    if len(s) <= max_len:
        return s
    cut = s[:max_len]
    for marker in (". ", "! ", "? "):
        idx = cut.rfind(marker)
        if idx > max_len * 0.6:
            return cut[: idx + 1].strip()
    return cut.rstrip() + "…"


# ── Win% bar graphic ────────────────────────────────────────────────────────
class WinBars(Flowable):
    def __init__(self, seasons, accent, width=6.9 * inch, height=1.5 * inch, cap=6):
        super().__init__()
        rows = [s for s in seasons if (s.get("wins") or 0) + (s.get("losses") or 0) > 0]
        rows = sorted(rows, key=lambda s: s["season"])[-cap:]
        self.rows = rows
        self.accent = accent
        self.width = width
        self.height = height

    def wrap(self, *a):
        return (self.width, self.height if self.rows else 0)

    def draw(self):
        if not self.rows:
            return
        c = self.canv
        n = len(self.rows)
        chart_h = self.height - 34
        slot = self.width / n
        bw = min(slot * 0.5, 52)
        baseline = 18
        c.setStrokeColor(HAIRLINE)
        c.setLineWidth(0.5)
        c.line(0, baseline, self.width, baseline)
        for i, s in enumerate(self.rows):
            w, l = s.get("wins") or 0, s.get("losses") or 0
            tot = w + l
            pct = w / tot if tot else 0
            x = i * slot + (slot - bw) / 2
            h = max(2, pct * chart_h)
            c.setFillColor(self.accent)
            c.roundRect(x, baseline, bw, h, 2, fill=1, stroke=0)
            c.setFillColor(INK)
            c.setFont("Helvetica-Bold", 8)
            c.drawCentredString(x + bw / 2, baseline + h + 4, f"{pct*100:.0f}%")
            c.setFillColor(MUTED)
            c.setFont("Helvetica", 7.5)
            c.drawCentredString(x + bw / 2, baseline - 11, f"{w}-{l}")
            c.setFillColor(LIGHT)
            c.setFont("Helvetica", 7)
            c.drawCentredString(x + bw / 2, baseline - 20, str(s["season"]))


# ── Roster, freshman, hometowns, and WAR graphics ───────────────────────────
class RosterClassBar(Flowable):
    """Horizontal stacked bar showing the share of the roster (and the share
    of plate appearances) by class year. Two stacks: roster headcount on top,
    plate appearances on bottom, so a reader can see at a glance whether a
    program runs older or younger players."""

    LABEL_ORDER = ["Fr", "R-Fr", "So", "R-So", "Jr", "Sr", "—"]
    COLORS = {
        "Fr":    colors.HexColor("#7fb3d5"),
        "R-Fr":  colors.HexColor("#6fa1bf"),
        "So":    colors.HexColor("#5fb275"),
        "R-So":  colors.HexColor("#4f9f63"),
        "Jr":    colors.HexColor("#f0b657"),
        "Sr":    colors.HexColor("#c97a48"),
        "—":     colors.HexColor("#b8b8b8"),
    }

    # The container panel applies 8px of horizontal padding plus a 0.5pt
    # border. We render slightly narrower than 6.9in so bars stay inside
    # those edges and never touch or overflow the panel rule.
    def __init__(self, classes, width=6.6 * inch, height=1.4 * inch):
        super().__init__()
        self.classes = classes
        self.width = width
        self.height = height

    def wrap(self, *a):
        return (self.width, self.height)

    def _stack(self, c, y, counts, total, label):
        bar_left = 0.65 * inch
        bar_right = self.width - 4   # small right inset so the bar stops short of the panel rule
        bar_w = bar_right - bar_left
        bar_h = 22
        # Background
        c.setFillColor(PANEL_SOFT)
        c.rect(bar_left, y, bar_w, bar_h, stroke=0, fill=1)
        # Stack segments in fixed order so colors stay consistent.
        x = bar_left
        for key in self.LABEL_ORDER:
            v = counts.get(key, 0)
            if total <= 0 or v <= 0:
                continue
            w = bar_w * (v / total)
            c.setFillColor(self.COLORS.get(key, colors.grey))
            c.rect(x, y, w, bar_h, stroke=0, fill=1)
            # Inline percent label if big enough.
            pct = v / total
            if pct >= 0.10:
                c.setFillColor(colors.white)
                c.setFont("Helvetica-Bold", 8)
                c.drawCentredString(x + w / 2, y + 7, f"{key} {pct*100:.0f}%")
            x += w
        # Row label.
        c.setFillColor(MUTED)
        c.setFont("Helvetica-Bold", 8)
        c.drawRightString(bar_left - 6, y + 7, label)

    def draw(self):
        c = self.canv
        cc = self.classes or {}
        counts = cc.get("by_class_count") or {}
        total_roster = sum(counts.values())
        pa_counts = cc.get("by_class_pa") or {}
        total_pa = sum(pa_counts.values())
        # Top bar = roster, bottom bar = plate appearances.
        self._stack(c, 50, counts, total_roster, "ROSTER")
        self._stack(c, 18, pa_counts, total_pa, "PA SHARE")
        # Legend at bottom.
        c.setFillColor(LIGHT)
        c.setFont("Helvetica", 7)
        c.drawString(0, 4, "Fr (and R-Fr): freshmen.  So: sophomores.  Jr: juniors.  Sr: seniors.  —: class not listed.")


class StateBars(Flowable):
    """Compact horizontal bar chart of player hometowns by state/province."""

    def __init__(self, breakdown, accent, width=6.6 * inch, top_n=6):
        super().__init__()
        rows = list((breakdown or {}).get("by_state") or [])[:top_n]
        self.rows = rows
        self.accent = accent
        self.width = width
        # Compute height from row count.
        self.height = max(0.4 * inch, 16 + 18 * len(rows))

    def wrap(self, *a):
        return (self.width, self.height)

    def draw(self):
        if not self.rows:
            return
        c = self.canv
        max_v = max(v for _, v in self.rows) or 1
        label_w = 0.45 * inch
        bar_left = label_w + 6
        bar_right = self.width - 0.45 * inch
        bar_w = bar_right - bar_left
        for i, (st, v) in enumerate(self.rows):
            y = self.height - 18 - i * 18
            c.setFillColor(INK)
            c.setFont("Helvetica-Bold", 9)
            c.drawString(0, y + 3, st)
            w = bar_w * (v / max_v)
            c.setFillColor(self.accent)
            c.roundRect(bar_left, y, w, 12, 2, stroke=0, fill=1)
            c.setFillColor(INK)
            c.setFont("Helvetica", 9)
            c.drawString(bar_left + w + 6, y + 3, str(v))


class WARSeasonBars(Flowable):
    """Side-by-side bars of team WAR by season: hitting WAR in the accent
    color and pitching WAR in a lighter shade. Negative WAR draws below a
    drawn zero line. A legend strip sits in a reserved top band so it never
    overlaps the bars."""

    def __init__(self, war_seasons, accent, width=6.6 * inch, height=1.9 * inch):
        super().__init__()
        rows = [r for r in (war_seasons or []) if isinstance(r, dict)]
        self.rows = rows[-6:]
        self.accent = accent
        self.width = width
        self.height = height

    def wrap(self, *a):
        return (self.width, self.height if self.rows else 0)

    def draw(self):
        if not self.rows:
            return
        c = self.canv
        n = len(self.rows)
        # Reserved bands so labels never collide with bars.
        legend_band = 14   # top, reserved for the legend
        season_band = 14   # bottom, reserved for season labels
        chart_top = self.height - legend_band
        chart_bot = season_band
        chart_h = chart_top - chart_bot

        # Legend strip at top.
        sw_y = self.height - 11
        c.setFillColor(self.accent)
        c.rect(0, sw_y, 9, 8, stroke=0, fill=1)
        c.setFillColor(INK)
        c.setFont("Helvetica", 8)
        c.drawString(13, sw_y + 1, "Hitting WAR")
        c.setFillColor(colors.HexColor("#9bb8d4"))
        c.rect(self.width / 2, sw_y, 9, 8, stroke=0, fill=1)
        c.setFillColor(INK)
        c.drawString(self.width / 2 + 13, sw_y + 1, "Pitching WAR")

        # Compute y range so positive and negative both fit cleanly.
        all_vals = []
        for r in self.rows:
            bv = r.get("bat_war") or 0
            pv = r.get("pit_war") or 0
            all_vals.extend([bv, pv, bv + pv])
        v_max = max([0.5] + [v for v in all_vals if v > 0])
        v_min = min([0.0] + [v for v in all_vals if v < 0])
        v_range = (v_max - v_min) or 1
        zero_y = chart_bot + chart_h * ((0 - v_min) / v_range)

        # Zero baseline.
        c.setStrokeColor(HAIRLINE)
        c.setLineWidth(0.5)
        c.line(0, zero_y, self.width, zero_y)

        def y_for(v):
            return chart_bot + chart_h * ((v - v_min) / v_range)

        slot = self.width / n
        bw = min(slot * 0.42, 44)

        for i, r in enumerate(self.rows):
            x = i * slot + (slot - bw) / 2
            bw_half = bw * 0.48
            bv = r.get("bat_war") or 0
            pv = r.get("pit_war") or 0
            # Hitting bar (left half)
            top = y_for(max(bv, 0))
            bot = y_for(min(bv, 0))
            c.setFillColor(self.accent)
            c.rect(x, bot, bw_half, max(top - bot, 1), stroke=0, fill=1)
            # Pitching bar (right half)
            top = y_for(max(pv, 0))
            bot = y_for(min(pv, 0))
            c.setFillColor(colors.HexColor("#9bb8d4"))
            c.rect(x + bw_half + 2, bot, bw_half, max(top - bot, 1), stroke=0, fill=1)
            # Season label under the baseline.
            c.setFillColor(LIGHT)
            c.setFont("Helvetica", 7.5)
            c.drawCentredString(x + bw / 2, 4, str(r["season"]))
            # Total WAR stamped above the bars (or below if both negative).
            # The bars are side-by-side, not stacked, so the label should sit
            # just above whichever of the two is taller — not above their sum.
            total = bv + pv
            c.setFillColor(INK)
            c.setFont("Helvetica-Bold", 8)
            top_val = max(bv, pv)
            bot_val = min(bv, pv)
            if top_val > 0:
                label_y = min(chart_top - 10, y_for(top_val) + 2)
            else:
                # Both bars at or below zero: stamp the label just below the
                # lower bar instead of stacking it on the zero line.
                label_y = max(chart_bot + 2, y_for(bot_val) - 9)
            c.drawCentredString(x + bw / 2, label_y, f"{total:+.1f}")


def freshman_panel(team):
    """Combined freshman impact panel: share of PA/IP + named standouts.
    Helps a recruit see whether freshmen actually played for this program."""
    rc = team.get("roster_classes") or {}
    th = team.get("top_freshman_hitter")
    tp = team.get("top_freshman_pitcher")
    # Only render if we actually know who the freshmen are (so the "0%" line
    # isn't a data gap masquerading as a meaningful fact).
    if not _has_class_data(rc) and not th and not tp:
        return None
    accent = LEVEL_COLOR[team["division"]]
    pa_share = rc.get("freshman_pa_share") or 0
    ip_share = rc.get("freshman_ip_share") or 0

    summary_bits = [
        f"<b>{pa_share*100:.0f}%</b> of the team's plate appearances came from freshmen "
        f"(Fr + R-Fr), and <b>{ip_share*100:.0f}%</b> of the innings pitched did too."
    ]
    if pa_share >= 0.30 and ip_share >= 0.20:
        summary_bits.append("This is a program that played its young players a lot.")
    elif pa_share <= 0.10 and ip_share <= 0.10:
        summary_bits.append("In 2026 it was mostly an older roster handling the workload.")
    summary = " ".join(summary_bits)

    standouts = []
    if th and th.get("name"):
        bits = []
        if th.get("plate_appearances"):
            bits.append(f"{int(th['plate_appearances'])} PA")
        if th.get("batting_avg") is not None:
            bits.append(f"{fmt_avg(th['batting_avg'])} AVG")
        if th.get("ops") is not None:
            bits.append(f"{fmt_avg(th['ops'])} OPS")
        if th.get("offensive_war") is not None:
            bits.append(f"{float(th['offensive_war']):.2f} WAR")
        standouts.append(
            Paragraph(f"<b>Top freshman bat:</b> {th['name']}  ·  " + ", ".join(bits), SMALLBODY)
        )
    if tp and tp.get("name"):
        bits = []
        if tp.get("innings_pitched") is not None:
            bits.append(f"{fmt_ip(tp['innings_pitched'])} IP")
        if tp.get("era") is not None:
            bits.append(f"{fmt_rate(tp['era'])} ERA")
        if tp.get("strikeouts"):
            bits.append(f"{int(tp['strikeouts'])} K")
        if tp.get("pitching_war") is not None:
            bits.append(f"{float(tp['pitching_war']):.2f} WAR")
        standouts.append(
            Paragraph(f"<b>Top freshman arm:</b> {tp['name']}  ·  " + ", ".join(bits), SMALLBODY)
        )

    rows = [[Paragraph("FRESHMAN IMPACT, 2026", TABLE_HEAD)],
            [Paragraph(summary, SMALLBODY)]]
    for s in standouts:
        rows.append([s])

    t = Table(rows, colWidths=[6.9 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("BACKGROUND", (0, 1), (-1, -1), PANEL_SOFT),
        ("BOX", (0, 0), (-1, -1), 0.5, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def states_panel(team):
    sb = team.get("state_breakdown") or {}
    if not sb.get("by_state"):
        return None
    accent = LEVEL_COLOR[team["division"]]
    rows = [[Paragraph("WHERE THE ROSTER COMES FROM", TABLE_HEAD)]]
    total = sb.get("total_with_hometown", 0)
    states = sb.get("by_state") or []
    n_states = len(states)
    summary = f"Players on the 2026 roster come from <b>{n_states}</b> states / provinces (of {total} with a hometown listed)."
    rows.append([Paragraph(summary, SMALLBODY)])
    rows.append([StateBars(sb, accent)])
    t = Table(rows, colWidths=[6.9 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("BACKGROUND", (0, 1), (-1, -1), PANEL_SOFT),
        ("BOX", (0, 0), (-1, -1), 0.5, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def _has_class_data(rc):
    """True only if at least some roster has a real class-year value listed.
    If every player is in the '—' (unknown) bucket the bar reads as 100% gray
    and we'd rather show nothing than show that."""
    counts = (rc or {}).get("by_class_count") or {}
    known = sum(v for k, v in counts.items() if k and k != "—")
    return known > 0


def roster_classes_panel(team):
    rc = team.get("roster_classes") or {}
    if not _has_class_data(rc):
        return None
    accent = LEVEL_COLOR[team["division"]]
    rows = [[Paragraph("ROSTER COMPOSITION BY CLASS", TABLE_HEAD)],
            [RosterClassBar(rc)]]
    if rc.get("transfer_or_juco_count"):
        rows.append([Paragraph(
            f"<b>{rc['transfer_or_juco_count']}</b> players on the 2026 roster came in from another program "
            f"(JUCO transfers or four-year transfers).", SMALLBODY)])
    t = Table(rows, colWidths=[6.9 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("BACKGROUND", (0, 1), (-1, -1), PANEL_SOFT),
        ("BOX", (0, 0), (-1, -1), 0.5, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


class RosterBuildBars(Flowable):
    """Stacked horizontal bars per recent season showing how a roster is
    built: returners, true freshmen, and transfers. Mirrors the 'Roster
    Composition' chart on the site's recruiting guide."""

    COL_RET = colors.HexColor("#3b6e9c")  # returners (cool)
    COL_FRO = colors.HexColor("#d97a3b")  # freshmen
    COL_TRN = colors.HexColor("#8b5cf6")  # transfers (purple, matches site)

    def __init__(self, comp, width=6.6 * inch, height=1.9 * inch):
        super().__init__()
        self.rows = list(comp or [])[-6:]
        self.width = width
        self.height = height

    def wrap(self, *a):
        return (self.width, self.height if self.rows else 0)

    def draw(self):
        if not self.rows:
            return
        c = self.canv
        # Legend strip on top.
        sw_y = self.height - 11
        for (lbl, col, x_off) in [
            ("Returners", self.COL_RET, 0),
            ("Freshmen",  self.COL_FRO, self.width * 0.32),
            ("Transfers", self.COL_TRN, self.width * 0.64),
        ]:
            c.setFillColor(col)
            c.rect(x_off, sw_y, 9, 8, stroke=0, fill=1)
            c.setFillColor(INK)
            c.setFont("Helvetica", 8)
            c.drawString(x_off + 13, sw_y + 1, lbl)

        label_band = 14
        season_band = 14
        chart_top = self.height - label_band
        chart_bot = season_band
        chart_h = chart_top - chart_bot
        n = len(self.rows)
        slot = self.width / n
        bw = min(slot * 0.55, 60)
        max_total = max((r.get("total") or 0) for r in self.rows) or 1

        for i, r in enumerate(self.rows):
            x = i * slot + (slot - bw) / 2
            total = r.get("total") or 0
            ret = r.get("returners") or 0
            fre = r.get("freshmen") or 0
            tra = r.get("transfers") or 0
            # Bar full height proportional to roster size relative to max.
            bar_total_h = chart_h * (total / max_total) if max_total else 0
            y = chart_bot
            for v, col in [(ret, self.COL_RET), (fre, self.COL_FRO), (tra, self.COL_TRN)]:
                if total <= 0 or v <= 0:
                    continue
                seg_h = bar_total_h * (v / total)
                c.setFillColor(col)
                c.rect(x, y, bw, seg_h, stroke=0, fill=1)
                if seg_h >= 11:
                    c.setFillColor(colors.white)
                    c.setFont("Helvetica-Bold", 8)
                    c.drawCentredString(x + bw / 2, y + seg_h / 2 - 3, str(v))
                y += seg_h
            # Season label below.
            c.setFillColor(LIGHT)
            c.setFont("Helvetica", 7.5)
            c.drawCentredString(x + bw / 2, 4, str(r["season"]))
            # Total stamp above bar.
            c.setFillColor(INK)
            c.setFont("Helvetica-Bold", 8)
            c.drawCentredString(x + bw / 2, chart_bot + bar_total_h + 4, str(total))


class FreshTransferBars(Flowable):
    """Paired bars per season showing % PA and % IP from a single cohort
    (either freshmen or transfers). Used twice with different data sets."""

    def __init__(self, rows, accent, pa_color, ip_color, width=6.6 * inch, height=1.8 * inch):
        super().__init__()
        self.rows = list(rows or [])[-6:]
        self.accent = accent
        self.pa_color = pa_color
        self.ip_color = ip_color
        self.width = width
        self.height = height

    def wrap(self, *a):
        return (self.width, self.height if self.rows else 0)

    def draw(self):
        if not self.rows:
            return
        c = self.canv
        # Legend.
        sw_y = self.height - 11
        c.setFillColor(self.pa_color)
        c.rect(0, sw_y, 9, 8, stroke=0, fill=1)
        c.setFillColor(INK)
        c.setFont("Helvetica", 8)
        c.drawString(13, sw_y + 1, "Share of team PA")
        c.setFillColor(self.ip_color)
        c.rect(self.width / 2, sw_y, 9, 8, stroke=0, fill=1)
        c.setFillColor(INK)
        c.drawString(self.width / 2 + 13, sw_y + 1, "Share of team IP")

        label_band = 14
        season_band = 14
        chart_top = self.height - label_band
        chart_bot = season_band
        chart_h = chart_top - chart_bot
        # Scale: 0% to 100%
        def y_for(pct):
            return chart_bot + chart_h * pct

        n = len(self.rows)
        slot = self.width / n
        bw = min(slot * 0.42, 44)

        # Baseline.
        c.setStrokeColor(HAIRLINE)
        c.setLineWidth(0.5)
        c.line(0, chart_bot, self.width, chart_bot)

        for i, r in enumerate(self.rows):
            x = i * slot + (slot - bw) / 2
            bw_half = bw * 0.48
            pa = float(r.get("pa_pct") or r.get("fresh_pa_pct") or r.get("transfer_pa_pct") or 0)
            ip = float(r.get("ip_pct") or r.get("fresh_ip_pct") or r.get("transfer_ip_pct") or 0)
            # PA bar (left)
            h_pa = y_for(pa) - chart_bot
            c.setFillColor(self.pa_color)
            c.rect(x, chart_bot, bw_half, max(h_pa, 1), stroke=0, fill=1)
            # IP bar (right)
            h_ip = y_for(ip) - chart_bot
            c.setFillColor(self.ip_color)
            c.rect(x + bw_half + 2, chart_bot, bw_half, max(h_ip, 1), stroke=0, fill=1)
            # Season label below.
            c.setFillColor(LIGHT)
            c.setFont("Helvetica", 7.5)
            c.drawCentredString(x + bw / 2, 4, str(r["season"]))
            # PA/IP % stamped on top.
            c.setFillColor(INK)
            c.setFont("Helvetica-Bold", 8)
            c.drawCentredString(x + bw_half / 2, chart_bot + h_pa + 2, f"{pa*100:.0f}%")
            c.drawCentredString(x + bw_half + 2 + bw_half / 2, chart_bot + h_ip + 2, f"{ip*100:.0f}%")


def roster_build_panel(team):
    """Multi-season returners-vs-freshmen-vs-transfers stack."""
    comp = team.get("roster_composition_series") or []
    if not comp:
        return None
    accent = LEVEL_COLOR[team["division"]]
    rows = [[Paragraph("HOW THE ROSTER IS BUILT  ·  RETURNERS, FRESHMEN, TRANSFERS", TABLE_HEAD)],
            [RosterBuildBars(comp)]]
    last = comp[-1]
    if last.get("total"):
        share = (
            f"In 2026, <b>{last.get('returners') or 0}</b> returners, "
            f"<b>{last.get('freshmen') or 0}</b> true freshmen, and "
            f"<b>{last.get('transfers') or 0}</b> transfers made up the {last['total']}-player group."
        )
        rows.append([Paragraph(share, SMALLBODY)])
    t = Table(rows, colWidths=[6.9 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("BACKGROUND", (0, 1), (-1, -1), PANEL_SOFT),
        ("BOX", (0, 0), (-1, -1), 0.5, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def freshman_production_panel(team):
    """Multi-season freshman production: % PA and % IP from freshmen."""
    rows_data = team.get("freshman_production") or []
    if not rows_data:
        return None
    accent = LEVEL_COLOR[team["division"]]
    pa_color = accent
    ip_color = colors.HexColor("#9bb8d4")
    chart = FreshTransferBars(rows_data, accent, pa_color, ip_color)
    # One-line takeaway about the latest season.
    last = rows_data[-1]
    pa_pct = float(last.get("fresh_pa_pct") or 0) * 100
    ip_pct = float(last.get("fresh_ip_pct") or 0) * 100
    summary = (f"In 2026, freshmen delivered <b>{pa_pct:.0f}%</b> of plate appearances and "
               f"<b>{ip_pct:.0f}%</b> of innings pitched.")
    rows = [[Paragraph("FRESHMAN PRODUCTION  ·  % PA AND % IP BY SEASON", TABLE_HEAD)],
            [Paragraph(summary, SMALLBODY)],
            [chart]]
    t = Table(rows, colWidths=[6.9 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("BACKGROUND", (0, 1), (-1, -1), PANEL_SOFT),
        ("BOX", (0, 0), (-1, -1), 0.5, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def transfer_reliance_panel(team):
    """Multi-season transfer reliance: % PA and % IP from transfers."""
    rows_data = team.get("transfer_production") or []
    if not rows_data:
        return None
    accent = LEVEL_COLOR[team["division"]]
    pa_color = colors.HexColor("#8b5cf6")  # purple (matches site)
    ip_color = colors.HexColor("#caa8f5")  # lighter purple for IP
    chart = FreshTransferBars(rows_data, accent, pa_color, ip_color)
    last = rows_data[-1]
    pa_pct = float(last.get("transfer_pa_pct") or 0) * 100
    ip_pct = float(last.get("transfer_ip_pct") or 0) * 100
    summary = (f"In 2026, transfers (players who arrived as upperclassmen) provided "
               f"<b>{pa_pct:.0f}%</b> of plate appearances and <b>{ip_pct:.0f}%</b> of innings pitched.")
    rows = [[Paragraph("TRANSFER RELIANCE  ·  % PA AND % IP BY SEASON", TABLE_HEAD)],
            [Paragraph(summary, SMALLBODY)],
            [chart]]
    t = Table(rows, colWidths=[6.9 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("BACKGROUND", (0, 1), (-1, -1), PANEL_SOFT),
        ("BOX", (0, 0), (-1, -1), 0.5, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def war_by_season_panel(team):
    rows_data = team.get("war_by_season") or []
    if not rows_data:
        return None
    accent = LEVEL_COLOR[team["division"]]
    rows = [[Paragraph("TEAM WAR BY SEASON", TABLE_HEAD)],
            [WARSeasonBars(rows_data, accent)]]
    t = Table(rows, colWidths=[6.9 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("BACKGROUND", (0, 1), (-1, -1), PANEL_SOFT),
        ("BOX", (0, 0), (-1, -1), 0.5, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


# ── Prose builders ──────────────────────────────────────────────────────────
def _city_info_for(team):
    city = (team.get("city") or "").strip()
    state = (team.get("state") or "").strip()
    return CITY_INFO.get(f"{city}, {state}")


def _town_paragraph(team):
    """A vivid paragraph describing where the school physically is. Pulls
    from the curated city_info.json (population + a one-line region note)
    and the profile's setting / distance / airport fields. The intent is to
    help a recruit and their family picture the actual place."""
    p = team["profile"]
    city = (team.get("city") or "").strip()
    state = (team.get("state") or "").strip()
    info = _city_info_for(team)
    setting = g(p, "campusSetting")
    distance = g(p, "distanceFromCity")
    airport = g(p, "nearestAirport")

    bits = []
    if city:
        if info and info.get("pop"):
            pop_str = fmt_count(info["pop"])
            bits.append(f"{city} (population about {pop_str})")
        elif city and state:
            bits.append(f"{city}, {state}")
        else:
            bits.append(city)
        if info and info.get("region"):
            bits.append(f"sits in {info['region']}")
    sentence1 = ""
    if bits:
        sentence1 = bits[0]
        if len(bits) > 1:
            sentence1 += " " + bits[1]
        if not sentence1.endswith("."):
            sentence1 += "."

    # Setting + distance.
    second_parts = []
    if setting:
        s = setting.strip().lower()
        descriptor = {
            "urban": "an urban, big-city feel",
            "suburban": "a suburban feel",
            "small town": "a small-town feel",
            "rural": "a rural feel",
        }.get(s, f"a {s} feel")
        second_parts.append(f"The campus has {descriptor}")
    if distance and not distance.lower().startswith("in "):
        second_parts.append(f"({distance.rstrip('.')})")
    sentence2 = " ".join(second_parts).strip()
    if sentence2 and not sentence2.endswith("."):
        sentence2 += "."

    sentence3 = ""
    if airport:
        sentence3 = f"The nearest commercial airport is {airport}."

    return " ".join(x for x in (sentence1, sentence2, sentence3) if x)


def program_intro(team):
    """Three-paragraph program intro: the school, the town, and the program.
    Designed so each writeup says something specific to that place rather
    than reading like a template.
    """
    p = team["profile"]
    name = p.get("teamName") or f'{team["short_name"]} {team["mascot"] or ""}'.strip() or team["school_name"]
    loc = f'{team.get("city","")}, {team.get("state","")}'.strip(", ")
    conf = team.get("conference") or ""
    stadium = g(p, "stadium")
    cap = g(p, "capacity")
    setting = g(p, "campusSetting")
    stype = g(p, "schoolType")
    enr = g(p, "enrollment")
    accept = g(p, "acceptance")
    majors = g(p, "topMajors")
    coach = g(p, "coach")
    cyears = g(p, "coachYears")
    crec = g(p, "careerRecord")
    grad = g(p, "gradRate")

    enr_disp = fmt_count(enr) if enr else ""

    # ── Paragraph 1: the school ──────────────────────────────────────────
    p1_bits = [f"<b>{name}</b> play out of {team['school_name']}"]
    if loc:
        p1_bits[-1] += f" in {loc}"
    if conf:
        p1_bits[-1] += f", and compete in the {conf}"
    p1_bits[-1] += "."

    def _a_or_an(word):
        """Return 'a' or 'an' for the leading sound of word. Good enough for
        the words we actually use here (urban/suburban/rural/small/etc.)."""
        if not word:
            return "a"
        first = word.lstrip().lower()[:1]
        return "an" if first in "aeiou" else "a"

    desc_parts = []
    if stype:
        # Preserve original capitalization of religious affiliations
        # ("Christian", "Catholic", "Lutheran") while lowercasing generic
        # descriptors ("Public", "Private", "Community College") so the
        # sentence reads naturally instead of as a title-cased label.
        inst_phrase = stype.strip()
        for generic in ("Public", "Private", "Community College", "Community", "College"):
            inst_phrase = re.sub(rf"\b{generic}\b", generic.lower(), inst_phrase)
        art = _a_or_an(inst_phrase)
        low = inst_phrase.lower()
        # If the type already ends in "college" or "university" / similar, don't
        # tack a redundant "school" on the end.
        if re.search(r"\b(college|university|institute)\b", low):
            desc_parts.append(f"{art} {inst_phrase}")
        elif "public" in low or "private" in low:
            desc_parts.append(f"{art} {inst_phrase} school")
        else:
            desc_parts.append(f"{art} {inst_phrase} institution")
    if enr_disp:
        if desc_parts:
            desc_parts[-1] += f" with roughly {enr_disp} undergraduates"
        else:
            desc_parts.append(f"a campus of roughly {enr_disp} undergraduates")
    if setting:
        setting_lc = setting.lower()
        desc_parts[-1] += f" in {_a_or_an(setting_lc)} {setting_lc} setting" if desc_parts else ""
        if not desc_parts:
            desc_parts.append(f"The campus is {setting_lc}")
    if desc_parts:
        p1_bits.append(f"It is {desc_parts[0]}.")

    acad_bits = []
    if accept:
        if accept.lower() == "open enrollment":
            acad_bits.append("admissions are open enrollment")
        else:
            acad_bits.append(f"the acceptance rate sits near {accept}")
    if grad:
        acad_bits.append(f"about {grad} of students graduate")
    if acad_bits:
        p1_bits.append(("Academically, " + " and ".join(acad_bits) + ".").capitalize().replace("academically", "Academically"))
    if majors:
        p1_bits.append(f"Common areas of study include {majors}.")

    # Student-faculty ratio note belongs in academics paragraph.
    if g(p, "sfr"):
        p1_bits.append(f"The student-to-faculty ratio is {g(p, 'sfr')}.")
    if g(p, "financialAidPct"):
        p1_bits.append(f"Around {g(p, 'financialAidPct')} of students receive some form of financial aid.")

    para1 = " ".join(p1_bits)

    # ── Paragraph 2: the town ─────────────────────────────────────────────
    para_town = _town_paragraph(team)

    # ── Paragraph 3: the baseball program ────────────────────────────────
    p2_bits = []
    if stadium:
        venue = f"Home games are played at {stadium}"
        if cap:
            venue += f", a venue that seats about {fmt_count(cap) or cap}"
        venue += "."
        p2_bits.append(venue)

    if coach and not is_tbd(coach):
        coach_sentence = f"{coach} runs the dugout"
        if cyears and not is_tbd(cyears):
            cy = cyears.strip()
            cy_lower = cy.lower()
            if cy_lower.startswith("since"):
                # Preserve internal capitalization (e.g. "HC since 2024") by
                # only lowercasing the leading "Since" if the rest is mixed-case.
                if cy[0].isupper() and cy[:5].lower() == "since":
                    cy = cy[0].lower() + cy[1:]
                coach_sentence += f", {cy}"
            elif "year" in cy_lower:
                coach_sentence += f", now in {cy_lower}"
            else:
                coach_sentence += f" (since {cy})"
        if valid_career_record(crec):
            coach_sentence += f", and brings a career mark of {crec}"
        coach_sentence += "."
        p2_bits.append(coach_sentence)
    elif coach and is_tbd(coach):
        p2_bits.append("The program is between head coaches as of the 2026 guide.")

    # Program-specific signal lines. These are pulled from the team's own
    # recent history so each writeup says something different. The intent is
    # the recruit walks away with one or two real takeaways per program.
    signals = _program_signals(team)
    if signals:
        p2_bits.append(signals)

    para2 = " ".join(p2_bits)

    paragraphs = [para1]
    if para_town:
        paragraphs.append("<b>About " + (team.get("city") or "the area") + ".</b> " + para_town)
    if para2:
        paragraphs.append(para2)
    text = "<br/><br/>".join(paragraphs)
    # Normalize spacing one more time so accidental doubles introduced by the
    # builders don't survive to the page.
    text = re.sub(r"  +", " ", text)
    text = re.sub(r"\s+\.", ".", text)
    text = re.sub(r"\s+,", ",", text)
    return text


def _program_signals(team):
    """Compose a sentence (or two) that highlights program-specific signals
    pulled from the data: recent winning streaks, pro production, freshman
    reliance, hometown footprint, national ranking, conference dominance."""
    bits = []
    profile = team["profile"]
    name = esc(team["short_name"])
    seasons = team.get("seasons") or []
    # Recent winning years tally.
    recent = [s for s in seasons if s["season"] >= 2021]
    win_seasons = []
    for s in recent:
        w, l = s.get("wins") or 0, s.get("losses") or 0
        if w + l > 0 and w / (w + l) >= 0.550:
            win_seasons.append(s["season"])
    if len(win_seasons) >= 3:
        bits.append(f"{name} has put together a winning season "
                    f"in {len(win_seasons)} of the last {len(recent)} years, "
                    "a steady run by Pacific Northwest standards.")
    elif len(win_seasons) <= 1 and len(recent) >= 3:
        bits.append("The program has been chasing a winning season for a few years now.")

    # National rankings.
    rk = team.get("rankings") or {}
    comp = rk.get("composite") or {}
    if comp.get("composite_rank") and comp.get("composite_percentile") is not None:
        cr = int(float(comp["composite_rank"]))
        pct = float(comp["composite_percentile"])
        if pct >= 90:
            bits.append(f"They entered 2026 among the country's elite, ranked No. {cr} in the composite "
                        f"national index that combines multiple advanced rating systems.")
        elif pct >= 70:
            bits.append(f"The 2026 composite national index placed them at No. {cr}, comfortably in the upper "
                        "third of teams at this level.")

    # Pro alumni count.
    alumni = team.get("pro_alumni") or []
    mlb = sum(1 for a in alumni if a.get("level") == "MLB")
    if mlb >= 5:
        bits.append(f"At least {mlb} {name} alums are currently active in Major League Baseball, "
                    "a clear sign the program puts players on a pro track.")
    elif len(alumni) >= 10:
        bits.append(f"{len(alumni)} {name} alumni are currently working through affiliated pro baseball, "
                    "from MLB rosters to short-season clubs.")

    # Freshman play time.
    rc = team.get("roster_classes") or {}
    fr_pa = rc.get("freshman_pa_share") or 0
    fr_ip = rc.get("freshman_ip_share") or 0
    if fr_pa >= 0.40 or fr_ip >= 0.35:
        bits.append("The 2026 roster leaned heavily on freshmen, which often signals a program in the middle "
                    "of a rebuild or one that recruits and immediately plays its young arms and bats.")

    # Conference dominance.
    cs = team.get("conf_standings") or {}
    place = None
    if cs.get("standings"):
        place = next((r["place"] for r in cs["standings"] if r["id"] == team["team_id"]), None)
    if place == 1:
        bits.append(f"In 2026 they finished first in the {team.get('conference','conference')}, "
                    "putting a trophy in the case.")

    # Cap at two signals to keep the paragraph readable.
    return " ".join(bits[:2])


# Division-level "typical" benchmarks for honest hitting/pitching context.
# These come from the gather step, which computes actual PA-weighted batting
# averages and IP-weighted ERA per division from the 2026 season's player
# rows. Previous hardcoded values overshot NWAC AVG by about .035 — Columbia
# Basin's .252 was being painted as below-average when it was actually right
# on the NWAC norm of .249.
_FALLBACK_NORMS = {
    "D1":   {"avg": 0.276, "ops": 0.796, "era": 4.83, "rpg": 3.33},
    "D2":   {"avg": 0.292, "ops": 0.805, "era": 6.73, "rpg": 4.04},
    "D3":   {"avg": 0.284, "ops": 0.814, "era": 6.86, "rpg": 4.33},
    "NAIA": {"avg": 0.288, "ops": 0.814, "era": 5.86, "rpg": 4.94},
    "NWAC": {"avg": 0.249, "ops": 0.662, "era": 4.94, "rpg": 2.78},
}
_LEVEL_NORMS = {**_FALLBACK_NORMS, **LEVEL_NORMS_DATA}


def _season_assessment(wpct):
    """A human-readable label for the season's results."""
    if wpct >= 0.700:
        return "elite", "It was a special season."
    if wpct >= 0.620:
        return "strong", "It was a strong season."
    if wpct >= 0.540:
        return "winning", "It was a winning season."
    if wpct >= 0.470:
        return "near .500", "The Pacific Northwest is a tough region, and the result fell in line with most years."
    if wpct >= 0.380:
        return "below .500", "It was a tough year for the program."
    if wpct >= 0.280:
        return "rebuilding", "It was a difficult year, the kind that usually triggers an off-season reset."
    return "very difficult", "It was a very difficult year, with wins hard to come by from start to finish."


def season_recap(team):
    """Two- to three-paragraph honest recap: where they finished, what worked,
    what didn't, who carried the load, and how it compares to last year.

    This is the most important block in the book. Players, parents, and
    coaches will read this before anything else. It needs to be accurate and
    written like a person, not a stat dump.
    """
    s = team.get("season_2026")
    if not s:
        return "The 2026 season's complete statistical record was not available for this program."

    name = esc(team["short_name"])
    div = team["division"]
    norms = _LEVEL_NORMS.get(div, _LEVEL_NORMS["NAIA"])
    w, l, t = s.get("wins") or 0, s.get("losses") or 0, s.get("ties") or 0
    games = w + l
    wpct = w / games if games else 0
    cw, cl = s.get("conference_wins") or 0, s.get("conference_losses") or 0
    cgames = cw + cl
    rd = s.get("run_differential")
    rs, ra = s.get("runs_scored"), s.get("runs_allowed")
    avg = s.get("team_batting_avg")
    ops = s.get("team_ops")
    era = s.get("team_era")
    whip = s.get("team_whip")
    conf_name = team.get("conference") or "conference"

    # Conference finish position from standings.
    cs = team.get("conf_standings")
    place = None
    conf_size = None
    if cs and cs.get("standings"):
        place = next((r["place"] for r in cs["standings"] if r["id"] == team["team_id"]), None)
        conf_size = len(cs["standings"])

    tier, tier_sentence = _season_assessment(wpct)

    # ── Paragraph 1: the headline ────────────────────────────────────────
    p1 = f"<b>{name} finished {w}-{l}"
    if t:
        p1 += f"-{t}"
    p1 += "</b> in 2026"
    if cgames > 0:
        p1 += f" and went {cw}-{cl} against {conf_name} opponents"
    p1 += "."
    if place and conf_size:
        p1 += f" That landed them {ordinal(place)} out of {conf_size} teams in the league standings."
    if rd is not None and (rs is not None or ra is not None) and (rs or ra):
        if rd >= 0:
            verb = "outscored opponents"
            qualifier = ""
            if rd >= 100:
                qualifier = ", a real run-prevention and run-creation gap"
            p1 += f" They {verb} by {int(rd)} runs"
        else:
            verb = "were outscored"
            qualifier = ""
            if rd <= -100:
                qualifier = ", a margin that doesn't show up by accident"
            p1 += f" They {verb} by {abs(int(rd))} runs"
        if rs is not None and ra is not None and (rs or ra):
            p1 += f" ({int(rs)} scored, {int(ra)} allowed){qualifier}."
        else:
            p1 += f"{qualifier}."

    # ── Paragraph 2: where the season was won and lost ───────────────────
    p2_parts = []
    if avg or ops or era or whip:
        offense_note = None
        pitching_note = None

        if avg is not None and ops is not None:
            if ops >= norms["ops"] + 0.110:
                offense_note = (f"The offense was the engine, hitting {fmt_avg(avg)} as a team with "
                                f"a {fmt_avg(ops)} OPS that sat well above {div} norms.")
            elif ops >= norms["ops"] + 0.030:
                offense_note = (f"The bats produced, with a {fmt_avg(avg)} team average and a "
                                f"{fmt_avg(ops)} OPS that came in above the typical {div} mark.")
            elif ops >= norms["ops"] - 0.040:
                offense_note = (f"At the plate, the club hit {fmt_avg(avg)} with a {fmt_avg(ops)} "
                                f"OPS, right around what you'd expect at this level.")
            elif ops >= norms["ops"] - 0.110:
                offense_note = (f"The offense was a step behind the rest of the level, hitting "
                                f"{fmt_avg(avg)} with a {fmt_avg(ops)} OPS.")
            else:
                offense_note = (f"Run production was the bigger problem: the lineup hit {fmt_avg(avg)} "
                                f"with a {fmt_avg(ops)} OPS, both well shy of what wins games at this "
                                f"level.")
        elif avg is not None:
            offense_note = f"The team hit {fmt_avg(avg)}."

        if era is not None:
            if era <= norms["era"] - 1.20:
                pitching_note = (f"The staff was the strength, posting a {fmt_rate(era)} ERA that "
                                 f"would be a top-tier mark at any level.")
            elif era <= norms["era"] - 0.50:
                pitching_note = (f"Pitching held up its end, with a {fmt_rate(era)} ERA that came "
                                 f"in noticeably better than the {div} average.")
            elif era <= norms["era"] + 0.60:
                pitching_note = (f"The staff pitched to a {fmt_rate(era)} ERA, in line with typical "
                                 f"{div} numbers.")
            elif era <= norms["era"] + 1.50:
                pitching_note = (f"Pitching was a problem area, with a team ERA of {fmt_rate(era)} "
                                 f"that ran above the level's norm.")
            else:
                pitching_note = (f"Pitching was where the season most often slipped away. A team "
                                 f"ERA of {fmt_rate(era)} reflects how hard it was to put up zeros.")
            if whip is not None and pitching_note and era is not None:
                pitching_note = pitching_note[:-1] + f" (WHIP {fmt_rate(whip)})."

        if offense_note:
            p2_parts.append(offense_note)
        if pitching_note:
            p2_parts.append(pitching_note)

    p2 = " ".join(p2_parts)

    # ── Paragraph 3: who carried the load + YoY context + assessment ────
    p3_parts = []
    th, tp = team.get("top_hitter"), team.get("top_pitcher")
    if th and th.get("name"):
        bits = []
        if th.get("batting_avg") is not None and th.get("on_base_pct") is not None and th.get("slugging_pct") is not None:
            bits.append(f"slashing {fmt_avg(th['batting_avg'])}/"
                        f"{fmt_avg(th['on_base_pct'])}/{fmt_avg(th['slugging_pct'])}")
        elif th.get("batting_avg") is not None:
            bits.append(f"hitting {fmt_avg(th['batting_avg'])}")
        if th.get("home_runs"):
            n = int(th['home_runs'])
            bits.append(f"{n} home run" + ("s" if n != 1 else ""))
        if th.get("rbi"):
            bits.append(f"{int(th['rbi'])} RBI")
        if th.get("wrc_plus") is not None:
            wp = float(th["wrc_plus"])
            if wp >= 130:
                bits.append(f"a {int(wp)} wRC+, well above the level's average bat")
        sentence = f"At the plate, <b>{th['name']}</b> was the standout"
        if bits:
            sentence += ", " + ", ".join(bits)
        sentence += "."
        p3_parts.append(sentence)

    if tp and tp.get("name"):
        bits = []
        if tp.get("era") is not None:
            bits.append(f"a {fmt_rate(tp['era'])} ERA")
        if tp.get("innings_pitched") is not None:
            bits.append(f"{fmt_ip(tp['innings_pitched'])} IP")
        if tp.get("strikeouts"):
            bits.append(f"{int(tp['strikeouts'])} strikeouts")
        if tp.get("whip") is not None:
            bits.append(f"a {fmt_rate(tp['whip'])} WHIP")
        sentence = f"On the mound, <b>{tp['name']}</b> was the most reliable arm"
        if bits:
            sentence += ", carrying " + ", ".join(bits) + "."
        else:
            sentence += "."
        p3_parts.append(sentence)

    # Year-over-year context.
    prior = next((x for x in team["seasons"] if x["season"] == 2025), None)
    if prior:
        pw, pl = prior.get("wins") or 0, prior.get("losses") or 0
        if (pw + pl) > 0:
            d = w - pw
            if d >= 5:
                p3_parts.append(f"The result was a noticeable step forward from {pw}-{pl} in 2025.")
            elif d >= 2:
                p3_parts.append(f"The win total ticked up from {pw}-{pl} a year earlier.")
            elif d <= -5:
                p3_parts.append(f"The record fell off from {pw}-{pl} the year before.")
            elif d <= -2:
                p3_parts.append(f"The win total slipped from {pw}-{pl} the year before.")
            else:
                p3_parts.append(f"The 2026 finish was right in line with {pw}-{pl} in 2025.")

    # If the team played in the postseason, lead with that fact — it's the
    # single most important context for the season and reframes the tier.
    postseason = POSTSEASON_2026.get(team["team_id"])
    if postseason and postseason.get("sentence"):
        p3_parts.append(postseason["sentence"])
    else:
        p3_parts.append(tier_sentence)
    p3 = " ".join(p3_parts)

    paragraphs = [x for x in (p1, p2, p3) if x]
    text = "<br/><br/>".join(paragraphs)
    text = re.sub(r"  +", " ", text)
    text = re.sub(r"\s+\.", ".", text)
    text = re.sub(r"\s+,", ",", text)
    return text


# ── Building blocks ─────────────────────────────────────────────────────────
def stat_tiles(team):
    s = team.get("season_2026") or {}
    p = team["profile"]
    # Try to display conference finish if we have standings; otherwise enrollment.
    finish = ""
    cs = team.get("conf_standings")
    if cs:
        place = next((r["place"] for r in cs["standings"] if r["id"] == team["team_id"]), None)
        total = len(cs["standings"])
        if place:
            finish = f"{ordinal(place)} of {total}"
    cells = [
        ("2026 RECORD", rec_str(s)),
        ("CONFERENCE", f"{s.get('conference_wins',0)}-{s.get('conference_losses',0)}" if s else "—"),
        ("RUN DIFF", (("+" if (s.get('run_differential') or 0) >= 0 else "") + str(int(s['run_differential'])))
                       if s.get('run_differential') is not None else "—"),
        ("TEAM AVG", fmt_avg(s.get("team_batting_avg")) if s.get("team_batting_avg") else "—"),
        ("TEAM ERA", fmt_rate(s.get("team_era")) if s.get("team_era") else "—"),
        ("CONF FINISH" if finish else "ENROLLMENT", finish or (fmt_count(g(p, "enrollment")) or "—")),
    ]
    accent = LEVEL_COLOR[team["division"]]
    lbl_row = [Paragraph(c[0], TILE_LBL) for c in cells]
    val_row = [Paragraph(c[1], TILE_VAL) for c in cells]
    t = Table([lbl_row, val_row], colWidths=[6.9 * inch / len(cells)] * len(cells),
              rowHeights=[15, 26])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("BACKGROUND", (0, 1), (-1, 1), PANEL),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LINEBEFORE", (1, 0), (-1, -1), 0.75, colors.white),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("BOX", (0, 0), (-1, -1), 0.5, accent),
    ]))
    return t


def hitter_table(team):
    hitters = team.get("top_hitters") or []
    if not hitters:
        return None
    headers = ["Player", "Pos", "Yr", "PA", "AVG", "OBP", "SLG", "OPS", "HR", "RBI", "SB", "wRC+", "WAR"]
    rows = [[Paragraph(h, TABLE_HEAD) for h in headers]]
    for h in hitters[:5]:
        war = h.get("offensive_war")
        rows.append([
            Paragraph(esc(h.get("name") or "—"), TABLE_NAME),
            Paragraph(h.get("position") or "—", TABLE_CELL),
            Paragraph((h.get("year_in_school") or "")[:4] if h.get("year_in_school") else "—", TABLE_CELL),
            Paragraph(fmt_int(h.get("plate_appearances")), TABLE_CELL),
            Paragraph(fmt_avg(h.get("batting_avg")), TABLE_CELL),
            Paragraph(fmt_avg(h.get("on_base_pct")), TABLE_CELL),
            Paragraph(fmt_avg(h.get("slugging_pct")), TABLE_CELL),
            Paragraph(fmt_avg(h.get("ops")), TABLE_CELL),
            Paragraph(fmt_int(h.get("home_runs")), TABLE_CELL),
            Paragraph(fmt_int(h.get("rbi")), TABLE_CELL),
            Paragraph(fmt_int(h.get("stolen_bases")), TABLE_CELL),
            Paragraph(fmt_int(h.get("wrc_plus")) if h.get("wrc_plus") else "—", TABLE_CELL),
            Paragraph(("%.2f" % float(war)) if war is not None else "—", TABLE_CELL),
        ])
    col_widths = [1.45*inch, 0.32*inch, 0.32*inch, 0.36*inch, 0.42*inch, 0.42*inch,
                  0.42*inch, 0.42*inch, 0.32*inch, 0.36*inch, 0.32*inch, 0.42*inch, 0.4*inch]
    accent = LEVEL_COLOR[team["division"]]
    t = Table(rows, colWidths=col_widths, rowHeights=[16] + [18]*(len(rows)-1))
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PANEL_SOFT]),
        ("LINEBELOW", (0, 0), (-1, -2), 0.3, HAIRLINE),
        ("BOX", (0, 0), (-1, -1), 0.5, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    return t


def pitcher_table(team):
    pitchers = team.get("top_pitchers") or []
    if not pitchers:
        return None
    headers = ["Player", "Yr", "G", "GS", "W-L", "SV", "IP", "ERA", "WHIP", "K", "K/9", "FIP", "WAR"]
    rows = [[Paragraph(h, TABLE_HEAD) for h in headers]]
    for p in pitchers[:5]:
        wl = f"{p.get('wins') or 0}-{p.get('losses') or 0}"
        war = p.get("pitching_war")
        rows.append([
            Paragraph(esc(p.get("name") or "—"), TABLE_NAME),
            Paragraph((p.get("year_in_school") or "")[:4] if p.get("year_in_school") else "—", TABLE_CELL),
            Paragraph(fmt_int(p.get("games")), TABLE_CELL),
            Paragraph(fmt_int(p.get("games_started")), TABLE_CELL),
            Paragraph(wl, TABLE_CELL),
            Paragraph(fmt_int(p.get("saves")) if p.get("saves") else "0", TABLE_CELL),
            Paragraph(fmt_ip(p.get("innings_pitched")), TABLE_CELL),
            Paragraph(fmt_rate(p.get("era")), TABLE_CELL),
            Paragraph(fmt_rate(p.get("whip")), TABLE_CELL),
            Paragraph(fmt_int(p.get("strikeouts")), TABLE_CELL),
            Paragraph(fmt_rate(p.get("k_per_9"), 1), TABLE_CELL),
            Paragraph(fmt_rate(p.get("fip")), TABLE_CELL),
            Paragraph(("%.2f" % float(war)) if war is not None else "—", TABLE_CELL),
        ])
    col_widths = [1.45*inch, 0.32*inch, 0.3*inch, 0.3*inch, 0.5*inch, 0.3*inch,
                  0.42*inch, 0.46*inch, 0.46*inch, 0.36*inch, 0.42*inch, 0.42*inch, 0.38*inch]
    accent = LEVEL_COLOR[team["division"]]
    t = Table(rows, colWidths=col_widths, rowHeights=[16] + [18]*(len(rows)-1))
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PANEL_SOFT]),
        ("LINEBELOW", (0, 0), (-1, -2), 0.3, HAIRLINE),
        ("BOX", (0, 0), (-1, -1), 0.5, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    return t


def _avg_str(v):
    """Render a batting AVG/OBP/SLG as ".287" (leading-zero stripped)."""
    if v is None:
        return "—"
    try:
        n = float(v)
    except Exception:
        return "—"
    s = ("%.3f" % n)
    return s.lstrip("0") if s.startswith("0") else s


def _delta_paragraph(team_val, league_val, kind, lower_is_better=False):
    """Color-coded ±delta indicator: green when better than league, red when
    worse. Used in the team-vs-league comparison tables to give the eye a fast
    read on where a team beat or trailed the typical line."""
    try:
        d = float(team_val) - float(league_val)
    except Exception:
        return Paragraph("", TABLE_CELL)
    if lower_is_better:
        good = d < 0
    else:
        good = d > 0
    color = "#0a7a3f" if good else "#a02620"
    if abs(d) < 0.001 and kind in ("avg",):
        color = "#5f5f5f"
    sign = "+" if d > 0 else ""
    if kind == "avg":
        delta_str = f"{sign}{d:.3f}".replace("+0.", "+.").replace("-0.", "-.")
    elif kind == "int":
        delta_str = f"{sign}{int(round(d))}"
    else:
        delta_str = f"{sign}{d:.2f}"
    return Paragraph(f'<font color="{color}"><b>{delta_str}</b></font>', TABLE_CELL)


def team_line_panel(team):
    """Two-block team-stats panel.

    Left block: the rate stats we can actually benchmark against the division
    (AVG, OPS, R/G for batting; ERA, R/G allowed for pitching) with a Δ vs.
    typical column. Right block: the raw counting stats (OBP, SLG, HR, IP,
    K/9, BB/9, WHIP) laid out in a tidy grid, no comparison column at all.
    Removes the previous panel's long parade of '—' placeholders."""
    accent = LEVEL_COLOR[team["division"]]
    div = team["division"]
    norms = _LEVEL_NORMS.get(div, _LEVEL_NORMS["NAIA"])
    b = team.get("team_batting") or {}
    p = team.get("team_pitching") or {}
    s2026 = team.get("season_2026") or {}
    games_played = (s2026.get("wins") or 0) + (s2026.get("losses") or 0) + (s2026.get("ties") or 0)
    rpg_off = ((b.get("r") or 0) / games_played) if games_played and b.get("r") else None
    rpg_def = ((p.get("runs_allowed") or 0) / games_played) if games_played and p.get("runs_allowed") else None

    def benchmark_table(title, rows):
        head = [
            Paragraph(title, TABLE_HEAD),
            Paragraph("Team", TABLE_HEAD),
            Paragraph(f"{div} Typ.", TABLE_HEAD),
            Paragraph("Δ", TABLE_HEAD),
        ]
        all_rows = [head] + rows
        t = Table(all_rows,
                  colWidths=[0.92*inch, 0.68*inch, 0.82*inch, 0.68*inch])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), accent),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [PANEL_SOFT, colors.white]),
            ("BOX", (0, 0), (-1, -1), 0.5, accent),
            ("LINEBELOW", (0, 0), (-1, -2), 0.25, HAIRLINE),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        return t

    bat_rows = [
        [Paragraph("AVG", TABLE_CELL_L),
         Paragraph(_avg_str(b.get("avg")), TABLE_CELL),
         Paragraph(_avg_str(norms["avg"]), TABLE_CELL),
         _delta_paragraph(b.get("avg"), norms["avg"], "avg")],
        [Paragraph("OPS", TABLE_CELL_L),
         Paragraph(_avg_str(b.get("ops")), TABLE_CELL),
         Paragraph(_avg_str(norms["ops"]), TABLE_CELL),
         _delta_paragraph(b.get("ops"), norms["ops"], "avg")],
        [Paragraph("R / G", TABLE_CELL_L),
         Paragraph(fmt_rate(rpg_off, 1) if rpg_off is not None else "—", TABLE_CELL),
         Paragraph(fmt_rate(norms["rpg"], 1), TABLE_CELL),
         (_delta_paragraph(rpg_off, norms["rpg"], "rate") if rpg_off is not None
          else Paragraph("—", TABLE_CELL))],
    ]
    bat_tbl = benchmark_table("BATTING vs " + div, bat_rows)

    pit_rows = [
        [Paragraph("ERA", TABLE_CELL_L),
         Paragraph(fmt_rate(p.get("era")), TABLE_CELL),
         Paragraph(fmt_rate(norms["era"]), TABLE_CELL),
         _delta_paragraph(p.get("era"), norms["era"], "rate", lower_is_better=True)],
        [Paragraph("R / G", TABLE_CELL_L),
         Paragraph(fmt_rate(rpg_def, 1) if rpg_def is not None else "—", TABLE_CELL),
         Paragraph(fmt_rate(norms["rpg"], 1), TABLE_CELL),
         (_delta_paragraph(rpg_def, norms["rpg"], "rate", lower_is_better=True) if rpg_def is not None
          else Paragraph("—", TABLE_CELL))],
    ]
    pit_tbl = benchmark_table("PITCHING vs " + div, pit_rows)

    # Compact "more stats" grid: label/value rows in 4 columns.
    def more_grid(title, pairs):
        # pairs: list of (label, value). Build 2-col-by-N table.
        rows = [[Paragraph(title, TABLE_HEAD), Paragraph("", TABLE_HEAD),
                 Paragraph("", TABLE_HEAD), Paragraph("", TABLE_HEAD)]]
        # Pair up two label-value pairs per row.
        for i in range(0, len(pairs), 2):
            l1, v1 = pairs[i]
            if i + 1 < len(pairs):
                l2, v2 = pairs[i + 1]
            else:
                l2, v2 = "", ""
            rows.append([
                Paragraph(l1, FACTLBL), Paragraph(str(v1), FACTVAL),
                Paragraph(l2, FACTLBL), Paragraph(str(v2), FACTVAL),
            ])
        t = Table(rows, colWidths=[0.78*inch, 0.84*inch, 0.78*inch, 0.84*inch])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), accent),
            ("SPAN", (0, 0), (-1, 0)),
            ("BACKGROUND", (0, 1), (-1, -1), PANEL_SOFT),
            ("BOX", (0, 0), (-1, -1), 0.5, accent),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        return t

    bat_more = more_grid("MORE BATTING", [
        ("OBP", _avg_str(b.get("obp"))),
        ("SLG", _avg_str(b.get("slg"))),
        ("HR",  fmt_int(b.get("hr"))),
        ("SB",  fmt_int(b.get("sb"))),
        ("BB",  fmt_int(b.get("bb"))),
        ("SO",  fmt_int(b.get("so"))),
    ])
    pit_more = more_grid("MORE PITCHING", [
        ("WHIP", fmt_rate(p.get("whip"))),
        ("K / 9", fmt_rate(p.get("k9"), 1)),
        ("BB / 9", fmt_rate(p.get("bb9"), 1)),
        ("HR/9", fmt_rate(p.get("hr9"), 2)),
        ("IP",   fmt_ip(p.get("ip"))),
        ("SO",   fmt_int(p.get("so"))),
    ])

    # Combine: top row of compare panels, bottom row of detail grids.
    outer = Table([
        [bat_tbl, pit_tbl],
        [bat_more, pit_more],
    ], colWidths=[3.36*inch, 3.36*inch], rowHeights=[None, None])
    outer.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
    ]))
    return outer


def _standings_row(r, team_id):
    """Format one standings row as [name, conf-record, overall, RD]."""
    is_me = (r["id"] == team_id)
    sn = esc(r["short_name"])
    name_text = f"<b>{sn}</b>" if is_me else sn
    place = f"{ordinal(r['place'])}. "
    cwl = f"{r.get('conference_wins') or 0}-{r.get('conference_losses') or 0}"
    owl = f"{r.get('wins') or 0}-{r.get('losses') or 0}"
    rs, ra = r.get("runs_scored") or 0, r.get("runs_allowed") or 0
    rd_raw = r.get("run_differential")
    if rs == 0 and ra == 0:
        rd_str = "—"
    else:
        rd = rd_raw if rd_raw is not None else (rs - ra)
        rd_str = (("+" if rd >= 0 else "") + str(int(rd)))
    return [
        Paragraph(place + name_text, TABLE_CELL_L),
        Paragraph(cwl, TABLE_CELL),
        Paragraph(owl, TABLE_CELL),
        Paragraph(rd_str, TABLE_CELL),
    ]


def standings_panel(team):
    cs = team.get("conf_standings")
    if not cs or not cs["standings"]:
        return None
    accent = LEVEL_COLOR[team["division"]]
    standings = cs["standings"]
    head = [Paragraph("Team", TABLE_HEAD), Paragraph("Conf.", TABLE_HEAD),
            Paragraph("Overall", TABLE_HEAD), Paragraph("RD", TABLE_HEAD)]

    n = len(standings)
    # For large conferences (Big Ten, etc.), render side-by-side columns.
    if n > 10:
        half = (n + 1) // 2
        left, right = standings[:half], standings[half:]
        # Pad right so columns align.
        while len(right) < len(left):
            right.append(None)
        col_widths = [1.85*inch, 0.55*inch, 0.55*inch, 0.45*inch]
        rows = [head + head]
        for L, R in zip(left, right):
            l_row = _standings_row(L, team["team_id"])
            r_row = _standings_row(R, team["team_id"]) if R else [Paragraph("", TABLE_CELL_L)] * 4
            rows.append(l_row + r_row)
        t = Table(rows, colWidths=col_widths + col_widths,
                  rowHeights=[15] + [14] * (len(rows) - 1))
        style = [
            ("BACKGROUND", (0, 0), (-1, 0), accent),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("BOX", (0, 0), (-1, -1), 0.5, accent),
            ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 1),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
            ("LINEBELOW", (0, 0), (-1, -2), 0.25, HAIRLINE),
            ("LINEAFTER", (3, 0), (3, -1), 0.6, accent),
        ]
        # Highlight this team's row (could be in left or right column).
        for i, (L, R) in enumerate(zip(left, right)):
            if L["id"] == team["team_id"]:
                style.append(("BACKGROUND", (0, i+1), (3, i+1), PANEL))
            if R and R["id"] == team["team_id"]:
                style.append(("BACKGROUND", (4, i+1), (7, i+1), PANEL))
        t.setStyle(TableStyle(style))
        return t

    # Small conference: single column.
    rows = [head]
    for r in standings:
        rows.append(_standings_row(r, team["team_id"]))
    t = Table(rows, colWidths=[3.3*inch, 0.9*inch, 0.9*inch, 0.7*inch],
              rowHeights=[16] + [15] * (len(rows) - 1))
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOX", (0, 0), (-1, -1), 0.5, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 1.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
        ("LINEBELOW", (0, 0), (-1, -2), 0.3, HAIRLINE),
    ]
    for i, r in enumerate(standings):
        if r["id"] == team["team_id"]:
            style.append(("BACKGROUND", (0, i+1), (-1, i+1), PANEL))
    t.setStyle(TableStyle(style))
    return t


def rankings_strip(team):
    r = team.get("rankings")
    if not r:
        return None
    bits = []
    comp = r.get("composite") or {}
    if comp.get("composite_rank"):
        cp = comp.get("composite_percentile")
        pct = f", top {100 - cp:.0f}% nationally" if cp else ""
        bits.append(f"<b>#{comp['composite_rank']:.0f}</b> Composite{pct}")
    for s in r.get("sources") or []:
        if s.get("national_rank") and s.get("total_teams"):
            src = s["source"].upper() if s.get("source") else ""
            bits.append(f"<b>#{s['national_rank']}</b> {src} (of {s['total_teams']})")
    if not bits:
        return None
    return Paragraph("  ·  ".join(bits), SMALLBODY)


def roster_snapshot(team):
    r = team.get("roster") or {}
    if not r.get("total"):
        return None
    by_pos = r.get("by_position") or []
    pos_str = ", ".join(f"{n} {pos}" for pos, n in by_pos if pos)
    txt = (f"<b>2026 roster:</b> {r['total']} players "
           f"({r['pitchers']} pitchers, {r['position_players']} position players)")
    if pos_str:
        txt += f". By listed position: {pos_str}."
    return Paragraph(txt, SMALLBODY)


def facts_panel(team):
    p = team["profile"]
    rows = []

    def add(lbl, val):
        if val:
            rows.append((lbl, val))
    add("Stadium", " ".join(x for x in [g(p, "stadium"),
                                        (f"({g(p,'capacity')})" if g(p, "capacity") else "")] if x))
    add("School Type", g(p, "schoolType"))
    add("Enrollment", fmt_count(g(p, "enrollment")))
    add("Student / Faculty", g(p, "sfr"))
    add("Acceptance Rate", g(p, "acceptance"))
    add("Top Majors", g(p, "topMajors"))
    add("Graduation Rate", g(p, "gradRate"))
    add("Financial Aid", g(p, "financialAidPct"))
    add("In-State Tuition", g(p, "inStateTuition"))
    add("Out-of-State Tuition", g(p, "outStateTuition"))
    add("Room & Board", g(p, "roomBoard"))
    add("Scholarships", scholarship_line(team))
    add("Roster Size", g(p, "rosterSize"))
    add("2026 Seniors", g(p, "gradSeniors"))
    add("Nearest Airport", g(p, "nearestAirport"))
    add("Distance", g(p, "distanceFromCity"))
    add("Campus Setting", g(p, "campusSetting"))
    add("Campus Safety", g(p, "campusSafety"))
    add("Athletics Site", g(p, "athleticsWebsite"))
    add("Roster Page", g(p, "baseballRosterUrl"))
    add("School Site", g(p, "schoolWebsite"))

    if not rows:
        return Spacer(1, 1)
    data = [[Paragraph(lbl, FACTLBL), Paragraph(val, FACTVAL)] for lbl, val in rows]
    t = Table(data, colWidths=[1.5 * inch, 5.3 * inch])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, HAIRLINE),
        ("LEFTPADDING", (0, 0), (0, -1), 0),
    ]))
    return t


def coach_panel(team):
    """Head coach summary: name + tenure + alma + record up top, then bio."""
    p = team["profile"]
    accent = LEVEL_COLOR[team["division"]]
    name = g(p, "coach") or "Head Coach"
    tenure = g(p, "coachYears")
    alma = g(p, "coachAlma")
    rec = g(p, "careerRecord")
    prev = g(p, "prevStops")
    email = g(p, "coachEmail")
    bio = clean_bio(g(p, "coachBio"))

    head_bits = []
    if tenure:
        head_bits.append(tenure)
    if alma:
        head_bits.append(f"{alma} alum")
    if valid_career_record(rec):
        head_bits.append(f"Career: {rec}")
    head_line = "  ·  ".join(head_bits)

    flow = []
    flow.append(Paragraph(f"<b>{name}</b>", S("coachname", fontName="Helvetica-Bold",
                                              fontSize=14, leading=17, textColor=accent)))
    if head_line:
        flow.append(Paragraph(head_line, S("coachmeta", fontName="Helvetica", fontSize=10,
                                            leading=13, textColor=MUTED)))
    if prev:
        flow.append(Spacer(1, 4))
        flow.append(Paragraph(f"<b>Coaching path:</b> {prev}", SMALLBODY))
    if email:
        flow.append(Paragraph(f"<b>Email:</b> <link href=\"mailto:{email}\" color=\"#14365c\">{email}</link>", SMALLBODY))
    if bio:
        flow.append(Spacer(1, 6))
        flow.append(Paragraph(bio, BIO))
    return flow


def assistants_panel(team):
    p = team["profile"]
    a = g(p, "assistants")
    size = g(p, "staffSize")
    if not a and not size:
        return None
    msg = ""
    if a:
        msg += a
    if size and size not in a:
        msg += f"  ·  Staff size: {size}"
    return Paragraph(msg, FACTVAL)


def pro_alumni_panel(team):
    """Compact 'Currently in Pro Baseball' panel.

    The data comes from backend/data/pro_alumni.json (the same source the
    site's pro tracker uses). We show MLB players first, then a handful of
    standout minor-leaguers, then a tail count if the list is longer."""
    alumni = team.get("pro_alumni") or []
    if not alumni:
        return None
    accent = LEVEL_COLOR[team["division"]]

    mlb = [a for a in alumni if a.get("level") == "MLB"]
    minors = [a for a in alumni if a.get("level") and a["level"] != "MLB"]

    rows = [[Paragraph("CURRENTLY IN PRO BASEBALL", TABLE_HEAD)]]
    summary_bits = []
    if mlb:
        summary_bits.append(f"<b>{len(mlb)} MLB</b>")
    by_lvl = {}
    for a in minors:
        by_lvl[a["level"]] = by_lvl.get(a["level"], 0) + 1
    for lvl in ("AAA", "AA", "A+", "A", "Rk"):
        if by_lvl.get(lvl):
            summary_bits.append(f"<b>{by_lvl[lvl]}</b> {lvl}")
    summary = f"{len(alumni)} total alums in affiliated pro ball  ·  " + "  ·  ".join(summary_bits) if summary_bits else f"{len(alumni)} alums in pro ball"
    rows.append([Paragraph(summary, FACTVAL)])

    listed = []
    # Show all MLB players, then fill up to 12 from minors (best level first).
    listed.extend(mlb)
    remaining = 12 - len(listed)
    if remaining > 0:
        listed.extend(minors[:remaining])
    listed = listed[:12]

    name_rows = []
    for a in listed:
        nm = esc(a.get("name") or "")
        lvl = esc(a.get("level") or "")
        cur = esc(a.get("current_team") or a.get("affiliate") or "")
        if cur:
            line = f"<b>{nm}</b>  ·  {lvl}, {cur}"
        elif lvl:
            line = f"<b>{nm}</b>  ·  {lvl}"
        else:
            line = f"<b>{nm}</b>"
        name_rows.append(Paragraph(line, SMALLBODY))

    # Two-column layout for player names.
    half = (len(name_rows) + 1) // 2
    left, right = name_rows[:half], name_rows[half:]
    while len(right) < len(left):
        right.append(Spacer(1, 1))
    name_grid = Table(list(zip(left, right)), colWidths=[3.4*inch, 3.4*inch])
    name_grid.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]))
    rows.append([name_grid])

    if len(alumni) > len(listed):
        rows.append([Paragraph(f"… and {len(alumni) - len(listed)} more in the system.", SMALLBODY)])

    t = Table(rows, colWidths=[6.9 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("BACKGROUND", (0, 1), (-1, -1), PANEL_SOFT),
        ("BOX", (0, 0), (-1, -1), 0.5, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def recruit_box(team):
    """High-visibility recruiting contact panel."""
    p = team["profile"]
    accent = LEVEL_COLOR[team["division"]]
    coach = g(p, "coach")
    email = g(p, "coachEmail")
    q = g(p, "recruitQuestionnaireUrl")
    sch = scholarship_line(team)
    roster_url = g(p, "baseballRosterUrl")

    rows = []
    rows.append([Paragraph("HOW TO GET ON THE RADAR", RECRUIT_LBL)])
    parts = []
    if coach and not is_tbd(coach):
        parts.append(f"Address communication to <b>{coach}</b>.")
    if email:
        parts.append(f'Email: <link href="mailto:{email}" color="#ffffff"><b>{email}</b></link>.')
    if q:
        parts.append(f'Fill out the recruiting questionnaire at <link href="{q}" color="#ffffff"><b>{q}</b></link>.')
    if sch:
        parts.append(f"Athletic aid: {sch}.")
    if roster_url:
        parts.append(f'Roster page: <link href="{roster_url}" color="#ffffff">{roster_url}</link>.')
    if not parts:
        parts.append("Direct contact information was not available for this program in the 2026 guide.")
    rows.append([Paragraph(" ".join(parts), RECRUIT_VAL)])

    t = Table(rows, colWidths=[6.9 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
    ]))
    return t


# ── Per-page builders ───────────────────────────────────────────────────────
def postseason_callout(team):
    """Small accent-colored banner highlighting a team's 2026 postseason
    result. Only renders for teams that actually played a postseason game."""
    info = POSTSEASON_2026.get(team["team_id"])
    if not info:
        return None
    accent = LEVEL_COLOR[team["division"]]
    label_style = ParagraphStyle("psn_label", fontName="Helvetica-Bold",
                                  fontSize=8, leading=10,
                                  textColor=colors.HexColor("#fff7cf"),
                                  alignment=TA_LEFT, tracking=1.5)
    value_style = ParagraphStyle("psn_value", fontName="Helvetica-Bold",
                                  fontSize=10.5, leading=12,
                                  textColor=colors.white,
                                  alignment=TA_LEFT)
    cell = [
        Paragraph("2026 POSTSEASON", label_style),
        Spacer(1, 1),
        Paragraph(info["headline"], value_style),
    ]
    t = Table([[cell]], colWidths=[6.9 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return t


def page1_snapshot(team):
    accent = LEVEL_COLOR[team["division"]]
    name = team["profile"].get("teamName") or team["school_name"]
    sub = "  ·  ".join(x for x in [team["mascot"], team.get("conference"),
                                   f'{team.get("city","")}, {team.get("state","")}'.strip(", ")] if x)
    header = Table(
        [[logo_flowable(team, box_size=1.4*inch),
          [Paragraph(esc(name), TEAMNAME), Spacer(1, 2), Paragraph(esc(sub), TEAMSUB)]]],
        colWidths=[1.55 * inch, 5.35 * inch],
    )
    header.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (0, 0), 0),
    ]))
    header._toc = (1, team["school_name"], f"team-{team['team_id']}")

    flow = [
        PageBreak(),
        header,
        Spacer(1, 4),
        HRFlowable(width="100%", thickness=2, color=accent, spaceAfter=6),
        stat_tiles(team),
    ]
    psc = postseason_callout(team)
    if psc:
        flow += [Spacer(1, 6), psc]
    flow += [
        Spacer(1, 6),
        Paragraph("THE PROGRAM", SECTION),
        Paragraph(program_intro(team), LEAD),
        Paragraph("THE 2026 SEASON", SECTION),
        Paragraph(season_recap(team), BODY),
        Paragraph("RECENT SEASONS", SECTION),
        WinBars(team["seasons"], accent),
    ]
    rs = rankings_strip(team)
    if rs:
        flow.append(Spacer(1, 4))
        flow.append(Paragraph("NATIONAL RANKINGS", SECTION))
        flow.append(rs)
    return flow


def _section_divider(team, title):
    """Inline section divider that visually opens a new chunk without a page
    break. Used when we let content flow inside a team's writeup."""
    accent = LEVEL_COLOR[team["division"]]
    return [
        Spacer(1, 14),
        HRFlowable(width="100%", thickness=1.5, color=accent, spaceAfter=4),
        Paragraph(title, PAGEHEAD_SUB),
        Spacer(1, 4),
    ]


def _kt(*items):
    """Wrap a section header + tables in a KeepTogether so the heading never
    sits orphaned at the bottom of a page while its table jumps to the next."""
    return KeepTogether(list(items))


def page2_indepth(team):
    """2026-season block. Flows naturally from page 1; no forced page break.
    Per Nate's note we wrap each table with its heading in KeepTogether so
    nothing splits across a page break."""
    flow = []
    flow += _section_divider(team, "2026 SEASON IN DEPTH")
    flow += [team_line_panel(team), Spacer(1, 8)]
    ht = hitter_table(team)
    if ht:
        flow += [_kt(Paragraph("TOP HITTERS BY WAR (MIN. 40 PA)", SECTION), ht), Spacer(1, 6)]
    pt = pitcher_table(team)
    if pt:
        flow += [_kt(Paragraph("TOP PITCHERS BY WAR (MIN. 15 IP)", SECTION), pt), Spacer(1, 6)]
    sp = standings_panel(team)
    if sp:
        conf_label = (team.get("conference") or "CONFERENCE").upper()
        # Standings can be tall; only KeepTogether for small conferences.
        cs = team.get("conf_standings") or {}
        if cs.get("standings") and len(cs["standings"]) <= 10:
            flow += [_kt(Paragraph(f"{conf_label} STANDINGS, 2026", SECTION), sp), Spacer(1, 6)]
        else:
            flow += [CondPageBreak(2.0 * inch),
                     Paragraph(f"{conf_label} STANDINGS, 2026", SECTION), sp, Spacer(1, 6)]
    rs = roster_snapshot(team)
    if rs:
        flow += [Paragraph("ROSTER SNAPSHOT", SECTION), rs]
    return flow


def page2b_roster_and_pipeline(team):
    """A 'Roster & Pipeline' block: class composition, freshman impact,
    hometowns by state, and team WAR trend. These graphics tell a recruit
    whether the program plays young, where the players come from, and where
    the team's value has been generated season by season."""
    flow = [Spacer(1, 8)]
    flow += _section_divider(team, "ROSTER, PIPELINE, AND WAR TREND")
    rc = roster_classes_panel(team)
    if rc:
        flow += [_kt(rc), Spacer(1, 8)]
    rb = roster_build_panel(team)
    if rb:
        flow += [_kt(rb), Spacer(1, 8)]
    fpp = freshman_production_panel(team)
    if fpp:
        flow += [_kt(fpp), Spacer(1, 8)]
    tr = transfer_reliance_panel(team)
    if tr:
        flow += [_kt(tr), Spacer(1, 8)]
    fp = freshman_panel(team)
    if fp:
        flow += [_kt(fp), Spacer(1, 8)]
    sp = states_panel(team)
    if sp:
        flow += [_kt(sp), Spacer(1, 8)]
    wp = war_by_season_panel(team)
    if wp:
        flow += [_kt(wp)]
    return flow


def page3_program(team):
    """Coach + program + recruiting block. Flows from the in-depth block."""
    flow = []
    flow += _section_divider(team, "PROGRAM, COACH, AND RECRUITING")
    flow += [Paragraph("HEAD COACH", SECTION)]
    flow.extend(coach_panel(team))
    a = assistants_panel(team)
    if a:
        flow += [Paragraph("COACHING STAFF", SECTION), a]
    flow += [Paragraph("PROGRAM FACTS", SECTION), facts_panel(team)]
    pap = pro_alumni_panel(team)
    if pap:
        flow += [Spacer(1, 8), _kt(pap)]
    flow += [Spacer(1, 8), _kt(recruit_box(team))]
    return flow


def team_flowables(team):
    return (page1_snapshot(team)
            + page2_indepth(team)
            + page2b_roster_and_pipeline(team)
            + page3_program(team))


def level_chapter(level):
    accent = level["color"]
    title = Paragraph(level["title"], S("lvltitle", fontName="Helvetica-Bold",
                                        fontSize=34, leading=38, textColor=accent))
    title._toc = (0, level["title"], f"level-{level['key']}")
    teams = [t for t in DATA if t["division"] == level["key"]]
    teams.sort(key=lambda t: (t.get("conference") or "", t["school_name"]))
    sub = Paragraph(level["subtitle"].upper() + f"  ·  {len(teams)} PROGRAMS",
                    S("lvlsub", fontName="Helvetica-Bold", fontSize=10, leading=14, textColor=MUTED))
    flow = [PageBreak(), Spacer(1, 0.4 * inch), title, Spacer(1, 4), sub,
            HRFlowable(width="100%", thickness=3, color=accent, spaceBefore=10, spaceAfter=16),
            Paragraph(PRIMERS[level["key"]], LEAD)]
    for t in teams:
        flow += team_flowables(t)
    return flow


# ── Document ────────────────────────────────────────────────────────────────
class TableTOC(_ReportlabTOC):
    """A drop-in replacement for reportlab's TableOfContents that renders the
    collected entries as a normal Platypus Table (two columns: title on the
    left, page number on the right). Avoids the dot-leader tab fills used by
    the default TOC, which several PDF-to-document converters (notably
    Google Docs) can't parse cleanly — entries end up jammed together when
    that converter runs over the file."""

    def wrap(self, availWidth, availHeight):
        rows = []
        for level, text, page, *_ in self._lastEntries or []:
            if level == 0:
                title_style = ParagraphStyle(
                    "tocL0", fontName="Helvetica-Bold", fontSize=12.5,
                    leading=18, textColor=INK, alignment=TA_LEFT)
                page_style = ParagraphStyle(
                    "tocL0p", fontName="Helvetica-Bold", fontSize=12.5,
                    leading=18, textColor=INK, alignment=2)  # TA_RIGHT
                rows.append([Paragraph(text, title_style), Paragraph(str(page), page_style)])
            else:
                title_style = ParagraphStyle(
                    "tocL1", fontName="Helvetica", fontSize=10,
                    leading=15, textColor=MUTED, leftIndent=18, alignment=TA_LEFT)
                page_style = ParagraphStyle(
                    "tocL1p", fontName="Helvetica", fontSize=10,
                    leading=15, textColor=MUTED, alignment=2)
                rows.append([Paragraph(text, title_style), Paragraph(str(page), page_style)])
        if not rows:
            self._table = None
            return (availWidth, 0)
        # Use most of the page width for the title; reserve a tidy column
        # for page numbers on the right.
        col_w = [availWidth - 0.7 * inch, 0.7 * inch]
        t = Table(rows, colWidths=col_w)
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ]))
        self._table = t
        w, h = t.wrap(availWidth, availHeight)
        return (w, h)

    def split(self, availWidth, availHeight):
        if not getattr(self, "_table", None):
            return []
        return self._table.split(availWidth, availHeight)

    def drawOn(self, canvas, x, y, _sW=0):
        if not getattr(self, "_table", None):
            return
        self._table.drawOn(canvas, x, y, _sW)


class BookDoc(BaseDocTemplate):
    def afterFlowable(self, flowable):
        toc = getattr(flowable, "_toc", None)
        if toc:
            level, text, key = toc
            self.canv.bookmarkPage(key)
            self.notify("TOCEntry", (level, text, self.page, key))
            self.canv.addOutlineEntry(text, key, level=level, closed=(level == 0))


def footer(canvas, doc):
    """Page footer.

    Stripped down to a single horizontal rule and a centered page number.
    The previous footer included the brand wordmark and a URL, but every
    text-extraction path (including the Google Docs PDF importer) pulls
    canvas-drawn text into the page body, which caused the wordmark to land
    inline with the TOC entries when the file was opened in Google Docs.
    Keeping only the page number means the only thing readers see in an
    extracted-text view is a small "12"-style integer between sections,
    which doesn't jumble the layout. Brand and URL still live on the cover.

    The drawing operations are also wrapped in beginMarkedContent('Artifact')
    so structure-aware viewers can skip them entirely, but we don't rely on
    that being respected.
    """
    if doc.page == 1:
        return
    canvas.saveState()
    try:
        canvas.beginMarkedContent("Artifact")
    except Exception:
        pass
    canvas.setStrokeColor(HAIRLINE)
    canvas.setLineWidth(0.5)
    canvas.line(0.75 * inch, 0.55 * inch, 7.75 * inch, 0.55 * inch)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawCentredString(4.25 * inch, 0.38 * inch, str(doc.page))
    try:
        canvas.endMarkedContent()
    except Exception:
        pass
    canvas.restoreState()


def cover_and_intro():
    counts = {lv["key"]: sum(1 for t in DATA if t["division"] == lv["key"]) for lv in LEVELS}
    cover = [
        Spacer(1, 1.5 * inch),
        Paragraph("PACIFIC NORTHWEST", S("c1", fontName="Helvetica-Bold", fontSize=15,
                                         leading=18, textColor=MUTED, alignment=TA_CENTER)),
        Spacer(1, 6),
        Paragraph("College Baseball", S("c2", fontName="Helvetica-Bold", fontSize=46,
                                        leading=50, textColor=INK, alignment=TA_CENTER)),
        Paragraph("Program Guide", S("c3", fontName="Helvetica-Bold", fontSize=46,
                                     leading=52, textColor=LEVEL_COLOR["D1"], alignment=TA_CENTER)),
        Spacer(1, 14),
        HRFlowable(width="50%", thickness=2.5, color=LEVEL_COLOR["NAIA"], hAlign="CENTER"),
        Spacer(1, 16),
        Paragraph(f"{len(DATA)} Programs  ·  Five Levels  ·  The 2026 Season",
                  S("c4", fontName="Helvetica", fontSize=13, leading=18,
                    textColor=MUTED, alignment=TA_CENTER)),
        Spacer(1, 0.4 * inch),
        Paragraph("A complete recruit and fan reference, built from the NWBB Stats database.",
                  S("ctag", fontName="Helvetica-Oblique", fontSize=10.5, leading=14,
                    textColor=LIGHT, alignment=TA_CENTER)),
        Spacer(1, 2.0 * inch),
        Paragraph("nwbaseballstats.com",
                  S("c5", fontName="Helvetica-Bold", fontSize=11,
                    textColor=LIGHT, alignment=TA_CENTER)),
        PageBreak(),
    ]
    about = [
        Paragraph("About This Guide",
                  S("ab", fontName="Helvetica-Bold", fontSize=22, textColor=INK)),
        HRFlowable(width="100%", thickness=2, color=LEVEL_COLOR["D1"],
                   spaceBefore=8, spaceAfter=14),
        Paragraph(
            f"This guide profiles all {len(DATA)} four-year and junior-college baseball programs in the "
            "Pacific Northwest, organized by competitive level. It is built for recruits, families, "
            "coaches, and fans who want a single, deep reference to the region's college baseball "
            "landscape, from the biggest D1 programs to the smallest NWAC schools.",
            LEAD),
        Paragraph(
            "Each program is given three pages. The first is a snapshot that introduces the school, "
            "summarizes the 2026 season, and shows how the program has trended over recent years. "
            "The second is a stats-focused breakdown with the team's top hitters and pitchers, the "
            "full conference standings, team batting and pitching lines, and national rankings where "
            "available. The third is built for the recruiting decision itself: a head-coach feature, "
            "coaching staff, stadium and facility details, the full academic and financial profile, "
            "location notes, and a direct contact panel for the program.",
            LEAD),
        Paragraph(
            "Records and statistics are drawn from the NWBB Stats season database; program details "
            "come from original research compiled by the NWBB Stats team. Where a field is missing, "
            "the source data was not available at the time of publication.",
            LEAD),
        Spacer(1, 10),
        Paragraph("WHAT'S INSIDE", SECTION),
        Table([[Paragraph(f"<b>{lv['title']}</b>", FACTVAL),
                Paragraph(lv["subtitle"], FACTVAL),
                Paragraph(f"{counts[lv['key']]} programs", FACTVAL)] for lv in LEVELS],
              colWidths=[1.6 * inch, 4.0 * inch, 1.2 * inch],
              style=TableStyle([("LINEBELOW", (0, 0), (-1, -2), 0.4, HAIRLINE),
                                ("TOPPADDING", (0, 0), (-1, -1), 5),
                                ("BOTTOMPADDING", (0, 0), (-1, -1), 5)])),
        Spacer(1, 12),
        Paragraph("HOW TO READ EACH PAGE", SECTION),
        Paragraph(
            "The colored stat strip at the top of each snapshot page summarizes the 2026 season at "
            "a glance: overall record, conference record, run differential, team batting average, "
            "team ERA, and either the team's conference finish or the school's undergraduate "
            "enrollment. The win-percentage bar graphic shows the last six seasons of results. On "
            "the in-depth page, hitter tables list players with at least 40 plate appearances, "
            "sorted by OPS; pitcher tables list players with at least 15 innings pitched, sorted by "
            "ERA. wRC+ and ERA- are league-adjusted metrics where 100 is league average, higher is "
            "better for hitters, and lower is better for pitchers.",
            BIO),
        PageBreak(),
    ]
    return cover + about


def build():
    frame = Frame(0.75 * inch, 0.75 * inch, 7.0 * inch, 9.3 * inch, id="body")
    doc = BookDoc(str(OUT), pagesize=letter,
                  title="Pacific Northwest College Baseball Program Guide (2026)",
                  author="NWBB Stats")
    doc.addPageTemplates([PageTemplate(id="body", frames=[frame], onPage=footer)])

    toc = TableTOC()
    toc.levelStyles = [
        ParagraphStyle("toc0", fontName="Helvetica-Bold", fontSize=12.5, leading=22,
                       textColor=INK, spaceBefore=8),
        ParagraphStyle("toc1", fontName="Helvetica", fontSize=10, leading=15,
                       leftIndent=18, textColor=MUTED),
    ]

    story = cover_and_intro()
    story += [Paragraph("Table of Contents",
                        S("toctitle", fontName="Helvetica-Bold", fontSize=22, textColor=INK)),
              HRFlowable(width="100%", thickness=2, color=LEVEL_COLOR["D1"],
                         spaceBefore=8, spaceAfter=12),
              toc]
    for level in LEVELS:
        story += level_chapter(level)

    doc.multiBuild(story)
    print(f"Built {OUT}")


if __name__ == "__main__":
    build()
