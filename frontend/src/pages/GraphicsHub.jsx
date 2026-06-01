// /graphics-hub — a single index that lists every social-media / shareable
// graphic generator on the site. Replaces the long "Graphics" dropdown
// in the header; the header now just links to this one page.

import { Link } from 'react-router-dom'

const GRAPHICS = [
  { to: '/graphics',                label: 'Leaderboards',          desc: 'Hitting / pitching / WAR leaderboard cards for social media.' },
  { to: '/scatter',                 label: 'Scatter Plot',          desc: 'Compare two stats across players or teams visually.' },
  { to: '/daily-scores',            label: 'Daily Scoreboard',      desc: 'Today\'s scores in one clean graphic.' },
  { to: '/key-matchup',             label: 'Key Matchup',           desc: 'Single matchup-of-the-day preview card.' },
  { to: '/series-recap',            label: 'Weekly Series Recap',   desc: 'Series-by-series weekend wrap-up graphic.' },
  { to: '/tournament-bracket',      label: 'Tournament Bracket',    desc: 'Conference tournament bracket as a shareable image.' },
  { to: '/daily-recap',             label: 'Daily Game Recap',      desc: 'Final + leaders for a single game.' },
  { to: '/player-pages',            label: 'Player Pages',          desc: 'Shareable per-player stat card.' },
  { to: '/conference-standings',    label: 'Conference Standings',  desc: 'Standings graphic for any PNW conference.' },
  { to: '/all-conference-graphic',  label: 'All-Conference Teams',  desc: 'Render the All-Conference 1st / 2nd / HM teams.' },
  { to: '/top-performers-graphic',  label: 'Top Performers',        desc: 'Weekly top 10 hitters and pitchers.' },
  { to: '/team-info-graphic',       label: 'Team Info',             desc: 'Full team overview graphic.' },
  { to: '/team-season-recap',       label: 'Team Season Recap',     desc: 'End-of-year highlights: record, WAR leaders, clutch moment.' },
  { to: '/summer/recap',            label: 'WCL Daily Recap',       desc: 'A full WCL slate: scores with R/H/E and each game\'s standouts.' },
  { to: '/summer/game-recap',       label: 'WCL Game Recap',        desc: 'One WCL game: line score, pitching decisions, and top hitters.' },
]

export default function GraphicsHub() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-pnw-slate">Graphics</h1>
        <p className="text-sm text-gray-600 mt-1">
          Pick a generator. Each one renders a shareable image you can save and post.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {GRAPHICS.map(g => (
          <Link
            key={g.to}
            to={g.to}
            className="group block bg-white border border-gray-200 rounded-lg p-4
                       hover:border-nw-teal hover:shadow-md transition-all"
          >
            <div className="text-sm font-bold text-gray-900 group-hover:text-nw-teal">
              {g.label}
            </div>
            <p className="text-[11px] text-gray-500 mt-1 leading-snug">{g.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
