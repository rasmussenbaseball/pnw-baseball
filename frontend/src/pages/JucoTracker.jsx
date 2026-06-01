import { useApi } from '../hooks/useApi'
import { usePersistedState } from '../hooks/usePersistedState'
import StatsLastUpdated from '../components/StatsLastUpdated'
import PlayerTrackerTable, {
  BoardToggle, HITTER_STAT_COLS, PITCHER_STAT_COLS, SORTABLE, ASC_DEFAULT, isHitter, isPitcher,
} from '../components/PlayerTrackerTable'

/**
 * JUCO Tracker - the recruiting tool.
 * Shows uncommitted NWAC players with their stats, split into Hitters
 * and Pitchers tables (two-way players appear in both), so 4-year
 * schools can identify transfer targets.
 */

export default function JucoTracker() {
  const [season, setSeason] = usePersistedState('juco_season', 2026)
  const [position, setPosition] = usePersistedState('juco_position', '')
  const [classYear, setClassYear] = usePersistedState('juco_classYear', 'So')
  const [sortBy, setSortBy] = usePersistedState('juco_sortBy', 'total_war')
  const [sortDir, setSortDir] = usePersistedState('juco_sortDir', 'desc')
  const [minAb, setMinAb] = usePersistedState('juco_minAb', 0)
  const [minIp, setMinIp] = usePersistedState('juco_minIp', 0)
  const [bats, setBats] = usePersistedState('juco_bats', '')
  const [throws_, setThrows] = usePersistedState('juco_throws', '')
  const [board, setBoard] = usePersistedState('juco_board', 'hitters')

  const { data, loading } = useApi('/players/juco/uncommitted', {
    season,
    position: position || undefined,
    year_in_school: classYear || undefined,
    sort_by: sortBy,
    sort_dir: sortDir,
    min_ab: minAb || 0,
    min_ip: minIp || 0,
    bats: bats || undefined,
    throws: throws_ || undefined,
    limit: 500,
  }, [season, position, classYear, sortBy, sortDir, minAb, minIp, bats, throws_])

  const positions = ['C', 'IF', '1B', '2B', '3B', 'SS', 'OF', 'LF', 'CF', 'RF', 'DH', 'P', 'UT']

  const handleSort = (key) => {
    if (!SORTABLE.has(key)) return
    if (sortBy === key) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    } else {
      setSortBy(key)
      setSortDir(ASC_DEFAULT.has(key) ? 'asc' : 'desc')
    }
  }

  const hitters = (data || []).filter(isHitter)
  const pitchers = (data || []).filter(isPitcher)

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-2">JUCO Tracker</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        NWAC players available for transfer to 4-year programs. Two-way players appear on both tables.
      </p>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-3 mb-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Season</label>
            <select value={season} onChange={(e) => setSeason(parseInt(e.target.value))}
              className="rounded border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-sm">
              {[2026, 2025, 2024].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Class</label>
            <select value={classYear} onChange={(e) => setClassYear(e.target.value)}
              className="rounded border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-sm">
              <option value="So">Sophomores</option>
              <option value="Fr">Freshmen</option>
              <option value="">All</option>
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Position</label>
            <select value={position} onChange={(e) => setPosition(e.target.value)}
              className="rounded border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-sm">
              <option value="">All</option>
              {positions.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Min AB</label>
            <input type="number" value={minAb} onChange={(e) => setMinAb(parseInt(e.target.value) || 0)}
              min={0} max={300} step={10}
              className="w-16 rounded border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm" />
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Min IP</label>
            <input type="number" value={minIp} onChange={(e) => setMinIp(parseInt(e.target.value) || 0)}
              min={0} max={150} step={5}
              className="w-16 rounded border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm" />
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Bats</label>
            <select value={bats} onChange={(e) => setBats(e.target.value)}
              className="rounded border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-sm">
              <option value="">All</option>
              <option value="L">LHH</option>
              <option value="R">RHH</option>
              <option value="S">SHH</option>
            </select>
          </div>

          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Throws</label>
            <select value={throws_} onChange={(e) => setThrows(e.target.value)}
              className="rounded border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-sm">
              <option value="">All</option>
              <option value="L">LHP</option>
              <option value="R">RHP</option>
            </select>
          </div>
        </div>
      </div>

      {/* Board selector — choose Hitters or Pitchers */}
      <BoardToggle
        board={board}
        onChange={setBoard}
        hitterCount={loading ? null : hitters.length}
        pitcherCount={loading ? null : pitchers.length}
      />

      {/* Results — one board at a time */}
      {loading ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-8 text-center text-gray-400 dark:text-gray-500 animate-pulse">
          Loading JUCO players...
        </div>
      ) : board === 'hitters' ? (
        <PlayerTrackerTable rows={hitters} statCols={HITTER_STAT_COLS} groupLabel="Hitting"
          sortBy={sortBy} sortDir={sortDir} onSort={handleSort} infoLabel="Team" committedHeader="Committed" />
      ) : (
        <PlayerTrackerTable rows={pitchers} statCols={PITCHER_STAT_COLS} groupLabel="Pitching"
          sortBy={sortBy} sortDir={sortDir} onSort={handleSort} infoLabel="Team" committedHeader="Committed" />
      )}

      <StatsLastUpdated levels={['JUCO']} className="mt-3" />
    </div>
  )
}
