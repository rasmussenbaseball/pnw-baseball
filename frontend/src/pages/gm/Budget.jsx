import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import {
  BUDGET_CATEGORIES,
  budgetCategoryEffects,
  extendedBudgetEffects,
  getBudgetGuidance,
  BUDGET_PRESETS,
  applyBudgetPreset,
  lockBudgetForYear,
  lockTravelAllocation,
} from '../../gm/engine/budget'
import { totalAnnualTravelCost } from '../../gm/engine/travel'
import { ensureUnifiedCalendar } from '../../gm/engine/gameYear'
import { optionalHireBoosts } from '../../gm/engine/coaches'
import GMShell from '../../gm/components/GMShell'
import nonNaiaRaw from '../../gm/data/non_naia_teams.json'

const NON_NAIA_DISPLAY = (() => {
  const out = {}
  for (const div of nonNaiaRaw.divisions) {
    for (const t of div.teams) out[t.id] = { ...t, division: div.id }
  }
  return out
})()

// Per-category metadata: friendly label + plain-English effect text.
const CATEGORIES = {
  scholarships: {
    label: 'Scholarships',
    blurb: 'Athletic aid pool — your scholarship $ for recruits and roster.',
    effect: 'More $ = win more recruiting battles + retain stars. Less = roster gets thinner.',
    icon: '',
  },
  coachingSalaries: {
    label: 'Coaching Salaries',
    blurb: 'HC + assistants. Pay determines who you can keep + hire.',
    effect: 'Locked to your actual payroll on the Coaches page.',
    icon: '',
    lockedFromHires: true,
  },
  travel: {
    label: 'Travel',
    blurb: 'Bus, flights, hotels for road games.',
    effect: 'Locked from your scheduled trips in Wk 3.',
    icon: '',
    lockedAlways: true,
  },
  equipment: {
    label: 'Equipment',
    blurb: 'Bats, gloves, balls, helmets, catcher gear.',
    effect: 'Cheaper gear = more in-game injuries. ±25% injury risk swing.',
    icon: '',
  },
  uniforms: {
    label: 'Uniforms',
    blurb: 'Game jerseys, alts, hats, travel polos.',
    effect: 'Tiny morale + recruiting-impression effect. Not worth obsessing over.',
    icon: '',
  },
  meals: {
    label: 'Meals & Nutrition',
    blurb: 'Training table + travel meals.',
    effect: 'Drives pitcher stamina + day-to-day durability. ±3 stamina pts.',
    icon: '',
  },
  facilities: {
    label: 'Facilities',
    blurb: 'Field, indoor cages, weight room maintenance.',
    effect: 'Offseason player development rate. ±20% on annual gains.',
    icon: '',
  },
  medical: {
    label: 'Medical / Training',
    blurb: 'Athletic trainer + recovery + supplies.',
    effect: 'Faster injury recovery. ±30% recovery speed.',
    icon: '',
  },
  recruiting: {
    label: 'Recruiting',
    blurb: 'Travel for visits, camp fees, signing day production.',
    effect: 'Boosts weekly AP earned + recruit pool size. Up to +5 AP/wk.',
    icon: '',
  },
  emergencyFund: {
    label: 'Emergency Fund',
    blurb: 'Rainy-day buffer. Drawn FIRST when random in-season events cost money (booster grants, equipment theft, hotel mix-ups, etc.).',
    effect: 'Higher = more wiggle room before random-event costs eat into other categories. Surfaced on every popup that involves money so you see what\'s available.',
    icon: '',
  },
}

const ADJUST_STEP = 1000

export default function Budget() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => {
    const s = loadDynasty(userId, slot)
    if (s) ensureUnifiedCalendar(s)
    return s
  })

  if (!save) return <Navigate to="/gm" replace />

  const budget = save.budget
  // DOO support staff adds +$50K to the spendable budget. Compute once here
  // so the usage bar + every category percentage uses the boosted total.
  const userTeam = save.teams[save.userSchoolId]
  const boosts = optionalHireBoosts(userTeam?.assistantCoachIds, save.coaches)
  const total = (budget.totalAthleticBudget || 0) + (boosts.budgetBonus || 0)
  const travelLocked = !!budget.travelLocked
  const weekOfYear = save.calendar?.weekOfYear ?? 1
  const isWk3Tutorial = weekOfYear === 3
  const isLocked = budget.locked?.year === save.calendar?.year

  // Self-heal: if travel is locked at $0 but the schedule has road trips,
  // re-lock against the actual cost.
  const liveTravel = useMemo(
    () => totalAnnualTravelCost(save.userSchoolId, save.schedule || [], save.schools, NON_NAIA_DISPLAY) || 0,
    [save.schedule, save.schools, save.userSchoolId],
  )
  useEffect(() => {
    if (travelLocked && (budget.allocations.travel || 0) === 0 && liveTravel > 0) {
      save.budget = lockTravelAllocation(budget, liveTravel)
      saveDynasty(save); setSave({ ...save })
    }
  }, [travelLocked, liveTravel])    // eslint-disable-line

  // ── Allocations + helpers ──────────────────────────────────────────────
  const allocated = BUDGET_CATEGORIES.reduce((s, c) => s + (budget.allocations[c] || 0), 0)
  const surplus = total - allocated     // positive = under, negative = over
  const usagePct = total > 0 ? Math.min(150, (allocated / total) * 100) : 0

  function adjustCategory(category, delta) {
    if (isLocked) return
    if (category === 'travel' && travelLocked) return
    if (category === 'coachingSalaries') return    // sourced from actual hires
    const current = budget.allocations[category] || 0
    const next = Math.max(0, current + delta)
    save.budget = {
      ...budget,
      allocations: { ...budget.allocations, [category]: next },
    }
    saveDynasty(save); setSave({ ...save })
  }

  function applyPreset(preset) {
    if (isLocked) return
    save.budget = applyBudgetPreset(budget, preset, level)
    saveDynasty(save); setSave({ ...save })
  }

  function lockBudget() {
    save.budget = lockBudgetForYear(save.budget, save.calendar?.year)
    save.newsfeed.unshift({
      id: `budget_lock_${save.calendar?.year}`,
      year: save.calendar?.year, week: save.calendar?.week, type: 'AWARD',
      headline: `${save.calendar?.year} budget locked. $${(total / 1000).toFixed(0)}K allocated across categories.`,
      payload: {},
    })
    saveDynasty(save); setSave({ ...save })
  }
  function unlockBudget() {
    save.budget = { ...save.budget, locked: null }
    saveDynasty(save); setSave({ ...save })
  }

  const userSchool = save.schools[save.userSchoolId]
  // Level-aware guidance + effects. Without this, a D3 program running 0%
  // scholarship is graded against NAIA's 55% expectation and looks like a
  // disaster on the page.
  const level = userSchool?.level || save.level || 'NAIA'
  const guidance = getBudgetGuidance(level)
  const effects = budgetCategoryEffects(budget, level)
  const ext = extendedBudgetEffects(budget, level)
  return (
    <GMShell schoolName={userSchool?.name} schoolColors={userSchool?.colors}>
    <div className="max-w-5xl mx-auto">
      <div className="mb-4">
        <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">ANNUAL BUDGET</h1>
        <p className="text-sm text-gray-600">
          Distribute <strong>${(total / 1000).toFixed(0)}K</strong> across categories.
          {boosts.budgetBonus > 0 && (
            <span className="text-emerald-700 font-semibold">
              {' '}(includes +${(boosts.budgetBonus / 1000).toFixed(0)}K from Director of Operations)
            </span>
          )}
          {' '}· <span className="font-semibold text-pnw-slate">{level} program</span>
          {' '}· Job Security: <JobSecurityBadge js={budget.jobSecurity} />
          {' '}· {budget.yearsAtSchool || 0} year{budget.yearsAtSchool === 1 ? '' : 's'} at school
        </p>
        <p className="text-[11px] text-gray-500 mt-1">
          Guidance bands are level-specific. {level === 'D3' || level === 'NWAC'
            ? 'No athletic scholarships at this level — that line stays at $0.'
            : level === 'D1'
              ? 'D1 typical breakdown: ~30% coaching, ~30% scholarships, ~12% travel, ~9% facilities.'
              : level === 'D2'
                ? 'D2 typical breakdown: ~40% scholarships, ~22% coaching, ~12% travel.'
                : 'NAIA typical breakdown: ~55% scholarships, ~19% coaching, ~14% travel.'}
        </p>
      </div>

      {/* USAGE BAR — at the top, the most important info on the page */}
      <UsageBar total={total} allocated={allocated} surplus={surplus} usagePct={usagePct} />

      {/* Wk 3 tutorial banner */}
      {isWk3Tutorial && !isLocked && (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4 mb-4">
          <div className="text-[11px] uppercase tracking-wider text-amber-700 font-bold mb-1">
            Week 3 — Set Your Budget
          </div>
          <div className="text-sm text-amber-900 leading-snug">
            Pick a preset or use the +/− buttons to fine-tune. Travel + coaching are locked
            (they come from your schedule + hires). The category effects on the right tell
            you exactly what each dollar buys. <strong>Lock the budget</strong> when you're
            happy with it to advance to Wk 4.
          </div>
        </div>
      )}

      {/* Presets */}
      {!isLocked && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4 shadow-sm">
          <h2 className="text-xs font-bold text-pnw-slate uppercase tracking-widest mb-2">Quick Presets</h2>
          <p className="text-[11px] text-gray-500 mb-3">
            One-click distributions. Travel + coaching stay locked; everything else rebalances.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {BUDGET_PRESETS.map(p => (
              <button
                key={p.key}
                onClick={() => applyPreset(p)}
                className="text-left border border-gray-200 rounded p-3 hover:border-pnw-green hover:bg-pnw-cream transition"
              >
                <div className="font-semibold text-sm text-pnw-slate">{p.label}</div>
                <div className="text-[11px] text-gray-600 mt-1 leading-snug">{p.blurb}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Lock state */}
      {isLocked ? (
        <div className="bg-green-50 border-2 border-green-300 rounded-xl p-3 mb-4 flex justify-between items-center">
          <div className="text-sm text-green-900">
            <strong> Budget locked for {save.calendar?.year}.</strong>{' '}
            Year-end review measures against this.
          </div>
          <button onClick={unlockBudget} className="px-3 py-1.5 border border-green-600 text-green-800 rounded text-xs font-semibold hover:bg-green-100">
            Unlock & edit
          </button>
        </div>
      ) : (
        <div className="bg-blue-50 border-2 border-blue-300 rounded-xl p-3 mb-4 flex justify-between items-center">
          <div className="text-sm text-blue-900">
            Looks good? <strong>Lock the budget in</strong> to clear the Wk 3 phase-gate.
          </div>
          <button onClick={lockBudget} className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold hover:opacity-90 shrink-0 ml-3">
            Lock budget 
          </button>
        </div>
      )}

      {/* Categories — each with +/- buttons + effect explanation */}
      <div className="space-y-3">
        {BUDGET_CATEGORIES.map(cat => {
          const meta = CATEGORIES[cat]
          const value = budget.allocations[cat] || 0
          const pct = total > 0 ? value / total : 0
          const guide = guidance[cat]
          const inRange = guide && pct >= guide.min && pct <= guide.max
          // At D3/NWAC, scholarships should be hard-locked at zero.
          // (We surface this with a level-specific note instead of an unhittable
          // guidance band.)
          const isForcedZero = guide && guide.min === 0 && guide.max === 0
          const catLocked = isLocked || meta.lockedAlways || isForcedZero ||
            (cat === 'travel' && travelLocked) || meta.lockedFromHires
          return (
            <CategoryRow
              key={cat}
              cat={cat}
              meta={meta}
              value={value}
              pct={pct}
              total={total}
              guide={guide}
              inRange={inRange || isForcedZero}   // 0% on forced-zero IS in range
              locked={catLocked}
              forcedZero={isForcedZero}
              level={level}
              onAdjust={(delta) => adjustCategory(cat, delta)}
              effectValue={effectsByCat(cat, effects, ext)}
            />
          )
        })}
      </div>
    </div>
    </GMShell>
  )
}

function UsageBar({ total, allocated, surplus, usagePct }) {
  const over = surplus < 0
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm mb-4">
      <div className="flex flex-col xs:flex-row justify-between items-baseline mb-2 gap-2">
        <div>
          <div className="text-xs uppercase tracking-widest text-gray-500 font-bold">Budget Usage</div>
          <div className="text-xl sm:text-2xl font-bold text-pnw-slate mt-0.5">
            ${(allocated / 1000).toFixed(1)}K
            <span className="text-base text-gray-500 font-normal"> / ${(total / 1000).toFixed(1)}K</span>
          </div>
        </div>
        <div className="text-left xs:text-right">
          <div className={'text-xl sm:text-2xl font-bold ' + (over ? 'text-red-700' : 'text-green-700')}>
            {over ? '-' : '+'}${(Math.abs(surplus) / 1000).toFixed(1)}K
          </div>
          <div className="text-xs uppercase tracking-wider text-gray-500">
            {over ? 'over budget' : surplus === 0 ? 'on budget' : 'surplus'}
          </div>
        </div>
      </div>
      {/* Visual progress bar */}
      <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden mt-2 relative">
        <div
          className={'h-full transition-all ' + (over ? 'bg-red-500' : usagePct > 95 ? 'bg-amber-500' : 'bg-pnw-green')}
          style={{ width: `${Math.min(100, usagePct)}%` }}
        />
        {over && (
          <div className="absolute top-0 right-0 h-full w-1 bg-red-700" />
        )}
      </div>
      {/* Effect of surplus / deficit */}
      <div className="text-[11px] text-gray-600 mt-2 leading-snug">
        {over
          ? <> <strong>${(-surplus / 1000).toFixed(1)}K over.</strong> The AD will cut next year's budget AND hit your job security at year-end. Over-budget is allowed, but expensive.</>
          : surplus > 0
            ? <>You have <strong>${(surplus / 1000).toFixed(1)}K unspent.</strong> Up to 25% of total rolls over to next year — the rest goes back to the school.</>
            : <>Every dollar deployed. AD likes a clean ledger.</>}
      </div>
    </div>
  )
}

function CategoryRow({ cat, meta, value, pct, total, guide, inRange, locked, forcedZero, level, onAdjust, effectValue }) {
  const guideMin = guide ? Math.round(guide.min * total) : null
  const guideMax = guide ? Math.round(guide.max * total) : null
  // Forced-zero categories (scholarships at D3/NWAC) show a level-specific
  // explainer instead of the typical-range band.
  const lockedReason = forcedZero
    ? (level === 'D3' ? 'D3 — no athletic scholarships permitted by NCAA.'
       : level === 'NWAC' ? 'NWAC — JUCO programs do not award athletic scholarships.'
       : 'Locked at zero for this level.')
    : null
  return (
    <div className={'bg-white rounded-xl border p-4 shadow-sm ' + (locked ? 'border-gray-200' : 'border-gray-200 hover:border-pnw-green/30')}>
      <div className="flex items-start gap-4">
        {/* Icon */}
        <div className="text-2xl shrink-0 mt-0.5">{meta.icon}</div>
        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-baseline">
            <div>
              <div className="text-sm font-bold text-pnw-slate">
                {meta.label}
                {locked && !forcedZero && <span className="text-gray-400 text-xs"> (locked)</span>}
                {forcedZero && <span className="text-gray-500 text-xs"> (n/a at this level)</span>}
              </div>
              <div className="text-[11px] text-gray-500">{lockedReason || meta.blurb}</div>
            </div>
            <div className="text-right shrink-0 ml-4">
              <div className="text-xl font-bold text-pnw-slate font-mono">${(value / 1000).toFixed(1)}K</div>
              <div className={'text-[11px] ' + (inRange ? 'text-green-700' : 'text-amber-700')}>
                {(pct * 100).toFixed(1)}%
                {guide && !forcedZero && (
                  <span className="text-gray-400 ml-1">
                    (typical {(guide.min * 100).toFixed(0)}-{(guide.max * 100).toFixed(0)}%)
                  </span>
                )}
              </div>
            </div>
          </div>
          {/* +/- controls */}
          {!locked && (
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={() => onAdjust(-ADJUST_STEP)}
                disabled={value <= 0}
                className="w-10 h-9 bg-gray-100 hover:bg-red-100 text-gray-700 hover:text-red-700 rounded-lg font-bold text-lg disabled:opacity-30 transition"
              >
                −
              </button>
              <button
                onClick={() => onAdjust(-ADJUST_STEP * 5)}
                disabled={value <= 0}
                className="px-3 h-9 bg-gray-100 hover:bg-red-100 text-gray-700 hover:text-red-700 rounded-lg font-semibold text-xs disabled:opacity-30 transition"
              >
                −$5K
              </button>
              <div className="flex-1" />
              <button
                onClick={() => onAdjust(+ADJUST_STEP * 5)}
                className="px-3 h-9 bg-gray-100 hover:bg-pnw-cream text-gray-700 hover:text-pnw-green rounded-lg font-semibold text-xs transition"
              >
                +$5K
              </button>
              <button
                onClick={() => onAdjust(+ADJUST_STEP)}
                className="w-10 h-9 bg-gray-100 hover:bg-pnw-cream text-gray-700 hover:text-pnw-green rounded-lg font-bold text-lg transition"
              >
                +
              </button>
            </div>
          )}
          {/* Effect explanation */}
          <div className="bg-gray-50 rounded p-2 mt-3 text-[11px] text-gray-700">
            <span className="font-semibold text-pnw-slate">Effect:</span> {meta.effect}
            {effectValue != null && (
              <span className={'ml-2 font-mono font-bold ' + (effectValue > 0 ? 'text-green-700' : effectValue < 0 ? 'text-red-700' : 'text-gray-500')}>
                {effectValue > 0 ? '+' : ''}{effectValue}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Per-category "current effect value" pulled from the combined effects.
// Returns a small number for display (e.g. +12 for dev%, -3 for stamina).
function effectsByCat(cat, base, ext) {
  switch (cat) {
    case 'facilities':
      return Math.round((ext.devMultiplier - 1) * 100)      // %
    case 'equipment':
      return Math.round((1 - ext.injuryMultiplier) * 100)   // %  inverted
    case 'meals':
      return Math.round(ext.staminaBoost * 10) / 10         // pts
    case 'medical':
      return Math.round((ext.recoveryMultiplier - 1) * 100) // %
    case 'recruiting':
      return base.recruitingAPBoost                          // AP
    default:
      return null
  }
}

function JobSecurityBadge({ js }) {
  if (js < 25) return <span className="font-bold text-red-700">{js} — Hot seat</span>
  if (js < 50) return <span className="font-bold text-amber-700">{js} — Watching</span>
  if (js < 75) return <span className="font-bold text-pnw-slate">{js} — Stable</span>
  return <span className="font-bold text-green-700">{js} — Tenured</span>
}
