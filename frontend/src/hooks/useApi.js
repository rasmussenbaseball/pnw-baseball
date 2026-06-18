import { useState, useEffect, useCallback } from 'react'
import { CURRENT_SEASON } from '../utils/constants'
import { supabase } from '../lib/supabase'
import { bumpPending, decrementPending } from '../lib/pendingRequests'

const API_BASE = '/api/v1'

// Pull the current Supabase access token (if any) and shape it as a
// Bearer header. Returns {} for anonymous so the fetch goes out
// without an Authorization header at all. This lets the backend
// distinguish anon from signed-in callers; tier-gated endpoints can
// reject anon, while public endpoints just ignore the token.
async function _authHeaders() {
  try {
    const { data } = await supabase.auth.getSession()
    const t = data?.session?.access_token
    return t ? { Authorization: `Bearer ${t}` } : {}
  } catch { return {} }
}

/**
 * Generic API hook for fetching data with loading/error states.
 *
 * IMPORTANT — `deps` contract: pass PRIMITIVES only (strings, numbers,
 * booleans), e.g. `[divisionId]`. Param changes are already covered by
 * JSON.stringify(params) in the fetch callback, so most callers can omit
 * deps entirely. Passing a fresh object/array literal in deps makes the
 * effect re-fire on EVERY render — an infinite refetch loop hammering
 * the API. If you need an object dependency, stringify it first.
 */
export function useApi(endpoint, params = {}, deps = []) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)

    // Allow callers to opt out of the fetch by passing null/undefined
    // as the endpoint — useful for conditional hooks (e.g. don't fetch
    // vs-team data when no portal team is selected).
    if (!endpoint) {
      setLoading(false)
      setData(null)
      return
    }

    // Bump the global pending-request counter so the GlobalRouteLoader
    // knows at least one fetch is in flight. Always paired with a
    // decrement in `finally` (success or error).
    bumpPending()
    try {
      const searchParams = new URLSearchParams()
      Object.entries(params).forEach(([key, value]) => {
        if (value !== null && value !== undefined && value !== '') {
          searchParams.set(key, value)
        }
      })

      const url = `${API_BASE}${endpoint}?${searchParams.toString()}`
      const response = await fetch(url, { headers: await _authHeaders() })

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      const result = await response.json()
      setData(result)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
      decrementPending()
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

/** Teams that have projections (for the Projections page team picker). */
export function useProjectionTeams(season = 2027) {
  return useApi('/projections/teams', { season }, [season])
}

/** 2027 projected hitters + pitchers for a team (returning + incoming). */
export function useTeamProjections(teamId, season = 2027) {
  return useApi(teamId ? `/teams/${teamId}/projections` : null, { season }, [teamId, season])
}

/**
 * Fetch the rich team-overview payload used by the social info-graphic
 * — record splits, run diff, Pythag, national/conf/power ranks, top 5
 * hitters and pitchers (with headshots + rate stats), 5-stat batting
 * AND pitching percentile cards vs division, and last 5 games.
 *
 * Excellent single-payload data source for a coach dashboard.
 */
export function useTeamInfoGraphic(teamId, season) {
  return useApi(
    `/teams/${teamId}/info-graphic`,
    { season },
    [teamId, season],
  )
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
 * Fetch hitter plate-discipline leaderboard (PBP preset).
 */
export function useBattingPbpLeaderboard(params) {
  return useApi('/leaderboards/batting-pbp', params, [JSON.stringify(params)])
}

/**
 * Fetch pitcher pitch-level leaderboard (PBP preset).
 */
export function usePitchingPbpLeaderboard(params) {
  return useApi('/leaderboards/pitching-pbp', params, [JSON.stringify(params)])
}

/**
 * Fetch fielding leaderboard. `position` filter is optional — omit
 * (or pass empty string) for an all-positions view that prefers the
 * official season total per player, falling back to summed
 * per-position rows where no season-total exists (e.g., D1).
 */
export function useFieldingLeaderboard(params) {
  return useApi('/leaderboards/fielding', params, [JSON.stringify(params)])
}

export function useRelieverLeaderboard(params) {
  return useApi('/leaderboards/relievers', params, [JSON.stringify(params)])
}

/**
 * Fetch WAR leaderboard.
 */
export function useWarLeaderboard(params) {
  return useApi('/leaderboards/war', params, [JSON.stringify(params)])
}

/**
 * Fetch team-level aggregated stats.
 */
export function useTeamStatsAgg(params) {
  return useApi('/team-stats', params, [JSON.stringify(params)])
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
export function usePlayerGameLogs(playerId, season = CURRENT_SEASON) {
  return useApi(`/players/${playerId}/gamelogs`, { season }, [playerId, season])
}

/**
 * Fetch a reliever's Goose Egg line (GEG / BRK / OPP / Goose%) for a season.
 */
export function usePlayerGooseEggs(playerId, season = CURRENT_SEASON) {
  return useApi(`/players/${playerId}/goose-eggs`, { season }, [playerId, season])
}

/**
 * Fetch player home/road splits for a season (or career if season is null).
 */
export function usePlayerSplits(playerId, season = CURRENT_SEASON) {
  const params = season ? { season } : {}
  return useApi(`/players/${playerId}/splits`, params, [playerId, season])
}

/**
 * Fetch player pitch-level stats (Phase 1 PBP-derived) — discipline,
 * count-state slash lines, L/R splits. Returns null discipline.pa
 * when the player has no game_events.
 */
export function usePlayerPitchLevelStats(playerId, season = CURRENT_SEASON, endpoint = null) {
  // `endpoint` override lets the summer player profile point the same
  // card at /summer/players/{id}/pitch-level-stats (same payload shape).
  return useApi(
    endpoint || `/players/${playerId}/pitch-level-stats`,
    { season },
    [playerId, season, endpoint]
  )
}

/**
 * Same idea but for pitchers: opponent slash + induced K%/Whiff%/etc.
 */
/**
 * Per-game WPA totals + running cumulative for the rolling chart on
 * the player profile. Returns { batter: [...], pitcher: [...] } so
 * two-way players can render both sides.
 */
export function usePlayerWpaByGame(playerId, season = CURRENT_SEASON) {
  return useApi(
    playerId ? `/players/${playerId}/wpa-by-game` : null,
    { season },
    [playerId, season]
  )
}

export function usePlayerPitchLevelStatsPitcher(playerId, season = CURRENT_SEASON, endpoint = null) {
  // `endpoint` override — see usePlayerPitchLevelStats.
  return useApi(
    endpoint || `/players/${playerId}/pitch-level-stats-pitcher`,
    { season },
    [playerId, season, endpoint]
  )
}

/**
 * Player's stats vs a specific opposing team (PBP-derived). Used by the
 * Player Card PDF when a portal team is set. Pass null teamId to skip
 * the fetch (no team selected).
 */
export function usePlayerVsTeam(playerId, teamId, side = 'batting', season = CURRENT_SEASON) {
  return useApi(
    teamId ? `/players/${playerId}/vs-team/${teamId}` : null,
    { season, side },
    [playerId, teamId, side, season]
  )
}

/**
 * Strikeout events for/by this player. When teamId is provided,
 * filters to K's where the opponent (pitcher / batter) is on that
 * team — used by the Player Card PDF's vs-team strikeout panel.
 */
export function usePlayerRecentKs(playerId, side = 'batting', teamId = null, season = CURRENT_SEASON, limit = 20) {
  const params = { season, side, limit }
  if (teamId) params.team_id = teamId
  return useApi(
    `/players/${playerId}/recent-ks`,
    params,
    [playerId, side, teamId, season, limit]
  )
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
 * Fetch CPI (Composite Power Index) team ratings by division.
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
 * Top moments of the season — best single-PA WPA swings + clutch
 * leaderboards for hitters and pitchers. Powers the /top-moments page.
 */
export function useTopMoments(season = 2026, opts = {}) {
  return useApi('/top-moments', { season, ...opts }, [season, JSON.stringify(opts)])
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
export function useRecentGames(season = CURRENT_SEASON, limit = 50, teamId = null, division = null) {
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
export function useTeamGames(teamId, season = CURRENT_SEASON) {
  return useApi(`/teams/${teamId}/games`, { season }, [teamId, season])
}

/**
 * Fetch compact ticker data (most recent results).
 */
export function useGamesTicker(season = CURRENT_SEASON, limit = 12) {
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
export function useKeyMatchup(date, season = CURRENT_SEASON) {
  return useApi('/games/key-matchup', { date, season }, [date, season])
}

export function useWinProbabilities(date, season = CURRENT_SEASON) {
  return useApi(date ? '/games/win-probabilities' : null, { date, season }, [date, season])
}

/**
 * Biggest upset from the most recent day with PNW-vs-PNW games.
 */
export function useUpsetOfTheDay(season = CURRENT_SEASON) {
  return useApi('/games/upset-of-the-day', { season }, [season])
}

/**
 * Top performers for a given date (hitters + pitchers).
 */
export function useDailyPerformers(date, season = CURRENT_SEASON) {
  return useApi('/games/daily-performers', { date, season }, [date, season])
}

/**
 * Quality starts leaderboard.
 */
export function useQualityStarts(season = CURRENT_SEASON, limit = 25) {
  return useApi('/games/quality-starts', { season, limit }, [season, limit])
}

/**
 * Top game scores leaderboard.
 */
export function useGameScores(season = CURRENT_SEASON, limit = 25) {
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
export function useRecruitingBreakdown(season = CURRENT_SEASON) {
  return useApi('/recruiting/breakdown', { season }, [season])
}

/**
 * Recruiting Classes leaderboard - per-school HS commit class summaries
 * for a grad year (PREMIUM-gated). Sorted by class_score desc.
 */
export function useRecruitingClasses(gradYear = 2026) {
  return useApi('/recruiting/classes', { grad_year: gradYear }, [gradYear])
}

/**
 * One school's full HS commit list for a grad year (PREMIUM-gated). Pass
 * null teamId to skip the fetch (used when no leaderboard row is expanded).
 */
export function useRecruitingClassDetail(teamId, gradYear = 2026) {
  return useApi(
    teamId ? `/recruiting/classes/${teamId}` : null,
    { grad_year: gradYear },
    [teamId, gradYear]
  )
}

/**
 * Transfer commits (JUCO + portal) grouped by destination PNW program
 * (PREMIUM-gated). Powers the "Transfers" and "Combined" views on the
 * Recruiting Classes page. Transfers are unrated for now (listed only).
 */
export function useRecruitingTransfers(gradYear = 2026) {
  return useApi('/recruiting/transfers', { grad_year: gradYear }, [gradYear])
}

/**
 * A team's incoming HS commits for a grad year (PUBLIC) - powers the
 * team-page "Incoming Class" section. Pass null teamId to skip.
 */
export function useTeamRecruits(teamId, gradYear = 2026) {
  return useApi(
    teamId ? `/teams/${teamId}/recruits` : null,
    { grad_year: gradYear },
    [teamId, gradYear]
  )
}

export function useIncomingTransfers(teamId) {
  return useApi(
    teamId ? `/teams/${teamId}/incoming-transfers` : null,
    {},
    [teamId]
  )
}

/**
 * Top recruiting classes (PUBLIC) - capped leaderboard for the homepage /
 * Recruiting Hub teaser card.
 */
export function useTopRecruitingClasses(gradYear = 2026, limit = 5) {
  return useApi('/recruiting/classes/top', { grad_year: gradYear, limit }, [gradYear, limit])
}

/**
 * Opponent Trends - comprehensive scouting report for a team.
 */
export function useOpponentTrends(teamId, season = CURRENT_SEASON) {
  return useApi(teamId ? `/opponent-trends/${teamId}` : null, { season }, [teamId, season])
}

/**
 * Historic Matchup - per-player batting and pitching aggregates from
 * every game two teams played each other in the given season, plus the
 * list of those games (scores, location, W/L/S decisions).
 */
export function useHistoricMatchup(teamA, teamB, season = CURRENT_SEASON) {
  return useApi(
    teamA && teamB ? '/coaching/historic-matchup' : null,
    { team_a: teamA, team_b: teamB, season },
    [teamA, teamB, season]
  )
}

/**
 * Historic Matchup opponents - distinct teams that team_a played at
 * least one final game against, used to populate the opponent dropdown.
 */
export function useHistoricMatchupOpponents(teamId, season = CURRENT_SEASON) {
  return useApi(
    teamId ? '/coaching/historic-matchup/opponents' : null,
    { team_a: teamId, season },
    [teamId, season]
  )
}

/**
 * NWAC Championship odds - Monte Carlo probability for each of the 8
 * championship teams to win the title (and to reach the grand final).
 */
export function useNwacChampionshipOdds(season = CURRENT_SEASON) {
  // Live tournament widget. The API is proxied through Vercel, whose edge
  // cache was serving a stale copy (e.g. a team shown eliminated minutes
  // after the result was corrected). A per-minute token makes the URL
  // unique each minute, bypassing the CDN copy and auto-refetching every
  // minute. The origin's own 180s cache keeps recompute cost bounded.
  const t = Math.floor(Date.now() / 60000)
  return useApi('/nwac-championship-odds', { season, _t: t }, [season, t])
}

/**
 * NWAC Tournament MVP tracker - top value players across the 8
 * championship teams (WAR rate, wRC+/FIP+), >=3 pitchers guaranteed.
 */
export function useNwacMvpTracker(season = CURRENT_SEASON) {
  // Same per-minute cache-bust as the odds widget so the tracker reflects
  // tournament games promptly instead of a stale edge-cached response.
  const t = Math.floor(Date.now() / 60000)
  return useApi('/nwac-mvp-tracker', { season, _t: t }, [season, t])
}
