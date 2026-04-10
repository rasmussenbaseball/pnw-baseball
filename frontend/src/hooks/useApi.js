import { useState, useEffect, useCallback } from 'react'

const API_BASE = '/api/v1'

/**
 * Generic API hook for fetching data with loading/error states.
 */
export function useApi(endpoint, params = {}, deps = []) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const searchParams = new URLSearchParams()
      Object.entries(params).forEach(([key, value]) => {
        if (value !== null && value !== undefined && value !== '') {
          searchParams.set(key, value)
        }
      })

      const url = `${API_BASE}${endpoint}?${searchParams.toString()}`
      const response = await fetch(url)

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      const result = await response.json()
      setData(result)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [endpoint, JSON.stringify(params)])

  useEffect(() => {
    fetchData()
  }, [fetchData, ...deps])

  return { data, loading, error, refetch: fetchData }
}

/**
 * Fetch divisions list.
 */
export function useDivisions() {
  return useApi('/divisions')
}

/**
 * Fetch conferences, optionally filtered by division.
 */
export function useConferences(divisionId = null) {
  return useApi('/conferences', divisionId ? { division_id: divisionId } : {}, [divisionId])
}

/**
 * Fetch teams with optional filters.
 */
export function useTeams(filters = {}) {
  return useApi('/teams', filters, [JSON.stringify(filters)])
}

/**
 * Fetch teams with top hitter/pitcher summary.
 */
export function useTeamsSummary(params = {}) {
  return useApi('/teams/summary', params, [JSON.stringify(params)])
}

/**
 * Fetch full team stats (batting + pitching tables).
 */
export function useTeamStats(teamId, season) {
  return useApi(`/teams/${teamId}/stats`, { season }, [teamId, season])
}

/**
 * Fetch batting leaderboard.
 */
export function useBattingLeaderboard(params) {
  return useApi('/leaderboards/batting', params, [JSON.stringify(params)])
}

/**
 * Fetch pitching leaderboard.
 */
export function usePitchingLeaderboard(params) {
  return useApi('/leaderboards/pitching', params, [JSON.stringify(params)])
}

/**
 * Fetch WAR leaderboard.
 */
export function useWarLeaderboard(params) {
  return useApi('/leaderboards/war', params, [JSON.stringify(params)])
}

/**
 * Summer league batting leaderboard.
 */
export function useSummerBattingLeaderboard(params) {
  return useApi('/leaderboards/summer/batting', params, [JSON.stringify(params)])
}

/**
 * Summer league pitching leaderboard.
 */
export function useSummerPitchingLeaderboard(params) {
  return useApi('/leaderboards/summer/pitching', params, [JSON.stringify(params)])
}

/**
 * Summer leagues list.
 */
export function useSummerLeagues() {
  return useApi('/summer/leagues')
}

/**
 * Summer stat leaders (compact, for homepage widget).
 */
export function useSummerStatLeaders(season, league = 'WCL') {
  return useApi('/summer/stat-leaders', { season, league }, [season, league])
}

/**
 * Summer teams list.
 */
export function useSummerTeams(league = null) {
  const params = league ? { league } : {}
  return useApi('/summer/teams', params, [league])
}

/**
 * Available summer seasons.
 */
export function useSummerSeasons() {
  return useApi('/summer/seasons')
}

/**
 * Fetch player profile.
 */
export function usePlayer(playerId, percentileSeason = null) {
  const params = percentileSeason ? { percentile_season: percentileSeason } : {}
  return useApi(`/players/${playerId}`, params, [playerId, percentileSeason])
}

/**
 * Fetch player game logs (batting + pitching) for a season.
 */
export function usePlayerGameLogs(playerId, season = 2026) {
  return useApi(`/players/${playerId}/gamelogs`, { season }, [playerId, season])
}

/**
 * Fetch player home/road splits for a season (or career if season is null).
 */
export function usePlayerSplits(playerId, season = 2026) {
  const params = season ? { season } : {}
  return useApi(`/players/${playerId}/splits`, params, [playerId, season])
}

/**
 * Fetch stat leaders (top N per category).
 */
export function useStatLeaders(season, limit = 5, qualified = false, level = null, split = null) {
  const params = { season, limit, qualified }
  if (level) params.level = level
  if (split) params.split = split
  return useApi('/stat-leaders', params, [season, limit, qualified, level, split])
}

/**
 * Fetch standings data (conference + overall).
 */
export function useStandings(season) {
  return useApi('/standings', { season }, [season])
}

/**
 * Fetch PPI team ratings by division.
 */
export function useTeamRatings(season) {
  return useApi('/team-ratings', { season }, [season])
}

/**
 * Fetch national rankings (composite from Pear & CBR).
 */
export function useNationalRankings(season) {
  return useApi('/national-rankings', { season }, [season])
}

/**
 * Fetch rankings for a single team (national rank, conference rank, SOS).
 */
export function useTeamRankings(teamId, season) {
  return useApi(`/teams/${teamId}/rankings`, { season }, [teamId, season])
}

/**
 * Search players.
 */
export function usePlayerSearch(query, filters = {}) {
  return useApi('/players/search', { q: query, ...filters }, [query, JSON.stringify(filters)])
}

/**
 * Fetch available seasons (returns array of years like [2026, 2025, ...]).
 */
export function useSeasons() {
  return useApi('/seasons', {}, [])
}

/**
 * Fetch park factors data with optional filters.
 */
export function useParkFactors(filters = {}) {
  return useApi('/park-factors', filters, [JSON.stringify(filters)])
}

/**
 * Fetch team history (all seasons, leaders, career leaders).
 */
export function useTeamHistory(teamId) {
  return useApi(`/teams/${teamId}/history`, {}, [teamId])
}

// ─── Future Schedule ───

/**
 * Fetch future scheduled games for a team.
 */
export function useTeamFutureGames(teamId, limit = 10) {
  return useApi('/games/future', {
    team_id: teamId || undefined,
    limit,
  }, [teamId, limit])
}

// ─── Game Results & Box Scores ───

/**
 * Fetch recent game results (for results page).
 */
export function useRecentGames(season = 2026, limit = 50, teamId = null, division = null) {
  return useApi('/games/recent', {
    season, limit,
    team_id: teamId || undefined,
    division: division || undefined,
  }, [season, limit, teamId, division])
}

/**
 * Fetch full box score for a single game.
 */
export function useGameDetail(gameId) {
  return useApi(`/games/${gameId}`, {}, [gameId])
}

/**
 * Fetch all games for a team in a season.
 */
export function useTeamGames(teamId, season = 2026) {
  return useApi(`/teams/${teamId}/games`, { season }, [teamId, season])
}

/**
 * Fetch compact ticker data (most recent results).
 */
export function useGamesTicker(season = 2026, limit = 12) {
  return useApi('/games/ticker', { season, limit }, [season, limit])
}

/**
 * Live scores / scoreboard data.
 */
export function useLiveScores() {
  return useApi('/games/live', {}, [])
}

/**
 * Games for a specific date (used by scoreboard date picker).
 * Pass null to skip fetching (e.g., when viewing today's live scores).
 */
export function useGamesByDate(date) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!date) {
      setData(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)

    fetch(`${API_BASE}/games/by-date?date=${date}`)
      .then(r => {
        if (!r.ok) throw new Error(`API error: ${r.status}`)
        return r.json()
      })
      .then(result => { if (!cancelled) setData(result) })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [date])

  return { data, loading, error }
}

/**
 * Win probabilities for all PNW-vs-PNW games on a date.
 */
export function useWinProbabilities(date, season = 2026) {
  return useApi(date ? '/games/win-probabilities' : null, { date, season }, [date, season])
}

/**
 * Biggest upset from the most recent day with PNW-vs-PNW games.
 */
export function useUpsetOfTheDay(season = 2026) {
  return useApi('/games/upset-of-the-day', { season }, [season])
}

/**
 * Quality starts leaderboard.
 */
export function useQualityStarts(season = 2026, limit = 25) {
  return useApi('/games/quality-starts', { season, limit }, [season, limit])
}

/**
 * Top game scores leaderboard.
 */
export function useGameScores(season = 2026, limit = 25) {
  return useApi('/games/game-scores', { season, limit }, [season, limit])
}

/**
 * PNW Grid configuration.
 */
export function useGridConfig() {
  return useApi('/grid/config', {}, [])
}

/**
 * Fetch a random PNW Grid configuration.
 */
export async function gridFetchRandom() {
  const resp = await fetch(`${API_BASE}/grid/random`)
  if (!resp.ok) throw new Error('Failed to fetch random grid')
  return resp.json()
}

/**
 * PNW Grid player search (for autocomplete).
 */
export async function gridSearchPlayers(query) {
  if (!query || query.length < 2) return []
  const resp = await fetch(`${API_BASE}/grid/search?q=${encodeURIComponent(query)}&limit=8`)
  if (!resp.ok) return []
  return resp.json()
}

/**
 * PNW Grid guess check (weekly mode).
 */
export async function gridCheckGuess(playerId, row, col) {
  const resp = await fetch(`${API_BASE}/grid/check/${playerId}/${row}/${col}`)
  if (!resp.ok) throw new Error('Check failed')
  return resp.json()
}

/**
 * PNW Grid guess check (random/custom mode).
 */
export async function gridCheckCustom(playerId, rowCriteria, colCriteria) {
  const resp = await fetch(`${API_BASE}/grid/check-custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      player_id: playerId,
      row_criteria: rowCriteria,
      col_criteria: colCriteria,
    }),
  })
  if (!resp.ok) throw new Error('Check failed')
  return resp.json()
}

/**
 * Fetch all valid players for each cell of a grid.
 */
export async function gridFetchSolutions(rows, columns) {
  const resp = await fetch(`${API_BASE}/grid/solutions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows, columns }),
  })
  if (!resp.ok) throw new Error('Failed to fetch solutions')
  return resp.json()
}

/**
 * Fetch available grid options (teams, stats, conferences) for custom grid builder.
 */
export async function gridFetchOptions() {
  const resp = await fetch(`${API_BASE}/grid/options`)
  if (!resp.ok) throw new Error('Failed to fetch grid options')
  return resp.json()
}

/**
 * Validate a custom grid - check that every cell has at least 1 matching player.
 */
export async function gridValidateCustom(rows, columns) {
  const resp = await fetch(`${API_BASE}/grid/validate-custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows, columns }),
  })
  if (!resp.ok) throw new Error('Validation failed')
  return resp.json()
}

/**
 * Recruiting Breakdown - team-level recruiting metrics.
 */
export function useRecruitingBreakdown(season = 2026) {
  return useApi('/recruiting/breakdown', { season }, [season])
}
