// Account-page "Your Team" picker.
//
// Visible only to Coach + Dev tiers. Lets a user designate a team
// they're affiliated with; that team's players get highlighted on
// leaderboards across the site, and the Portal pre-fills its team
// selector with this choice.
//
// "No affiliation" is always pinned to the top of the list as the
// explicit opt-out — needed because once a team is chosen there's
// no other obvious way to go back to "show all players neutrally".

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAffiliatedTeam } from '../context/AffiliationContext'
import { useTier } from '../hooks/useTier'
import { tierMeets } from '../lib/tiers'

const API_BASE = '/api/v1'


export default function YourTeamSection() {
  const { tier } = useTier()
  const { team: affiliated, setAffiliation, loading } = useAffiliatedTeam()

  // Hide entirely for non-Coach tiers, but keep a teaser visible to
  // Premium/Free users so they know the feature exists.
  const canSet = tierMeets(tier, 'coach')

  // Build a complete teams list. We cache the response since /teams
  // is small and changes rarely.
  const [teams, setTeams] = useState(null)
  useEffect(() => {
    let alive = true
    fetch(`${API_BASE}/teams?include_inactive=false`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { if (alive) setTeams(Array.isArray(d) ? d : (d?.teams || [])) })
      .catch(() => { if (alive) setTeams([]) })
    return () => { alive = false }
  }, [])

  // Group teams by division so the dropdown is browsable.
  const groups = useMemo(() => {
    if (!teams) return null
    const buckets = { D1: [], D2: [], D3: [], NAIA: [], JUCO: [], Other: [] }
    for (const t of teams) {
      const level = t.division_level || t.level || 'Other'
      const key = ['D1', 'D2', 'D3', 'NAIA', 'JUCO'].includes(level) ? level : 'Other'
      buckets[key].push(t)
    }
    for (const k of Object.keys(buckets)) {
      buckets[k].sort((a, b) => (a.short_name || '').localeCompare(b.short_name || ''))
    }
    return buckets
  }, [teams])

  // Local select state — value of '' means "No affiliation".
  const [selected, setSelected] = useState('')
  useEffect(() => {
    setSelected(affiliated?.id ? String(affiliated.id) : '')
  }, [affiliated?.id])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  const dirty = (
    (selected === '' && affiliated)
    || (selected !== '' && Number(selected) !== affiliated?.id)
  )

  async function handleSave() {
    if (saving || !dirty) return
    setSaving(true); setError(null); setSavedAt(null)
    try {
      const teamId = selected === '' ? null : Number(selected)
      await setAffiliation(teamId)
      setSavedAt(Date.now())
    } catch (e) {
      setError(e.message || 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 mb-4">
      <div className="flex items-center justify-between gap-2 mb-1">
        <h2 className="text-sm font-bold text-gray-800 dark:text-gray-100 uppercase tracking-wider">
          Your Team
        </h2>
        {savedAt && !error && (
          <span className="text-[11px] font-semibold text-emerald-600 uppercase tracking-wider">
            Saved
          </span>
        )}
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 leading-snug">
        Tag a team to highlight its players across leaderboards and pre-fill the
        Coaching Portal's team selector. Pick "No affiliation" to keep things
        neutral.
      </p>

      {!canSet ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-700/50 dark:bg-amber-900/20 p-4">
          <div className="text-sm font-semibold text-amber-900 dark:text-amber-200 mb-1">
            Coach &amp; Scout feature
          </div>
          <p className="text-sm text-amber-800/85 dark:text-amber-200/80">
            Designating a team is part of the Coach &amp; Scout tier — see{' '}
            <Link to="/pricing" className="underline-offset-4 hover:underline font-semibold">
              plans
            </Link>{' '}
            for details.
          </p>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex-1 min-w-0">
            <label
              htmlFor="affiliated-team-select"
              className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1"
            >
              Team
            </label>
            <select
              id="affiliated-team-select"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={loading || !teams}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600
                         bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100
                         px-3 py-2 text-sm focus:border-nw-teal focus:ring-1 focus:ring-nw-teal
                         disabled:opacity-50"
            >
              {/* No affiliation — always at the top */}
              <option value="">No affiliation</option>
              {groups && Object.entries(groups).map(([lvl, list]) => (
                list.length === 0 ? null : (
                  <optgroup key={lvl} label={lvl === 'JUCO' ? 'NWAC (JUCO)' : lvl}>
                    {list.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.short_name || t.school_name || `Team ${t.id}`}
                      </option>
                    ))}
                  </optgroup>
                )
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="px-4 py-2 rounded-lg bg-nw-teal text-white text-sm font-semibold
                       hover:bg-pnw-forest transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {affiliated && canSet && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-amber-200
                        dark:border-amber-700/40 bg-amber-50 dark:bg-amber-900/15 p-3">
          {affiliated.logo_url && (
            <img
              src={affiliated.logo_url}
              alt=""
              className="w-9 h-9 object-contain rounded bg-white p-0.5"
              onError={(e) => { e.currentTarget.style.display = 'none' }}
            />
          )}
          <div className="text-sm">
            <div className="font-semibold text-gray-900 dark:text-gray-100">
              Highlighting {affiliated.short_name || affiliated.school_name}
            </div>
            <div className="text-[12px] text-gray-500 dark:text-gray-400">
              {affiliated.division_level}
              {affiliated.conference_abbrev ? ` · ${affiliated.conference_abbrev}` : ''}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</div>
      )}
    </section>
  )
}
