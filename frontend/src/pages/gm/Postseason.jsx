import { useMemo } from 'react'
import { Link, useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadDynasty } from '../../gm/engine/save'
import TeamLogo from '../../gm/components/TeamLogo'
import GMShell from '../../gm/components/GMShell'

export default function Postseason() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const slot = parseInt(params.get('slot') || '1', 10)
  const userId = user?.id || 'guest'

  const save = useMemo(() => loadDynasty(userId, slot), [userId, slot])
  if (!save) return <Navigate to="/gm" replace />
  const userSchool = save.schools[save.userSchoolId]
  if (!save.postseason) {
    return (
      <GMShell schoolName={userSchool?.name} schoolColors={userSchool?.colors}>
      <div className="max-w-3xl mx-auto">
        <h1 className="font-pixel-display text-xl tracking-widest text-white">POSTSEASON</h1>
        <p className="font-pixel text-base text-[#a8a8c8] mt-3">No postseason results yet. Finish a season to see conference tournaments and the NAIA Opening Round.</p>
      </div>
      </GMShell>
    )
  }

  const ps = save.postseason
  const userConfId = save.schools[save.userSchoolId]?.conferenceId
  const userTournament = ps.tournaments.find(t => t.conferenceId === userConfId)

  return (
    <GMShell schoolName={userSchool?.name} schoolColors={userSchool?.colors}>
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">{ps.year} POSTSEASON</h1>
        <p className="text-sm text-gray-600">
          {ps.userChamp ? ' You won your conference!' : ps.userQualified ? ' You qualified for your conference tournament.' : ' You missed the conference tournament.'}
        </p>
      </div>

      {userTournament && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm mb-4">
          <h2 className="text-lg font-semibold mb-3">
            {save.conferences[userConfId].name} Tournament
          </h2>
          <div className="mb-3">
            <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">Qualifiers (seeds)</div>
            <div className="space-y-1">
              {userTournament.qualifiers.map(q => {
                const school = save.schools[q.schoolId]
                const isUser = q.schoolId === save.userSchoolId
                return (
                  <div key={q.schoolId} className={'flex items-center gap-2 text-sm ' + (isUser ? 'font-bold text-pnw-green' : '')}>
                    <span className="w-6 text-gray-500">#{q.seed}</span>
                    <TeamLogo school={school} size={20} />
                    <span>{school?.name}</span>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="mb-2">
            <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">Games</div>
            <div className="space-y-1.5">
              {userTournament.games.map((g, i) => {
                const home = save.schools[g.homeId]
                const away = save.schools[g.awayId]
                const homeWon = g.winner === g.homeId
                const userInGame = g.homeId === save.userSchoolId || g.awayId === save.userSchoolId
                return (
                  <div key={g.id || i} className={'border rounded p-2 ' + (userInGame ? 'border-pnw-green bg-pnw-cream' : 'border-gray-200')}>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{g.label}</div>
                    <div className="flex justify-between items-center text-sm">
                      <div className={'flex items-center gap-2 ' + (homeWon ? 'font-bold' : 'text-gray-500')}>
                        <TeamLogo school={home} size={20} />
                        <span>{home?.name}</span>
                      </div>
                      <div className="font-mono text-sm">
                        <span className={homeWon ? 'font-bold' : ''}>{g.homeRuns}</span>
                        <span className="mx-1">–</span>
                        <span className={!homeWon ? 'font-bold' : ''}>{g.awayRuns}</span>
                      </div>
                      <div className={'flex items-center gap-2 ' + (!homeWon ? 'font-bold' : 'text-gray-500')}>
                        <span>{away?.name}</span>
                        <TeamLogo school={away} size={20} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {userTournament.champion && (
            <div className="mt-4 pt-3 border-t text-sm">
              <strong>Champion:</strong> {save.schools[userTournament.champion]?.name}
              {' '}<span className="text-xs text-gray-500">
                (auto-bid to {ps.level === 'NAIA' ? 'NAIA Opening Round' : (ps.nationalSpec?.name || 'national tournament')})
              </span>
            </div>
          )}
        </div>
      )}

      {/* All-conference-champions block — only meaningful for NAIA where we
          sim every conference. Non-NAIA dynasties show their own conference
          only (we don't track 30 D1 conferences). */}
      {ps.level === 'NAIA' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h2 className="text-lg font-semibold mb-3">All 21 Conference Champions</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
            {ps.tournaments.map(t => {
              const conf = save.conferences[t.conferenceId]
              const champ = save.schools[t.champion]
              return (
                <div key={t.conferenceId} className="border border-gray-200 rounded p-2">
                  <div className="text-[10px] uppercase tracking-wider text-gray-500">{conf?.abbreviation}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <TeamLogo school={champ} size={16} />
                    <span className="font-medium">{champ?.name || '—'}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* National-bracket field — every level. Reads state.nationalChamps */}
      <NationalFieldSection ps={ps} save={save} />

      {/* NWAC playoff bracket */}
      {ps.level === 'NWAC' && ps.nwac && (
        <NwacBracketSection ps={ps} save={save} />
      )}

      {/* D1/D2/D3 full national bracket */}
      {ps.level && ps.level !== 'NAIA' && ps.level !== 'NWAC' && ps.national && (
        <NationalBracketSection ps={ps} save={save} />
      )}

      {ps.level === 'NAIA' && ps.national && (
        <NationalSection ps={ps} save={save} />
      )}
    </div>
    </GMShell>
  )
}

/**
 * Multi-level national bracket display — used for D1/D2/D3/NWAC dynasties
 * who won their conference. Shows each round with a win/lose pill.
 */
/**
 * Full national-tournament field — every conference champion + at-large
 * bids. Reads state.nationalChamps[year][level] which is populated by
 * runNationalChampionsTracking after the user's postseason runs.
 */
function NationalFieldSection({ ps, save }) {
  const level = ps.level
  const year = (ps.year - 1)
    || save.calendar?.year - 1
    || save.calendar?.year
  const data = save.nationalChamps?.[year]?.[level]
    || save.nationalChamps?.[year - 1]?.[level]
    || save.nationalChamps?.[ps.year]?.[level]
  if (!data || !data.field) return null
  const userInField = data.field.some(t => t.id === save.userSchoolId)

  // Group by conferenceName for the champions, then show at-large pool
  const champions = data.field.filter(t => t.viaAutoBid)
  const atLarge   = data.field.filter(t => !t.viaAutoBid)

  const levelLabels = {
    D1: 'NCAA D1 Tournament', D2: 'NCAA D2 Tournament',
    D3: 'NCAA D3 Tournament', NAIA: 'NAIA National Tournament',
  }

  return (
    <div className="mt-6 bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
      <div className="flex justify-between items-baseline mb-1 flex-wrap gap-2">
        <h2 className="text-lg font-semibold">{levelLabels[level] || 'National Field'} — {data.fieldSize}-team field</h2>
        {userInField
          ? <span className="text-xs font-bold text-pnw-green">[YOU'RE IN]</span>
          : <span className="text-xs text-gray-500 italic">your program missed the field</span>}
      </div>
      <p className="text-xs text-gray-500 mb-4">
        {champions.length} conference auto-bids + {atLarge.length} at-large bids. Conference champs from every {level} league nationally; at-larges selected by PEAR strength.
      </p>

      {/* Conference champion auto-bids */}
      <div className="mb-4">
        <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">
          Conference Auto-Bids ({champions.length})
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-1.5 text-xs">
          {champions.slice(0, 60).map((t, i) => {
            const isUser = t.id === save.userSchoolId
            return (
              <div
                key={i}
                className={'flex items-center justify-between gap-2 p-1.5 rounded border ' +
                  (isUser ? 'border-pnw-green bg-pnw-cream/40 font-bold' : 'border-gray-200')
                }
              >
                <div className="min-w-0 flex-1">
                  <div className="text-pnw-slate truncate">{t.name}</div>
                  <div className="text-[10px] text-gray-500 truncate">{t.conferenceName}</div>
                </div>
                {t.state && <span className="text-[10px] text-gray-500 shrink-0">{t.state}</span>}
              </div>
            )
          })}
        </div>
      </div>

      {/* At-large bids */}
      {atLarge.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">
            At-Large Bids ({atLarge.length})
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-1.5 text-xs">
            {atLarge.slice(0, 30).map((t, i) => {
              const isUser = t.id === save.userSchoolId
              return (
                <div
                  key={i}
                  className={'flex items-center justify-between gap-2 p-1.5 rounded border ' +
                    (isUser ? 'border-pnw-green bg-pnw-cream/40 font-bold' : 'border-gray-200')
                  }
                >
                  <div className="text-pnw-slate truncate flex-1 min-w-0">{t.name}</div>
                  {t.state && <span className="text-[10px] text-gray-500 shrink-0">{t.state}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// Resolve a team's display name — real schools live in save.schools;
// synthetic national-bracket opponents (D1/D2/D3) come from the level pool.
function teamNameResolver(save, ps) {
  const pool = {}
  for (const t of (ps.national?.field?.seededField || [])) pool[t.id] = t.name
  return (id) => save.schools[id]?.name || pool[id] || (id ? id.replace(/-d[123]$/, '').replace(/-/g, ' ') : '—')
}

function NationalBracketSection({ ps, save }) {
  const nat = ps.national
  if (!nat) return null
  const path = ps.nationalUserPath || {}
  const nameFor = teamNameResolver(save, ps)
  const champName = nameFor(nat.nationalChampion)
  const userId = save.userSchoolId
  const isUserChamp = nat.nationalChampion === userId

  return (
    <div className="mt-6 space-y-4">
      {/* Field summary */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h2 className="text-lg font-semibold mb-1">{ps.nationalSpec?.name || 'National Tournament'}</h2>
        <p className="text-xs text-gray-500 mb-3">
          {(nat.field?.seededField || []).length}-team field — {(nat.field?.autoBids || []).length} conference auto-bids
          + {(nat.field?.atLargeBids || []).length} at-large bids (selected by NWBB rating).
        </p>

        {/* Champion banner */}
        {nat.nationalChampion && (
          <div className={'mb-3 p-3 rounded border ' + (isUserChamp
            ? 'bg-gradient-to-r from-yellow-100 to-amber-100 border-amber-300'
            : 'bg-gray-50 border-gray-200')}>
            <div className="text-xs uppercase tracking-wider text-amber-900">{ps.year} National Champion</div>
            <div className="flex items-center gap-2 mt-1">
              <TeamLogo school={save.schools[nat.nationalChampion]} size={26} />
              <div className="text-xl font-bold text-pnw-slate">{champName}</div>
            </div>
          </div>
        )}

        {/* User path summary */}
        {path.qualified ? (
          <div className="text-sm text-gray-700">
            <span className="font-semibold">{save.schools[userId]?.name}</span> earned a
            {' '}<span className="font-semibold">{path.bidType === 'auto' ? 'conference auto-bid' : 'at-large bid'}</span>
            {' '}(overall seed #{path.seed}).{' '}
            {path.wonWS ? 'Won the national championship!'
              : path.inWS ? 'Reached the World Series.'
              : path.wonSuper ? 'Won the Super Regional, fell short of the title.'
              : path.wonRegion ? 'Won the Regional.'
              : 'Eliminated in the Regional round.'}
          </div>
        ) : (
          <div className="text-sm text-gray-600">
            {save.schools[userId]?.name} missed the {ps.level} national field this year. {champName} won it all.
          </div>
        )}
      </div>

      {/* User's regional */}
      {path.region && (
        <BracketSiteCard
          title="Your Regional"
          host={nameFor(path.region.host)}
          teams={path.region.teams}
          games={path.region.games}
          winner={path.region.winner}
          userId={userId}
          nameFor={nameFor}
          save={save}
        />
      )}

      {/* User's super regional (D1/D3) */}
      {path.superPair && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-pnw-slate mb-2">Your Super Regional (best-of-3)</h3>
          <div className="text-sm mb-2">
            {nameFor(path.superPair.host)} vs {nameFor(path.superPair.visitor)} —
            {' '}<span className="font-mono">{path.superPair.homeWins}-{path.superPair.awayWins}</span>,
            winner <span className="font-semibold">{nameFor(path.superPair.winner)}</span>
          </div>
          <GameList games={path.superPair.games} userId={userId} nameFor={nameFor} />
        </div>
      )}

      {/* World Series */}
      {nat.worldSeries?.games?.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-pnw-slate mb-1">
            {nat.superRegionals ? 'College World Series' : `${ps.level} World Series`} — 8-team double-elim
          </h3>
          <p className="text-xs text-gray-500 mb-3">
            Field: {(nat.worldSeries.qualifiers || []).map(nameFor).join(', ')}
          </p>
          <GameList games={nat.worldSeries.games} userId={userId} nameFor={nameFor} />
        </div>
      )}
    </div>
  )
}

function BracketSiteCard({ title, host, teams, games, winner, userId, nameFor, save }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-pnw-slate mb-2">{title} <span className="font-normal text-gray-500">— hosted by {host}</span></h3>
      <div className="space-y-1 mb-3 text-xs">
        {(teams || []).map(id => (
          <div key={id} className={'flex items-center gap-2 ' + (id === userId ? 'font-bold text-pnw-green' : '')}>
            <TeamLogo school={save.schools[id]} size={16} />
            <span>{nameFor(id)}</span>
            {winner === id && <span className="text-pnw-green font-bold">— Regional champ</span>}
          </div>
        ))}
      </div>
      <GameList games={games} userId={userId} nameFor={nameFor} />
    </div>
  )
}

function GameList({ games, userId, nameFor }) {
  if (!games || games.length === 0) return null
  return (
    <div className="space-y-1 text-xs">
      {games.map((g, i) => {
        const homeWon = (g.winner ? g.winner === g.homeId : g.homeRuns > g.awayRuns)
        const userIn = g.homeId === userId || g.awayId === userId
        return (
          <div key={i} className={'flex items-center justify-between p-1.5 rounded ' + (userIn ? 'bg-pnw-cream' : '')}>
            <span className="text-gray-500 w-28 shrink-0">{g.label || `Game ${i + 1}`}</span>
            <span className={'flex-1 text-right ' + (homeWon ? 'font-bold' : 'text-gray-500')}>{nameFor(g.homeId)}</span>
            <span className="font-mono mx-2">{g.homeRuns}–{g.awayRuns}</span>
            <span className={'flex-1 ' + (!homeWon ? 'font-bold' : 'text-gray-500')}>{nameFor(g.awayId)}</span>
          </div>
        )
      })}
    </div>
  )
}

function NwacBracketSection({ ps, save }) {
  const nwac = ps.nwac
  if (!nwac) return null
  const path = ps.nwacUserPath || {}
  const userId = save.userSchoolId
  const nameFor = (id) => save.schools[id]?.name || (id ? id.replace(/^nwac-/, '').replace(/-/g, ' ') : '—')
  const champName = nameFor(nwac.nwacChampion)
  const isUserChamp = nwac.nwacChampion === userId
  const DIV_LABEL = { NWAC_NORTH: 'North', NWAC_SOUTH: 'South', NWAC_EAST: 'East', NWAC_WEST: 'West' }

  return (
    <div className="mt-6 space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h2 className="text-lg font-semibold mb-1">NWAC Championship</h2>
        <p className="text-xs text-gray-500 mb-3">
          Top 4 per division qualify. Division champs bye to the 8-team championship at Longview, WA; #2 seeds host super regionals.
        </p>

        {nwac.nwacChampion && (
          <div className={'mb-3 p-3 rounded border ' + (isUserChamp
            ? 'bg-gradient-to-r from-yellow-100 to-amber-100 border-amber-300'
            : 'bg-gray-50 border-gray-200')}>
            <div className="text-xs uppercase tracking-wider text-amber-900">{ps.year} NWAC Champion</div>
            <div className="flex items-center gap-2 mt-1">
              <TeamLogo school={save.schools[nwac.nwacChampion]} size={26} />
              <div className="text-xl font-bold text-pnw-slate">{champName}</div>
            </div>
          </div>
        )}

        {path.qualified ? (
          <div className="text-sm text-gray-700">
            <span className="font-semibold">{save.schools[userId]?.name}</span> seeded #{path.seed} in the {DIV_LABEL[path.division] || path.division} division.{' '}
            {path.wonChampionship ? 'Won the NWAC Championship!'
              : path.inChampionship ? 'Reached the 8-team championship at Longview.'
              : path.wonSuperRegional ? 'Won the Super Regional, fell short at Longview.'
              : path.hadBye ? 'Earned a #1-seed bye but came up short.'
              : 'Eliminated in the Super Regional.'}
          </div>
        ) : (
          <div className="text-sm text-gray-600">
            {save.schools[userId]?.name} missed the NWAC playoffs (top 4 in division required). {champName} won it all.
          </div>
        )}
      </div>

      {/* Division seeds */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-pnw-slate mb-2">Division Seeds (top 4)</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Object.keys(nwac.seedsByDiv || {}).map(div => (
            <div key={div}>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{DIV_LABEL[div] || div}</div>
              <div className="space-y-0.5 text-xs">
                {(nwac.seedsByDiv[div] || []).map((id, i) => (
                  <div key={id} className={'flex items-center gap-2 ' + (id === userId ? 'font-bold text-pnw-green' : '')}>
                    <span className="w-4 text-gray-500">#{i + 1}</span>
                    <TeamLogo school={save.schools[id]} size={14} />
                    <span>{nameFor(id)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Super regionals */}
      {(nwac.superRegionals || []).length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-pnw-slate mb-2">Super Regionals</h3>
          <div className="space-y-3">
            {nwac.superRegionals.map((sr, i) => (
              <div key={i} className="border border-gray-200 rounded p-2">
                <div className="text-xs mb-1">
                  Host: <span className="font-semibold">{nameFor(sr.hostId)}</span> ·
                  Play-in: {nameFor(sr.playInA)} vs {nameFor(sr.playInB)} →
                  {' '}<span className="font-semibold">{nameFor(sr.playInGame?.winner)}</span> ·
                  Winner: <span className="font-semibold text-pnw-green">{nameFor(sr.winner)}</span>
                </div>
                <GameList games={sr.bo3Games} userId={userId} nameFor={nameFor} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Championship games */}
      {nwac.championship?.games?.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-pnw-slate mb-1">NWAC Championship — Longview, WA (double-elim)</h3>
          <p className="text-xs text-gray-500 mb-3">
            Field: {(nwac.championship.qualifiers || []).map(nameFor).join(', ')}
          </p>
          <GameList games={nwac.championship.games} userId={userId} nameFor={nameFor} />
        </div>
      )}
    </div>
  )
}

function NationalSection({ ps, save }) {
  const nat = ps.national
  const userSite = ps.userInField
    ? nat.openingRound.sites.find(s => s.teams.some(t => t.id === save.userSchoolId))
    : null

  return (
    <>
      <div className="mt-6 bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h2 className="text-lg font-semibold mb-3">NAIA National Tournament — Opening Round</h2>
        <p className="text-xs text-gray-500 mb-4">46-team field across 10 host sites. Winners advance to Avista NAIA World Series at Harris Field, Lewiston ID.</p>

        {userSite && (
          <div className="mb-4 border border-pnw-green bg-pnw-cream rounded p-3">
            <div className="text-xs uppercase tracking-wider text-pnw-green mb-1">Your site (hosted by {save.schools[userSite.host]?.name})</div>
            <div className="space-y-1 text-xs">
              {userSite.teams.map(t => (
                <div key={t.id} className={'flex items-center gap-2 ' + (t.id === save.userSchoolId ? 'font-bold' : '')}>
                  <span className="w-5 text-gray-500">#{t.seed}</span>
                  <TeamLogo school={save.schools[t.id]} size={16} />
                  <span>{save.schools[t.id]?.name}</span>
                  {userSite.winner === t.id && <span className="text-pnw-green font-bold">Advanced</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Opening Round winners (advance to WS)</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 text-xs">
          {nat.openingRound.sites.map((site, i) => {
            const winner = save.schools[site.winner]
            const isUser = site.winner === save.userSchoolId
            return (
              <div key={i} className={'flex items-center gap-2 p-1.5 rounded ' + (isUser ? 'bg-pnw-cream font-bold' : '')}>
                <span className="text-gray-500 w-12">Site {i + 1}</span>
                <TeamLogo school={winner} size={16} />
                <span>{winner?.name || '—'}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="mt-4 bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h2 className="text-lg font-semibold mb-3">Avista NAIA World Series</h2>
        <p className="text-xs text-gray-500 mb-4">Harris Field, Lewiston ID. 10 teams, two pools of 5, top 2 from each pool advance to semis.</p>

        {nat.worldSeries?.champion && (
          <div className="mb-4 p-3 bg-gradient-to-r from-yellow-100 to-amber-100 border border-amber-300 rounded">
            <div className="text-xs uppercase tracking-wider text-amber-900"> {ps.year} National Champion</div>
            <div className="flex items-center gap-2 mt-1">
              <TeamLogo school={save.schools[nat.worldSeries.champion]} size={28} />
              <div className="text-xl font-bold text-pnw-slate">{save.schools[nat.worldSeries.champion]?.name}</div>
            </div>
          </div>
        )}

        {nat.worldSeries?.games?.length > 0 && (
          <>
            <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">All games</div>
            <div className="space-y-1 text-xs">
              {nat.worldSeries.games.map((g, i) => {
                const home = save.schools[g.homeId]
                const away = save.schools[g.awayId]
                const homeWon = g.winner === g.homeId
                const userIn = g.homeId === save.userSchoolId || g.awayId === save.userSchoolId
                return (
                  <div key={i} className={'flex items-center justify-between p-1.5 rounded ' + (userIn ? 'bg-pnw-cream' : '')}>
                    <span className="text-gray-500 w-32">{g.label}</span>
                    <span className={homeWon ? 'font-bold' : 'text-gray-500'}>{home?.name}</span>
                    <span className="font-mono">{g.homeRuns}–{g.awayRuns}</span>
                    <span className={!homeWon ? 'font-bold' : 'text-gray-500'}>{away?.name}</span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </>
  )
}
