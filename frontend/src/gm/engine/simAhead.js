/**
 * Week-recap helpers: snapshot the user-relevant slice of state before a
 * single-week advance, then diff it after, producing the rating / happiness /
 * GPA / budget / record changes the Dashboard's Week Recap modal renders.
 *
 * (Multi-week "sim ahead" was removed May 2026 — only single-week advance
 * remains, but it still uses these snapshot/diff helpers.)
 */

import { playerOverall, playerPotentialOverall } from './playerRating'
import { happinessLevel } from './happiness'

/**
 * Capture the slice of save state we want to diff. Keep this small — full save
 * snapshots are expensive and most fields are noise.
 *
 * @param {import('./types.js').SaveState} save
 */
export function snapshotState(save) {
  const team = save.teams[save.userSchoolId]
  const players = team.rosterPlayerIds.map(id => save.players[id]).filter(Boolean)
  const byId = {}
  for (const p of players) {
    // Capture the FULL rating block so we can render a per-stat diff in the
    // week recap. Shallow copy is enough; ratings are flat numbers.
    const ratings = p.isPitcher ? { ...(p.pitcher || {}) } : { ...(p.hitter || {}) }
    byId[p.id] = {
      name: `${p.firstName} ${p.lastName}`,
      pos: p.isPitcher ? 'P' : p.primaryPosition,
      classYear: (p.redshirtUsed ? 'RS-' : '') + p.classYear,
      ovr: playerOverall(p),
      pot: playerPotentialOverall(p),
      happiness: p.happiness?.value ?? 60,
      gpa: p.gpa ?? null,
      isPitcher: !!p.isPitcher,
      ratings,
    }
  }
  const myRating = save.nwbbRatings?.[save.userSchoolId]
  return {
    week: save.calendar.week,
    seasonWeek: save.calendar.seasonWeek,
    offseasonWeek: save.calendar.offseasonWeek,
    mode: save.calendar.mode,
    players: byId,
    budget: save.budget?.totalAthleticBudget ?? 0,
    jobSecurity: save.budget?.jobSecurity ?? 50,
    ap: save.ap?.currentWeek ?? 0,
    wins: team.wins,
    losses: team.losses,
    runDiff: team.runDiff,
    nationalRank: myRating?.nationalRank ?? null,
    nwbbRating: myRating?.rating ?? null,
  }
}

/**
 * Diff two snapshots into something the UI can render.
 *
 * Players with no meaningful change are dropped. Players who appeared or
 * disappeared between snapshots (transfers / graduations) are noted.
 */
export function diffSnapshots(before, after) {
  const ovrChanges = []
  const happinessChanges = []
  const gpaChanges = []
  const departed = []
  const arrived = []

  for (const [id, b] of Object.entries(before.players)) {
    const a = after.players[id]
    if (!a) {
      departed.push({ id, ...b })
      continue
    }
    const ovrDelta = a.ovr - b.ovr
    if (ovrDelta !== 0) {
      // Compute per-stat diff so the recap row can show WHICH ratings moved.
      const statDiffs = []
      const bRatings = b.ratings || {}
      const aRatings = a.ratings || {}
      for (const k of Object.keys(aRatings)) {
        if (k.startsWith('velocity')) continue   // velo is a measurable, not a 0-99 rating
        const bv = bRatings[k]
        const av = aRatings[k]
        if (typeof bv !== 'number' || typeof av !== 'number') continue
        const d = av - bv
        if (Math.abs(d) >= 0.5) {
          statDiffs.push({ stat: k, before: bv, after: av, delta: d })
        }
      }
      statDiffs.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
      ovrChanges.push({
        id, name: a.name, pos: a.pos, isPitcher: a.isPitcher,
        before: b.ovr, after: a.ovr, delta: ovrDelta,
        statDiffs,
      })
    }
    const hDelta = a.happiness - b.happiness
    if (Math.abs(hDelta) >= 3) happinessChanges.push({
      id, name: a.name, pos: a.pos,
      before: b.happiness, after: a.happiness, delta: hDelta,
      beforeLevel: happinessLevel(b.happiness),
      afterLevel: happinessLevel(a.happiness),
    })
    if (b.gpa != null && a.gpa != null && Math.abs(a.gpa - b.gpa) >= 0.02) {
      gpaChanges.push({ id, name: a.name, before: b.gpa, after: a.gpa, delta: a.gpa - b.gpa })
    }
  }
  for (const [id, a] of Object.entries(after.players)) {
    if (!before.players[id]) arrived.push({ id, ...a })
  }

  // Sort by absolute delta so the biggest movers float to the top.
  ovrChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  happinessChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  gpaChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  return {
    fromWeek: before.week,
    toWeek: after.week,
    fromMode: before.mode,
    toMode: after.mode,
    fromOffseasonWeek: before.offseasonWeek,
    toOffseasonWeek: after.offseasonWeek,
    fromSeasonWeek: before.seasonWeek,
    toSeasonWeek: after.seasonWeek,
    ovrChanges, happinessChanges, gpaChanges,
    departed, arrived,
    budgetDelta: after.budget - before.budget,
    jobSecurityDelta: after.jobSecurity - before.jobSecurity,
    recordDelta: { w: after.wins - before.wins, l: after.losses - before.losses },
    runDiffDelta: after.runDiff - before.runDiff,
    // National-ranking movement — Dashboard surfaces this in the week recap
    // so the user can see where their rank moved each in-season week.
    rankMove: (before.nationalRank != null && after.nationalRank != null
      && (before.wins !== after.wins || before.losses !== after.losses))
      ? {
        before: before.nationalRank,
        after: after.nationalRank,
        delta: before.nationalRank - after.nationalRank,   // + = climbed up
        beforeRating: before.nwbbRating,
        afterRating: after.nwbbRating,
      }
      : null,
  }
}
