/**
 * Injury system.
 *
 * Players can pick up injuries during regular-season games, fall scrimmages,
 * and (rarely) practice weeks. While injured a player:
 *
 *   - Can't appear in lineups (auto-filtered from defaultLineup + live sim)
 *   - Doesn't gain dev points from any source (offseason pass, 1-on-1, summer ball)
 *   - Doesn't accrue summer-ball assignment dev either
 *
 * On return, MODERATE/MAJOR/SEASON injuries leave a small lingering rating
 * penalty + durability hit.
 *
 * Tuning targets:
 *   - Each team picks up ~10-15 injuries per year
 *   - ~2-3 of those are MODERATE+, 1 every couple years is MAJOR/SEASON
 *   - Pitchers with heavy spring IP carry elevated arm-injury risk
 *   - High durability cuts risk roughly in half; low durability roughly doubles it
 *
 * State shape on a player:
 *   player.injury = {
 *     type: 'HAMSTRING_STRAIN',
 *     severity: 'MINOR'|'MODERATE'|'MAJOR'|'SEASON',
 *     weeksRemaining: 3,
 *     totalWeeks: 4,            // for the recap "X-week injury"
 *     weekIncurred: 32,         // weekOfYear
 *     yearIncurred: 2027,
 *     statPenalty: { fielding: -2, durability: -2 },
 *     context: 'GAME'|'PRACTICE'|'SUMMER',
 *   }
 *
 * History lives at player.injuryHistory (array of cleared injuries, optional).
 */

/** @typedef {import('./types.js').Player} Player */

const HITTER_INJURIES = [
  {
    key: 'HAMSTRING_STRAIN',
    label: 'Hamstring strain',
    severity: 'MINOR',
    weeks: [1, 2],
    affectsRatings: { speed: -2, durability: -1 },
    blurb: 'Pulled up running out a grounder.',
  },
  {
    key: 'ANKLE_SPRAIN',
    label: 'Sprained ankle',
    severity: 'MINOR',
    weeks: [2, 3],
    affectsRatings: { speed: -2, fielding: -1, durability: -1 },
    blurb: 'Rolled the ankle rounding a base.',
  },
  {
    key: 'BACK_TIGHTNESS',
    label: 'Back tightness',
    severity: 'MINOR',
    weeks: [1, 2],
    affectsRatings: { power_l: -1, power_r: -1, durability: -1 },
    blurb: 'Lower back lock-up after a swing.',
  },
  {
    key: 'WRIST_INJURY',
    label: 'Wrist injury',
    severity: 'MODERATE',
    weeks: [4, 7],
    affectsRatings: { contact_l: -2, contact_r: -2, power_l: -2, power_r: -2, durability: -2 },
    blurb: 'Jammed wrist on a check-swing.',
  },
  {
    key: 'OBLIQUE_STRAIN',
    label: 'Oblique strain',
    severity: 'MODERATE',
    weeks: [4, 6],
    affectsRatings: { power_l: -3, power_r: -3, durability: -2 },
    blurb: 'Pulled the oblique mid-swing.',
  },
  {
    key: 'BROKEN_FINGER',
    label: 'Broken finger',
    severity: 'MODERATE',
    weeks: [3, 5],
    affectsRatings: { fielding: -2, arm: -1, durability: -1 },
    blurb: 'Caught a foul tip on the hand.',
  },
  {
    key: 'CONCUSSION',
    label: 'Concussion',
    severity: 'MODERATE',
    weeks: [3, 6],
    affectsRatings: { discipline: -2, composure: -2, durability: -2 },
    blurb: 'Took a beaning to the head.',
  },
  {
    key: 'KNEE_SPRAIN',
    label: 'Knee sprain',
    severity: 'MAJOR',
    weeks: [7, 11],
    affectsRatings: { speed: -4, fielding: -3, durability: -3 },
    blurb: 'Caught a cleat sliding into second.',
  },
  {
    key: 'ACL_TEAR',
    label: 'Torn ACL',
    severity: 'SEASON',
    weeks: [20, 24],
    affectsRatings: { speed: -6, fielding: -4, durability: -5 },
    blurb: 'Non-contact ACL — done for the year.',
  },
  {
    key: 'LABRUM_TEAR_HITTER',
    label: 'Torn labrum',
    severity: 'MAJOR',
    weeks: [10, 16],
    affectsRatings: { power_l: -4, power_r: -4, arm: -4, durability: -4 },
    blurb: 'Shoulder labrum tear from a hard swing.',
  },
]

const PITCHER_INJURIES = [
  {
    key: 'SHOULDER_FATIGUE',
    label: 'Shoulder fatigue',
    severity: 'MINOR',
    weeks: [1, 2],
    affectsRatings: { stuff: -1, durability: -1 },
    blurb: 'Dead arm after a heavy outing.',
  },
  {
    key: 'BLISTER',
    label: 'Finger blister',
    severity: 'MINOR',
    weeks: [1, 2],
    affectsRatings: { control: -1, durability: -1 },
    blurb: 'Blister on the index finger — affects feel for spin.',
  },
  {
    key: 'BACK_TIGHTNESS_P',
    label: 'Back tightness',
    severity: 'MINOR',
    weeks: [1, 2],
    affectsRatings: { stamina: -1, durability: -1 },
    blurb: 'Lower-back tightness after starts.',
  },
  {
    key: 'FOREARM_STRAIN',
    label: 'Forearm strain',
    severity: 'MODERATE',
    weeks: [3, 5],
    affectsRatings: { control: -2, stuff: -1, durability: -2 },
    blurb: 'Forearm tightness — precursor to elbow trouble.',
  },
  {
    key: 'ELBOW_INFLAMMATION',
    label: 'Elbow inflammation',
    severity: 'MODERATE',
    weeks: [4, 7],
    affectsRatings: { stuff: -3, control: -2, durability: -3 },
    blurb: 'Inflammation in the throwing elbow.',
  },
  {
    key: 'ROTATOR_CUFF_STRAIN',
    label: 'Rotator cuff strain',
    severity: 'MODERATE',
    weeks: [5, 9],
    affectsRatings: { stuff: -3, stamina: -3, durability: -3 },
    blurb: 'Shoulder cuff strain — power dropping off.',
  },
  {
    key: 'LABRUM_TEAR_PITCHER',
    label: 'Shoulder labrum tear',
    severity: 'MAJOR',
    weeks: [12, 18],
    affectsRatings: { stuff: -5, stamina: -4, durability: -5 },
    blurb: 'Torn labrum in the throwing shoulder.',
  },
  {
    key: 'TOMMY_JOHN',
    label: 'UCL tear (Tommy John)',
    severity: 'SEASON',
    weeks: [40, 52],
    affectsRatings: { stuff: -7, control: -3, command: -3, durability: -6 },
    blurb: 'UCL tear. Done for the year and likely longer.',
  },
]

/**
 * Pick a random injury appropriate for the player and severity. Returns the
 * raw injury template (caller fills in weeksRemaining + context).
 *
 * @param {Player} player
 * @param {'MINOR'|'MODERATE'|'MAJOR'|'SEASON'} severity
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 */
export function pickInjury(player, severity, rng) {
  const pool = player.isPitcher ? PITCHER_INJURIES : HITTER_INJURIES
  const candidates = pool.filter(i => i.severity === severity)
  if (candidates.length === 0) {
    // Fallback to any injury of the appropriate side
    return rng.pick(pool)
  }
  return rng.pick(candidates)
}

/**
 * Build a concrete injury record on a player from a template + context.
 * Sets weeksRemaining + records all metadata.
 *
 * @param {Player} player
 * @param {*} template
 * @param {{ context: string, week: number, year: number, rng: ReturnType<import('./rng.js').makeRng> }} ctx
 * @returns {object}  the injury record (also written to player.injury)
 */
export function applyInjury(player, template, ctx) {
  const weeks = ctx.rng.int(template.weeks[0], template.weeks[1])
  // Many injury templates have game-flavored blurbs ("Dead arm after a
  // heavy outing", "Jammed wrist on a check-swing"). When the context is
  // PRACTICE, those references to in-game moments are nonsense — swap to
  // a practice-flavored blurb instead.
  const blurb = ctx.context === 'PRACTICE'
    ? practiceBlurb(template.key, player.isPitcher)
    : template.blurb
  const injury = {
    type: template.key,
    label: template.label,
    severity: template.severity,
    blurb,
    weeksRemaining: weeks,
    totalWeeks: weeks,
    weekIncurred: ctx.week,
    yearIncurred: ctx.year,
    statPenalty: template.affectsRatings || {},
    context: ctx.context,
  }
  player.injury = injury
  return injury
}

/**
 * Return a practice-flavored blurb for an injury. Falls back to a generic
 * "tweaked in practice" line if the template doesn't have a custom one.
 */
function practiceBlurb(templateKey, isPitcher) {
  const lib = {
    HAMSTRING_STRAIN:    'Pulled up running drills.',
    ANKLE_SPRAIN:        'Rolled an ankle in fielding work.',
    BACK_TIGHTNESS:      'Back locked up during BP.',
    WRIST_INJURY:        'Tweaked the wrist taking swings.',
    OBLIQUE_STRAIN:      'Felt a pop in the oblique during BP.',
    BROKEN_FINGER:       'Jammed a finger fielding grounders.',
    CONCUSSION:          'Hit by a foul ball in the cage.',
    KNEE_SPRAIN:         'Sprained the knee in agility drills.',
    ACL_TEAR:            'Non-contact knee injury in practice.',
    LABRUM_TEAR_HITTER:  'Shoulder gave out during a swing.',
    SHOULDER_FATIGUE:    'Arm felt dead after a bullpen session.',
    BLISTER_P:           'Blister formed during a long pen.',
    BACK_TIGHTNESS_P:    'Lower back locked up in long toss.',
    FOREARM_STRAIN:      'Forearm tightness after a heavy pen.',
    ELBOW_INFLAMMATION:  'Elbow flared up during throwing.',
    ROTATOR_CUFF_STRAIN: 'Shoulder cuff strained in a pen.',
    LABRUM_TEAR_PITCHER: 'Shoulder gave out during a long toss.',
    TOMMY_JOHN:          'UCL tear during a bullpen.',
  }
  if (lib[templateKey]) return lib[templateKey]
  return isPitcher ? 'Tweaked it in a bullpen session.' : 'Tweaked it during practice.'
}

/**
 * Is the player currently sidelined?
 */
export function isInjured(player) {
  if (!player?.injury) return false
  return (player.injury.weeksRemaining || 0) > 0
}

/**
 * Per-player game-injury roll. Called from simWeek after each game for
 * players who actually appeared in the boxscore. Returns the injury template
 * if hit, else null. Caller applies via applyInjury().
 *
 * Base 0.7% per appearance modulated by:
 *   - durability (higher = lower risk; 80 dur ~halves base rate)
 *   - usage (heavy game-PAs or pitcher IP bumps risk)
 *   - injury history (recovering players are slightly more fragile briefly)
 *
 * @param {Player} player
 * @param {{ gamePa?: number, gameIp?: number }} ctx
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 */
export function rollGameInjury(player, ctx, rng) {
  if (!player || isInjured(player)) return null
  const dur = player.isPitcher
    ? (player.pitcher?.durability ?? 60)
    : (player.hitter?.durability ?? 60)
  // 80 dur ~0.4× base; 40 dur ~1.6× base
  const durFactor = Math.max(0.3, Math.min(2.0, 1.6 - (dur - 40) * 0.02))
  let baseRisk = 0.007
  if (player.isPitcher && (ctx.gameIp || 0) >= 6) baseRisk *= 1.3
  if (!player.isPitcher && (ctx.gamePa || 0) >= 5) baseRisk *= 1.1
  // Recently-returned players are slightly more fragile for 2 weeks
  if (player._recentReturn && player._recentReturn.weeksAgo <= 2) baseRisk *= 1.25
  const finalRisk = baseRisk * durFactor
  if (!rng.chance(finalRisk)) return null
  // If we hit, decide severity. Heavily skewed minor.
  const severity = rng.weighted(
    ['MINOR', 'MODERATE', 'MAJOR', 'SEASON'],
    [70, 22, 6, 2],
  )
  return pickInjury(player, severity, rng)
}

/**
 * Lower-probability roll for practice / training weeks. Returns null mostly.
 * About 1/3 the base rate of a game roll, skewed even more toward minor.
 *
 * @param {Player} player
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 */
export function rollPracticeInjury(player, rng) {
  if (!player || isInjured(player)) return null
  const dur = player.isPitcher
    ? (player.pitcher?.durability ?? 60)
    : (player.hitter?.durability ?? 60)
  const durFactor = Math.max(0.3, Math.min(2.0, 1.6 - (dur - 40) * 0.02))
  const baseRisk = 0.0025
  const finalRisk = baseRisk * durFactor
  if (!rng.chance(finalRisk)) return null
  const severity = rng.weighted(
    ['MINOR', 'MODERATE', 'MAJOR', 'SEASON'],
    [85, 13, 2, 0.5],
  )
  return pickInjury(player, severity, rng)
}

/**
 * Tick the injury counter on every player in the save by 1 week. Players
 * whose injury wraps to 0 are healed — apply the stat penalty to their
 * ratings, clear the injury, and tag them with _recentReturn so future
 * injury rolls know they're brittle for a couple weeks.
 *
 * Returns { newlyHealed: Player[] } so the WeekRecap can surface returns.
 *
 * @param {any} state
 */
export function tickInjuries(state) {
  const newlyHealed = []
  for (const p of Object.values(state.players || {})) {
    // Decay the recent-return brittleness
    if (p._recentReturn) {
      p._recentReturn.weeksAgo = (p._recentReturn.weeksAgo || 0) + 1
      if (p._recentReturn.weeksAgo > 4) delete p._recentReturn
    }
    if (!p.injury) continue
    p.injury.weeksRemaining = Math.max(0, (p.injury.weeksRemaining || 0) - 1)
    if (p.injury.weeksRemaining > 0) continue
    // Healed — apply lingering rating penalty
    const penalty = p.injury.statPenalty || {}
    const isPitcher = p.isPitcher
    const block = isPitcher ? p.pitcher : p.hitter
    if (block) {
      for (const [k, v] of Object.entries(penalty)) {
        if (typeof block[k] === 'number') {
          block[k] = Math.max(20, block[k] + v)   // v is negative
        }
      }
    }
    // Durability is on both hitter + pitcher blocks if both exist
    if (penalty.durability && p.hitter && typeof p.hitter.durability === 'number') {
      p.hitter.durability = Math.max(20, p.hitter.durability + penalty.durability)
    }
    if (penalty.durability && p.pitcher && typeof p.pitcher.durability === 'number') {
      p.pitcher.durability = Math.max(20, p.pitcher.durability + penalty.durability)
    }
    // Move to history + flag recent return
    if (!p.injuryHistory) p.injuryHistory = []
    p.injuryHistory.push({
      ...p.injury,
      healedWeek: state.calendar?.weekOfYear,
      healedYear: state.calendar?.year,
    })
    p._recentReturn = {
      injuryType: p.injury.type,
      severity: p.injury.severity,
      weeksAgo: 0,
    }
    newlyHealed.push(p)
    delete p.injury
  }
  return { newlyHealed }
}

/**
 * Heal everyone instantly. Used at end-of-year so SEASON injuries don't
 * carry across an entire new season — players come back at start of fall
 * camp the next year, with the stat penalty already applied.
 *
 * @param {any} state
 */
export function clearAllInjuriesForNewSeason(state) {
  for (const p of Object.values(state.players || {})) {
    if (p.injury) {
      const penalty = p.injury.statPenalty || {}
      const block = p.isPitcher ? p.pitcher : p.hitter
      if (block) {
        for (const [k, v] of Object.entries(penalty)) {
          if (typeof block[k] === 'number') {
            block[k] = Math.max(20, block[k] + v)
          }
        }
      }
      if (!p.injuryHistory) p.injuryHistory = []
      p.injuryHistory.push({ ...p.injury, healedYear: state.calendar?.year })
      delete p.injury
    }
    delete p._recentReturn
  }
}

/**
 * Filter a list of players to only the healthy ones. Used by lineup builders
 * + summer-ball + dev passes so injured players don't accidentally play /
 * develop while sidelined.
 *
 * @param {Player[]} players
 */
export function onlyHealthy(players) {
  return (players || []).filter(p => !isInjured(p))
}
