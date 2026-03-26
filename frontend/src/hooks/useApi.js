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
 * Fetch player profile.
 */
export function usePlayer(playerId, percentileSeason = null) {
  const params = percentileSeason ? { percentile_season: percentileSeason } : {}
  return useApi(`/players/${playerId}`, params, [playerId, percentileSeason])
}

/**
 * Fetch stat leaders (top N per category).
 */
export function useStatLeaders(season, limit = 5, qualified = false) {
  return useApi('/stat-leaders', { season, limit, qualified }, [season, limit, qualified])
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
