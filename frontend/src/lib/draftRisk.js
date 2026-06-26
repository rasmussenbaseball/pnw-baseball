/**
 * Draft-risk lookup. A player ranked in the top 30 of the current (2026) PNW MLB
 * Draft Board may leave for pro ball, so even an underclassman who'd otherwise
 * "return" carries draft risk. Maps player_id -> {rank, pos, year} for the top N.
 * Source of truth: src/data/draftData.js (same board the /draftboard page uses).
 */
import { DRAFT_DATA } from '../data/draftData'

const DRAFT_YEAR = '26'
const TOP_N = 30

const _map = new Map()
for (const p of DRAFT_DATA[DRAFT_YEAR]?.prospects || []) {
  if (p.playerId && p.rank <= TOP_N) {
    _map.set(p.playerId, { rank: p.rank, pos: p.pos, year: DRAFT_DATA[DRAFT_YEAR].year })
  }
}

export function draftRisk(playerId) {
  return playerId ? _map.get(playerId) || null : null
}
