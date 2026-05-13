import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import {
  BUDGET_CATEGORIES,
  rebalanceAllocations,
  budgetCategoryEffects,
  extendedBudgetEffects,
  BUDGET_GUIDANCE,
  BUDGET_PRESETS,
  applyBudgetPreset,
  budgetOverage,
  lockBudgetForYear,
} from '../../gm/engine/budget'
import { ensureUnifiedCalendar } from '../../gm/engine/gameYear'

const CATEGORY_LABELS = {
  scholarships:      { label: 'Scholarships',         blurb: 'Athletic aid pool. Drives recruit closing rate.' },
  coachingSalaries:  { label: 'Coaching Salaries',    blurb: 'HC + assistants. Affects weekly AP earned.' },
  travel:            { label: 'Travel',               blurb: 'Bus/flights/hotels. LOCKED from your schedule in Wk 3.' },
  equipment:         { label: 'Equipment',            blurb: 'Bats, gloves, balls. Cheap gear = more injuries.' },
  uniforms:          { label: 'Uniforms',             blurb: 'Game jerseys, hats, travel polos.' },
  meals:             { label: 'Meals',                blurb: 'Training table + travel meals. Pitcher stamina + durability.' },
  facilities:        { label: 'Facilities',           blurb: 'Field, cage, weight room. Offseason player development rate.' },
  medical:           { label: 'Medical',              blurb: 'Trainers + rehab. Injury recovery speed.' },
  recruiting:        { label: 'Recruiting',           blurb: 'Visits + camps. Boosts recruit pool + closing rate.' },
  misc:              { label: 'Miscellaneous',        blurb: 'Awards, banquets, team building, buffer.' },
}

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
  const total = budget.totalAthleticBudget
  const travelLocked = !!budget.travelLocked
  const weekOfYear = save.calendar?.weekOfYear ?? 1
  const isWk3Tutorial = weekOfYear === 3
  const isLocked = budget.locked?.year === save.calendar?.year

  function setCategory(category, newAmount) {
    if (category === 'travel' && travelLocked) return
    if (isLocked) return
    const updated = rebalanceAllocations(
      budget.allocations, category, newAmount, budget.totalAthleticBudget,
    )
    save.budget = { ...budget, allocations: updated }
    saveDynasty(save); setSave({ ...save })
  }

  function applyPreset(preset) {
    if (isLocked) return
    save.budget = applyBudgetPreset(budget, preset)
    saveDynasty(save); setSave({ ...save })
  }

  function lockBudget() {
    save.budget = lockBudgetForYear(save.budget, save.calendar?.year)
    saveDynasty(save); setSave({ ...save })
  }

  function unlockBudget() {
    save.budget = { ...save.budget, locked: null }
    saveDynasty(save); setSave({ ...save })
  }

  const effects = budgetCategoryEffects(budget)
  const ext = extendedBudgetEffects(budget)
  const overage = budgetOverage(budget)

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="mb-4">
        <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Dashboard</Link>
        <h1 className="text-3xl font-bold text-pnw-slate mt-1">Annual Budget</h1>
        <p className="text-sm text-gray-600">
          Total: <span className="font-bold">${(total / 1000).toFixed(0)}K</span>
          {' '}• Job Security: <JobSecurityBadge js={budget.jobSecurity} />
          {' '}• {budget.yearsAtSchool || 0} year{budget.yearsAtSchool === 1 ? '' : 's'} at school
        </p>
      </div>

      {/* Wk 3 tutorial banner */}
      {isWk3Tutorial && !isLocked && (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4 mb-4">
          <div className="text-[11px] uppercase tracking-wider text-amber-700 font-bold mb-1">
            Week 3 — Set Your Budget
          </div>
          <div className="text-sm text-amber-900">
            Pick a preset or build your own. Travel is locked from your schedule trips.
            Going over total is allowed but the AD will dock job security at year-end.
            <strong className="block mt-1">Lock the budget in when you're happy with it to advance to Wk 4.</strong>
          </div>
        </div>
      )}

      {/* Presets */}
      {!isLocked && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2">Quick presets</h2>
          <p className="text-[11px] text-gray-500 mb-3">
            Each preset rebalances the non-travel categories. Tweak with sliders below.
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

      {/* Over-budget warning */}
      {overage > 0 && (
        <div className="bg-red-50 border-2 border-red-300 rounded-xl p-3 mb-4 text-sm text-red-900">
          <strong>⚠ Over budget by ${(overage / 1000).toFixed(1)}K.</strong>{' '}
          You're allowed to overspend, but the AD will reduce next year's budget AND dock job
          security at end-of-year. {budget.jobSecurity < 50 && ' You\'re already on thin ice — be careful.'}
        </div>
      )}

      {/* Lock state */}
      {isLocked ? (
        <div className="bg-green-50 border-2 border-green-300 rounded-xl p-4 mb-4 flex justify-between items-center">
          <div>
            <div className="font-semibold text-green-900">✓ Budget locked for {save.calendar?.year}</div>
            <div className="text-xs text-green-800 mt-1">
              You can unlock and tweak, but the AD's review at year-end measures against what's
              locked here.
            </div>
          </div>
          <button onClick={unlockBudget} className="px-3 py-1.5 border border-green-600 text-green-800 rounded text-xs font-semibold hover:bg-green-100">
            Unlock & edit
          </button>
        </div>
      ) : (
        <div className="bg-blue-50 border-2 border-blue-300 rounded-xl p-3 mb-4 flex justify-between items-center">
          <div className="text-sm text-blue-900">
            Once your numbers look right, <strong>lock the budget in</strong> — this is what Wk 3's
            phase-gate checks for.
          </div>
          <button onClick={lockBudget} className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold hover:opacity-90 shrink-0 ml-3">
            Lock budget ✓
          </button>
        </div>
      )}

      {/* Categories */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {BUDGET_CATEGORIES.map(cat => {
          const value = budget.allocations[cat] || 0
          const pct = value / total
          const info = CATEGORY_LABELS[cat]
          const guide = BUDGET_GUIDANCE[cat]
          const inRange = guide && pct >= guide.min && pct <= guide.max
          const guideMin = guide ? Math.round(guide.min * total) : null
          const guideMax = guide ? Math.round(guide.max * total) : null
          const catLocked = isLocked || (cat === 'travel' && travelLocked)
          return (
            <div key={cat} className={'p-4 border-b last:border-b-0 ' + (catLocked ? 'opacity-70' : '')}>
              <div className="flex justify-between items-baseline mb-1">
                <div className="flex-1 min-w-0">
                  <span className="font-semibold text-pnw-slate text-sm">
                    {info.label} {cat === 'travel' && travelLocked && '🔒'}
                  </span>
                  <span className="ml-2 text-xs text-gray-500">{info.blurb}</span>
                </div>
                <div className="text-right ml-3 whitespace-nowrap">
                  <span className="font-bold text-pnw-slate">${(value / 1000).toFixed(0)}K</span>
                  <span className={'text-xs ml-1 ' + (inRange ? 'text-green-700' : 'text-amber-700')}>
                    {(pct * 100).toFixed(1)}%
                  </span>
                </div>
              </div>
              {guide && (
                <div className="text-[10px] text-gray-500 mb-1">
                  Suggested: ${(guideMin / 1000).toFixed(0)}K–${(guideMax / 1000).toFixed(0)}K ({(guide.min * 100).toFixed(0)}–{(guide.max * 100).toFixed(0)}%) — {guide.note}
                </div>
              )}
              <div className="relative">
                <input
                  type="range" min={0} max={total} step={1000} value={value}
                  onChange={e => setCategory(cat, parseInt(e.target.value, 10))}
                  disabled={catLocked}
                  className="w-full relative z-10"
                />
                {guide && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 h-1 bg-green-300/40 rounded-full pointer-events-none"
                    style={{ left: `${guide.min * 100}%`, width: `${(guide.max - guide.min) * 100}%` }}
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Effects panel */}
      <div className="mt-6 bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-pnw-slate uppercase tracking-wider mb-3">Sim Effects from your allocation</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          <EffectRow label="Facilities → offseason dev rate" value={(ext.devMultiplier - 1) * 100} unit="%" positiveGood />
          <EffectRow label="Equipment → injury risk" value={(ext.injuryMultiplier - 1) * 100} unit="%" positiveGood={false} />
          <EffectRow label="Meals → pitcher stamina" value={ext.staminaBoost} unit="pts" positiveGood />
          <EffectRow label="Meals → team GPA floor" value={ext.gpaFloor} unit="GPA" positiveGood />
          <EffectRow label="Medical → recovery speed" value={(ext.recoveryMultiplier - 1) * 100} unit="%" positiveGood />
          <EffectRow label="Recruiting → AP per week" value={effects.recruitingAPBoost} unit="AP" positiveGood />
          <EffectRow label="Recruiting → pool size" value={(ext.recruitPoolMultiplier - 1) * 100} unit="%" positiveGood />
        </div>
      </div>
    </div>
  )
}

function EffectRow({ label, value, unit, positiveGood }) {
  const isPositive = value > 0
  const isNeutral = Math.abs(value) < 0.1
  const isGood = isNeutral ? null : (positiveGood ? isPositive : !isPositive)
  const color = isNeutral ? 'text-gray-400' : (isGood ? 'text-green-700' : 'text-red-700')
  return (
    <div className="flex justify-between text-xs">
      <span className="text-gray-700">{label}</span>
      <span className={'font-mono ' + color}>
        {isNeutral ? '0' : `${isPositive ? '+' : ''}${value.toFixed(1)}`} {unit}
      </span>
    </div>
  )
}

function JobSecurityBadge({ js }) {
  if (js < 25) return <span className="font-bold text-red-700">{js} — Hot seat</span>
  if (js < 50) return <span className="font-bold text-amber-700">{js} — Watching</span>
  if (js < 75) return <span className="font-bold text-pnw-slate">{js} — Stable</span>
  return <span className="font-bold text-green-700">{js} — Tenured</span>
}
