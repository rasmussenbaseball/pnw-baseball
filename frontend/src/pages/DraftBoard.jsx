import { useState } from 'react'
import { Link } from 'react-router-dom'

const DRAFT_DATA = {
  '26': {
    year: 2026,
    prospects: [
      { rank: 1, name: 'Maddox Molony', pos: 'SS', school: 'Oregon', playerId: 3506 },
      { rank: 2, name: 'Sean Duncan', pos: 'LHP', school: 'Terry Fox Secondary (BC)', playerId: null },
      { rank: 3, name: 'Eli Herst', pos: 'RHP', school: 'Seattle Academy (WA)', playerId: null },
      { rank: 4, name: 'Ethan Kleinschmit', pos: 'LHP', school: 'Oregon State', playerId: 3644 },
      { rank: 5, name: 'Cal Scolari', pos: 'RHP', school: 'Oregon', playerId: 3632 },
      { rank: 6, name: 'Teagan Scott', pos: 'C', school: 'South Salem (OR)', playerId: null },
      { rank: 7, name: 'Eric Segura', pos: 'RHP', school: 'Oregon State', playerId: 3643 },
      { rank: 8, name: 'Sawyer Nelson', pos: 'SS', school: 'South Salem (OR)', playerId: null },
      { rank: 9, name: 'Wyatt Queen', pos: 'RHP', school: 'Oregon State', playerId: 3649 },
      { rank: 10, name: 'Bryce Collins', pos: 'RHP', school: 'Kelso (WA)', playerId: null },
      { rank: 11, name: 'Finbar O\'Brien', pos: 'RHP', school: 'Gonzaga', playerId: 3575 },
      { rank: 12, name: 'Grady Saunders', pos: 'RHP', school: 'Thurston (OR)', playerId: null },
      { rank: 13, name: 'Collin Clarke', pos: 'P', school: 'Oregon', playerId: 3624 },
      { rank: 14, name: 'Anthony Karis', pos: 'OF', school: 'Gonzaga Prep (WA)', playerId: null },
      { rank: 15, name: 'Kealoha Kepo\'o-Sabate', pos: 'RHP', school: 'Meadowdale (WA)', playerId: null },
      { rank: 16, name: 'Ryan Cooney', pos: 'IF', school: 'Oregon', playerId: 3502 },
      { rank: 17, name: 'Will Rohrbacher', pos: 'IF', school: 'Bainbridge (WA)', playerId: null },
      { rank: 18, name: 'Erik Hoffberg', pos: 'LHP', school: 'Gonzaga', playerId: 3568 },
      { rank: 19, name: 'Colton Bower', pos: 'C', school: 'Washington', playerId: 3484 },
      { rank: 20, name: 'Mikey Bell', pos: 'INF', school: 'Gonzaga', playerId: 3550 },
    ],
  },
  '27': {
    year: 2027,
    prospects: [
      { rank: 1, name: 'Dax Whitney', pos: 'RHP', school: 'Oregon St', playerId: 3642 },
      { rank: 2, name: 'Jackson Hotchkiss', pos: 'OF', school: 'Washington', playerId: 3492 },
      { rank: 3, name: 'Will Sanford', pos: 'RHP', school: 'Oregon', playerId: 3623 },
      { rank: 4, name: 'Rylan Howe', pos: 'RHP', school: 'Union (WA)', playerId: null },
      { rank: 5, name: 'Tanner Bradley', pos: 'RHP', school: 'Oregon', playerId: 3629 },
      { rank: 6, name: 'Joe Mendazona Jr.', pos: 'C', school: 'Central (OR)', playerId: null },
      { rank: 7, name: 'Brayden Landry', pos: 'SS', school: 'Puyallup (WA)', playerId: null },
      { rank: 8, name: 'Karsten Sweum', pos: 'LHP', school: 'Gonzaga', playerId: 3569 },
      { rank: 9, name: 'Wyatt Plyler', pos: 'OF', school: 'Sumner (WA)', playerId: null },
      { rank: 10, name: 'Luke Overbay', pos: 'OF', school: 'Tumwater (WA)', playerId: null },
      { rank: 11, name: 'Jax Gimenez', pos: 'OF', school: 'Oregon', playerId: 3503 },
      { rank: 12, name: 'Reece Johnson', pos: 'OF', school: 'King\'s Way (WA)', playerId: null },
      { rank: 13, name: 'Adam Haight', pos: 'OF', school: 'Oregon St', playerId: 3518 },
      { rank: 14, name: 'Tyler Ransom', pos: 'LHP', school: 'Sugar-Salem (ID)', playerId: null },
      { rank: 15, name: 'Cole Katayma-Stall', pos: 'SS', school: 'Portland', playerId: 3586 },
    ],
  },
  '28': {
    year: 2028,
    prospects: [
      { rank: 1, name: 'Angel Laya', pos: 'OF', school: 'Oregon', playerId: 3501 },
      { rank: 2, name: 'Lincoln Moore', pos: 'SS', school: 'Kentlake (WA)', playerId: null },
      { rank: 3, name: 'Josh Proctor', pos: 'OF/3B', school: 'Oregon St', playerId: 3522 },
      { rank: 4, name: 'Brayden Jaksa', pos: 'C', school: 'Oregon', playerId: 3510 },
      { rank: 5, name: 'Madden Pike', pos: 'SS', school: 'Puyallup (WA)', playerId: null },
      { rank: 6, name: 'Mason Pike', pos: 'TWP', school: 'Oregon St', playerId: 3656 },
      { rank: 7, name: 'Collin McGowan', pos: 'C', school: 'Battle Ground (WA)', playerId: null },
      { rank: 8, name: 'Daniel Porras', pos: 'OF', school: 'Washington', playerId: 3489 },
      { rank: 9, name: 'Sam Smith', pos: 'OF', school: 'Central Catholic (OR)', playerId: null },
      { rank: 10, name: 'Zeke Thomas', pos: 'RHP', school: 'Willamette (OR)', playerId: null },
    ],
  },
}

const YEARS = ['26', '27', '28']

const POS_COLORS = {
  SS: 'bg-blue-100 text-blue-800',
  C: 'bg-amber-100 text-amber-800',
  RHP: 'bg-red-100 text-red-800',
  LHP: 'bg-emerald-100 text-emerald-800',
  OF: 'bg-purple-100 text-purple-800',
  '1B': 'bg-orange-100 text-orange-800',
  '2B': 'bg-cyan-100 text-cyan-800',
  '3B': 'bg-pink-100 text-pink-800',
  IF: 'bg-blue-100 text-blue-800',
  INF: 'bg-blue-100 text-blue-800',
  P: 'bg-rose-100 text-rose-800',
  TWP: 'bg-rose-100 text-rose-800',
  'OF/3B': 'bg-violet-100 text-violet-800',
}

export default function DraftBoard({ year }) {
  const [activeYear, setActiveYear] = useState(year || '26')
  const board = DRAFT_DATA[activeYear]

  return (
    <div>
      {/* Header + Year Tabs */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-pnw-slate mb-1">PNW MLB Draft Board</h1>
        <p className="text-sm text-gray-500 mb-4">
          Top PNW prospects for the MLB Draft
        </p>
        <div className="flex gap-2">
          {YEARS.map((yr) => (
            <button
              key={yr}
              onClick={() => setActiveYear(yr)}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
                activeYear === yr
                  ? 'bg-pnw-teal text-white shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              '{yr}
            </button>
          ))}
        </div>
      </div>

      {/* Subtitle for active year */}
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-gray-700">
          {board.year} Draft - {board.prospects.length} Prospects
        </h2>
      </div>

      {/* Desktop table */}
      <div className="hidden sm:block bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider w-12">Rank</th>
              <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">Player</th>
              <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider w-20">Pos</th>
              <th className="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">School</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {board.prospects.map((p) => {
              const posClass = POS_COLORS[p.pos] || 'bg-gray-100 text-gray-800'
              return (
                <tr key={p.rank} className="hover:bg-teal-50/40 transition-colors">
                  <td className="px-4 py-3">
                    <span className={`text-sm font-bold ${p.rank <= 3 ? 'text-amber-600' : 'text-gray-400'}`}>
                      {p.rank}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {p.playerId ? (
                      <Link
                        to={`/player/${p.playerId}`}
                        className="text-sm font-semibold text-gray-900 hover:text-nw-teal transition-colors"
                      >
                        {p.name}
                      </Link>
                    ) : (
                      <span className="text-sm font-semibold text-gray-900">{p.name}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 text-xs font-bold rounded ${posClass}`}>
                      {p.pos}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{p.school}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="sm:hidden space-y-2">
        {board.prospects.map((p) => {
          const posClass = POS_COLORS[p.pos] || 'bg-gray-100 text-gray-800'
          return (
            <div key={p.rank} className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-3 flex items-center gap-3">
              <span className={`text-lg font-bold w-8 text-center shrink-0 ${p.rank <= 3 ? 'text-amber-600' : 'text-gray-400'}`}>
                {p.rank}
              </span>
              <div className="flex-1 min-w-0">
                {p.playerId ? (
                  <Link
                    to={`/player/${p.playerId}`}
                    className="text-sm font-semibold text-gray-900 hover:text-nw-teal transition-colors block truncate"
                  >
                    {p.name}
                  </Link>
                ) : (
                  <span className="text-sm font-semibold text-gray-900 block truncate">{p.name}</span>
                )}
                <span className="text-xs text-gray-500">{p.school}</span>
              </div>
              <span className={`inline-block px-2 py-0.5 text-xs font-bold rounded shrink-0 ${posClass}`}>
                {p.pos}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
