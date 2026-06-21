import { useApi } from '../hooks/useApi'
import { usePersistedState } from '../hooks/usePersistedState'
import PlayerTrackerTable, {
  BoardToggle, HITTER_STAT_COLS, PITCHER_STAT_COLS, SORTABLE, ASC_DEFAULT, isHitter, isPitcher,
} from '../components/PlayerTrackerTable'
import { CURRENT_SEASON } from '../lib/seasons'

/**
 * WCL Transfer Portal Tracker — West Coast League summer players added to the
 * portal via the Commitment Editor. Same look/behavior AND the same full stat
 * columns (season + PBP) as the JUCO and Transfer Portal trackers, but the stats
 * are SUMMER (WCL) and the roster isn't limited to PNW spring players. "WCL Team"
 * = where they play in the summer; "Spring School" = the curated 2026 school.
 */

const wclHref = (row) => `/summer/players/${row.id}`

export default function WclTransferTracker() {
  const [season, setSeason] = usePersistedState('wcl_season', CURRENT_SEASON)
  const [position, setPosition] = usePersistedState('wcl_position', '')
  const [hitSortBy, setHitSortBy] = usePersistedState('wcl_hitSortBy', 'offensive_war')
  const [hitSortDir, setHitSortDir] = usePersistedState('wcl_hitSortDir', 'desc')
  const [pitSortBy, setPitSortBy] = usePersistedState('wcl_pitSortBy', 'pitching_war')
  const [pitSortDir, setPitSortDir] = usePersistedState('wcl_pitSortDir', 'desc')
  const [bats, setBats] = usePersistedState('wcl_bats', '')
  const [throws_, setThrows] = usePersistedState('wcl_throws', '')
  const [board, setBoard] = usePersistedState('wcl_board', 'hitters')

  const sortBy = board === 'hitters' ? hitSortBy : pitSortBy
  const sortDir = board === 'hitters' ? hitSortDir : pitSortDir
  const setSortBy = board === 'hitters' ? setHitSortBy : setPitSortBy
  const setSortDir = board === 'hitters' ? setHitSortDir : setPitSortDir

  const { data, loading } = useApi('/wcl-portal', {
    season,
    position: position || undefined,
    sort_by: sortBy,
    sort_dir: sortDir,
    bats: bats || undefined,
    throws: throws_ || undefined,
  }, [season, position, sortBy, sortDir, bats, throws_])

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
      <h1 className="text-2xl font-bold text-nw-teal dark:text-gray-100 mb-2">WCL Transfer Portal Tracker</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        West Coast League players in the transfer portal, shown with their summer (WCL) stats. Includes players whose
        spring school is outside the Pacific Northwest. Two-way players appear on both tables.
      </p>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-3 mb-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col">
            <label className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Summer</label>
            <select value={season} onChange={(e) => setSeason(parseInt(e.target.value))}
              className="rounded border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-sm">
              {[2026, 2025, 2024].map(y => <option key={y} value={y}>{y}</option>)}
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

      <BoardToggle board={board} onChange={setBoard}
        hitterCount={loading ? null : hitters.length}
        pitcherCount={loading ? null : pitchers.length} />

      {loading ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border p-8 text-center text-gray-400 dark:text-gray-500 animate-pulse">
          Loading WCL portal...
        </div>
      ) : board === 'hitters' ? (
        <PlayerTrackerTable rows={hitters} statCols={HITTER_STAT_COLS} groupLabel="WCL Hitting"
          sortBy={sortBy} sortDir={sortDir} onSort={handleSort}
          infoLabel="WCL Team" committedHeader="Spring School" playerHref={wclHref} />
      ) : (
        <PlayerTrackerTable rows={pitchers} statCols={PITCHER_STAT_COLS} groupLabel="WCL Pitching"
          sortBy={sortBy} sortDir={sortDir} onSort={handleSort}
          infoLabel="WCL Team" committedHeader="Spring School" playerHref={wclHref} />
      )}
    </div>
  )
}
