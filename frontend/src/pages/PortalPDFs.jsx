// PortalPDFs — landing page for the printable PDF tools.
//
// Two products live here today:
//   • Team Scouting Sheet — picks a team, prints all hitters + all pitchers
//   • Player Card — picks a player (and a side for two-way guys), prints
//     a single-page Statcast-style profile
//
// The page layout is two stacked cards, each with its own picker, so a
// coach can scan both options at a glance.

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTeams, usePlayerSearch } from '../hooks/useApi'


export default function PortalPDFs() {
  const navigate = useNavigate()
  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-portal-purple-dark">Printable PDFs</h1>
        <p className="text-sm text-gray-600">
          One-page reports built for the dugout — print or save as PDF.
        </p>
      </div>

      <ScoutingSheetCard onPick={(id) => navigate(`/portal/scouting-sheet/${id}`)} />
      <PlayerCardCard onPick={(id, side) =>
        navigate(`/portal/pdfs/player-card/${id}${side ? `?side=${side}` : ''}`)} />
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
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-lg font-bold text-portal-purple-dark">Team Scouting Sheet</h2>
        <span className="text-[11px] text-gray-500">2 pages · hitters + pitchers</span>
      </div>
      <p className="text-xs text-gray-600 mb-3">
        Every hitter and pitcher on the team's roster with the 13 / 12 most coach-relevant stats,
        color-shaded by conference percentile, plus a notes panel for in-game scribbles.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm bg-white text-gray-900 flex-1 min-w-[220px]"
        >
          <option value="">— pick a team —</option>
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
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-lg font-bold text-portal-purple-dark">Player Card</h2>
        <span className="text-[11px] text-gray-500">1 page · stats + spray + percentiles</span>
      </div>
      <p className="text-xs text-gray-600 mb-3">
        One-page Statcast-style profile — percentile bars, spray chart, plate discipline,
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
        <div className="inline-flex rounded-full bg-gray-100 p-0.5 text-xs">
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
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Results dropdown */}
      {query.length >= 2 && (
        <div className="border border-gray-200 rounded mb-2 max-h-72 overflow-y-auto bg-white">
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
                            border-b border-gray-100 last:border-0 flex items-center gap-2 ${
                  selected?.id === p.id ? 'bg-portal-purple/10' : ''
                }`}
              >
                {p.logo_url && (
                  <img src={p.logo_url} alt="" className="h-5 w-5 object-contain shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-900 truncate">
                    {p.first_name} {p.last_name}
                    {p.jersey_number && (
                      <span className="text-gray-400 font-normal ml-1">#{p.jersey_number}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-500 truncate">
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
            <span className="text-gray-500 text-xs ml-2">
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
