/**
 * Homepage, September 2026 redesign ("Savant" direction with the award cards
 * and Team Ratings tiles from the "Program" direction on top).
 *
 * Reading order on desktop:
 *   1. AwardsRow       four "of the year" cards (rule-based: wRC+, oWAR, K-BB%, best national rank)
 *   2. ResultsStrip    the most recent game date's results
 *   3. RatingsTiles    Team Ratings (CPI) tiles with a division switcher
 *   4. LeaderRail      six leader cards with proportional bars, division pills
 *   5. Play-by-play    coverage, the biggest swing of the season, clutch leaders, pitch-level leaders
 *      Standings       conference standings for one division
 *      WCL             summer standings as run-differential bars
 *   6. Projections     next-season player projections in key categories (hitters / pitchers)
 *      Recruiting      recruiting class ratings for the class currently committing
 *   7. Articles + tools
 *
 * Everything here is light and flat on purpose: white panels on the site
 * cream, one accent (teal), orange only for "below zero" bars. Display type is
 * Archivo (font-archivo), every number is IBM Plex Mono (font-plex); both are
 * loaded on demand by Homepage.jsx.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../../hooks/useApi'
import { CURRENT_SEASON, SUMMER_SEASON, PROJECTION_SEASON, RECRUITING_GRAD_YEAR } from '../../lib/seasons'
import { teamColor, darken } from '../../lib/teamColors'

const SEASON = CURRENT_SEASON
// Projections target the NEXT spring; comes from seasons.js so a January
// CURRENT_SEASON bump does not ask for projections that do not exist yet.
const PROJ_SEASON = PROJECTION_SEASON
const DIVS = ['D1', 'D2', 'D3', 'NAIA', 'NWAC']

// ─── small shared pieces ─────────────────────────────────────────────
function Logo({ src, size = 20, className = '' }) {
  if (!src) return <span style={{ width: size, height: size }} className={`shrink-0 inline-block ${className}`} />
  return (
    <img src={src} alt="" loading="lazy" width={size} height={size}
      className={`shrink-0 object-contain ${className}`} style={{ width: size, height: size }}
      onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} />
  )
}

function Panel({ title, to, linkLabel = 'View all', controls = null, className = '', children }) {
  return (
    <section data-panel className={`bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 min-w-0 ${className}`}>
      {/* data-panel-body is what the Masonry measures: the natural height of the
          content, independent of any stretch applied to the section. */}
      <div data-panel-body>
        <div className="flex items-center gap-3 mb-2">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400 truncate">{title}</h2>
          <div className="ml-auto flex items-center gap-2">
            {controls}
            {to && <Link to={to} className="text-[11px] font-semibold text-nw-teal dark:text-nw-teal-light hover:underline whitespace-nowrap">{linkLabel} →</Link>}
          </div>
        </div>
        {children}
      </div>
    </section>
  )
}

function Lead({ children }) {
  return <p className="font-archivo font-extrabold text-[19px] leading-tight tracking-tight text-gray-900 dark:text-gray-100 mb-3" style={{ fontVariationSettings: '"wdth" 90' }}>{children}</p>
}

function Pills({ options, value, onChange }) {
  return (
    <div className="flex gap-0.5 flex-wrap">
      {options.map((o) => (
        <button key={o} type="button" onClick={() => onChange(o)}
          className={`text-[11px] font-bold px-2 py-0.5 rounded transition-colors ${
            value === o ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900'
              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
          {o === 'all' ? 'All' : o === 'bat' ? 'Hitters' : o === 'pit' ? 'Pitchers' : o}
        </button>
      ))}
    </div>
  )
}

function Skeleton({ rows = 5, className = '' }) {
  return (
    <div className={`space-y-2 animate-pulse ${className}`}>
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="h-3.5 rounded bg-gray-100 dark:bg-gray-700" style={{ width: `${70 + (i * 13) % 30}%` }} />)}
    </div>
  )
}

const Mono = ({ children, className = '' }) => <span className={`font-plex tabular-nums ${className}`}>{children}</span>

function abbrName(name) {
  const parts = (name || '').trim().split(/\s+/)
  return parts.length < 2 ? name : `${parts[0][0]}. ${parts.slice(1).join(' ')}`
}

function Bar({ pct, color = 'bg-nw-teal', className = '' }) {
  return (
    <span className={`block h-1.5 rounded-sm bg-gray-100 dark:bg-gray-700 overflow-hidden ${className}`}>
      <span className={`block h-full rounded-sm ${color}`} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </span>
  )
}

function usePlayerLinks() {
  return (id, wcl = false) => (wcl ? `/summer/players/${id}` : `/player/${id}`)
}

// ─── 1. Awards ────────────────────────────────────────────────────────
function AwardCard({ label, name, to, logo, team, level, headline, line, color }) {
  const bg = `linear-gradient(160deg, ${color} 0%, ${darken(color, 0.4)} 100%)`
  return (
    <div className="relative rounded-lg text-white p-4 min-h-[210px] flex flex-col overflow-hidden" style={{ background: bg }}>
      {logo && (
        <span className="absolute top-3 right-3 w-11 h-11 rounded-md bg-white/90 grid place-items-center">
          <Logo src={logo} size={34} />
        </span>
      )}
      <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/85 pr-14">{label}</div>
      <div className="mt-6">
        {to ? (
          <Link to={to} className="font-archivo font-black text-[24px] leading-none tracking-tight hover:underline block" style={{ fontVariationSettings: '"wdth" 88' }}>{name}</Link>
        ) : (
          <div className="font-archivo font-black text-[24px] leading-none tracking-tight" style={{ fontVariationSettings: '"wdth" 88' }}>{name}</div>
        )}
        <div className="text-[12px] text-white/85 mt-1">{team}{level ? ` · ${level}` : ''}</div>
      </div>
      <div className="mt-auto pt-4">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/80">{headline?.label}</div>
        <Mono className="block text-[56px] font-semibold leading-none tracking-tighter">{headline?.value ?? '–'}</Mono>
      </div>
      {line?.length > 0 && (
        <div className="flex gap-4 mt-2 text-[12px] text-white/85">
          {line.filter(s => s?.value != null).map((s) => (
            <span key={s.label}><Mono className="font-semibold text-white">{s.value}</Mono> {s.label}</span>
          ))}
        </div>
      )}
    </div>
  )
}

function teamOfYear(ratings, natl) {
  // Highest national percentile among PNW teams; JUCO has no national data, so
  // fall back to the top CPI if nothing else is available.
  let best = null
  ;(natl?.divisions || []).forEach((d) => (d.teams || []).forEach((t) => {
    if (t.national_percentile == null) return
    if (!best || t.national_percentile > best.national_percentile) best = { ...t, level: d.division_level }
  }))
  const cpiById = {}
  const teamById = {}
  ;(ratings || []).forEach((d) => (d.teams || []).forEach((t) => { cpiById[t.id] = t.cpi; teamById[t.id] = { ...t, level: d.division_level } }))
  if (!best) {
    const all = Object.values(teamById).filter(t => t.cpi != null).sort((a, b) => b.cpi - a.cpi)
    if (!all.length) return null
    const t = all[0]
    return { name: t.short_name, id: t.id, logo: t.logo_url, level: t.level, wins: t.wins, losses: t.losses, conf: `${t.conf_wins}-${t.conf_losses}`, cpi: Math.round(t.cpi), natl: null }
  }
  const t = teamById[best.team_id] || {}
  return {
    name: best.short_name, id: best.team_id, logo: best.logo_url || t.logo_url, level: best.level,
    wins: t.wins, losses: t.losses, conf: t.conf_wins != null ? `${t.conf_wins}-${t.conf_losses}` : null,
    cpi: cpiById[best.team_id] != null ? Math.round(cpiById[best.team_id]) : null,
    natl: best.composite_rank != null ? Math.round(best.composite_rank) : null,
  }
}

export function AwardsRow({ ratings, natl }) {
  const { data, loading } = useApi('/home/awards', { season: SEASON })
  const team = useMemo(() => teamOfYear(ratings, natl), [ratings, natl])
  const cards = []
  const pc = (k, label) => {
    const c = data?.[k]
    if (!c) return null
    return (
      <AwardCard key={k} label={label} name={c.name} to={`/player/${c.player_id}`} logo={c.logo}
        team={c.team} level={c.level} headline={c.stats?.headline} line={c.stats?.line} color={teamColor(c.team)} />
    )
  }
  cards.push(pc('hitter', 'Hitter of the year'), pc('mvp', 'Most valuable'), pc('pitcher', 'Pitcher of the year'))
  if (team) {
    cards.push(
      <AwardCard key="team" label="Team of the year" name={team.name} to={`/team/${team.id}`} logo={team.logo}
        team={team.level ? `${team.level}${team.natl ? ` · No. ${team.natl} nationally` : ''}` : ''}
        headline={{ label: 'Record', value: team.wins != null ? `${team.wins}-${team.losses}` : '–' }}
        line={[{ label: 'CPI', value: team.cpi }, { label: 'conf', value: team.conf }]}
        color={teamColor(team.name)} />
    )
  }
  const filled = cards.filter(Boolean)
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2 px-0.5">
        <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-gray-500 dark:text-gray-400">{SEASON} season, final</div>
        <Link to="/stat-leaders" className="text-[11px] font-semibold text-nw-teal dark:text-nw-teal-light hover:underline">How these are picked →</Link>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {loading && filled.length < 3
          ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="rounded-lg min-h-[210px] bg-gray-200 dark:bg-gray-700 animate-pulse" />)
          : filled}
      </div>
    </div>
  )
}

// ─── 2. Results strip ─────────────────────────────────────────────────
export function ResultsStrip() {
  const { data } = useApi('/games/recent', { season: SEASON, limit: 12 })
  const games = useMemo(() => {
    const list = Array.isArray(data) ? data : (data?.games || [])
    const finals = list.filter(g => g.status === 'final' && g.home_score != null)
    if (!finals.length) return []
    const latest = finals.map(g => g.game_date).sort().slice(-1)[0]
    return finals.filter(g => g.game_date === latest).slice(0, 6)
  }, [data])
  if (!games.length) return null
  const date = new Date(games[0].game_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2 px-0.5">
        <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-gray-500 dark:text-gray-400">Last results · {date}</div>
        <Link to="/scoreboard" className="text-[11px] font-semibold text-nw-teal dark:text-nw-teal-light hover:underline">Scoreboard →</Link>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
        {games.map((g) => {
          const hw = g.home_score > g.away_score
          const Row = ({ short, logo, score, win, division }) => (
            <div className={`flex items-center gap-1.5 text-[12px] ${win ? 'font-bold text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`}>
              <Logo src={logo} size={16} />
              <span className="truncate flex-1 min-w-0">{short}</span>
              {division && <span className="text-[9px] font-bold text-gray-400 uppercase">{division}</span>}
              <Mono className="text-[13px]">{score}</Mono>
            </div>
          )
          return (
            <Link key={g.id} to={`/game/${g.id}`} className="bg-white dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-2 hover:border-nw-teal transition-colors min-w-0">
              <Row short={g.away_short || g.away_team_name} logo={g.away_logo} score={g.away_score} win={!hw} division={g.away_division} />
              <Row short={g.home_short || g.home_team_name} logo={g.home_logo} score={g.home_score} win={hw} division={g.home_division} />
            </Link>
          )
        })}
      </div>
    </div>
  )
}

// ─── 3. Team Ratings tiles ────────────────────────────────────────────
export function RatingsTiles({ ratings, natl, loading }) {
  const [div, setDiv] = useState(() => { try { return localStorage.getItem('home.div') || 'D1' } catch { return 'D1' } })
  const pick = (d) => { setDiv(d); try { localStorage.setItem('home.div', d) } catch { /* noop */ } }
  const rankById = {}
  ;(natl?.divisions || []).forEach((d) => (d.teams || []).forEach((t) => { if (t.composite_rank != null) rankById[t.team_id] = Math.round(t.composite_rank) }))
  const level = div === 'NWAC' ? 'JUCO' : div
  const block = (ratings || []).find((d) => d.division_level === level)
  const teams = (block?.teams || []).filter(t => t.cpi != null).sort((a, b) => b.cpi - a.cpi).slice(0, 6)
  return (
    <div>
      <div className="flex items-center gap-3 mb-2 px-0.5 flex-wrap">
        <h2 className="font-archivo font-black text-[22px] tracking-tight text-gray-900 dark:text-gray-100" style={{ fontVariationSettings: '"wdth" 88' }}>Team Ratings</h2>
        <Pills options={DIVS} value={div} onChange={pick} />
        <Link to="/team-ratings" className="ml-auto text-[11px] font-semibold text-nw-teal dark:text-nw-teal-light hover:underline">Full ratings and standings →</Link>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2.5">
        {loading && !teams.length
          ? Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-[118px] rounded-lg bg-gray-200 dark:bg-gray-700 animate-pulse" />)
          : teams.map((t) => {
            const cpi = Math.round(t.cpi)
            const natRank = rankById[t.id]
            return (
              <Link key={t.id} to={`/team/${t.id}`} className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 flex flex-col gap-2 hover:border-nw-teal transition-colors min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Logo src={t.logo_url} size={30} />
                  <div className="min-w-0">
                    <div className="font-archivo font-bold text-[14px] leading-tight truncate text-gray-900 dark:text-gray-100">{t.short_name}</div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate"><Mono>{t.wins}-{t.losses}</Mono>{t.conference_abbrev ? ` · ${t.conference_abbrev}` : ''}</div>
                  </div>
                </div>
                <div className="flex items-end justify-between">
                  <div>
                    <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-gray-400">CPI</div>
                    <Mono className={`block text-[28px] font-semibold leading-none ${cpi >= 100 ? 'text-nw-teal dark:text-nw-teal-light' : 'text-gray-700 dark:text-gray-300'}`}>{cpi}</Mono>
                  </div>
                  <div className="text-right text-[10px] text-gray-500 dark:text-gray-400 leading-tight">
                    {natRank != null
                      ? <><Mono className="block text-[15px] font-semibold text-gray-900 dark:text-gray-100">#{natRank}</Mono>{div === 'NWAC' ? 'NWAC' : 'natl'}</>
                      : <><Mono className="block text-[15px] font-semibold text-gray-900 dark:text-gray-100">{t.conf_wins != null ? `${t.conf_wins}-${t.conf_losses}` : '–'}</Mono>conf</>}
                  </div>
                </div>
                <Bar pct={((cpi - 60) / (140 - 60)) * 100} />
              </Link>
            )
          })}
      </div>
    </div>
  )
}

// ─── 4. Leader rail ───────────────────────────────────────────────────
const RAIL_KEYS = [
  ['hitting', 'wrc_plus'], ['hitting', 'owar'], ['hitting', 'hr'],
  ['pitching', 'pwar'], ['pitching', 'fip_plus'], ['pitching', 'k_pct'],
]
const LOWER_BETTER = new Set(['era', 'baa', 'bb_pct', 'kbb'])

export function LeaderRail() {
  const [division, setDivision] = useState('all')
  const { data, loading } = useApi('/home/leaders', { division }, [division])
  const isWcl = division === 'WCL'
  const link = usePlayerLinks()
  const cats = RAIL_KEYS.map(([side, key]) => (data?.[side] || []).find(c => c.key === key)).filter(Boolean)
  return (
    <div>
      <div className="flex items-center gap-3 mb-2 px-0.5 flex-wrap">
        <h2 className="font-archivo font-black text-[22px] tracking-tight text-gray-900 dark:text-gray-100" style={{ fontVariationSettings: '"wdth" 88' }}>Stat Leaders</h2>
        <Pills options={['all', ...DIVS, 'WCL']} value={division} onChange={setDivision} />
        <Link to={isWcl ? '/summer/stats' : '/stat-leaders'} className="ml-auto text-[11px] font-semibold text-nw-teal dark:text-nw-teal-light hover:underline">All leaderboards →</Link>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2.5">
        {(loading && !cats.length ? Array.from({ length: 6 }) : cats).map((c, i) => {
          if (!c) return <div key={i} className="h-[150px] rounded-lg bg-gray-200 dark:bg-gray-700 animate-pulse" />
          const top = c.leaders[0]
          const lower = LOWER_BETTER.has(c.key)
          const scale = (l) => !top || !l ? 0 : lower ? (top.value / l.value) * 100 : (l.value / top.value) * 100
          return (
            <div key={c.key} className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 min-w-0">
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">{c.label}</span>
                <span className="text-[10px] text-gray-400">{isWcl ? 'WCL' : division === 'all' ? 'All levels' : division}</span>
              </div>
              {top ? (
                <>
                  <div className="mt-1.5 flex items-center gap-1.5 min-w-0">
                    <Logo src={top.logo} size={18} />
                    <Link to={link(top.player_id, isWcl)} className="font-bold text-[14px] leading-tight truncate text-gray-900 dark:text-gray-100 hover:text-nw-teal hover:underline" title={top.name}>{top.name}</Link>
                  </div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{top.team}{top.level ? ` · ${top.level}` : ''}</div>
                  <Mono className="block text-[30px] font-semibold leading-none tracking-tight mt-1.5 text-gray-900 dark:text-gray-100">{top.display}</Mono>
                  <div className="mt-2 space-y-1">
                    {c.leaders.slice(0, 3).map((l, j) => (
                      <div key={l.player_id} className="flex items-center gap-1.5 text-[10px]">
                        <span className="w-[62px] truncate text-gray-500 dark:text-gray-400" title={l.name}>{abbrName(l.name)}</span>
                        <Bar pct={scale(l)} color={j === 0 ? 'bg-nw-teal' : 'bg-nw-teal/40'} className="flex-1" />
                        <Mono className="w-9 text-right text-gray-600 dark:text-gray-300">{l.display}</Mono>
                      </div>
                    ))}
                  </div>
                </>
              ) : <div className="text-[12px] text-gray-400 mt-3">No qualified leaders yet.</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── 5a. Play-by-play ─────────────────────────────────────────────────
function pbpLeaders(data, side, key) {
  return (data?.[side] || []).find(c => c.key === key)
}

export function PbpPanel() {
  const { data, loading } = useApi('/home/pbp', { season: SEASON })
  const { data: leaders } = useApi('/home/leaders', { division: 'all' })
  const link = usePlayerLinks()
  const cov = data?.coverage
  const m = data?.moment
  const pct = cov?.final_games ? Math.round((cov.games / cov.final_games) * 100) : null
  const mini = [
    ['Contact%', pbpLeaders(leaders, 'hitting', 'contact'), false],
    ['Air-pull%', pbpLeaders(leaders, 'hitting', 'airpull'), false],
    ['Whiff%', pbpLeaders(leaders, 'pitching', 'whiff'), true],
    ['Putaway%', pbpLeaders(leaders, 'pitching', 'putaway'), true],
  ]
  const half = m ? (m.half === 'bottom' ? 'B' : 'T') : ''
  const before = m ? `${m.bat_score_before}-${m.fld_score_before}` : ''
  return (
    <Panel title="Play-by-play · every pitch charted" to="/percentiles" linkLabel="Percentiles">
      {loading && !data ? <Skeleton rows={8} /> : (
        <>
          <Lead>{cov ? <><Mono>{cov.events.toLocaleString()}</Mono> plays charted across {pct != null ? `${pct}% of` : ''} {SEASON} games.</> : 'Every pitch of every game, charted.'}</Lead>
          <p className="text-[12px] text-gray-500 dark:text-gray-400 -mt-2 mb-3">
            Win probability, leverage, batted balls and pitch sequences for every plate appearance, at every level. <Mono>{(cov?.events_all_time || 0).toLocaleString()}</Mono> plays all time.
          </p>
          {m && (
            <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3 mb-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">Biggest swing of {SEASON}</span>
                <Mono className="text-[15px] font-semibold text-nw-teal dark:text-nw-teal-light">+{Math.round(m.wpa * 100)}% WPA</Mono>
              </div>
              <div className="flex items-center gap-2 text-[12px] font-semibold text-gray-900 dark:text-gray-100">
                <Logo src={m.bat_logo} size={18} />
                {m.player_id ? <Link to={link(m.player_id)} className="hover:underline">{m.name}</Link> : m.name}
                <span className="text-gray-400 font-normal">· {m.bat_team}</span>
              </div>
              <p className="text-[12px] text-gray-600 dark:text-gray-300 leading-snug mt-1">{m.result_text}</p>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                {half}{m.inning}, {m.outs_before} out, down {before} · {m.away_short} at {m.home_short}, final <Mono>{m.away_score}-{m.home_score}</Mono> · {m.game_date ? new Date(m.game_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
              </div>
            </div>
          )}
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400 mb-1">Clutch hitters · season WPA</div>
          <div className="space-y-1 mb-3">
            {(data?.clutch_hitters || []).map((h, i) => (
              <div key={h.player_id} className="grid items-center gap-2 text-[12px]" style={{ gridTemplateColumns: '14px 18px 1fr 70px 44px' }}>
                <Mono className="text-gray-400 text-[11px]">{i + 1}</Mono>
                <Logo src={h.logo} size={18} />
                <Link to={link(h.player_id)} className="truncate font-semibold text-gray-900 dark:text-gray-100 hover:underline">{h.name} <span className="font-normal text-gray-400">{h.team}</span></Link>
                <Bar pct={(h.wpa / (data.clutch_hitters[0]?.wpa || 1)) * 100} />
                <Mono className="text-right text-gray-700 dark:text-gray-300">+{h.wpa.toFixed(2)}</Mono>
              </div>
            ))}
          </div>
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400 mb-1">Pitch-level leaders</div>
          <div className="grid grid-cols-2 gap-2">
            {mini.map(([label, cat]) => {
              const t = cat?.leaders?.[0]
              return (
                <div key={label} className="rounded-md bg-gray-50 dark:bg-gray-900/40 px-2.5 py-2 min-w-0">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</div>
                  {t ? (
                    <>
                      <Mono className="block text-[18px] font-semibold leading-tight text-gray-900 dark:text-gray-100">{t.display}</Mono>
                      <Link to={link(t.player_id)} className="text-[11px] truncate block text-gray-700 dark:text-gray-300 hover:underline">{t.name} <span className="text-gray-400">{t.team}</span></Link>
                    </>
                  ) : <div className="text-[11px] text-gray-400">–</div>}
                </div>
              )
            })}
          </div>
          <div className="mt-3 flex gap-3 text-[11px] font-semibold">
            <Link to="/top-moments" className="text-nw-teal dark:text-nw-teal-light hover:underline">Top moments →</Link>
            <Link to="/percentiles" className="text-nw-teal dark:text-nw-teal-light hover:underline">Savant-style percentiles →</Link>
          </div>
        </>
      )}
    </Panel>
  )
}

// ─── 5b. Standings ────────────────────────────────────────────────────
export function StandingsPanel({ standings, loading }) {
  const [div, setDiv] = useState('NAIA')
  const level = div === 'NWAC' ? 'JUCO' : div
  const confs = (standings?.conferences || []).filter(c => c.division_level === level && (c.teams || []).length)
  let groups
  if (div === 'D1') {
    const pnw = []
    confs.forEach(c => (c.teams || []).forEach(t => { if (t.is_pnw) pnw.push(t) }))
    pnw.sort((a, b) => (b.win_pct ?? 0) - (a.win_pct ?? 0))
    groups = [{ name: 'PNW Division I, by win percentage', teams: pnw.slice(0, 8), key: 'd1' }]
  } else {
    groups = confs.map(c => ({ name: c.conference_name, teams: (c.teams || []).slice(0, 6), key: c.conference_id }))
  }
  const rec = (w, l) => (w != null && (w || l)) ? `${w}-${l}` : '–'
  return (
    <Panel title="Standings" to="/standings" linkLabel="Full standings" controls={<Pills options={DIVS} value={div} onChange={setDiv} />}>
      {loading && !standings ? <Skeleton rows={10} /> : groups.map((g) => (
        <div key={g.key} className="mb-3 last:mb-0">
          <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400 mb-1">
            <span className="truncate">{g.name}</span>
            <span className="flex gap-2 shrink-0"><span className="w-10 text-right">Conf</span><span className="w-10 text-right">All</span></span>
          </div>
          {g.teams.map((t, i) => (
            <Link key={t.id} to={`/team/${t.id}`} className="grid items-center gap-1.5 py-[3px] border-t border-gray-100 dark:border-gray-700/60 text-[12px] hover:bg-gray-50 dark:hover:bg-gray-700/40" style={{ gridTemplateColumns: '14px 18px 1fr 40px 40px' }}>
              <Mono className="text-[11px] text-gray-400">{i + 1}</Mono>
              <Logo src={t.logo_url} size={18} />
              <span className="truncate font-semibold text-gray-900 dark:text-gray-100">{t.short_name}</span>
              <Mono className="text-right text-gray-700 dark:text-gray-300">{rec(t.conf_wins, t.conf_losses)}</Mono>
              <Mono className="text-right text-gray-500 dark:text-gray-400">{rec(t.wins, t.losses)}</Mono>
            </Link>
          ))}
        </div>
      ))}
    </Panel>
  )
}

// ─── 5c. WCL ──────────────────────────────────────────────────────────
export function WclPanel() {
  // WCL is summer ball: use the most recent summer with data, not the spring year.
  const { data, loading } = useApi('/summer/standings', { season: SUMMER_SEASON })
  const teams = Array.isArray(data) ? data : (data?.teams || [])
  const byDiv = useMemo(() => {
    const g = {}
    teams.forEach((t) => { (g[t.division || 'League'] ||= []).push({ ...t, diff: (t.runs_scored || 0) - (t.runs_against || 0) }) })
    Object.values(g).forEach(list => list.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0)))
    return g
  }, [teams])
  const maxAbs = Math.max(60, ...teams.map(t => Math.abs((t.runs_scored || 0) - (t.runs_against || 0))))
  const best = teams.length ? [...teams].sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0] : null
  const bestDiff = best ? (best.runs_scored || 0) - (best.runs_against || 0) : 0
  return (
    <Panel title={`West Coast League · ${SUMMER_SEASON}`} to="/summer" linkLabel="Summer hub">
      {loading && !teams.length ? <Skeleton rows={10} /> : (
        <>
          {best && <Lead>{best.short_name || best.name} finished <Mono>{best.wins}-{best.losses}</Mono>, {bestDiff >= 0 ? '+' : ''}{bestDiff} in runs.</Lead>}
          {Object.entries(byDiv).map(([div, list]) => (
            <div key={div} className="mb-3 last:mb-0">
              <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400 mb-1">
                <span>{div} · run differential</span><span>W-L</span>
              </div>
              {list.map((t) => {
                const w = (Math.abs(t.diff) / maxAbs) * 50
                return (
                  <Link key={t.id} to={`/summer/teams/${t.team_id || t.id}`} className="grid items-center gap-1.5 py-[3px] border-t border-gray-100 dark:border-gray-700/60 text-[12px] hover:bg-gray-50 dark:hover:bg-gray-700/40" style={{ gridTemplateColumns: '18px 1fr 1fr 40px' }}>
                    <Logo src={t.logo_url} size={18} />
                    <span className="truncate font-semibold text-gray-900 dark:text-gray-100">{t.short_name || t.name}</span>
                    <span className="relative block h-2 rounded-sm bg-gray-100 dark:bg-gray-700">
                      <span className={`absolute top-0 h-full rounded-sm ${t.diff >= 0 ? 'bg-nw-teal' : 'bg-orange-500'}`} style={{ left: `${t.diff >= 0 ? 50 : 50 - w}%`, width: `${Math.max(1, w)}%` }} />
                      <span className="absolute top-0 left-1/2 w-px h-full bg-gray-300 dark:bg-gray-600" />
                    </span>
                    <Mono className="text-right text-gray-600 dark:text-gray-300">{t.wins}-{t.losses}</Mono>
                  </Link>
                )
              })}
            </div>
          ))}
        </>
      )}
    </Panel>
  )
}

// ─── 6a. Projections ──────────────────────────────────────────────────
const PROJ_COLS = {
  bat: [
    { key: 'WAR', label: 'WAR', fmt: v => v.toFixed(1) },
    { key: 'wOBA', label: 'wOBA', fmt: v => v.toFixed(3).replace(/^0/, '') },
    { key: 'HR', label: 'HR', fmt: v => Math.round(v).toString() },
    { key: 'OPS', label: 'OPS', fmt: v => v.toFixed(3).replace(/^0/, '') },
  ],
  pit: [
    { key: 'WAR', label: 'WAR', fmt: v => v.toFixed(1) },
    { key: 'FIP', label: 'FIP', fmt: v => v.toFixed(2), asc: true },
    { key: 'K_pct', label: 'K%', fmt: v => `${(v * 100).toFixed(1)}%` },
    { key: 'ERA', label: 'ERA', fmt: v => v.toFixed(2), asc: true },
  ],
}
const PROJ_MIN = { bat: p => (p.PT || 0) >= 150, pit: p => (p.IP || 0) >= 40 }

export function ProjectionsPanel() {
  const [side, setSide] = useState('bat')
  const [statKey, setStatKey] = useState('WAR')
  const { data, loading } = useApi('/projections/player-leaders', { side, season: PROJ_SEASON }, [side])
  const players = (data?.players || []).filter(p => !p.insufficient && PROJ_MIN[side](p))
  const cols = PROJ_COLS[side]
  const c = cols.find(x => x.key === statKey) || cols[0]
  const list = players.filter(p => p[c.key] != null).sort((a, b) => c.asc ? a[c.key] - b[c.key] : b[c.key] - a[c.key]).slice(0, 8)
  const top = list[0]?.[c.key]
  const pickSide = (sd) => { setSide(sd); setStatKey('WAR') }
  return (
    <Panel title={`${PROJ_SEASON} projections`} to="/projections" linkLabel="All projections"
      controls={<Pills options={['bat', 'pit']} value={side} onChange={pickSide} />}>
      <Lead>Who the model likes for {PROJ_SEASON}, before a pitch is thrown.</Lead>
      <p className="text-[12px] text-gray-500 dark:text-gray-400 -mt-2 mb-2">
        College Marcel projections for every returner, transfer and freshman. Minimum {side === 'bat' ? '150 projected PA' : '40 projected IP'}.
      </p>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">Projected {c.label}</div>
        <Pills options={cols.map(x => x.key)} value={c.key} onChange={setStatKey} />
      </div>
      {loading && !data ? <Skeleton rows={8} /> : list.map((p, i) => {
        const pct = top == null ? 0 : c.asc ? (top / p[c.key]) * 100 : (p[c.key] / top) * 100
        return (
          <div key={p.player_id} className="grid items-center gap-1.5 py-[3px] border-t border-gray-100 dark:border-gray-700/60 text-[12px]" style={{ gridTemplateColumns: '14px 18px 1fr 48px' }}>
            <Mono className="text-[11px] text-gray-400">{i + 1}</Mono>
            <Logo src={p.logo_url} size={18} />
            <div className="min-w-0">
              <Link to={`/player/${p.canonical_id || p.player_id}`} className="block truncate font-semibold text-gray-900 dark:text-gray-100 hover:underline">
                {p.name} <span className="font-normal text-gray-400">{p.team} · {p.level}{p.is_incoming ? ' · new' : ''}</span>
              </Link>
              <Bar pct={pct} className="mt-1" color={i === 0 ? 'bg-nw-teal' : 'bg-nw-teal/40'} />
            </div>
            <Mono className="text-right text-gray-700 dark:text-gray-300">{c.fmt(p[c.key])}</Mono>
          </div>
        )
      })}
    </Panel>
  )
}

// ─── 6b. Recruiting ───────────────────────────────────────────────────
export function RecruitingPanel() {
  const { data, loading } = useApi('/recruiting/classes/top')
  const classes = (data?.classes || []).slice(0, 7)
  // The endpoint defaults to the class currently committing (backend
  // RECRUITING_GRAD_YEAR); mirror that if the payload ever omits grad_year.
  const year = data?.grad_year || RECRUITING_GRAD_YEAR
  return (
    <Panel title={`${year} recruiting classes`} to="/recruiting-classes" linkLabel="All classes">
      {loading && !data ? <Skeleton rows={7} /> : (
        <>
          {classes[0] && <Lead>{classes[0].short_name} signed the region's top class.</Lead>}
          <p className="text-[12px] text-gray-500 dark:text-gray-400 -mt-2 mb-3">Class rating averages each commit's state ranking. Higher is better.</p>
          {classes.map((c, i) => (
            <Link key={c.team_id} to={`/recruiting-classes`} className="grid items-center gap-2 py-1.5 border-t border-gray-100 dark:border-gray-700/60 text-[12px] hover:bg-gray-50 dark:hover:bg-gray-700/40" style={{ gridTemplateColumns: '14px 22px 1fr 40px' }}>
              <Mono className="text-[11px] text-gray-400">{i + 1}</Mono>
              <Logo src={c.logo_url} size={22} />
              <div className="min-w-0">
                <div className="truncate font-semibold text-gray-900 dark:text-gray-100">{c.short_name} <span className="font-normal text-gray-400">{c.division} · {c.commits} commits</span></div>
                <Bar pct={c.class_score} className="mt-1" color="bg-amber-500" />
                {c.top_commit?.name && <div className="text-[10px] text-gray-400 truncate mt-0.5">Top commit: {c.top_commit.name}{c.top_commit.position ? `, ${c.top_commit.position}` : ''}</div>}
              </div>
              <Mono className="text-right text-[15px] font-semibold text-gray-900 dark:text-gray-100">{c.class_score}</Mono>
            </Link>
          ))}
        </>
      )}
    </Panel>
  )
}

// ─── 7a. Articles ─────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return { d: '', m: '' }
  const dt = new Date(iso)
  return { d: dt.getDate(), m: dt.toLocaleDateString('en-US', { month: 'short' }).toUpperCase() }
}

export function ArticlesPanel() {
  const { data, loading } = useApi('/articles', { limit: 4 })
  const arts = data?.articles || []
  const [first, ...rest] = arts
  return (
    <Panel title="From the newsroom" to="/news" linkLabel="All articles">
      {loading && !data ? <Skeleton rows={6} /> : !arts.length ? <div className="text-[12px] text-gray-400">No articles yet.</div> : (
        <div className="grid grid-cols-1 gap-3">
          <Link to={`/news/${first.slug}`} className="group min-w-0">
            {first.hero_image_url
              ? <img src={first.hero_image_url} alt="" className="w-full aspect-[16/9] object-cover rounded-md bg-gray-100 dark:bg-gray-700" onError={(e) => { e.currentTarget.style.display = 'none' }} />
              : <div className="w-full aspect-[16/9] rounded-md bg-gradient-to-br from-nw-teal to-nw-teal-dark" />}
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-400 mt-2">{new Date(first.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
            <h3 className="font-archivo font-extrabold text-[19px] leading-tight tracking-tight text-gray-900 dark:text-gray-100 group-hover:text-nw-teal mt-0.5" style={{ fontVariationSettings: '"wdth" 90' }}>{first.title}</h3>
            {(first.subtitle || first.excerpt) && <p className="text-[12.5px] text-gray-600 dark:text-gray-300 leading-snug mt-1 line-clamp-3">{first.subtitle || first.excerpt}</p>}
          </Link>
          <div className="min-w-0">
            {rest.slice(0, 3).map((a) => {
              const { d, m } = fmtDate(a.published_at)
              return (
                <Link key={a.id || a.slug} to={`/news/${a.slug}`} className="grid gap-3 py-2.5 border-t first:border-t-0 border-gray-100 dark:border-gray-700/60 group" style={{ gridTemplateColumns: '40px 1fr' }}>
                  <div className="font-plex text-[10px] text-gray-400 leading-tight"><Mono className="block text-[20px] font-semibold text-gray-900 dark:text-gray-100">{d}</Mono>{m}</div>
                  <div className="min-w-0">
                    <h4 className="font-bold text-[14px] leading-tight text-gray-900 dark:text-gray-100 group-hover:text-nw-teal line-clamp-2">{a.title}</h4>
                    {(a.subtitle || a.excerpt) && <p className="text-[12px] text-gray-500 dark:text-gray-400 leading-snug mt-0.5 line-clamp-2">{a.subtitle || a.excerpt}</p>}
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      )}
    </Panel>
  )
}

// ─── 7b. By the numbers ───────────────────────────────────────────────
export function SiteNumbersPanel() {
  const { data, loading } = useApi('/site-stats')
  const rows = data ? [
    ['Players tracked', data.total_players, '/players'],
    ['Games', data.total_games, '/scoreboard'],
    ['Plays charted', data.total_pbp_events, '/top-moments'],
    ['Home runs', data.total_home_runs, '/hitting'],
    ['Stolen bases', data.total_stolen_bases, '/hitting'],
    ['Strikeouts', data.total_strikeouts, '/pitching'],
    ['Innings pitched', data.total_innings_pitched, '/pitching'],
  ] : []
  return (
    <Panel title="The database, by the numbers" to="/about" linkLabel="About the site">
      {loading && !data ? <Skeleton rows={7} /> : (
        <>
          <Lead>{data?.total_teams || 57} programs, five levels, every box score and every pitch.</Lead>
          <div className="grid grid-cols-2 gap-x-4">
            {rows.map(([label, v, to]) => (
              <Link key={label} to={to} className="py-2 border-t border-gray-100 dark:border-gray-700/60 min-w-0 hover:bg-gray-50 dark:hover:bg-gray-700/40">
                <Mono className="block text-[22px] font-semibold leading-none text-gray-900 dark:text-gray-100">{(v || 0).toLocaleString()}</Mono>
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500 dark:text-gray-400">{label}</span>
              </Link>
            ))}
          </div>
        </>
      )}
    </Panel>
  )
}

// ─── 7c. Conference champions ─────────────────────────────────────────
const CONF_ORDER = ['CCC', 'GNAC', 'NWC', 'NWAC-N', 'NWAC-S', 'NWAC-E', 'NWAC-W', 'WCC', 'Big Ten', 'MWC']
function confSort(a, b) {
  const ia = CONF_ORDER.indexOf(a), ib = CONF_ORDER.indexOf(b)
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
}
function levelLabel(l) { return l === 'JUCO' ? 'NWAC' : l }

export function ChampionsPanel({ standings }) {
  const { data, loading } = useApi('/home/champions', { season: SEASON })
  const regular = useMemo(() => {
    const out = []
    ;(standings?.conferences || []).forEach((c) => {
      if (!c.conference_abbrev || c.conference_abbrev === 'IND') return
      const winners = (c.teams || []).filter(t => t.rank === 1 || /^T-?1$/i.test(String(t.rank_label || '')))
      if (!winners.length) return
      out.push({ conf: c.conference_abbrev, name: c.conference_name, level: levelLabel(c.division_level), winners })
    })
    return out.sort((a, b) => confSort(a.conf, b.conf))
  }, [standings])
  const tourn = [...(data?.tournaments || [])].sort((a, b) => confSort(a.conference, b.conference))
  const Row = ({ logo, name, to, sub, right }) => (
    <Link to={to || '#'} className="grid items-center gap-2 py-[5px] border-t border-gray-100 dark:border-gray-700/60 text-[12px] hover:bg-gray-50 dark:hover:bg-gray-700/40" style={{ gridTemplateColumns: '22px 1fr auto' }}>
      <Logo src={logo} size={22} />
      <div className="min-w-0"><div className="truncate font-semibold text-gray-900 dark:text-gray-100">{name}</div><div className="text-[10px] text-gray-500 dark:text-gray-400 truncate">{sub}</div></div>
      <div className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 whitespace-nowrap">{right}</div>
    </Link>
  )
  return (
    <Panel title={`${SEASON} champions`} to="/standings" linkLabel="Standings">
      {!standings && loading ? <Skeleton rows={8} /> : (
        <>
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400 mb-1">Conference tournaments</div>
          {tourn.length ? tourn.map((t) => (
            <Row key={t.conference + t.team} logo={t.logo} name={t.team} to={t.team_id ? `/team/${t.team_id}` : '/standings'}
              sub={t.note || t.event} right={<><span>{t.conference}</span><span className="block text-gray-400 font-semibold">{t.level}</span></>} />
          )) : <div className="text-[12px] text-gray-400 py-1">Tournaments start in May.</div>}
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400 mt-4 mb-1">Regular season</div>
          {regular.map((r) => r.winners.map((t) => (
            <Row key={r.conf + t.id} logo={t.logo_url} name={t.short_name} to={`/team/${t.id}`}
              sub={`${t.conf_wins}-${t.conf_losses} in ${r.name}${r.winners.length > 1 ? ' (shared)' : ''}`}
              right={<><span>{r.conf}</span><span className="block text-gray-400 font-semibold">{r.level}</span></>} />
          )))}
        </>
      )}
    </Panel>
  )
}

// ─── Masonry ──────────────────────────────────────────────────────────
// Panels have very different heights depending on the data, so a plain grid
// leaves holes. This lays them out greedily (each panel goes to the shortest
// column, in the order given), then spreads any leftover height across the
// panels of shorter columns so every column ends on the same line. Children
// never move between DOM parents, so their state and fetches survive.
function useColumnCount() {
  const get = () => (typeof window === 'undefined' ? 3 : window.innerWidth >= 1024 ? 3 : window.innerWidth >= 640 ? 2 : 1)
  const [n, setN] = useState(get)
  useEffect(() => {
    const onResize = () => setN(get())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return n
}

function assignColumns(heights, cols, gap) {
  const n = heights.length
  if (cols <= 1) return heights.map(() => 0)
  const greedy = () => {
    const colH = Array(cols).fill(0)
    return heights.map((h) => {
      let c = 0
      for (let k = 1; k < cols; k++) if (colH[k] < colH[c] - 1) c = k
      colH[c] += h + gap
      return c
    })
  }
  if (n > 11) return greedy()
  let best = null, bestScore = Infinity
  const cur = Array(n).fill(0)
  const colH = Array(cols).fill(0)
  const rec = (i) => {
    if (i === n) {
      if (colH.some((h) => h === 0)) return
      const score = Math.max(...colH) - Math.min(...colH)
      if (score < bestScore - 0.5) { bestScore = score; best = cur.slice() }
      return
    }
    for (let c = 0; c < cols; c++) {
      cur[i] = c; colH[c] += heights[i] + gap
      rec(i + 1)
      colH[c] -= heights[i] + gap
    }
  }
  rec(0)
  return best || greedy()
}

export function Masonry({ children, gap = 16 }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : [children]
  const cols = useColumnCount()
  const wrapRef = useRef(null)
  const itemRefs = useRef([])
  const [layout, setLayout] = useState({ pos: [], height: 0, colW: 0 })

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let raf = 0
    const measure = () => {
      const width = el.clientWidth
      if (!width) return
      const colW = (width - gap * (cols - 1)) / cols
      // Natural height of each panel: its body plus the section's own padding
      // and border, so a stretch from a previous pass never feeds back in.
      const heights = itemRefs.current.map((r) => {
        if (!r) return 0
        const sec = r.querySelector('[data-panel]')
        const body = sec && sec.querySelector('[data-panel-body]')
        if (!sec || !body) return r.offsetHeight
        const cs = getComputedStyle(sec)
        return body.offsetHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
          + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
      })
      // Pick the column assignment with the least slack (max column minus min
      // column). With a handful of panels every assignment can be tried; the
      // first best one in lexicographic order keeps early panels in early
      // columns, so the reading order stays sensible. Panels never reorder
      // within a column.
      const colOf = assignColumns(heights, cols, gap)
      const colH = Array(cols).fill(0)
      colOf.forEach((c, i) => { colH[c] += heights[i] + gap })
      const maxH = Math.max(...colH)
      // spread the slack of each shorter column across its panels
      const perCol = colH.map((h) => maxH - h)
      const countCol = Array(cols).fill(0)
      colOf.forEach((c) => { countCol[c] += 1 })
      const extra = perCol.map((slack, c) => (countCol[c] ? slack / countCol[c] : 0))
      const run = Array(cols).fill(0)
      const pos = heights.map((h, i) => {
        const c = colOf[i]
        const top = run[c]
        const hh = h + (cols > 1 ? extra[c] : 0)
        run[c] += hh + gap
        return { left: c * (colW + gap), top, height: hh }
      })
      setLayout({ pos, height: Math.max(0, maxH - gap), colW })
    }
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure) })
    ro.observe(el)
    itemRefs.current.forEach((r) => { const b = r && r.querySelector('[data-panel-body]'); ro.observe(b || r) })
    measure()
    return () => { ro.disconnect(); cancelAnimationFrame(raf) }
  }, [cols, gap, items.length])

  if (cols === 1) {
    return <div className="flex flex-col gap-4">{items}</div>
  }
  const ready = layout.pos.length === items.length && layout.colW > 0
  return (
    <div ref={wrapRef} className="relative" style={{ height: ready ? layout.height : undefined }}>
      {items.map((child, i) => {
        const p = ready ? layout.pos[i] : null
        return (
          <div key={child.key ?? i} ref={(r) => { itemRefs.current[i] = r }}
            className={ready ? 'absolute' : 'relative mb-4'}
            style={ready ? { left: p.left, top: p.top, width: layout.colW } : { width: layout.colW || undefined }}>
            <div className="h-full flex flex-col [&>section]:flex-1" style={ready && p.height ? { minHeight: p.height } : undefined}>
              {child}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── 7d. Tools ────────────────────────────────────────────────────────
const TOOLS = [
  ['Portal', 'Coach & Scouting Portal', 'Series planner, scouting sheets, lineup helper, printable PDFs', '/portal'],
  ['Players', 'Player Comps', 'Closest NW and MLB comparables for every player', '/player-comps'],
  ['Transfers', 'Transfer Portal Tracker', 'Every PNW player in the portal with full stat lines', '/coaching/transfer-portal'],
  ['Recruiting', 'Recruiting Classes', 'Every PNW program\'s incoming class, rated', '/recruiting-classes'],
  ['Game', 'Coaching Simulator', 'Run a PNW program, D1 through NWAC', '/gm'],
  ['Games', 'PNW Grid', 'A new puzzle every day, built on the database', '/pnw-grid'],
]

export function ToolsRow() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2.5">
      {TOOLS.map(([kicker, name, desc, to]) => (
        <Link key={to} to={to} className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 hover:border-nw-teal transition-colors min-w-0">
          <div className="font-plex text-[10px] uppercase tracking-[0.14em] text-nw-teal dark:text-nw-teal-light mb-1">{kicker}</div>
          <div className="font-bold text-[14px] text-gray-900 dark:text-gray-100 leading-tight">{name}</div>
          <div className="text-[11.5px] text-gray-500 dark:text-gray-400 leading-snug mt-0.5">{desc}</div>
        </Link>
      ))}
    </div>
  )
}
