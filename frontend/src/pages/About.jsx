// About — the story behind NW Baseball Stats.
//
// Sections (in order):
//   1. Hero stats   - big "wow" counters pulled from /site-stats
//   2. The Team     - Nate's bio + intern roster (placeholders ready for blurbs)
//   3. Behind the   - how the site was built (tech stack, LOC chart, data pipeline)
//      Curtain
//   4. Coverage     - teams + data sources
//   5. Run Environ. - division-by-division run context + comparison chart
//   6. Stat Glossary- batting / pitching / advanced / WAR (deep)
//
// No "Site Updates" section here anymore; updates live elsewhere.

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, Cell,
} from 'recharts'


// ───────────────────────────────────────────────────────────────────
//  Repo line-count snapshot (regenerate periodically; counted via
//    find . -type f \( ... \) | xargs wc -l   on 2026-05-25).
//  This is intentionally a static figure so the page can render
//  without a separate API call. Update when it drifts meaningfully.
// ───────────────────────────────────────────────────────────────────
const LOC = {
  frontend: 96_202,   // src/*.jsx + js + css
  backend:  34_077,   // backend/app/**.py (excludes .venv)
  scripts:  47_532,   // scrapers, migrations, jobs
}
LOC.total = LOC.frontend + LOC.backend + LOC.scripts


// ───────────────────────────────────────────────────────────────────
//  Hours spent pair-coding with Claude on this project.
//  Source: parse ~/.claude/projects/**/*.jsonl session logs and group
//  consecutive message timestamps into "active sessions" (gap >10min
//  closes a session). Local logs retain ~14 days of sessions; the
//  full project has 53 active commit-days at a measured 3.8h/active-day
//  rate, so 200+ is a conservative lower bound.
//  Update by re-running the audit script periodically.
// ───────────────────────────────────────────────────────────────────
const CLAUDE_HOURS = 200


// ─── Interns. Each entry: name, role, headshot (path or null), blurb.
//     Set bioPending: true when the person is on the team but hasn't
//     submitted a bio yet — that swaps the blurb for a small
//     placeholder line instead of leaving the card looking empty.
const INTERNS = [
  {
    name: 'Kai Malloch',
    role: 'Intern',
    headshot: '/team-photos/kai-malloch.jpg',
    blurb: 'Kai is a high school baseball player at Nathan Hale High School and a youth pitching coach working with the 13U to 15U age groups. He builds independent player development projects to further understand pitching and showcase his work, including regression models that look at how factors like bodyweight and sleep impact pitching velocity, plus deep dives into MLB pitching arsenals. He plans to attend either Gonzaga University or the University of Washington to study Business Administration and Finance, with hopes to work in professional baseball operations.',
  },
  // For interns who play college ball in the PNW, `headshot` is the
  // same URL their player profile page renders (sourced from each
  // school's Sidearm CDN). If a school re-uploads a photo and the URL
  // changes, update both here and the players row at the same time.
  {
    name: 'Connor Broschard',
    role: 'Intern',
    playerId: 3336,
    headshot: 'https://golcathletics.com/images/2025/12/16/Conor_Broschard_IWQMZ.jpg?width=80&quality=90',
    blurb: 'Connor is an outfielder and pitcher at Lewis & Clark College, originally from Fairfield, California. He is studying Rhetoric and Media Studies with a minor in Entrepreneurial Leadership and Innovation. He has been fascinated by baseball stats and baseball media for as long as he can remember, and hopes to work professionally in the baseball world someday, whether in the media landscape or in a front office or scouting role. He is also a diehard Boston Red Sox fan.',
    highlight: { pct: 91, label: 'Opponent wOBA', value: '.252' },
    built: { label: 'Player Comparison Tool', to: '/player-comps' },
  },
  {
    name: 'Oliver Duthie',
    role: 'Intern',
    playerId: 3002,
    headshot: 'https://gothunderbirds.ca/images/2026/1/6/BASE_Oliver_Duthie.jpg?width=80&quality=90',
    blurb: 'Oliver recently graduated from the University of British Columbia, where he spent five years as a left-handed pitcher. Born and raised in Dubai, United Arab Emirates, he moved to Canada for school and immersed himself in analytics, player development, pitch design, and scouting, handling advance reports on opposing teams along the way. Whether he is building models in R, analyzing pitch shapes, or studying how arsenals and lineups fit together, he is focused on using data and technology to help players improve, with the goal of contributing to a professional baseball organization.',
    highlight: { pct: 99, label: 'First-Pitch Strike%', value: '70.6%' },
    built: { label: 'Pro Tracker', to: '/pro-tracker' },
  },
  {
    name: 'Trevor Kazahaya',
    role: 'Intern',
    playerId: 3352,
    headshot: 'https://goboxers.com/images/2026/2/23/0_Trevor_Kazahaya.jpg?width=80&quality=90',
    blurb: 'Trevor is a student-athlete from Rancho Santa Margarita, California, studying Business Administration with concentrations in Accounting and Finance at Pacific University. A member of the Pacific Boxers, he is drawn to the analytical side of the game: player development, scouting, performance evaluation, and advanced metrics. His focus is combining modern analytics with on-field experience to give coaches, players, and fans meaningful insight, and to make advanced data more accessible across D2, D3, NAIA, and JUCO programs in the Pacific Northwest.',
    highlight: { pct: 90, label: 'wRC+ (D3)', value: '133' },
    built: { label: 'Player Comparison Tool', to: '/player-comps' },
  },
  {
    name: 'Zack Ahn',
    role: 'Intern',
    headshot: '/team-photos/zack-ahn.jpg',
    blurb: 'Zack is a Washington-based student-athlete and catching coordinator focused on player development and baseball analytics. He works alongside former MLB pitcher Casey Sadler on youth player development, and is graduating from Eastlake High School with an associate degree earned through Central Washington University\'s Running Start program. A lifelong Seattle Mariners season-ticket holder, he hopes to play college baseball and work in its analysis.',
  },
  {
    name: 'Nate Petz',
    role: 'Intern',
    playerId: 3253,
    headshot: 'https://athletics.whitman.edu/images/2025/11/7/Petz_HS.jpg?width=80&quality=90',
    blurb: 'Nate is from West Sacramento, California, and plays baseball while studying statistics at Whitman College. He has been All-Conference at both second base and catcher, and loves digging into advanced analytics, especially when they involve his friends and teammates.',
    highlight: { pct: 94, label: 'WAR', value: '1.4' },
    built: { label: 'Goose Eggs (Reliever Leaders)', to: '/relievers' },
  },
  {
    name: 'Luke Malzewski',
    role: 'Intern',
    playerId: 3261,
    headshot: 'https://athletics.whitman.edu/images/2025/11/7/Malzewski_2_HS.jpg?width=80&quality=90',
    blurb: 'Luke is a utility player at Whitman College, originally from Seattle, WA. He is studying Economics and works as an Athletic Event Management student worker, and earned All-Conference honors this past season. He has been fascinated by baseball stats since he started playing and has been surrounded by PNW baseball his whole life, and is excited to combine the two.',
    highlight: { pct: 96, label: 'wRC+ (D3)', value: '146' },
    built: { label: 'Recruiting Matchmaker', to: '/recruiting/quiz' },
  },
]


// ─── Run environment numbers (averaged 2022-2026 PNW data).
//     Pulled into a single object so the comparison chart and the
//     per-league cards share a source of truth.
const ENVIRONMENTS = {
  D1:   { ba: .280, obp: .386, slg: .430, ops: .816, era: 5.43, k9: 8.8, bb9: 4.4, label: 'NCAA Division I' },
  D2:   { ba: .283, obp: .393, slg: .393, ops: .786, era: 5.99, k9: 7.2, bb9: 5.0, label: 'NCAA Division II' },
  D3:   { ba: .280, obp: .388, slg: .407, ops: .795, era: 5.80, k9: 7.4, bb9: 4.6, label: 'NCAA Division III' },
  NAIA: { ba: .288, obp: .395, slg: .433, ops: .828, era: 6.11, k9: 7.7, bb9: 4.8, label: 'NAIA' },
  NWAC: { ba: .243, obp: .335, slg: .335, ops: .670, era: 4.52, k9: 7.6, bb9: 4.0, label: 'NWAC (JUCO)' },
  WCL:  { ba: .248, obp: .342, slg: .346, ops: .688, era: 4.18, k9: 8.4, bb9: 3.9, label: 'West Coast League' },
}


// ─── Helpers ──────────────────────────────────────────────────────

function StatDef({ abbr, name, children }) {
  return (
    <div className="py-3 border-b border-gray-100 dark:border-gray-700 last:border-0">
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-sm font-bold text-nw-teal font-mono">{abbr}</span>
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{name}</span>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">{children}</p>
    </div>
  )
}

function Card({ title, subtitle, children, accent }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden mb-4">
      {title && (
        <div className={`px-5 py-3 border-b border-gray-100 dark:border-gray-700 ${accent ? 'bg-nw-teal/5 dark:bg-nw-teal/10' : 'bg-gray-50 dark:bg-gray-900/40'}`}>
          <h3 className="text-base font-bold text-gray-800 dark:text-gray-100">{title}</h3>
          {subtitle && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</p>}
        </div>
      )}
      <div className="px-5 py-2">{children}</div>
    </div>
  )
}

function P({ children }) {
  return <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-3">{children}</p>
}

function Formula({ children }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 my-2 font-mono text-xs text-gray-700 dark:text-gray-200 overflow-x-auto">
      {children}
    </div>
  )
}

function SectionHeading({ id, children }) {
  return (
    <h2 id={id} className="text-lg font-bold text-nw-teal dark:text-gray-100 mt-8 mb-3 scroll-mt-20 flex items-center gap-2">
      {children}
    </h2>
  )
}

// NOTE: full class names are spelled out here because Tailwind JIT
// can't see dynamically built class strings (e.g. `text-${color}`).
const CHIP_COLOR_CLASS = {
  'nw-teal': 'text-nw-teal dark:text-gray-100',
}

function StatChip({ label, value, sub, color = 'nw-teal' }) {
  const colorClass = CHIP_COLOR_CLASS[color] || CHIP_COLOR_CLASS['nw-teal']
  return (
    <div className="flex-1 min-w-[140px] bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 px-4 py-3">
      <p className={`text-2xl sm:text-3xl font-bold tabular-nums ${colorClass}`}>
        {value}
      </p>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 font-semibold uppercase tracking-wider mt-0.5">
        {label}
      </p>
      {sub && <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

function formatBig(n) {
  if (n == null) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 10_000)    return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}


// ============================================================
// HERO STATS — the "wow" numbers up top
// ============================================================
function HeroStats({ siteStats }) {
  if (!siteStats) return null
  return (
    <div className="mb-6">
      {/* Headline row: the impressive counting stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <StatChip
          label="Home Runs Tracked"
          value={siteStats.total_home_runs?.toLocaleString() ?? '—'}
          sub="Every HR, every box score"
        />
        <StatChip
          label="Innings Pitched"
          value={formatBig(siteStats.total_innings_pitched)}
          sub="Full pitching coverage"
        />
        <StatChip
          label="Strikeouts"
          value={formatBig(siteStats.total_strikeouts)}
          sub="K's in our database"
        />
        <StatChip
          label="PBP Events"
          value={formatBig(siteStats.total_pbp_events)}
          sub="Per-plate-appearance detail"
        />
      </div>
      {/* Supporting row: scale-of-coverage stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatChip
          label="Players"
          value={siteStats.total_players?.toLocaleString() ?? '—'}
          color="nw-teal"
        />
        <StatChip
          label="Games"
          value={siteStats.total_games?.toLocaleString() ?? '—'}
          color="nw-teal"
        />
        <StatChip
          label="Hours with Claude"
          value={`${CLAUDE_HOURS}+`}
          sub="AI pair-coding sessions"
          color="nw-teal"
        />
        <StatChip
          label="Lines of Code"
          value={LOC.total.toLocaleString()}
          sub="Frontend + backend + scrapers"
          color="nw-teal"
        />
      </div>
    </div>
  )
}


// ============================================================
// THE TEAM — Nate's bio + intern roster
// ============================================================
function TeamSection() {
  return (
    <div>
      {/* Founder card */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden mb-4">
        <div className="px-5 py-5">
          <div className="flex flex-col sm:flex-row gap-5">
            <div className="shrink-0">
              <img
                src="/team-photos/nate-rasmussen.jpg"
                alt="Nate Rasmussen"
                className="w-32 h-32 sm:w-40 sm:h-40 rounded-lg object-cover ring-1 ring-gray-200 dark:ring-gray-700 mx-auto sm:mx-0"
              />
            </div>
            <div className="flex-1">
              <div className="flex items-baseline gap-2 flex-wrap mb-1">
                <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100">Nate Rasmussen</h3>
                <span className="text-[10px] font-bold uppercase tracking-wider text-nw-teal bg-nw-teal/10 px-2 py-0.5 rounded">
                  Founder
                </span>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500 uppercase tracking-wider font-semibold mb-3">
                Pitching Coach · Scout · Analyst
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-3">
                Born and raised in West Seattle, WA. Pitched two years out of the bullpen at{' '}
                <Link to="/player/5882" className="text-nw-teal hover:underline">Bellevue College</Link>{' '}
                before transferring to{' '}
                <Link to="/player/3925" className="text-nw-teal hover:underline">Bushnell University</Link>{' '}
                as a starter, where he started the program's first playoff game in school history. He is now the pitching coach at{' '}
                <Link to="/team/bushnell-beacons" className="text-nw-teal hover:underline">Bushnell</Link>, and previously coached at Washington Baseball Academy.
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-3">
                On the scouting side, he is currently an analyst and scout for Over-Slot Baseball and Just Baseball Media, and was previously the Director of Amateur Scouting at Prospects Live.
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-3">
                He built NW Baseball Stats from scratch in early 2026 to close the analytics gap between MLB-level data and PNW college baseball. The same advanced metrics that FanGraphs, Baseball Reference, and Baseball Savant make trivial at the big-league level were essentially nonexistent for D2, D3, NAIA, and JUCO programs in this region. This site fills that gap.
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4">
                NW Baseball Stats sits at the intersection of coaching and scouting, giving coaches actionable game-planning intelligence and giving players a fair, modern measurement of what they actually did on the field.
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <a
                  href="https://x.com/RasmussenBase"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-900 text-white text-xs font-medium hover:bg-gray-700 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                  @RasmussenBase
                </a>
                <span className="text-[11px] text-gray-400 dark:text-gray-500">·</span>
                <Link to="/feature-request" className="text-xs text-nw-teal hover:underline">
                  Request a feature
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Intern roster */}
      <Card
        title="2026 Internship Class"
        subtitle="A small, hand-picked team helping build out scouting, content, and engineering"
      >
        <P>
          The internship is geared toward giving young people in the Pacific Northwest real work experience inside the baseball world, building on the skills they already have in player development, scouting, writing, and analysis.
        </P>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 my-3">
          {INTERNS.map((intern, i) => (
            <div
              key={i}
              className="bg-gray-50 dark:bg-gray-900/40 rounded-lg p-4 border border-gray-100 dark:border-gray-700"
            >
              <div className="flex items-start gap-3">
                <div className="shrink-0 w-12 h-12 rounded-full bg-gradient-to-br from-nw-teal/30 to-nw-teal/20 dark:from-nw-teal/40 dark:to-gray-700 flex items-center justify-center">
                  {intern.headshot ? (
                    <img src={intern.headshot} alt={intern.name} className="w-12 h-12 rounded-full object-cover" />
                  ) : (
                    <svg className="w-6 h-6 text-nw-teal/50" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    {intern.playerId ? (
                      <Link
                        to={`/player/${intern.playerId}`}
                        className="text-sm font-bold text-nw-teal hover:text-nw-teal-light dark:text-nw-teal/90 dark:hover:text-nw-teal-light underline-offset-2 hover:underline"
                      >
                        {intern.name}
                      </Link>
                    ) : (
                      <p className="text-sm font-bold text-gray-800 dark:text-gray-100">{intern.name}</p>
                    )}
                    {intern.joining && (
                      <span className="text-[9px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 rounded">
                        Joining Soon
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 font-semibold uppercase tracking-wider mb-1">
                    {intern.role}
                  </p>
                  <p className={`text-xs leading-relaxed ${
                    intern.bioPending
                      ? 'text-gray-400 dark:text-gray-500 italic'
                      : 'text-gray-600 dark:text-gray-300'
                  }`}>
                    {intern.blurb}
                  </p>
                  {intern.built && (
                    <p className="mt-2 text-[11px]">
                      <span className="font-bold uppercase tracking-wider text-[9px] text-nw-teal mr-1">Built</span>
                      <Link
                        to={intern.built.to}
                        className="text-nw-teal hover:text-nw-teal-light hover:underline font-medium underline-offset-2"
                      >
                        {intern.built.label} →
                      </Link>
                    </p>
                  )}
                </div>
              </div>

              {/* 2026 statistical highlight — detached mini-section */}
              {intern.highlight && (
                <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 flex items-center gap-2.5">
                  <div className="shrink-0 w-11 h-11 rounded-lg bg-gradient-to-br from-nw-teal to-nw-teal-light text-white flex flex-col items-center justify-center leading-none shadow-sm">
                    <span className="text-sm font-extrabold tabular-nums">{intern.highlight.pct}</span>
                    <span className="text-[7px] font-bold uppercase tracking-wider opacity-80">pct</span>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[9px] font-bold uppercase tracking-[1.5px] text-nw-teal mb-0.5">
                      2026 Highlight
                    </div>
                    <div className="text-xs text-gray-700 dark:text-gray-200 leading-tight">
                      <span className="font-extrabold text-gray-900 dark:text-gray-100">{intern.highlight.value}</span>{' '}
                      {intern.highlight.label}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        <p className="text-[11px] text-gray-400 dark:text-gray-500 italic mt-2">
          Interested in joining? Reach out via X or the feature-request form.
        </p>
      </Card>

      <Card title="Why This Site Exists" accent>
        <P>
          MLB fans have FanGraphs, Baseball Reference, and Baseball Savant. College baseball, especially at the D2, D3, NAIA, and JUCO levels, has almost none of that. A catcher at a JUCO putting up a 150 wRC+ should be visible to four-year programs. A D3 pitcher with a 2.50 FIP should be recognized even if their ERA is inflated by poor defense. The goal of this site is to give every player a fair, modern measurement and to give every coach a real scouting tool.
        </P>
      </Card>
    </div>
  )
}


// ============================================================
// BEHIND THE CURTAIN — how the site was built
// ============================================================
function BehindTheCurtainSection() {
  const locData = [
    { name: 'Frontend',  loc: LOC.frontend, fill: '#0d9488' },  // teal-600
    { name: 'Scripts',   loc: LOC.scripts,  fill: '#0f766e' },  // teal-700
    { name: 'Backend',   loc: LOC.backend,  fill: '#115e59' },  // teal-800
  ]

  return (
    <div>
      <Card title="How This Was Built" subtitle="A two-person team: one human, one AI">
        <P>
          The entire site (frontend, backend, database, scrapers, advanced-stats engine) was built collaboratively between Nate and Claude, Anthropic's AI coding assistant. Claude handles implementation; Nate drives vision, design, data validation, and quality control. Every formula, every UI choice, every scraper edge case was reviewed by a human who actually coaches and scouts the players these stats are measuring.
        </P>
        <P>
          The site went from zero to a working leaderboard on March 30, 2026. Since then it has added per-plate-appearance play-by-play, Baseball Savant-style percentiles, a draft board, a coaching/scouting portal, an article system, a JUCO transfer tracker, full email broadcasts, a tier-gated subscription system, and dozens of other features. All while staying a one-person operation.
        </P>
      </Card>

      <Card title="Lines of Code" subtitle={`${LOC.total.toLocaleString()} total across the stack`}>
        <P>
          The codebase is split roughly into three pieces: the React frontend you're looking at, the Python FastAPI backend that serves all the stats, and the script library that scrapes data from official athletics sites every day.
        </P>
        <div className="h-[200px] my-3">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={locData} layout="vertical" margin={{ top: 4, right: 24, left: 12, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:stroke-gray-700" />
              <XAxis
                type="number"
                tick={{ fontSize: 10, fill: '#6b7280' }}
                axisLine={{ stroke: '#d1d5db' }}
                tickFormatter={(v) => (v / 1000).toFixed(0) + 'k'}
              />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 11, fill: '#374151', fontWeight: 600 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={{ fontSize: 11, borderRadius: 6 }}
                formatter={(v) => [v.toLocaleString() + ' lines', 'LOC']}
              />
              <Bar dataKey="loc" radius={[0, 4, 4, 0]}>
                {locData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="bg-gray-50 dark:bg-gray-900/40 rounded p-2">
            <p className="font-bold text-gray-800 dark:text-gray-100 tabular-nums">{LOC.frontend.toLocaleString()}</p>
            <p className="text-[10px] text-gray-500 dark:text-gray-400">Frontend (JSX/JS/CSS)</p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-900/40 rounded p-2">
            <p className="font-bold text-gray-800 dark:text-gray-100 tabular-nums">{LOC.scripts.toLocaleString()}</p>
            <p className="text-[10px] text-gray-500 dark:text-gray-400">Scrapers &amp; Jobs (Python)</p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-900/40 rounded p-2">
            <p className="font-bold text-gray-800 dark:text-gray-100 tabular-nums">{LOC.backend.toLocaleString()}</p>
            <p className="text-[10px] text-gray-500 dark:text-gray-400">Backend API (Python)</p>
          </div>
        </div>
      </Card>

      <Card title="The Tech Stack" subtitle="Modern tools, deliberately chosen">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 my-3">
          <TechCard
            heading="Frontend"
            tools={['React 18', 'Vite', 'Tailwind CSS', 'Recharts', 'React Router']}
            host="Vercel (auto-deploy on every push)"
          />
          <TechCard
            heading="Backend API"
            tools={['Python 3', 'FastAPI', 'psycopg2', 'Uvicorn']}
            host="DigitalOcean droplet (Ubuntu 22.04, systemd service)"
          />
          <TechCard
            heading="Database"
            tools={['Postgres', 'Supabase Auth (JWT)', 'Row Level Security']}
            host="Supabase managed (60+ tables, 6M+ rows)"
          />
          <TechCard
            heading="Data Pipeline"
            tools={['BeautifulSoup', 'Playwright', 'ScraperAPI', 'GitHub Actions']}
            host="Server cron + scheduled workflows"
          />
          <TechCard
            heading="Email & Billing"
            tools={['Resend (HTTPS API)', 'Stripe Checkout', 'Stripe Customer Portal']}
            host="Webhook-driven tier management"
          />
          <TechCard
            heading="Built with"
            tools={['Claude (Anthropic)', 'GitHub', 'VS Code']}
            host="One developer, AI-assisted"
          />
        </div>
      </Card>

      <Card title="The Data Pipeline" subtitle="From official athletics sites to the stats you see">
        <P>
          Stats don't appear by magic. Every number on the site is scraped from an official source, parsed, validated, deduplicated, and recomputed into advanced metrics. Here is the actual flow that runs four times a day:
        </P>
        <PipelineFlow />
        <P>
          The full pipeline runs at 1pm, 4pm, 7pm, and 11pm Pacific. Live scores refresh every 10 minutes between 8am and 8pm during game days. NWAC data scrapes separately via GitHub Actions because the NWAC's hosting provider blocks all datacenter IPs (ScraperAPI gives us a residential proxy to work around that).
        </P>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 my-3 text-center text-xs">
          <PipelineStat n="4×/day" l="Full refresh" />
          <PipelineStat n="10 min" l="Live score refresh" />
          <PipelineStat n="3" l="Scraper sources" sub="Sidearm, Presto, WCL" />
          <PipelineStat n="100%" l="HR coverage" sub="As of April 2026" />
        </div>
      </Card>

      <Card title="Architecture in One Diagram" subtitle="What happens when you load a player page">
        <ArchitectureFlow />
      </Card>

      <Card title="Known Limitations" subtitle="What we don't have, in the spirit of transparency">
        <div className="py-2 space-y-2">
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">No defensive metrics.</span> No DRS, no UZR, no batted-ball location for defense. Defensive ratings would require Statcast-style fielding data that just doesn't exist at this level.</p>
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">No exit velocity or launch angle.</span> Public PBP feeds don't include batted-ball measurements. Our xFIP and SIERA rely on rate-based estimates rather than measured contact quality.</p>
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">Small samples.</span> A college season is 40 to 56 games. WAR over that span is a guide, not a verdict. Use it directionally.</p>
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">Cross-division comparisons are approximate.</span> We normalize within each division. The absolute talent gap between, say, a D1 wRC+ of 130 and a D3 wRC+ of 130 still exists.</p>
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">Scorer-dependent.</span> Box scores reflect what the home scorer entered. If a scorer miscredits a hit or misclassifies an error, our data reflects that. NWAC re-scrapes catch most corrections.</p>
        </div>
      </Card>
    </div>
  )
}

function TechCard({ heading, tools, host }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-900/40 rounded-lg p-3 border border-gray-100 dark:border-gray-700">
      <p className="text-xs font-bold text-nw-teal uppercase tracking-wider mb-1.5">{heading}</p>
      <ul className="space-y-1 mb-2">
        {tools.map((t) => (
          <li key={t} className="text-xs text-gray-700 dark:text-gray-200 flex items-center gap-1.5">
            <span className="w-1 h-1 rounded-full bg-nw-teal/60 shrink-0" />
            {t}
          </li>
        ))}
      </ul>
      <p className="text-[10px] text-gray-500 dark:text-gray-400 italic">{host}</p>
    </div>
  )
}

function PipelineStat({ n, l, sub }) {
  return (
    <div className="bg-nw-teal/5 dark:bg-nw-teal/10 rounded p-2">
      <p className="text-lg font-bold text-nw-teal tabular-nums">{n}</p>
      <p className="text-[10px] text-gray-700 dark:text-gray-200 font-semibold">{l}</p>
      {sub && <p className="text-[9px] text-gray-500 dark:text-gray-400">{sub}</p>}
    </div>
  )
}

function PipelineFlow() {
  const steps = [
    { n: 1, t: 'Scrape',     d: 'Hit team athletics sites, parse Sidearm/Presto HTML, capture box scores' },
    { n: 2, t: 'Match',      d: 'Resolve opponent names to team_id, link players across schools' },
    { n: 3, t: 'Persist',    d: 'Write per-game rows to game_batting / game_pitching / game_events' },
    { n: 4, t: 'Aggregate',  d: 'Roll up to batting_stats / pitching_stats season totals' },
    { n: 5, t: 'Advanced',   d: 'Compute wOBA, FIP, wRC+, FIP+, SIERA, kwERA, WAR, percentile rankings' },
    { n: 6, t: 'Serve',      d: 'API endpoints query Postgres, frontend renders Recharts visualizations' },
  ]
  return (
    <div className="my-4 space-y-2">
      {steps.map((s) => (
        <div key={s.n} className="flex items-start gap-3 bg-gray-50 dark:bg-gray-900/40 rounded p-2.5 border border-gray-100 dark:border-gray-700">
          <div className="shrink-0 w-7 h-7 rounded-full bg-nw-teal text-white text-xs font-bold flex items-center justify-center">
            {s.n}
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">{s.t}</p>
            <p className="text-xs text-gray-600 dark:text-gray-300">{s.d}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

function ArchitectureFlow() {
  return (
    <div className="my-3 text-xs">
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 items-stretch">
        <ArchNode title="You" sub="Browser request" emoji="👤" />
        <ArchArrow />
        <ArchNode title="Vercel" sub="React SPA shell" emoji="⚛️" />
        <ArchArrow />
        <ArchNode title="FastAPI" sub="DigitalOcean droplet" emoji="🐍" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 items-stretch mt-2">
        <div className="hidden sm:block" />
        <div className="hidden sm:block" />
        <div className="hidden sm:block" />
        <div className="hidden sm:block" />
        <ArchArrow vertical />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 items-stretch mt-2">
        <div className="hidden sm:block" />
        <div className="hidden sm:block" />
        <div className="hidden sm:block" />
        <div className="hidden sm:block" />
        <ArchNode title="Postgres" sub="Supabase managed" emoji="🐘" />
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-3 italic">
        The browser only ever talks to Vercel and a single API host. Vercel serves the React bundle; FastAPI does the data work; Postgres holds everything. The scraper layer runs separately and only writes; it never serves requests.
      </p>
    </div>
  )
}

function ArchNode({ title, sub, emoji }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3 text-center">
      <div className="text-2xl mb-1">{emoji}</div>
      <p className="text-xs font-bold text-gray-800 dark:text-gray-100">{title}</p>
      <p className="text-[10px] text-gray-500 dark:text-gray-400">{sub}</p>
    </div>
  )
}

function ArchArrow({ vertical }) {
  return (
    <div className="flex items-center justify-center text-nw-teal text-lg font-bold">
      {vertical ? '↓' : '→'}
    </div>
  )
}


// ============================================================
// COVERAGE SECTION
// ============================================================
function CoverageSection() {
  return (
    <div>
      <Card title="Teams Tracked" subtitle="57 programs across five divisions, plus summer ball">
        <div className="my-3 space-y-1.5">
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">NCAA D1 (7):</span> Oregon, Oregon State, Washington, Washington State, Gonzaga, Portland, Seattle U</p>
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">NCAA D2 (5):</span> Central Washington, Montana State Billings, Northwest Nazarene, Saint Martin's, Western Oregon</p>
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">NCAA D3 (9):</span> George Fox, Lewis &amp; Clark, Linfield, Pacific, PLU, UPS, Whitman, Whitworth, Willamette</p>
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">NAIA (8):</span> Bushnell, College of Idaho, Corban, Eastern Oregon, Lewis-Clark State, Oregon Tech, UBC, Warner Pacific</p>
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">NWAC (28):</span> Every community college program across four sub-conferences (North, South, East, West)</p>
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">Summer:</span> West Coast League (WCL) and select PNW summer leagues</p>
        </div>
      </Card>

      <Card title="Data Sources" subtitle="Where the raw numbers come from">
        <P>
          Every player statistic on the site is scraped from an official source. We never fabricate or estimate raw stats. Advanced metrics are computed from those raw numbers using the formulas described in the glossary below.
        </P>
        <div className="my-3 space-y-1.5">
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">D1, D2, D3, NAIA:</span> Sidearm Sports team athletics pages (legacy ASP.NET and modern Nuxt URLs)</p>
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">NWAC:</span> PrestoSports (nwacsports.com), via ScraperAPI to bypass the WAF</p>
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">Summer ball:</span> PointStreak and league-hosted stat pages</p>
          <p className="text-sm text-gray-600 dark:text-gray-300"><span className="font-semibold text-gray-700 dark:text-gray-200">National rankings:</span> Pear Ratings and CollegeBaseballRatings (CBR)</p>
        </div>
      </Card>
    </div>
  )
}


// ============================================================
// RUN ENVIRONMENT SECTION
// ============================================================
function EnvironmentSection() {
  const leagues = Object.entries(ENVIRONMENTS).map(([key, e]) => ({ key, ...e }))
  return (
    <div>
      <Card title="What is a Run Environment?" subtitle="Why context matters when comparing stats across divisions">
        <P>
          Not all leagues are created equal. A .300 batting average in the NWAC means something very different than a .300 average in D1. The quality of pitching, defense, ballparks, bats, and weather all affect how many runs are scored. The "run environment" describes the overall offensive context of a league.
        </P>
        <P>
          This is why we use adjusted stats like wRC+ and FIP+. They normalize raw numbers to a common scale (100 = league average) so you can compare a D3 hitter to a D1 hitter on equal footing, relative to their peers.
        </P>
        <P>
          All run environment figures below are averaged across 2022 to 2026 PNW data to provide stable baselines. These are the same averages used to compute wRC+, FIP+, and other league-adjusted stats.
        </P>
      </Card>

      <Card title="Run Environments Compared" subtitle="OPS, ERA, and K/9 by league, each on its own scale">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 my-3">
          <MiniBar
            title="Avg OPS"
            note="Higher = more offense"
            data={leagues.map(l => ({ name: l.key, value: l.ops }))}
            fill="#0d9488"
            domain={[0.6, 0.9]}
            tickFmt={(v) => v.toFixed(3)}
            valueFmt={(v) => v.toFixed(3)}
          />
          <MiniBar
            title="Avg ERA"
            note="Lower = better pitching"
            data={leagues.map(l => ({ name: l.key, value: l.era }))}
            fill="#dc2626"
            domain={[3.5, 6.5]}
            tickFmt={(v) => v.toFixed(1)}
            valueFmt={(v) => v.toFixed(2)}
          />
          <MiniBar
            title="Avg K/9"
            note="Higher = strikeout pitching"
            data={leagues.map(l => ({ name: l.key, value: l.k9 }))}
            fill="#0f766e"
            domain={[6.5, 9.5]}
            tickFmt={(v) => v.toFixed(1)}
            valueFmt={(v) => v.toFixed(1)}
          />
        </div>
        <p className="text-[11px] text-gray-500 dark:text-gray-400 italic">
          NAIA is the highest-scoring environment (highest OPS, highest ERA). NWAC and WCL are wood-bat leagues, which suppress offense substantially while keeping pitching strikeout rates competitive.
        </p>
      </Card>

      <EnvironmentCard
        title="NCAA Division I"
        subtitle="Big Ten, WCC, Mountain West"
        e={ENVIRONMENTS.D1}
        copy="D1 is the highest level of college baseball in the PNW. These programs feature the best pitching, with strikeout rates near 9 K/9 and the lowest walk rates. The run environment is moderate compared to other PNW divisions, because the better pitching offsets the talented hitters."
      />
      <EnvironmentCard
        title="NCAA Division II"
        subtitle="Great Northwest Athletic Conference (GNAC)"
        e={ENVIRONMENTS.D2}
        copy="The GNAC features five PNW schools. D2 has a high-scoring environment with the highest walk rates of any PNW division and ERAs near 6.00. Pitching depth is at a premium; the gap between aces and back-end starters is wide."
      />
      <EnvironmentCard
        title="NCAA Division III"
        subtitle="Northwest Conference (NWC)"
        e={ENVIRONMENTS.D3}
        copy="The Northwest Conference is a nine-team D3 league with strong competitive balance. D3 has a hitter-friendly environment with solid batting averages and OPS figures. Pitching is uneven across teams; bullpens are typically shorter than in higher divisions."
      />
      <EnvironmentCard
        title="NAIA"
        subtitle="Cascade Collegiate Conference (CCC)"
        e={ENVIRONMENTS.NAIA}
        copy="The CCC is an eight-team NAIA conference. NAIA has the highest OPS of any PNW division (.828) and the most offense-friendly run environment. Many programs sit in hitter-friendly ballparks (College of Idaho, Lewis-Clark) which pushes the numbers further."
      />
      <EnvironmentCard
        title="NWAC"
        subtitle="Two-year colleges across Washington and Oregon"
        e={ENVIRONMENTS.NWAC}
        copy="The NWAC is the two-year college (JUCO) conference covering Washington and Oregon, with 28 programs across four divisions. Critically, the NWAC is a wood-bat league, one of the few in the country that plays exclusively with wood bats rather than metal. This substantially suppresses offense: batting averages are much lower (.243) and OPS is the lowest of any PNW division (.670). NWAC pitching ERAs and strikeout rates are competitive with higher divisions, suggesting pitching development outpaces hitting at this level."
      />
      <EnvironmentCard
        title="West Coast League (WCL)"
        subtitle="Premier summer collegiate wood-bat league"
        e={ENVIRONMENTS.WCL}
        copy="The WCL is the top summer collegiate league in the Pacific Northwest, with teams across Washington, Oregon, and British Columbia. Players use wood bats (unlike the metal bats used during the college season), which significantly changes the run environment. The WCL is a key development league for MLB Draft prospects, and the K/9 rate (8.4) is the highest of any league we track."
      />
    </div>
  )
}

// MiniBar — small standalone bar chart card. Each metric (OPS / ERA / K/9)
// gets its own scale and color so visual comparisons aren't distorted by
// the wildly different unit ranges. Used in EnvironmentSection.
function MiniBar({ title, note, data, fill, domain, tickFmt, valueFmt }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-900/40 rounded-lg p-3 border border-gray-100 dark:border-gray-700">
      <p className="text-xs font-bold text-gray-800 dark:text-gray-100 mb-0.5">{title}</p>
      <p className="text-[10px] text-gray-500 dark:text-gray-400 mb-2">{note}</p>
      <div className="h-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 10, fill: '#6b7280', fontWeight: 600 }}
              axisLine={{ stroke: '#d1d5db' }}
              tickLine={false}
            />
            <YAxis
              domain={domain}
              tick={{ fontSize: 9, fill: '#9ca3af' }}
              tickFormatter={tickFmt}
              axisLine={false}
              tickLine={false}
              width={40}
            />
            <Tooltip
              contentStyle={{ fontSize: 11, borderRadius: 6 }}
              formatter={(v) => [valueFmt(v), title]}
            />
            <Bar dataKey="value" fill={fill} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}


function EnvironmentCard({ title, subtitle, e, copy }) {
  return (
    <Card title={title} subtitle={subtitle}>
      <P>{copy}</P>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-3 text-center">
        <EnvStat v={e.ba.toFixed(3)} l="Avg BA" />
        <EnvStat v={e.ops.toFixed(3)} l="Avg OPS" />
        <EnvStat v={e.era.toFixed(2)} l="Avg ERA" />
        <EnvStat v={e.k9.toFixed(1)} l="Avg K/9" />
      </div>
    </Card>
  )
}

function EnvStat({ v, l }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-900/40 rounded p-2 border border-gray-100 dark:border-gray-700">
      <p className="text-lg font-bold text-gray-800 dark:text-gray-100 tabular-nums">{v}</p>
      <p className="text-[10px] text-gray-500 dark:text-gray-400 font-semibold uppercase tracking-wider">{l}</p>
    </div>
  )
}


// ============================================================
// GLOSSARY: TRADITIONAL BATTING
// ============================================================
function BattingSection() {
  return (
    <div>
      <Card title="Counting Stats" subtitle="The raw totals every leaderboard is built from">
        <StatDef abbr="G" name="Games Played">
          Number of games a player appeared in. Includes pinch-hit and pinch-run appearances.
        </StatDef>
        <StatDef abbr="PA" name="Plate Appearances">
          Every trip to the plate, including walks, hit-by-pitches, and sacrifices. The most accurate denominator for rate stats.
        </StatDef>
        <StatDef abbr="AB" name="At-Bats">
          Plate appearances minus walks, HBP, sacrifices, and catcher interference. The denominator for AVG and SLG.
        </StatDef>
        <StatDef abbr="H / 1B / 2B / 3B / HR" name="Hits and Extra-Base Hits">
          Singles, doubles, triples, and home runs. Together they make up total hits.
        </StatDef>
        <StatDef abbr="TB" name="Total Bases">
          1×Singles + 2×Doubles + 3×Triples + 4×HR. The basis for SLG.
        </StatDef>
        <StatDef abbr="R / RBI" name="Runs and Runs Batted In">
          Runs scored and runs driven in. Heavily lineup-context dependent; useful descriptively, not for evaluation.
        </StatDef>
        <StatDef abbr="BB / HBP / SF / SH" name="Walks, HBP, Sacrifices">
          Walks, hit-by-pitches, sacrifice flies, and sacrifice bunts. All show up in OBP and wOBA calculations.
        </StatDef>
        <StatDef abbr="SO" name="Strikeouts">
          Times the batter struck out (whether swinging or looking). Lower is better.
        </StatDef>
        <StatDef abbr="SB / CS" name="Stolen Bases / Caught Stealing">
          Successful and unsuccessful steal attempts. Break-even rate is around 75% (SB / (SB+CS)).
        </StatDef>
      </Card>

      <Card title="Traditional Batting Rates" subtitle="Standard percentage and ratio stats">
        <StatDef abbr="AVG" name="Batting Average">
          Hits divided by at-bats. The most traditional measure of hitting ability, though it ignores walks, extra-base power, and how a player reaches base. A .300 AVG is considered excellent at any level.
        </StatDef>
        <StatDef abbr="OBP" name="On-Base Percentage">
          How often a batter reaches base, including hits, walks, and hit-by-pitches.
          <Formula>OBP = (H + BB + HBP) / (AB + BB + HBP + SF)</Formula>
          OBP correlates more strongly with run scoring than AVG.
        </StatDef>
        <StatDef abbr="SLG" name="Slugging Percentage">
          Total bases divided by at-bats. Measures raw power by weighting extra-base hits more heavily (1B=1, 2B=2, 3B=3, HR=4).
        </StatDef>
        <StatDef abbr="OPS" name="On-Base Plus Slugging">
          OBP + SLG. A quick-and-dirty measure combining a hitter's ability to get on base and hit for power. Above .900 is excellent at most college levels.
        </StatDef>
        <StatDef abbr="ISO" name="Isolated Power">
          SLG minus AVG. Measures raw extra-base power by stripping out singles.
          <Formula>ISO = SLG - AVG</Formula>
          A .200 ISO is elite power; below .100 is minimal.
        </StatDef>
        <StatDef abbr="BABIP" name="Batting Average on Balls in Play">
          How often non-home-run batted balls fall for hits.
          <Formula>BABIP = (H - HR) / (AB - K - HR + SF)</Formula>
          League average is typically around .300. Extreme values often regress.
        </StatDef>
        <StatDef abbr="BB%" name="Walk Rate">
          Walks divided by plate appearances. Elite hitters walk 12%+ of the time; league average is around 8 to 9%.
        </StatDef>
        <StatDef abbr="K%" name="Strikeout Rate">
          Strikeouts divided by plate appearances. Lower is generally better for hitters.
        </StatDef>
        <StatDef abbr="BB/K" name="Walk-to-Strikeout Ratio">
          Walks divided by strikeouts. Above 1.0 indicates outstanding plate discipline.
        </StatDef>
        <StatDef abbr="SB%" name="Stolen Base Success Rate">
          SB / (SB + CS). Above 75% is the threshold where stealing actually adds value.
        </StatDef>
      </Card>

      <Card title="Advanced Batting" subtitle="Sabermetric metrics that adjust for context">
        <StatDef abbr="wOBA" name="Weighted On-Base Average">
          A comprehensive rate stat that weights each way of reaching base by its actual run value. Our linear weights are calibrated per division.
          <Formula>wOBA = (0.69×uBB + 0.72×HBP + 0.88×1B + 1.24×2B + 1.56×3B + 2.00×HR) / (AB + uBB + SF + HBP)</Formula>
          Weights shown are D1 defaults; they vary by division. Above .370 is excellent; below .300 is below average.
        </StatDef>
        <StatDef abbr="wOBACON" name="wOBA on Contact">
          wOBA calculated only on at-bats where the ball was put in play (excluding strikeouts). Isolates a hitter's quality of contact.
        </StatDef>
        <StatDef abbr="wRAA" name="Weighted Runs Above Average">
          Converts wOBA into a counting stat representing runs above or below the league-average hitter. A wRAA of 0 is exactly average; +15 over a college season is elite.
        </StatDef>
        <StatDef abbr="wRC" name="Weighted Runs Created">
          Estimates total runs a player created through their offensive contributions. Built on the same wOBA framework as wRAA.
        </StatDef>
        <StatDef abbr="wRC+" name="Weighted Runs Created Plus">
          The gold standard offensive metric. 100 is exactly league average. A wRC+ of 130 means the hitter was 30% better than average. The single best number for comparing hitters across divisions.
          <Formula>wRC+ = 100 × (wRAA/PA + lgR/PA) / (Park Factor × lgR/PA)</Formula>
        </StatDef>
        <StatDef abbr="OPS+" name="OPS Plus">
          OPS adjusted to a league-average baseline (100). Less rigorous than wRC+ but simpler to understand. Higher is better.
        </StatDef>
        <StatDef abbr="BsR" name="Baserunning Runs">
          Estimates a player's baserunning value (steals + advancement on the bases) in runs above or below average. We do not yet compute BsR on this site; values shown are conservative steal-only estimates.
        </StatDef>
      </Card>

      <Card title="Batted-Ball & PBP-Derived" subtitle="From play-by-play data (Phase E, April 2026)">
        <StatDef abbr="GB%" name="Ground Ball Rate">
          Percentage of batted balls classified as ground balls. Hitters with high GB% rarely hit for power.
        </StatDef>
        <StatDef abbr="FB%" name="Fly Ball Rate">
          Percentage of batted balls hit in the air to the outfield. High FB% pairs with high HR/FB.
        </StatDef>
        <StatDef abbr="LD%" name="Line Drive Rate">
          Percentage of batted balls classified as line drives. The best batted-ball outcome for a hitter; LD% above 22% is elite.
        </StatDef>
        <StatDef abbr="PU%" name="Pop-Up Rate">
          Percentage of infield pop-ups. Essentially a guaranteed out; lower is better.
        </StatDef>
        <StatDef abbr="Pull% / Cent% / Oppo%" name="Spray Direction">
          Percentage of batted balls hit to the pull side, up the middle, and to the opposite field. Pull% above 50% indicates a strong pull hitter.
        </StatDef>
        <StatDef abbr="HR/FB" name="Home Run per Fly Ball">
          What percentage of a hitter's fly balls clear the fence. Above 12% is power.
        </StatDef>
        <StatDef abbr="WPA" name="Win Probability Added">
          The change in a team's win probability attributable to each plate appearance, summed across the season. A WPA of +2.0 means the hitter (or pitcher) added two wins worth of clutch performance over an average player in the same situations.
        </StatDef>
        <StatDef abbr="LI" name="Leverage Index">
          A measure of how important a plate appearance was. 1.0 is average; above 2.0 is a high-leverage spot (close game, late innings).
        </StatDef>
        <StatDef abbr="0-0 BIP%" name="First-Pitch Contact Rate">
          Percentage of plate appearances ending on the first pitch with a ball in play. Aggressive hitters have higher 0-0 BIP%.
        </StatDef>
      </Card>
    </div>
  )
}


// ============================================================
// GLOSSARY: PITCHING
// ============================================================
function PitchingSection() {
  return (
    <div>
      <Card title="Counting & Rate Stats" subtitle="The traditional pitching numbers">
        <StatDef abbr="IP" name="Innings Pitched">
          Stored in baseball notation: 6.2 means 6 and 2/3 innings (NOT 6.2 as a decimal). For rate-stat math we convert to outs (6.2 IP = 20 outs).
        </StatDef>
        <StatDef abbr="W / L / SV / HLD" name="Wins, Losses, Saves, Holds">
          Traditional pitching decisions. Holds credit a reliever who enters and leaves with a lead intact. Heavily team and usage dependent; weak for evaluation.
        </StatDef>
        <StatDef abbr="QS" name="Quality Starts">
          A start of at least 6 innings allowing 3 earned runs or fewer. A blunt but useful starter consistency stat.
        </StatDef>
        <StatDef abbr="BF" name="Batters Faced">
          Total plate appearances against this pitcher. The proper denominator for K%, BB%, and HR%.
        </StatDef>
        <StatDef abbr="ER / R / H / HR / BB / SO" name="Counting Stats Allowed">
          Earned runs, runs, hits, home runs, walks, and strikeouts allowed.
        </StatDef>
        <StatDef abbr="ERA" name="Earned Run Average">
          Earned runs allowed per nine innings pitched.
          <Formula>ERA = (ER × 9) / IP</Formula>
          Heavily influenced by defense, sequencing, and luck. A 3.00 ERA at D1 is excellent.
        </StatDef>
        <StatDef abbr="WHIP" name="Walks + Hits per Inning Pitched">
          (BB + H) / IP. Below 1.00 is elite; above 1.50 indicates too many baserunners.
        </StatDef>
        <StatDef abbr="BAA" name="Batting Average Against">
          Opponents' batting average when facing this pitcher. Below .230 is excellent.
        </StatDef>
        <StatDef abbr="K/9 / BB/9 / H/9 / HR/9" name="Per-Nine Rates">
          Strikeouts, walks, hits, and home runs allowed per nine innings. The most common pitching rate stats.
        </StatDef>
        <StatDef abbr="K/BB" name="Strikeout-to-Walk Ratio">
          Strikeouts divided by walks. Above 3.0 is good; above 5.0 is elite.
        </StatDef>
        <StatDef abbr="K%" name="Strikeout Percentage">
          Strikeouts divided by batters faced. More accurate than K/9 because it's based on actual batters faced.
        </StatDef>
        <StatDef abbr="BB%" name="Walk Percentage">
          Walks divided by batters faced. More accurate than BB/9.
        </StatDef>
        <StatDef abbr="K-BB%" name="Strikeout Minus Walk Percentage">
          K% minus BB%. Above 20% is very good; above 30% is elite. One of the best single-number indicators of pitching skill.
        </StatDef>
        <StatDef abbr="HR/PA%" name="Home Run Rate">
          Home runs allowed per plate appearance. Below 2% is good; above 4% is a serious problem.
        </StatDef>
      </Card>

      <Card title="Defense-Independent Pitching" subtitle="Predictive metrics that strip out defense and luck">
        <StatDef abbr="FIP" name="Fielding Independent Pitching">
          Estimates what a pitcher's ERA "should" be based only on outcomes they control: strikeouts, walks, HBP, and home runs. Better predictor of future performance than ERA.
          <Formula>FIP = ((13×HR + 3×(BB+HBP) - 2×K) / IP) + FIP Constant</Formula>
        </StatDef>
        <StatDef abbr="xFIP" name="Expected Fielding Independent Pitching">
          Like FIP, but replaces actual home runs with expected home runs based on a league-average HR/FB rate. Strips out flukey HR variance.
        </StatDef>
        <StatDef abbr="SIERA" name="Skill-Interactive ERA">
          A more sophisticated ERA estimator that accounts for the interaction between strikeout rate, walk rate, and ground ball rate.
          <Formula>SIERA ≈ 6.145 - 16.986×K% + 11.434×BB% - 1.858×GB% + interaction terms</Formula>
        </StatDef>
        <StatDef abbr="kwERA" name="Strikeout-Walk ERA">
          The simplest ERA estimator. Uses only strikeouts and walks.
          <Formula>kwERA = 5.40 - 12 × ((K - BB) / BF)</Formula>
        </StatDef>
        <StatDef abbr="FIP+" name="FIP Plus">
          FIP adjusted to a scale where 100 is league average. Higher is better. Allows comparison across divisions.
          <Formula>FIP+ = 100 × (League FIP / (Player FIP / Park Factor))</Formula>
        </StatDef>
        <StatDef abbr="FIP-" name="FIP Minus">
          Same as FIP+ but inverted (lower is better). 100 is average; 80 is 20% better than league.
        </StatDef>
        <StatDef abbr="ERA+" name="ERA Plus">
          ERA adjusted to a scale where 100 is league average. Higher is better.
          <Formula>ERA+ = 100 × (League ERA / (Player ERA / Park Factor))</Formula>
        </StatDef>
        <StatDef abbr="ERA-" name="ERA Minus">
          Same as ERA+ but inverted. Lower is better.
        </StatDef>
        <StatDef abbr="BABIP" name="BABIP Against">
          Same formula as the batting version, from the pitcher's perspective. Pitchers have limited control over their BABIP; league average is around .300.
        </StatDef>
        <StatDef abbr="LOB%" name="Left on Base Percentage">
          The percentage of baserunners a pitcher strands. League average is around 72%. Very high LOB% often regresses.
        </StatDef>
      </Card>

      <Card title="Pitch-Level & PBP-Derived" subtitle="From play-by-play data (Phase A-E, April 2026)">
        <StatDef abbr="Strike%" name="Strike Rate">
          (Called + Swinging + Foul + In-play) / Total Pitches. The most direct measure of a pitcher's ability to throw strikes. 65%+ is elite.
        </StatDef>
        <StatDef abbr="Whiff%" name="Whiff Rate">
          Swinging strikes divided by total swings. Power pitchers run 30%+; control pitchers may sit closer to 20%.
        </StatDef>
        <StatDef abbr="Putaway%" name="Two-Strike Putaway Rate">
          Strikeouts divided by two-strike counts reached. Measures finishing ability.
        </StatDef>
        <StatDef abbr="First-Pitch K%" name="First-Pitch Strike Rate">
          Percentage of plate appearances where the first pitch is a strike. Above 60% gives a pitcher a major count advantage.
        </StatDef>
        <StatDef abbr="WPA" name="Win Probability Added">
          See batting glossary. Pitchers accumulate WPA by getting outs in high-leverage spots and lose WPA by allowing runs there.
        </StatDef>
        <StatDef abbr="LI" name="Leverage Index">
          The average leverage of a pitcher's plate appearances. Closers and high-leverage relievers run LI well above 1.0.
        </StatDef>
        <StatDef abbr="GB%/FB%/LD%" name="Batted-Ball Profile">
          The distribution of contact a pitcher allows. Sinkerballers run GB% above 50%; fly-ball pitchers sit lower.
        </StatDef>
      </Card>
    </div>
  )
}


// ============================================================
// GLOSSARY: WAR & TEAM METRICS
// ============================================================
function WarSection() {
  return (
    <div>
      <Card title="What is WAR?" subtitle="Wins Above Replacement: a single-number value metric" accent>
        <P>
          WAR attempts to answer one question: how many wins did this player contribute compared to a freely available replacement-level player? A WAR of 0 means replacement level. A WAR of 2.0+ over a college season is outstanding.
        </P>
        <P>
          Our WAR is "box score WAR." It's directionally useful for comparing players within the same division, but the exact numbers should be taken with appropriate context.
        </P>
      </Card>

      <Card title="Offensive WAR (oWAR)" subtitle="How we measure position player value">
        <P>
          Offensive WAR has three components, summed and converted from runs to wins:
        </P>
        <div className="bg-gray-50 dark:bg-gray-900/40 rounded-lg p-4 my-3 space-y-3 border border-gray-100 dark:border-gray-700">
          <div>
            <span className="text-xs font-bold text-nw-teal">1. Batting Runs (wRAA)</span>
            <p className="text-xs text-gray-600 dark:text-gray-300 mt-1">
              How many runs above or below average the player created through hitting. Derived from wOBA using division-specific linear weights.
            </p>
          </div>
          <div>
            <span className="text-xs font-bold text-nw-teal">2. Positional Adjustment</span>
            <p className="text-xs text-gray-600 dark:text-gray-300 mt-1">
              Harder defensive positions get a bonus; easier ones get a penalty. We scale MLB positional adjustments to the college season length with a 50% confidence discount.
            </p>
          </div>
          <div>
            <span className="text-xs font-bold text-nw-teal">3. Replacement Level</span>
            <p className="text-xs text-gray-600 dark:text-gray-300 mt-1">
              A playing-time credit for being on the field. Scaled from the MLB standard of 20 runs per 600 PA.
            </p>
          </div>
        </div>
        <Formula>oWAR = (Batting Runs + Positional Adjustment + Replacement Level) / Runs Per Win</Formula>
        <P>
          Runs Per Win varies by division: 9.0 for D1, 9.5 for D2/NAIA, 10.0 for D3/NWAC.
        </P>
      </Card>

      <Card title="Pitching WAR (pWAR)" subtitle="How we measure pitcher value">
        <P>
          Pitching WAR is built on FIP, not ERA, measuring a pitcher's value based on outcomes they control.
        </P>
        <Formula>pWAR = ((League FIP - Player FIP) / Runs Per Win) × (IP / 9) + Replacement Level</Formula>
      </Card>

      <Card title="Division-Specific Linear Weights" subtitle="How we calibrate stats across divisions">
        <P>
          Each division has its own run environment. A home run is worth more in a low-scoring NWAC game than in a high-scoring NAIA game.
        </P>
        <div className="overflow-x-auto my-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider bg-gray-50 dark:bg-gray-900/40">
                <th className="text-left px-3 py-2">Weight</th>
                <th className="text-center px-2 py-2">D1</th>
                <th className="text-center px-2 py-2">D2</th>
                <th className="text-center px-2 py-2">D3</th>
                <th className="text-center px-2 py-2">NAIA</th>
                <th className="text-center px-2 py-2">NWAC</th>
              </tr>
            </thead>
            <tbody className="text-gray-700 dark:text-gray-200">
              <tr className="border-t border-gray-100 dark:border-gray-700"><td className="px-3 py-1.5 font-medium">Walk (uBB)</td><td className="text-center px-2">0.69</td><td className="text-center px-2">0.69</td><td className="text-center px-2">0.70</td><td className="text-center px-2">0.70</td><td className="text-center px-2">0.70</td></tr>
              <tr className="border-t border-gray-100 dark:border-gray-700"><td className="px-3 py-1.5 font-medium">HBP</td><td className="text-center px-2">0.72</td><td className="text-center px-2">0.72</td><td className="text-center px-2">0.73</td><td className="text-center px-2">0.73</td><td className="text-center px-2">0.73</td></tr>
              <tr className="border-t border-gray-100 dark:border-gray-700"><td className="px-3 py-1.5 font-medium">Single</td><td className="text-center px-2">0.88</td><td className="text-center px-2">0.89</td><td className="text-center px-2">0.89</td><td className="text-center px-2">0.90</td><td className="text-center px-2">0.90</td></tr>
              <tr className="border-t border-gray-100 dark:border-gray-700"><td className="px-3 py-1.5 font-medium">Double</td><td className="text-center px-2">1.24</td><td className="text-center px-2">1.25</td><td className="text-center px-2">1.26</td><td className="text-center px-2">1.27</td><td className="text-center px-2">1.27</td></tr>
              <tr className="border-t border-gray-100 dark:border-gray-700"><td className="px-3 py-1.5 font-medium">Triple</td><td className="text-center px-2">1.56</td><td className="text-center px-2">1.58</td><td className="text-center px-2">1.59</td><td className="text-center px-2">1.60</td><td className="text-center px-2">1.60</td></tr>
              <tr className="border-t border-gray-100 dark:border-gray-700"><td className="px-3 py-1.5 font-medium">Home Run</td><td className="text-center px-2">2.00</td><td className="text-center px-2">2.02</td><td className="text-center px-2">2.03</td><td className="text-center px-2">2.05</td><td className="text-center px-2">2.05</td></tr>
              <tr className="border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40"><td className="px-3 py-1.5 font-medium">Runs/PA</td><td className="text-center px-2">0.125</td><td className="text-center px-2">0.130</td><td className="text-center px-2">0.135</td><td className="text-center px-2">0.135</td><td className="text-center px-2">0.140</td></tr>
              <tr className="border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40"><td className="px-3 py-1.5 font-medium">Runs/Win</td><td className="text-center px-2">9.0</td><td className="text-center px-2">9.5</td><td className="text-center px-2">10.0</td><td className="text-center px-2">9.5</td><td className="text-center px-2">10.0</td></tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Team Metrics" subtitle="Site-specific composite ratings">
        <StatDef abbr="PPI" name="PNW Power Index">
          A composite team strength rating that blends record, run differential, strength of schedule, and recent form. Used on the homepage and standings to rank teams across divisions.
        </StatDef>
        <StatDef abbr="SOS" name="Strength of Schedule">
          The average opponent quality on a team's schedule. We compute SOS by taking the mean PPI of all opponents played.
        </StatDef>
        <StatDef abbr="SOS Remaining" name="Remaining Strength of Schedule">
          Same as SOS but only counts games not yet played. Lower SOS Remaining means an easier path to the playoffs.
        </StatDef>
        <StatDef abbr="Pythag W%" name="Pythagorean Win Percentage">
          Expected win percentage based on runs scored and runs allowed. A large gap between actual and Pythagorean record signals luck (good or bad).
          <Formula>Pythag W% = RS² / (RS² + RA²)</Formula>
        </StatDef>
      </Card>
    </div>
  )
}


// ─── Jump-link navigation (no Updates section) ─────────────────────
const PAGE_SECTIONS = [
  { id: 'team', label: 'The Team' },
  { id: 'behind', label: 'Behind the Curtain' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'environments', label: 'Run Environments' },
  { id: 'glossary', label: 'Stat Glossary' },
]


// ============================================================
// MAIN ABOUT PAGE
// ============================================================
export default function About() {
  const [activeGlossary, setActiveGlossary] = useState('batting')
  const [siteStats, setSiteStats] = useState(null)

  useEffect(() => {
    fetch('/api/v1/site-stats')
      .then((r) => r.json())
      .then((d) => setSiteStats(d))
      .catch((err) => console.error('[About] /site-stats failed:', err))
  }, [])

  const scrollTo = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-1">
        About NW Baseball Stats
      </h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        The story behind the site, the team building it, and every stat we track. A true peek behind the curtain.
      </p>

      <HeroStats siteStats={siteStats} />

      {/* Jump-link nav */}
      <div className="flex gap-1 mb-5 overflow-x-auto pb-1">
        {PAGE_SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => scrollTo(s.id)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors
                       bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300
                       hover:bg-nw-teal hover:text-white"
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="max-w-5xl">
        <SectionHeading id="team">The Team</SectionHeading>
        <TeamSection />

        <SectionHeading id="behind">Behind the Curtain</SectionHeading>
        <BehindTheCurtainSection />

        <SectionHeading id="coverage">Coverage</SectionHeading>
        <CoverageSection />

        <SectionHeading id="environments">Run Environments</SectionHeading>
        <EnvironmentSection />

        <SectionHeading id="glossary">Stat Glossary</SectionHeading>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Definitions and formulas for every stat used on the site, organized by category.
        </p>
        <div className="flex gap-1 mb-4 overflow-x-auto pb-1">
          {[
            { id: 'batting', label: 'Batting' },
            { id: 'pitching', label: 'Pitching' },
            { id: 'war', label: 'WAR & Team' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveGlossary(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                activeGlossary === tab.id
                  ? 'bg-nw-teal text-white'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {activeGlossary === 'batting' && <BattingSection />}
        {activeGlossary === 'pitching' && <PitchingSection />}
        {activeGlossary === 'war' && <WarSection />}
      </div>
    </div>
  )
}
