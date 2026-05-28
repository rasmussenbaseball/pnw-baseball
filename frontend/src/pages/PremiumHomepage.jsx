// PremiumHomepage — the homepage for signed-in PREMIUM-tier users.
//
// The richest tier homepage: it surfaces the coaching sim as the
// headline feature (Dynasty + Story modes), reuses the best
// data widgets from the free homepage, and adds a dense "toolbox" of
// quick links to the biggest tools on the site.
//
// Wired in App.jsx HomepageRouter on tier === 'premium'.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useAffiliatedTeam } from '../context/AffiliationContext'
import PreviewTierWidget from '../components/PreviewTierWidget'
import PixelHeadshot from '../gm/components/PixelHeadshot'
import {
  StatLeadersBoard, ScatterWidget, DivisionRunEnvChart,
  PercentilesWidget, LeagueQuizWidget, WpaSwingsBoard, PnwMapWidget,
} from './FreeHomepage'

export default function PremiumHomepage() {
  return (
    <div className="space-y-5 sm:space-y-6">
      <PreviewTierWidget />
      <PremiumWelcome />

      {/* Headline feature: the coaching simulator */}
      <CoachingSimWidget />

      {/* Premium toolbox — quick links to the biggest tools */}
      <PremiumToolbox />

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
    <div className="rounded-xl bg-gradient-to-r from-pnw-slate via-nw-teal to-pnw-sky text-white px-5 py-4 sm:px-6 sm:py-5 flex flex-col sm:flex-row sm:items-center gap-3">
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
    <section className="rounded-2xl overflow-hidden border border-white/10 shadow-xl bg-gradient-to-br from-gray-900 to-pnw-slate text-white">
      <div className="px-5 sm:px-7 pt-6 pb-5">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-bold uppercase tracking-[2px] text-amber-300">
            Premium · Included
          </span>
        </div>
        <h2 className="text-2xl sm:text-3xl font-extrabold leading-tight mb-2">
          NW Coaching Simulator
        </h2>
        <p className="text-sm sm:text-base text-white/75 max-w-2xl leading-relaxed">
          A turn-based dynasty and career simulator covering every level of PNW
          baseball, from the NWAC to Division I. Recruit, build a roster, manage a
          budget, hire coaches, and chase a title. Pick how you want to play.
        </p>
      </div>

      {/* Two mode panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-white/10">
        <SimModePanel
          eyebrow="Mode 1"
          title="Dynasty"
          tagline="Run a program, your way."
          body="Take the reins at any school in the region and run a full multi-season dynasty as head coach. Recruit classes, develop players, set lineups and rotations, manage your budget, and build a powerhouse."
          bullets={['Pick any of 57 programs', 'Multi-season recruiting + portal', 'Full budget + coaching staff']}
          roster={DYNASTY_ROSTER}
          rosterLabel="Your roster"
          cta={{ to: '/gm/new', label: 'Start a Dynasty' }}
        />
        <SimModePanel
          eyebrow="Mode 2"
          title="Story Mode"
          tagline="Rise through the ranks."
          body="Start at the bottom as a JUCO bench coach with nothing but ambition. Win games, earn promotions, and climb from the NWAC all the way to a Division I dugout in a career that's all your own."
          bullets={['Begin as a JUCO assistant', 'Earn promotions + job offers', 'Build a coaching legacy']}
          roster={STORY_ROSTER}
          rosterLabel="Where you start"
          cta={{ to: '/gm/new', label: 'Begin Your Story' }}
          accent
        />
      </div>

      <div className="px-5 sm:px-7 py-4 bg-black/20 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-xs text-white/60">
          Already have a save? Jump back into your dynasty.
        </span>
        <Link
          to="/gm"
          className="px-5 py-2.5 rounded-lg bg-amber-400 text-[#003845] font-bold text-sm hover:bg-amber-300 transition-colors"
        >
          Open the Sim →
        </Link>
      </div>
    </section>
  )
}

function SimModePanel({ eyebrow, title, tagline, body, bullets, roster, rosterLabel, cta, accent }) {
  return (
    <div className={`p-5 sm:p-6 ${accent ? 'bg-[#1a1530]' : 'bg-[#161a2e]'}`}>
      <div className="text-[10px] font-bold uppercase tracking-[2px] text-amber-300/80 mb-1">{eyebrow}</div>
      <h3 className="text-xl sm:text-2xl font-extrabold leading-tight">{title}</h3>
      <p className="text-sm font-semibold text-amber-200/90 mb-3">{tagline}</p>
      <p className="text-xs sm:text-sm text-white/70 leading-relaxed mb-4">{body}</p>

      {/* Mini pixel roster preview */}
      <div className="rounded-lg bg-black/25 border border-white/10 p-3 mb-4">
        <div className="text-[9px] font-bold uppercase tracking-wider text-white/40 mb-2">{rosterLabel}</div>
        <div className="flex flex-wrap gap-3">
          {roster.map((p) => (
            <div key={p.id} className="flex items-center gap-2">
              <PixelHeadshot playerId={p.id} capColor="#003845" jerseyColor="#00687a" capAccent="#fbbf24" size={30} />
              <div className="leading-tight">
                <div className="text-xs font-bold text-white">{p.name}</div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-semibold text-amber-300/80">{p.pos}</span>
                  <span className="text-[10px] font-extrabold tabular-nums" style={{ color: ovrColor(p.ovr) }}>{p.ovr}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <ul className="space-y-1.5 mb-5">
        {bullets.map((b) => (
          <li key={b} className="flex items-center gap-2 text-xs sm:text-sm text-white/85">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-300 shrink-0" />
            {b}
          </li>
        ))}
      </ul>

      <Link
        to={cta.to}
        className="inline-block px-5 py-2.5 rounded-lg bg-white/10 border border-white/20 font-bold text-sm hover:bg-white/20 transition-colors"
      >
        {cta.label}
      </Link>
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
  { to: '/team-ratings', label: 'Power Index', desc: 'PPI team ratings', icon: 'trophy' },
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
