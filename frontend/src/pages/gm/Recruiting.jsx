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
  getTopPriorities, priorityFitScores, buildRecruitFeedback,
} from '../../gm/engine/recruits'
import { annualNilPoolForSchool, nilOfferCapForSchool, totalNilCommitted, formatNil } from '../../gm/engine/nil'
import { makeRng } from '../../gm/engine/rng'
import { scholarshipSnapshot } from '../../gm/engine/scholarshipAccounting'
import { REGIONS, REGION_LABELS, STATE_TO_REGION } from '../../gm/engine/regions'
import { prettyLabel } from '../../gm/engine/format'
import TeamLogo from '../../gm/components/TeamLogo'
import { getArchetype, getQuirk, formatHeight } from '../../gm/engine/playerArchetypes'
import GMShell, { ContextBox, ModalCloseButton, useModalDismiss, gmToast } from '../../gm/components/GMShell'

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

// Plain-English explanation of how each priority gets evaluated against your
// program. Shown in a tooltip next to the priority chip.
const PREFERENCE_EXPLANATIONS = {
  financial:       'Scored on your scholarship offer + NIL vs the level-adjusted market rate. Bigger offers + NIL stack here.',
  proximity:       'Distance from the recruit\'s home town to your campus. Same state = full score, far away = penalty.',
  playing_time:    'Path to the lineup at the recruit\'s position. Scored on roster QUALITY (player overalls), not just headcount — a 90-OVR recruit looking at a 60-OVR starter sees an open path; the same starter blocks a 60-OVR recruit. Three weak guys blocking aren\'t as bad as one elite returner.',
  program_history: 'Your live NATIONAL RANKING (60% weight) blended with the school\'s legacy program reputation (40%). #1 national = elite, top-25 = strong, outside top-100 = soft. Climbing the rankings during the season is the fastest way to land "wants to win" recruits.',
  facilities:      'Driven by your Facilities + S&C budget tier. Higher allocation = higher score.',
  academics:       'Your school\'s academic profile (50%) blended with your live TEAM GPA vs the league average around 3.0 (50%). A 3.5+ team GPA reads as an elite academics program; a 2.6 team GPA scares academics-first recruits even at a strong school. Run Study Hall + Tutoring during the term to lift this.',
  coaching:        'Your head coach\'s Developer rating. Top developers attract development-minded recruits.',
  pipeline_fit:    'Whether the recruit\'s home region is in your head coach\'s primary or secondary region.',
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

  const signedRecruits = Object.values(recruits).filter(r => r.signedTo === save.userSchoolId)
  const liveOffers = Object.values(recruits).filter(r =>
    r.liveOffer && r.liveOffer.schoolId === save.userSchoolId && r.status !== 'signed' && r.status !== 'lost',
  )
  const totalOffered = liveOffers.reduce((s, r) => s + (r.liveOffer?.amount || 0), 0)

  function handleAction(recruit, actionKey) {
    const action = ACTION_TYPES[actionKey]
    if (!action) return
    if (save.ap.currentWeek < action.apCost) {
      gmToast(`Not enough AP. Need ${action.apCost}, have ${save.ap.currentWeek}.`, 'warn')
      return
    }
    // Per-recruit AP cap: a coach can't dump 30 AP on one prospect in a week.
    // Cap at 10 AP/recruit/week so users have to spread effort across the
    // board. (Total across all prospects is still gated by the weekly AP
    // pool.) Tag the count with year+week so it auto-resets each new week.
    const PER_RECRUIT_AP_CAP = 10
    const currentWeekTag = `${save.calendar.year}_${save.calendar.weekOfYear}`
    const g = recruit.scoutGrades?.[save.userSchoolId]
    const alreadySpent = (g && g.apSpentWeekTag === currentWeekTag)
      ? (g.apSpentThisWeek || 0)
      : 0
    if (alreadySpent + action.apCost > PER_RECRUIT_AP_CAP) {
      gmToast(`You've spent ${alreadySpent} AP on ${recruit.firstName} ${recruit.lastName} this week. Cap is ${PER_RECRUIT_AP_CAP}/recruit per week — work other prospects.`, 'warn')
      return
    }
    const rng = makeRng('action', recruit.id, save.userSchoolId, Date.now())
    const result = applyRecruitingAction(recruit, save.userSchoolId, action, rng)
    // Track per-recruit per-week AP — reset if tag from a previous week,
    // then accumulate.
    const grade = result.recruit.scoutGrades[save.userSchoolId]
    if (grade) {
      if (grade.apSpentWeekTag !== currentWeekTag) {
        grade.apSpentThisWeek = 0
        grade.apSpentWeekTag = currentWeekTag
      }
      grade.apSpentThisWeek = (grade.apSpentThisWeek || 0) + action.apCost
    }
    save.recruits[recruit.id] = result.recruit
    save.ap.currentWeek -= action.apCost
    save.ap.spentThisWeek += action.apCost
    save.ap.spentByCategory.recruiting = (save.ap.spentByCategory.recruiting || 0) + action.apCost
    saveDynasty(save)
    setSave({ ...save })
    if (result.revealed) {
      const label = PREFERENCE_LABELS[result.revealed]
      const top3 = getTopPriorities(recruit)
      const inTop3 = top3.includes(result.revealed)
      gmToast(
        `${recruit.firstName} ${recruit.lastName} cares about: "${label}"` +
        (inTop3 ? ` — TOP 3 priority.` : ` — not top 3.`),
        inTop3 ? 'success' : 'info',
      )
    }
  }

  function handleOffer(recruit, amount, nilAmount = 0) {
    const existing = save.recruits[recruit.id].liveOffer
    const isModification = existing && existing.schoolId === save.userSchoolId
    if (isModification) {
      // Modifications cost 1 AP
      if (save.ap.currentWeek < 1) {
        gmToast('Modifying an offer costs 1 AP. You don\'t have any left this week.', 'warn')
        return
      }
      save.ap.currentWeek -= 1
      save.ap.spentThisWeek += 1
      save.ap.spentByCategory.recruiting = (save.ap.spentByCategory.recruiting || 0) + 1
    }
    // First offer is free; modifications charged above
    setLiveOffer(save.recruits[recruit.id], save.userSchoolId, amount, nilAmount)
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

  return (
    <GMShell schoolName={userSchool?.name} schoolColors={userSchool?.colors}>
    <div className="max-w-6xl mx-auto">
      {isWk4Tutorial && (
        <Wk4Tutorial save={save} apBaseline={apBaseline} />
      )}

      <div className="mb-6 flex flex-col sm:flex-row sm:justify-between sm:items-start gap-3">
        <div className="min-w-0">
          <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">Dashboard</Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-pnw-slate mt-1">Recruiting Board</h1>
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
        <div className="text-left sm:text-right shrink-0">
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
          <li><strong>The recruit decides</strong>. Each recruit has 3 main priorities (revealed via Home Visit / Campus Visit). If your school satisfies their top 3 + the offer is fair, they commit fast. Miss their priorities and they shop around.</li>
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
        {(() => {
          // NWAC is the only true HS-only level. D3 gets the full slate
          // of pools but each is smaller (no athletic $ → fewer JUCO/portal
          // kids ever land at a D3).
          const level = save.level || 'NAIA'
          const hsOnly = level === 'NWAC'
          const tabs = hsOnly
            ? [{ key: 'ALL', label: 'All' }, { key: 'HS_SR', label: 'HS' }]
            : [
                { key: 'ALL',    label: 'All' },
                { key: 'HS_SR',  label: 'HS' },
                { key: 'JUCO',   label: 'JUCO' },
                { key: 'PORTAL', label: 'Transfer Portal', requiresPortal: true },
              ]
          return tabs.map(t => {
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
          })
        })()}
        {save.level === 'NWAC' && (
          <span className="text-[10px] text-amber-700 ml-2 italic">
            NWAC = JUCO. HS recruits only.
          </span>
        )}
        {save.level === 'D3' && (
          <span className="text-[10px] text-amber-700 ml-2 italic">
            D3 = no athletic $. JUCO/portal kids RARE — most want a paid offer elsewhere.
          </span>
        )}
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

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
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
/**
 * "What the recruit is thinking" panel. Renders the offer reaction quote +
 * the commit-proximity progress bar + the commit-price reveal (if fully
 * scouted). Powered by `buildRecruitFeedback` in engine/recruits.js.
 */
function RecruitFeedbackPanel({ feedback: fb }) {
  if (!fb || !fb.hasOffer) return null

  // Offer reaction styling
  const reactionStyle = {
    INSULTED:    { color: 'bg-red-100 border-red-300 text-red-900', label: 'Insulted' },
    LOWBALL:     { color: 'bg-orange-100 border-orange-300 text-orange-900', label: 'Underwhelmed' },
    FAIR:        { color: 'bg-amber-100 border-amber-300 text-amber-900', label: 'Fair' },
    STRONG:      { color: 'bg-emerald-100 border-emerald-300 text-emerald-900', label: 'Impressed' },
    BLOWN_AWAY:  { color: 'bg-emerald-200 border-emerald-400 text-emerald-900', label: 'Blown away' },
  }[fb.offerReaction] || { color: 'bg-gray-100 border-gray-300 text-gray-900', label: '—' }

  // Commit proximity bar — 5 buckets, 20% each
  const PROX_ORDER = ['COLD', 'WARMING', 'WARM', 'LEANING_YOU', 'READY_TO_SIGN']
  const PROX_LABELS = {
    COLD: 'Cold',
    WARMING: 'Warming up',
    WARM: 'In the mix',
    LEANING_YOU: 'Leaning you',
    READY_TO_SIGN: 'Ready to commit',
  }
  const proxIdx = PROX_ORDER.indexOf(fb.commitProximity)
  const proxPct = ((proxIdx + 1) / PROX_ORDER.length) * 100
  const proxColor = proxIdx >= 4 ? 'bg-emerald-500'
    : proxIdx >= 3 ? 'bg-lime-500'
    : proxIdx >= 2 ? 'bg-amber-400'
    : proxIdx >= 1 ? 'bg-orange-400'
    : 'bg-red-400'

  return (
    <div className="bg-pnw-cream/30 border border-pnw-green/30 rounded-lg p-3 mb-4">
      <div className="text-[10px] uppercase tracking-wider text-pnw-green font-bold mb-2">
        What the recruit is thinking
      </div>

      {/* Offer reaction */}
      <div className={'rounded border-2 p-2 mb-2 ' + reactionStyle.color}>
        <div className="flex justify-between items-baseline">
          <span className="font-semibold text-xs uppercase tracking-wider">Offer reaction</span>
          <span className="text-[10px] font-bold uppercase">{reactionStyle.label}</span>
        </div>
        <div className="italic text-sm mt-0.5">{fb.offerReactionLine}</div>
      </div>

      {/* Commit proximity */}
      <div className="mb-2">
        <div className="flex justify-between items-baseline">
          <span className="font-semibold text-xs uppercase tracking-wider text-pnw-slate">Commit proximity</span>
          <span className="text-[11px] font-semibold text-pnw-slate">{PROX_LABELS[fb.commitProximity]}</span>
        </div>
        <div className="h-2.5 bg-gray-200 rounded-full mt-1 overflow-hidden">
          <div className={'h-full ' + proxColor} style={{ width: `${proxPct}%` }} />
        </div>
        <div className="italic text-xs text-gray-700 mt-1">{fb.commitLine}</div>
      </div>

      {/* Commit price */}
      {(fb.commitPrice != null || fb.commitPriceNote) && (
        <div className="bg-white rounded border border-pnw-green/30 p-2">
          <div className="text-[10px] uppercase tracking-wider text-pnw-green font-bold">
            Commit price (scout-revealed)
          </div>
          {fb.commitPrice != null && (
            <div className="text-base font-mono font-bold text-pnw-green mt-0.5">
              ${(fb.commitPrice / 1000).toFixed(1)}K/yr
              {fb.commitPriceNote && (
                <span className="text-[11px] text-gray-600 font-normal ml-2">{fb.commitPriceNote}</span>
              )}
            </div>
          )}
          {fb.commitPrice == null && fb.commitPriceNote && (
            <div className="text-[11px] text-gray-700 mt-0.5 italic">{fb.commitPriceNote}</div>
          )}
        </div>
      )}
    </div>
  )
}

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

function RecruitRow({ recruit, save, interest, noise, expanded, onToggleExpand, onOpenModal, onToggleFollow }) {
  const isSigned = recruit.signedTo === save.userSchoolId
  const hasLiveOffer = recruit.liveOffer?.schoolId === save.userSchoolId
  const apSpent = recruit.scoutGrades?.[save.userSchoolId]?.apSpent || 0
  const scoutedAtAll = apSpent >= 2
  const fullyScouted = isFullyScouted(recruit, save.userSchoolId)
  const src = SOURCE_CHIP[recruit.pool] || SOURCE_CHIP.HS_SR
  const archetype = getArchetype(recruit.archetypeKey)
  const m = recruit.measurables || {}

  // Compute Est OVR + Est POT ranges. Always-visible 30-pt hint. As AP is
  // spent, `noise` drops and the range narrows. CRITICAL: when the true
  // value sits near the 20 or 99 boundary, naïve clamping shrinks the
  // displayed band (e.g. true 96 with ±15 → 81-99 = 18 wide, not 30) which
  // GIVES AWAY that the player is a stud before scouting. Use
  // shiftedRange() to preserve the band's width by extending the unclamped
  // side instead.
  function shiftedRange(trueVal, half) {
    const minWidth = half * 2
    let lo = trueVal - half
    let hi = trueVal + half
    if (lo < 20) { hi = Math.min(99, 20 + minWidth); lo = 20 }
    else if (hi > 99) { lo = Math.max(20, 99 - minWidth); hi = 99 }
    return { lo, hi }
  }
  function ovrRange() {
    const block = recruit.isPitcher ? recruit.truePitcher : recruit.trueHitter
    if (!block) return { lo: null, hi: null }
    const trueOvr = Math.round(Object.values(block).reduce((a, b) => a + b, 0) / Object.keys(block).length)
    return shiftedRange(trueOvr, noise)   // default noise 15 → 30-pt band
  }
  function potRange() {
    const block = recruit.isPitcher ? recruit.truePotentialPitcher : recruit.truePotentialHitter
    if (!block) return { lo: null, hi: null }
    const truePot = Math.round(Object.values(block).reduce((a, b) => a + b, 0) / Object.keys(block).length)
    return shiftedRange(truePot, noise)
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

function RecruitExpansion({ recruit, save, scoutedAtAll, archetype, measurables, onOpenModal }) {
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
          className="w-full px-2 py-1.5 bg-pnw-green text-white rounded text-xs font-semibold hover:opacity-90"
        >
          Open full recruit panel
        </button>
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

// ── Fundraise modal ─────────────────────────────────────────────────────────

function FundraiseModal({ ap, onChangeAP, maxAP, coach, programHistory, onConfirm, onClose }) {
  const { backdropProps, stopProps } = useModalDismiss(onClose)
  const motivatorMult = 0.7 + (coach.motivator / 100) * 0.9
  const historyMult = 0.7 + (programHistory / 100) * 0.9
  const estimated = Math.round(ap * 800 * motivatorMult * historyMult)
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" {...backdropProps}>
      <div className="bg-white rounded-xl max-w-md w-full p-6" {...stopProps}>
        <div className="flex justify-between items-start gap-3 mb-3">
          <h3 className="text-xl font-bold text-pnw-slate">Fundraise</h3>
          <ModalCloseButton onClick={onClose} />
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
  const { backdropProps, stopProps } = useModalDismiss(onClose)
  const grade = recruit.scoutGrades[save.userSchoolId] || { noise: 15, interest: 0, revealedPreferences: [], actionsApplied: [], apSpent: 0 }
  const isSignedToUs = recruit.status === 'signed' && recruit.signedTo === save.userSchoolId
  const hasLiveOffer = recruit.liveOffer?.schoolId === save.userSchoolId
  const [offerAmount, setOfferAmount] = useState(recruit.liveOffer?.amount ?? 5000)
  const [nilOffer, setNilOffer] = useState(recruit.liveOffer?.nilAmount ?? 0)
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

  // Visible stat ranges — half-width = noise (at default noise 15 that's a
  // 30-point spread). As you spend AP, noise drops and the range narrows.
  // Uses shifted clamping so a recruit near 99 doesn't get a tell-tale
  // narrow band (e.g. 92 ±15 would clamp to 77-99 = 22 wide; shifted to
  // preserve width gives 70-99 = 30 wide and hides the upside).
  function ratingRange(v) {
    const half = Math.max(1, grade.noise)
    const minWidth = half * 2
    let lo = v - half
    let hi = v + half
    if (lo < 20) { hi = Math.min(99, 20 + minWidth); lo = 20 }
    else if (hi > 99) { lo = Math.max(20, 99 - minWidth); hi = 99 }
    return { lo, hi }
  }
  // Compute Est OVR from the TRUE rating (not the noisy view) so the range
  // is centered on the right value. The displayed range hides the truth via
  // its width; we don't need to add per-render noise on top.
  const trueBlock = recruit.isPitcher ? recruit.truePitcher : recruit.trueHitter
  const trueOvrAvg = trueBlock
    ? Math.round(Object.values(trueBlock).reduce((a, b) => a + b, 0) / Object.keys(trueBlock).length)
    : 0
  const estOvrRange = ratingRange(trueOvrAvg)
  // Est POT range — same 30-point spread.
  const potBlock = recruit.isPitcher ? recruit.truePotentialPitcher : recruit.truePotentialHitter
  const truePotAvg = potBlock
    ? Math.round(Object.values(potBlock).reduce((a, b) => a + b, 0) / Object.keys(potBlock).length)
    : null
  const estPotRange = truePotAvg == null ? null : ratingRange(truePotAvg)
  const archetype = getArchetype(recruit.archetypeKey)
  const visibleQuirks = (recruit.visibleQuirks || []).map(getQuirk).filter(Boolean)
  const m = recruit.measurables || {}

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" {...backdropProps}>
      <div className="bg-white rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6" {...stopProps}>
        <div className="flex justify-between items-start gap-3 mb-3 sticky -top-6 -mt-6 pt-6 -mx-6 px-6 pb-3 bg-white z-10">
          <div className="min-w-0">
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
          <ModalCloseButton onClick={onClose} />
        </div>

        {/* Est OVR + POT ranges show ALWAYS — even before any scouting — as a
            ~30-pt hint at the player's true value. The rest (interest, GPA,
            suitors, archetype) stays gated behind first scouting action. */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3">
          <div className={'rounded p-2 text-center ' + (hasScoutedAtAll ? 'bg-pnw-cream' : 'bg-gray-100')}>
            <div className="text-[10px] uppercase tracking-wider text-gray-600">Interest</div>
            <div className="text-xl font-bold text-pnw-green">
              {hasScoutedAtAll ? grade.interest : <span className="text-gray-400">?</span>}
            </div>
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
            <div className="text-xl font-bold text-gray-700">
              {hasScoutedAtAll ? academicRatingToGpa(recruit.academicRating).toFixed(1) : <span className="text-gray-400">?</span>}
            </div>
          </div>
          <div className="bg-gray-50 rounded p-2 text-center">
            <div className="text-[10px] uppercase tracking-wider text-gray-600">Suitors</div>
            <div className="text-sm font-bold text-gray-700">
              {hasScoutedAtAll && recruit.suitorsRevealed ? totalSuit : '?'}
            </div>
          </div>
        </div>

        {/* Pre-scout banner — once OVR/POT are visible, this is just a
            reminder that the rest is gated. */}
        {!hasScoutedAtAll && (
          <div className="bg-amber-50 border-2 border-amber-300 rounded-lg p-3 mb-4 text-center">
            <div className="text-sm font-bold text-amber-900">Est OVR + POT are loose 30-pt hints.</div>
            <div className="text-[11px] text-amber-800 mt-1 max-w-md mx-auto">
              Spend AP on a scouting action below (Text, Call, Scout Trip, etc.) to narrow the bands
              and reveal Interest, GPA, suitors, archetype, and priorities.
            </div>
          </div>
        )}

        {hasScoutedAtAll && (
          <>
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
            until ANY scouting action has been taken. PNW rivals shown by
            NAME (extra stakes when an in-region rival is also chasing). */}
        {hasScoutedAtAll && (() => {
          // PNW rivals — any school in state.schools that appears on the
          // recruit's interestedSchools list and isn't the user. These are
          // PNW programs in the user's level (state.schools is the PNW
          // roster for that level). Show by name so the user can feel the
          // in-region competition heat.
          const pnwRivals = (recruit.interestedSchools || [])
            .filter(id => id !== save.userSchoolId && save.schools[id])
            .map(id => save.schools[id])
          return (
        <div className="bg-amber-50 border border-amber-200 rounded p-2 mb-4 text-xs text-amber-900">
          {recruit.suitorsRevealed ? (
            <>
              {pnwRivals.length > 0 && (
                <div className="mb-2 pb-2 border-b border-amber-200">
                  <strong className="text-red-700">⚔ PNW rivals also recruiting:</strong>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {pnwRivals.map(s => (
                      <span
                        key={s.id}
                        className="inline-block px-2 py-0.5 rounded bg-white border font-semibold"
                        style={{ borderColor: s.colors?.primary || '#b91c1c', color: s.colors?.primary || '#b91c1c' }}
                      >
                        {s.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
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
                Take a Scout Trip or Home Visit to learn who else is recruiting them.
              </div>
            </>
          )}
        </div>
          )
        })()}

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
              Current: <span className="font-bold font-mono text-pnw-green">${(recruit.liveOffer.amount / 1000).toFixed(1)}K scholarship</span>
              {recruit.liveOffer.nilAmount > 0 && (
                <span className="ml-2 font-bold font-mono text-amber-700">+ {formatNil(recruit.liveOffer.nilAmount)} NIL</span>
              )}
              {' '}• {recruit.liveOffer.changes} change{recruit.liveOffer.changes === 1 ? '' : 's'}
            </div>
          )}
          {/* Scholarship slider — gated by level. D3 + NWAC = no athletic $ */}
          {(() => {
            const school = save.schools[save.userSchoolId]
            const pool = school?.scholarshipPool || 0
            const noScholarships = pool === 0
            if (noScholarships) {
              return (
                <div className="bg-gray-50 border border-gray-200 rounded p-2 text-[11px] text-gray-700">
                  <strong>No athletic scholarships</strong> at this level.{' '}
                  {save.level === 'D3'
                    ? 'D3 schools can\'t offer athletic aid — focus on academic fit + playing time.'
                    : save.level === 'NWAC'
                    ? 'NWAC tuition is low ($5-8K). Cost rarely drives commits at this level.'
                    : 'Athletic $ unavailable.'}
                </div>
              )
            }
            return (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">$</span>
                  <input
                    type="range"
                    min={1000} max={Math.max(25000, Math.round((school?.tuitionPerYear || 25000) / 1000) * 1000)} step={500}
                    value={offerAmount}
                    onChange={e => setOfferAmount(parseInt(e.target.value, 10))}
                    className="flex-1"
                  />
                  <span className="font-mono font-bold text-pnw-green w-16 text-right">${(offerAmount / 1000).toFixed(1)}K</span>
                </div>
                <div className="text-[10px] text-gray-500 mt-1">
                  School scholarship pool: <strong>${(pool / 1000).toFixed(0)}K/yr</strong>.
                  First offer is free; modifications cost 1 AP.
                </div>
              </>
            )
          })()}

          {/* NIL slider — D1 only */}
          {save.level === 'D1' && (() => {
            const school = save.schools[save.userSchoolId]
            const nilPool = annualNilPoolForSchool(school)
            const nilCap = nilOfferCapForSchool(school)
            const committed = totalNilCommitted(save) - (recruit.liveOffer?.nilAmount || 0)
            const remaining = Math.max(0, nilPool - committed)
            const maxThisOffer = Math.min(nilCap, remaining + (recruit.liveOffer?.nilAmount || 0))
            return (
              <div className="mt-3 bg-amber-50 border border-amber-200 rounded p-2">
                <div className="flex justify-between items-center mb-1">
                  <div className="text-xs uppercase tracking-wider text-amber-800 font-bold">NIL Offer (D1)</div>
                  <div className="text-[10px] text-amber-800">
                    Pool: <strong>{formatNil(nilPool)}</strong> · Remaining: <strong>{formatNil(remaining + (recruit.liveOffer?.nilAmount || 0))}</strong>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0} max={maxThisOffer} step={Math.max(500, Math.round(maxThisOffer / 100))}
                    value={Math.min(nilOffer, maxThisOffer)}
                    onChange={e => setNilOffer(parseInt(e.target.value, 10))}
                    className="flex-1"
                  />
                  <span className="font-mono font-bold text-amber-800 w-20 text-right">{formatNil(nilOffer)}</span>
                </div>
                <div className="text-[10px] text-amber-900 mt-1">
                  NIL is cash on top of scholarship — counts 1.5x for $-priority recruits. Per-recruit cap at this program: <strong>{formatNil(nilCap)}</strong>.
                </div>
              </div>
            )
          })()}

          <div className="flex gap-2 mt-3">
            <button
              onClick={() => onOffer(recruit, offerAmount, save.level === 'D1' ? nilOffer : 0)}
              className="flex-1 px-3 py-1.5 bg-pnw-green text-white rounded text-xs font-semibold hover:opacity-90"
              disabled={(save.schools[save.userSchoolId]?.scholarshipPool || 0) === 0 && nilOffer === 0}
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
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 text-xs">
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

        {/* If the recruit has already COMMITTED to us, show that instead of the
            live "still deciding" feedback (which would otherwise read as
            "insulted / cold" even though they signed). */}
        {isSignedToUs && (
          <div className="mb-4 bg-green-50 border-2 border-green-400 rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wider text-green-700 font-bold">Committed to you</div>
            <div className="text-sm text-green-900 mt-0.5">
              {recruit.firstName} {recruit.lastName} signed with your program
              {recruit.liveOffer?.amount ? <> at <strong>${(recruit.liveOffer.amount / 1000).toFixed(1)}K</strong></> : ' (roster offer)'}.
              They're locked in for next year's class.
            </div>
          </div>
        )}

        {/* Recruit reaction + commit proximity + commit price — only shown
            after a live offer is in AND they haven't committed yet. */}
        {hasLiveOffer && !isSignedToUs && (() => {
          const fb = buildRecruitFeedback(recruit, save.userSchoolId, save)
          return <RecruitFeedbackPanel feedback={fb} />
        })()}

        {/* Top 3 priorities — replaces the 0/10 weighted list. We show
            ONLY the three things the recruit actually cares about and how
            well your school satisfies each. Gated behind scouting actions:
            you have to reveal at least one priority via Home Visit or
            Campus Visit before any are shown. */}
        <div className="mb-4">
          <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Top 3 priorities</div>
          {grade.revealedPreferences.length === 0 ? (
            <p className="text-xs text-gray-400">
              Hidden. Take a Home Visit or Campus Visit to find out what this player cares about most.
            </p>
          ) : (() => {
            const top3 = getTopPriorities(recruit)
            const fb = buildRecruitFeedback(recruit, save.userSchoolId, save)
            return (
              <div className="space-y-1.5">
                {top3.map(key => {
                  const isRevealed = grade.revealedPreferences.includes(key)
                  const fit = fb.priorityScores[key] ?? 50
                  const fitColor = fit >= 70 ? 'bg-emerald-500' : fit >= 50 ? 'bg-amber-400' : 'bg-red-500'
                  const fitLabel = fit >= 70 ? 'Strong' : fit >= 50 ? 'OK' : 'Weak'
                  const explanation = PREFERENCE_EXPLANATIONS[key]
                  return (
                    <div key={key} className="flex items-center gap-2 text-sm">
                      <div className="w-44 cursor-help" title={isRevealed && explanation ? `${PREFERENCE_LABELS[key]} — ${explanation}` : 'Reveal more by spending AP on this recruit.'}>
                        {isRevealed ? (
                          <span className="inline-block bg-amber-100 text-amber-900 px-2 py-0.5 rounded font-semibold">
                            {PREFERENCE_LABELS[key]}
                            <span className="ml-1 text-[10px] opacity-70" aria-hidden="true">ⓘ</span>
                          </span>
                        ) : (
                          <span className="inline-block bg-gray-100 text-gray-500 px-2 py-0.5 rounded italic">
                            (hidden priority)
                          </span>
                        )}
                      </div>
                      <div
                        className="flex-1 h-2.5 bg-gray-200 rounded-full overflow-hidden cursor-help"
                        title={isRevealed && explanation ? `How we score it: ${explanation}` : ''}
                      >
                        <div className={'h-full ' + fitColor} style={{ width: `${fit}%` }} />
                      </div>
                      <div className="w-12 text-right font-mono text-xs text-gray-600">
                        {fitLabel}
                      </div>
                    </div>
                  )
                })}
                <div className="text-[10px] text-gray-500 mt-1.5">
                  Composite fit on the player's top 3 priorities:{' '}
                  <span className={'font-bold ' + (fb.topPriorityFit >= 70 ? 'text-emerald-600' : fb.topPriorityFit >= 50 ? 'text-amber-600' : 'text-red-600')}>
                    {fb.topPriorityFit}/100
                  </span>
                  {fb.topPriorityFit >= 70 && <span className="text-emerald-700"> — they'll commit much faster.</span>}
                  {fb.topPriorityFit < 35 && <span className="text-red-700"> — they're not seeing what they want here.</span>}
                </div>
              </div>
            )
          })()}
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
          ? <> All AP spent. You've built your initial recruiting board for next year's class.
              Head to the dashboard to advance to Wk 5 (Fall Camp opens).</>
          : <>This is your <strong>first scouting week</strong>. You must spend every AP on
              recruiting actions — add recruits to your board, run scouting trips, send introductory
              outreach. The class you're building is for <strong>next year's enrollment</strong>.
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
