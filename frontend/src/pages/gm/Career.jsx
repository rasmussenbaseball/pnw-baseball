/**
 * Career page — story-mode career trajectory + offer acceptance.
 *
 * Displays:
 *   - Career arc (every job the user has held, with W-L + result)
 *   - Achievements (FIRST_HC, NAIA_HC, D1_HC etc.)
 *   - Pending offers — accept/decline buttons
 *   - Pending firing notice (if any)
 *   - Goal progress (D1 head coach)
 *
 * Hidden entirely if state.career is missing (regular dynasty).
 */

import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import {
  acceptCareerOffer, declineAllCareerOffers, roleLabel, DIFFICULTY_TUNING,
} from '../../gm/engine/storyMode'
import { refillThinRosters } from '../../gm/engine/events'
import GMShell, { gmToast } from '../../gm/components/GMShell'

const LEVEL_COLOR = {
  D1:   'bg-purple-100 text-purple-800 border-purple-300',
  D2:   'bg-blue-100 text-blue-800 border-blue-300',
  D3:   'bg-emerald-100 text-emerald-800 border-emerald-300',
  NAIA: 'bg-amber-100 text-amber-800 border-amber-300',
  NWAC: 'bg-slate-100 text-slate-700 border-slate-300',
}

export default function Career() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'
  const [save, setSave] = useState(() => loadDynasty(userId, slot))
  const [busy, setBusy] = useState(false)

  if (!save) return <Navigate to="/gm" replace />
  if (!save.career || !save.career.enabled) {
    return (
      <GMShell schoolName={save.schools?.[save.userSchoolId]?.name}>
        <div className="max-w-3xl mx-auto p-6 text-center">
          <h1 className="font-pixel-display text-xl tracking-widest text-white mb-2">CAREER</h1>
          <p className="text-[#a8a8c8] font-pixel">
            This dynasty is in <strong className="text-amber-300">Regular Mode</strong> — no career
            climb. Career tracking only applies to story-mode saves.
          </p>
          <Link to={`/gm/dashboard?slot=${slot}`} className="inline-block mt-4 text-amber-300 underline">
            ← Back to dashboard
          </Link>
        </div>
      </GMShell>
    )
  }

  const career = save.career
  const userSchool = save.schools[save.userSchoolId]
  const offers = career.currentOffers || []
  const firing = career.pendingFiring
  const goalDone = !!career.goalAchieved
  const ended = !!career.careerEnded

  function handleAccept(offerId) {
    if (busy) return
    setBusy(true)
    const result = acceptCareerOffer(save, offerId)
    if (!result.ok) { gmToast(result.error, 'error'); setBusy(false); return }
    // Immediate roster top-up at the new school. acceptCareerOffer can't
    // call refillThinRosters directly (circular dep with events.js), so we
    // call it here. The Dashboard self-heal would catch this on next mount
    // anyway, but doing it now lets the user navigate straight to Roster
    // / DepthChart and see a populated squad instead of an empty cupboard.
    try { refillThinRosters(save) } catch (e) { console.warn('roster refill on offer accept failed:', e) }
    saveDynasty(save)
    setSave({ ...save })
    setBusy(false)
  }
  function handleDecline() {
    if (busy) return
    setBusy(true)
    declineAllCareerOffers(save)
    saveDynasty(save)
    setSave({ ...save })
    setBusy(false)
  }

  return (
    <GMShell schoolName={userSchool?.name} schoolColors={userSchool?.colors}>
      <div className="max-w-4xl mx-auto">
        <div className="mb-4">
          <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">CAREER</h1>
          <p className="text-sm text-[#a8a8c8] font-pixel">
            Story mode · {DIFFICULTY_TUNING[career.difficulty]?.label || career.difficulty} difficulty
            · Starting role: {roleLabel(career.startingRole)} at the {career.startingLevel} level
          </p>
        </div>

        {/* Goal banner */}
        <GoalBanner goalDone={goalDone} ended={ended} career={career} />

        {/* Pending firing */}
        {firing && !ended && (
          <FiringBanner firing={firing} offers={offers} />
        )}

        {/* Pending offers */}
        {offers.length > 0 && !ended && (
          <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4 mb-4">
            <h2 className="text-sm font-bold uppercase tracking-widest text-amber-700 mb-2">
              {offers.length} Offer{offers.length === 1 ? '' : 's'} On The Table
            </h2>
            <p className="text-[11px] text-amber-900 mb-3">
              Pick at most one. Declining all of them keeps you at your current job
              {firing ? ' — but you were fired, so career ends.' : '.'}
            </p>
            <div className="space-y-2">
              {offers.map(o => (
                <OfferCard key={o.id} offer={o} onAccept={() => handleAccept(o.id)} />
              ))}
            </div>
            <button
              onClick={handleDecline}
              disabled={busy}
              className="mt-3 px-4 py-2 bg-gray-200 text-gray-800 rounded text-sm font-semibold hover:bg-gray-300 disabled:opacity-50"
            >
              Decline all · stay where I am
            </button>
          </div>
        )}

        {ended && (
          <div className="bg-red-50 border-2 border-red-400 rounded-xl p-5 mb-4 text-center">
            <div className="text-red-700 text-lg font-bold mb-1">Career ended.</div>
            <p className="text-sm text-red-800">
              You were fired and didn't accept a new offer. The dynasty stays as a record, but no new
              seasons will start. Begin a new save to play again.
            </p>
          </div>
        )}

        {/* Trajectory */}
        <h2 className="text-sm font-bold uppercase tracking-widest text-white mt-6 mb-2">
          Career Trajectory
        </h2>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="space-y-2">
            {career.trajectory.map((stop, idx) => (
              <TrajectoryRow key={idx} stop={stop} isLast={idx === career.trajectory.length - 1} />
            ))}
          </div>
        </div>

        {/* Achievements */}
        {career.achievements.length > 0 && (
          <>
            <h2 className="text-sm font-bold uppercase tracking-widest text-white mt-6 mb-2">
              Achievements
            </h2>
            <div className="bg-white rounded-xl border border-gray-200 p-4 flex flex-wrap gap-2">
              {career.achievements.map(a => (
                <span key={a} className="px-2 py-1 bg-emerald-100 text-emerald-800 text-xs font-bold rounded">
                  {a.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </GMShell>
  )
}

function GoalBanner({ goalDone, ended, career }) {
  if (ended) return null
  // D1 HC is a MILESTONE, not an end-state. Keep playing — defend the
  // throne, win a national title, get poached by an MLB org, anything.
  if (goalDone) {
    return (
      <div className="bg-gradient-to-br from-amber-50 to-purple-50 border-2 border-amber-400 rounded-xl p-5 mb-4 text-center">
        <div className="text-amber-700 text-lg font-bold">★ Milestone: D1 Head Coach</div>
        <p className="text-sm text-pnw-slate mt-1">
          You made it to the top. The career keeps going — defend the seat, chase a national title,
          or get poached. No true win condition; play as long as you want.
        </p>
      </div>
    )
  }
  // Current ladder rung indicator
  const last = career.trajectory[career.trajectory.length - 1]
  const currentLevel = last?.level || 'NWAC'
  const LEVELS = ['NWAC', 'D3', 'NAIA', 'D2', 'D1']
  const idx = LEVELS.indexOf(currentLevel)
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1">
        Goal: D1 Head Coach
      </div>
      <div className="flex items-center gap-2 mb-1">
        {LEVELS.map((lvl, i) => (
          <div key={lvl} className="flex-1 text-center">
            <div className={
              'rounded p-1 text-[10px] font-bold border ' +
              (i <= idx ? LEVEL_COLOR[lvl] : 'bg-gray-50 text-gray-400 border-gray-200')
            }>
              {lvl}
            </div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-gray-600">
        Currently coaching at <strong>{currentLevel}</strong>. Climb up by performing + accepting offers.
      </div>
    </div>
  )
}

function FiringBanner({ firing, offers }) {
  return (
    <div className="bg-red-50 border-2 border-red-400 rounded-xl p-4 mb-4">
      <div className="text-red-700 font-bold">You've been let go.</div>
      <p className="text-sm text-red-900 mt-1">{firing.reason}</p>
      {firing.severance > 0 && (
        <p className="text-[11px] text-red-700 mt-1">
          Severance: {firing.severance} weeks of pay. Use this time to land an offer.
        </p>
      )}
      {offers.length === 0 && (
        <p className="text-[11px] text-red-700 mt-1 font-bold">
          No offers came in. If you decline staying, your career ends.
        </p>
      )}
    </div>
  )
}

function OfferCard({ offer, onAccept }) {
  const tierGain = offer.tierGain || 0
  const tierLabel = tierGain > 0 ? 'UPGRADE' : tierGain === 0 ? 'LATERAL' : 'STEP DOWN'
  const tierColor = tierGain > 0 ? 'text-emerald-700' : tierGain === 0 ? 'text-gray-600' : 'text-amber-700'
  return (
    <div className="bg-white border border-amber-200 rounded p-3 flex justify-between items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={'text-[10px] font-bold px-1.5 py-0.5 rounded border ' + (LEVEL_COLOR[offer.level] || 'bg-gray-100')}>
            {offer.level}
          </span>
          <span className="font-bold text-pnw-slate">{offer.fromSchoolName}</span>
          <span className="text-xs text-gray-500">→ {roleLabel(offer.role)}</span>
          <span className={'text-[10px] font-bold ' + tierColor}>{tierLabel}</span>
        </div>
        <div className="text-[11px] text-gray-600 mt-1">{offer.blurb}</div>
        <div className="flex gap-3 text-[11px] text-gray-700 mt-1.5">
          <span><strong>${(offer.salary / 1000).toFixed(0)}K</strong> salary</span>
          {offer.signingBonus > 0 && (
            <span>+ <strong>${(offer.signingBonus / 1000).toFixed(0)}K</strong> signing bonus</span>
          )}
        </div>
      </div>
      <button
        onClick={onAccept}
        className="px-3 py-2 bg-emerald-600 text-white rounded text-sm font-semibold hover:bg-emerald-700 shrink-0"
      >
        Accept
      </button>
    </div>
  )
}

function TrajectoryRow({ stop, isLast }) {
  const result = stop.result
  const resultBadge = {
    'started':         { label: 'Started', color: 'bg-blue-100 text-blue-800' },
    'completed':       { label: 'Completed', color: 'bg-gray-100 text-gray-700' },
    'hired':           { label: 'Hired', color: 'bg-emerald-100 text-emerald-800' },
    'promoted':        { label: 'Promoted', color: 'bg-emerald-100 text-emerald-800' },
    'fired':           { label: 'Fired', color: 'bg-red-100 text-red-800' },
    'declined-offers': { label: 'Stayed', color: 'bg-amber-100 text-amber-800' },
  }[result] || { label: result, color: 'bg-gray-100 text-gray-700' }
  return (
    <div className={'flex items-center gap-3 p-2 rounded ' + (isLast ? 'bg-amber-50 border border-amber-200' : 'bg-gray-50')}>
      <div className="font-mono text-sm font-bold text-pnw-slate w-12">{stop.year}</div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm text-pnw-slate truncate">
          {roleLabel(stop.role)} · {stop.schoolName}
          {stop.level && (
            <span className={'ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded border ' + (LEVEL_COLOR[stop.level] || 'bg-gray-100')}>
              {stop.level}
            </span>
          )}
        </div>
        {(stop.wins || stop.losses) > 0 && (
          <div className="text-[11px] text-gray-500 mt-0.5">
            {stop.wins}-{stop.losses} ({((stop.wins / Math.max(1, stop.wins + stop.losses)) * 100).toFixed(0)}%)
          </div>
        )}
      </div>
      <span className={'text-[10px] font-bold px-1.5 py-0.5 rounded ' + resultBadge.color}>
        {resultBadge.label}
      </span>
    </div>
  )
}
