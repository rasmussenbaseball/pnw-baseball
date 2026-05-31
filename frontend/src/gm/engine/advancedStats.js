/**
 * Advanced sabermetric stats — wOBA, wRC+, FIP, xFIP, WAR, plus rate stats.
 *
 * Ported from the main NWBB site (backend/app/stats/advanced.py) into JS
 * for the GM game. Linear weights are calibrated to NAIA-level run
 * environments (slightly more offense than D1, more singles, fewer HR).
 *
 * The GM stats schema (see season.js / sim.js) stores per-player rows like:
 *   batter:  { ab, h, d, t, hr, bb, k, rbi, pa, hbp, sf, sac, gidp, roe }
 *   pitcher: { ip, h, bb, k, er, outs, pa, hbp, hr }
 * pa on a pitcher row is BF (batters faced) — the engine names them the same.
 * `outs` is the source of truth for IP; `ip` is a derived display value
 * (6.2 = 6 and 2/3 innings, baseball notation).
 *
 * USAGE:
 *   import { computeBatting, computePitching, leagueAverages } from './advancedStats'
 *   const lg = leagueAverages(state)
 *   const adv = computeBatting(playerStat, lg)
 *   // adv = { avg, obp, slg, ops, iso, babip, bbPct, kPct, wOBA, wRC, wRCplus, oWAR, ... }
 */

// ─── NAIA linear weights ────────────────────────────────────────────────────
//
// These are slightly hotter than D1 to reflect NAIA's higher run environment
// (smaller parks, less elite pitching). Values cribbed from D1/D2 NCAA-level
// weights then tuned upward.
export const NAIA_WEIGHTS = {
  wBB: 0.70,
  wHBP: 0.73,
  w1B: 0.90,
  w2B: 1.27,
  w3B: 1.60,
  wHR: 2.05,
  wOBAScale: 1.24,
  runsPerPA: 0.135,    // league mean R/PA
  runsPerWin: 9.5,     // ~9.5 runs per marginal win at this level
}

// ─── Safe division ──────────────────────────────────────────────────────────

function safeDiv(num, den, def = 0) {
  if (!den || den === 0) return def
  return num / den
}

// ─── Innings <-> outs ───────────────────────────────────────────────────────

/** Convert IP notation (6.2 = 6 2/3) to total outs. */
export function ipToOuts(ip) {
  if (!ip) return 0
  const full = Math.floor(ip)
  const partial = Math.round((ip - full) * 10)
  return full * 3 + partial
}

/** Convert total outs to IP notation (20 outs → 6.2). */
export function outsToIp(outs) {
  if (!outs) return 0
  const full = Math.floor(outs / 3)
  const partial = outs % 3
  return full + partial / 10
}

/** Convert total outs to true decimal innings (20 outs → 6.667). */
export function outsToDecimalIp(outs) {
  if (!outs) return 0
  return outs / 3
}

/**
 * Format a decimal-IP value (the legacy outs/3 storage shape) into baseball
 * notation "X.Y" where Y ∈ {0,1,2} represents thirds of an inning. The old
 * display path used `ip.toFixed(1)`, which produced "6.7" for 20 outs — read
 * by users as 6 and 7/10 of an inning, when the real value is 6.2 (6 IP + 2
 * outs). Reported by Zack Ahn, May 2026.
 */
export function formatIp(ip) {
  if (ip == null || Number.isNaN(ip)) return '—'
  const outs = Math.max(0, Math.round(ip * 3))
  return outsToIp(outs).toFixed(1)
}

// ─── League averages (computed from the user's save) ────────────────────────

/**
 * Compute league-wide averages from save.playerStats. The user's GM save
 * stores every player's accumulated season totals so we can derive league
 * wOBA, OBP, ERA, FIP, etc. in one pass.
 *
 * @param {object} state  the dynasty save
 * @returns {{
 *   leagueWoba: number, leagueObp: number, leagueEra: number,
 *   leagueFip: number, fipConstant: number, hrFbRate: number,
 *   weights: typeof NAIA_WEIGHTS,
 * }}
 */
export function leagueAverages(state) {
  const weights = NAIA_WEIGHTS
  if (!state?.playerStats) {
    return { leagueWoba: 0.320, leagueObp: 0.340, leagueEra: 4.50, leagueFip: 4.20, fipConstant: 3.10, hrFbRate: 0.10, weights }
  }

  // Sum totals across every stat row in the save (all teams, not just the
  // user's). Faithful league-wide aggregate; this number is small enough
  // (50 schools × 50 players ≈ 2500 rows) to compute on demand.
  let pa = 0, ab = 0, h = 0, d = 0, t = 0, hr = 0, bb = 0, ibb = 0, hbp = 0, sf = 0, k = 0
  let pOuts = 0, pER = 0, pBB = 0, pK = 0, pHR = 0, pHBP = 0, pBF = 0
  for (const row of Object.values(state.playerStats)) {
    if (row.isPitcher) {
      pOuts += row.outs || 0
      pER += row.er || 0
      pBB += row.bb || 0
      pK += row.k || 0
      pHR += row.hr || 0
      pHBP += row.hbp || 0
      pBF += row.pa || 0
    } else {
      pa += row.pa || 0
      ab += row.ab || 0
      h += row.h || 0
      d += row.d || 0
      t += row.t || 0
      hr += row.hr || 0
      bb += row.bb || 0
      ibb += row.ibb || 0
      hbp += row.hbp || 0
      sf += row.sf || 0
      k += row.k || 0
    }
  }
  const singles = Math.max(0, h - d - t - hr)
  const ubb = Math.max(0, bb - ibb)
  // wOBA
  const wobaNum = weights.wBB * ubb + weights.wHBP * hbp + weights.w1B * singles +
                  weights.w2B * d + weights.w3B * t + weights.wHR * hr
  const wobaDen = ab + ubb + sf + hbp
  const leagueWoba = safeDiv(wobaNum, wobaDen, 0.320)
  const leagueObp = safeDiv(h + bb + hbp, ab + bb + hbp + sf, 0.340)

  // FIP constant: lgERA - ((13*lgHR + 3*(lgBB+lgHBP) - 2*lgK) / lgIP)
  const lgIp = outsToDecimalIp(pOuts)
  const leagueEra = safeDiv(pER * 9, lgIp, 4.50)
  const fipConstant = lgIp > 0
    ? leagueEra - (13 * pHR + 3 * (pBB + pHBP) - 2 * pK) / lgIp
    : 3.10
  const leagueFip = leagueEra   // by construction FIP averages to ERA league-wide
  // HR/FB estimate — fall back to the 0.10 default if we have no signal
  const estimatedFb = (pBF - pK - pBB - pHBP) * 0.35
  const hrFbRate = estimatedFb > 0 ? Math.min(0.25, Math.max(0.05, pHR / estimatedFb)) : 0.10

  return { leagueWoba, leagueObp, leagueEra, leagueFip, fipConstant, hrFbRate, weights }
}

// ─── Batting advanced stats ─────────────────────────────────────────────────

/**
 * @param {object} line   { ab, h, d, t, hr, bb, ibb?, hbp, sf, sac?, k, pa }
 * @param {ReturnType<typeof leagueAverages>} lg
 */
export function computeBatting(line, lg) {
  const weights = lg.weights
  const ab = line.ab || 0
  const h = line.h || 0
  const d = line.d || 0
  const t = line.t || 0
  const hr = line.hr || 0
  const bb = line.bb || 0
  const ibb = line.ibb || 0
  const hbp = line.hbp || 0
  const sf = line.sf || 0
  const k = line.k || 0
  const pa = line.pa || (ab + bb + hbp + sf + (line.sac || 0))
  const singles = Math.max(0, h - d - t - hr)
  const ubb = Math.max(0, bb - ibb)
  const tb = singles + 2 * d + 3 * t + 4 * hr

  const avg = safeDiv(h, ab)
  const obp = safeDiv(h + bb + hbp, ab + bb + hbp + sf)
  const slg = safeDiv(tb, ab)
  const ops = obp + slg
  const iso = slg - avg
  // BABIP = (H - HR) / (AB - K - HR + SF)
  const babipDen = ab - k - hr + sf
  const babip = babipDen > 0 ? safeDiv(h - hr, babipDen) : 0
  const bbPct = safeDiv(bb, pa)
  const kPct = safeDiv(k, pa)

  // wOBA
  const wobaNum = weights.wBB * ubb + weights.wHBP * hbp + weights.w1B * singles +
                  weights.w2B * d + weights.w3B * t + weights.wHR * hr
  const wobaDen = ab + ubb + sf + hbp
  const wOBA = safeDiv(wobaNum, wobaDen)

  // wRAA = ((wOBA - lgwOBA) / wOBAScale) * PA
  const wRAA = ((wOBA - lg.leagueWoba) / weights.wOBAScale) * pa
  // wRC = (((wOBA - lgwOBA) / wOBAScale) + lgR/PA) * PA
  const wRC = (((wOBA - lg.leagueWoba) / weights.wOBAScale) + weights.runsPerPA) * pa
  // wRC+ = 100 * (wRAA/PA + lgR/PA) / lgR/PA
  const wRCplus = pa > 0 && weights.runsPerPA > 0
    ? Math.round(100 * ((wRAA / pa + weights.runsPerPA) / weights.runsPerPA))
    : 0
  // Offensive WAR (simplified — wRAA / runs_per_win)
  const oWAR = safeDiv(wRAA, weights.runsPerWin)

  return { avg, obp, slg, ops, iso, babip, bbPct, kPct, wOBA, wRAA, wRC, wRCplus, oWAR, pa }
}

// ─── Pitching advanced stats ────────────────────────────────────────────────

/**
 * @param {object} line  { outs, h, bb, k, er, hr, hbp, pa(=BF) }
 * @param {ReturnType<typeof leagueAverages>} lg
 */
export function computePitching(line, lg) {
  const ip = outsToDecimalIp(line.outs || 0)
  const bb = line.bb || 0
  const k = line.k || 0
  const hr = line.hr || 0
  const hbp = line.hbp || 0
  const h = line.h || 0
  const er = line.er || 0
  const bf = line.pa || 0
  const ibb = line.ibb || 0

  const era = ip > 0 ? safeDiv(er * 9, ip) : 0
  const whip = ip > 0 ? safeDiv(h + bb, ip) : 0
  const kPer9 = ip > 0 ? safeDiv(k * 9, ip) : 0
  const bbPer9 = ip > 0 ? safeDiv(bb * 9, ip) : 0
  const hr9 = ip > 0 ? safeDiv(hr * 9, ip) : 0
  const kbb = bb > 0 ? safeDiv(k, bb) : (k > 0 ? Infinity : 0)
  const kPct = safeDiv(k, bf)
  const bbPct = safeDiv(bb, bf)

  // FIP = ((13*HR + 3*(BB+HBP) - 2*K) / IP) + FIP_constant
  const fip = ip > 0
    ? (13 * hr + 3 * (bb + hbp) - 2 * k) / ip + lg.fipConstant
    : 0

  // xFIP — replace HR rate with league HR/FB applied to estimated FB
  let xfip = 0
  if (ip > 0) {
    const estBip = bf > 0 ? bf - k - bb - hbp : ip * 3
    const estFb = Math.max(0, estBip) * 0.35
    const xHr = estFb * lg.hrFbRate
    xfip = (13 * xHr + 3 * (bb + hbp) - 2 * k) / ip + lg.fipConstant
  }

  // BABIP-against = (H - HR) / (BF - K - HR - BB - HBP)
  const bip = bf - k - bb - hbp - hr
  const hitsInPlay = h - hr
  const babip = bip > 0 && hitsInPlay >= 0 && hitsInPlay <= bip
    ? safeDiv(hitsInPlay, bip)
    : 0

  // Pitching WAR (simplified, no replacement-level adjustment):
  // pWAR = ((leagueFIP - FIP) / runsPerWin) * (IP / 9)
  const pWAR = ip > 0
    ? ((lg.leagueFip - fip) / lg.weights.runsPerWin) * (ip / 9)
    : 0

  return { ip, era, whip, kPer9, bbPer9, hr9, kbb, kPct, bbPct, fip, xfip, babip, pWAR, bf }
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

export function fmtRate(v) {
  if (v == null || isNaN(v)) return '—'
  return v.toFixed(3).replace(/^0\./, '.')
}

export function fmt2(v) {
  if (v == null || isNaN(v)) return '—'
  return v.toFixed(2)
}

export function fmtPct(v) {
  if (v == null || isNaN(v)) return '—'
  return (v * 100).toFixed(1) + '%'
}

export function fmtWar(v) {
  if (v == null || isNaN(v)) return '—'
  return v.toFixed(1)
}
