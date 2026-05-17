import { useMemo, useState } from 'react'
import { useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import { ensureNwbbRatings } from '../../gm/engine/nwbbRating'
import TeamLogo from '../../gm/components/TeamLogo'
import GMShell from '../../gm/components/GMShell'

/**
 * National Rankings page — driven by the NWBB Rating engine.
 *
 * Each row shows the team's rating (predictive 0-100), record, SOS rank,
 * quality wins, Pythagorean win pct, and road W-L. Sortable by any column.
 */

const COLUMNS = [
  { key: 'rating',         label: 'Rating',  desc: 'Predictive 0-100 rating. Higher = better.' },
  { key: 'record',         label: 'Record',  desc: 'Wins-losses.' },
  { key: 'sos',            label: 'SOS',     desc: 'Strength of Schedule (mean opponent rating). Higher = harder schedule.' },
  { key: 'pythagWinPct',   label: 'Pyth %',  desc: 'Pythagorean win expectation from RS/RA.' },
  { key: 'qualityWins',    label: 'QW',      desc: 'Wins vs top-25% teams (quality wins).' },
  { key: 'roadWinPct',     label: 'Road W%', desc: 'Win pct in road games.' },
  { key: 'marginAvg',      label: 'Margin',  desc: 'Avg run differential per game (capped ±10).' },
]

export default function Rankings() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const save = useMemo(() => loadDynasty(userId, slot), [userId, slot])
  const [sortKey, setSortKey] = useState('rating')

  if (!save) return <Navigate to="/gm" replace />

  // Compute / read NWBB ratings — cached on state.nwbbRatings
  const ratings = useMemo(() => ensureNwbbRatings(save), [save])

  // Build display rows: NAIA only. Join with team record (W-L) so we can show
  // it in the table without a separate scan.
  const rows = useMemo(() => {
    return Object.values(ratings)
      .filter(r => !r.isNonNaia)
      .map(r => {
        const school = save.schools[r.teamId]
        const team = save.teams[r.teamId]
        return {
          ...r,
          school,
          conferenceAbbr: save.conferences[school?.conferenceId]?.abbreviation || '',
          wins: team?.wins || 0,
          losses: team?.losses || 0,
        }
      })
  }, [ratings, save])

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      if (sortKey === 'record') {
        const aWinPct = (a.wins + a.losses) > 0 ? a.wins / (a.wins + a.losses) : 0
        const bWinPct = (b.wins + b.losses) > 0 ? b.wins / (b.wins + b.losses) : 0
        return bWinPct - aWinPct
      }
      if (sortKey === 'roadWinPct') {
        return (b.roadWinPct ?? -1) - (a.roadWinPct ?? -1)
      }
      return (b[sortKey] ?? -Infinity) - (a[sortKey] ?? -Infinity)
    })
  }, [rows, sortKey])

  const userSchool = save.schools[save.userSchoolId]
  const userR = ratings[save.userSchoolId]
  const totalGamesPlayed = (save.schedule || []).filter(g => g.played).length

  return (
    <GMShell schoolName={userSchool?.name} schoolColors={userSchool?.colors}>
      <div className="max-w-7xl mx-auto">
        <div className="mb-4">
          <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">NATIONAL RANKINGS</h1>
          <p className="font-pixel text-sm text-[#a8a8c8]">
            NWBB Rating — predictive 0-100 scale. Higher = better. SOS-adjusted iteratively, road wins worth more,
            margin of victory diminishing past ±10 runs, and beating top-25 teams earns quality-win bonuses.
          </p>
          {userR && (
            <div className="mt-3 bg-[#1a1a2e] border-2 border-amber-400 rounded p-3 text-sm">
              <span className="font-pixel uppercase tracking-widest text-amber-300 text-xs mr-3">Your program:</span>
              <span className="text-white font-bold">#{userR.nationalRank} {userSchool?.name}</span>
              <span className="text-[#a8a8c8] ml-3">Rating: <span className="text-white font-mono">{userR.rating.toFixed(1)}</span></span>
              <span className="text-[#a8a8c8] ml-3">SOS: <span className="text-white font-mono">{userR.sos.toFixed(1)}</span> (#{userR.sosRank})</span>
              <span className="text-[#a8a8c8] ml-3">QW: <span className="text-white font-mono">{userR.qualityWins}</span></span>
              {totalGamesPlayed < 10 && (
                <div className="text-[10px] text-amber-300 mt-1">
                  Year 1 / early season — ratings still anchored to preseason PEAR seed. Stabilizes after ~15 games per team.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-between items-center mb-3">
          <div className="flex gap-1 flex-wrap">
            {COLUMNS.map(col => (
              <button
                key={col.key}
                onClick={() => setSortKey(col.key)}
                title={col.desc}
                className={'px-2.5 py-1 rounded text-xs font-pixel uppercase tracking-wider ' +
                  (sortKey === col.key ? 'bg-amber-400 text-[#1a1a2e] font-bold' : 'bg-[#3a3a5e] text-[#e8e8e8]')
                }
              >
                {col.label}
              </button>
            ))}
          </div>
          <div className="text-xs text-[#a8a8c8]">{sorted.length} programs</div>
        </div>

        <div className="bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#0f0f1e]">
                <tr className="text-left text-[10px] font-pixel uppercase tracking-widest text-amber-300">
                  <th className="py-2 px-3 w-12">#</th>
                  <th className="w-8"></th>
                  <th>Program</th>
                  <th>Conf</th>
                  <th title={COLUMNS[0].desc} className="text-right pr-3">Rating</th>
                  <th title="Record">Record</th>
                  <th title={COLUMNS[2].desc} className="text-right pr-3">SOS</th>
                  <th title="SOS rank — 1 = hardest schedule">SOS#</th>
                  <th title={COLUMNS[3].desc} className="text-right pr-3">Pyth%</th>
                  <th title={COLUMNS[4].desc} className="text-right pr-3">QW</th>
                  <th title={COLUMNS[5].desc} className="text-right pr-3">Road W%</th>
                  <th title={COLUMNS[6].desc} className="text-right pr-3">Margin</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => {
                  const isUser = r.teamId === save.userSchoolId
                  return (
                    <tr key={r.teamId} className={'border-t border-[#3a3a5e] ' + (isUser ? 'bg-amber-400/15 font-bold' : 'hover:bg-[#3a3a5e]/30 text-[#e8e8e8]')}>
                      <td className="py-2 px-3 font-mono text-amber-300">{r.nationalRank}</td>
                      <td><TeamLogo school={r.school} size={22} /></td>
                      <td className="text-white">{r.school?.name || r.teamId}</td>
                      <td className="text-[10px] text-[#a8a8c8]">{r.conferenceAbbr}</td>
                      <td className={'font-mono text-right pr-3 ' + ratingColor(r.rating)}>{r.rating.toFixed(1)}</td>
                      <td className="font-mono">{r.wins}-{r.losses}</td>
                      <td className="font-mono text-right pr-3">{r.sos.toFixed(1)}</td>
                      <td className="font-mono text-[10px] text-[#a8a8c8]">#{r.sosRank}</td>
                      <td className="font-mono text-right pr-3">{r.pythagWinPct ? r.pythagWinPct.toFixed(3).replace(/^0\./, '.') : '—'}</td>
                      <td className="font-mono text-right pr-3">{r.qualityWins}</td>
                      <td className="font-mono text-right pr-3">{r.roadWinPct != null ? (r.roadWinPct * 100).toFixed(0) + '%' : '—'}</td>
                      <td className={'font-mono text-right pr-3 ' + (r.marginAvg > 0 ? 'text-emerald-400' : r.marginAvg < 0 ? 'text-red-400' : '')}>
                        {r.marginAvg > 0 ? '+' : ''}{r.marginAvg.toFixed(1)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-3 text-[10px] text-[#a8a8c8] leading-snug max-w-3xl">
          <strong className="text-amber-300">How the rating works:</strong>{' '}
          Massey-style iterative SOS-adjusted average — your rating equals the mean
          of (opponent rating + capped margin + venue adjustment + quality-win bonus) across every game you played.
          Beating a #5 on the road in a close game is worth meaningfully more than beating a #150 at home by 10.
          Non-NAIA opponents factor in too — beating a D1 is a huge rating spike; beating a bad D3 barely moves anything.
        </div>
      </div>
    </GMShell>
  )
}

function ratingColor(v) {
  if (v >= 85) return 'text-emerald-400 font-bold'
  if (v >= 75) return 'text-emerald-400'
  if (v >= 65) return 'text-amber-300'
  if (v >= 55) return 'text-[#e8e8e8]'
  if (v >= 45) return 'text-[#a8a8c8]'
  return 'text-[#666680]'
}
