import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import {
  generateRecruitPool, ACTION_TYPES, applyRecruitingAction,
  estimateRecruitRatings, recruitingPhase, visibleRecruits,
  tryAdvanceRecruit,
  setLiveOffer, withdrawOffer, totalSuitors, visibleSuitors,
  academicScholarship, academicRatingToGpa,
  scoutingProgress, isFullyScouted,
  predictRecruitAttendance, rsvpLabel, CAMP_MAX_INVITES,
} from '../../gm/engine/recruits'
import { makeRng } from '../../gm/engine/rng'
import { scholarshipSnapshot } from '../../gm/engine/scholarshipAccounting'
import { REGIONS, REGION_LABELS, STATE_TO_REGION } from '../../gm/engine/regions'
import { prettyLabel } from '../../gm/engine/format'
import TeamLogo from '../../gm/components/TeamLogo'
import { getArchetype, getQuirk, formatHeight } from '../../gm/engine/playerArchetypes'
import GMShell, { ContextBox } from '../../gm/components/GMShell'

const POOL_LABELS = {
  HS_SR: 'HS Senior',
  JUCO: 'JUCO Transfer',
  NAIA_TRANSFER: 'NAIA Portal',
  D1_TRANSFER: 'D1 Portal',
  D2_TRANSFER: 'D2 Portal',
  D3_TRANSFER: 'D3 Portal',
}

// Compact source-level chip shown on every row in the unified board.
// Replaces the per-pool tab system — one feed, one label per player.
const SOURCE_CHIP = {
  HS_SR:         { short: 'HS',  color: 'bg-blue-100 text-blue-800' },
  JUCO:          { short: 'JC',  color: 'bg-emerald-100 text-emerald-800' },
  NAIA_TRANSFER: { short: 'NAIA',color: 'bg-pnw-green/10 text-pnw-green' },
  D1_TRANSFER:   { short: 'D1',  color: 'bg-purple-100 text-purple-800' },
  D2_TRANSFER:   { short: 'D2',  color: 'bg-amber-100 text-amber-800' },
  D3_TRANSFER:   { short: 'D3',  color: 'bg-slate-100 text-slate-700' },
}

const PREFERENCE_LABELS = {
  financial:        'Wants $$$',
  proximity:        'Close to home',
  playing_time:     'Wants playing time',
  program_history:  'Wants to win',
  facilities:       'Wants facilities',
  academics:        'Strong academics',
  coaching:         'Wants top coaching',
  pipeline_fit:     'Coach pipeline fit',
}

export default function Recruiting() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => {
    const s = loadDynasty(userId, slot)
    return s
  })
  // Wk 4 tutorial flag — the scouting opens this week and the user must
  // spend every AP on scouting before they can advance.
  const weekOfYear = save?.calendar?.weekOfYear ?? 1
  const isWk4Tutorial = weekOfYear === 4
  const apBaseline = save?.ap?.baseline ?? 25
  const [board, setBoard] = useState('BOARD')        // BOARD | FOLLOWING | OFFERS | SIGNED
  const [poolFilter, setPoolFilter] = useState('ALL')
  const [expandedRow, setExpandedRow] = useState(null)
  const [posFilter, setPosFilter] = useState('ALL')
  const [regionFilter, setRegionFilter] = useState('ALL')
  const [openRecruit, setOpenRecruit] = useState(null)
  // Sort order — applies to the BOARD view. Defaults to regional rank
  // which is the original behavior; user can pick any of these.
  const [sortBy, setSortBy] = useState('RANK')   // RANK | INTEREST | SCOUTED | EST_OVR | EST_POT | NAME

  function toggleFollow(recruitId) {
    const r = save.recruits[recruitId]
    if (!r) return
    r.followed = !r.followed
    saveDynasty(save)
    setSave({ ...save })
  }

  function toggleCampInvite(recruitId) {
    const r = save.recruits[recruitId]
    if (!r) return
    if (r.pool !== 'HS_SR') {
      alert('Prospect camp is HS only.')
      return
    }
    // Invite windows are ONLY Wk 5 and Wk 10. Outside those weeks, the user
    // can view the list but not modify it. 50 invites max per window.
    const wk = save.calendar?.weekOfYear ?? 0
    const isInviteWindow = wk === 5 || wk === 10
    if (!isInviteWindow) {
      alert('Camp invites can only be sent during Wk 5 or Wk 10. Wait for the next window.')
      return
    }
    // Track invites per window so the 50-per-window cap is enforced even
    // after un-inviting + re-inviting.
    if (!save.campInvitesByWindow) save.campInvitesByWindow = { 5: 0, 10: 0 }
    const currentlyInvited = !!r.campInvited
    if (!currentlyInvited) {
      const totalInvited = Object.values(save.recruits || {}).filter(x => x.campInvited).length
      if (totalInvited >= CAMP_MAX_INVITES) {
        alert(`Camp invite cap reached (${CAMP_MAX_INVITES}). Un-invite someone first.`)
        return
      }
      const PER_WINDOW = 50
      if ((save.campInvitesByWindow[wk] || 0) >= PER_WINDOW) {
        alert(`Week ${wk} invite cap reached (${PER_WINDOW} per window). Use the Wk ${wk === 5 ? 10 : 5} window for the rest.`)
        return
      }
      save.campInvitesByWindow[wk] = (save.campInvitesByWindow[wk] || 0) + 1
      // Send the invite + give them a small immediate interest boost — being
      // contacted at all is a positive signal even if they decline camp.
      if (!r.scoutGrades[save.userSchoolId]) {
        r.scoutGrades[save.userSchoolId] = { interest: 0, noise: 15, revealedPreferences: [], actionsApplied: [], apSpent: 0 }
      }
      const g = r.scoutGrades[save.userSchoolId]
      g.interest = Math.min(100, g.interest + 5)
      r.campInviteWindow = wk
    } else {
      // Un-inviting frees a slot in the window it was sent during.
      const inviteWk = r.campInviteWindow || wk
      save.campInvitesByWindow[inviteWk] = Math.max(0, (save.campInvitesByWindow[inviteWk] || 0) - 1)
      r.campInviteWindow = null
    }
    r.campInvited = !currentlyInvited
    saveDynasty(save)
    setSave({ ...save })
  }

  if (!save) return <Navigate to="/gm" replace />

  const phase = recruitingPhase(save.calendar)
  const userHC = save.coaches[save.teams[save.userSchoolId].headCoachId]
  const userSchool = save.schools[save.userSchoolId]

  // Lazy-generate recruit pool on first visit, biased by coach
  const recruits = useMemo(() => {
    if (save.recruits && Object.keys(save.recruits).length > 0) return save.recruits
    const pool = generateRecruitPool(save.calendar.year + 1, save.rngSeed, userHC, save.userSchoolId)
    save.recruits = pool
    saveDynasty(save)
    return pool
  }, [save])

  const visible = visibleRecruits(recruits, save.calendar)

  const stateBreakdown = useMemo(() => {
    const out = {}
    for (const r of visible) {
      const s = r.hometown.state
      out[s] = (out[s] || 0) + 1
    }
    return Object.entries(out).sort((a, b) => b[1] - a[1])
  }, [visible])
  const topStates = stateBreakdown.slice(0, 8)

  // Board view filters
  const boardFiltered = visible.filter(r => {
    if (board === 'FOLLOWING') return r.followed === true
    if (board === 'OFFERS') return r.liveOffer?.schoolId === save.userSchoolId
    if (board === 'INVITES') return r.campInvited === true
    return true
  })

  // Signed tab includes signed recruits (which are not in `visible`since
  // visibleRecruits excludes status==='signed')
  const signedList = Object.values(save.recruits || {}).filter(r => r.signedTo === save.userSchoolId)

  const baseList = board === 'SIGNED' ? signedList : boardFiltered

  const list = baseList
    .filter(r => {
      if (poolFilter === 'ALL') return true
      if (poolFilter === 'PORTAL') return ['NAIA_TRANSFER', 'D1_TRANSFER', 'D2_TRANSFER', 'D3_TRANSFER'].includes(r.pool)
      return r.pool === poolFilter
    })
    .filter(r => posFilter === 'ALL' || r.primaryPosition === posFilter)
    .filter(r => regionFilter === 'ALL' || STATE_TO_REGION[r.hometown.state] === regionFilter)
    .map(r => {
      const grade = r.scoutGrades[save.userSchoolId]
      const interest = grade?.interest ?? 0
      const noise = grade?.noise ?? 15
      // "Scouted %" = inverse of noise. Max initial noise is 15, full-scout
      // floor is 2. Maps to 0-100 so users see a familiar percent.
      const scoutedPct = Math.max(0, Math.min(100, Math.round((15 - noise) / 13 * 100)))
      // Rough est OVR / POT from the current (noisy) rating block. Used
      // only for sorting so a small approximation is fine.
      const block = r.isPitcher ? r.truePitcher : r.trueHitter
      const potBlock = r.isPitcher ? r.truePotentialPitcher : r.truePotentialHitter
      const vals = block ? Object.values(block).filter(v => typeof v === 'number' && v < 100) : []
      const potVals = potBlock ? Object.values(potBlock).filter(v => typeof v === 'number' && v < 100) : []
      const estOvr = vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : 0
      const estPot = potVals.length > 0 ? Math.round(potVals.reduce((s, v) => s + v, 0) / potVals.length) : 0
      return { recruit: r, interest, noise, scoutedPct, estOvr, estPot }
    })
    .sort((a, b) => {
      // RANK is the default — ranked players bubble to the top, then by interest
      if (sortBy === 'RANK') {
        const ra = a.recruit.regionalRank
        const rb = b.recruit.regionalRank
        if (ra != null && rb != null) return ra - rb
        if (ra != null) return -1
        if (rb != null) return 1
        return b.interest - a.interest
      }
      if (sortBy === 'INTEREST') return b.interest - a.interest
      if (sortBy === 'SCOUTED')  return b.scoutedPct - a.scoutedPct
      // OVR/POT sorts: unscouted recruits (scoutedPct < 25) must NOT bubble
      // to the top — that would give away ratings the user paid AP to learn.
      // Sort them to the BOTTOM, then by est OVR/POT inside each bucket.
      if (sortBy === 'EST_OVR') {
        const aHidden = a.scoutedPct < 25
        const bHidden = b.scoutedPct < 25
        if (aHidden !== bHidden) return aHidden ? 1 : -1
        return b.estOvr - a.estOvr
      }
      if (sortBy === 'EST_POT') {
        const aHidden = a.scoutedPct < 25
        const bHidden = b.scoutedPct < 25
        if (aHidden !== bHidden) return aHidden ? 1 : -1
        return b.estPot - a.estPot
      }
      if (sortBy === 'NAME')     return a.recruit.lastName.localeCompare(b.recruit.lastName)
      return 0
    })
    .slice(0, 80)

  const followedCount = Object.values(save.recruits || {}).filter(r => r.followed && r.status !== 'signed' && r.status !== 'lost').length
  const invitedCount = Object.values(save.recruits || {}).filter(r => r.campInvited && r.status !== 'signed' && r.status !== 'lost').length

  const signedRecruits = Object.values(recruits).filter(r => r.signedTo === save.userSchoolId)
  const liveOffers = Object.values(recruits).filter(r =>
    r.liveOffer && r.liveOffer.schoolId === save.userSchoolId && r.status !== 'signed' && r.status !== 'lost',
  )
  const totalOffered = liveOffers.reduce((s, r) => s + (r.liveOffer?.amount || 0), 0)

  function handleAction(recruit, actionKey) {
    const action = ACTION_TYPES[actionKey]
    if (!action) return
    if (save.ap.currentWeek < action.apCost) {
      alert(`Not enough AP. Need ${action.apCost}, have ${save.ap.currentWeek}.`)
      return
    }
    const rng = makeRng('action', recruit.id, save.userSchoolId, Date.now())
    const result = applyRecruitingAction(recruit, save.userSchoolId, action, rng)
    save.recruits[recruit.id] = result.recruit
    save.ap.currentWeek -= action.apCost
    save.ap.spentThisWeek += action.apCost
    save.ap.spentByCategory.recruiting = (save.ap.spentByCategory.recruiting || 0) + action.apCost
    saveDynasty(save)
    setSave({ ...save })
    if (result.revealed) {
      const label = PREFERENCE_LABELS[result.revealed]
      alert(`${recruit.firstName} ${recruit.lastName} revealed a priority: "${label}" (weight: ${recruit.preferences[result.revealed]}/10)`)
    }
  }

  function handleOffer(recruit, amount) {
    const existing = save.recruits[recruit.id].liveOffer
    const isModification = existing && existing.schoolId === save.userSchoolId
    if (isModification) {
      // Modifications cost 1 AP
      if (save.ap.currentWeek < 1) {
        alert('Modifying an offer costs 1 AP. You don\'t have any left this week.')
        return
      }
      save.ap.currentWeek -= 1
      save.ap.spentThisWeek += 1
      save.ap.spentByCategory.recruiting = (save.ap.spentByCategory.recruiting || 0) + 1
    }
    // First offer is free; modifications charged above
    setLiveOffer(save.recruits[recruit.id], save.userSchoolId, amount)
    const signRng = makeRng('sign', recruit.id, save.userSchoolId, save.calendar.week)
    const signed = tryAdvanceRecruit(save.recruits[recruit.id], save.userSchoolId, userSchool, signRng, save)
    if (signed) {
      save.newsfeed.unshift({
        id: `sign_${recruit.id}_${save.calendar.year}`,
        year: save.calendar.year, week: save.calendar.week,
        type: 'AWARD',
        headline: `${recruit.firstName} ${recruit.lastName} (${recruit.primaryPosition}, ${recruit.hometown.state}) signed with ${userSchool.name}!`,
        payload: {},
      })
    }
    saveDynasty(save)
    setSave({ ...save })
  }

  function handleWithdraw(recruit) {
    withdrawOffer(save.recruits[recruit.id], save.userSchoolId)
    saveDynasty(save)
    setSave({ ...save })
  }


  const phaseLabel = phase === 'PRE_PORTAL'
    ? 'Pre-Portal — HS + JUCO recruits only'
    : 'Portal Open — All pools (D1/D2/D3/NAIA transfers + remaining HS/JUCO)'
  const campWindowOpen = isCampWindowOpen(save.calendar)
  const campHeldThisYear = save.prospectCamp?.year === save.calendar.year

  return (
    <GMShell schoolName={userSchool?.name} schoolColors={userSchool?.colors}>
    <div className="max-w-6xl mx-auto">
      {isWk4Tutorial && (
        <Wk4Tutorial save={save} apBaseline={apBaseline} />
      )}

      <div className="mb-6 flex justify-between items-start">
        <div>
          <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">Dashboard</Link>
          <h1 className="text-3xl font-bold text-pnw-slate mt-1">Recruiting Board</h1>
          <p className="text-sm text-gray-600">
            <span className="font-semibold">Class of {save.calendar.year + 1}–{String((save.calendar.year + 2) % 100).padStart(2, '0')}</span> ({save.calendar.year + 1} enrollees, play {save.calendar.year + 2} season) • {visible.length} on board • {phaseLabel}
          </p>
          {(userHC.pipelines?.length > 0 || userHC.regions?.length > 0) && (
            <p className="text-xs text-gray-500 mt-1">
              Pipelines: {(userHC.pipelines || []).map(p => p.replace(/_/g, ' ')).join(', ') || 'none'}
              {' '}• Regions: {(userHC.regions || []).join(', ') || 'none'}
            </p>
          )}
          {topStates.length > 0 && (
            <p className="text-xs text-gray-400 mt-1">
              States in pool: {topStates.map(([s, c]) => `${s} ${c}`).join(' • ')}
            </p>
          )}
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-pnw-green">{save.ap.currentWeek} AP</div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500">This week</div>
        </div>
      </div>

      <ContextBox storageKey="recruitingHelp" title="How recruiting works">
        <ul className="list-disc list-inside space-y-1">
          <li><strong>Three pools</strong>: HS seniors (Aug-Wk52), JUCO transfers, and 4-year transfer portal (D1/D2/D3 + NAIA). Use the source filter at the top to focus.</li>
          <li><strong>Scout first</strong>. New recruits show ±10-15 pt fog on ratings. Spend AP on Text, Call, Scout Trip, Home Visit, Campus Visit to narrow the fog AND build their interest in you.</li>
          <li><strong>Each action is one-shot per recruit.</strong> You can't run two Scout Trips on the same kid. Pick the right tool for where they are: Scout Trip when fog is high, Campus Visit when interest is already 80+.</li>
          <li><strong>Extend an offer</strong> when you're confident. Offers use $ from your scholarship pool (not AP). Bigger offers = more interest. You can revise or withdraw later.</li>
          <li><strong>The recruit decides</strong>. They score every interested school on 8 preferences (financial, playing time, proximity, coaching, pipeline fit, facilities, academics, program history). High fit + plus offer = sign.</li>
          <li><strong>Prospect Camp Wk 13</strong> is huge — invitees show up, get partially scouted, and bump interest in you. Invite top targets in Wks 5 and 10.</li>
        </ul>
        <p className="mt-2 text-xs text-gray-300">Visible quirks + archetype are shown for free. Hidden quirks (clutch, injury history, work ethic) require deeper scouting to surface.</p>
      </ContextBox>

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
          <div className="text-xs text-gray-500 uppercase tracking-wider">Signed class</div>
          <div className="text-2xl font-bold text-pnw-green">{signedRecruits.length}</div>
          <div className="text-[10px] text-gray-400">recruits bound to you</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
          <div className="text-xs text-gray-500 uppercase tracking-wider">Live offers</div>
          <div className="text-2xl font-bold text-pnw-slate">{liveOffers.length}</div>
          <div className="text-[10px] text-gray-400">${(totalOffered / 1000).toFixed(0)}K committed</div>
        </div>
        <Link to={`/gm/weekly?slot=${slot}`} className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm hover:border-pnw-green hover:bg-pnw-cream">
          <div className="text-xs text-gray-500 uppercase tracking-wider">Prospect camp</div>
          <div className="text-lg font-bold text-pnw-slate">{campHeldThisYear ? `${save.prospectCamp.attendees} att` : campWindowOpen ? 'Open' : 'Closed'}</div>
          <div className="text-[10px] text-gray-400">Manage on Weekly Actions </div>
        </Link>
        <Link to={`/gm/weekly?slot=${slot}`} className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm hover:border-pnw-green hover:bg-pnw-cream">
          <div className="text-xs text-gray-500 uppercase tracking-wider">Fundraise</div>
          <div className="text-lg font-bold text-pnw-slate">Weekly Actions</div>
          <div className="text-[10px] text-gray-400">Manage on Weekly Actions </div>
        </Link>
      </div>

      {/* Scholarship availability — what new $ can actually be offered */}
      <ScholarshipBanner save={save} />

      {/* Roster snapshot — returning, weaknesses, spots available */}
      <RosterSnapshotPanel save={save} />

      {/* Board tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {[
          { key: 'BOARD', label: 'Board', count: visible.length },
          { key: 'FOLLOWING', label: ' Following', count: followedCount },
          { key: 'OFFERS', label: 'Offers Out', count: liveOffers.length },
          { key: 'INVITES', label: `Camp Invites`, count: `${invitedCount}/${CAMP_MAX_INVITES}` },
          { key: 'SIGNED', label: 'Signed', count: signedRecruits.length },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setBoard(t.key)}
            className={'px-3 py-2 text-sm border-b-2 -mb-px transition ' +
              (board === t.key
                ? 'border-pnw-green text-pnw-green font-semibold'
                : 'border-transparent text-gray-500 hover:text-pnw-slate')
            }
          >
            {t.label} <span className="text-xs text-gray-400">({t.count})</span>
          </button>
        ))}
      </div>

      <div className="flex gap-2 mb-3 flex-wrap items-center">
        <span className="text-xs text-gray-500 mr-2">Source:</span>
        {[
          { key: 'ALL',           label: 'All' },
          { key: 'HS_SR',         label: 'HS' },
          { key: 'JUCO',          label: 'JUCO' },
          { key: 'PORTAL',        label: 'Transfer Portal', requiresPortal: true },
        ].map(t => {
          const isLocked = t.requiresPortal && phase === 'PRE_PORTAL'
          const active = poolFilter === t.key
          return (
            <button
              key={t.key}
              onClick={() => !isLocked && setPoolFilter(t.key)}
              disabled={isLocked}
              className={'px-3 py-1.5 rounded-lg text-xs font-semibold transition ' +
                (active ? 'bg-pnw-green text-white shadow' : 'bg-gray-100 text-gray-700 hover:bg-gray-200') +
                (isLocked ? ' opacity-40 cursor-not-allowed' : '')
              }
              title={isLocked ? 'Portal opens after the regular season ends' : ''}
            >
              {t.label}{isLocked ? ' ' : ''}
            </button>
          )
        })}
      </div>

      <div className="flex gap-2 mb-3 flex-wrap items-center">
        <span className="text-xs text-gray-500 mr-2">Pos:</span>
        {['ALL', 'C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF', 'P'].map(p => (
          <button
            key={p}
            onClick={() => setPosFilter(p)}
            className={'px-2 py-1 rounded text-xs ' + (posFilter === p ? 'bg-pnw-green text-white' : 'bg-gray-100 text-gray-700')}
          >{p}</button>
        ))}
      </div>

      <div className="flex gap-2 mb-3 flex-wrap items-center">
        <span className="text-xs text-gray-500 mr-2">Region:</span>
        <button onClick={() => setRegionFilter('ALL')} className={'px-2 py-1 rounded text-xs ' + (regionFilter === 'ALL' ? 'bg-pnw-green text-white' : 'bg-gray-100 text-gray-700')}>All</button>
        {REGIONS.map(r => (
          <button key={r} onClick={() => setRegionFilter(r)} className={'px-2 py-1 rounded text-xs ' + (regionFilter === r ? 'bg-pnw-green text-white' : 'bg-gray-100 text-gray-700')}>{REGION_LABELS[r]}</button>
        ))}
      </div>

      <div className="flex gap-2 mb-3 flex-wrap items-center">
        <span className="text-xs text-gray-500 mr-2">Sort by:</span>
        {[
          ['RANK', 'Regional rank'],
          ['INTEREST', 'Most interest'],
          ['SCOUTED', 'Most scouted'],
          ['EST_OVR', 'Highest est OVR'],
          ['EST_POT', 'Highest est POT'],
          ['NAME', 'Last name (A-Z)'],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setSortBy(k)}
            className={'px-2 py-1 rounded text-xs ' + (sortBy === k ? 'bg-pnw-green text-white' : 'bg-gray-100 text-gray-700')}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left text-xs text-gray-500 uppercase">
              <th className="py-2 px-3 w-8"></th>
              <th className="w-6"></th>
              <SortableTh sortKey="RANK" sortBy={sortBy} setSortBy={setSortBy} title="Regional rank (top 25 per region for HS prospects)">Rk</SortableTh>
              <SortableTh sortKey="NAME" sortBy={sortBy} setSortBy={setSortBy}>Player</SortableTh>
              <th>Pos</th>
              <th title="Source league — HS, JUCO, NAIA/D1/D2/D3 portal">Src</th>
              <SortableTh sortKey="EST_OVR" sortBy={sortBy} setSortBy={setSortBy} title="Estimated current OVR — band narrows as you scout, never collapses fully. Unscouted recruits sort to the bottom so ratings aren't leaked.">Est OVR</SortableTh>
              <SortableTh sortKey="EST_POT" sortBy={sortBy} setSortBy={setSortBy} title="Estimated ceiling — wider band than current. Unscouted recruits sort to the bottom.">Est POT</SortableTh>
              <SortableTh sortKey="INTEREST" sortBy={sortBy} setSortBy={setSortBy}>Interest</SortableTh>
              <SortableTh sortKey="SCOUTED" sortBy={sortBy} setSortBy={setSortBy} title="Scouting progress">Scout</SortableTh>
              <th>Offer</th>
              <th className="w-20"></th>
            </tr>
          </thead>
          <tbody>
            {list.map(({ recruit, interest, noise }) => (
              <RecruitRow
                key={recruit.id}
                recruit={recruit}
                save={save}
                interest={interest}
                noise={noise}
                expanded={expandedRow === recruit.id}
                onToggleExpand={() => setExpandedRow(expandedRow === recruit.id ? null : recruit.id)}
                onOpenModal={() => setOpenRecruit(recruit)}
                onToggleFollow={() => toggleFollow(recruit.id)}
                onToggleCamp={() => toggleCampInvite(recruit.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {openRecruit && (
        <RecruitModal
          recruit={save.recruits[openRecruit.id] || openRecruit}
          save={save}
          onAction={handleAction}
          onOffer={handleOffer}
          onWithdraw={handleWithdraw}
          onClose={() => setOpenRecruit(null)}
        />
      )}

    </div>
    </GMShell>
  )
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Clickable table header. Adds the standard "active" highlight + arrow when
 * this column is the current sort, so the user knows the buttons up top and
 * the header row are wired to the same state.
 */
function SortableTh({ sortKey, sortBy, setSortBy, children, title }) {
  const active = sortBy === sortKey
  return (
    <th
      title={title}
      onClick={() => setSortBy(sortKey)}
      className={'select-none cursor-pointer hover:text-pnw-slate transition ' + (active ? 'text-pnw-green font-bold' : '')}
    >
      {children}
      {active && <span className="ml-0.5">↓</span>}
    </th>
  )
}

function RosterSnapshotPanel({ save }) {
  const ROSTER_CAP = 50
  const team = save.teams?.[save.userSchoolId]
  if (!team) return null
  const players = (team.rosterPlayerIds || []).map(id => save.players[id]).filter(Boolean)
  // Returning next year = everyone except graduating seniors. A SR with a
  // redshirt year used + only 3 seasons played stays (they have eligibility
  // left); a SR with 4 seasons used is done.
  function isGraduating(p) {
    if (p.classYear !== 'SR') return false
    if (p.redshirtUsed === true && (p.seasonsUsed ?? 0) < 4) return false
    return true
  }
  const returningCount = players.filter(p => !isGraduating(p)).length
  const graduating = players.filter(isGraduating).length
  // Already-committed recruits for the upcoming class
  const committedRecruits = Object.values(save.recruits || {}).filter(r =>
    r.signedTo === save.userSchoolId && r.status === 'signed',
  ).length
  // Spots available for the upcoming cycle = cap - returning - committed
  const projectedNextYearSize = returningCount + committedRecruits
  const spotsAvailable = Math.max(0, ROSTER_CAP - projectedNextYearSize)

  // Positional needs — count returning players at each position (non-graduating)
  function returningAtPosition(targetPos) {
    return players.filter(p => {
      if (isGraduating(p)) return false
      if (targetPos === 'P') return p.isPitcher
      return p.primaryPosition === targetPos
    }).length
  }
  // Target depth per spot
  const POS_TARGETS = { C: 3, '1B': 2, '2B': 2, SS: 2, '3B': 2, LF: 2, CF: 2, RF: 2, P: 15 }
  const weaknesses = []
  for (const [pos, target] of Object.entries(POS_TARGETS)) {
    const have = returningAtPosition(pos)
    if (have < target) weaknesses.push({ pos, have, target, gap: target - have })
  }
  weaknesses.sort((a, b) => b.gap - a.gap)

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 mb-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Roster spots */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1">Roster spots available</div>
          <div className="flex items-baseline gap-2">
            <div className="text-3xl font-bold text-pnw-green leading-none">{spotsAvailable}</div>
            <div className="text-xs text-gray-500">/ {ROSTER_CAP} cap</div>
          </div>
          <div className="text-[11px] text-gray-600 mt-1 leading-snug">
            <strong>{returningCount}</strong> returning · <strong>{committedRecruits}</strong> already signed ·
            <strong className="text-amber-700"> {graduating}</strong> graduating after this season.
          </div>
        </div>
        {/* Positional weaknesses */}
        <div className="md:col-span-2">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1">Positional needs (returning roster)</div>
          {weaknesses.length === 0 ? (
            <div className="text-xs text-green-700 italic">No critical gaps — every position has depth.</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {weaknesses.map(w => (
                <div
                  key={w.pos}
                  className={'px-2 py-1 rounded text-xs flex items-center gap-1.5 ' +
                    (w.gap >= 3 ? 'bg-red-100 text-red-800 border border-red-200'
                      : w.gap === 2 ? 'bg-amber-100 text-amber-800 border border-amber-200'
                      : 'bg-gray-100 text-gray-700 border border-gray-200')}
                  title={`${w.have} returning at ${w.pos}, target ${w.target}`}
                >
                  <span className="font-bold">{w.pos}</span>
                  <span className="font-mono">{w.have}/{w.target}</span>
                </div>
              ))}
            </div>
          )}
          <div className="text-[11px] text-gray-500 italic mt-1.5">
            Red = critical gap (3+ short), amber = needs 2, gray = needs 1. Focus your recruiting on these spots.
          </div>
        </div>
      </div>
    </div>
  )
}

function ScholarshipBanner({ save }) {
  const s = scholarshipSnapshot(save)
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3 mb-4 shadow-sm">
      <div className="flex justify-between items-baseline text-xs mb-2">
        <div className="text-gray-600">
          <span className="font-semibold text-pnw-slate">Next year's scholarship budget</span> — pool ${(s.pool / 1000).toFixed(0)}K, returning ${(s.returningCommitted / 1000).toFixed(0)}K, signed ${(s.signedRecruits / 1000).toFixed(0)}K, offers out ${(s.pendingOffers / 1000).toFixed(0)}K
        </div>
        <div className="font-semibold text-pnw-green text-sm">${(s.nextYearAvailable / 1000).toFixed(1)}K available</div>
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden flex">
        <div className="bg-pnw-slate h-full" style={{ width: `${(s.returningCommitted / Math.max(1, s.pool)) * 100}%` }} title="Returning roster" />
        <div className="bg-pnw-green h-full" style={{ width: `${(s.signedRecruits / Math.max(1, s.pool)) * 100}%` }} title="Signed recruits" />
        <div className="bg-amber-500 h-full" style={{ width: `${(s.pendingOffers / Math.max(1, s.pool)) * 100}%` }} title="Pending offers" />
      </div>
      <div className="text-[11px] text-gray-500 mt-1.5">
        <span className="font-semibold">{s.graduatingSeniors}</span> senior{s.graduatingSeniors === 1 ? '' : 's'} graduating — freeing <span className="font-semibold text-pnw-green">${(s.graduatingDollars / 1000).toFixed(1)}K</span> for next year's class.
        {s.nextYearAvailable < 5000 && <span className="text-amber-700">  Low runway.</span>}
      </div>
    </div>
  )
}

function isCampWindowOpen(calendar) {
  if (calendar.mode !== 'OFFSEASON') return false
  // Use sim-date, not wall clock: offseason week 1 = Aug 1. Camp window is
  // Aug-Nov of the offseason roughly offseason weeks 1-17.
  return calendar.offseasonWeek >= 1 && calendar.offseasonWeek <= 17
}

function _unusedComputeProgramMomentum(save) {
  // Use last completed season's win pct + postseason status
  const team = save.teams[save.userSchoolId]
  const totalGames = (team.wins || 0) + (team.losses || 0)
  const winPct = totalGames > 0 ? (team.wins || 0) / totalGames : 0.5
  let momentum = winPct * 100
  if (save.postseason?.userChamp) momentum += 15
  if (save.postseason?.userInWS) momentum += 20
  if (save.postseason?.userWSChamp) momentum += 30
  return Math.min(100, Math.max(0, Math.round(momentum)))
}

function SuitorBadge({ recruit }) {
  const vis = visibleSuitors(recruit)
  if (!vis.revealed) {
    const color = vis.total >= 6 ? 'text-amber-700' : vis.total >= 3 ? 'text-gray-700' : 'text-gray-500'
    return <span className={'text-[10px] italic ' + color}>{vis.label}</span>
  }
  const suitors = vis.suitors || {}
  const parts = []
  if (suitors.d1) parts.push(`${suitors.d1} D1`)
  if (suitors.topNaia) parts.push(`${suitors.topNaia} top NAIA`)
  if (suitors.otherNaia) parts.push(`${suitors.otherNaia} NAIA`)
  if (suitors.d2d3) parts.push(`${suitors.d2d3} D2/D3`)
  const color = vis.total >= 6 ? 'text-red-700' : vis.total >= 3 ? 'text-amber-700' : 'text-gray-600'
  return <span className={'text-[10px] ' + color}>{parts.slice(0, 2).join(' • ') || 'none'}</span>
}

function RecruitRow({ recruit, save, interest, noise, expanded, onToggleExpand, onOpenModal, onToggleFollow, onToggleCamp }) {
  const isSigned = recruit.signedTo === save.userSchoolId
  const hasLiveOffer = recruit.liveOffer?.schoolId === save.userSchoolId
  const apSpent = recruit.scoutGrades?.[save.userSchoolId]?.apSpent || 0
  const scoutedAtAll = apSpent >= 2
  const fullyScouted = isFullyScouted(recruit, save.userSchoolId)
  const src = SOURCE_CHIP[recruit.pool] || SOURCE_CHIP.HS_SR
  const archetype = getArchetype(recruit.archetypeKey)
  const m = recruit.measurables || {}

  // Compute Est OVR + Est POT ranges (uniform within ±noise — equally likely
  // anywhere in the band).
  function ovrRange() {
    if (!scoutedAtAll) return { lo: null, hi: null }
    const block = recruit.isPitcher ? recruit.truePitcher : recruit.trueHitter
    const trueOvr = Math.round(Object.values(block).reduce((a, b) => a + b, 0) / Object.keys(block).length)
    const half = noise
    return {
      lo: Math.max(20, trueOvr - half),
      hi: Math.min(99, trueOvr + half),
    }
  }
  function potRange() {
    if (!scoutedAtAll) return { lo: null, hi: null }
    const block = recruit.isPitcher ? recruit.truePotentialPitcher : recruit.truePotentialHitter
    if (!block) return { lo: null, hi: null }
    const truePot = Math.round(Object.values(block).reduce((a, b) => a + b, 0) / Object.keys(block).length)
    // POT noise: 1.2× current noise (tightened from 1.5× — old bands were
    // basically useless "60-99" reads on initial board view).
    const half = Math.round(noise * 1.2)
    return {
      lo: Math.max(20, truePot - half),
      hi: Math.min(99, truePot + half),
    }
  }
  const ovr = ovrRange()
  const pot = potRange()
  const sp = scoutingProgress(recruit, save.userSchoolId)

  return (
    <>
      <tr className={'border-t ' + (isSigned ? 'bg-green-50' : 'hover:bg-gray-50')}>
        <td className="py-2 px-3 text-center">
          <button
            onClick={onToggleExpand}
            className="text-gray-400 hover:text-pnw-slate transition"
            title={expanded ? 'Collapse' : 'Expand for details + scout actions'}
          >
            {expanded ? '▾' : '▸'}
          </button>
        </td>
        <td className="text-center">
          <button
            onClick={onToggleFollow}
            className={'text-base leading-none transition ' + (recruit.followed ? 'text-amber-500' : 'text-gray-300 hover:text-amber-400')}
            title={recruit.followed ? 'Unfollow' : 'Follow / star this recruit'}
          >
            {recruit.followed ? '' : ''}
          </button>
        </td>
        <td className="text-xs">
          {recruit.regionalRank != null ? (
            <span
              className={'inline-block px-1.5 py-0.5 rounded font-bold font-mono ' +
                (recruit.regionalRank <= 5 ? 'bg-yellow-100 text-yellow-800'
                  : recruit.regionalRank <= 10 ? 'bg-amber-100 text-amber-800'
                  : 'bg-gray-100 text-gray-700')}
              title={`#${recruit.regionalRank} in ${recruit.rankedRegion}`}
            >
              #{recruit.regionalRank}
            </span>
          ) : (
            <span className="text-gray-300 text-[10px]">—</span>
          )}
        </td>
        <td className="font-medium">
          <div className="flex items-center gap-1.5">
            {isSigned && <span className="text-[9px] font-bold uppercase text-pnw-green bg-pnw-green/10 border border-pnw-green/30 rounded px-1 py-0.5">Signed</span>}
            <span>{recruit.firstName} {recruit.lastName}</span>
            {scoutedAtAll && archetype && (
              <span className="text-[10px] text-gray-500 italic hidden lg:inline">· {archetype.label}</span>
            )}
          </div>
          <div className="text-[10px] text-gray-400">{recruit.hometown.city}, {recruit.hometown.state}</div>
        </td>
        <td className="text-xs">{recruit.isPitcher ? 'P' : recruit.primaryPosition}</td>
        <td>
          <span className={'text-[10px] font-bold px-1.5 py-0.5 rounded ' + src.color}>
            {src.short}
          </span>
        </td>
        <td className="font-mono text-xs">
          {ovr.lo == null ? <span className="text-gray-400">???</span>
            : ovr.lo === ovr.hi ? <span className="font-bold">{ovr.lo}</span>
            : <span>{ovr.lo}–{ovr.hi}</span>}
        </td>
        <td className="font-mono text-xs">
          {pot.lo == null ? <span className="text-gray-400">???</span>
            : pot.lo === pot.hi ? <span className="font-bold text-pnw-green">{pot.lo}</span>
            : <span className="text-pnw-green">{pot.lo}–{pot.hi}</span>}
        </td>
        <td>
          <div className="flex items-center gap-2">
            <div className="w-12 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-pnw-green" style={{ width: `${interest}%` }} />
            </div>
            <span className="text-xs font-mono">{interest}</span>
          </div>
        </td>
        <td>
          <div className="flex items-center gap-2">
            <div className="w-12 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className={'h-full ' + (fullyScouted ? 'bg-blue-600' : 'bg-pnw-slate')} style={{ width: `${sp * 100}%` }} />
            </div>
            {fullyScouted && <span className="text-[10px] text-blue-700 font-bold">FULL</span>}
          </div>
        </td>
        <td className="text-xs">
          {hasLiveOffer ? (
            <span className="font-mono font-bold text-pnw-green">${(recruit.liveOffer.amount / 1000).toFixed(1)}K</span>
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </td>
        <td>
          {isSigned ? (
            <span className="text-xs text-green-700 font-bold">SIGNED</span>
          ) : (
            <button
              onClick={onOpenModal}
              className="text-xs bg-pnw-green text-white px-2 py-1 rounded hover:opacity-90"
            >
              Recruit 
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-t bg-gray-50">
          <td colSpan={12} className="p-3">
            <RecruitExpansion
              recruit={recruit}
              save={save}
              hasLiveOffer={hasLiveOffer}
              onOpenModal={onOpenModal}
              onToggleCamp={onToggleCamp}
              archetype={archetype}
              measurables={m}
              scoutedAtAll={scoutedAtAll}
            />
          </td>
        </tr>
      )}
    </>
  )
}

function RecruitExpansion({ recruit, save, scoutedAtAll, archetype, measurables, onOpenModal, onToggleCamp }) {
  const visibleQuirks = (recruit.visibleQuirks || []).map(getQuirk).filter(Boolean)
  const isHs = recruit.pool === 'HS_SR'
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
      {/* Measurables */}
      <div className="bg-white rounded p-3 border border-gray-200">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1.5">Measurables</div>
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
          {measurables.heightInches && <><span className="text-gray-500">Height</span><span className="font-mono text-right">{formatHeight(measurables.heightInches)}</span></>}
          {measurables.weightLbs && <><span className="text-gray-500">Weight</span><span className="font-mono text-right">{measurables.weightLbs} lb</span></>}
          {measurables.sixtyYardSec && <><span className="text-gray-500">60-yard</span><span className="font-mono text-right">{measurables.sixtyYardSec.toFixed(2)} s</span></>}
          {measurables.maxEvMph && <><span className="text-gray-500">Max EV</span><span className="font-mono text-right font-bold">{measurables.maxEvMph} mph</span></>}
          {measurables.popTimeSec && <><span className="text-gray-500">Pop time</span><span className="font-mono text-right">{measurables.popTimeSec.toFixed(2)} s</span></>}
          {measurables.fbVeloMph && <><span className="text-gray-500">FB velo</span><span className="font-mono text-right">{measurables.fbVeloMinMph}–{measurables.fbVeloMaxMph} mph</span></>}
        </div>
        <div className="text-[10px] text-gray-400 italic mt-1">Public-knowledge measurables — always visible.</div>
      </div>

      {/* Profile (archetype + visible quirks) */}
      <div className="bg-white rounded p-3 border border-gray-200">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1.5">Profile</div>
        {scoutedAtAll && archetype ? (
          <>
            <div className="text-sm font-bold text-pnw-slate">{archetype.label}</div>
            <div className="text-[11px] text-gray-600 leading-snug mt-0.5">{archetype.blurb}</div>
            {visibleQuirks.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {visibleQuirks.map(q => (
                  <span key={q.key} className="text-[10px] font-semibold bg-pnw-cream text-pnw-slate px-1.5 py-0.5 rounded" title={q.label}>
                    {q.bias && Object.values(q.bias).some(v => v < 0) ? ' ' : ' '}{q.label}
                  </span>
                ))}
              </div>
            )}
            {recruit.hiddenQuirks?.length > 0 && (
              <div className="mt-2 text-[10px] text-gray-400 italic">
                + {recruit.hiddenQuirks.length} hidden trait{recruit.hiddenQuirks.length === 1 ? '' : 's'} (scout deeper to reveal)
              </div>
            )}
          </>
        ) : (
          <div className="text-[11px] text-gray-400 italic">
            Scout the player to reveal their archetype + visible quirks.
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="bg-white rounded p-3 border border-gray-200">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1.5">Actions</div>
        <button
          onClick={onOpenModal}
          className="w-full mb-1.5 px-2 py-1.5 bg-pnw-green text-white rounded text-xs font-semibold hover:opacity-90"
        >
          Open full recruit panel 
        </button>
        {isHs && (
          <button
            onClick={onToggleCamp}
            className={'w-full px-2 py-1.5 rounded text-xs font-semibold ' +
              (recruit.campInvited
                ? 'bg-blue-100 text-blue-800 hover:bg-blue-200'
                : 'border border-gray-300 text-gray-700 hover:bg-gray-100')}
          >
            {recruit.campInvited ? ' Camp invite sent' : '+ Invite to prospect camp (free)'}
          </button>
        )}
      </div>
    </div>
  )
}

function ActionCard({ title, subtitle, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={'text-left bg-white border border-gray-200 rounded-xl p-4 shadow-sm transition ' +
        (disabled ? 'opacity-60 cursor-not-allowed' : 'hover:border-pnw-green')
      }
    >
      <div className="font-semibold text-pnw-slate">{title}</div>
      <div className="text-xs text-gray-500 mt-1">{subtitle}</div>
    </button>
  )
}

// ── Camp modal ──────────────────────────────────────────────────────────────

function CampModal({ save, coach, recruits, onConfirm, onClose }) {
  const [fee, setFee] = useState(125)
  const [invitedIds, setInvitedIds] = useState([])
  const [showInviteList, setShowInviteList] = useState(false)

  const momentum = useMemo(() => computeProgramMomentum(save), [save])

  const prediction = useMemo(() => {
    return predictCampTurnout(recruits, save.userSchoolId, invitedIds, fee, coach.recruiter, momentum)
  }, [recruits, save.userSchoolId, invitedIds, fee, coach.recruiter, momentum])

  const projectedRevenue = prediction.predictedAttendees * fee
  const isBelowMin = prediction.predictedAttendees < CAMP_MIN_ATTENDEES

  // List of pool recruits to invite from
  const invitablePool = Object.values(recruits)
    .filter(r => r.pool === 'HS_SR' && r.status === 'open')
    .sort((a, b) => {
      const ia = a.scoutGrades[save.userSchoolId]?.interest ?? 0
      const ib = b.scoutGrades[save.userSchoolId]?.interest ?? 0
      return ib - ia
    })
    .slice(0, 80)

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6">
        <div className="flex justify-between items-start mb-3">
          <h3 className="text-xl font-bold text-pnw-slate">Hold Prospect Camp</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"></button>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          HS prospects only. Runs once a year in <strong>Week 13 (late October)</strong>. Attendees get +25 interest + scout fog drop + small rating bump. Revenue ($ × attendees) adds to budget immediately. Camp needs <strong>{CAMP_MIN_ATTENDEES} min</strong> attendees or it's cancelled. Max {CAMP_MAX_ATTENDEES}, with walk-ons capped at 25.
        </p>

        <div className="mb-4">
          <label className="text-xs uppercase tracking-wider text-gray-500">Fee per attendee</label>
          <div className="flex items-center gap-3 mt-1">
            <input type="range" min={25} max={200} step={5} value={fee} onChange={e => setFee(parseInt(e.target.value, 10))} className="flex-1" />
            <span className="font-mono font-bold text-pnw-green w-16 text-right">${fee}</span>
          </div>
        </div>

        <div className="bg-pnw-cream rounded p-3 mb-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500">Predicted</div>
              <div className={'text-xl font-bold ' + (isBelowMin ? 'text-red-700' : 'text-pnw-green')}>{prediction.predictedAttendees}</div>
              <div className="text-[10px] text-gray-500">attendees</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500">Invited</div>
              <div className="text-xl font-bold text-pnw-slate">{prediction.invitedAttendees}</div>
              <div className="text-[10px] text-gray-500">of {invitedIds.length} invites</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500">Walk-ons</div>
              <div className="text-xl font-bold text-pnw-slate">{prediction.walkOns}</div>
              <div className="text-[10px] text-gray-500">uninvited</div>
            </div>
          </div>
          <div className="mt-3 text-center">
            <span className="text-sm text-gray-700">Projected revenue: </span>
            <span className="font-bold text-pnw-green">${(projectedRevenue / 1000).toFixed(1)}K</span>
          </div>
          {isBelowMin && (
            <div className="mt-2 text-xs text-red-700 text-center">
               Below the {CAMP_MIN_ATTENDEES}-attendee minimum. Lower the fee or invite more players, or the camp won't run.
            </div>
          )}
        </div>

        <div className="bg-gray-50 rounded p-2 text-xs text-gray-600 mb-4">
          Coach recruiter: <strong>{coach.recruiter}</strong> • Program momentum: <strong>{momentum}/100</strong>
        </div>

        <div className="mb-4">
          <button
            onClick={() => setShowInviteList(!showInviteList)}
            className="text-sm text-pnw-green hover:underline"
          >
            {showInviteList ? 'Hide' : 'Show'} invite list ({invitedIds.length} selected)
          </button>
        </div>

        {showInviteList && (
          <div className="border rounded p-2 mb-4 max-h-60 overflow-y-auto">
            {invitablePool.map(r => {
              const isInvited = invitedIds.includes(r.id)
              const interest = r.scoutGrades[save.userSchoolId]?.interest ?? 0
              return (
                <button
                  key={r.id}
                  onClick={() => {
                    setInvitedIds(prev =>
                      isInvited ? prev.filter(x => x !== r.id) : [...prev, r.id],
                    )
                  }}
                  className={'w-full flex items-center justify-between p-1.5 text-xs rounded ' +
                    (isInvited ? 'bg-pnw-cream' : 'hover:bg-gray-50')
                  }
                >
                  <span>
                    {isInvited && ' '}
                    {r.firstName} {r.lastName} ({r.primaryPosition}, {r.hometown.state})
                  </span>
                  <span className="text-gray-500">Interest {interest}</span>
                </button>
              )
            })}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 border rounded text-sm">Cancel</button>
          <button
            onClick={() => onConfirm(fee, invitedIds)}
            disabled={isBelowMin}
            className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            Hold Camp
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Fundraise modal ─────────────────────────────────────────────────────────

function FundraiseModal({ ap, onChangeAP, maxAP, coach, programHistory, onConfirm, onClose }) {
  const motivatorMult = 0.7 + (coach.motivator / 100) * 0.9
  const historyMult = 0.7 + (programHistory / 100) * 0.9
  const estimated = Math.round(ap * 800 * motivatorMult * historyMult)
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-md w-full p-6">
        <div className="flex justify-between items-start mb-3">
          <h3 className="text-xl font-bold text-pnw-slate">Fundraise</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"></button>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          Spend AP on donor + alumni outreach. Money goes directly to your budget.
        </p>
        <div className="mb-4">
          <label className="text-xs uppercase tracking-wider text-gray-500">AP to spend</label>
          <div className="flex items-center gap-3 mt-1">
            <input type="range" min={1} max={Math.max(1, maxAP)} step={1} value={Math.min(ap, maxAP)} onChange={e => onChangeAP(parseInt(e.target.value, 10))} className="flex-1" />
            <span className="font-mono font-bold text-pnw-green w-16 text-right">{ap} AP</span>
          </div>
          <div className="text-sm text-gray-700 mt-2">
            Estimated raise: <span className="font-bold text-pnw-green">${(estimated / 1000).toFixed(1)}K</span>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 border rounded text-sm">Cancel</button>
          <button onClick={onConfirm} disabled={ap > maxAP} className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold disabled:bg-gray-300">Fundraise</button>
        </div>
      </div>
    </div>
  )
}

// ── Recruit modal ───────────────────────────────────────────────────────────

function RecruitModal({ recruit, save, onAction, onOffer, onWithdraw, onClose }) {
  const grade = recruit.scoutGrades[save.userSchoolId] || { noise: 15, interest: 0, revealedPreferences: [], actionsApplied: [], apSpent: 0 }
  const hasLiveOffer = recruit.liveOffer?.schoolId === save.userSchoolId
  const [offerAmount, setOfferAmount] = useState(recruit.liveOffer?.amount ?? 5000)
  const totalSuit = totalSuitors(recruit)

  // GATE: no ratings info shown until you've taken ANY scouting action on
  // this recruit. Identity (name, position, pool, hometown, bats/throws)
  // is always visible — that's the "scouting report says exists" baseline.
  // Anything that costs AP gates the data.
  const hasScoutedAtAll = (grade.apSpent || 0) > 0 || (grade.actionsApplied || []).filter(k => k !== 'REGION_SEED').length > 0

  const noisyRatings = useMemo(() => {
    const rng = makeRng('view', recruit.id, save.userSchoolId, save.calendar.year, grade.noise)
    return estimateRecruitRatings(recruit, save.userSchoolId, rng)
  }, [recruit.id, grade.noise, save.calendar.year])

  // Visible stat ranges — noise is the ±3σ band, so half-width = noise / 2
  // gives a "likely range." As you scout, noise shrinks range narrows.
  function ratingRange(v) {
    const half = Math.max(1, Math.round(grade.noise / 2))
    return { lo: Math.max(20, v - half), hi: Math.min(99, v + half) }
  }
  const estOvrPoint = Math.round(
    Object.values(noisyRatings.ratings).reduce((s, n) => s + n, 0) / Object.keys(noisyRatings.ratings).length
  )
  const estOvrRange = ratingRange(estOvrPoint)
  // Est POT range — wider noise band than current (potential is harder to read)
  const potBlock = recruit.isPitcher ? recruit.truePotentialPitcher : recruit.truePotentialHitter
  const truePotAvg = potBlock
    ? Math.round(Object.values(potBlock).reduce((a, b) => a + b, 0) / Object.keys(potBlock).length)
    : null
  const potHalf = Math.max(1, Math.round(grade.noise * 1.2))
  const estPotRange = truePotAvg == null ? null : {
    lo: Math.max(20, truePotAvg - potHalf),
    hi: Math.min(99, truePotAvg + potHalf),
  }
  const archetype = getArchetype(recruit.archetypeKey)
  const visibleQuirks = (recruit.visibleQuirks || []).map(getQuirk).filter(Boolean)
  const m = recruit.measurables || {}

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6">
        <div className="flex justify-between items-start mb-3">
          <div>
            <h3 className="text-xl font-bold text-pnw-slate">{recruit.firstName} {recruit.lastName}</h3>
            <p className="text-sm text-gray-600">
              {recruit.primaryPosition} • {POOL_LABELS[recruit.pool]} • {recruit.hometown.state} • {recruit.bats}/{recruit.throws}
            </p>
            {recruit.previousSchoolName && (
              <p className="text-xs text-gray-500">From {recruit.previousSchoolName}</p>
            )}
            {/* Measurables strip — always public, no scout gate */}
            <div className="text-[11px] text-gray-600 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              {m.heightInches && <span><span className="text-gray-400">Ht:</span> <strong>{formatHeight(m.heightInches)}</strong></span>}
              {m.weightLbs && <span><span className="text-gray-400">Wt:</span> <strong>{m.weightLbs} lb</strong></span>}
              {m.fbVeloMph && <span><span className="text-gray-400">FB:</span> <strong>{m.fbVeloMinMph}–{m.fbVeloMaxMph} mph</strong></span>}
              {m.sixtyYardSec && <span><span className="text-gray-400">60:</span> <strong>{m.sixtyYardSec.toFixed(2)}s</strong></span>}
              {m.popTimeSec && <span><span className="text-gray-400">Pop:</span> <strong>{m.popTimeSec.toFixed(2)}s</strong></span>}
              {m.maxEvMph && <span><span className="text-gray-400">Max EV:</span> <strong>{m.maxEvMph} mph</strong></span>}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"></button>
        </div>

        {/* Pre-scout banner — until ANY scouting action is taken, no ratings,
            no GPA, no suitors. Just identity above + a call to scout. */}
        {!hasScoutedAtAll && (
          <div className="bg-amber-50 border-2 border-amber-300 rounded-lg p-4 mb-4 text-center">
            <div className="text-3xl mb-1"></div>
            <div className="text-sm font-bold text-amber-900">No scouting report yet</div>
            <div className="text-[11px] text-amber-800 mt-1 max-w-md mx-auto">
              You know who they are — that's it. Spend AP on a scouting action below
              (Text, Call, Scout Trip, etc.) to start revealing their ratings, suitors, GPA, and priorities.
            </div>
          </div>
        )}

        {hasScoutedAtAll && (
          <>
            <div className="grid grid-cols-6 gap-2 mb-3">
              <div className="bg-pnw-cream rounded p-2 text-center">
                <div className="text-[10px] uppercase tracking-wider text-gray-600">Interest</div>
                <div className="text-xl font-bold text-pnw-green">{grade.interest}</div>
              </div>
              <div className="bg-gray-50 rounded p-2 text-center">
                <div className="text-[10px] uppercase tracking-wider text-gray-600">Est OVR</div>
                <div className="text-base font-bold text-pnw-slate font-mono">{estOvrRange.lo}–{estOvrRange.hi}</div>
              </div>
              <div className="bg-gray-50 rounded p-2 text-center">
                <div className="text-[10px] uppercase tracking-wider text-gray-600">Est POT</div>
                <div className="text-base font-bold text-pnw-green font-mono">
                  {estPotRange ? `${estPotRange.lo}–${estPotRange.hi}` : '—'}
                </div>
              </div>
              <div className="bg-gray-50 rounded p-2 text-center">
                <div className="text-[10px] uppercase tracking-wider text-gray-600">Scout fog</div>
                <div className="text-xl font-bold text-gray-700">±{grade.noise}</div>
              </div>
              <div className="bg-gray-50 rounded p-2 text-center">
                <div className="text-[10px] uppercase tracking-wider text-gray-600">GPA</div>
                <div className="text-xl font-bold text-gray-700">{academicRatingToGpa(recruit.academicRating).toFixed(1)}</div>
              </div>
              <div className="bg-gray-50 rounded p-2 text-center">
                <div className="text-[10px] uppercase tracking-wider text-gray-600">Suitors</div>
                <div className="text-sm font-bold text-gray-700">
                  {recruit.suitorsRevealed ? totalSuit : '?'}
                </div>
              </div>
            </div>
            {/* Archetype + visible quirks — player's profile, set at generation */}
            {archetype && (
              <div className="bg-pnw-cream/40 rounded p-2 mb-3 border border-pnw-green/20">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-[10px] uppercase tracking-wider text-pnw-green font-bold">Profile:</span>
                  <span className="text-sm font-bold text-pnw-slate">{archetype.label}</span>
                  <span className="text-[11px] text-gray-600 italic">{archetype.blurb}</span>
                </div>
                {visibleQuirks.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {visibleQuirks.map(q => (
                      <span key={q.key} className="text-[10px] font-semibold bg-white text-pnw-slate px-1.5 py-0.5 rounded border border-gray-200" title={q.label}>
                        {q.bias && Object.values(q.bias).some(v => v < 0) ? ' ' : ' '}{q.label}
                      </span>
                    ))}
                  </div>
                )}
                {recruit.hiddenQuirks?.length > 0 && (
                  <div className="text-[10px] text-gray-500 italic mt-1">
                    + {recruit.hiddenQuirks.length} hidden trait{recruit.hiddenQuirks.length === 1 ? '' : 's'} not yet revealed.
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Suitor info: vague pre-scouted, exact after — and hidden entirely
            until ANY scouting action has been taken. */}
        {hasScoutedAtAll && (
        <div className="bg-amber-50 border border-amber-200 rounded p-2 mb-4 text-xs text-amber-900">
          {recruit.suitorsRevealed ? (
            <>
              <strong>Other interested programs:</strong>
              {recruit.suitors.d1 > 0 && <span> {recruit.suitors.d1} D1</span>}
              {recruit.suitors.topNaia > 0 && <span> • {recruit.suitors.topNaia} top NAIA</span>}
              {recruit.suitors.otherNaia > 0 && <span> • {recruit.suitors.otherNaia} NAIA</span>}
              {recruit.suitors.d2d3 > 0 && <span> • {recruit.suitors.d2d3} D2/D3</span>}
              <div className="text-[10px] text-amber-700 mt-1">
                {totalSuit >= 6 ? 'Heavily recruited — will take longer to commit.' :
                  totalSuit >= 3 ? 'Several suitors — strong offer recommended.' :
                  'Few suitors — fair offer should be enough.'}
              </div>
            </>
          ) : (
            <>
              <strong>Recruiting interest:</strong>{' '}
              <em>{visibleSuitors(recruit).label}</em>
              <div className="text-[10px] text-amber-700 mt-1">
                Take a Scout Trip, Home Visit, or invite to Camp to learn who else is recruiting them.
              </div>
            </>
          )}
        </div>
        )}

        {/* Academic scholarship preview */}
        {hasScoutedAtAll && (() => {
          const school = save.schools[save.userSchoolId]
          const gpa = academicRatingToGpa(recruit.academicRating)
          const academic$ = academicScholarship(recruit, school)
          const pct = school.tuitionPerYear > 0 ? academic$ / school.tuitionPerYear : 0
          if (academic$ <= 0) {
            return (
              <div className="bg-gray-50 border border-gray-200 rounded p-2 mb-4 text-xs text-gray-600">
                <strong> Academics:</strong> GPA {gpa.toFixed(2)} — doesn't qualify for academic aid at this school (need 2.0+).
              </div>
            )
          }
          return (
            <div className="bg-blue-50 border border-blue-200 rounded p-2 mb-4 text-xs text-blue-900">
              <strong> Academic scholarship:</strong> GPA {gpa.toFixed(2)} {(pct * 100).toFixed(0)}% of tuition = <span className="font-mono font-bold">${(academic$ / 1000).toFixed(1)}K/yr</span>.
              Funded by the academic department — does NOT come out of your athletic scholarship pool.
            </div>
          )
        })()}

        {/* Live offer editor */}
        <div className="bg-white border border-gray-200 rounded p-3 mb-4">
          <div className="flex justify-between items-center mb-2">
            <div className="text-xs uppercase tracking-wider text-gray-500">Scholarship Offer</div>
            {hasLiveOffer && <span className="text-[10px] text-green-700 font-bold">LIVE OFFER ACTIVE</span>}
          </div>
          {hasLiveOffer && (
            <div className="text-sm text-gray-700 mb-2">
              Current offer: <span className="font-bold font-mono text-pnw-green">${(recruit.liveOffer.amount / 1000).toFixed(1)}K</span>
              {' '}• {recruit.liveOffer.changes} change{recruit.liveOffer.changes === 1 ? '' : 's'}
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">$</span>
            <input
              type="range"
              min={1000} max={25000} step={500}
              value={offerAmount}
              onChange={e => setOfferAmount(parseInt(e.target.value, 10))}
              className="flex-1"
            />
            <span className="font-mono font-bold text-pnw-green w-16 text-right">${(offerAmount / 1000).toFixed(1)}K</span>
          </div>
          <div className="text-[10px] text-gray-500 mt-1">
            Bushnell avg scholarship: <strong>$5K/player</strong>. Anything above $5K is above-average for the program. First offer is free; modifications cost 1 AP.
          </div>
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => onOffer(recruit, offerAmount)}
              className="flex-1 px-3 py-1.5 bg-pnw-green text-white rounded text-xs font-semibold hover:opacity-90"
            >
              {hasLiveOffer ? 'Update Offer (1 AP)' : 'Submit Offer'}
            </button>
            {hasLiveOffer && (
              <button
                onClick={() => onWithdraw(recruit)}
                className="px-3 py-1.5 border border-red-300 text-red-700 rounded text-xs hover:bg-red-50"
              >
                Withdraw
              </button>
            )}
          </div>
        </div>

        {hasScoutedAtAll && (
          <div className="mb-4">
            <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Estimated ratings <span className="normal-case text-gray-400">— range based on scouting; narrows as you scout more.</span></div>
            <div className="grid grid-cols-4 gap-1 text-xs">
              {Object.entries(noisyRatings.ratings).map(([k, v]) => {
                const r = ratingRange(v)
                const isPoint = r.lo === r.hi
                return (
                  <div key={k} className="bg-gray-50 rounded p-2">
                    <div className="text-[10px] text-gray-500 uppercase">{prettyLabel(k)}</div>
                    <div className="font-mono font-bold text-pnw-slate">
                      {isPoint ? v : `${r.lo}–${r.hi}`}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="mb-4">
          <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Revealed priorities</div>
          {grade.revealedPreferences.length === 0 ? (
            <p className="text-xs text-gray-400">No priorities revealed yet. Try a Home Visit or Campus Visit.</p>
          ) : (
            <div className="space-y-1">
              {grade.revealedPreferences.map(p => (
                <div key={p} className="flex items-center gap-2 text-xs">
                  <span className="inline-block bg-amber-100 text-amber-900 px-2 py-0.5 rounded">{PREFERENCE_LABELS[p]}</span>
                  <span className="text-gray-500">weight: {recruit.preferences[p]}/10</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mb-3">
          <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Take an action</div>
          <p className="text-[11px] text-gray-500 mb-2">
            One use per action per recruit. ~10 AP total fully scouts them.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {Object.values(ACTION_TYPES).filter(a => a.key !== 'SCHOLARSHIP_OFFER').map(action => {
              const alreadyUsed = (grade.actionsApplied || []).includes(action.key)
              const cantAfford = save.ap.currentWeek < action.apCost
              return (
                <button
                  key={action.key}
                  onClick={() => onAction(recruit, action.key)}
                  disabled={alreadyUsed || cantAfford}
                  className="text-left p-3 border border-gray-200 rounded hover:border-pnw-green hover:bg-pnw-cream disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <div className="flex justify-between items-center">
                    <span className="font-semibold text-sm">
                      {action.label} {alreadyUsed && <span className="text-[10px] text-green-700 ml-1">(done)</span>}
                    </span>
                    <span className={'text-xs font-mono px-1.5 py-0.5 rounded ' +
                      (alreadyUsed ? 'bg-gray-300 text-gray-600' : 'bg-pnw-green text-white')}>
                      {alreadyUsed ? 'used' : `${action.apCost} AP`}
                    </span>
                  </div>
                  <div className="text-[10px] text-gray-500 mt-1">{action.blurb}</div>
                </button>
              )
            })}
          </div>
        </div>

        <div className="mt-3 text-[10px] text-gray-400">
          Actions taken: {grade.actionsApplied.length} · AP spent: {grade.apSpent || 0}
          {(grade.apSpent || 0) >= 10 && <span className="ml-2 text-green-700 font-semibold"> Fully scouted</span>}
        </div>
      </div>
    </div>
  )
}

function Wk4Tutorial({ save, apBaseline }) {
  const currentAP = save.ap?.currentWeek ?? 0
  const spent = Math.max(0, apBaseline - currentAP)
  const pct = Math.min(100, Math.round((spent / Math.max(1, apBaseline)) * 100))
  const done = currentAP === 0
  // Use Tailwind classes (which my pixel-shell CSS remaps to bright
  // pastels on the dark theme) instead of hard-coded HEX inline styles
  // designed for cream backgrounds.
  return (
    <div className={'rounded-xl p-4 mb-4 border-2 ' +
      (done ? 'bg-green-50 border-green-300' : 'bg-amber-50 border-amber-300')}>
      <div className={'text-[11px] uppercase tracking-wider font-bold mb-1 ' +
        (done ? 'text-green-700' : 'text-amber-700')}>
        Week 4 — Open Scouting & Build Your Board
      </div>
      <div className={'text-sm leading-snug mb-2 ' + (done ? 'text-green-800' : 'text-amber-800')}>
        {done
          ? <> All AP spent. You\'ve built your initial recruiting board for next year\'s class.
              Head to the dashboard to advance to Wk 5 (Fall Camp opens).</>
          : <>This is your <strong>first scouting week</strong>. You must spend every AP on
              recruiting actions — add recruits to your board, run scouting trips, send introductory
              outreach. The class you\'re building is for <strong>next year's enrollment</strong>.
              Action buttons appear on each recruit card; clicking them costs AP.</>}
      </div>
      <div className="flex items-center gap-3 text-xs">
        <div className="flex-1 bg-white rounded-full h-2 overflow-hidden">
          <div
            className={done ? 'h-2 bg-green-600' : 'h-2 bg-amber-500'}
            style={{ width: `${pct}%`, transition: 'width 200ms' }}
          />
        </div>
        <div className={'font-mono whitespace-nowrap ' + (done ? 'text-green-700' : 'text-amber-700')}>
          {spent} / {apBaseline} AP spent
        </div>
      </div>
    </div>
  )
}
