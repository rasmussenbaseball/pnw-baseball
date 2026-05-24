/**
 * NWAC sophomore transfer destinations.
 *
 * When an NWAC SO completes their 2-year career, real life: they commit to
 * a 4-year program. Per Nate (May 2026): an 80-OVR SO transfers to a random
 * ~80-OVR school; a 92-OVR SO transfers to a random ~92-OVR school. We
 * compute every D1/D2/D3/NAIA program's expected Team OVR via the
 * rank-bucketed system (programRating.js) and match the player to a school
 * of similar OVR with a regional (PNW) bias.
 *
 * Destination is purely cosmetic — the transferred player doesn't appear
 * on the receiving team's roster. It's a newsfeed flourish + the NWAC
 * Alumni tracking pane + a small coach-progression bonus (better
 * destinations = more coach points the user earns from developing JUCO
 * talent into 4-year prospects).
 */

import nonNaiaRaw from '../data/non_naia_teams.json'
import pearNaia from '../data/pear_ratings_2026.json'
import { ovrForLevelRank } from './programRating'
import { awardCoachUpgradePoints } from './coachProgression'

// ─── Unified team pool (D1/D2/D3/NAIA) with computed OVR ───────────────
//
// We assign an OVR to every program using the same rank-bucketed system
// the team-selector uses (programRating.js / ovrForLevelRank). For NAIA we
// derive a rank by sorting PEAR ratings; D1/D2/D3 already have pearRank
// in non_naia_teams.json.

/** PNW + nearby state codes. */
const PNW_STATES = new Set(['WA', 'OR', 'ID', 'MT', 'BC'])
const WEST_STATES = new Set(['WA', 'OR', 'ID', 'MT', 'BC', 'CA', 'NV', 'AZ', 'UT', 'CO'])

function extractStateFromName(name) {
  const m = name?.match(/\(([A-Z]{2})\)\s*$/)
  return m ? m[1] : null
}

/** Flat list of D1/D2/D3 programs from non_naia_teams.json, with OVR. */
function nonNaiaWithOvr() {
  const out = []
  for (const div of nonNaiaRaw.divisions || []) {
    if (div.id !== 'D1' && div.id !== 'D2' && div.id !== 'D3') continue
    for (const t of div.teams || []) {
      const ovr = ovrForLevelRank(div.id, t.pearRank)
      if (typeof ovr !== 'number') continue
      out.push({
        id: t.id, name: t.name, state: t.state || null,
        division: div.id, conference: t.pearConference || null,
        ovr,
      })
    }
  }
  return out
}

/** NAIA programs from pear_ratings_2026.json, with OVR derived from rank. */
function naiaWithOvr() {
  const stats = pearNaia?.stats || []
  // Filter to NAIA-ish conferences (PEAR mixes some divisions). Use a
  // permissive include — NAIA conf names are diverse — and fall back to
  // best-effort rank assignment.
  const naia = stats.filter(t => {
    const c = String(t.Conference || '')
    return !/Big Ten|SEC|ACC|Pac-12|Big 12|WCC|Sun Belt|American|Mountain West|WAC|MVC|Horizon|MAC|Big West|Big South|Patriot|Ivy|MEAC|SWAC|CAA|A-10|Big East|Atlantic Sun|Conference USA|Southland|OVC|Big Sky|Summit|Northeast|MAAC|GAC|Continental AC|Crossroads|Cascade Conference|Frontier|Heart of America|Mid-South|North Star|Sooner|Wolverine-Hoosier|American Midwest|Great Plains|Kansas Coll|Red River|River States/i.test(c) || /NAIA|Frontier|Cascade|Sooner|Heart|Crossroads|Continental|Mid-South|North Star|Wolverine|Red River|River States|Kansas Coll/i.test(c)
  })
  // Best-effort: just include EVERY team in the file and rank globally,
  // then assign OVR via NAIA window. This produces some D1 schools mixed
  // in (since PEAR includes them) but the OVR math still works because
  // we cap NAIA at OVR 84.
  const sorted = [...stats].sort((a, b) => (b.Rating ?? 0) - (a.Rating ?? 0))
  return sorted.map((t, idx) => {
    const ovr = ovrForLevelRank('NAIA', idx + 1)
    if (typeof ovr !== 'number') return null
    return {
      id: 'naia-' + (t.Team || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: t.Team,
      state: extractStateFromName(t.Team),
      division: 'NAIA',
      conference: t.Conference,
      ovr,
    }
  }).filter(Boolean)
}

/** All possible transfer destinations, with each program's expected OVR. */
const ALL_DESTINATIONS = (() => {
  const non = nonNaiaWithOvr()
  const naia = naiaWithOvr()
  return [...non, ...naia]
})()

// ─── Main picker ─────────────────────────────────────────────────────────

/**
 * Pick a destination for an NWAC sophomore transferring out, OVR-matched.
 *
 * Per Nate: an 80-OVR SO transfers to a random ~80-OVR school; a 92-OVR
 * SO transfers to a random ~92-OVR school. We find every program with
 * Team OVR within ±3 of the player's OVR, apply a regional (PNW) bias
 * (stronger for lower-tier kids who want to stay close to home), and
 * random-pick from that set.
 *
 * @param {{ ovr: number, hometown?: { state?: string } }} player
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @returns {{ tier: string, division: string, name: string, state: string|null, conference: string|null, id: string|null, destOvr: number } | null}
 */
export function pickNwacTransferDestination(player, rng) {
  const ovr = Math.max(20, Math.min(99, player.ovr ?? 60))
  // Walk-on cutoff — kids below 50 OVR typically don't get picked up by a
  // 4-year program. Real life: NWAC bench kids who can't crack 4-yr depth.
  if (ovr < 50) {
    return {
      tier: 'WALKON', division: 'NONE',
      name: 'Career ended — no 4-yr offer',
      state: null, conference: null, id: null, destOvr: 0,
    }
  }

  // Match window — ±3 OVR for a credible "you sent them to a similar
  // program" feel. Widen the window if there aren't enough candidates.
  let window = 3
  let pool = ALL_DESTINATIONS.filter(d => Math.abs(d.ovr - ovr) <= window)
  while (pool.length < 6 && window < 10) {
    window += 1
    pool = ALL_DESTINATIONS.filter(d => Math.abs(d.ovr - ovr) <= window)
  }
  if (pool.length === 0) {
    // Fall back to nearest neighbor if the OVR is way out of range.
    const sorted = [...ALL_DESTINATIONS].sort((a, b) => Math.abs(a.ovr - ovr) - Math.abs(b.ovr - ovr))
    pool = sorted.slice(0, 5)
  }

  // Regional preference — lower-tier kids stay PNW; elite kids go where
  // the opportunity is.
  const pnwPref = ovr >= 88 ? 0.30
    : ovr >= 78 ? 0.50
    : ovr >= 68 ? 0.65
    : 0.75
  const preferPnw = rng.chance(pnwPref)
  let candidates = pool
  if (preferPnw) {
    const pnwOnly = pool.filter(t => PNW_STATES.has(t.state))
    if (pnwOnly.length > 0) candidates = pnwOnly
  } else if (ovr < 88) {
    const westOnly = pool.filter(t => WEST_STATES.has(t.state))
    if (westOnly.length > 0 && rng.chance(0.6)) candidates = westOnly
  }

  // Uniform-random pick within the OVR-matched, region-filtered pool.
  const pick = candidates[Math.floor(rng.next() * candidates.length)] || candidates[0]
  if (!pick) return null

  // Tier label for back-compat with newsfeed string formatting.
  const tier = pick.ovr >= 90 ? 'ELITE'
    : pick.ovr >= 80 ? 'HIGH'
    : pick.ovr >= 70 ? 'MID'
    : pick.ovr >= 60 ? 'AVG'
    : 'LOW'

  return {
    tier,
    division: pick.division,
    name: pick.name,
    state: pick.state || null,
    conference: pick.conference || null,
    id: pick.id || null,
    destOvr: pick.ovr,
  }
}

/**
 * Run transfer-destination picking for every player on the user's roster
 * who's transferring out at end of year (NWAC SO). Stores results on the
 * player record AND on state.nwacAlumni[year] for the Dashboard widget.
 *
 * @param {object} state
 */
export function assignNwacTransferDestinations(state) {
  if (state.level !== 'NWAC') return
  const rng = makePersistentRng(state)
  if (!state.nwacAlumni) state.nwacAlumni = {}
  const year = state.calendar?.year ?? 0
  if (!state.nwacAlumni[year]) state.nwacAlumni[year] = []

  const userTeam = state.teams?.[state.userSchoolId]
  if (!userTeam) return
  const userTeamId = state.userSchoolId

  // Coaching points pile-up. We tally up the OVR of EVERY destination for
  // players who came from the USER'S team, and award coach upgrade points
  // based on those destinations: each kid sent to a high-OVR school is
  // worth more. This is NWAC's analog to the D1 MLB-draft-pick bonus.
  let userCoachPts = 0

  // Find all just-transferred players (set by runDevelopment when SO → GRAD)
  // We re-scan the players map by transferred status + classYear === 'SO'
  for (const p of Object.values(state.players || {})) {
    if (p.eligibilityStatus !== 'transferred') continue
    if (p.classYear !== 'SO') continue
    if (p._nwacTransferDest) continue   // already picked

    const ovr = computePlayerOvr(p)
    const dest = pickNwacTransferDestination({ ovr, hometown: p.hometown }, rng)
    p._nwacTransferDest = dest

    state.nwacAlumni[year].push({
      playerId: p.id,
      playerName: `${p.firstName} ${p.lastName}`,
      ovr,
      position: p.primaryPosition,
      hometown: p.hometown,
      destination: dest,
    })

    // Coach-progression bonus — only for the user's own team. Per Nate:
    // sending kids to bigger 4-yr programs IS the win condition for an
    // NWAC coach. Award scales with destination tier:
    //   D1 destination (~85+ OVR): 3 pts
    //   D2 destination (~70-84 OVR): 2 pts
    //   NAIA/D3 (~60-79): 1 pt
    //   NWAC walk-on / no offer: 0 pts
    if (p.schoolId === userTeamId && dest && dest.division !== 'NONE') {
      const destOvr = dest.destOvr ?? 0
      if (destOvr >= 85)      userCoachPts += 3
      else if (destOvr >= 70) userCoachPts += 2
      else if (destOvr >= 60) userCoachPts += 1
    }

    // Newsfeed line — call out the best transfers
    if (dest && dest.division !== 'NONE') {
      const headline = ovr >= 85
        ? `${p.firstName} ${p.lastName} (NWAC ${p.primaryPosition}, ${ovr} OVR) commits to ${dest.name}${dest.state ? ` (${dest.state})` : ''}!`
        : `${p.firstName} ${p.lastName} transfers to ${dest.name}${dest.division ? ` (${dest.division})` : ''}.`
      state.newsfeed.unshift({
        id: `nwac_xfer_${p.id}_${year}`,
        year, week: state.calendar?.week ?? 0, type: 'TRANSFER_OUT',
        headline,
        payload: { playerId: p.id, destination: dest, ovr },
        big: ovr >= 80,
      })
    }
  }

  // Award the coaching bonus once for the whole class.
  if (userCoachPts > 0) {
    awardCoachUpgradePoints(state, userCoachPts, `Sophomore class placed at 4-yr programs`)
  }
}

function makePersistentRng(state) {
  // Use rngSeed + year so each year produces a stable transfer crop
  const seed = (state.rngSeed || 1) ^ (state.calendar?.year || 2026) << 4
  let s = Math.abs(seed) || 1
  return {
    next() {
      s = (s * 1664525 + 1013904223) % 4294967296
      return s / 4294967296
    },
    chance(p) { return this.next() < p },
    weighted(items, weights) {
      const total = weights.reduce((a, b) => a + b, 0)
      let r = this.next() * total
      for (let i = 0; i < items.length; i++) {
        r -= weights[i]
        if (r <= 0) return items[i]
      }
      return items[items.length - 1]
    },
  }
}

function computePlayerOvr(p) {
  if (p.isPitcher && p.pitcher) {
    const v = [
      p.pitcher.stuff, p.pitcher.control, p.pitcher.command,
      p.pitcher.stamina, p.pitcher.vs_l, p.pitcher.vs_r,
    ].filter(x => typeof x === 'number')
    if (v.length === 0) return 60
    return Math.round(v.reduce((a, b) => a + b, 0) / v.length)
  }
  if (p.hitter) {
    const v = [
      p.hitter.contact_l, p.hitter.contact_r,
      p.hitter.power_l, p.hitter.power_r,
      p.hitter.discipline, p.hitter.speed,
      p.hitter.fielding, p.hitter.arm,
    ].filter(x => typeof x === 'number')
    if (v.length === 0) return 60
    return Math.round(v.reduce((a, b) => a + b, 0) / v.length)
  }
  return 60
}
