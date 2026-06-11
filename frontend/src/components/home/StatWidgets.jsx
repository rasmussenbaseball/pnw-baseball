/**
 * Homepage stat widgets (June 2026 redesign) — five compact cards built on
 * the shared WidgetShell system:
 *
 *   StandingsWidget   — final conference standings, one carousel slide per conference
 *   WarLeadersWidget  — top hitters/pitchers by WAR, one slide per level
 *   StatLeadersWidget — mixed old-school + advanced leaders, Spring/WCL toggle
 *   RecordsWidget     — PNW record book highlights
 *   CpiWidget         — WCL Composite Power Index top 6
 *
 * Every card: short (Carousel paginates instead of growing), tabular-nums,
 * dark-mode variants, links to its full page, and never blanks on a failed
 * fetch (WidgetSkeleton while loading, WidgetNote on error/empty).
 */

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  WidgetCard, Carousel, PillToggle, PlayerRow, GroupLabel,
  WidgetSkeleton, WidgetNote,
} from './WidgetShell'
import { useApi } from '../../hooks/useApi'
import { formatStat, divisionBadgeClass } from '../../utils/stats'
import { CURRENT_SEASON } from '../../lib/seasons'

const API_BASE = '/api/v1'

// The backend's stat-leaders/records "format" strings include a couple not
// covered by formatStat's switch — map them, then delegate.
function fmt(value, format) {
  if (value === null || value === undefined) return '-'
  const n = Number(value)
  if (Number.isNaN(n)) return String(value)
  if (format === 'float1') return n.toFixed(1)
  if (format === 'float2') return n.toFixed(2)
  return formatStat(n, format)
}

/** Tiny division-level chip ('JUCO' in the DB displays as 'NWAC'). */
function LevelChip({ level }) {
  if (!level) return null
  return (
    <span className={`text-[8px] font-bold px-1 py-px rounded whitespace-nowrap align-middle ${divisionBadgeClass(level)}`}>
      {level === 'JUCO' ? 'NWAC' : level}
    </span>
  )
}

/** A GroupLabel + top-3 PlayerRow list for one stat category. */
function CategoryBlock({ cat }) {
  if (!cat || !(cat.leaders || []).length) return null
  return (
    <div className="mb-1.5 last:mb-0">
      <GroupLabel>{cat.label}</GroupLabel>
      {cat.leaders.map((p, i) => (
        <PlayerRow
          key={`${p.player_id}-${i}`}
          rank={i + 1}
          logo={p.logo_url}
          name={`${p.first_name} ${p.last_name}`}
          sub={p.division_level
            ? <>{p.team_short ? `${p.team_short} ` : ''}<LevelChip level={p.division_level} /></>
            : p.team_short}
          value={fmt(p.value, cat.format)}
          to={p.to !== undefined ? p.to : (p.player_id ? `/player/${p.player_id}` : null)}
        />
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// 1. StandingsWidget
// ════════════════════════════════════════════════════════════════════

export function StandingsWidget() {
  const { data, loading, error } = useApi('/standings', { season: CURRENT_SEASON })

  // Same set StandingsPage renders: every conference that has teams.
  const conferences = (data?.conferences || []).filter(c => (c.teams || []).length > 0)

  const slides = conferences.map(conf => (
    <div key={conf.conference_id}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <LevelChip level={conf.division_level} />
        <span className="text-[11px] font-bold text-gray-700 dark:text-gray-200 truncate">
          {conf.conference_name}
        </span>
      </div>
      <div>
        {conf.teams.slice(0, 6).map((team, i) => {
          const conf_rec = (team.conf_wins || team.conf_losses)
            ? `${team.conf_wins}-${team.conf_losses}` : '-'
          const overall = (team.wins || team.losses)
            ? `${team.wins}-${team.losses}` : '-'
          const inner = (
            <>
              <span className="w-4 text-[10px] font-bold text-gray-400 tabular-nums shrink-0">{i + 1}</span>
              {team.logo_url
                ? <img src={team.logo_url} alt="" loading="lazy" className="w-5 h-5 object-contain shrink-0"
                    onError={(e) => { e.target.style.visibility = 'hidden' }} />
                : <span className="w-5 shrink-0" />}
              <span className="flex-1 min-w-0 text-xs font-semibold text-gray-800 dark:text-gray-100 truncate">
                {team.short_name}
              </span>
              <span className="w-10 text-right text-xs font-bold tabular-nums text-nw-teal dark:text-nw-teal-light">{conf_rec}</span>
              <span className="w-10 text-right text-[11px] tabular-nums text-gray-400">{overall}</span>
            </>
          )
          // Champion (top team) gets the subtle gold left border.
          const cls = `flex items-center gap-2 py-1 px-1 -mx-1 rounded ${
            i === 0 ? 'border-l-2 border-amber-400 bg-amber-50/40 dark:bg-amber-900/10' : ''
          }`
          return team.is_pnw
            ? <Link key={team.id} to={`/team/${team.id}`} className={`${cls} hover:bg-nw-cream dark:hover:bg-gray-700/50`}>{inner}</Link>
            : <div key={team.id} className={cls}>{inner}</div>
        })}
      </div>
      <div className="flex justify-end gap-4 mt-1 text-[8px] uppercase tracking-wider text-gray-400">
        <span>Conf</span>
        <span>Overall</span>
      </div>
    </div>
  ))

  return (
    <WidgetCard title={`Final ${CURRENT_SEASON} Standings`} to="/standings" linkLabel="Full standings">
      {loading
        ? <WidgetSkeleton rows={7} />
        : (error || !slides.length)
          ? <WidgetNote>Standings are unavailable right now.</WidgetNote>
          : <Carousel slides={slides} ariaLabel="Conference standings" />}
    </WidgetCard>
  )
}

// ════════════════════════════════════════════════════════════════════
// 2. WarLeadersWidget
// ════════════════════════════════════════════════════════════════════

const WAR_LEVELS = ['D1', 'D2', 'D3', 'NAIA', 'NWAC']

// 10 fetches (5 levels x batting+pitching) after a divisions lookup — done
// with plain fetch inside one effect rather than calling useApi in a loop.
function useWarLeadersByLevel() {
  const [state, setState] = useState({ loading: true, error: null, levels: [] })

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const dRes = await fetch(`${API_BASE}/divisions`)
        if (!dRes.ok) throw new Error(`divisions ${dRes.status}`)
        const divisions = await dRes.json()

        const top3 = async (kind, divisionId, sortBy) => {
          const qs = new URLSearchParams({
            season: String(CURRENT_SEASON),
            division_id: String(divisionId),
            sort_by: sortBy,
            sort_dir: 'desc',
            qualified: 'true',
            limit: '3',
          })
          const r = await fetch(`${API_BASE}/leaderboards/${kind}?${qs.toString()}`)
          if (!r.ok) return []
          const j = await r.json()
          return j?.data || []
        }

        const levels = await Promise.all(WAR_LEVELS.map(async (label) => {
          // The divisions table stores NWAC as level 'JUCO'.
          const dbLevel = label === 'NWAC' ? 'JUCO' : label
          const div = (divisions || []).find(d => d.level === dbLevel)
          if (!div) return { label, hitters: [], pitchers: [] }
          const [hitters, pitchers] = await Promise.all([
            top3('batting', div.id, 'offensive_war'),
            top3('pitching', div.id, 'pitching_war'),
          ])
          return { label, hitters, pitchers }
        }))

        if (!cancelled) setState({ loading: false, error: null, levels })
      } catch (err) {
        if (!cancelled) setState({ loading: false, error: err.message, levels: [] })
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  return state
}

export function WarLeadersWidget() {
  const { loading, error, levels } = useWarLeadersByLevel()

  const slides = levels
    .filter(lvl => lvl.hitters.length || lvl.pitchers.length)
    .map(lvl => (
      <div key={lvl.label}>
        <div className="flex items-center gap-1.5 mb-1.5">
          <LevelChip level={lvl.label === 'NWAC' ? 'JUCO' : lvl.label} />
          <span className="text-[11px] font-bold text-gray-700 dark:text-gray-200">{lvl.label}</span>
        </div>
        {lvl.hitters.length > 0 && (
          <div className="mb-1.5">
            <GroupLabel>Top hitters</GroupLabel>
            {lvl.hitters.map((p, i) => (
              <PlayerRow
                key={p.player_id}
                rank={i + 1}
                logo={p.logo_url}
                name={`${p.first_name} ${p.last_name}`}
                sub={p.team_short}
                value={p.offensive_war != null ? Number(p.offensive_war).toFixed(1) : '-'}
                to={`/player/${p.player_id}`}
              />
            ))}
          </div>
        )}
        {lvl.pitchers.length > 0 && (
          <div>
            <GroupLabel>Top pitchers</GroupLabel>
            {lvl.pitchers.map((p, i) => (
              <PlayerRow
                key={p.player_id}
                rank={i + 1}
                logo={p.logo_url}
                name={`${p.first_name} ${p.last_name}`}
                sub={p.team_short}
                value={p.pitching_war != null ? Number(p.pitching_war).toFixed(1) : '-'}
                to={`/player/${p.player_id}`}
              />
            ))}
          </div>
        )}
      </div>
    ))

  return (
    <WidgetCard title="WAR Leaders by Level" to="/war" linkLabel="Full WAR board">
      {loading
        ? <WidgetSkeleton rows={7} />
        : (error || !slides.length)
          ? <WidgetNote>WAR leaders are unavailable right now.</WidgetNote>
          : <Carousel slides={slides} ariaLabel="WAR leaders by level" />}
    </WidgetCard>
  )
}

// ════════════════════════════════════════════════════════════════════
// 3. StatLeadersWidget
// ════════════════════════════════════════════════════════════════════

export function StatLeadersWidget() {
  const [mode, setMode] = useState('spring')      // 'spring' | 'wcl'
  const [wclSeason, setWclSeason] = useState(CURRENT_SEASON)

  // Spring: season stat leaders + four PBP categories. Fixed hook count, so
  // calling useApi several times here is fine (never in a loop).
  const spring = useApi('/stat-leaders', { season: CURRENT_SEASON, limit: 3, qualified: true })
  const airPull = useApi('/leaderboards/batting-pbp',
    { season: CURRENT_SEASON, limit: 3, min_pa: 75, sort_by: 'air_pull_pct', sort_dir: 'desc' })
  const contact = useApi('/leaderboards/batting-pbp',
    { season: CURRENT_SEASON, limit: 3, min_pa: 75, sort_by: 'contact_pct', sort_dir: 'desc' })
  const strike = useApi('/leaderboards/pitching-pbp',
    { season: CURRENT_SEASON, limit: 3, min_bf: 75, sort_by: 'strike_pct', sort_dir: 'desc' })
  const whiffP = useApi('/leaderboards/pitching-pbp',
    { season: CURRENT_SEASON, limit: 3, min_bf: 75, sort_by: 'whiff_pct', sort_dir: 'desc' })

  // WCL mode only fetches when toggled on (null endpoint = skip).
  const wcl = useApi(
    mode === 'wcl' ? '/summer/stat-leaders' : null,
    { season: wclSeason, league: 'WCL', limit: 3 },
    [mode, wclSeason],
  )

  // If the current summer season has no leaders yet, fall back one year.
  useEffect(() => {
    if (mode !== 'wcl' || wclSeason !== CURRENT_SEASON || !wcl.data) return
    const cats = [...(wcl.data.batting || []), ...(wcl.data.pitching || [])]
    const hasLeaders = cats.some(c => (c.leaders || []).length > 0)
    if (!hasLeaders) setWclSeason(CURRENT_SEASON - 1)
  }, [mode, wclSeason, wcl.data])

  const findCat = (list, key) => (list || []).find(c => c.key === key) || null
  const pbpCat = (res, label, field) => {
    const rows = res.data?.data || []
    if (!rows.length) return null
    return {
      label,
      format: 'pct',
      leaders: rows.map(r => ({
        player_id: r.player_id,
        first_name: r.first_name,
        last_name: r.last_name,
        team_short: r.team_short,
        logo_url: r.logo_url,
        division_level: r.division_level,
        value: r[field],
      })),
    }
  }

  let slides = []
  let isLoading
  let title

  if (mode === 'spring') {
    isLoading = spring.loading || airPull.loading || contact.loading || strike.loading || whiffP.loading
    const bat = spring.data?.batting
    const pit = spring.data?.pitching
    const slideDefs = [
      // 1. Old school
      [findCat(bat, 'batting_avg'), findCat(bat, 'home_runs'), findCat(bat, 'stolen_bases')],
      // 2. Advanced bat
      [findCat(bat, 'wrc_plus'), findCat(bat, 'wobacon'), pbpCat(airPull, 'Air-Pull%', 'air_pull_pct')],
      // 3. Contact & strikes (PBP)
      [pbpCat(contact, 'Contact%', 'contact_pct'), pbpCat(whiffP, 'Whiff% (P)', 'whiff_pct'), pbpCat(strike, 'Strike%', 'strike_pct')],
      // 4. Pitching classics
      [findCat(pit, 'era'), findCat(pit, 'strikeouts'), findCat(pit, 'fip_plus')],
    ]
    slides = slideDefs
      .map(cats => cats.filter(c => c && (c.leaders || []).length))
      .filter(cats => cats.length > 0)
      .map((cats, si) => (
        <div key={si}>
          {cats.map((c, ci) => <CategoryBlock key={`${si}-${ci}`} cat={c} />)}
        </div>
      ))
    title = 'Stat Leaders'
  } else {
    isLoading = wcl.loading
    const cats = [...(wcl.data?.batting || []), ...(wcl.data?.pitching || [])]
      .filter(c => (c.leaders || []).length)
      .map(c => ({
        ...c,
        leaders: c.leaders.map(l => ({
          ...l,
          // Summer rows link to the spring profile when linked, else the
          // summer player page.
          to: l.spring_player_id
            ? `/player/${l.spring_player_id}`
            : (l.player_id ? `/summer/players/${l.player_id}` : null),
        })),
      }))
    const chunks = []
    for (let i = 0; i < cats.length; i += 3) chunks.push(cats.slice(i, i + 3))
    slides = chunks.map((chunk, si) => (
      <div key={si}>
        {chunk.map((c, ci) => <CategoryBlock key={`${si}-${ci}`} cat={c} />)}
      </div>
    ))
    title = `WCL ${wclSeason} Stat Leaders`
  }

  return (
    <WidgetCard
      title={title}
      to={mode === 'wcl' ? '/summer/stats' : '/stat-leaders'}
      linkLabel={mode === 'wcl' ? 'Summer stats' : 'All leaders'}
      controls={
        <PillToggle
          light
          options={[{ value: 'spring', label: 'Spring' }, { value: 'wcl', label: 'WCL' }]}
          value={mode}
          onChange={setMode}
        />
      }
    >
      {isLoading
        ? <WidgetSkeleton rows={7} />
        : !slides.length
          ? <WidgetNote>Stat leaders are unavailable right now.</WidgetNote>
          : <Carousel slides={slides} ariaLabel="Stat leaders" />}
    </WidgetCard>
  )
}

// ════════════════════════════════════════════════════════════════════
// 4. RecordsWidget
// ════════════════════════════════════════════════════════════════════

// Slide layout: title + (category, scope, record-key) triples. PNW level =
// best mark across all five divisions; the chip shows which level holds it.
const RECORD_SLIDES = [
  {
    title: 'Single-season hitting',
    records: [
      ['batting', 'single_season', 'hr'],
      ['batting', 'single_season', 'avg'],
      ['batting', 'single_season', 'sb'],
    ],
  },
  {
    title: 'Single-season pitching',
    records: [
      ['pitching', 'single_season', 'strikeouts'],
      ['pitching', 'single_season', 'era'],
      ['pitching', 'single_season', 'wins'],
    ],
  },
  {
    title: 'Career marks',
    records: [
      ['batting', 'career', 'hits'],
      ['batting', 'career', 'hr'],
      ['pitching', 'career', 'strikeouts'],
    ],
  },
]

export function RecordsWidget() {
  // /records returns every category nested as
  // {batting|pitching: {D1..JUCO|PNW: {single_season|career: {key: {label, format, leaders}}}}}
  const { data, loading, error } = useApi('/records', { limit: 1 })

  const slides = RECORD_SLIDES.map(def => {
    const rows = def.records
      .map(([cat, scope, key]) => {
        const stat = data?.[cat]?.PNW?.[scope]?.[key]
        const leader = stat?.leaders?.[0]
        if (!stat || !leader) return null
        return { stat, leader, scope }
      })
      .filter(Boolean)
    if (!rows.length) return null
    return (
      <div key={def.title}>
        <GroupLabel className="mb-1">{def.title}</GroupLabel>
        {rows.map(({ stat, leader, scope }) => (
          <PlayerRow
            key={`${stat.label}-${leader.player_id}`}
            logo={leader.logo_url}
            name={`${leader.first_name} ${leader.last_name}`}
            sub={
              <>
                {stat.label}
                {scope === 'single_season' && leader.season ? ` · ${leader.season}` : ''}
                {leader.team_short ? ` · ${leader.team_short} ` : ' '}
                <LevelChip level={leader.division_level} />
              </>
            }
            value={fmt(leader.value, stat.format)}
            valueClass="font-extrabold text-amber-600 dark:text-amber-400"
            to={leader.player_id ? `/player/${leader.player_id}` : null}
          />
        ))}
      </div>
    )
  }).filter(Boolean)

  return (
    <WidgetCard title="PNW Record Book" accent="gold" to="/records" linkLabel="Full record book">
      {loading
        ? <WidgetSkeleton rows={6} />
        : (error || !slides.length)
          ? <WidgetNote>Records are unavailable right now.</WidgetNote>
          : <Carousel slides={slides} ariaLabel="PNW record book" />}
    </WidgetCard>
  )
}

// ════════════════════════════════════════════════════════════════════
// 5. CpiWidget
// ════════════════════════════════════════════════════════════════════

export function CpiWidget() {
  const [season, setSeason] = useState(CURRENT_SEASON)
  const { data, loading, error } = useApi('/summer/cpi', { season, league: 'WCL' }, [season])

  // The current summer may not have started yet — fall back one year.
  useEffect(() => {
    if (!loading && data && !(data.teams || []).length && season === CURRENT_SEASON) {
      setSeason(CURRENT_SEASON - 1)
    }
  }, [loading, data, season])

  const teams = (data?.teams || [])
    .slice()
    .sort((a, b) => (b.cpi ?? -1) - (a.cpi ?? -1))
    .slice(0, 6)
  const maxCpi = teams.reduce((m, t) => Math.max(m, t.cpi || 0), 0)

  return (
    <WidgetCard
      title="WCL Power Index (CPI)"
      accent="summer"
      badge={data?.season ? String(data.season) : undefined}
      to="/summer/cpi"
      linkLabel="Full CPI"
    >
      {loading
        ? <WidgetSkeleton rows={6} />
        : (error || !teams.length)
          ? <WidgetNote>CPI ratings are unavailable right now.</WidgetNote>
          : (
            <div>
              {teams.map((t, i) => (
                <Link
                  key={t.team_id}
                  to={`/summer/teams/${t.team_id}`}
                  className="flex items-center gap-2 py-1 px-1 -mx-1 rounded hover:bg-nw-cream dark:hover:bg-gray-700/50"
                >
                  <span className="w-4 text-[10px] font-bold text-gray-400 tabular-nums shrink-0">{i + 1}</span>
                  {t.logo
                    ? <img src={t.logo} alt="" loading="lazy" className="w-5 h-5 object-contain shrink-0"
                        onError={(e) => { e.target.style.visibility = 'hidden' }} />
                    : <span className="w-5 shrink-0" />}
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-semibold text-gray-800 dark:text-gray-100 truncate leading-tight">{t.team}</span>
                    <span className="block text-[10px] text-gray-400 leading-tight tabular-nums">{t.actual_w}-{t.actual_l}</span>
                  </span>
                  {/* CPI value over a tiny bar scaled vs the slide max */}
                  <span className="relative flex items-center justify-end w-16 h-4 shrink-0">
                    <span
                      className="absolute inset-y-0.5 right-0 rounded-sm bg-nw-teal-light/25 dark:bg-nw-teal-light/20"
                      style={{ width: `${maxCpi > 0 ? Math.max(8, (t.cpi / maxCpi) * 100) : 0}%` }}
                    />
                    <span className="relative text-xs font-bold tabular-nums text-nw-teal dark:text-nw-teal-light pr-0.5">
                      {t.cpi}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          )}
    </WidgetCard>
  )
}
