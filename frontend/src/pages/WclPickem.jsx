// WCL Pick 'Em — a weekly confidence pool for the West Coast League.
// WCL teams play 3-game series, so you pick a SERIES winner for every WCL series
// each week and rank them 1..N (no repeats). A correct series pick earns its
// confidence value. Lock in your whole card before the week's first series
// starts; after that it's view-only with results flowing in live.
//
// Backend: /api/v1/pickem/* (schedule + results from our own summer_games,
// grouped into series; only WCL-vs-WCL; a tie/split is a push).
// Original concept + UI by intern Luke Malzewski.

import { useEffect, useMemo, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import InternCredit from '../components/InternCredit'

const API = '/api/v1/pickem'

async function authHeaders() {
  try {
    const { data } = await supabase.auth.getSession()
    const t = data?.session?.access_token
    return t ? { Authorization: `Bearer ${t}` } : {}
  } catch { return {} }
}
async function getJSON(url) {
  // no-store: live pool data (schedule/results/leaderboard) — never serve stale cache.
  const r = await fetch(url, { headers: await authHeaders(), cache: 'no-store' })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`)
  return r.json()
}
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`)
  return j
}

const teamName = (s, id) => (id === s.away_team_id ? s.away_name : s.home_name)
const lastWord = (nm) => (nm || '').split(' ').slice(-1)[0].slice(0, 4)

export default function WclPickem() {
  const { user } = useAuth()
  const [tab, setTab] = useState('picks')
  const [weeks, setWeeks] = useState([])
  const [week, setWeek] = useState(null)
  const [series, setSeries] = useState([])
  const [myPicks, setMyPicks] = useState({})
  const [draft, setDraft] = useState({})
  const [name, setName] = useState(localStorage.getItem('pickem_name') || '')
  const [msg, setMsg] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getJSON(`${API}/weeks`).then(d => {
      setWeeks(d.weeks || [])
      setWeek(d.current || (d.weeks?.[d.weeks.length - 1]?.key))
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const loadWeek = useCallback(async (wk) => {
    if (!wk) return
    const d = await getJSON(`${API}/series?week=${wk}`)
    setSeries(d.series || [])
    if (user) {
      try {
        const mp = await getJSON(`${API}/my-picks?week=${wk}`)
        setMyPicks(mp.picks || {}); setDraft(mp.picks || {})
      } catch { setMyPicks({}); setDraft({}) }
    } else { setMyPicks({}); setDraft({}) }
  }, [user])

  useEffect(() => { if (week) loadWeek(week) }, [week, loadWeek])

  const weekOpen = series.length > 0 && series.every(s => !s.locked)
  const N = series.length
  const usedConf = useMemo(
    () => new Set(Object.values(draft).map(p => p.confidence).filter(Boolean)),
    [draft]
  )
  const draftComplete = series.length > 0 &&
    series.every(s => draft[s.id]?.pick_team_id && draft[s.id]?.confidence)

  function setPick(sid, teamId) {
    setDraft(d => ({ ...d, [sid]: { ...d[sid], pick_team_id: teamId } }))
  }
  function setConf(sid, val) {
    setDraft(d => {
      const next = { ...d }
      for (const k of Object.keys(next)) {
        if (k !== String(sid) && next[k]?.confidence === val) next[k] = { ...next[k], confidence: null }
      }
      next[sid] = { ...next[sid], confidence: val }
      return next
    })
  }

  async function submit() {
    setMsg(null)
    const nm = name.trim()
    if (!nm) { setMsg({ t: 'warn', m: 'Enter a display name first.' }); return }
    localStorage.setItem('pickem_name', nm)
    const picks = series.map(s => ({
      series_id: s.id, pick_team_id: draft[s.id].pick_team_id, confidence: draft[s.id].confidence,
    }))
    try {
      await postJSON(`${API}/picks`, { week, display_name: nm, picks })
      setMsg({ t: 'ok', m: '🔒 Picks locked in. Good luck!' })
      await loadWeek(week)
    } catch (e) { setMsg({ t: 'err', m: e.message }) }
  }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-12 text-center text-gray-500">Loading the pool…</div>

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <div className="flex items-center gap-2 mb-1">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">⚾ WCL Pick 'Em</h1>
        <span className="text-[11px] font-bold bg-nw-teal/10 text-nw-teal px-2 py-0.5 rounded-full">2026</span>
      </div>
      <p className="text-sm text-gray-500 mb-2">
        Pick a series winner for every WCL series each week and rank them 1–N (no repeats). Highest rank = most confident. Points tally automatically as series wrap up.
      </p>
      <InternCredit names="Luke Malzewski" className="mb-4" />

      <div className="flex border-b border-gray-200 dark:border-gray-700 mb-4">
        {[['picks', 'My Picks'], ['rankings', 'Rankings'], ['entries', 'All Entries']].map(([k, lbl]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === k ? 'border-nw-teal text-nw-teal font-semibold' : 'border-transparent text-gray-500 hover:text-gray-900'}`}>
            {lbl}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {weeks.map(w => (
          <button key={w.key} onClick={() => setWeek(w.key)}
            className={`px-3 py-1 text-xs rounded-full border ${w.key === week ? 'bg-nw-teal text-white border-nw-teal' : 'bg-gray-50 dark:bg-gray-800 text-gray-500 border-gray-300 dark:border-gray-600 hover:border-nw-teal'}`}>
            {w.label}
          </button>
        ))}
      </div>

      {tab === 'picks' && (
        <PicksView user={user} series={series} weekOpen={weekOpen} N={N}
          draft={draft} myPicks={myPicks} usedConf={usedConf} setPick={setPick} setConf={setConf}
          name={name} setName={setName} draftComplete={draftComplete} submit={submit} msg={msg} />
      )}
      {tab === 'rankings' && <RankingsView />}
      {tab === 'entries' && <EntriesView week={week} />}
    </div>
  )
}

// ── My Picks ──────────────────────────────────────────────────────
function PicksView({ user, series, weekOpen, N, draft, myPicks, usedConf, setPick, setConf, name, setName, draftComplete, submit, msg }) {
  if (!series.length) return <div className="text-center py-10 text-gray-500 text-sm">No WCL series scheduled for this week yet.</div>
  const submitted = Object.keys(myPicks).length > 0
  const editable = weekOpen && !!user

  return (
    <div>
      {!user && (
        <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm">
          <Link to="/login" className="font-semibold underline">Sign in</Link> to make your picks. You can still browse the rankings and everyone's entries.
        </div>
      )}
      {user && !weekOpen && (
        <div className="mb-4 p-3 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 text-sm">
          This week is locked — the first series has started. Picks are view-only; results update live.
        </div>
      )}
      {editable && (
        <div className="mb-4">
          <label className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Display name</label>
          <input value={name} onChange={e => setName(e.target.value)} maxLength={40} placeholder="e.g. Tyler S."
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-900" />
        </div>
      )}

      {series.map(s => {
        const mine = myPicks[s.id]
        const d = draft[s.id] || {}
        const win = s.winner_team_id
        const decided = s.status === 'final'
        return (
          <div key={s.id} className={`border rounded-lg mb-2.5 overflow-hidden ${(d.pick_team_id && d.confidence) ? 'border-nw-teal' : 'border-gray-200 dark:border-gray-700'}`}>
            <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-800 text-[11px] text-gray-400">
              <span>{s.label} · {s.games.length}-game series</span>
              <span>{decided ? (s.is_push ? 'Split' : '✓ Final') : s.status === 'in_progress' ? '● In progress' : (d.confidence ? `${d.confidence} pts` : 'Upcoming')}</span>
            </div>
            <div className="px-3 py-2.5">
              {/* matchup + series record */}
              <div className="flex items-center gap-2 mb-1.5">
                <SeriesTeam s={s} side="away" win={win} />
                <div className="flex flex-col items-center px-1">
                  <span className="text-sm font-bold text-gray-700 dark:text-gray-200">{s.away_wins}–{s.home_wins}</span>
                  <span className="text-[10px] text-gray-400">{decided ? 'final' : 'series'}</span>
                </div>
                <SeriesTeam s={s} side="home" win={win} align="right" />
              </div>

              {/* per-game scores */}
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-400 mb-2">
                {s.games.map((g, i) => (
                  <span key={i}>{g.date}: {g.away_score != null ? `${g.away_score}–${g.home_score}` : 'TBD'}</span>
                ))}
              </div>

              {/* pick the series winner */}
              <div className="flex gap-1.5 mb-1.5">
                {[s.away_team_id, s.home_team_id].map(tid => {
                  const picked = (mine ? mine.pick_team_id : d.pick_team_id) === tid
                  let result = ''
                  if (s.locked && mine) result = s.is_push ? 'push' : win ? (mine.pick_team_id === win ? 'correct' : 'wrong') : ''
                  let cls = 'border-gray-300 dark:border-gray-600 text-gray-600 bg-gray-50 dark:bg-gray-800'
                  if (picked && result === 'correct') cls = 'bg-green-100 border-green-600 text-green-900'
                  else if (picked && result === 'wrong') cls = 'bg-red-100 border-red-600 text-red-900 line-through'
                  else if (picked && result === 'push') cls = 'bg-gray-200 border-gray-400 text-gray-700'
                  else if (picked) cls = 'bg-nw-teal border-nw-teal text-white'
                  else if (s.locked) cls = 'opacity-40'
                  return (
                    <button key={tid} disabled={!editable} onClick={() => setPick(s.id, tid)}
                      className={`flex-1 px-2 py-2 text-sm font-medium rounded-md border-2 ${cls} ${editable ? 'hover:border-nw-teal' : 'cursor-default'}`}>
                      {teamName(s, tid)}
                    </button>
                  )
                })}
              </div>

              {editable ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] text-gray-400 w-16">Confidence</span>
                  <div className="flex gap-1 flex-wrap">
                    {Array.from({ length: N }, (_, i) => i + 1).map(num => {
                      const sel = d.confidence === num
                      const taken = usedConf.has(num) && !sel
                      return (
                        <button key={num} disabled={taken} onClick={() => setConf(s.id, num)}
                          className={`w-8 h-7 text-xs rounded-md border flex items-center justify-center ${sel ? 'bg-nw-teal border-nw-teal text-white font-semibold' : taken ? 'opacity-40 border-dashed border-gray-300 text-gray-300 cursor-not-allowed' : 'border-gray-300 dark:border-gray-600 text-gray-500 hover:border-nw-teal'}`}>
                          {num}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : mine ? (
                <div className="text-[11px] text-gray-500">
                  Picked <strong>{teamName(s, mine.pick_team_id)}</strong> · confidence <strong>{mine.confidence}</strong>
                  {decided ? (s.is_push
                    ? <span className="text-gray-500"> · push (split)</span>
                    : mine.pick_team_id === win
                      ? <span className="text-green-700 font-medium"> · +{mine.confidence} pts ✓</span>
                      : <span className="text-red-700"> · 0 pts ✗</span>)
                    : <span> · pending</span>}
                </div>
              ) : null}
            </div>
          </div>
        )
      })}

      {editable && (
        <div className="mt-4">
          {msg && <div className={`mb-2 p-2.5 rounded-md text-sm ${msg.t === 'ok' ? 'bg-green-50 text-green-800 border border-green-200' : msg.t === 'warn' ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>{msg.m}</div>}
          <button onClick={submit} disabled={!draftComplete}
            className={`w-full py-2.5 rounded-md text-sm font-semibold ${draftComplete ? 'bg-nw-teal text-white hover:bg-nw-teal-dark' : 'bg-gray-200 text-gray-400 cursor-default'}`}>
            {draftComplete ? (submitted ? '🔒 Update my picks' : '🔒 Lock in my picks') : `Pick & rank all ${N} series to submit`}
          </button>
        </div>
      )}
    </div>
  )
}

function SeriesTeam({ s, side, win, align }) {
  const id = side === 'away' ? s.away_team_id : s.home_team_id
  const logo = side === 'away' ? s.away_logo : s.home_logo
  const nm = side === 'away' ? s.away_name : s.home_name
  const isWin = win && win === id
  return (
    <div className={`flex items-center gap-1.5 flex-1 ${align === 'right' ? 'justify-end text-right' : ''}`}>
      {align === 'right' && <span className={`text-sm font-semibold ${isWin ? 'text-nw-teal' : 'text-gray-900 dark:text-gray-100'}`}>{nm}</span>}
      {logo && <img src={logo} alt="" className="w-5 h-5 object-contain" />}
      {align !== 'right' && <span className={`text-sm font-semibold ${isWin ? 'text-nw-teal' : 'text-gray-900 dark:text-gray-100'}`}>{nm}</span>}
    </div>
  )
}

// ── Rankings ──────────────────────────────────────────────────────
function RankingsView() {
  const [data, setData] = useState(null)
  useEffect(() => { getJSON(`${API}/leaderboard`).then(setData).catch(() => setData({ standings: [] })) }, [])
  if (!data) return <div className="text-center py-8 text-gray-500 text-sm">Loading…</div>
  const s = data.standings || []
  if (!s.length) return <div className="text-center py-10 text-gray-500 text-sm">No picks yet — be the first to enter!</div>
  const podium = s.slice(0, 3)
  const podOrder = podium.length >= 3 ? [podium[1], podium[0], podium[2]] : podium
  const medals = podium.length >= 3 ? ['🥈', '🥇', '🥉'] : ['🥇', '🥈', '🥉']
  return (
    <div>
      {podium.length > 0 && (
        <div className="flex gap-2 justify-center mb-4">
          {podOrder.map((p, i) => (
            <div key={i} className="flex-1 max-w-[180px] border rounded-lg p-3 text-center bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700">
              <div className="text-2xl">{medals[i]}</div>
              <div className="text-sm font-semibold truncate text-gray-900 dark:text-white">{p.name}</div>
              <div className="text-xl font-bold text-nw-teal">{p.total}</div>
              <div className="text-[11px] text-gray-400">{p.correct}W · {p.wrong}L · {p.pending} pend</div>
            </div>
          ))}
        </div>
      )}
      <div className="border rounded-lg overflow-hidden border-gray-200 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead><tr className="bg-gray-50 dark:bg-gray-800 text-[11px] text-gray-400 uppercase tracking-wide">
            <th className="text-left px-3 py-2">#</th><th className="text-left px-3 py-2">Player</th>
            <th className="text-right px-3 py-2">Pts</th><th className="text-right px-3 py-2">W</th>
            <th className="text-right px-3 py-2">L</th><th className="text-right px-3 py-2">Pend</th>
          </tr></thead>
          <tbody>
            {s.map((p, i) => (
              <tr key={i} className={`border-t border-gray-100 dark:border-gray-800 ${p.is_me ? 'bg-nw-teal/5' : ''}`}>
                <td className="px-3 py-2 text-gray-400">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</td>
                <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">{p.name}{p.is_me && <span className="text-[11px] text-nw-teal font-normal"> (you)</span>}</td>
                <td className="px-3 py-2 text-right font-bold text-nw-teal">{p.total}</td>
                <td className="px-3 py-2 text-right text-green-700 text-xs">{p.correct}</td>
                <td className="px-3 py-2 text-right text-red-700 text-xs">{p.wrong}</td>
                <td className="px-3 py-2 text-right text-gray-400 text-xs">{p.pending}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── All Entries ───────────────────────────────────────────────────
function EntriesView({ week }) {
  const [data, setData] = useState(null)
  useEffect(() => { if (week) getJSON(`${API}/entries?week=${week}`).then(setData).catch(() => setData({ entries: [], series: [] })) }, [week])
  if (!data) return <div className="text-center py-8 text-gray-500 text-sm">Loading…</div>
  const { series = [], entries = [] } = data
  if (!entries.length) return <div className="text-center py-10 text-gray-500 text-sm">No entries for this week yet.</div>
  return (
    <div>
      <p className="text-xs text-gray-400 mb-2">Picks stay hidden until each series starts. Green = correct, red = wrong, gray = push.</p>
      <div className="overflow-x-auto border rounded-lg border-gray-200 dark:border-gray-700">
        <table className="text-xs border-collapse min-w-full">
          <thead><tr className="bg-gray-50 dark:bg-gray-800">
            <th className="text-left px-2 py-1.5 sticky left-0 bg-gray-50 dark:bg-gray-800">Player</th>
            {series.map(s => (
              <th key={s.id} className="px-2 py-1.5 text-center text-[10px] text-gray-500 whitespace-nowrap">
                {lastWord(s.away_name)}@{lastWord(s.home_name)}
                {s.winner_team_id
                  ? <div className="text-green-700">{lastWord(teamName(s, s.winner_team_id))}✓</div>
                  : s.is_push ? <div className="text-gray-400">split</div> : null}
              </th>
            ))}
            <th className="px-2 py-1.5 text-right">Pts</th>
          </tr></thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i} className={e.is_me ? 'bg-nw-teal/5' : ''}>
                <td className="px-2 py-1.5 font-semibold whitespace-nowrap sticky left-0 bg-inherit text-gray-900 dark:text-gray-100">{e.name}{e.is_me && <span className="text-[10px] text-nw-teal"> you</span>}</td>
                {series.map(s => {
                  const p = e.picks[s.id]
                  if (!p) return <td key={s.id} className="px-2 py-1.5 text-center text-gray-300">–</td>
                  const cls = p.result === 'win' ? 'bg-green-100 text-green-900' : p.result === 'loss' ? 'bg-red-100 text-red-900' : p.result === 'push' ? 'bg-gray-100 text-gray-500' : ''
                  return (
                    <td key={s.id} className={`px-2 py-1.5 text-center ${cls}`}>
                      {p.hidden ? <span className="text-gray-400">🔒</span> : <><div className="font-semibold">{lastWord(teamName(s, p.pick_team_id))}</div><div className="text-[10px] text-gray-400">{p.confidence}</div></>}
                    </td>
                  )
                })}
                <td className="px-2 py-1.5 text-right font-bold text-nw-teal">{e.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
