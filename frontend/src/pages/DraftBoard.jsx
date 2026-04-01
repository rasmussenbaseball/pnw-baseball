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
    ],
  },
  '27': { year: 2027, prospects: [] },
  '28': { year: 2028, prospects: [] },
}

const POS_COLORS = {
  SS: 'bg-blue-100 text-blue-800',
  C: 'bg-amber-100 text-amber-800',
  RHP: 'bg-red-100 text-red-800',
  LHP: 'bg-emerald-100 text-emerald-800',
  OF: 'bg-purple-100 text-purple-800',
  '1B': 'bg-orange-100 text-orange-800',
  '2B': 'bg-cyan-100 text-cyan-800',
  '3B': 'bg-pink-100 text-pink-800',
}

export default function DraftBoard({ year }) {
  const board = DRAFT_DATA[year]

  if (!board || board.prospects.length === 0) {
    return (
      <div className="text-center py-20">
        <h1 className="text-2xl font-bold text-pnw-slate mb-2">MLB Draft Board '${year}</h1>
        <p className="text-gray-500">PNW prospects for the 20{year} MLB Draft. Coming soon!</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-pnw-slate mb-1">
          {board.year} MLB Draft Board
        </h1>
        <p className="text-sm text-gray-500">
          Top PNW prospects for the {board.year} MLB Draft
        </p>
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
