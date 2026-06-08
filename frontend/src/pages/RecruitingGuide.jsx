// Recruiting Guide — the in-depth, per-program research page. Readable by
// premium subscribers (the Recruit Matchmaker links here); editing is admin-only.
//
// One modern page per PNW program: hero + at-a-glance tiles, the hand-researched
// program profile (coaching, academics, cost, facilities, location, recruiting
// contacts) from the recruiting_programs table, and the on-field analytics
// (records, WAR, roster makeup, hometowns, best players) from the same
// /recruiting/guide/{team_id} endpoint. Admins can edit the program profile inline.
//
// Themed with the shared playerProfile primitives so light/dark mode are real.

import { useState, useMemo, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { useApi, useTeams } from '../hooks/useApi'
import { useAuth } from '../context/AuthContext'
import { isAdminEmail } from '../lib/tiers'
import {
  ProfileShell, SectionCard, usePlayerProfileTheme, divisionBadge,
} from '../components/playerProfile/shared'
import {
  FIELD_GROUPS, ALL_EDITABLE_FIELDS,
} from '../data/recruitingProgramSchema'

const inchesToFeetStr = (inches) => {
  if (!inches) return '-'
  const n = Math.round(inches)
  return `${Math.floor(n / 12)}'${n % 12}"`
}
const hostname = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}
const isEmpty = (v) => v == null || String(v).trim() === ''

// ── Value renderer (display side) ───────────────────────────────────────────
function FieldValue({ format, value, T }) {
  if (isEmpty(value)) return null
  if (format === 'url') {
    return (
      <a href={value} target="_blank" rel="noopener noreferrer"
        className="hover:underline break-all" style={{ color: T.accent }}>
        {hostname(value)} ↗
      </a>
    )
  }
  if (format === 'email') {
    return <a href={`mailto:${value}`} className="hover:underline break-all" style={{ color: T.accent }}>{value}</a>
  }
  if (format === 'multiline') {
    return <span className="whitespace-pre-line leading-relaxed">{value}</span>
  }
  return <span>{value}</span>
}

// ── At-a-glance stat tile ───────────────────────────────────────────────────
function StatTile({ label, value, T }) {
  if (isEmpty(value)) return null
  return (
    <div className="rounded-md px-3 py-2.5" style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <div className="text-[9.5px] font-bold uppercase tracking-widest mb-1" style={{ color: T.textLight }}>{label}</div>
      <div className="text-[15px] font-extrabold leading-tight" style={{ color: T.text }}>{value}</div>
    </div>
  )
}

// ── One labeled row inside a program section ────────────────────────────────
function InfoRow({ label, value, format, T }) {
  if (isEmpty(value)) return null
  const block = format === 'multiline'
  return (
    <div className={block ? 'py-2' : 'flex items-baseline gap-3 py-1.5'} style={{ borderTop: `1px solid ${T.rowBorder}` }}>
      <div className={`text-[10.5px] font-bold uppercase tracking-widest shrink-0 ${block ? 'mb-1' : 'w-36'}`} style={{ color: T.textLight }}>
        {label}
      </div>
      <div className="text-[13px] flex-1 min-w-0" style={{ color: T.text }}>
        <FieldValue format={format} value={value} T={T} />
      </div>
    </div>
  )
}

function ProgramGroup({ title, fields, profile, T }) {
  const rows = fields.filter((f) => !isEmpty(profile?.[f.key]))
  if (rows.length === 0) return null
  return (
    <SectionCard title={title}>
      <div className="flex flex-col">
        {rows.map((f) => (
          <InfoRow key={f.key} label={f.label} value={profile[f.key]} format={f.format} T={T} />
        ))}
      </div>
    </SectionCard>
  )
}

// ── Hero ────────────────────────────────────────────────────────────────────
function Hero({ teamInfo, program, T }) {
  const profile = program?.profile || {}
  const level = program?.division || teamInfo?.division_name
  const loc = [profile.city || teamInfo?.city, profile.state || teamInfo?.state].filter(Boolean).join(', ')
  return (
    <div className="rounded-md p-5 mb-4" style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <div className="flex items-center gap-4">
        {teamInfo?.logo_url
          ? <img src={teamInfo.logo_url} alt="" className="w-16 h-16 object-contain shrink-0" />
          : <div className="w-16 h-16 rounded-full shrink-0" style={{ background: T.track }} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-[22px] font-extrabold leading-tight" style={{ color: T.text }}>
              {teamInfo?.school_name || teamInfo?.name}
            </h1>
            {level && divisionBadge(level)}
          </div>
          <div className="text-[12.5px] mt-0.5" style={{ color: T.textMuted }}>
            {profile.teamName || teamInfo?.name}
            {teamInfo?.conference_name ? ` · ${teamInfo.conference_name}` : (program?.conference ? ` · ${program.conference}` : '')}
            {loc ? ` · ${loc}` : ''}
          </div>
          {!isEmpty(profile.recentRecord) && (
            <div className="text-[11.5px] mt-1" style={{ color: T.textLight }}>{profile.recentRecord}</div>
          )}
        </div>
      </div>
      {/* Quick links */}
      <div className="flex flex-wrap gap-2 mt-3">
        {[
          ['Recruiting Questionnaire', profile.recruitQuestionnaireUrl],
          ['Athletics Site', profile.athleticsWebsite],
          ['Baseball Roster', profile.baseballRosterUrl || teamInfo?.roster_url],
          ['School Site', profile.schoolWebsite],
        ].filter(([, u]) => !isEmpty(u)).map(([label, u]) => (
          <a key={label} href={u} target="_blank" rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-md text-[11.5px] font-bold hover:opacity-90"
            style={{ background: T.accent, color: '#fff' }}>
            {label} ↗
          </a>
        ))}
        {teamInfo?.id != null && (
          <Link to={`/team/${teamInfo.id}`} className="px-3 py-1.5 rounded-md text-[11.5px] font-bold hover:opacity-80"
            style={{ background: T.track, color: T.textMuted }}>
            Full team page →
          </Link>
        )}
        <Link to="/recruiting/quiz" className="px-3 py-1.5 rounded-md text-[11.5px] font-bold hover:opacity-80"
          style={{ background: T.track, color: T.textMuted }}>
          Find your fit →
        </Link>
      </div>
    </div>
  )
}

// ── Team dropdown (grouped by division) ─────────────────────────────────────
const DIV_ORDER = ['NCAA Division I', 'NCAA Division II', 'NCAA Division III', 'NAIA', 'NWAC', 'JUCO']
function TeamSelect({ teams, value, onChange, T }) {
  const grouped = useMemo(() => {
    const g = {}
    for (const t of teams || []) { const d = t.division_name || 'Other'; (g[d] ||= []).push(t) }
    return g
  }, [teams])
  const order = [...DIV_ORDER, ...Object.keys(grouped).filter((d) => !DIV_ORDER.includes(d))]
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value ? parseInt(e.target.value) : null)}
      className="w-full px-3 py-2.5 rounded-md text-[14px] font-semibold outline-none"
      style={{ background: T.card, border: `1px solid ${T.borderStrong}`, color: T.text }}>
      <option value="">Choose a program…</option>
      {order.filter((d) => grouped[d]).map((d) => (
        <optgroup key={d} label={d}>
          {grouped[d].slice().sort((a, b) => (a.short_name || a.name).localeCompare(b.short_name || b.name))
            .map((t) => <option key={t.id} value={t.id}>{t.short_name || t.name}</option>)}
        </optgroup>
      ))}
    </select>
  )
}

// ── Admin editor (schema-driven) ────────────────────────────────────────────
function ProgramEditor({ teamId, profile, onSaved, onCancel, T }) {
  const { session } = useAuth()
  const [form, setForm] = useState(() => {
    const init = {}
    for (const f of ALL_EDITABLE_FIELDS) init[f.key] = profile?.[f.key] ?? ''
    return init
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }))

  const save = async () => {
    setSaving(true); setError(null)
    // Preserve any unknown keys, overlay edits, drop blanks so empty fields hide.
    const merged = { ...(profile || {}) }
    for (const f of ALL_EDITABLE_FIELDS) {
      const v = (form[f.key] ?? '').toString().trim()
      if (v) merged[f.key] = v
      else delete merged[f.key]
    }
    try {
      const res = await fetch(`/api/v1/recruiting/programs/${teamId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ profile: merged }),
      })
      if (!res.ok) throw new Error(`Save failed (HTTP ${res.status})`)
      const data = await res.json()
      onSaved(data.program?.profile || merged)
    } catch (e) {
      setError(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const inputStyle = { background: T.bg, border: `1px solid ${T.borderStrong}`, color: T.text }
  return (
    <SectionCard title="Edit Program Info" right="ADMIN">
      {error && (
        <div className="mb-3 px-3 py-2 rounded text-[12px]" style={{ background: T.highlight, color: T.great }}>{error}</div>
      )}
      <div className="grid sm:grid-cols-2 gap-x-5 gap-y-3">
        {ALL_EDITABLE_FIELDS.map((f) => (
          <label key={f.key} className={`flex flex-col gap-1 ${f.format === 'multiline' ? 'sm:col-span-2' : ''}`}>
            <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>{f.label}</span>
            {f.format === 'multiline'
              ? <textarea rows={f.key === 'coachBio' ? 5 : 3} value={form[f.key]} onChange={(e) => set(f.key, e.target.value)}
                  className="px-2.5 py-1.5 rounded-md text-[13px] outline-none resize-y" style={inputStyle} />
              : <input type={f.format === 'email' ? 'email' : f.format === 'url' ? 'url' : 'text'}
                  value={form[f.key]} onChange={(e) => set(f.key, e.target.value)}
                  className="px-2.5 py-1.5 rounded-md text-[13px] outline-none" style={inputStyle} />}
          </label>
        ))}
      </div>
      <div className="flex gap-2 mt-4">
        <button onClick={save} disabled={saving}
          className="px-4 py-2 rounded-md text-[13px] font-bold text-white disabled:opacity-60"
          style={{ background: T.accent }}>
          {saving ? 'Saving…' : 'Save program info'}
        </button>
        <button onClick={onCancel} disabled={saving}
          className="px-4 py-2 rounded-md text-[13px] font-bold" style={{ background: T.track, color: T.textMuted }}>
          Cancel
        </button>
      </div>
    </SectionCard>
  )
}

// ── Themed recharts helpers ─────────────────────────────────────────────────
function chartProps(T) {
  return {
    grid: { strokeDasharray: '3 3', stroke: T.border },
    axis: { stroke: T.textMuted, tick: { fill: T.textMuted, fontSize: 12 } },
    tooltip: {
      contentStyle: { background: T.card, border: `1px solid ${T.borderStrong}`, borderRadius: 8, color: T.text },
      labelStyle: { color: T.textMuted }, itemStyle: { color: T.text },
    },
  }
}

function RecordTable({ records, T }) {
  if (!records?.length) return null
  const sorted = [...records].sort((a, b) => b.season - a.season)
  const pct = (w, l) => { const t = (w || 0) + (l || 0); return t ? (w / t).toFixed(3).replace(/^0/, '') : '-' }
  return (
    <SectionCard title="Year-by-Year Record">
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px] tabular-nums" style={{ color: T.text }}>
          <thead>
            <tr className="text-[9.5px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>
              <th className="text-left py-1.5">Season</th><th className="text-center py-1.5">Overall</th>
              <th className="text-center py-1.5">Win%</th><th className="text-center py-1.5">Conf</th>
              <th className="text-center py-1.5">Conf%</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const hasConf = (r.conf_wins || 0) + (r.conf_losses || 0) > 0
              return (
                <tr key={r.season} style={{ borderTop: `1px solid ${T.rowBorder}` }}>
                  <td className="text-left py-1.5 font-bold" style={{ color: T.accent }}>{r.season}</td>
                  <td className="text-center py-1.5 font-semibold">{r.wins}-{r.losses}{r.ties ? `-${r.ties}` : ''}</td>
                  <td className="text-center py-1.5" style={{ color: T.textMuted }}>{pct(r.wins, r.losses)}</td>
                  <td className="text-center py-1.5">{hasConf ? `${r.conf_wins}-${r.conf_losses}` : '-'}</td>
                  <td className="text-center py-1.5" style={{ color: T.textMuted }}>{hasConf ? pct(r.conf_wins, r.conf_losses) : '-'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  )
}

// Total WAR uses a distinct teal so it reads apart from oWAR (navy) / pWAR (gold).
const TOTAL_WAR_COLOR = '#0d9488'

function TrendCharts({ records, warBySeason, T }) {
  const cp = chartProps(T)
  const recData = (records || []).map((r) => {
    const tot = (r.wins || 0) + (r.losses || 0)
    return { season: r.season, winPct: tot ? +(100 * r.wins / tot).toFixed(1) : 0 }
  })
  const warData = (warBySeason || []).map((w) => {
    const o = +parseFloat(w.total_owar || 0).toFixed(1)
    const p = +parseFloat(w.total_pwar || 0).toFixed(1)
    return { season: w.season, owar: o, pwar: p, total: +(o + p).toFixed(1) }
  })
  if (!recData.length && !warData.length) return null

  // One WAR metric per chart (oWAR / pWAR / total) — clearer than a stacked bar,
  // especially when a season's WAR is negative. No bar radius so negative bars
  // (which point downward) render cleanly.
  const WarChart = ({ title, field, color }) => (
    <SectionCard title={title}>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={warData}>
          <CartesianGrid {...cp.grid} />
          <XAxis dataKey="season" {...cp.axis} />
          <YAxis {...cp.axis} />
          <Tooltip {...cp.tooltip} cursor={{ fill: T.track, opacity: 0.4 }} />
          <Bar dataKey={field} fill={color} name={title} />
        </BarChart>
      </ResponsiveContainer>
    </SectionCard>
  )

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      {recData.length > 0 && (
        <SectionCard title="Win % by Season">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={recData}>
              <CartesianGrid {...cp.grid} />
              <XAxis dataKey="season" {...cp.axis} />
              <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} {...cp.axis} />
              <Tooltip {...cp.tooltip} formatter={(v) => `${v}%`} cursor={{ fill: T.track, opacity: 0.4 }} />
              <Bar dataKey="winPct" fill={T.accent} name="Win %" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>
      )}
      {warData.length > 0 && <WarChart title="Offensive WAR by Season" field="owar" color={T.accent} />}
      {warData.length > 0 && <WarChart title="Pitching WAR by Season" field="pwar" color={T.gold} />}
      {warData.length > 0 && <WarChart title="Total WAR by Season" field="total" color={TOTAL_WAR_COLOR} />}
    </div>
  )
}

function RosterOverview({ overview, T }) {
  if (!overview) return null
  const cp = chartProps(T)
  const byClass = Object.entries(overview.by_class || {}).filter(([, c]) => c > 0).map(([name, value]) => ({ name, value }))
  const palette = [T.accent, T.gold, T.great, T.poor, T.hot, '#8b5cf6']
  return (
    <SectionCard title="Roster Overview" right={overview.season ? String(overview.season) : ''}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-2">
        {[['Roster Size', overview.total_players], ['Appeared', overview.players_appeared],
          ['Pitchers', overview.pitcher_count], ['Hitters', overview.hitter_count]].map(([l, v]) => (
          <div key={l} className="rounded-md px-3 py-2.5 text-center" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
            <div className="text-[9.5px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>{l}</div>
            <div className="text-[22px] font-extrabold" style={{ color: T.accent }}>{v ?? 0}</div>
          </div>
        ))}
      </div>
      {byClass.length > 0 && (
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie data={byClass} cx="50%" cy="50%" outerRadius={86} dataKey="value" paddingAngle={2}
              label={({ name, value }) => `${name}: ${value}`} labelLine={false} stroke={T.card}>
              {byClass.map((e, i) => <Cell key={i} fill={palette[i % palette.length]} />)}
            </Pie>
            <Tooltip {...cp.tooltip} formatter={(v, n) => [`${v} players`, n]} />
          </PieChart>
        </ResponsiveContainer>
      )}
    </SectionCard>
  )
}

function RosterComposition({ comp, T }) {
  if (!comp?.length) return null
  const cp = chartProps(T)
  const data = comp.map((c) => ({ season: String(c.season), Returners: c.returners || 0, Freshmen: c.freshmen || 0, Transfers: c.transfers || 0, total: c.total || 0 }))
  return (
    <SectionCard title="Roster Composition" right="RETURNERS · FRESHMEN · TRANSFERS">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data}>
          <CartesianGrid {...cp.grid} />
          <XAxis dataKey="season" {...cp.axis} />
          <YAxis {...cp.axis} />
          <Tooltip {...cp.tooltip} cursor={{ fill: T.track, opacity: 0.4 }}
            formatter={(v, n, p) => { const t = p.payload.total; return [`${v}${t ? ` (${((v / t) * 100).toFixed(0)}%)` : ''}`, n] }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Returners" stackId="r" fill={T.accent} name="Returners" />
          <Bar dataKey="Freshmen" stackId="r" fill={T.hot} name="Freshmen" />
          <Bar dataKey="Transfers" stackId="r" fill="#8b5cf6" name="Transfers" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </SectionCard>
  )
}

function FreshmanProd({ fresh, T }) {
  if (!fresh?.length) return null
  const cp = chartProps(T)
  const data = fresh.map((f) => ({ season: f.season, pa: +(parseFloat(f.fresh_pa_pct || 0) * 100).toFixed(1), ip: +(parseFloat(f.fresh_ip_pct || 0) * 100).toFixed(1) }))
  return (
    <SectionCard title="Freshman Production" right="% PA / % IP BY FRESHMEN">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data}>
          <CartesianGrid {...cp.grid} />
          <XAxis dataKey="season" {...cp.axis} />
          <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} {...cp.axis} />
          <Tooltip {...cp.tooltip} formatter={(v) => `${v}%`} cursor={{ fill: T.track, opacity: 0.4 }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="pa" fill={T.accent} name="Freshman PA %" />
          <Bar dataKey="ip" fill={T.poor} name="Freshman IP %" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </SectionCard>
  )
}

function Hometowns({ breakdown, T }) {
  const states = breakdown?.by_state?.map((s) => ({ name: s.state, value: s.count })) || []
  if (!states.length) return null
  const cp = chartProps(T)
  return (
    <SectionCard title="Where Players Come From" right="BY STATE">
      <ResponsiveContainer width="100%" height={Math.max(200, states.length * 26)}>
        <BarChart data={states} layout="vertical" margin={{ left: 70 }}>
          <CartesianGrid {...cp.grid} />
          <XAxis type="number" {...cp.axis} />
          <YAxis dataKey="name" type="category" width={64} {...cp.axis} />
          <Tooltip {...cp.tooltip} cursor={{ fill: T.track, opacity: 0.4 }} />
          <Bar dataKey="value" fill={T.accent} name="Players" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </SectionCard>
  )
}

function BestPlayers({ best, T }) {
  const bat = best?.batting || [], pit = best?.pitching || []
  if (!bat.length && !pit.length) return null
  const Col = ({ title, players, color }) => players.length === 0 ? null : (
    <SectionCard title={title} right="ALL-TIME WAR">
      <div className="flex flex-col">
        {players.slice(0, 10).map((p, i) => (
          <div key={i} className="flex items-center gap-3 py-1.5" style={{ borderTop: i ? `1px solid ${T.rowBorder}` : 'none' }}>
            <span className="text-[11px] font-bold w-4 text-center shrink-0" style={{ color: T.textLight }}>{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold truncate" style={{ color: T.text }}>{p.name}</div>
              <div className="text-[10.5px] truncate" style={{ color: T.textMuted }}>{p.position}{p.seasons?.length ? ` · ${p.seasons.join(', ')}` : ''}</div>
            </div>
            <span className="text-[13px] font-extrabold tabular-nums shrink-0" style={{ color }}>{parseFloat(p.total_war).toFixed(1)}</span>
          </div>
        ))}
      </div>
    </SectionCard>
  )
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Col title="Top Hitters" players={bat} color={T.accent} />
      <Col title="Top Pitchers" players={pit} color={T.poor} />
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function RecruitingGuide() {
  const T = usePlayerProfileTheme()
  const [sp, setSp] = useSearchParams()
  const [teamId, setTeamId] = useState(sp.get('team') ? parseInt(sp.get('team')) : null)
  const [editing, setEditing] = useState(false)
  const [localProfile, setLocalProfile] = useState(null) // optimistic after save

  // The page is readable by premium recruits, but only admins can edit (the
  // editor UI is hidden here; the PUT is admin-gated server-side as a backstop).
  const { user } = useAuth()
  const isAdmin = isAdminEmail(user?.email)

  const { data: teams = [] } = useTeams()
  const { data: guide, loading } = useApi(teamId ? `/recruiting/guide/${teamId}` : null, {}, [teamId])

  useEffect(() => {
    setSp(teamId ? { team: String(teamId) } : {}, { replace: true })
    setEditing(false); setLocalProfile(null)
  }, [teamId]) // eslint-disable-line

  const teamInfo = guide?.team_info
  const program = guide?.program
  const profile = localProfile || program?.profile || {}

  const glance = [
    ['Enrollment', profile.enrollment], ['Acceptance', profile.acceptance],
    ['Out-of-State', profile.outStateTuition], ['Roster', profile.rosterSize],
  ].filter(([, v]) => !isEmpty(v))

  return (
    <ProfileShell>
      <div className="max-w-5xl mx-auto px-3 py-5">
        <div className="mb-4">
          <h1 className="text-[26px] font-extrabold tracking-tight" style={{ color: T.text }}>Recruiting Guide</h1>
          <p className="text-[13px] mt-1" style={{ color: T.textMuted }}>
            In-depth program research: coaching, academics, cost, facilities, location, and on-field profile for every PNW program.
          </p>
        </div>

        <SectionCard>
          <div className="flex items-end gap-3">
            <div className="flex-1 min-w-0">
              <span className="text-[10.5px] font-bold uppercase tracking-widest" style={{ color: T.textLight }}>Program</span>
              <div className="mt-1"><TeamSelect teams={teams} value={teamId} onChange={setTeamId} T={T} /></div>
            </div>
            {isAdmin && teamId && program && !editing && (
              <button onClick={() => setEditing(true)}
                className="px-3.5 py-2.5 rounded-md text-[12px] font-bold shrink-0" style={{ background: T.track, color: T.text }}>
                Edit info
              </button>
            )}
          </div>
        </SectionCard>

        {!teamId && (
          <div className="text-center py-16 text-[13px]" style={{ color: T.textMuted }}>
            Choose a program above to open its full recruiting profile.
          </div>
        )}

        {teamId && loading && !guide && (
          <div className="text-center py-16 text-[13px]" style={{ color: T.textMuted }}>Loading program…</div>
        )}

        {teamId && guide && (
          <>
            <Hero teamInfo={teamInfo} program={program ? { ...program, profile } : null} T={T} />

            {isAdmin && editing && (
              <ProgramEditor teamId={teamId} profile={profile}
                onSaved={(p) => { setLocalProfile(p); setEditing(false) }}
                onCancel={() => setEditing(false)} T={T} />
            )}

            {!editing && (
              <>
                {glance.length > 0 && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                    {glance.map(([l, v]) => <StatTile key={l} label={l} value={v} T={T} />)}
                  </div>
                )}

                {!program && (
                  <SectionCard>
                    <div className="text-[12.5px] py-3 text-center" style={{ color: T.textMuted }}>
                      {isAdmin
                        ? 'No program profile yet for this team. Use “Edit info” to add it.'
                        : 'Full program profile coming soon for this team.'}
                    </div>
                  </SectionCard>
                )}

                {FIELD_GROUPS.map((g) => (
                  <ProgramGroup key={g.title} title={g.title} fields={g.fields} profile={profile} T={T} />
                ))}

                {/* On-field analytics */}
                <RecordTable records={guide.season_records} T={T} />
                <TrendCharts records={guide.season_records} warBySeason={guide.war_by_season} T={T} />
                <RosterOverview overview={guide.roster_overview} T={T} />
                <RosterComposition comp={guide.roster_composition} T={T} />
                <FreshmanProd fresh={guide.freshman_production} T={T} />
                <Hometowns breakdown={guide.hometown_breakdown} T={T} />
                <BestPlayers best={guide.best_players} T={T} />
              </>
            )}
          </>
        )}
      </div>
    </ProfileShell>
  )
}
