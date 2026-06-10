// PortalTeamGate — full-screen prompt asking the user to pick their
// primary focus team on first portal entry. Once selected, the team
// is persisted in localStorage (via PortalTeamContext) and this gate
// gets out of the way for all subsequent visits.
//
// The "Switch team" button in the header clears the team and re-shows
// this gate.

import { useState, useMemo, useEffect } from 'react'
import { useTeams, useDivisions } from '../hooks/useApi'
import { usePortalTeam } from '../context/PortalTeamContext'
import { useAffiliatedTeam } from '../context/AffiliationContext'
import { CURRENT_SEASON } from '../lib/seasons'

const SEASON = CURRENT_SEASON


export default function PortalTeamGate({ children }) {
  const { team, setTeam } = usePortalTeam()
  const { team: affiliated, loading: affiliationLoading } = useAffiliatedTeam()

  // When a Coach has designated "their team" on the Account page, the
  // Portal should pre-fill with that team instead of forcing a manual
  // pick on first entry. Only auto-fill when the portal team is still
  // unset — we don't override a deliberate Portal choice.
  useEffect(() => {
    if (team) return
    if (affiliationLoading) return
    if (!affiliated) return
    setTeam({
      id: affiliated.id,
      name: affiliated.school_name || affiliated.short_name,
      short_name: affiliated.short_name,
      logo_url: affiliated.logo_url,
    })
  }, [team, affiliated, affiliationLoading, setTeam])

  // If a team is already chosen (or about to be auto-picked), render
  // children directly.
  if (team) return children
  if (affiliationLoading) return null

  return <TeamPicker onPick={setTeam} />
}


function TeamPicker({ onPick }) {
  const [divisionId, setDivisionId] = useState('')
  const [search, setSearch] = useState('')
  const { data: divisions } = useDivisions()
  const { data: teams } = useTeams({
    season: SEASON,
    ...(divisionId && { division_id: divisionId }),
  })

  const filtered = useMemo(() => {
    if (!teams) return []
    const q = search.trim().toLowerCase()
    let list = [...teams]
    if (q) {
      list = list.filter(t =>
        (t.short_name || '').toLowerCase().includes(q) ||
        (t.name || '').toLowerCase().includes(q) ||
        (t.school_name || '').toLowerCase().includes(q)
      )
    }
    list.sort((a, b) =>
      (a.short_name || a.name).localeCompare(b.short_name || b.name)
    )
    return list
  }, [teams, search])

  return (
    <div className="min-h-[calc(100vh-72px)] flex items-start justify-center
                    py-10 px-4 bg-portal-cream dark:bg-gray-900">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center
                          w-14 h-14 rounded-full bg-portal-purple
                          text-portal-accent text-2xl font-bold mb-3">
            ⚾
          </div>
          <h1 className="text-2xl font-bold text-portal-purple-dark dark:text-gray-100 mb-1">
            Welcome to the Coach &amp; Scouting Portal
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 max-w-md mx-auto">
            Pick your primary focus team. We'll remember it on this device
            so every page in the portal pre-loads with your team in mind.
            You can switch at any time from the header.
          </p>
        </div>

        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm">
          <div className="border-b border-gray-100 dark:border-gray-700 px-4 py-3 flex flex-wrap gap-2">
            <select
              value={divisionId}
              onChange={(e) => setDivisionId(e.target.value)}
              className="rounded border border-gray-300 px-2 py-1.5 text-sm
                         focus:ring-2 focus:ring-portal-accent focus:border-transparent"
            >
              <option value="">All Divisions</option>
              {(divisions || []).map(d => (
                <option key={d.id} value={d.id}>{d.level}</option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Search team..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 min-w-[160px] rounded border border-gray-300 px-2 py-1.5 text-sm
                         focus:ring-2 focus:ring-portal-accent focus:border-transparent"
            />
          </div>

          <div className="max-h-[480px] overflow-y-auto p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
            {filtered.length === 0 && (
              <div className="col-span-full text-center text-sm text-gray-400 py-8">
                No teams match your search.
              </div>
            )}
            {filtered.map(t => (
              <button
                key={t.id}
                onClick={() => onPick({
                  id: t.id,
                  name: t.name,
                  short_name: t.short_name,
                  logo_url: t.logo_url,
                  division_level: t.division_level,
                })}
                className="flex items-center gap-2 px-3 py-2 rounded
                           hover:bg-portal-purple hover:text-white
                           transition-colors text-left"
              >
                {t.logo_url && (
                  <img src={t.logo_url} alt="" className="h-6 w-6 object-contain shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate">
                    {t.short_name || t.name}
                  </div>
                  <div className="text-[11px] opacity-70 truncate">
                    {t.division_level || ''}
                    {t.conference_abbrev ? ` · ${t.conference_abbrev}` : ''}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
