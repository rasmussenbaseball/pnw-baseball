/**
 * Coaching archetypes.
 *
 * Every coach has a single archetype that biases their 4 ratings (developer,
 * motivator, recruiter, tactician). Archetypes pair with each other to form
 * synergies on the staff: hire assistants who echo your head coach for a
 * focused-staff bonus, OR hire assistants whose archetype is your opposite
 * to round out the staff for a different bonus.
 *
 * Staff ratings = average of all coach ratings × synergy multiplier, capped.
 */

export const ARCHETYPES = {
  TEACHER: {
    key: 'TEACHER',
    label: 'Teacher',
    blurb: 'Player-development focused. Big offseason gains, weaker on recruiting + tactics.',
    color: 'text-pnw-green',
    bias: { developer: +14, motivator: +4, recruiter: -8, tactician: -2 },
    // Player-facing fixed profile when chosen as HC archetype — sums to
    // ~250 across the 4 ratings to stay in line with the previous slider
    // budget. Stays at NAIA-mid-tier overall.
    fixedRatings: { developer: 80, motivator: 65, recruiter: 50, tactician: 55 },
    opposite: 'SHOWMAN',
  },
  SHOWMAN: {
    key: 'SHOWMAN',
    label: 'Showman',
    blurb: 'Recruiter + motivator. Wins families over, runs flashy programs; less hands-on dev.',
    color: 'text-amber-700',
    bias: { developer: -8, motivator: +6, recruiter: +14, tactician: -4 },
    fixedRatings: { developer: 50, motivator: 70, recruiter: 80, tactician: 50 },
    opposite: 'TEACHER',
  },
  STRATEGIST: {
    key: 'STRATEGIST',
    label: 'Strategist',
    blurb: 'Tactician above all. Lineup + bullpen master; less warm with players + recruits.',
    color: 'text-blue-700',
    bias: { developer: 0, motivator: -6, recruiter: -4, tactician: +14 },
    fixedRatings: { developer: 62, motivator: 50, recruiter: 55, tactician: 83 },
    opposite: 'PLAYER_COACH',
  },
  PLAYER_COACH: {
    key: 'PLAYER_COACH',
    label: 'Player\'s Coach',
    blurb: 'Builds loyalty + happiness. Players love them; in-game tactics aren\'t their strength.',
    color: 'text-red-700',
    bias: { developer: +4, motivator: +14, recruiter: +2, tactician: -8 },
    fixedRatings: { developer: 65, motivator: 82, recruiter: 65, tactician: 50 },
    opposite: 'STRATEGIST',
  },
  GENERALIST: {
    key: 'GENERALIST',
    label: 'Generalist',
    blurb: 'No-strong-bias. Solid in everything, exceptional in nothing.',
    color: 'text-gray-700',
    bias: { developer: +2, motivator: +2, recruiter: +2, tactician: +2 },
    fixedRatings: { developer: 65, motivator: 65, recruiter: 65, tactician: 65 },
    opposite: 'GENERALIST',
  },
}

export const ARCHETYPE_KEYS = Object.keys(ARCHETYPES)

/**
 * Assign an archetype to a coach using their existing ratings — picks the
 * archetype whose bias profile best matches the coach. Used to back-fill
 * archetypes for coaches generated before this system existed.
 */
export function inferArchetype(coach) {
  if (!coach) return 'GENERALIST'
  // Strongest single rating decides — produces a clean mapping
  const r = {
    developer: coach.developer ?? 50,
    motivator: coach.motivator ?? 50,
    recruiter: coach.recruiter ?? 50,
    tactician: coach.tactician ?? 50,
  }
  const max = Math.max(r.developer, r.motivator, r.recruiter, r.tactician)
  // Generalist threshold: if no rating dominates (max - min < 8), call it
  // generalist.
  const min = Math.min(r.developer, r.motivator, r.recruiter, r.tactician)
  if (max - min < 8) return 'GENERALIST'
  if (r.developer === max) return 'TEACHER'
  if (r.motivator === max) return 'PLAYER_COACH'
  if (r.recruiter === max) return 'SHOWMAN'
  return 'STRATEGIST'
}

/**
 * Apply an archetype's rating bias on top of a base profile. Used at coach
 * generation time when we want the candidate's stats to reflect their type.
 */
export function applyArchetypeBias(ratings, archetypeKey) {
  const arc = ARCHETYPES[archetypeKey] || ARCHETYPES.GENERALIST
  const out = { ...ratings }
  for (const k of Object.keys(arc.bias)) {
    out[k] = Math.max(20, Math.min(99, (ratings[k] ?? 50) + arc.bias[k]))
  }
  return out
}

/**
 * Compute the combined coaching staff rating. Average of all coach ratings,
 * then applies a synergy multiplier:
 *   - Pure echo: every assistant matches HC archetype → +5% (focused identity)
 *   - Balanced: opposite-archetype assistants → +4% (well-rounded staff)
 *   - Mixed/clashing: no clear identity → no bonus or small penalty (-2%)
 *
 * Returns { developer, motivator, recruiter, tactician, overall, synergy,
 * synergyLabel } so the UI can show the breakdown.
 *
 * @param {Coach} headCoach
 * @param {Coach[]} assistants
 */
export function staffRatings(headCoach, assistants) {
  const list = [headCoach, ...(assistants || [])].filter(Boolean)
  if (list.length === 0) {
    return { developer: 0, motivator: 0, recruiter: 0, tactician: 0, overall: 0, synergy: 1.0, synergyLabel: 'No staff', hcArchetype: 'GENERALIST' }
  }
  // Soft-floor adjustment: a really bad assistant (rating < 40) gets pulled
  // up toward 40 in the staff average. The HC + the rest of the staff still
  // contribute their full quality; one bad hire doesn't fully tank the
  // overall. Bumps the perceived floor of each rating contribution.
  function effective(coach, key) {
    const v = coach[key] ?? 50
    if (coach.role === 'HEAD_COACH') return v
    return v < 40 ? 40 - (40 - v) * 0.4 : v   // pull bad ratings up softly
  }
  const avg = (key) => {
    const sum = list.reduce((s, c) => s + effective(c, key), 0)
    return sum / list.length
  }
  let dev = avg('developer'), mot = avg('motivator'), rec = avg('recruiter'), tac = avg('tactician')

  const hcArc = headCoach?.archetype || inferArchetype(headCoach)
  const synergy = computeSynergy(hcArc, assistants || [])

  // Depth bonus: bigger staffs (more eyes, more development reps) get a
  // small additional bump. 3 assistants = baseline (+0%); each extra
  // assistant beyond the minimum adds +1% up to +4% at 7 assistants.
  const depthBonus = Math.min(0.04, Math.max(0, ((assistants?.length ?? 0) - 3) * 0.01))
  const mult = synergy.mult + depthBonus

  dev *= mult
  mot *= mult
  rec *= mult
  tac *= mult

  const overall = (dev + mot + rec + tac) / 4

  return {
    developer: Math.round(dev),
    motivator: Math.round(mot),
    recruiter: Math.round(rec),
    tactician: Math.round(tac),
    overall: Math.round(overall),
    synergy: mult,
    synergyLabel: depthBonus > 0
      ? `${synergy.label} + ${(depthBonus * 100).toFixed(0)}% staff depth`
      : synergy.label,
    hcArchetype: hcArc,
  }
}

/**
 * Synergy bonus calculation. Pure echo OR opposite-pair full → bonus.
 * Anything in between → smaller bonus or neutral.
 */
function computeSynergy(hcArchetype, assistants) {
  if (assistants.length === 0) return { mult: 1.0, label: 'No assistants' }
  const arcs = assistants.map(a => a.archetype || inferArchetype(a))
  const sameCount = arcs.filter(a => a === hcArchetype).length
  const oppArc = ARCHETYPES[hcArchetype]?.opposite
  const oppCount = arcs.filter(a => a === oppArc).length

  // Pure echo: 100% of assistants share the HC archetype.
  if (sameCount === arcs.length) {
    return { mult: 1.05, label: `Echo staff (+5%) — all assistants share your ${ARCHETYPES[hcArchetype]?.label || hcArchetype} archetype` }
  }
  // Balanced: at least one opposite-archetype assistant, none of the HC type
  // (i.e. user is deliberately complementing).
  if (oppCount >= 1 && sameCount === 0) {
    return { mult: 1.04, label: `Balanced staff (+4%) — opposite archetypes complement the HC` }
  }
  // Mixed but identifiable: HC archetype repeated by some but not all
  if (sameCount >= Math.ceil(arcs.length / 2)) {
    return { mult: 1.02, label: `Tilted staff (+2%) — most assistants share the HC archetype` }
  }
  // Mixed opposite-leaning
  if (oppCount >= 1) {
    return { mult: 1.02, label: `Some balance (+2%) — at least one opposite-archetype assistant` }
  }
  // No clear identity
  return { mult: 0.98, label: `Unfocused staff (-2%) — no clear archetype identity` }
}
