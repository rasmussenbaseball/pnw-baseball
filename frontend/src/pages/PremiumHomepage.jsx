// PremiumHomepage — the homepage for signed-in PREMIUM-tier users.
//
// The richest tier homepage: it surfaces the coaching sim as the
// headline feature (Dynasty + Story modes), reuses the best
// data widgets from the free homepage, and adds a dense "toolbox" of
// quick links to the biggest tools on the site.
//
// Wired in App.jsx HomepageRouter on tier === 'premium'.

import { useEffect, useState, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useAffiliatedTeam } from '../context/AffiliationContext'
import PreviewTierWidget from '../components/PreviewTierWidget'
import PixelHeadshot from '../gm/components/PixelHeadshot'
import PitchLevelStatsCard from '../components/PitchLevelStatsCard'
import PitcherPitchLevelStatsCard from '../components/PitcherPitchLevelStatsCard'
import {
  StatLeadersBoard, ScatterWidget, DivisionRunEnvChart,
  PercentilesWidget, LeagueQuizWidget, WpaSwingsBoard, PnwMapWidget,
} from './FreeHomepage'
import { CURRENT_SEASON } from '../lib/seasons'

const SEASON = CURRENT_SEASON

// `portalShowcase` is an optional slot rendered directly beneath the
// toolbox. The premium homepage passes nothing (so its output is
// unchanged); the coach homepage passes its portal showcase widget so
// the Coach & Scout portal tools surface high on the page.
export default function PremiumHomepage({ portalShowcase = null }) {
  return (
    <div className="space-y-5 sm:space-y-6">
      <PreviewTierWidget />
      <PremiumWelcome />

      {/* Premium toolbox — quick links to the biggest tools */}
      <PremiumToolbox />

      {/* Coach-tier portal showcase (slot is empty on the premium page) */}
      {portalShowcase}

      {/* Season leaders */}
      <StatLeadersBoard />

      {/* Data widgets, two columns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 flex flex-col gap-5">
          <ScatterWidget />
          <DivisionRunEnvChart />
        </div>
        <div className="flex flex-col gap-5">
          <PercentilesWidget />
          <WpaSwingsBoard />
        </div>
      </div>

      {/* Mock player-page deep dives — rotate through the top 200 */}
      <MockPlayerSpotlight mode="hitter" />
      <MockPlayerSpotlight mode="pitcher" />

      {/* Coaching simulator — dense feature block, placed mid-page */}
      <CoachingSimWidget />

      <LeagueQuizWidget />
      <PnwMapWidget />
    </div>
  )
}


// ============================================================
// PREMIUM WELCOME
// ============================================================
function PremiumWelcome() {
  const { user } = useAuth()
  const { team } = useAffiliatedTeam()
  const name = user?.email ? user.email.split('@')[0] : 'there'
  return (
    <div className="rounded-xl bg-gradient-to-r from-nw-teal via-nw-teal to-nw-teal-light text-white px-5 py-4 sm:px-6 sm:py-5 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[2px] text-amber-300 bg-amber-400/15 px-2 py-0.5 rounded">
            Premium
          </span>
          <span className="text-[11px] uppercase tracking-[2px] font-semibold text-white/70">Welcome back</span>
        </div>
        <div className="text-xl sm:text-2xl font-extrabold truncate mt-1">
          {team ? `Following ${team.short_name || team.name}` : `Hey, ${name}`}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link to="/gm" className="px-3 py-1.5 rounded-lg bg-amber-400 text-[#003845] text-sm font-bold hover:bg-amber-300 transition-colors">Launch the Sim</Link>
        <Link to="/percentiles" className="px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-sm font-semibold transition-colors">Percentiles</Link>
        <Link to="/news" className="px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-sm font-semibold transition-colors">Articles</Link>
      </div>
    </div>
  )
}


// ============================================================
// MOCK PLAYER SPOTLIGHT — full PBP + spray breakdown, rotating
// through the top 200 hitters / pitchers
// ============================================================
// Reuses the EXACT components from the real player page
// (PitchLevelStatsCard / PitcherPitchLevelStatsCard), which each
// fetch their own data by playerId and render the color-coded
// plate-discipline + batted-ball tiles, spray chart, count battle,
// hand splits, and situational splits. We just pick a random player
// from the top 200 (by WAR) and let the card do the rest.
function fmtAvg(v) {
  if (v == null) return '-'
  const n = Number(v)
  return n >= 1 ? n.toFixed(3) : n.toFixed(3).replace(/^0/, '')
}

function MockPlayerSpotlight({ mode }) {
  const isHitter = mode === 'hitter'
  const [pool, setPool] = useState([])
  const [player, setPlayer] = useState(null)
  // Some top-WAR players (e.g., a few D1 arms) have no PBP coverage, so
  // their pitch-level card would render blank. We verify the selected
  // player actually has tracked PBP data and auto-skip to another if
  // not. `verifying` gates the render until we've confirmed data.
  const [verifying, setVerifying] = useState(true)
  const triesRef = useRef(0)

  const pickRandom = useCallback((rows) => (
    rows.length ? rows[Math.floor(Math.random() * rows.length)] : null
  ), [])

  useEffect(() => {
    let alive = true
    const sortBy = isHitter ? 'offensive_war' : 'pitching_war'
    const endpoint = isHitter ? 'batting' : 'pitching'
    fetch(`/api/v1/leaderboards/${endpoint}?season=${SEASON}&sort_by=${sortBy}&sort_dir=desc&limit=200&qualified=true`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        const rows = d?.data || []
        setPool(rows)
        triesRef.current = 0
        setPlayer(pickRandom(rows))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [isHitter, pickRandom])

  // Verify the current player has PBP data; if not, hop to another.
  useEffect(() => {
    if (!player || pool.length === 0) return
    let alive = true
    setVerifying(true)
    const url = isHitter
      ? `/api/v1/players/${player.player_id}/pitch-level-stats?season=${SEASON}`
      : `/api/v1/players/${player.player_id}/pitch-level-stats-pitcher?season=${SEASON}`
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        const disc = d?.discipline || {}
        const ok = isHitter ? (disc.tracked_pa > 0) : (disc.total_pa > 0)
        if (ok) {
          setVerifying(false)
          triesRef.current = 0
        } else if (triesRef.current < 12) {
          triesRef.current += 1
          setPlayer(pickRandom(pool))   // re-triggers this effect
        } else {
          setVerifying(false)           // give up gracefully
        }
      })
      .catch(() => { if (alive) setVerifying(false) })
    return () => { alive = false }
  }, [player, pool, isHitter, pickRandom])

  const [expanded, setExpanded] = useState(false)

  const shuffle = () => {
    triesRef.current = 0
    setExpanded(false)            // start each new player compact
    setPlayer(pickRandom(pool))
  }

  const statLine = (p) => isHitter
    ? [
        ['AVG', fmtAvg(p.batting_avg)],
        ['HR', p.home_runs ?? 0],
        ['wRC+', Math.round(p.wrc_plus ?? 0)],
        ['OPS', fmtAvg(p.ops)],
        ['WAR', (p.offensive_war ?? 0).toFixed(1)],
      ]
    : [
        ['ERA', (p.era ?? 0).toFixed(2)],
        ['SO', p.strikeouts ?? 0],
        ['FIP+', Math.round(p.fip_plus ?? 0)],
        ['WHIP', (p.whip ?? 0).toFixed(2)],
        ['WAR', (p.pitching_war ?? 0).toFixed(1)],
      ]

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal">
            {isHitter ? 'Hitter deep dive' : 'Pitcher deep dive'} · Top 200 by WAR
          </div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">
            Full pitch-level breakdown
          </h3>
        </div>
        <button
          onClick={shuffle}
          className="px-3 py-1.5 rounded-lg bg-nw-teal text-white text-xs font-semibold hover:bg-nw-teal-light transition-colors shrink-0"
        >
          {isHitter ? 'Next hitter' : 'Next pitcher'}
        </button>
      </div>

      {!player || verifying ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-8 text-center text-gray-400 animate-pulse">
          Loading {isHitter ? 'hitter' : 'pitcher'}...
        </div>
      ) : (
        <>
          {/* Player header bar */}
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 flex items-center gap-3 flex-wrap">
            {player.logo_url && (
              <img src={player.logo_url} alt="" className="w-10 h-10 object-contain shrink-0"
                onError={(e) => { e.target.style.display = 'none' }} />
            )}
            <div className="min-w-0">
              <Link to={`/player/${player.player_id}`} className="text-base sm:text-lg font-extrabold text-gray-900 dark:text-gray-100 hover:text-nw-teal leading-tight">
                {player.first_name} {player.last_name}
              </Link>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {player.team_short || player.team_name} · {player.division_level}
                {player.position ? ` · ${player.position}` : ''}
              </div>
            </div>
            <div className="ml-auto flex gap-2 flex-wrap">
              {statLine(player).map(([label, value]) => (
                <div key={label} className="text-center bg-gray-50 dark:bg-gray-900/40 rounded-md px-2.5 py-1.5 min-w-[52px]">
                  <div className="text-sm font-extrabold text-gray-900 dark:text-gray-100 tabular-nums leading-none">{value}</div>
                  <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mt-0.5">{label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* The real player-page pitch-level card. Collapsed by
              default to the top sections (discipline tiles + batted
              ball + spray); "Show more" reveals the count battle,
              hand splits, and situational tables. */}
          <div className="relative">
            <div className={expanded ? '' : 'max-h-[460px] overflow-hidden'}>
              {isHitter
                ? <PitchLevelStatsCard key={player.player_id} playerId={player.player_id} season={SEASON} />
                : <PitcherPitchLevelStatsCard key={player.player_id} playerId={player.player_id} season={SEASON} />}
            </div>
            {!expanded && (
              <div className="absolute bottom-0 inset-x-0 h-24 bg-gradient-to-t from-white dark:from-gray-800 to-transparent pointer-events-none rounded-b-lg" />
            )}
          </div>
          <div className="flex justify-center -mt-2">
            <button
              onClick={() => setExpanded((e) => !e)}
              className="px-4 py-1.5 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs font-semibold text-nw-teal hover:border-nw-teal shadow-sm transition-colors"
            >
              {expanded ? 'Show less ↑' : 'Show full breakdown ↓'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}


// ============================================================
// COACHING SIM WIDGET — the headline premium feature
// ============================================================
const DYNASTY_ROSTER = [
  { id: 'pm-okafor-90', name: 'D. Okafor', pos: 'SS', ovr: 90 },
  { id: 'pm-rivas-86',  name: 'A. Rivas',  pos: 'CF', ovr: 86 },
  { id: 'pm-soto-83',   name: 'L. Soto',   pos: 'RHP', ovr: 83 },
]
const STORY_ROSTER = [
  { id: 'sm-you-72',    name: 'You',       pos: 'BENCH', ovr: 72 },
  { id: 'sm-kerr-68',   name: 'T. Kerr',   pos: 'JUCO', ovr: 68 },
]

function ovrColor(ovr) {
  if (ovr >= 85) return '#16a34a'
  if (ovr >= 80) return '#65a30d'
  if (ovr >= 75) return '#ca8a04'
  return '#9ca3af'
}

function CoachingSimWidget() {
  return (
    <section className="rounded-xl overflow-hidden border border-white/10 shadow-lg bg-gradient-to-br from-gray-900 to-nw-teal text-white">
      <div className="px-4 sm:px-5 py-4 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[2px] text-amber-300 mb-1">
            Premium · Included
          </div>
          <h2 className="text-lg sm:text-xl font-extrabold leading-tight">
            NW Coaching Simulator
          </h2>
          <p className="text-xs text-white/65 max-w-xl leading-snug mt-1">
            Turn-based dynasty + career sim across every PNW level. Recruit, build a roster,
            manage a budget, and chase a title. Two ways to play.
          </p>
        </div>
        <Link
          to="/gm"
          className="shrink-0 px-4 py-2 rounded-lg bg-amber-400 text-[#003845] font-bold text-xs hover:bg-amber-300 transition-colors"
        >
          Open the Sim →
        </Link>
      </div>

      {/* Two compact mode panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-white/10">
        <SimModePanel
          title="Dynasty"
          tagline="Run a program, your way."
          body="Take the reins at any of 57 programs and run a full multi-season dynasty: recruit, develop, set lineups, manage the budget."
          roster={DYNASTY_ROSTER}
          rosterLabel="Your roster"
          cta={{ to: '/gm/new', label: 'Start a Dynasty' }}
        />
        <SimModePanel
          title="Story Mode"
          tagline="Rise through the ranks."
          body="Start as a JUCO bench coach with nothing but ambition. Win games, earn promotions, and climb all the way to a D1 dugout."
          roster={STORY_ROSTER}
          rosterLabel="Where you start"
          cta={{ to: '/gm/new', label: 'Begin Your Story' }}
          accent
        />
      </div>
    </section>
  )
}

function SimModePanel({ title, tagline, body, roster, rosterLabel, cta, accent }) {
  return (
    <div className={`px-4 py-3.5 ${accent ? 'bg-[#1a1530]' : 'bg-[#161a2e]'}`}>
      <div className="flex items-baseline gap-2 mb-0.5">
        <h3 className="text-base font-extrabold leading-tight">{title}</h3>
        <span className="text-[11px] font-semibold text-amber-200/90">{tagline}</span>
      </div>
      <p className="text-[11px] text-white/65 leading-snug mb-2.5">{body}</p>

      {/* Inline pixel roster preview + CTA on one row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {roster.map((p) => (
            <div key={p.id} className="flex items-center gap-1" title={`${p.name} · ${p.pos} · ${p.ovr} OVR`}>
              <PixelHeadshot playerId={p.id} capColor="#003845" jerseyColor="#00687a" capAccent="#fbbf24" size={26} />
              <span className="text-[10px] font-extrabold tabular-nums" style={{ color: ovrColor(p.ovr) }}>{p.ovr}</span>
            </div>
          ))}
        </div>
        <Link
          to={cta.to}
          className="shrink-0 px-3 py-1.5 rounded-md bg-white/10 border border-white/20 font-bold text-[11px] hover:bg-white/20 transition-colors whitespace-nowrap"
        >
          {cta.label}
        </Link>
      </div>
    </div>
  )
}


// ============================================================
// PREMIUM TOOLBOX — quick links to the biggest tools
// ============================================================
const TOOLBOX = [
  { to: '/hitting',     label: 'Hitting',      desc: 'wRC+, wOBA, ISO, BABIP', icon: 'bat' },
  { to: '/pitching',    label: 'Pitching',     desc: 'FIP, xFIP, SIERA, K-BB%', icon: 'ball' },
  { to: '/fielding',    label: 'Fielding',     desc: 'Per-position defense', icon: 'glove' },
  { to: '/war',         label: 'WAR',          desc: 'Two-way value combined', icon: 'star' },
  { to: '/percentiles', label: 'Percentiles',  desc: 'Savant-style rankings', icon: 'bars' },
  { to: '/scatter',     label: 'Scatter',      desc: 'Plot any two stats', icon: 'dots' },
  { to: '/top-moments', label: 'Top Moments',  desc: 'Biggest WPA swings', icon: 'bolt' },
  { to: '/team-ratings', label: 'Power Index', desc: 'CPI team ratings', icon: 'trophy' },
]

function ToolIcon({ name }) {
  // Simple inline glyphs — keep it lightweight, no emoji.
  const common = 'w-5 h-5'
  const paths = {
    bat: 'M3 21l6-6m0 0l9-9a2 2 0 10-3-3l-9 9m3 3l-3-3',
    ball: 'M12 3a9 9 0 100 18 9 9 0 000-18zm-5 4c2 1.5 3 4 3 5m9-5c-2 1.5-3 4-3 5',
    glove: 'M6 11V6a2 2 0 014 0v4m0-3a2 2 0 014 0v3m0-2a2 2 0 014 0v6a6 6 0 01-6 6H9a5 5 0 01-5-5v-2a2 2 0 014 0',
    star: 'M11.48 3.5l2.46 4.99 5.51.8-3.99 3.88.94 5.49-4.92-2.59-4.92 2.59.94-5.49-3.99-3.88 5.51-.8z',
    bars: 'M4 20V10m5 10V4m5 16v-8m5 8V8',
    dots: 'M5 19a1 1 0 100-2 1 1 0 000 2zm6-4a1 1 0 100-2 1 1 0 000 2zm3 4a1 1 0 100-2 1 1 0 000 2zm5-9a1 1 0 100-2 1 1 0 000 2z',
    bolt: 'M13 2L3 14h8l-1 8 10-12h-8z',
    trophy: 'M8 4h8v3a4 4 0 11-8 0V4zM6 5H4v1a3 3 0 003 3m11-4h2v1a3 3 0 01-3 3M9 14h6m-3 0v4m-3 0h6',
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" className={common}>
      <path d={paths[name] || paths.dots} />
    </svg>
  )
}

function PremiumToolbox() {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal">Your toolbox</div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Jump into the data</h3>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {TOOLBOX.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className="group bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3 sm:p-4 hover:border-nw-teal hover:shadow-md transition-all flex items-center gap-3"
          >
            <span className="shrink-0 w-9 h-9 rounded-lg bg-nw-teal/10 dark:bg-nw-teal/20 text-nw-teal flex items-center justify-center group-hover:bg-nw-teal group-hover:text-white transition-colors">
              <ToolIcon name={t.icon} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-gray-900 dark:text-gray-100 group-hover:text-nw-teal transition-colors truncate">{t.label}</span>
              <span className="block text-[11px] text-gray-500 dark:text-gray-400 truncate">{t.desc}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  )
}
