// PortalPDFs — landing page for the printable PDF tools.
//
// Three products live here:
//   • Team Scouting Sheet — picks a team, prints all hitters + all pitchers
//   • Player Card — picks a single player (with side for two-way guys),
//     prints a single-page Statcast-style profile
//   • Bulk Player Cards — picks a team, then individually checks off
//     which players to include; prints them all at once, one card per
//     physical page (use case: an entire roster's worth of cards in
//     one print job)

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTeams, usePlayerSearch, useApi } from '../hooks/useApi'


export default function PortalPDFs() {
  const navigate = useNavigate()
  // Restore a sensible tab title on every visit. Without this, the
  // tab can stay stuck on the most recent Player Card filename
  // (e.g. "ODaniel_Michael_Hitting_2026") after you navigate back
  // here, since PlayerCardPDF's cleanup doesn't always restore the
  // pre-card title cleanly.
  useEffect(() => {
    document.title = 'PDFs · NW Baseball Stats'
  }, [])
  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-portal-purple-dark dark:text-gray-100">Printable PDFs</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          One-page reports built for the dugout. Print or save as PDF.
        </p>
      </div>

      <NWACChampBoardCard onOpen={() => navigate('/portal/nwac-tournament-sheet')} />
      <ScoutingSheetCard onPick={(id) => navigate(`/portal/scouting-sheet/${id}`)} />
      <BullpenSheetCard onPick={(id) => navigate(`/portal/bullpen-sheet/${id}`)} />
      <CatcherCardsCard onPick={(id) => navigate(`/portal/catcher-cards/${id}`)} />
      <PlayerCardCard onPick={(id, side) =>
        navigate(`/portal/pdfs/player-card/${id}${side ? `?side=${side}` : ''}`)} />
      <BulkPlayerCardsCard onGenerate={(idsParam) =>
        navigate(`/portal/pdfs/bulk-player-cards?ids=${encodeURIComponent(idsParam)}`)} />
    </div>
  )
}


// ─────────────────────────────────────────────────────────
// NWAC Championship Board — cross-team ranked board (no picker).
// Every pitcher then every hitter across the 8 championship teams,
// ranked by WAR, shaded vs the field. Landscape multi-page PDF.
// ─────────────────────────────────────────────────────────
function NWACChampBoardCard({ onOpen }) {
  return (
    <div className="bg-gradient-to-br from-[#04323d] via-[#062f3a] to-[#021b22] border border-pnw-teal/40 rounded-lg shadow-sm p-4 text-white">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-lg font-bold text-white">NWAC Championship Board</h2>
        <span className="text-[11px] text-pnw-teal/80">all 8 teams · ranked by WAR</span>
      </div>
      <p className="text-xs text-white/70 mb-3">
        The whole championship field on two ranked boards: every pitcher, then every hitter
        across all 8 teams in Longview, sorted by WAR. Each row shows year, height, weight, and
        commitment, with main and advanced stats color-shaded against the field.
      </p>
      <div className="flex items-center justify-end">
        <button
          onClick={onOpen}
          className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                     bg-pnw-teal text-white hover:bg-white hover:text-[#04323d] transition-colors"
        >
          Open Board
        </button>
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────
// Scouting sheet picker — group teams by conference
// ─────────────────────────────────────────────────────────
function ScoutingSheetCard({ onPick }) {
  // Important: useApi starts with `data: null`, and a `data = []` default
  // in destructuring only kicks in for `undefined` — not `null`. If we
  // try `for (const t of null)` we crash with "t is not iterable" (the
  // exact bug we hit on first deploy). Use a defensive fallback.
  const { data } = useTeams()
  const teams = Array.isArray(data) ? data : []
  const grouped = useMemo(() => {
    const g = {}
    for (const t of teams) {
      const k = t.conference_abbrev || t.conference_name || 'Other'
      if (!g[k]) g[k] = []
      g[k].push(t)
    }
    Object.values(g).forEach(arr =>
      arr.sort((a, b) => (a.short_name || a.name || '').localeCompare(b.short_name || b.name || '')))
    return g
  }, [teams])
  const [teamId, setTeamId] = useState('')

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm p-4">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-lg font-bold text-portal-purple-dark dark:text-gray-100">Team Scouting Sheet</h2>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">2 pages · hitters + pitchers</span>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
        Every hitter and pitcher on the team's roster with the 13 / 12 most coach-relevant stats,
        color-shaded by conference percentile, plus a notes panel for in-game scribbles.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm bg-white text-gray-900 flex-1 min-w-[220px]"
        >
          <option value="">Pick a team...</option>
          {Object.keys(grouped).sort().map(g => (
            <optgroup key={g} label={g}>
              {grouped[g].map(t => (
                <option key={t.id} value={t.id}>{t.short_name || t.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          disabled={!teamId}
          onClick={() => teamId && onPick(parseInt(teamId, 10))}
          className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                     bg-portal-purple text-portal-cream hover:bg-portal-purple-dark
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Open Sheet
        </button>
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────
// Player card picker — search + side toggle
// ─────────────────────────────────────────────────────────
function PlayerCardCard({ onPick }) {
  const [query, setQuery] = useState('')
  // /players/search requires q.length >= 2 — don't fire below that.
  const { data, loading } = usePlayerSearch(query.length >= 2 ? query : '', {})
  const results = (data?.results || data || []).slice(0, 8)

  const [selected, setSelected] = useState(null)   // {id, name, ...}
  const [side, setSide] = useState(null)           // 'batting' | 'pitching' | null (let backend decide)

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm p-4">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-lg font-bold text-portal-purple-dark dark:text-gray-100">Player Card</h2>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">1 page · stats + spray + percentiles</span>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
        One-page Statcast-style profile: percentile bars, spray chart, plate discipline,
        splits, season stats, and summer ball. For two-way players, pick a side or leave it
        on auto and we'll default to whichever side has more career WAR.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search player by name..."
          className="rounded border border-gray-300 px-3 py-2 text-sm flex-1 min-w-[220px]"
        />
        <div className="inline-flex rounded-full bg-gray-100 dark:bg-gray-700 p-0.5 text-xs">
          {[
            ['auto',     'Auto'],
            ['batting',  'Hitting'],
            ['pitching', 'Pitching'],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setSide(id === 'auto' ? null : id)}
              className={`px-3 py-1 rounded-full font-bold transition-all ${
                (side || 'auto') === id
                  ? 'bg-portal-purple text-portal-cream'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Results dropdown */}
      {query.length >= 2 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded mb-2 max-h-72 overflow-y-auto bg-white dark:bg-gray-800">
          {loading ? (
            <div className="px-3 py-2 text-xs text-gray-400 italic animate-pulse">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-400 italic">No players found.</div>
          ) : (
            results.map(p => (
              <button
                key={p.id}
                onClick={() => setSelected(p)}
                className={`w-full text-left px-3 py-2 hover:bg-portal-purple/5 transition-colors
                            border-b border-gray-100 dark:border-gray-700 last:border-0 flex items-center gap-2 ${
                  selected?.id === p.id ? 'bg-portal-purple/10' : ''
                }`}
              >
                {p.logo_url && (
                  <img src={p.logo_url} alt="" className="h-5 w-5 object-contain shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                    {p.first_name} {p.last_name}
                    {p.jersey_number && (
                      <span className="text-gray-400 font-normal ml-1">#{p.jersey_number}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                    {p.position || ''}
                    {p.team_short ? ` · ${p.team_short}` : ''}
                    {p.division_level ? ` · ${p.division_level}` : ''}
                    {p.year_in_school ? ` · ${p.year_in_school}` : ''}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {selected && (
        <div className="flex items-center justify-between gap-2 bg-portal-purple/5 border border-portal-purple/20 rounded px-3 py-2">
          <div className="text-sm">
            <span className="font-bold">{selected.first_name} {selected.last_name}</span>
            <span className="text-gray-500 dark:text-gray-400 text-xs ml-2">
              {selected.team_short || ''} · {side ? side : 'auto side'}
            </span>
          </div>
          <button
            onClick={() => onPick(selected.id, side)}
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                       bg-portal-purple text-portal-cream hover:bg-portal-purple-dark"
          >
            Open Card
          </button>
        </div>
      )}
    </div>
  )
}


// ─────────────────────────────────────────────────────────
// Bullpen Sheet — single-page coaching tool with the full pitcher
// roster + situational leaderboards (best @ home, best vs LHH, etc.)
// ─────────────────────────────────────────────────────────
function BullpenSheetCard({ onPick }) {
  const { data: teamsData } = useTeams()
  const teams = Array.isArray(teamsData) ? teamsData : []
  const grouped = useMemo(() => {
    const g = {}
    for (const t of teams) {
      const k = t.conference_abbrev || t.conference_name || 'Other'
      if (!g[k]) g[k] = []
      g[k].push(t)
    }
    Object.values(g).forEach(arr =>
      arr.sort((a, b) => (a.short_name || a.name || '').localeCompare(b.short_name || b.name || '')))
    return g
  }, [teams])
  const [teamId, setTeamId] = useState('')

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm p-4">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-lg font-bold text-portal-purple-dark dark:text-gray-100">Bullpen Sheet</h2>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">1 page · roster + situational leaderboards</span>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
        Every pitcher on the staff with their season stats, L/R splits, RISP wOBA,
        plus a "who's best in X" leaderboard for each game-state situation
        (home/road, vs LHH/RHH, bases empty, runners on, late & close). Built for
        in-game bullpen decisions.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm bg-white text-gray-900 flex-1 min-w-[220px]"
        >
          <option value="">Pick a team...</option>
          {Object.keys(grouped).sort().map(g => (
            <optgroup key={g} label={g}>
              {grouped[g].map(t => (
                <option key={t.id} value={t.id}>{t.short_name || t.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          disabled={!teamId}
          onClick={() => teamId && onPick(parseInt(teamId, 10))}
          className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                     bg-portal-purple text-portal-cream hover:bg-portal-purple-dark
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Open Sheet
        </button>
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────
// Catcher Cards — pocket-sized 5"×2" cards for in-game pitch
// calling. Pick the OPPOSING team; we generate a 2-page PDF with
// the top 14 hitters by PA, 7 per card.
// ─────────────────────────────────────────────────────────
function CatcherCardsCard({ onPick }) {
  const { data: teamsData } = useTeams()
  const teams = Array.isArray(teamsData) ? teamsData : []
  const grouped = useMemo(() => {
    const g = {}
    for (const t of teams) {
      const k = t.conference_abbrev || t.conference_name || 'Other'
      if (!g[k]) g[k] = []
      g[k].push(t)
    }
    Object.values(g).forEach(arr =>
      arr.sort((a, b) => (a.short_name || a.name || '').localeCompare(b.short_name || b.name || '')))
    return g
  }, [teams])
  const [teamId, setTeamId] = useState('')

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm p-4">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-lg font-bold text-portal-purple-dark dark:text-gray-100">Catcher Cards</h2>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">2 pages · 5″ × 2″ each · pocket-size</span>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
        Pick the opposing team. We generate two strict 5×2-inch cards covering
        their top 14 hitters by PA, 7 per card. Each row shows wOBA splits, K%,
        BB%, swing rates, ISO, SB, and a blank notes column. Save as PDF, print at
        100% scale, cut, fit in a wristband.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm bg-white text-gray-900 flex-1 min-w-[220px]"
        >
          <option value="">Pick the opposing team...</option>
          {Object.keys(grouped).sort().map(g => (
            <optgroup key={g} label={g}>
              {grouped[g].map(t => (
                <option key={t.id} value={t.id}>{t.short_name || t.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          disabled={!teamId}
          onClick={() => teamId && onPick(parseInt(teamId, 10))}
          className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                     bg-portal-purple text-portal-cream hover:bg-portal-purple-dark
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Open Cards
        </button>
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────
// Bulk Player Cards — pick a team, then check off which players
// to include. Each player gets a "Hitting" / "Pitching" / "Both"
// dropdown so two-way players can have either side or both.
// ─────────────────────────────────────────────────────────
function BulkPlayerCardsCard({ onGenerate }) {
  const { data: teamsData } = useTeams()
  const teams = Array.isArray(teamsData) ? teamsData : []
  const grouped = useMemo(() => {
    const g = {}
    for (const t of teams) {
      const k = t.conference_abbrev || t.conference_name || 'Other'
      if (!g[k]) g[k] = []
      g[k].push(t)
    }
    Object.values(g).forEach(arr =>
      arr.sort((a, b) => (a.short_name || a.name || '').localeCompare(b.short_name || b.name || '')))
    return g
  }, [teams])

  const [teamId, setTeamId] = useState('')

  // Roster fetched from the existing scouting-sheet endpoint — it
  // returns hitters + pitchers grouped, with player_ids and meta.
  // Skipped when no team picked yet.
  const { data: sheet, loading: sheetLoading } = useApi(
    teamId ? `/portal/scouting-sheet/${teamId}` : null,
    { season: 2026 },
    [teamId]
  )

  // Build a unified roster: every player gets one entry, with flags
  // for whether they have hitting and/or pitching data. Two-way
  // players show "both" available.
  const roster = useMemo(() => {
    if (!sheet) return []
    const map = new Map()
    for (const h of sheet.hitters || []) {
      map.set(h.player_id, {
        ...h, hasBatting: true, hasPitching: false,
      })
    }
    for (const p of sheet.pitchers || []) {
      const existing = map.get(p.player_id)
      if (existing) {
        existing.hasPitching = true
      } else {
        map.set(p.player_id, {
          ...p, hasBatting: false, hasPitching: true,
        })
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      // Sort by jersey number when available, else by last name
      const ja = parseInt(a.jersey_number, 10)
      const jb = parseInt(b.jersey_number, 10)
      if (Number.isFinite(ja) && Number.isFinite(jb)) return ja - jb
      if (Number.isFinite(ja)) return -1
      if (Number.isFinite(jb)) return 1
      return (a.last_name || '').localeCompare(b.last_name || '')
    })
  }, [sheet])

  // Per-player selection state. Key = player_id, value = chosen
  // side(s): 'none' | 'batting' | 'pitching' | 'both'.
  const [picks, setPicks] = useState({})

  // Reset picks when team changes
  useEffect(() => { setPicks({}) }, [teamId])

  // Default each visible player to 'batting' for hitters, 'pitching'
  // for pitchers, 'both' for two-way — but UNCHECKED. The dropdown
  // shows the default; checkbox controls inclusion.
  const defaultSide = (p) => {
    if (p.hasBatting && p.hasPitching) return 'both'
    if (p.hasPitching) return 'pitching'
    return 'batting'
  }

  const togglePlayer = (pid) => {
    setPicks(s => {
      const cur = s[pid]
      if (cur && cur !== 'none') {
        const { [pid]: _, ...rest } = s
        return rest
      }
      const p = roster.find(r => r.player_id === pid)
      return { ...s, [pid]: defaultSide(p) }
    })
  }
  const setSide = (pid, side) => {
    setPicks(s => ({ ...s, [pid]: side }))
  }

  const selectedCount = Object.keys(picks).length
  const totalCards = Object.values(picks).reduce(
    (n, side) => n + (side === 'both' ? 2 : 1), 0)

  const selectAll = () => {
    const next = {}
    for (const p of roster) next[p.player_id] = defaultSide(p)
    setPicks(next)
  }
  const clearAll = () => setPicks({})

  const handleGenerate = () => {
    // Build the comma-separated id:side list for the bulk URL.
    const tokens = []
    for (const p of roster) {
      const side = picks[p.player_id]
      if (!side) continue
      if (side === 'both') {
        if (p.hasBatting) tokens.push(`${p.player_id}:batting`)
        if (p.hasPitching) tokens.push(`${p.player_id}:pitching`)
      } else {
        tokens.push(`${p.player_id}:${side}`)
      }
    }
    if (tokens.length) onGenerate(tokens.join(','))
  }

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm p-4">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-lg font-bold text-portal-purple-dark dark:text-gray-100">Bulk Player Cards</h2>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          {selectedCount > 0
            ? `${selectedCount} player${selectedCount === 1 ? '' : 's'} · ${totalCards} card${totalCards === 1 ? '' : 's'}`
            : 'pick a team, check players, print all at once'}
        </span>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
        Pick a team, then check off which players you want cards for. For two-way
        players you can choose hitting, pitching, or both. Hits one big print
        dialog for the entire batch: one player card per physical page.
      </p>

      {/* Team picker */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm bg-white text-gray-900 flex-1 min-w-[220px]"
        >
          <option value="">Pick a team...</option>
          {Object.keys(grouped).sort().map(g => (
            <optgroup key={g} label={g}>
              {grouped[g].map(t => (
                <option key={t.id} value={t.id}>{t.short_name || t.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* Roster checkbox list */}
      {teamId && (
        <div className="border border-gray-200 dark:border-gray-700 rounded mb-3">
          {sheetLoading || !sheet ? (
            <div className="px-3 py-4 text-xs text-gray-400 italic animate-pulse">Loading roster…</div>
          ) : roster.length === 0 ? (
            <div className="px-3 py-4 text-xs text-gray-400 italic">No players found on this team.</div>
          ) : (
            <>
              <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-gray-600 dark:text-gray-400">
                  {roster.length} on roster
                </span>
                <div className="flex gap-2">
                  <button onClick={selectAll}
                          className="text-[11px] font-semibold text-portal-purple dark:text-portal-accent-light hover:underline">
                    Select all
                  </button>
                  <span className="text-gray-300">·</span>
                  <button onClick={clearAll}
                          className="text-[11px] font-semibold text-portal-purple dark:text-portal-accent-light hover:underline">
                    Clear
                  </button>
                </div>
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                {roster.map(p => {
                  const checked = !!picks[p.player_id]
                  const side = picks[p.player_id] || defaultSide(p)
                  const isTwoWay = p.hasBatting && p.hasPitching
                  return (
                    <div
                      key={p.player_id}
                      className={`flex items-center gap-2 px-3 py-1.5 border-b border-gray-100
                                  last:border-0 hover:bg-portal-purple/5 ${
                        checked ? 'bg-portal-purple/5' : ''
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePlayer(p.player_id)}
                        className="h-4 w-4 accent-portal-purple cursor-pointer"
                      />
                      <span className="text-[11px] text-gray-400 tabular-nums w-6 text-right">
                        {p.jersey_number || '–'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                          {p.first_name} {p.last_name}
                        </div>
                        <div className="text-[10px] text-gray-500 dark:text-gray-400 truncate">
                          {p.position || ''}
                          {p.bats || p.throws ? ` · ${p.bats || '–'}/${p.throws || '–'}` : ''}
                          {p.year_in_school ? ` · ${p.year_in_school}` : ''}
                          {isTwoWay && <span className="text-portal-purple font-bold ml-1">· two-way</span>}
                        </div>
                      </div>
                      {/* Side selector — only shown for two-way; single-side
                          players just print their one side. */}
                      {checked && isTwoWay && (
                        <select
                          value={side}
                          onChange={(e) => setSide(p.player_id, e.target.value)}
                          className="text-[11px] rounded border border-gray-300 px-1 py-0.5 bg-white"
                        >
                          <option value="batting">Hitting</option>
                          <option value="pitching">Pitching</option>
                          <option value="both">Both (2 cards)</option>
                        </select>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Generate button */}
      <div className="flex items-center justify-end gap-2">
        <button
          disabled={selectedCount === 0}
          onClick={handleGenerate}
          className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded
                     bg-portal-purple text-portal-cream hover:bg-portal-purple-dark
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Generate {totalCards || 0} Card{totalCards === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  )
}
