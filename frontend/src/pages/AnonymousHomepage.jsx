// AnonymousHomepage — the homepage that anonymous (signed-out) visitors
// see. Goal: drive free-account signups. Style: hero + interleaved CTAs.
//
// Architecture note: App.jsx route conditionally renders this when
// `!user`. When the visitor is signed in, the existing Homepage
// (the dashboard with live widgets) renders instead. This sets up
// a clean pattern for future per-tier homepages (Free, Premium,
// Coach all get their own variant of /).

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  useBattingLeaderboard, usePitchingLeaderboard,
} from '../hooks/useApi'
import { usePublishedArticles } from '../hooks/useArticles'

const SEASON = 2026

export default function AnonymousHomepage() {
  return (
    <div className="-mx-2 sm:-mx-4">
      <HeroSection />

      <div className="px-4 sm:px-6 lg:px-8 max-w-6xl mx-auto py-8 sm:py-12 space-y-12">
        <ByTheNumbersStrip />
        <SeasonInReviewSection />
        <InlineCta
          headline="Want to follow your team?"
          body="Create a free account to favorite players, bookmark teams, and tailor stats to the schools you care about. No credit card."
        />
        <FreeToolsShowcase />
        <WhatsNextCard />
        <LockTeaseCta />
        <FeaturedArticles />
        <ClosingCtaWithFounder />
      </div>
    </div>
  )
}


// ============================================================
// HERO
// ============================================================
function HeroSection() {
  return (
    <section
      className="relative overflow-hidden text-white"
      style={{
        background:
          'linear-gradient(135deg, #003845 0%, #00687a 45%, #008ba6 100%)',
      }}
    >
      {/* Decorative diamond grid — subtle, evokes the field */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.06] pointer-events-none"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
          backgroundSize: '24px 24px',
        }}
      />

      <div className="relative max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 mb-5 rounded-full bg-white/10 backdrop-blur border border-white/15 text-[11px] font-semibold uppercase tracking-[2px] text-amber-300">
          Pacific Northwest Baseball
        </div>

        <h1 className="text-3xl sm:text-5xl lg:text-6xl font-extrabold leading-[1.05] mb-5 tracking-tight">
          Northwest baseball,<br className="hidden sm:block" />{' '}
          <span className="text-amber-300">deeply analyzed.</span>
        </h1>

        <p className="text-base sm:text-xl text-white/85 max-w-2xl mx-auto leading-relaxed mb-8">
          Every D1, D2, D3, NAIA, and NWAC team in the PNW. FanGraphs and
          Baseball Savant-style advanced metrics for{' '}
          <span className="font-semibold text-white">11,000+ players</span>{' '}
          across <span className="font-semibold text-white">9 seasons</span>.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
          <Link
            to="/auth?mode=signup"
            className="px-6 py-3 rounded-lg bg-amber-400 text-[#003845] font-bold text-base hover:bg-amber-300 transition-colors shadow-lg"
          >
            Create free account
          </Link>
          <a
            href="#explore"
            className="px-6 py-3 rounded-lg bg-white/10 backdrop-blur border border-white/20 text-white font-semibold text-base hover:bg-white/20 transition-colors"
          >
            Explore as guest
          </a>
        </div>

        <p className="text-[11px] text-white/55 uppercase tracking-wider">
          Free forever. No credit card. Built by a coach, scout, and former pitcher.
        </p>
      </div>
    </section>
  )
}


// ============================================================
// BY THE NUMBERS
// ============================================================
function ByTheNumbersStrip() {
  const [stats, setStats] = useState(null)
  useEffect(() => {
    fetch('/api/v1/site-stats')
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {})
  }, [])

  const fmt = (n) => {
    if (n == null) return '...'
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
    if (n >= 10_000) return (n / 1_000).toFixed(0) + 'K'
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
    return n.toLocaleString()
  }

  const chips = [
    { label: 'Players',    value: fmt(stats?.total_players) },
    { label: 'Games',      value: fmt(stats?.total_games) },
    { label: 'HR tracked', value: fmt(stats?.total_home_runs) },
    { label: 'PBP events', value: fmt(stats?.total_pbp_events) },
    { label: 'Seasons',    value: fmt(stats?.seasons_tracked) },
  ]

  return (
    <div id="explore" className="grid grid-cols-2 sm:grid-cols-5 gap-3 -mt-12 sm:-mt-16 relative z-10">
      {chips.map((c) => (
        <div
          key={c.label}
          className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 px-4 py-3 sm:py-4 text-center"
        >
          <div className="text-2xl sm:text-3xl font-extrabold text-nw-teal tabular-nums">
            {c.value}
          </div>
          <div className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mt-0.5">
            {c.label}
          </div>
        </div>
      ))}
    </div>
  )
}


// ============================================================
// 2026 SEASON IN REVIEW
// ============================================================
function SeasonInReviewSection() {
  const { data: batting } = useBattingLeaderboard({
    season: SEASON, sort_by: 'offensive_war', sort_dir: 'desc', limit: 1, qualified: true,
  })
  const { data: pitching } = usePitchingLeaderboard({
    season: SEASON, sort_by: 'pitching_war', sort_dir: 'desc', limit: 1, qualified: true,
  })
  const topBatter = batting?.data?.[0]
  const topPitcher = pitching?.data?.[0]

  return (
    <section>
      <SectionHeading
        eyebrow="2026 Season"
        title="The year in review"
        sub="The most-decorated players and the biggest moment of the spring."
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <FeatureCard
          title="NWAC Champion"
          eyebrow="Tournament"
          headline="Lower Columbia"
          subhead="16th NWAC title in school history. Jaylen Kennedy named tournament MVP."
          accent="from-amber-50 to-amber-100 dark:from-amber-900/30 dark:to-amber-900/10 border-amber-200 dark:border-amber-800/40"
          link={{ to: '/articles/lower-columbia-nwac-champions', label: 'Read the recap' }}
          emoji="🏆"
        />
        <PlayerHighlightCard
          eyebrow="Top Hitter (WAR)"
          player={topBatter}
          subStat={topBatter ? `${(topBatter.offensive_war ?? 0).toFixed(1)} WAR` : ''}
          subStat2={topBatter ? `wRC+ ${Math.round(topBatter.wrc_plus ?? 0)}` : ''}
        />
        <PlayerHighlightCard
          eyebrow="Top Pitcher (WAR)"
          player={topPitcher}
          subStat={topPitcher ? `${(topPitcher.pitching_war ?? 0).toFixed(1)} WAR` : ''}
          subStat2={topPitcher ? `ERA+ ${Math.round(topPitcher.era_plus ?? 0)}` : ''}
        />
      </div>
    </section>
  )
}

function FeatureCard({ title, eyebrow, headline, subhead, accent, link, emoji }) {
  return (
    <div className={`rounded-xl bg-gradient-to-br ${accent} border p-5 flex flex-col h-full`}>
      <div className="text-[10px] font-semibold uppercase tracking-[2px] text-gray-500 dark:text-gray-400 mb-2">
        {eyebrow}
      </div>
      {emoji && <div className="text-3xl mb-2">{emoji}</div>}
      <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">{title}</div>
      <div className="text-xl sm:text-2xl font-extrabold text-gray-900 dark:text-gray-100 mb-2 leading-tight">
        {headline}
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-4 flex-1">
        {subhead}
      </p>
      {link && (
        <Link
          to={link.to}
          className="text-sm font-semibold text-nw-teal hover:underline self-start"
        >
          {link.label} →
        </Link>
      )}
    </div>
  )
}

function PlayerHighlightCard({ eyebrow, player, subStat, subStat2 }) {
  if (!player) {
    return (
      <div className="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-5 animate-pulse">
        <div className="h-3 w-20 bg-gray-200 dark:bg-gray-700 rounded mb-3" />
        <div className="h-6 w-3/4 bg-gray-200 dark:bg-gray-700 rounded mb-2" />
        <div className="h-4 w-1/2 bg-gray-200 dark:bg-gray-700 rounded" />
      </div>
    )
  }
  return (
    <div className="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-5 flex flex-col h-full">
      <div className="text-[10px] font-semibold uppercase tracking-[2px] text-gray-500 dark:text-gray-400 mb-3">
        {eyebrow}
      </div>
      <div className="flex items-center gap-3 mb-3">
        {player.headshot_url ? (
          <img
            src={player.headshot_url}
            alt=""
            className="w-12 h-12 rounded-full object-cover ring-1 ring-gray-200 dark:ring-gray-700"
            onError={(e) => { e.target.style.display = 'none' }}
          />
        ) : (
          <div className="w-12 h-12 rounded-full bg-nw-teal/15 dark:bg-nw-teal/25 flex items-center justify-center text-nw-teal font-bold">
            {(player.first_name?.[0] || '?')}{(player.last_name?.[0] || '')}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <Link
            to={`/player/${player.id || player.player_id}`}
            className="block text-lg font-extrabold text-gray-900 dark:text-gray-100 leading-tight hover:text-nw-teal truncate"
          >
            {player.first_name} {player.last_name}
          </Link>
          <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {player.team_short || player.team_name} · {player.division_level}
          </div>
        </div>
      </div>
      <div className="flex gap-3 mt-auto pt-3 border-t border-gray-100 dark:border-gray-700">
        <div className="flex-1">
          <div className="text-lg font-bold text-nw-teal tabular-nums">{subStat}</div>
        </div>
        <div className="flex-1 text-right">
          <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 tabular-nums">{subStat2}</div>
        </div>
      </div>
    </div>
  )
}


// ============================================================
// INLINE SIGNUP CTAs
// ============================================================
function InlineCta({ headline, body }) {
  return (
    <div className="rounded-xl bg-nw-teal/8 dark:bg-nw-teal/15 border border-nw-teal/30 dark:border-nw-teal/40 px-5 py-5 sm:px-6 sm:py-6 flex flex-col sm:flex-row sm:items-center gap-4">
      <div className="flex-1">
        <div className="text-base sm:text-lg font-bold text-gray-900 dark:text-gray-100 mb-1">
          {headline}
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
          {body}
        </p>
      </div>
      <Link
        to="/auth?mode=signup"
        className="shrink-0 px-5 py-2.5 bg-nw-teal text-white rounded-lg font-semibold text-sm hover:bg-pnw-sky transition-colors"
      >
        Sign up free
      </Link>
    </div>
  )
}


// ============================================================
// FREE TOOLS SHOWCASE
// ============================================================
function FreeToolsShowcase() {
  const tools = [
    {
      title: 'Leaderboards',
      desc: 'Hitting, pitching, and fielding leaders across every division.',
      to: '/hitting',
      icon: '📊',
    },
    {
      title: 'Team Pages',
      desc: 'Rosters, schedules, splits, advanced stats for 57 teams.',
      to: '/teams',
      icon: '⚾',
    },
    {
      title: 'Standings',
      desc: 'Live conference and overall rankings, plus PPI ratings.',
      to: '/standings',
      icon: '🏟️',
    },
    {
      title: 'Stat Glossary',
      desc: 'Every metric on the site defined, with formulas.',
      to: '/about#glossary',
      icon: '📖',
    },
  ]
  return (
    <section>
      <SectionHeading
        eyebrow="Free, no sign-up required"
        title="Start exploring"
        sub="Everything on this row works for anonymous visitors. Sign up later to favorite players and personalize your view."
      />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tools.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className="group bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 sm:p-5 hover:border-nw-teal hover:shadow-md transition-all"
          >
            <div className="text-3xl mb-2">{t.icon}</div>
            <div className="text-sm sm:text-base font-bold text-gray-900 dark:text-gray-100 mb-1 group-hover:text-nw-teal transition-colors">
              {t.title}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
              {t.desc}
            </p>
          </Link>
        ))}
      </div>
    </section>
  )
}


// ============================================================
// WHAT'S NEXT
// ============================================================
function WhatsNextCard() {
  return (
    <section className="rounded-xl bg-gradient-to-br from-nw-teal/10 to-pnw-sky/10 dark:from-nw-teal/20 dark:to-pnw-sky/20 border border-nw-teal/20 dark:border-nw-teal/30 p-5 sm:p-7">
      <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal mb-3">
        Coming up
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <h3 className="text-xl sm:text-2xl font-extrabold text-gray-900 dark:text-gray-100 mb-2 leading-tight">
            West Coast League opens June 3
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-3">
            Summer ball returns next week with full WCL coverage: box scores, league
            leaderboards, and player tracking for every PNW team. Sign up now to follow
            your favorite players through the summer.
          </p>
          <Link
            to="/summerball"
            className="inline-block text-sm font-semibold text-nw-teal hover:underline"
          >
            Browse summer ball data →
          </Link>
        </div>
        <div className="bg-white/60 dark:bg-gray-800/60 rounded-lg p-4 border border-white dark:border-gray-700">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
            What we track
          </div>
          <ul className="text-xs text-gray-700 dark:text-gray-300 space-y-1.5">
            <li>· WCL daily box scores</li>
            <li>· League leaderboards</li>
            <li>· Year-over-year splits</li>
            <li>· PIL + CCL coverage too</li>
          </ul>
        </div>
      </div>
    </section>
  )
}


// ============================================================
// LOCK-TEASE CTA
// ============================================================
function LockTeaseCta() {
  const perks = [
    { label: 'Favorite players + bookmark teams', icon: '★' },
    { label: 'Personalized dashboards', icon: '📈' },
    { label: 'Read every article', icon: '📰' },
    { label: 'Email digests when your team plays', icon: '📧' },
  ]
  return (
    <section className="rounded-xl bg-gradient-to-br from-gray-900 to-pnw-slate dark:from-gray-950 dark:to-pnw-slate text-white p-6 sm:p-8">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[2px] text-amber-300 mb-3">
            What you'll unlock
          </div>
          <h3 className="text-2xl sm:text-3xl font-extrabold mb-3 leading-tight">
            A free account, more depth.
          </h3>
          <p className="text-sm text-white/75 leading-relaxed mb-5">
            Personalize the site to the teams and players you care about, and skip
            the paywall on every article we publish.
          </p>
          <Link
            to="/auth?mode=signup"
            className="inline-block px-5 py-2.5 bg-amber-400 text-[#003845] rounded-lg font-bold text-sm hover:bg-amber-300 transition-colors"
          >
            Create free account
          </Link>
        </div>
        <ul className="space-y-3">
          {perks.map((p) => (
            <li key={p.label} className="flex items-start gap-3">
              <span className="shrink-0 w-7 h-7 rounded-full bg-amber-400/15 text-amber-300 flex items-center justify-center text-sm font-bold">
                {p.icon}
              </span>
              <span className="text-sm text-white/90">{p.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}


// ============================================================
// FEATURED ARTICLES
// ============================================================
function FeaturedArticles() {
  const { data: articles } = usePublishedArticles(4)
  const items = Array.isArray(articles) ? articles : (articles?.data || [])
  if (!items.length) return null

  return (
    <section>
      <SectionHeading
        eyebrow="From the site"
        title="Latest articles"
        sub="Recaps, scouting takes, and analysis from the NW Baseball Stats desk."
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {items.slice(0, 3).map((a) => (
          <Link
            key={a.id || a.slug}
            to={`/articles/${a.slug || a.id}`}
            className="group bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden hover:border-nw-teal hover:shadow-md transition-all"
          >
            {a.cover_image_url || a.image_url ? (
              <div
                className="aspect-[16/9] bg-gray-100 dark:bg-gray-700 bg-cover bg-center"
                style={{ backgroundImage: `url(${a.cover_image_url || a.image_url})` }}
              />
            ) : (
              <div className="aspect-[16/9] bg-gradient-to-br from-nw-teal/20 to-pnw-sky/20 dark:from-nw-teal/30 dark:to-pnw-sky/30 flex items-center justify-center text-4xl">
                ⚾
              </div>
            )}
            <div className="p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5">
                {a.published_at
                  ? new Date(a.published_at).toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric',
                    })
                  : 'Article'}
              </div>
              <h4 className="text-sm sm:text-base font-bold text-gray-900 dark:text-gray-100 leading-tight line-clamp-3 group-hover:text-nw-teal transition-colors">
                {a.title}
              </h4>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}


// ============================================================
// FOUNDER + FINAL CTA
// ============================================================
function ClosingCtaWithFounder() {
  return (
    <section className="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-6 sm:p-8 text-center">
      <h3 className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-gray-100 mb-3">
        Ready to dig in?
      </h3>
      <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 max-w-xl mx-auto mb-6">
        Built by a coach, scout, and former pitcher. Free forever for the basics,
        with paid tiers for coaches who need recruiting and game-planning depth.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          to="/auth?mode=signup"
          className="px-6 py-3 bg-nw-teal text-white rounded-lg font-bold hover:bg-pnw-sky transition-colors"
        >
          Create free account
        </Link>
        <Link
          to="/pricing"
          className="px-6 py-3 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg font-semibold hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
        >
          See paid tiers
        </Link>
      </div>
      <div className="mt-6 pt-6 border-t border-gray-100 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
        Questions? <Link to="/about" className="text-nw-teal hover:underline">About the site</Link>
        {' · '}
        <a href="https://x.com/RasmussenBase" target="_blank" rel="noopener noreferrer" className="text-nw-teal hover:underline">@RasmussenBase</a>
      </div>
    </section>
  )
}


// ============================================================
// Helpers
// ============================================================
function SectionHeading({ eyebrow, title, sub }) {
  return (
    <div className="mb-5">
      {eyebrow && (
        <div className="text-[10px] font-semibold uppercase tracking-[2px] text-nw-teal mb-1.5">
          {eyebrow}
        </div>
      )}
      <h2 className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-gray-100 leading-tight mb-1">
        {title}
      </h2>
      {sub && (
        <p className="text-sm text-gray-500 dark:text-gray-400">{sub}</p>
      )}
    </div>
  )
}
