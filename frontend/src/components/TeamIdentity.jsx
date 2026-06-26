/**
 * Team Identity tab (Team Profile V2). Team-level letter-grade report card,
 * a radar vs the division peer group, trait chips, a light outlook, and
 * returning-production percentages. No player names here by design — this tab
 * is about how the team played and what that means going forward.
 * Data: /api/v1/teams/{id}/identity?season=
 */
import {
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, ResponsiveContainer,
} from 'recharts'
import { useApi } from '../hooks/useApi'

function gradeClasses(grade) {
  const L = (grade || '')[0]
  if (L === 'A') return 'text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-900/30 dark:border-emerald-800'
  if (L === 'B') return 'text-teal-700 bg-teal-50 border-teal-200 dark:text-teal-300 dark:bg-teal-900/30 dark:border-teal-800'
  if (L === 'C') return 'text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-900/30 dark:border-amber-800'
  if (L === 'D') return 'text-orange-700 bg-orange-50 border-orange-200 dark:text-orange-300 dark:bg-orange-900/30 dark:border-orange-800'
  return 'text-rose-700 bg-rose-50 border-rose-200 dark:text-rose-300 dark:bg-rose-900/30 dark:border-rose-800'
}

const REPORT_ORDER = [
  ['offense', 'Offense'], ['power', 'Power'], ['contact', 'Contact'],
  ['discipline', 'Discipline'], ['speed', 'Speed'], ['pitching', 'Run Prevention'],
  ['miss_bats', 'Miss Bats'], ['strike_throwing', 'Strike Throwing'], ['pitching_depth', 'Pitching Depth'],
]

function Card({ title, children, right }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden mb-4 sm:mb-6">
      {title && (
        <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/40">
          <div className="text-sm font-bold text-nw-teal dark:text-gray-100 uppercase tracking-wide">{title}</div>
          {right}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  )
}

function GradePill({ grade, big }) {
  return (
    <span className={`inline-flex items-center justify-center font-extrabold rounded-lg border ${gradeClasses(grade)} ${
      big ? 'text-3xl w-16 h-16' : 'text-base w-11 h-9'
    }`}>{grade}</span>
  )
}

function RetBar({ label, pct }) {
  const v = Math.max(0, Math.min(100, pct ?? 0))
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</span>
        <span className="text-sm font-bold text-gray-800 dark:text-gray-100 tabular-nums">{v.toFixed(0)}%</span>
      </div>
      <div className="h-2 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
        <div className="h-full rounded-full bg-nw-teal-light" style={{ width: `${v}%` }} />
      </div>
    </div>
  )
}

export default function TeamIdentity({ teamId, season }) {
  const { data, loading, error } = useApi(`/teams/${teamId}/identity`, { season }, [teamId, season])

  if (loading) return <div className="py-10 text-center text-sm text-gray-400 animate-pulse">Building team identity…</div>
  if (error || !data || data.error) return <div className="py-10 text-center text-sm text-gray-400">Team identity is unavailable for this season.</div>

  const g = data.grades
  const radar = data.radar || []

  return (
    <div>
      {/* Identity headline + overall grade */}
      <Card>
        <div className="flex items-center gap-4">
          <GradePill grade={g.overall?.grade} big />
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{season} Team Identity</div>
            <div className="text-xl sm:text-2xl font-extrabold text-gray-900 dark:text-gray-100 leading-tight">{data.identity_label}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Graded vs {data.peer_count} {data.peer_group} peers · {data.outlook?.label}
            </div>
          </div>
        </div>
        {(data.positive_tags?.length > 0 || data.concern_tags?.length > 0) && (
          <div className="flex flex-wrap gap-1.5 mt-4">
            {data.positive_tags.map((t) => (
              <span key={t} className="text-[11px] font-semibold px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">✓ {t}</span>
            ))}
            {data.concern_tags.map((t) => (
              <span key={t} className="text-[11px] font-semibold px-2 py-1 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">△ {t}</span>
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        {/* Report card */}
        <Card title="Report Card">
          <div className="grid grid-cols-3 gap-2.5">
            {REPORT_ORDER.map(([key, label]) => (
              <div key={key} className="flex flex-col items-center gap-1.5 rounded-lg border border-gray-100 dark:border-gray-700 py-2.5">
                <GradePill grade={g[key]?.grade} />
                <span className="text-[10px] font-medium text-gray-500 dark:text-gray-400 text-center leading-tight px-1">{label}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Radar vs peers */}
        <Card title={`Team Radar vs ${data.peer_group}`}>
          <ResponsiveContainer width="100%" height={300}>
            <RadarChart data={radar} outerRadius="72%" margin={{ top: 10, right: 30, bottom: 10, left: 30 }}>
              <PolarGrid stroke="rgba(148,163,184,0.3)" />
              <PolarAngleAxis dataKey="label" tick={{ fontSize: 10, fill: 'currentColor' }} className="text-gray-500 dark:text-gray-400" />
              <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
              <Radar dataKey="score" stroke="#0e7490" fill="#22d3ee" fillOpacity={0.35} />
            </RadarChart>
          </ResponsiveContainer>
          <p className="text-[11px] text-gray-400 text-center -mt-2">Percentile vs division peers (outer edge = best in {data.peer_group}).</p>
        </Card>
      </div>

      {/* What worked / focus areas */}
      {data.narrative && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
          <Card title="What Worked Last Season">
            <ul className="space-y-2">
              {data.narrative.strengths.map((t, i) => (
                <li key={i} className="flex gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <span className="text-emerald-500 font-bold shrink-0">✓</span><span>{t}</span></li>
              ))}
            </ul>
          </Card>
          <Card title="Focus Areas">
            <ul className="space-y-2">
              {data.narrative.improvements.map((t, i) => (
                <li key={i} className="flex gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <span className="text-amber-500 font-bold shrink-0">→</span><span>{t}</span></li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {/* Returning production + looking ahead */}
      <Card title="Returning Production">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <RetBar label="Plate Apps" pct={data.returning?.ret_pa_pct} />
          <RetBar label="Innings" pct={data.returning?.ret_ip_pct} />
          <RetBar label="oWAR" pct={data.returning?.ret_owar_pct} />
          <RetBar label="pWAR" pct={data.returning?.ret_pwar_pct} />
        </div>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200 mt-4">{data.narrative?.outlook || data.outlook?.text}</p>
        {data.narrative?.returners?.length > 0 && (
          <ul className="mt-2.5 space-y-1.5">
            {data.narrative.returners.map((t, i) => (
              <li key={i} className="flex gap-2 text-xs text-gray-500 dark:text-gray-400">
                <span className="text-nw-teal-light shrink-0">•</span><span>{t}</span></li>
            ))}
          </ul>
        )}
      </Card>

      {/* Game plan / next step */}
      {data.suggestions?.length > 0 && (
        <Card title="Next Step">
          <ul className="space-y-2">
            {data.suggestions.map((s, i) => (
              <li key={i} className="flex gap-2 text-sm text-gray-700 dark:text-gray-300">
                <span className="text-nw-teal-light font-bold shrink-0">→</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Stat snapshot */}
      <Card title="Stat Snapshot">
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-y-3 text-center">
          {[
            ['OPS', data.snapshot?.ops?.toFixed?.(3).replace(/^0/, '')],
            ['ISO', data.snapshot?.iso?.toFixed?.(3).replace(/^0/, '')],
            ['BB%', data.snapshot?.bat_bb_pct != null ? `${data.snapshot.bat_bb_pct}%` : '-'],
            ['ERA', data.snapshot?.era != null ? data.snapshot.era.toFixed(2) : '-'],
            ['K%', data.snapshot?.pit_k_pct != null ? `${data.snapshot.pit_k_pct}%` : '-'],
            ['SB', data.snapshot?.sb],
          ].map(([label, val]) => (
            <div key={label}>
              <div className="text-base sm:text-lg font-bold text-gray-900 dark:text-gray-100 tabular-nums">{val ?? '-'}</div>
              <div className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">{label}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
