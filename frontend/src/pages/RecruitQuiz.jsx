// Recruit Matchmaker — a quiz that ranks all 57 NW college programs
// (D1/D2/D3/NAIA/NWAC) by fit. Restyled from the intern's prototype and wired so
// each match links to its NWBB team page + recruiting questionnaire. Records and
// win rates come from our real game data; any question can be flagged a
// "dealbreaker" to hard-filter the results.

import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { RECRUIT_QUESTIONS, RECRUIT_SCHOOLS, REAL_RECORDS_2026 } from '../data/recruitQuiz'
import { usePersistedState } from '../hooks/usePersistedState'
import InternCredit from '../components/InternCredit'

const LEVEL_CHIP = {
  D1:   'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  D2:   'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  D3:   'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
  NAIA: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  NWAC: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
}
// Parse a "YEAR: W-L" segment out of a record string into a win rate (0-1).
function parseWinRate(rec, year) {
  const m = (rec || '').match(new RegExp(`${year}:\\s*(\\d+)-(\\d+)`))
  if (!m) return null
  const w = +m[1], l = +m[2]
  return (w + l) > 0 ? w / (w + l) : null
}

// Records: override the stale spreadsheet 2026 W-L with our real DB result, then
// compute a "right now" win rate as the average of the 2025 and 2026 win
// percentages. (2024/2025 are kept from the sheet for display — our older-season
// game coverage is partial for the Nuxt D1 schools, so the sheet is more reliable.)
function withRealRecord(s) {
  let record = s.record
  const real = REAL_RECORDS_2026[s.teamId]
  if (real) {
    const [w, l] = real.split('-').map(Number)
    const token = `2026: ${w}-${l}`
    record = /2026:\s*\d+-\d+/.test(s.record || '')
      ? s.record.replace(/2026:\s*\d+-\d+/, token)
      : (s.record ? `${token}; ${s.record}` : token)
  }
  const rates = [parseWinRate(record, 2025), parseWinRate(record, 2026)].filter(v => v != null)
  const winRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null
  const winRatePct = winRate == null ? null : Math.round(winRate * 100)
  return { ...s, record, winRate, winRatePct }
}

// ── Weighted fit scoring ──
// Returns { pct, cats } where cats[questionKey] = { earned, possible }. The
// per-category breakdown powers both the overall % (sum earned / sum possible,
// skipping categories a school has no data for) and the dealbreaker filter (a
// school "satisfies" a dealbreaker question when it earns >= half that
// category's points). Multi-select takes the best match across the user's picks.
function scoreSchool(s, a) {
  const cats = {}
  const match = (key, weight, fn) => { cats[key] = { earned: fn(), possible: weight } }
  const arr = v => (Array.isArray(v) ? v : v == null ? [] : [v])

  match('level', 35, () => {
    const picked = arr(a.level)
    if (picked.includes('ANY')) return 20
    if (picked.includes(s.level)) return 35
    if (picked.includes('D1') && s.level === 'D2') return 8
    if (picked.includes('D2') && (s.level === 'D1' || s.level === 'D3')) return 5
    if (picked.includes('D3') && (s.level === 'D2' || s.level === 'NAIA')) return 5
    if (picked.includes('NAIA') && (s.level === 'D3' || s.level === 'NWAC')) return 5
    if (picked.includes('NWAC') && s.level === 'NAIA') return 5
    return 0
  })

  match('state', 20, () => {
    const picked = arr(a.state)
    if (picked.includes('ANY')) return 12
    if (picked.includes(s.state)) return 20
    if (picked.includes('WA_OR') && (s.state === 'WA' || s.state === 'OR')) return 20
    if (picked.includes('ID_MT') && (s.state === 'ID' || s.state === 'MT')) return 20
    if (picked.includes('WA_OR')) return 3
    return 0
  })

  match('aid', 12, () => {
    const picked = arr(a.aid)
    if (!picked.length) return 0
    const score = v => {
      if (v === 'scholarship' && s.aid === 'scholarship') return 12
      if (v === 'needbased' && s.aid === 'needbased') return 12
      if (v === 'nice' || v === 'none') return 8
      if (v === 'needbased' && s.aid === 'none') return 4
      return 0
    }
    return Math.max(...picked.map(score))
  })

  if (s.tuition !== 'unknown') {
    match('tuition', 8, () => {
      const picked = arr(a.tuition)
      if (picked.includes('ANY')) return 5
      const tc = ['verylow', 'low', 'moderate', 'high', 'veryhigh']
      return Math.max(...picked.map(v => { const d = Math.abs(tc.indexOf(v) - tc.indexOf(s.tuition)); return d === 0 ? 8 : d === 1 ? 4 : d === 2 ? 2 : 0 }), 0)
    })
  }
  if (s.enrollment !== 'unknown') {
    match('campus', 8, () => {
      const picked = arr(a.campus)
      if (picked.includes('ANY')) return 5
      const sz = ['small', 'medium', 'large', 'xlarge']
      return Math.max(...picked.map(v => { const d = Math.abs(sz.indexOf(v) - sz.indexOf(s.enrollment)); return d === 0 ? 8 : d === 1 ? 4 : d === 2 ? 2 : 0 }), 0)
    })
  }
  if (s.campus !== 'unknown') {
    match('setting', 7, () => {
      const picked = arr(a.setting)
      if (picked.includes('ANY')) return 4
      if (picked.includes(s.campus)) return 7
      if (picked.some(v => (v === 'urban' && s.campus === 'suburban') || (v === 'suburban' && s.campus === 'urban'))) return 3
      return 0
    })
  }
  if (s.schoolType !== 'unknown') {
    match('schoolType', 8, () => {
      const picked = arr(a.schoolType)
      if (picked.includes('ANY')) return 5
      if (picked.includes(s.schoolType)) return 8
      if (picked.includes('private') && s.schoolType === 'christian') return 4
      if (picked.includes('christian') && s.schoolType === 'private') return 4
      return 0
    })
  }
  if (s.accept !== 'unknown') {
    match('accept', 5, () => {
      const picked = arr(a.accept)
      if (picked.includes('ANY')) return 3
      const ac = ['open', 'easy', 'moderate', 'selective', 'veryselective']
      return Math.max(...picked.map(v => { const d = Math.abs(ac.indexOf(v) - ac.indexOf(s.accept)); return d === 0 ? 5 : d === 1 ? 3 : 0 }), 0)
    })
  }
  if (s.sfr !== 'unknown') {
    match('sfrPref', 7, () => {
      const picked = arr(a.sfrPref)
      if (picked.includes('ANY')) return 4
      const sr = ['small', 'medium', 'large']
      return Math.max(...picked.map(v => { const d = Math.abs(sr.indexOf(v) - sr.indexOf(s.sfr)); return d === 0 ? 7 : d === 1 ? 3 : 0 }), 0)
    })
  }
  if (s.gradProfile !== 'unknown') {
    match('gradPref', 6, () => {
      if (a.gradPref === 'ANY') return 3
      if (a.gradPref === 'high' && s.gradProfile === 'high') return 6
      if (a.gradPref === 'high' && s.gradProfile === 'mid') return 2
      if (a.gradPref === 'mid' && (s.gradProfile === 'high' || s.gradProfile === 'mid')) return 6
      return 0
    })
  }
  if (s.coachTenure !== 'unknown') {
    match('coachTenure', 7, () => {
      const picked = arr(a.coachTenure)
      if (picked.includes('ANY')) return 4
      if (picked.includes(s.coachTenure)) return 7
      const to = ['new', 'newer', 'established', 'veteran']
      return Math.max(...picked.map(v => { const d = Math.abs(to.indexOf(v) - to.indexOf(s.coachTenure)); return d === 1 ? 3 : 0 }), 0)
    })
  }
  if (s.staffSize !== 'unknown') {
    match('staffSize', 6, () => {
      const picked = arr(a.staffSize)
      if (picked.includes('ANY')) return 3
      const ss = ['small', 'mid', 'large']
      return Math.max(...picked.map(v => { const d = Math.abs(ss.indexOf(v) - ss.indexOf(s.staffSize)); return d === 0 ? 6 : d === 1 ? 3 : 0 }), 0)
    })
  }
  if (s.winRate != null) {
    match('winProfile', 7, () => {
      if (a.winProfile === 'contender') return s.winRate >= 0.50 ? 7 : s.winRate >= 0.40 ? 3 : 0
      if (a.winProfile === 'notbad') return s.winRate >= 0.35 ? 7 : s.winRate >= 0.30 ? 3 : 0
      return 4 // "doesn't matter" or unanswered
    })
  }
  if (s.airportDist !== 'unknown') {
    match('airportPref', 7, () => {
      const picked = arr(a.airportPref)
      if (picked.includes('ANY')) return 4
      const ad = ['close', 'moderate', 'far']
      return Math.max(...picked.map(v => { if (v === s.airportDist) return 7; const d = Math.abs(ad.indexOf(v) - ad.indexOf(s.airportDist)); return d === 1 ? 3 : 0 }), 0)
    })
  }
  match('stats', 7, () => {
    const stMap = { D1: ['elite', 'above'], D2: ['above', 'avg'], D3: ['above', 'avg'], NAIA: ['above', 'avg'], NWAC: ['avg', 'project'] }
    const good = stMap[s.level] || []
    const picked = arr(a.stats)
    if (!picked.length) return 4
    if (picked.some(v => good.includes(v))) return 7
    if (picked.some(v => v === 'elite') && good.includes('above')) return 3
    if (picked.some(v => v === 'project') && good.includes('avg')) return 3
    return 1
  })

  let earned = 0, possible = 0
  for (const k in cats) { earned += cats[k].earned; possible += cats[k].possible }
  return { pct: possible > 0 ? Math.round((earned / possible) * 100) : 0, cats }
}

// Questions that can be toggled into a hard "dealbreaker" filter. (The closing
// self-assessment 'stats' question is about the player, not the school.)
const DEALBREAKER_KEYS = new Set([
  'level', 'state', 'aid', 'tuition', 'campus', 'setting', 'schoolType',
  'accept', 'sfrPref', 'gradPref', 'coachTenure', 'staffSize', 'winProfile', 'airportPref',
])
// A real (non-empty, non-"ANY") answer is required for a dealbreaker to bite.
function hasRealPick(v) {
  if (Array.isArray(v)) return v.length > 0 && !v.includes('ANY')
  return v != null && v !== 'ANY'
}

function Pill({ children, tone = 'tl' }) {
  const tones = {
    tl: 'bg-teal-50 border-teal-200 text-teal-800 dark:bg-teal-900/30 dark:border-teal-800 dark:text-teal-300',
    bl: 'bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-900/30 dark:border-blue-800 dark:text-blue-300',
    am: 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-900/30 dark:border-amber-800 dark:text-amber-300',
    gr: 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-900/30 dark:border-emerald-800 dark:text-emerald-300',
    gy: 'bg-gray-100 border-gray-200 text-gray-600 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-300',
  }
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${tones[tone]}`}>{children}</span>
}

const AID_LABEL = {
  scholarship: 'Athletic scholarships',
  needbased: 'Need-based aid',
  nice: 'Some athletic aid',
  none: 'No athletic aid',
}
const cap = (v) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : v)

// Expanded "everything we know" panel for a matched program. Pulls the curated
// program data (built from the recruiting-guide spreadsheet) into labeled
// sections; empty fields are skipped so sparse programs degrade gracefully.
function ProgramDetail({ s }) {
  const sections = [
    ['Baseball Program', [
      ['Head Coach', s.coach],
      ['Alma Mater', s.coachAlma],
      ['Tenure', s.coachYears],
      ['Coaching Staff', s.staffSizeRaw && s.staffSizeRaw !== '0' ? `${s.staffSizeRaw} coaches` : null],
      ['Recent Record', s.record],
      ['Win Rate (2025-26 avg)', s.winRatePct != null ? `${s.winRatePct}%` : null],
      ['Home Field', s.stadium ? (s.capacity ? `${s.stadium} · seats ${s.capacity}` : s.stadium) : null],
      ['Scholarships', s.scholarshipInfo],
    ]],
    ['Academics', [
      ['School Type', s.schoolTypeRaw],
      ['Undergrad Enrollment', s.enrollRaw && s.enrollRaw !== '0' ? `${Number(s.enrollRaw).toLocaleString()} students` : null],
      ['Student-to-Faculty', s.sfrRaw],
      ['Acceptance Rate', s.acceptRaw],
      ['Graduation Rate', s.gradRate],
      ['Top Majors', s.majors],
    ]],
    ['Cost & Location', [
      ['Out-of-State Tuition', s.tuitionRaw],
      ['Financial Aid', AID_LABEL[s.aid]],
      ['Location', s.location],
      ['Campus Setting', cap(s.campus)],
      ['Nearest Airport', s.airportRaw],
      ['Distance from City', s.distCityRaw],
    ]],
  ]
  return (
    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
      <div className="grid sm:grid-cols-3 gap-x-5 gap-y-4">
        {sections.map(([title, rows]) => {
          const filled = rows.filter(([, v]) => v != null && v !== '' && v !== 'unknown')
          if (!filled.length) return null
          return (
            <div key={title}>
              <div className="text-[10px] font-bold uppercase tracking-widest text-nw-teal mb-1.5">{title}</div>
              <dl className="space-y-1.5">
                {filled.map(([label, value]) => (
                  <div key={label} className="text-[12px] leading-snug">
                    <dt className="text-gray-400 dark:text-gray-500">{label}</dt>
                    <dd className="font-semibold text-gray-700 dark:text-gray-200">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )
        })}
      </div>

      {/* CTAs: deep recruiting guide, team page, recruiting questionnaire */}
      <div className="flex flex-wrap items-center gap-2.5 mt-4">
        {s.teamId && (
          <Link to={`/recruiting/guide?team=${s.teamId}`}
            className="inline-flex items-center gap-1 text-xs font-bold rounded-lg bg-nw-teal text-white px-3 py-1.5 hover:bg-nw-teal-dark transition-colors">
            Full recruiting guide →
          </Link>
        )}
        {s.teamId && (
          <Link to={`/team/${s.teamId}`}
            className="inline-flex items-center gap-1 text-xs font-semibold rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 px-3 py-1.5 hover:border-nw-teal hover:text-nw-teal transition-colors">
            Team page & stats →
          </Link>
        )}
        {s.recruitURL && (
          <a href={s.recruitURL} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-semibold rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 px-3 py-1.5 hover:border-nw-teal hover:text-nw-teal transition-colors">
            Recruiting questionnaire →
          </a>
        )}
      </div>
    </div>
  )
}

export default function RecruitQuiz() {
  // Answers, dealbreakers, and completion persist to localStorage so returning to
  // the Matchmaker lands on your saved results until you clear them and retake.
  const [ans, setAns] = usePersistedState('matchmaker_answers', {}, { storage: 'local' })
  const [dealbreakers, setDealbreakers] = usePersistedState('matchmaker_dealbreakers', {}, { storage: 'local' })
  const [done, setDone] = usePersistedState('matchmaker_done', false, { storage: 'local' })
  // Land on the last question (not Q1) if reopening a completed quiz and hitting Back.
  const [step, setStep] = useState(done ? RECRUIT_QUESTIONS.length - 1 : 0)
  const [expanded, setExpanded] = useState({}) // program name -> open?
  const toggleDetail = (name) => setExpanded(p => ({ ...p, [name]: !p[name] }))
  const toggleDealbreaker = (key) => setDealbreakers(p => ({ ...p, [key]: !p[key] }))

  const q = RECRUIT_QUESTIONS[step]
  const total = RECRUIT_QUESTIONS.length

  // Active dealbreakers = toggled on AND with a real (non-ANY) answer.
  const activeDealbreakers = useMemo(
    () => RECRUIT_QUESTIONS.filter(qq => dealbreakers[qq.key] && hasRealPick(ans[qq.key])),
    [dealbreakers, ans],
  )

  const { results, dbFellBack } = useMemo(() => {
    if (!done) return { results: [], dbFellBack: false }
    const scored = RECRUIT_SCHOOLS
      .map(withRealRecord)
      .map(s => { const r = scoreSchool(s, ans); return { ...s, pct: r.pct, cats: r.cats } })
      .sort((a, b) => b.pct - a.pct)

    // Dealbreakers: drop any school that doesn't at least half-satisfy a flagged
    // question (cats[key].earned >= half its points). Missing data passes.
    const dbKeys = activeDealbreakers.map(qq => qq.key)
    const passes = s => dbKeys.every(k => {
      const c = s.cats[k]
      return !c || c.possible === 0 || c.earned >= 0.5 * c.possible
    })
    let pool = dbKeys.length ? scored.filter(passes) : scored
    let fellBack = false
    if (dbKeys.length && pool.length === 0) { pool = scored; fellBack = true } // never show nothing

    // Diversify: guarantee the best match at each surviving level, then fill with
    // the next-highest scorers. Re-sorted by fit for display.
    const N = 8
    const bestPerLevel = []
    const seen = new Set()
    for (const s of pool) { if (!seen.has(s.level)) { seen.add(s.level); bestPerLevel.push(s) } }
    const fillers = pool.filter(s => !bestPerLevel.includes(s)).slice(0, Math.max(0, N - bestPerLevel.length))
    return { results: [...bestPerLevel, ...fillers].sort((a, b) => b.pct - a.pct), dbFellBack: fellBack }
  }, [done, ans, activeDealbreakers])

  const pick = (question, val) => {
    setAns(prev => {
      if (!question.multi) return { ...prev, [question.key]: val }
      const cur = Array.isArray(prev[question.key]) ? prev[question.key] : []
      let next
      if (val === 'ANY') next = cur.includes('ANY') ? [] : ['ANY']
      else next = cur.includes(val) ? cur.filter(v => v !== val) : [...cur.filter(v => v !== 'ANY'), val]
      return { ...prev, [question.key]: next }
    })
  }

  const isSel = (question, val) =>
    question.multi ? (ans[question.key] || []).includes(val) : ans[question.key] === val
  const answered = q && (q.multi ? (ans[q.key] || []).length > 0 : ans[q.key] != null)

  const next = () => { if (step < total - 1) setStep(step + 1); else setDone(true) }
  const back = () => { if (done) setDone(false); else if (step > 0) setStep(step - 1) }
  const restart = () => { setStep(0); setAns({}); setDone(false); setExpanded({}); setDealbreakers({}); window.scrollTo(0, 0) }

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 py-6">
      {/* Hero */}
      <div className="text-center mb-6">
        <div className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-nw-teal bg-teal-50 dark:bg-teal-900/30 px-3 py-1 rounded-full mb-3">
          Recruit Matchmaker
        </div>
        <h1 className="text-3xl sm:text-4xl font-black text-nw-teal dark:text-gray-100 leading-tight">
          Find your best-fit <span className="text-nw-teal">NW program</span>
        </h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 max-w-md mx-auto">
          Answer what matters to you and we'll rank all 57 college baseball programs across WA, OR, ID, MT &amp; BC.
        </p>
        <InternCredit names="Luke Malzewski" className="mt-2" />
        <div className="flex items-center justify-center gap-6 mt-4">
          {[['57', 'Programs'], ['5', 'Levels'], ['15', 'Questions']].map(([n, l]) => (
            <div key={l} className="text-center">
              <div className="text-xl font-black text-nw-teal">{n}</div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400">{l}</div>
            </div>
          ))}
        </div>
      </div>

      {!done ? (
        /* ── Quiz card ── */
        <div className="rounded-2xl bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 shadow-sm p-5 sm:p-7">
          <div className="flex items-center gap-3 mb-5">
            <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-nw-teal to-teal-300 rounded-full transition-all duration-300"
                   style={{ width: `${((step + 1) / total) * 100}%` }} />
            </div>
            <div className="text-xs text-gray-400 dark:text-gray-500 tabular-nums whitespace-nowrap">{step + 1} / {total}</div>
          </div>

          <div className="text-[10px] font-bold uppercase tracking-widest text-nw-teal mb-1">{q.cat}</div>
          <div className="text-lg sm:text-xl font-bold text-nw-teal dark:text-gray-100 leading-snug mb-2">{q.text}</div>
          {q.hint && (
            <div className="text-[13px] text-gray-500 dark:text-gray-400 mb-4 px-3 py-2 bg-teal-50/60 dark:bg-teal-900/20 border-l-2 border-teal-300 dark:border-teal-700 rounded-r">
              {q.hint}
            </div>
          )}

          <div className="flex flex-col gap-2">
            {q.answers.map((opt, i) => {
              const sel = isSel(q, opt.value)
              return (
                <button
                  key={opt.value}
                  onClick={() => pick(q, opt.value)}
                  className={`flex items-center gap-3 text-left rounded-xl border px-3.5 py-3 text-sm transition-colors w-full
                    ${sel
                      ? 'border-nw-teal bg-teal-50 dark:bg-teal-900/30 text-nw-teal dark:text-gray-100 ring-2 ring-nw-teal/30'
                      : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-nw-teal hover:bg-teal-50/40 dark:hover:bg-teal-900/20'}`}
                >
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 border
                    ${sel ? 'bg-nw-teal text-white border-nw-teal' : 'bg-white dark:bg-gray-800 text-gray-400 border-gray-300 dark:border-gray-600'}`}>
                    {q.multi ? (sel ? '✓' : '') : String.fromCharCode(65 + i)}
                  </span>
                  <span className="leading-snug">{opt.label}</span>
                </button>
              )
            })}
          </div>

          {DEALBREAKER_KEYS.has(q.key) && (
            <button
              type="button"
              onClick={() => toggleDealbreaker(q.key)}
              disabled={!hasRealPick(ans[q.key])}
              className={`flex items-center gap-2.5 mt-3 w-full text-left rounded-lg border px-3 py-2.5 text-[13px] transition-colors
                ${dealbreakers[q.key]
                  ? 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-900/30 dark:text-rose-200'
                  : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-rose-300 disabled:opacity-50 disabled:hover:border-gray-200'}`}
            >
              <span className={`w-4 h-4 rounded flex items-center justify-center text-[10px] font-bold shrink-0 border
                ${dealbreakers[q.key] ? 'bg-rose-500 text-white border-rose-500' : 'border-gray-300 dark:border-gray-600'}`}>
                {dealbreakers[q.key] ? '✓' : ''}
              </span>
              <span className="leading-snug">
                <span className="font-semibold">Dealbreaker</span> · only show schools that match my answer here
                {!hasRealPick(ans[q.key]) && <span className="opacity-70"> (pick a specific answer first)</span>}
              </span>
            </button>
          )}

          <div className="flex items-center justify-between mt-6 pt-4 border-t border-gray-100 dark:border-gray-700">
            <button onClick={back} disabled={step === 0}
              className="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 disabled:opacity-40 hover:border-gray-400 dark:hover:border-gray-500 transition-colors">
              Back
            </button>
            <button onClick={next} disabled={!answered}
              className="px-7 py-2.5 text-sm font-semibold rounded-lg bg-nw-teal text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-nw-teal-dark transition-colors">
              {step === total - 1 ? 'See my matches' : 'Next'}
            </button>
          </div>
        </div>
      ) : (
        /* ── Results ── */
        <div>
          <div className="mb-4">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-2xl font-black text-nw-teal dark:text-gray-100">Your top program matches</h2>
              <button onClick={restart}
                className="shrink-0 mt-1 text-xs font-semibold text-gray-500 dark:text-gray-400 hover:text-rose-600 dark:hover:text-rose-400 underline decoration-dotted underline-offset-2 whitespace-nowrap">
                Clear &amp; retake
              </button>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              Saved from your last quiz, ranked by fit across all five levels (D1, D2, D3, NAIA, NWAC), including your best option at each. Tap a school to see its full NWBB profile.
            </p>
            {activeDealbreakers.length > 0 && !dbFellBack && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                <span className="font-semibold">Dealbreakers applied:</span>
                {activeDealbreakers.map(qq => (
                  <span key={qq.key} className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800">{qq.cat}</span>
                ))}
              </div>
            )}
            {dbFellBack && (
              <div className="mt-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                No school met every dealbreaker, so we loosened them and ranked your closest fits instead. Try removing one to tighten the list.
              </div>
            )}
          </div>

          <div className="space-y-2.5">
            {results.map((s, i) => {
              const open = expanded[s.name] ?? (i === 0)
              return (
              <div key={s.name}
                className={`rounded-xl bg-white dark:bg-gray-800 ring-1 p-4 transition-shadow hover:shadow-md
                  ${i === 0 ? 'ring-2 ring-nw-teal' : 'ring-gray-200 dark:ring-gray-700'}`}>
                <div className="flex items-start gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0
                    ${i === 0 ? 'bg-nw-teal text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`}>
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {s.teamId
                        ? <Link to={`/team/${s.teamId}`} className="font-bold text-nw-teal dark:text-gray-100 hover:text-nw-teal">{s.name}</Link>
                        : <span className="font-bold text-nw-teal dark:text-gray-100">{s.name}</span>}
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${LEVEL_CHIP[s.level] || ''}`}>{s.level}</span>
                      {i === 0 && <span className="text-[10px] font-bold uppercase tracking-wide bg-nw-teal text-white px-2 py-0.5 rounded-full">Best Match</span>}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{s.location} · {s.conference}</div>

                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {s.enrollRaw && <Pill tone="tl">{s.enrollRaw} students</Pill>}
                      {s.sfrRaw && <Pill tone="bl">{s.sfrRaw} student:faculty</Pill>}
                      {s.winRatePct != null && <Pill tone="am">{s.winRatePct}% win rate</Pill>}
                      {s.gradRate && <Pill tone="gr">{s.gradRate} grad rate</Pill>}
                      {s.schoolTypeRaw && <Pill tone="gy">{s.schoolTypeRaw}</Pill>}
                    </div>

                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                      Coach: <span className="font-semibold text-gray-700 dark:text-gray-200">{s.coach || 'N/A'}</span>
                      {s.coachYears ? ` · ${s.coachYears}` : ''}
                      {s.staffSizeRaw ? ` · ${s.staffSizeRaw} coaches` : ''}
                    </div>

                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {s.tuitionRaw && <span className="text-[11px] text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-700 rounded-full px-2 py-0.5">{s.tuitionRaw} OOS tuition</span>}
                      {s.scholarshipInfo && <span className="text-[11px] text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-700 rounded-full px-2 py-0.5">{s.scholarshipInfo}</span>}
                      {s.stadium && <span className="text-[11px] text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-700 rounded-full px-2 py-0.5">{s.stadium}</span>}
                    </div>

                    <button onClick={() => toggleDetail(s.name)}
                      aria-expanded={open}
                      className="flex items-center gap-1.5 mt-2.5 text-xs font-bold text-nw-teal hover:underline">
                      {open ? 'Hide full breakdown' : 'View full breakdown'}
                      <span className={`transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
                    </button>
                  </div>
                  <div className="flex flex-col items-center shrink-0">
                    <div className="text-xl font-black text-nw-teal leading-none">{s.pct}%</div>
                    <div className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mt-1">match</div>
                  </div>
                </div>

                {open && <ProgramDetail s={s} />}
              </div>
              )
            })}
          </div>

          <div className="mt-5 rounded-xl bg-gradient-to-br from-nw-teal to-[#1f3a4d] dark:from-gray-900 dark:to-gray-800 p-5 flex items-center justify-between gap-4 flex-wrap">
            <div className="text-white">
              <div className="font-bold">Dig deeper on your matches</div>
              <p className="text-sm text-white/70 mt-0.5">Every NW program has full stats, rosters, and analytics on NW Baseball Stats.</p>
            </div>
            <Link to="/teams" className="bg-white text-nw-teal font-bold text-sm rounded-lg px-4 py-2 hover:bg-teal-50 transition-colors whitespace-nowrap">
              Browse all teams →
            </Link>
          </div>

          <button onClick={restart}
            className="mt-3 w-full py-2.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-rose-300 hover:text-rose-600 dark:hover:text-rose-400 transition-colors">
            Clear my saved answers and retake the quiz
          </button>
        </div>
      )}
    </div>
  )
}
