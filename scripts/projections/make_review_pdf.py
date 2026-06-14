"""Generate the NWBB Stats projection-system review PDF for the intern group."""
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, PageBreak,
                                Table, TableStyle, ListFlowable, ListItem, HRFlowable)
from reportlab.lib.enums import TA_CENTER, TA_LEFT

OUT = "/Users/naterasmussen/Desktop/NWBB_Projection_System_Review.pdf"

TEAL = colors.HexColor("#0f766e")
NAVY = colors.HexColor("#1f2937")
MAROON = colors.HexColor("#7f1d1d")
LIGHT = colors.HexColor("#f1f5f9")
GREY = colors.HexColor("#64748b")

ss = getSampleStyleSheet()
S = {}
S['title'] = ParagraphStyle('title', parent=ss['Title'], fontSize=26, leading=30, textColor=NAVY, spaceAfter=6)
S['subtitle'] = ParagraphStyle('subtitle', parent=ss['Normal'], fontSize=13, leading=17, textColor=GREY, alignment=TA_CENTER, spaceAfter=4)
S['h1'] = ParagraphStyle('h1', parent=ss['Heading1'], fontSize=18, leading=22, textColor=TEAL, spaceBefore=16, spaceAfter=8)
S['h2'] = ParagraphStyle('h2', parent=ss['Heading2'], fontSize=13.5, leading=17, textColor=NAVY, spaceBefore=12, spaceAfter=4)
S['body'] = ParagraphStyle('body', parent=ss['Normal'], fontSize=10.5, leading=15, textColor=NAVY, spaceAfter=7, alignment=TA_LEFT)
S['bullet'] = ParagraphStyle('bullet', parent=S['body'], leftIndent=14, spaceAfter=3)
S['cap'] = ParagraphStyle('cap', parent=ss['Normal'], fontSize=9, leading=12, textColor=GREY, spaceAfter=10)
S['callh'] = ParagraphStyle('callh', parent=ss['Normal'], fontSize=10.5, leading=14, textColor=colors.white, fontName='Helvetica-Bold')
S['callb'] = ParagraphStyle('callb', parent=ss['Normal'], fontSize=10, leading=14, textColor=NAVY)
S['cell'] = ParagraphStyle('cell', parent=ss['Normal'], fontSize=9, leading=12, textColor=NAVY)
S['cellb'] = ParagraphStyle('cellb', parent=S['cell'], fontName='Helvetica-Bold')
S['cellw'] = ParagraphStyle('cellw', parent=S['cell'], textColor=colors.white, fontName='Helvetica-Bold')

story = []

def P(t, st='body'): story.append(Paragraph(t, S[st]))
def gap(h=8): story.append(Spacer(1, h))
def bullets(items, st='bullet'):
    story.append(ListFlowable([ListItem(Paragraph(i, S[st]), leftIndent=10, value='•') for i in items],
                              bulletType='bullet', start='•', leftIndent=8))
    gap(4)

def callout(title, body):
    inner = [[Paragraph(title, S['callh'])], [Paragraph(body, S['callb'])]]
    t = Table(inner, colWidths=[6.6*inch])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (0,0), TEAL),
        ('BACKGROUND', (0,1), (0,1), LIGHT),
        ('LEFTPADDING',(0,0),(-1,-1),10),('RIGHTPADDING',(0,0),(-1,-1),10),
        ('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),8),
        ('LINEBELOW',(0,0),(0,0),0,colors.white)]))
    story.append(t); gap(10)

def dtable(header, rows, widths, fontsize=9):
    data = [[Paragraph(h, S['cellw']) for h in header]]
    for r in rows:
        data.append([Paragraph(str(c), S['cell']) for c in r])
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0), NAVY),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, LIGHT]),
        ('GRID',(0,0),(-1,-1),0.5, colors.HexColor("#cbd5e1")),
        ('VALIGN',(0,0),(-1,-1),'TOP'),
        ('LEFTPADDING',(0,0),(-1,-1),5),('RIGHTPADDING',(0,0),(-1,-1),5),
        ('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),4)]))
    story.append(t); gap(10)

# ───────────────────────── COVER ─────────────────────────
gap(150)
P("NWBB Stats", 'title')
P("Player Projection System", 'subtitle')
P("How the 2027 Projections Are Built, Why They Work, and What's Left", 'subtitle')
gap(20)
story.append(HRFlowable(width="40%", thickness=2, color=TEAL, spaceAfter=20, hAlign='CENTER'))
P("An in-depth technical review for the analytics intern group", 'subtitle')
P("Pacific Northwest college baseball &middot; NCAA D1/D2/D3, NAIA, NWAC", 'subtitle')
P("Prepared June 2026", 'subtitle')
story.append(PageBreak())

# ───────────────────────── 1. PHILOSOPHY ─────────────────────────
P("1. What We Are Building and the Core Philosophy", 'h1')
P("The projection system forecasts every returning and incoming player's 2027 season for all 57+ "
  "PNW teams across five levels (D1, D2, D3, NAIA, and NWAC junior college). For each player it "
  "produces a full hitting or pitching line plus playing time, value (WAR), a range of outcomes, "
  "and flags for breakout candidates and limited-data players.")
P("The whole system rests on one idea, which is the most important thing for an intern to internalize:")
callout("The central principle",
        "The model's job is to <b>rank players by skill</b> — the things a player actually controls and "
        "repeats year to year. It is NOT the model's job to invent the absolute numbers. Those come from "
        "<b>what players at that exact level actually do</b>. So we separate two questions: (1) <i>how good is "
        "this player relative to his peers?</i> (the model), and (2) <i>what does a player of that caliber at "
        "that level actually produce?</i> (the league's real distribution).")
P("This matters because raw season stats are a mix of <b>skill</b> and <b>luck</b>. A .360 hitter is partly "
  "good and partly lucky (balls found grass). If you just project last year's number forward, you carry the "
  "luck with it and every projection regresses to a bland middle. Instead we lean on the stats a player "
  "<i>repeats</i>, regress the noisy ones hard, and then stretch the result back out to the realistic, "
  "level-appropriate spread.")
P("A deliberate product decision (made by the owner, not a statistical default): we prioritize "
  "<b>distributional realism over RMSE-optimal medians</b>. A pure accuracy-minimizing model compresses "
  "everyone toward the mean because that lowers average error. We accept slightly higher error in exchange "
  "for projections that span the range players really achieve, so the best hitter projects near .400 and a "
  "true ace projects sub-3.00, instead of everyone bunched around the average.")

# ───────────────────────── 2. DATA ─────────────────────────
P("2. The Data We Project From", 'h1')
bullets([
  "<b>Three seasons of box-score stats</b> (2024-2026) per player, from the per-season batting_stats / "
  "pitching_stats tables. These are the backbone.",
  "<b>Play-by-play (PBP) peripherals</b> derived from 45,000+ parsed plate appearances: swing rate, "
  "whiff rate, called-strike rate, ground-ball / fly-ball / line-drive rates, pull-air rate, and pitch "
  "strike%. Coverage is roughly 85-90% on batted-ball type and about 50% of pitchers have enough PBP to "
  "use their fly-ball rate.",
  "<b>Class / year-in-school</b> for aging, and <b>height/weight/handedness</b> where available.",
  "<b>Transfer and commitment data</b>: a curated transfer-portal file plus each player's committed_to "
  "field, used to place transfers on their 2027 destination team at the right level.",
])
P("Roster construction for 2027: returning players stay on their team; graduating seniors and departed "
  "NWAC sophomores are removed; players who commit elsewhere reappear on their new team, with their stats "
  "translated to the new level. Incoming freshmen are not in the data yet (an important caveat in Section 9).")

# ───────────────────────── 3. PIPELINE ─────────────────────────
P("3. The Projection Pipeline (Step by Step)", 'h1')
P("Every player flows through the same seven stages. Stages 1-5 produce a skill estimate; stage 6 turns "
  "that estimate into calibrated, realistic numbers; stage 7 builds the displayed line.")
dtable(
  ["#", "Stage", "What it does"],
  [["1", "Weighted history", "Blend the player's last three seasons with 5/4/3 recency weights, each season also weighted by its sample size (PA or batters faced)."],
   ["2", "Level translation", "If a player changed levels (e.g. NWAC to a 4-year), shift each stat by the amount real transfers historically gained or lost on that move."],
   ["3", "Regression", "Pull each stat toward the class-and-level league mean. Noisy stats get pulled hard; repeatable skills are barely touched (Section 4)."],
   ["4", "Aging", "Apply a small class-to-class development step (e.g. freshman to sophomore)."],
   ["5", "Skill refinement", "For select stats, replace the raw projection with a model built on stabler PBP inputs (e.g. project a pitcher's walk rate partly from his strike-throwing)."],
   ["6", "Per-level mapping", "Map each player's projected RANK within his level onto that level's ACTUAL stat distribution. De-compresses the spread and calibrates to the run environment (Section 5). This is the heart of the system."],
   ["7", "Reconstruction", "Derive the dependent stats (OBP, wOBA, SLG, WHIP, opponent AVG) from the mapped skills, assign playing time, and build the counting line."]],
  [0.4*inch, 1.5*inch, 4.7*inch])

story.append(PageBreak())

# ───────────────────────── 4. CORE METHODS ─────────────────────────
P("4. Core Methods Explained", 'h1')

P("4.1 Recency weighting", 'h2')
P("Recent seasons matter more, but a 200-PA season is more trustworthy than a 40-PA one. We weight each "
  "of the last three seasons by 5/4/3 (most recent highest) <i>and</i> by its sample size, so a big recent "
  "season dominates and a tiny one barely registers. Summer-league data is folded in at reduced weight with "
  "a wood-to-metal-bat correction.")

P("4.2 Regression and reliability (the most important method)", 'h2')
P("Regression to the mean is how we strip luck out. We add a number of 'phantom' league-average plate "
  "appearances (the ballast) to a player's record. A player with little data ends up near league average; a "
  "player with a lot of data keeps his own number. The size of the ballast is set by how repeatable the stat "
  "is, measured by its year-to-year self-correlation r:")
callout("Ballast formula",
        "ballast = n &times; (1 &minus; r) / r, where n is a typical season's sample and r is the stat's "
        "year-to-year correlation. A high-r (repeatable) stat needs little ballast; a low-r (luck-driven) "
        "stat needs a lot, so it regresses hard toward the mean.")
P("On top of this we apply a deliberate <b>0.6&times; trust multiplier</b> to the most repeatable skills "
  "(ISO, strikeout rate, home-run rate, wOBA-on-contact), shrinking their ballast further so proven skills "
  "keep their character instead of being pulled to average. This is the lever that lets a true masher stay a "
  "masher.")

P("4.3 Level translations", 'h2')
P("Players change levels constantly (especially NWAC sophomores moving to 4-year schools). We learned, from "
  "real transfer pairs in our own data, how each stat actually changes on each move, then apply that shift, "
  "shrunk by how many transfers we have for that move. The single most important finding for PNW: power "
  "translates very differently by destination.")
dtable(
  ["NWAC &rarr; ...", "wOBA", "AVG", "ISO", "K%", "(transfers)"],
  [["D1", "-.059", "-.049", "-.028", "+8.7 pts", "18"],
   ["D2", "-.011", "-.004", "+.009", "+2.8 pts", "36"],
   ["NAIA", "+.016", "+.012", "+.052", "+1.7 pts", "39"]],
  [1.3*inch, 0.9*inch, 0.9*inch, 0.9*inch, 1.0*inch, 1.0*inch])
P("Read it like this: a hitter moving from NWAC to D1 loses contact and strikes out far more (the level is "
  "much harder), but a hitter moving to NAIA actually gains power. The model bakes this in automatically.", 'cap')

P("4.4 The per-level quantile map (de-compression + calibration)", 'h2')
P("This is the stage that makes the numbers look real, and it is the cleverest part of the system, so it is "
  "worth understanding well. After stages 1-5, every projection is <b>too compressed</b> — regression has "
  "squeezed everyone toward the middle, which is statistically 'safe' but produces a board where every "
  "hitter is .270-.300 and every ERA is ~5. Real seasons are far more spread out.")
P("We fix this by mapping each player's projected <b>rank</b> within his level onto that level's <b>actual</b> "
  "stat distribution. The best projected hitter at NAIA gets the AVG of the best actual NAIA hitter; the median "
  "gets the median; and so on. Two things happen at once:")
bullets([
  "<b>De-compression</b>: the spread is stretched back out to match reality (best hitter ~.400, ERAs from "
  "sub-2 to 8+).",
  "<b>Per-level calibration</b>: because each level is mapped to its OWN distribution, every stat is "
  "automatically scaled to that league's run environment. NWAC homers leave the yard on ~3.7% of fly balls "
  "vs ~9% at the 4-year levels, so NWAC HR/9 lands near 0.28 while NAIA is 0.83 — the model never has to be "
  "told this; it falls out of mapping to each level's real numbers."])
callout("A subtlety interns should know",
        "We map only projected REGULARS onto the qualified-player distribution. If we mapped the whole roster "
        "(including bench and unproven players), the bench would fill the bottom ranks and shove every starter "
        "above the league median, making it look like every starter hits .300+. Mapping regulars to the "
        "regular distribution keeps the right share of .300 hitters per team.")

story.append(PageBreak())

P("4.5 Map the skills, derive everything else", 'h2')
P("A hard lesson (and a real bug we caught): only the <b>independent skills</b> get mapped — AVG, ISO, "
  "home-run rate, strikeout%, walk%, FIP. The <b>dependent stats</b> are then DERIVED from those so they stay "
  "internally consistent. We learned this when on-base percentage was being mapped on its own and a hitter "
  "with a 3% walk rate showed an OBP 110 points above his average, which is impossible. Now:")
bullets([
  "<b>OBP</b> = (hits + walks + hit-by-pitch) / (at-bats + walks + HBP + sac flies), using the real per-level "
  "HBP rate (~3% of PA in college, which we had badly underestimated).",
  "<b>wOBA</b> is built from the reconstructed slash with linear weights.",
  "<b>SLG</b> is recomputed from the actual reconstructed hits, so the slash line always adds up.",
  "<b>Opponent AVG and WHIP</b> (pitchers) are derived from strikeout%, home-run rate, walk%, and a regressed "
  "BABIP, so WHIP and opponent AVG always agree with each other and with the skills."])

P("4.6 Playing time", 'h2')
P("Counting stats need plate appearances and innings. We anchor each team's total PA and IP to its level's "
  "average team totals, then distribute them: hitters by a depth-chart share (who played each position most, "
  "with the best idle bat at DH and rest days for everyone), pitchers by quality plus strike-throwing "
  "durability (an ace draws ~80 IP down to mop-up arms). Every player is capped at that level's realistic "
  "individual max so no one is over-allocated.")

P("4.7 Limited-data handling and breakouts", 'h2')
bullets([
  "A player with under ~60 career PA/BF is regressed toward a below-average (25th-percentile) anchor — "
  "unproven players are usually not good, because the good ones earn playing time.",
  "Under ~10 PA / ~5 IP we show 'not enough data to project' rather than invent a line, while still listing "
  "the player.",
  "<b>Breakout flag (rocket icon)</b>: hitters with a real track record, an unlucky-low BABIP, and a big "
  "projected jump; pitchers whose 2026 ERA sat well above their FIP (bad-luck run prevention) and who project "
  "a real ERA drop. About 65 players league-wide qualify."])

P("4.8 WAR", 'h2')
P("Projected WAR uses the exact same formula as the actual-season WAR on player pages, so projected and real "
  "WAR are directly comparable: batting runs from projected wOBA vs the level's league wOBA, plus positional "
  "adjustment and replacement level; pitching from projected FIP vs league FIP scaled by innings.")

story.append(PageBreak())

# ───────────────────────── 5. STAT BY STAT ─────────────────────────
P("5. How Each Stat Is Projected", 'h1')
P("Hitters:", 'h2')
dtable(
  ["Stat", "How it is projected"],
  [["AVG", "Regressed, refined from K%/BABIP/line-drive rate, then mapped to the level distribution."],
   ["ISO", "Regressed (lightly — it is a stable skill), then mapped per level."],
   ["HR", "From DEMONSTRATED career ISO (sample-regressed so small samples can't fake power), mapped per level, x PA."],
   ["OBP / wOBA", "Derived from the mapped AVG, walk%, and the real per-level HBP rate."],
   ["BB% / K%", "Regressed plus a PBP refine: walk rate leans on swing rate, strikeout rate on whiff and swing rates."],
   ["2B / 3B", "Split out of the mapped ISO after removing the bases from HR, by the player's career mix."],
   ["PA", "Share of the team's level-average PA, by depth-chart playing time, capped at the level max."]],
  [1.1*inch, 5.5*inch])

P("Pitchers:", 'h2')
dtable(
  ["Stat", "How it is projected"],
  [["FIP", "Run-estimator on projected K/BB/HR, mapped per level. The skill backbone."],
   ["ERA", "FIP plus only 16% of the pitcher's career ERA-minus-FIP gap, so no one is projected to keep getting lucky."],
   ["K% / BB%", "50/50 blend of the pitcher's track record and a strike%/whiff% skill anchor, so command/stuff move the number but a proven record is not overwritten."],
   ["HR/9", "xFIP-style: projected fly-ball rate x the level's home-run-per-fly-ball rate, mapped per level."],
   ["WHIP / Opp AVG", "Derived from K%, HR rate, walk%, and a regressed BABIP (pitchers barely control BABIP)."],
   ["IP", "Share of the team's level-average innings, by quality and durability, capped; shown in baseball notation."]],
  [1.1*inch, 5.5*inch])

# ───────────────────────── 6. PREDICTIVENESS ─────────────────────────
P("6. Which Stats Are Predictive (and Which Are Noise)", 'h1')
P("The single best guide to projecting a stat is its year-to-year self-correlation r: how much a player's "
  "number in one season predicts his number the next. High r = a repeatable skill we can trust; low r = "
  "mostly luck or small-sample noise that must be regressed hard. These are measured from our own PNW data:")
dtable(
  ["Stat", "Year-over-year r", "Verdict", "How we treat it"],
  [["Pull-air rate", ".72", "Very stable", "Trust heavily"],
   ["HR rate (per PA)", ".61", "Stable", "Light regression"],
   ["ISO (power)", ".60", "Stable", "Light regression"],
   ["Strikeout rate", ".60", "Stable", "Light regression"],
   ["wOBA-on-contact", ".51", "Stable", "Light regression"],
   ["Strike-throwing %", "~.55", "Stable (pitchers)", "Anchor walk/K projections to it"],
   ["HR allowed / BF", ".34", "Volatile", "Use fly-ball% instead (xFIP)"],
   ["WHIP", ".34", "Volatile", "Derive from skills, regress"],
   ["ERA", ".30", "Volatile", "Project from FIP, not from ERA"],
   ["BABIP (hitter/pitcher)", ".28 / .21", "Mostly luck", "Regress hard to league mean"]],
  [1.7*inch, 1.3*inch, 1.4*inch, 2.2*inch])
P("This table is why, for example, we never project a pitcher's ERA from his ERA — we project his FIP (built "
  "from the things he controls: strikeouts, walks, home runs) and derive ERA from that. It is also why a "
  "pitcher's fly-ball rate (stable) drives his home-run projection rather than his actual home runs allowed "
  "(noisy).", 'cap')

story.append(PageBreak())

# ───────────────────────── 7. VALIDATION ─────────────────────────
P("7. How We Know It Works (Validation)", 'h1')
P("7.1 Leakage-free backtest", 'h2')
P("The model is fit only on seasons before the test year, then asked to predict the held-out year, so it "
  "never sees the answer. On that honest test our model beats a standard Marcel baseline (the industry "
  "reference projection) on both sides: hitter wOBA error and pitcher ERA error.")

P("7.2 Calibration against the real league", 'h2')
P("Beyond rank accuracy, we check that the projected distributions match what the league actually produces. "
  "After the latest round of fixes the projected regulars line up closely with the 2026 actuals:")
dtable(
  ["Stat", "Actual (2026)", "Projected", "Status"],
  [["Hitter OBP", ".381", ".378", "Calibrated"],
   ["Hitter wOBA", ".353", ".350", "Calibrated"],
   ["% of regulars hitting .300+ (D2)", "56%", "57%", "Calibrated"],
   ["% of regulars hitting .300+ (NWAC)", "25%", "23%", "Calibrated"],
   ["Pitcher HR/9 (NAIA)", "0.83", "0.83", "Calibrated, per level"],
   ["Pitcher HR/9 (NWAC)", "0.28", "0.28", "Calibrated, per level"],
   ["Team PA total (NAIA)", "2117", "2059", "Within 3%"],
   ["Team IP total (D2/D3/NAIA)", "350-442", "matches", "Within 3%"]],
  [2.6*inch, 1.3*inch, 1.2*inch, 1.5*inch])
P("The per-team PA and IP totals are anchored to each level's average and distributed across the roster, so "
  "teams add up to realistic full-season figures.", 'cap')

# ───────────────────────── 8. WHAT'S LEFT ─────────────────────────
P("8. What Still Needs Work (Not Yet Mastered)", 'h1')
P("This is the honest list — the places we know the model is weakest and where the interns can help most.")

P("8.1 Incomplete rosters", 'h2')
P("Incoming freshmen and not-yet-announced transfers are not in the data. So D1 and NWAC team totals run "
  "below their level average (those levels lose the most players to the draft, transfers, and graduation). As "
  "rosters fill, totals will climb to the level average automatically. We deliberately do not cram a full "
  "season onto a half-roster.")

P("8.2 ERA spread is compressed by design", 'h2')
P("Because ERA is anchored to FIP and we project only a sliver of luck, projected ERAs are less spread than "
  "real ERAs — a pitcher who ran a lucky 2.40 over a 4.50 FIP is projected near his FIP. This is intentional "
  "(we don't project luck to repeat), but a future 'stuff'-based component (velocity, pitch shapes) could "
  "justify more spread for genuinely elite arms.")

P("8.3 Limited batted-ball coverage", 'h2')
P("Only about half of pitchers have enough play-by-play for a fly-ball-based HR projection, and we have no "
  "true exit-velocity or launch-angle data (no Trackman at this level). Better batted-ball data would unlock "
  "expected-stats (xwOBA, xERA) and much sharper power and contact projections.")

P("8.4 Other open items", 'h2')
bullets([
  "<b>No park factors.</b> Hitter-friendly and pitcher-friendly home parks are not yet adjusted for.",
  "<b>Aging is coarse.</b> We use class-to-class steps, not true age/biological development curves; "
  "height/weight are not yet used as priors.",
  "<b>wOBA weights are flat,</b> not level-specific (a minor calibration refinement).",
  "<b>No platoon / handedness splits</b> and no strength-of-schedule adjustment.",
  "<b>Transfer destinations are partly manual.</b> A curated portal file plus name-matching places transfers; "
  "out-of-region schools that share a city name with a PNW team must be handled by hand.",
  "<b>Two-way players and role changes</b> (a reliever who becomes a starter, a position player who pitches) "
  "are still approximate."])

gap(6)
story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#cbd5e1"), spaceAfter=10))
P("Bottom line: the model is good at <b>ranking</b> players by repeatable skill and at producing "
  "<b>level-calibrated, realistic</b> stat lines. The frontier is better inputs (batted-ball data, parks, "
  "bios) and completing rosters. Those are where the next gains come from.", 'cap')

doc = SimpleDocTemplate(OUT, pagesize=letter, topMargin=0.8*inch, bottomMargin=0.7*inch,
                        leftMargin=0.9*inch, rightMargin=0.9*inch,
                        title="NWBB Projection System Review", author="NWBB Stats")
doc.build(story)
print("wrote", OUT)
