// WCL Pick 'Em — a weekly confidence pool for the West Coast League.
// Each week you pick a winner for every WCL game and rank your picks 1..N
// (no repeats). Correct picks earn their confidence value. You lock in your
// whole card before the week's first game starts; after that it's view-only
// with results flowing in live from our own summer-ball data.
//
// Backend: /api/v1/pickem/* (schedule + results come straight from summer_games).
// Original concept + UI by intern Luke Malzewski; productionized onto our stack
// (Supabase-auth identity, server-side scoring, anti-copy pick hiding).

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
  // no-store: these are live pool endpoints (schedule/results/leaderboard) —
  // never serve a stale browser-cached copy.
  const r = await fetch(url, { headers: await authHeaders(), cache: 'no-store' })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`)
  return r.json()
}
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`)
  return j
}

const teamName = (g, id) => (id === g.away_team_id ? g.away_name : g.home_name)

export default function WclPickem() {
  const { user } = useAuth()
  const [tab, setTab] = useState('picks')
  const [weeks, setWeeks] = useState([])
  const [week, setWeek] = useState(null)
  const [games, setGames] = useState([])
  const [myPicks, setMyPicks] = useState({})       // { game_id: {pick_team_id, confidence} }
  const [draft, setDraft] = useState({})            // unsaved working picks
  const [name, setName] = useState(localStorage.getItem('pickem_name') || '')
  const [msg, setMsg] = useState(null)
  const [loading, setLoading] = useState(true)

  // ── Load weeks once, pick the current one ──
  useEffect(() => {
    getJSON(`${API}/weeks`).then(d => {
      setWeeks(d.weeks || [])
      setWeek(d.current || (d.weeks?.[d.weeks.length - 1]?.key))
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const loadWeek = useCallback(async (wk) => {
    if (!wk) return
    const g = await getJSON(`${API}/games?week=${wk}`)
    setGames(g.games || [])
    if (user) {
      try {
        const mp = await getJSON(`${API}/my-picks?week=${wk}`)
        setMyPicks(mp.picks || {})
        setDraft(mp.picks || {})
      } catch { setMyPicks({}); setDraft({}) }
    } else { setMyPicks({}); setDraft({}) }
  }, [user])

  useEffect(() => { if (week) loadWeek(week) }, [week, loadWeek])

  const weekOpen = games.length > 0 && games.every(g => !g.locked)
  const N = games.length
  const usedConf = useMemo(
    () => new Set(Object.values(draft).map(p => p.confidence).filter(Boolean)),
    [draft]
  )
  const draftComplete = games.length > 0 &&
    games.every(g => draft[g.id]?.pick_team_id && draft[g.id]?.confidence)

  function setPick(gid, teamId) {
    setDraft(d => ({ ...d, [gid]: { ...d[gid], pick_team_id: teamId } }))
  }
  function setConf(gid, val) {
    setDraft(d => {
      const next = { ...d }
      // remove this number from any other game
      for (const k of Object.keys(next)) {
        if (k !== String(gid) && next[k]?.confidence === val) next[k] = { ...next[k], confidence: null }
      }
      next[gid] = { ...next[gid], confidence: val }
      return next
    })
  }

  async function submit() {
    setMsg(null)
    const nm = name.trim()
    if (!nm) { setMsg({ t: 'warn', m: 'Enter a display name first.' }); return }
    localStorage.setItem('pickem_name', nm)
    const picks = games.map(g => ({
      game_id: g.id,
      pick_team_id: draft[g.id].pick_team_id,
      confidence: draft[g.id].confidence,
    }))
    try {
      await postJSON(`${API}/picks`, { week, display_name: nm, picks })
      setMsg({ t: 'ok', m: '🔒 Picks locked in. Good luck!' })
      await loadWeek(week)
    } catch (e) {
      setMsg({ t: 'err', m: e.message })
    }
  }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-12 text-center text-gray-500">Loading the pool…</div>

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <div className="flex items-center gap-2 mb-1">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">⚾ WCL Pick 'Em</h1>
        <span className="text-[11px] font-bold bg-nw-teal/10 text-nw-teal px-2 py-0.5 rounded-full">2026</span>
      </div>
      <p className="text-sm text-gray-500 mb-2">
        Pick a winner for every WCL game each week and rank them 1–N (no repeats). Highest rank = most confident. Points tally automatically as results come in.
      </p>
      <InternCredit names="Luke Malzewski" className="mb-4" />

      {/* Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 mb-4">
        {[['picks', 'My Picks'], ['rankings', 'Rankings'], ['entries', 'All Entries']].map(([k, lbl]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === k ? 'border-nw-teal text-nw-teal font-semibold' : 'border-transparent text-gray-500 hover:text-gray-900'}`}>
            {lbl}
          </button>
        ))}
      </div>

      {/* Week selector */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {weeks.map(w => (
          <button key={w.key} onClick={() => setWeek(w.key)}
            className={`px-3 py-1 text-xs rounded-full border ${w.key === week ? 'bg-nw-teal text-white border-nw-teal' : 'bg-gray-50 dark:bg-gray-800 text-gray-500 border-gray-300 dark:border-gray-600 hover:border-nw-teal'}`}>
            {w.label}
          </button>
        ))}
      </div>

      {tab === 'picks' && (
        <PicksView
          user={user} games={games} weekOpen={weekOpen} N={N}
          draft={draft} myPicks={myPicks} usedConf={usedConf}
          setPick={setPick} setConf={setConf}
          name={name} setName={setName}
          draftComplete={draftComplete} submit={submit} msg={msg}
        />
      )}
      {tab === 'rankings' && <RankingsView user={user} />}
      {tab === 'entries' && <EntriesView week={week} />}
    </div>
  )
}

// ── My Picks ──────────────────────────────────────────────────────
function PicksView({ user, games, weekOpen, N, draft, myPicks, usedConf, setPick, setConf, name, setName, draftComplete, submit, msg }) {
  if (!games.length) return <div className="text-center py-10 text-gray-500 text-sm">No WCL games scheduled for this week yet.</div>

  // group by date
  const byDate = {}
  games.forEach(g => { (byDate[g.dateLabel] = byDate[g.dateLabel] || []).push(g) })
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
          This week is locked — first pitch has passed. Picks are view-only; results update live.
        </div>
      )}
      {editable && (
        <div className="mb-4 flex items-end gap-2">
          <div className="flex-1">
            <label className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Display name</label>
            <input value={name} onChange={e => setName(e.target.value)} maxLength={40} placeholder="e.g. Tyler S."
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-900" />
          </div>
        </div>
      )}

      {Object.entries(byDate).map(([dlabel, dg]) => (
        <div key={dlabel}>
          <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mt-4 mb-1.5">{dlabel}</div>
          {dg.map(g => {
            const mine = myPicks[g.id]
            const d = draft[g.id] || {}
            const win = g.winner_team_id
            return (
              <div key={g.id} className={`border rounded-lg mb-2 overflow-hidden ${(d.pick_team_id && d.confidence) ? 'border-nw-teal' : 'border-gray-200 dark:border-gray-700'}`}>
                <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-800 text-[11px] text-gray-400">
                  <span>{g.dateLabel}</span>
                  <span>{g.status === 'final' ? '✓ Final' : g.locked ? 'Locked' : (d.confidence ? `${d.confidence} pts` : 'Upcoming')}</span>
                </div>
                <div className="px-3 py-2.5">
                  {/* matchup / score */}
                  <div className="flex items-center gap-2 mb-2">
                    <TeamCell g={g} side="away" win={win} />
                    <span className="text-[11px] text-gray-400">@</span>
                    <TeamCell g={g} side="home" win={win} />
                    {g.status === 'final' && (
                      <span className="ml-auto text-sm font-bold text-gray-700 dark:text-gray-200">{g.away_score}–{g.home_score}</span>
                    )}
                  </div>

                  {/* pick buttons */}
                  <div className="flex gap-1.5 mb-1.5">
                    {[g.away_team_id, g.home_team_id].map(tid => {
                      const picked = (mine ? mine.pick_team_id : d.pick_team_id) === tid
                      const result = g.locked && mine ? (win ? (mine.pick_team_id === win ? 'correct' : 'wrong') : '') : ''
                      let cls = 'border-gray-300 dark:border-gray-600 text-gray-600 bg-gray-50 dark:bg-gray-800'
                      if (picked && result === 'correct') cls = 'bg-green-100 border-green-600 text-green-900'
                      else if (picked && result === 'wrong') cls = 'bg-red-100 border-red-600 text-red-900 line-through'
                      else if (picked) cls = 'bg-nw-teal border-nw-teal text-white'
                      else if (g.locked) cls = 'opacity-40'
                      return (
                        <button key={tid} disabled={!(weekOpen && user)} onClick={() => setPick(g.id, tid)}
                          className={`flex-1 px-2 py-2 text-sm font-medium rounded-md border-2 ${cls} ${weekOpen && user ? 'hover:border-nw-teal' : 'cursor-default'}`}>
                          {teamName(g, tid)}
                        </button>
                      )
                    })}
                  </div>

                  {/* confidence */}
                  {editable ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] text-gray-400 w-16">Confidence</span>
                      <div className="flex gap-1 flex-wrap">
                        {Array.from({ length: N }, (_, i) => i + 1).map(num => {
                          const sel = d.confidence === num
                          const taken = usedConf.has(num) && !sel
                          return (
                            <button key={num} disabled={taken} onClick={() => setConf(g.id, num)}
                              className={`w-8 h-7 text-xs rounded-md border flex items-center justify-center ${sel ? 'bg-nw-teal border-nw-teal text-white font-semibold' : taken ? 'opacity-40 border-dashed border-gray-300 text-gray-300 cursor-not-allowed' : 'border-gray-300 dark:border-gray-600 text-gray-500 hover:border-nw-teal'}`}>
                              {num}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ) : mine ? (
                    <div className="text-[11px] text-gray-500">
                      Confidence <strong>{mine.confidence}</strong>
                      {win ? (mine.pick_team_id === win
                        ? <span className="text-green-700 font-medium"> · +{mine.confidence} pts ✓</span>
                        : <span className="text-red-700"> · 0 pts ✗</span>)
                        : <span> · pending</span>}
                    </div>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ))}

      {editable && (
        <div className="mt-4">
          {msg && <div className={`mb-2 p-2.5 rounded-md text-sm ${msg.t === 'ok' ? 'bg-green-50 text-green-800 border border-green-200' : msg.t === 'warn' ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>{msg.m}</div>}
          <button onClick={submit} disabled={!draftComplete}
            className={`w-full py-2.5 rounded-md text-sm font-semibold ${draftComplete ? 'bg-nw-teal text-white hover:bg-nw-teal-dark' : 'bg-gray-200 text-gray-400 cursor-default'}`}>
            {draftComplete ? (submitted ? '🔒 Update my picks' : '🔒 Lock in my picks') : `Pick & rank all ${N} games to submit`}
          </button>
        </div>
      )}
    </div>
  )
}

function TeamCell({ g, side, win }) {
  const id = side === 'away' ? g.away_team_id : g.home_team_id
  const logo = side === 'away' ? g.away_logo : g.home_logo
  const nm = side === 'away' ? g.away_name : g.home_name
  const isWin = win && win === id
  return (
    <div className={`flex items-center gap-1.5 flex-1 ${side === 'away' ? 'justify-start' : 'justify-start'}`}>
      {logo && <img src={logo} alt="" className="w-5 h-5 object-contain" />}
      <span className={`text-sm font-semibold ${isWin ? 'text-nw-teal' : 'text-gray-900 dark:text-gray-100'}`}>{nm}</span>
    </div>
  )
}

// ── Rankings ──────────────────────────────────────────────────────
function RankingsView({ user }) {
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
  useEffect(() => { if (week) getJSON(`${API}/entries?week=${week}`).then(setData).catch(() => setData({ entries: [], games: [] })) }, [week])
  if (!data) return <div className="text-center py-8 text-gray-500 text-sm">Loading…</div>
  const { games = [], entries = [] } = data
  if (!entries.length) return <div className="text-center py-10 text-gray-500 text-sm">No entries for this week yet.</div>
  const ab = (g, id) => {
    const nm = id === g.away_team_id ? g.away_name : g.home_name
    return nm.split(' ').slice(-1)[0].slice(0, 4)
  }
  return (
    <div>
      <p className="text-xs text-gray-400 mb-2">Picks stay hidden until each game locks. Green = correct, red = wrong.</p>
      <div className="overflow-x-auto border rounded-lg border-gray-200 dark:border-gray-700">
        <table className="text-xs border-collapse min-w-full">
          <thead><tr className="bg-gray-50 dark:bg-gray-800">
            <th className="text-left px-2 py-1.5 sticky left-0 bg-gray-50 dark:bg-gray-800">Player</th>
            {games.map(g => (
              <th key={g.id} className="px-2 py-1.5 text-center text-[10px] text-gray-500 whitespace-nowrap">
                {ab(g, g.away_team_id)}@{ab(g, g.home_team_id)}
                {g.winner_team_id && <div className="text-green-700">{ab(g, g.winner_team_id)}✓</div>}
              </th>
            ))}
            <th className="px-2 py-1.5 text-right">Pts</th>
          </tr></thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i} className={e.is_me ? 'bg-nw-teal/5' : ''}>
                <td className="px-2 py-1.5 font-semibold whitespace-nowrap sticky left-0 bg-inherit text-gray-900 dark:text-gray-100">{e.name}{e.is_me && <span className="text-[10px] text-nw-teal"> you</span>}</td>
                {games.map(g => {
                  const p = e.picks[g.id]
                  if (!p) return <td key={g.id} className="px-2 py-1.5 text-center text-gray-300">–</td>
                  const cls = p.result === 'win' ? 'bg-green-100 text-green-900' : p.result === 'loss' ? 'bg-red-100 text-red-900' : ''
                  return (
                    <td key={g.id} className={`px-2 py-1.5 text-center ${cls}`}>
                      {p.hidden ? <span className="text-gray-400">🔒</span> : <><div className="font-semibold">{ab(g, p.pick_team_id)}</div><div className="text-[10px] text-gray-400">{p.confidence}</div></>}
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
