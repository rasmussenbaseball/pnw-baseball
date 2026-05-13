import { useMemo, useState } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty, saveDynasty } from '../../gm/engine/save'
import {
  BUDGET_CATEGORIES,
  rebalanceAllocations,
  budgetCategoryEffects,
  BUDGET_GUIDANCE,
} from '../../gm/engine/budget'

const CATEGORY_LABELS = {
  scholarships:      { label: 'Scholarships',         blurb: 'Athletic aid to players (the 12-equivalency pool, as $)' },
  coachingSalaries:  { label: 'Coaching Salaries',    blurb: 'HC + assistants. Drives your weekly AP.' },
  travel:            { label: 'Travel',               blurb: 'Bus, flights, hotels, per diem for away trips.' },
  equipment:         { label: 'Equipment',            blurb: 'Bats, gloves, balls, helmets, catcher gear.' },
  uniforms:          { label: 'Uniforms',             blurb: 'Game jerseys, BP, travel polos, hats.' },
  meals:             { label: 'Meals',                blurb: 'Training table, post-game, travel meals. Affects durability + injury risk.' },
  facilities:        { label: 'Facilities',           blurb: 'Field, indoor cage, weight room maintenance + upgrades.' },
  medical:           { label: 'Medical',              blurb: 'Trainers, rehab, recovery. Affects injury recovery time.' },
  recruiting:        { label: 'Recruiting',           blurb: 'Phone, visits, signing-day. Boosts your recruiting AP.' },
  misc:              { label: 'Miscellaneous',        blurb: 'Awards, banquets, team-building, contingency.' },
}

export default function Budget() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const [save, setSave] = useState(() => loadDynasty(userId, slot))

  if (!save) return <Navigate to="/gm" replace />

  const budget = save.budget

  function setCategory(category, newAmount) {
    const updated = rebalanceAllocations(
      budget.allocations,
      category,
      newAmount,
      budget.totalAthleticBudget,
    )
    save.budget = { ...budget, allocations: updated }
    saveDynasty(save)
    setSave({ ...save })
  }

  const effects = budgetCategoryEffects(budget)
  const total = budget.totalAthleticBudget

  return (
    <div className="max-w-4xl mx-auto py-8">
      <div className="mb-6">
        <Link to={`/gm/dashboard?slot=${slot}`} className="text-sm text-pnw-green hover:underline">← Dashboard</Link>
        <h1 className="text-3xl font-bold text-pnw-slate mt-1">Annual Budget</h1>
        <p className="text-sm text-gray-600">
          Total program budget: <span className="font-bold">${(total / 1000).toFixed(0)}K</span>
          {' '}• Job Security: <JobSecurityBadge js={budget.jobSecurity} />
          {' '}• {budget.yearsAtSchool || 0} year{budget.yearsAtSchool === 1 ? '' : 's'} at school
        </p>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-900 mb-4">
        Allocations rebalance proportionally — drag one category up and the others scale down to keep the total constant.
        Going over total at year-end cuts next year's budget AND hurts job security.
        <span className="block mt-1 text-amber-800">The colored bar shows the healthy spending range for each category — green inside, amber outside.</span>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {BUDGET_CATEGORIES.map(cat => {
          const value = budget.allocations[cat] || 0
          const pct = value / total
          const info = CATEGORY_LABELS[cat]
          const guide = BUDGET_GUIDANCE[cat]
          const inRange = guide && pct >= guide.min && pct <= guide.max
          const guideMin = guide ? Math.round(guide.min * total) : null
          const guideMax = guide ? Math.round(guide.max * total) : null
          return (
            <div key={cat} className="p-4 border-b last:border-b-0">
              <div className="flex justify-between items-baseline mb-1">
                <div className="flex-1 min-w-0">
                  <span className="font-semibold text-pnw-slate text-sm">{info.label}</span>
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
                  type="range"
                  min={0}
                  max={total}
                  step={1000}
                  value={value}
                  onChange={e => setCategory(cat, parseInt(e.target.value, 10))}
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

      <div className="mt-6 bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-pnw-slate uppercase tracking-wider mb-3">Current Effects</h3>
        <div className="space-y-1.5 text-sm">
          <EffectRow label="Equipment → effective OVR" value={effects.equipmentBump} unit="pts" positiveGood />
          <EffectRow label="Meals → injury risk" value={-effects.mealsInjuryReduction * 100} unit="%" positiveGood={false} />
          <EffectRow label="Facilities → drift per year" value={effects.facilitiesDrift} unit="pts" positiveGood />
          <EffectRow label="Medical → recovery speed" value={effects.medicalRecovery * 100} unit="%" positiveGood />
          <EffectRow label="Recruiting → AP per week" value={effects.recruitingAPBoost} unit="AP" positiveGood />
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
