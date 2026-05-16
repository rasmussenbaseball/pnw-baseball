/**
 * Player archetype system.
 *
 * Generates players by COMPOSING three layers:
 *   1. BODY FRAME — physique. Drives height + weight + a small rating bias.
 *   2. ARCHETYPE  — the player's "role" (defensive wizard, power bat, control
 *                   artist, etc.). Sets rating multipliers per stat key.
 *   3. QUIRKS     — 0-3 random tags that nudge individual ratings up or down.
 *                   Some are hidden until you spend extra scouting AP.
 *
 * The composition multiplies out to thousands of unique combinations naturally.
 * The visible result on a roster: every player has a distinct profile (a
 * stocky-framed power catcher with a cannon arm reads differently from a
 * lanky 5-tool CF with elite eye).
 *
 * USAGE:
 *   const profile = composePlayerProfile({ position, isPitcher, slotTier, rng })
 *   // profile = { frame, archetype, quirks[], biases{}, measurables{} }
 *   // Use profile.biases to MULTIPLY rating means, profile.quirks to add deltas.
 */

// ─── Body frames ────────────────────────────────────────────────────────────

/** @typedef {{
 *   key: string,
 *   label: string,
 *   heightInches: [number, number],
 *   weightLbs: [number, number],
 *   bias: Object<string, number>,
 * }} BodyFrame */

/** @type {BodyFrame[]} */
export const BODY_FRAMES = [
  { key: 'LANKY',      label: 'Lanky',      heightInches: [74, 80], weightLbs: [170, 195],
    bias: { speed: +3, stamina: +2, durability: -1, power_l: -2, power_r: -2 } },
  { key: 'TOWERING',   label: 'Towering',   heightInches: [76, 82], weightLbs: [210, 250],
    bias: { power_l: +4, power_r: +4, stuff: +3, speed: -4, fielding: -1 } },
  { key: 'ATHLETIC',   label: 'Athletic',   heightInches: [71, 76], weightLbs: [180, 215],
    bias: { fielding: +2, arm: +1, speed: +1 } },
  { key: 'STOCKY',     label: 'Stocky',     heightInches: [68, 73], weightLbs: [205, 235],
    bias: { power_l: +3, power_r: +3, durability: +2, speed: -2 } },
  { key: 'WIRY',       label: 'Wiry',       heightInches: [69, 73], weightLbs: [165, 185],
    bias: { speed: +3, contact_l: +2, contact_r: +2, power_l: -3, power_r: -3 } },
  { key: 'UNDERSIZED', label: 'Undersized', heightInches: [66, 70], weightLbs: [155, 180],
    bias: { discipline: +3, speed: +2, fielding: +2, power_l: -5, power_r: -5 } },
]

/**
 * Apply a pool-specific physical-maturity adjustment to a frame's weight
 * range. HS seniors haven't filled out — pull weights down ~20 lb. JUCO
 * transfers are mid-development — pull down ~8 lb. Everyone else (D1
 * transfer / NAIA portal / generated college roster) uses the base frame.
 *
 * @param {BodyFrame} frame
 * @param {'HS_SR'|'JUCO'|'COLLEGE'} pool
 */
export function frameForPool(frame, pool) {
  if (pool === 'HS_SR') {
    return { ...frame, weightLbs: [frame.weightLbs[0] - 22, frame.weightLbs[1] - 18] }
  }
  if (pool === 'JUCO') {
    return { ...frame, weightLbs: [frame.weightLbs[0] - 10, frame.weightLbs[1] - 6] }
  }
  return frame
}

// Frame selection weights — most players are average-sized. TOWERING + LANKY
// are rare; ATHLETIC / STOCKY / WIRY are the bulk of the pool.
const FRAME_WEIGHTS = {
  LANKY:      15,
  TOWERING:    7,
  ATHLETIC:   30,
  STOCKY:     22,
  WIRY:       16,
  UNDERSIZED: 10,
}

function pickFrameWeighted(rng) {
  const keys = BODY_FRAMES.map(f => f.key)
  const weights = keys.map(k => FRAME_WEIGHTS[k] || 1)
  const picked = rng.weighted(keys, weights)
  return BODY_FRAMES.find(f => f.key === picked)
}

/**
 * Position-specific height windows. Looser than rigid stereotypes — real
 * rosters have undersized 2Bs, taller-than-expected CFs, and short pitchers
 * who play up via deception. Tuned May 2026 per Nate: lowered floors for
 * P / 2B / 3B; raised CF ceiling.
 *   C: 5'9-6'4      1B: 6'0-6'6     2B: 5'6-6'1
 *   SS: 5'8-6'3     3B: 5'8-6'4     LF: 5'10-6'4
 *   CF: 5'9-6'6     RF: 5'10-6'5    P: 5'9-6'9
 */
const POSITION_HEIGHT_WINDOW = {
  C:  { min: 69, max: 76, bias: -1.5 },   // 5'9-6'4
  '1B': { min: 72, max: 78, bias: +1.5 }, // 6'0-6'6
  '2B': { min: 66, max: 73, bias: -1.5 }, // 5'6-6'1 (Altuve types allowed)
  SS:  { min: 68, max: 75, bias:  0 },    // 5'8-6'3
  '3B': { min: 68, max: 76, bias: +0.5 }, // 5'8-6'4 (shorter 3Bs allowed)
  LF:  { min: 70, max: 76, bias:  0 },    // 5'10-6'4
  CF:  { min: 69, max: 78, bias: -0.5 },  // 5'9-6'6 (taller CFs allowed)
  RF:  { min: 70, max: 77, bias: +0.5 },  // 5'10-6'5
  P:   { min: 69, max: 81, bias: +1.0 },  // 5'9-6'9 (Stroman types allowed)
  SP:  { min: 69, max: 81, bias: +1.0 },
  RP:  { min: 69, max: 81, bias: +1.0 },
  DH:  { min: 70, max: 78, bias:  0 },
}

/**
 * Position stereotype biases. Layered on top of the archetype's rating biases
 * so each position leans toward its real-world type — CFs run, RFs throw,
 * SSs glove + arm, 2Bs contact-y and smaller, 1Bs power + slow, 3Bs hot
 * corner with an arm. Catchers nudged toward fielding + arm + composure.
 *
 * SMALLER deltas than archetype biases (max ±6) so they shade the roll
 * without overpowering it. A Power-Bat CF (archetype +12 power) still
 * reads as a power hitter — just with above-avg wheels from the CF nudge.
 */
const POSITION_BIAS = {
  C:   { fielding: +4, arm: +5, composure: +3, speed: -4, durability: +2 },
  '1B': { power_l: +4, power_r: +4, durability: +2, speed: -6, fielding: -1 },
  '2B': { fielding: +2, contact_l: +3, contact_r: +3, speed: +1, arm: -3, power_l: -2, power_r: -2 },
  SS:  { fielding: +6, arm: +5, contact_l: +1, contact_r: +1 },
  '3B': { arm: +5, power_l: +3, power_r: +3, fielding: +1, speed: -3 },
  LF:  { power_l: +2, power_r: +2, fielding: -1, arm: -2 },
  CF:  { speed: +5, fielding: +5, arm: +1 },
  RF:  { arm: +6, power_l: +3, power_r: +3, speed: -1 },
  DH:  { power_l: +3, power_r: +3, speed: -3, fielding: -5, arm: -3 },
}

export const HITTER_HEIGHT_CAP = 78   // retained for back-compat
export const PITCHER_HEIGHT_CAP = 81

/**
 * Apply position-aware height adjustment + position-specific cap/floor.
 * If a frame's raw roll falls outside the window for the position, clamp
 * to the window so we never produce 6'6 shortstops or 5'6 first basemen.
 *
 * @param {number} rawHeight  height from the frame range
 * @param {string} position
 * @param {boolean} isPitcher
 */
export function adjustHeightForPosition(rawHeight, position, isPitcher) {
  const w = POSITION_HEIGHT_WINDOW[position] ?? { min: 66, max: 81, bias: 0 }
  const shifted = rawHeight + w.bias
  return Math.min(w.max, Math.max(w.min, Math.round(shifted)))
}

// ─── Hitter archetypes ──────────────────────────────────────────────────────

/** @typedef {{
 *   key: string,
 *   label: string,
 *   blurb: string,
 *   positions: string[],     // valid primary positions (empty = any non-pitcher)
 *   bias: Object<string, number>,
 *   ceilings?: Object<string, number>,  // hard cap per rating (lets us reduce DH-style profiles)
 * }} HitterArchetype */

/** @type {HitterArchetype[]} */
export const HITTER_ARCHETYPES = [
  // ── Star templates ────────────────────────────────────────────────────
  { key: 'FIVE_TOOL', label: '5-tool', blurb: 'Plus everywhere — speed, power, contact, defense, arm.',
    positions: ['CF', 'SS', 'RF'],
    bias: { contact_l: +6, contact_r: +6, power_l: +5, power_r: +5, discipline: +4, speed: +6, fielding: +5, arm: +5 } },
  { key: 'POWER_BAT', label: 'Power hitter', blurb: 'Light-tower power, average contact, fly-ball approach.',
    positions: ['1B', '3B', 'LF', 'RF', 'DH'],
    bias: { power_l: +12, power_r: +12, contact_l: -4, contact_r: -4, speed: -4, fielding: -2 } },
  { key: 'CONTACT_WIZARD', label: 'Contact wizard', blurb: 'Bat-to-ball machine. Rarely strikes out. Light pop.',
    positions: ['2B', 'SS', 'CF', 'LF'],
    bias: { contact_l: +12, contact_r: +12, discipline: +8, power_l: -6, power_r: -6 } },
  // ── Speed templates ───────────────────────────────────────────────────
  { key: 'SPEED_DEMON', label: 'Speed demon', blurb: 'Plus-plus runner. Slap-and-go, plus range.',
    positions: ['CF', 'SS', '2B'],
    bias: { speed: +18, contact_l: +4, contact_r: +4, fielding: +5, power_l: -8, power_r: -8 } },
  { key: 'LEADOFF', label: 'Leadoff type', blurb: 'Hit, run, take pitches. Sets the table.',
    positions: ['CF', '2B', 'LF'],
    bias: { contact_l: +6, contact_r: +6, discipline: +10, speed: +8, power_l: -4, power_r: -4 } },
  // ── Defensive specialists ─────────────────────────────────────────────
  { key: 'DEFENSIVE_WIZARD', label: 'Defensive wizard', blurb: 'Vacuum cleaner. Glove carries the bat.',
    positions: ['SS', '2B', '3B', 'CF'],
    bias: { fielding: +18, arm: +10, contact_l: -8, contact_r: -8, power_l: -8, power_r: -8 } },
  { key: 'GLOVE_FIRST_IF', label: 'Glove-first IF', blurb: 'Plus defender, average bat. Lineup floor.',
    positions: ['SS', '2B', '3B'],
    bias: { fielding: +10, arm: +6, contact_l: -2, contact_r: -2, power_l: -4, power_r: -4 } },
  { key: 'CANNON_OF', label: 'Cannon-arm OF', blurb: 'Howitzer from RF. Runners freeze.',
    positions: ['RF', 'CF', 'LF'],
    bias: { arm: +15, fielding: +5, power_l: +3, power_r: +3, speed: -2 } },
  { key: 'POWER_C', label: 'Power-hitting catcher', blurb: 'Rare bat behind the plate. Adequate defense.',
    positions: ['C'],
    bias: { power_l: +8, power_r: +8, contact_l: +2, contact_r: +2, fielding: -4, arm: -2, speed: -4 } },
  { key: 'DEFENSIVE_C', label: 'Defensive catcher', blurb: 'Game caller, framing, pop time. Light bat.',
    positions: ['C'],
    bias: { fielding: +12, arm: +12, contact_l: -6, contact_r: -6, power_l: -8, power_r: -8 } },
  // ── Mid-profile templates ─────────────────────────────────────────────
  { key: 'CLEANUP', label: 'Cleanup bat', blurb: 'Drive in runs. Power + ok contact.',
    positions: ['1B', '3B', 'LF', 'RF'],
    bias: { power_l: +8, power_r: +8, contact_l: +2, contact_r: +2, discipline: +2 } },
  { key: 'GAP_POWER', label: 'Gap-power hitter', blurb: 'Doubles machine. Sprays the ball.',
    positions: ['1B', '3B', 'LF', 'RF', 'CF'],
    bias: { power_l: +6, power_r: +6, contact_l: +5, contact_r: +5, discipline: +3 } },
  { key: 'SLAP_HITTER', label: 'Slap hitter', blurb: 'Beat out the throw. No pop.',
    positions: ['2B', 'SS', 'CF', 'LF'],
    bias: { contact_l: +6, contact_r: +6, speed: +6, power_l: -10, power_r: -10 } },
  { key: 'GRINDER', label: 'Grinder', blurb: 'No standout tool. Plays the right way.',
    positions: [],   // any
    bias: { discipline: +3, composure: +5, fielding: +2 } },
  // ── Specialized / rare ────────────────────────────────────────────────
  { key: 'LATE_BLOOMER_HIT', label: 'Late bloomer', blurb: 'Current numbers lie. Big jump coming.',
    positions: [],
    bias: { contact_l: -3, contact_r: -3, power_l: -3, power_r: -3 } },   // potential bonus added elsewhere
  { key: 'TOOLS_RAW', label: 'Toolsy / raw', blurb: 'Loud tools, no idea how to use them yet.',
    positions: ['CF', 'RF', 'SS'],
    bias: { power_l: +4, power_r: +4, speed: +6, contact_l: -8, contact_r: -8, discipline: -10 } },
]

// ─── Pitcher archetypes ─────────────────────────────────────────────────────

/** @typedef {{
 *   key: string,
 *   label: string,
 *   blurb: string,
 *   role: 'SP'|'RP'|'ANY',
 *   bias: Object<string, number>,
 *   velocityBias?: number,   // mph delta applied to base velocity — DECOUPLED from stuff
 * }} PitcherArchetype */

// Stuff rating = pitch SHAPE / MOVEMENT / quality (independent of velo).
// velocityBias = mph delta — DECOUPLED from stuff. A flamethrower throws hard
// but can have average stuff; a crafty lefty throws slow but can have plus
// movement. Same idea in real baseball: Lance McCullers had filthy stuff at
// 92, Jacob deGrom had filthy stuff at 100. Velo and stuff aren't the same
// metric — both contribute, neither implies the other.
/** @type {PitcherArchetype[]} */
export const PITCHER_ARCHETYPES = [
  { key: 'FLAMETHROWER', label: 'Flamethrower', blurb: '95+ heat. Velo plays. Spotty control.',
    role: 'ANY', velocityBias: +5,
    bias: { vs_r: +5, vs_l: +5, control: -10, command: -6, stamina: -3 } },
  { key: 'POWER_ARM', label: 'Power arm', blurb: 'Big stuff + plus velo. Strikes guys out.',
    role: 'ANY', velocityBias: +2.5,
    bias: { stuff: +10, vs_l: +4, vs_r: +4, control: -5, command: -4 } },
  { key: 'CONTROL_ARTIST', label: 'Control artist', blurb: 'Paints corners. Lives off command.',
    role: 'ANY', velocityBias: -1,
    bias: { control: +12, command: +12, stuff: -3, vs_l: +3, vs_r: +3 } },
  { key: 'CRAFTY_LEFTY', label: 'Crafty lefty', blurb: 'No velo, plus movement. Murders lefties.',
    role: 'ANY', velocityBias: -3,
    bias: { command: +10, control: +8, stuff: +4, vs_l: +14, vs_r: -3, composure: +5 } },
  { key: 'WORKHORSE', label: 'Workhorse SP', blurb: 'Eats innings. 6+ every start.',
    role: 'SP', velocityBias: 0,
    bias: { stamina: +12, durability: +10, command: +5, stuff: -2 } },
  { key: 'CLOSER_PROFILE', label: 'Closer profile', blurb: 'Lights-out 1-inning guy. Filthy stuff + nerves of steel.',
    role: 'RP', velocityBias: +1.5,
    bias: { stuff: +10, composure: +12, stamina: -10, control: +3 } },
  { key: 'GROUND_BALL', label: 'Ground-ball machine', blurb: 'Sinker-slider. Survives on contact management.',
    role: 'ANY', velocityBias: -1,
    bias: { command: +10, control: +8, stuff: -2 } },
  { key: 'STRIKEOUT_ARTIST', label: 'Strikeout artist', blurb: 'Wipeout secondary. Misses bats by the dozen.',
    role: 'ANY', velocityBias: +1,
    bias: { stuff: +12, command: +6, vs_l: +5, vs_r: +5, control: -2 } },
  { key: 'TWO_PITCH_RP', label: 'Two-pitch reliever', blurb: 'FB-slider. Plays up in short bursts.',
    role: 'RP', velocityBias: +1.5,
    bias: { stuff: +8, vs_r: +5, stamina: -12, control: +2 } },
  { key: 'DECEPTIVE', label: 'Deceptive arm', blurb: 'Funky delivery. Ball gets on hitters quick.',
    role: 'ANY', velocityBias: -0.5,
    bias: { stuff: +8, vs_l: +5, vs_r: +5, composure: +4 } },
  { key: 'PITCH_SHAPER', label: 'Pitch shaper', blurb: 'Plus movement, average velo. Lets the ball move.',
    role: 'ANY', velocityBias: -1,
    bias: { stuff: +14, command: +5, vs_l: +4, vs_r: +4 } },
  { key: 'SOFT_TOSSING_VETERAN', label: 'Soft-tossing veteran', blurb: 'Mid-80s heater, advanced feel. Outsmarts hitters.',
    role: 'ANY', velocityBias: -8,
    bias: { command: +12, composure: +8, control: +6, stuff: -6, stamina: +2 } },
  { key: 'LATE_BLOOMER_P', label: 'Late bloomer (P)', blurb: 'Stuff in development. Potential to break out.',
    role: 'ANY', velocityBias: -1,
    bias: { stuff: -3, control: -2, command: -2 } },
  { key: 'GRINDER_P', label: 'Grinder', blurb: 'No standout tool. Throws strikes, eats innings.',
    role: 'ANY', velocityBias: 0,
    bias: { control: +3, command: +3, durability: +3 } },
]

// ─── Quirks ─────────────────────────────────────────────────────────────────

/** @typedef {{
 *   key: string,
 *   label: string,
 *   side: 'hitter'|'pitcher'|'any',
 *   bias: Object<string, number>,
 *   hidden: boolean,    // if true, ratings impact is invisible until extra scouting
 *   rarity: number,     // weight for random selection
 * }} Quirk */

/** @type {Quirk[]} */
export const QUIRKS = [
  // ── Visible positive quirks ───────────────────────────────────────────
  { key: 'CANNON_ARM',      label: 'Cannon arm',       side: 'hitter',  bias: { arm: +12 }, hidden: false, rarity: 4 },
  { key: 'WHEELS',          label: 'Plus-plus wheels', side: 'hitter',  bias: { speed: +15 }, hidden: false, rarity: 3 },
  { key: 'ELITE_EYE',       label: 'Elite eye',        side: 'hitter',  bias: { discipline: +14 }, hidden: false, rarity: 3 },
  { key: 'POWER_SURGE',     label: 'Plus raw power',   side: 'hitter',  bias: { power_l: +8, power_r: +8 }, hidden: false, rarity: 3 },
  { key: 'HIT_TOOL',        label: 'Pure hitter',      side: 'hitter',  bias: { contact_l: +8, contact_r: +8 }, hidden: false, rarity: 3 },
  { key: 'GLOVE_PLUS',      label: 'Plus glove',       side: 'hitter',  bias: { fielding: +10 }, hidden: false, rarity: 3 },
  { key: 'LEFTY_KILLER',    label: 'Lefty killer',     side: 'hitter',  bias: { power_l: +8, contact_l: +6 }, hidden: false, rarity: 2 },
  { key: 'RIGHTY_KILLER',   label: 'Righty killer',    side: 'hitter',  bias: { power_r: +8, contact_r: +6 }, hidden: false, rarity: 2 },
  { key: 'TWO_PITCH_KO',    label: 'Wipeout secondary',side: 'pitcher', bias: { stuff: +7, vs_r: +4 }, hidden: false, rarity: 3 },
  { key: 'LATE_MOVEMENT',   label: 'Late movement',    side: 'pitcher', bias: { command: +6, stuff: +5 }, hidden: false, rarity: 3 },
  { key: 'RUBBER_ARM',      label: 'Rubber arm',       side: 'pitcher', bias: { stamina: +10, durability: +6 }, hidden: false, rarity: 2 },
  { key: 'HEAVY_BALL',      label: 'Heavy ball',       side: 'pitcher', bias: { stuff: +5, control: +3 }, hidden: false, rarity: 3 },
  { key: 'PLATOON_NEUTRAL', label: 'Platoon-neutral',  side: 'pitcher', bias: { vs_l: +6, vs_r: +4 }, hidden: false, rarity: 3 },
  // ── Visible negative quirks ───────────────────────────────────────────
  { key: 'GLASS_BAT',          label: 'Pitchers\' kryptonite (low power)', side: 'hitter',  bias: { power_l: -10, power_r: -10 }, hidden: false, rarity: 2 },
  { key: 'DEFENSIVE_LIABILITY',label: 'Defensive liability',               side: 'hitter',  bias: { fielding: -12, arm: -8 }, hidden: false, rarity: 2 },
  { key: 'AGGRESSIVE',         label: 'Aggressive swinger',                side: 'hitter',  bias: { discipline: -10, power_l: +3, power_r: +3 }, hidden: false, rarity: 3 },
  { key: 'NO_VELO',            label: 'Below-average velocity',            side: 'pitcher', bias: { stuff: -8 }, hidden: false, rarity: 2 },
  { key: 'WILD_THING',         label: 'Wild thing',                        side: 'pitcher', bias: { control: -12, stuff: +4 }, hidden: false, rarity: 2 },
  // ── HIDDEN quirks — only revealed via extra scouting ──────────────────
  { key: 'CLUTCH',             label: 'Clutch performer',  side: 'any',     bias: { composure: +12 }, hidden: true, rarity: 3 },
  { key: 'STREAKY',            label: 'Streaky',           side: 'any',     bias: { composure: -8 }, hidden: true, rarity: 3 },
  { key: 'INJURY_PRONE',       label: 'Injury history',    side: 'any',     bias: { durability: -14 }, hidden: true, rarity: 2 },
  { key: 'HIGH_MOTOR',         label: 'High motor',        side: 'any',     bias: { composure: +5, durability: +5 }, hidden: true, rarity: 4 },
  { key: 'LOW_WORK_ETHIC',     label: 'Coachability question', side: 'any', bias: { composure: -3 }, hidden: true, rarity: 2 },
  { key: 'COMPOSURE_KING',     label: 'Ice in his veins',  side: 'any',     bias: { composure: +14 }, hidden: true, rarity: 2 },
  { key: 'BIG_GAME_GENE',      label: 'Big-game gene',     side: 'any',     bias: { composure: +8, durability: +3 }, hidden: true, rarity: 2 },
]

// ─── Composition function ──────────────────────────────────────────────────

/**
 * Compose a player profile by picking a frame + archetype + 0-3 quirks.
 * Returns an object the generator uses to bias rating rolls.
 *
 * @param {{
 *   position: string,
 *   isPitcher: boolean,
 *   slotTier?: 'starter'|'bench'|'depth',
 *   rng: ReturnType<import('./rng.js').makeRng>,
 *   forceArchetype?: string,
 * }} params
 * @returns {{
 *   frame: BodyFrame,
 *   archetype: HitterArchetype|PitcherArchetype,
 *   quirks: Quirk[],
 *   biases: Object<string, number>,
 *   measurables: { heightInches: number, weightLbs: number },
 *   isLateBloomer: boolean,
 * }}
 */
export function composePlayerProfile({ position, isPitcher, slotTier = 'bench', rng, forceArchetype, pool = 'COLLEGE' }) {
  // Pick frame (weighted — average frames much more common than TOWERING),
  // then apply pool-specific maturity. HS seniors are 18-19 and haven't
  // filled out — their weight ranges are pulled DOWN ~20 lb.
  const baseFrame = pickFrameWeighted(rng)
  const frame = frameForPool(baseFrame, pool)
  // Pick archetype matching role; starters more likely to get standout templates
  const archetypePool = isPitcher ? PITCHER_ARCHETYPES : HITTER_ARCHETYPES
  let candidate
  if (forceArchetype) {
    candidate = archetypePool.find(a => a.key === forceArchetype) || rng.pick(archetypePool)
  } else {
    // Filter to compatible positions for hitters; pitchers filter by role
    const compatible = isPitcher
      ? archetypePool.filter(a => a.role === 'ANY' ||
          (a.role === 'SP' && position === 'SP') ||
          (a.role === 'RP' && position === 'RP'))
      : archetypePool.filter(a => a.positions.length === 0 || a.positions.includes(position))
    // Star archetypes (FIVE_TOOL, FLAMETHROWER, etc.) less likely on bench
    const tierFilter = (slotTier === 'depth' || slotTier === 'bench')
      ? compatible.filter(a => !isStarArchetype(a.key))
      : compatible
    candidate = rng.pick(tierFilter.length > 0 ? tierFilter : compatible)
  }
  // Quirks — 0, 1, 2, or rarely 3
  const quirkCount = rng.weighted([0, 1, 2, 3], [40, 35, 20, 5])
  const allowedSide = isPitcher ? ['pitcher', 'any'] : ['hitter', 'any']
  const compatibleQuirks = QUIRKS.filter(q => allowedSide.includes(q.side))
  const picked = []
  for (let i = 0; i < quirkCount; i++) {
    const remaining = compatibleQuirks.filter(q => !picked.includes(q))
    if (remaining.length === 0) break
    const weights = remaining.map(q => q.rarity)
    picked.push(rng.weighted(remaining, weights))
  }
  // Merge biases: frame + position stereotype + archetype + all quirks.
  // Same key → sum. Position bias is layered BEFORE archetype + quirks so
  // archetypes that explicitly contradict the position stereotype (e.g.
  // "Power-Hitting Catcher") can override it; the final number is the sum.
  const biases = {}
  function merge(src) {
    for (const [k, v] of Object.entries(src || {})) {
      biases[k] = (biases[k] || 0) + v
    }
  }
  merge(frame.bias)
  // Hitter position bias only — pitchers use the same set of pitcher-rating
  // keys regardless of SP/RP, so position-specific stereotypes don't apply.
  if (!isPitcher) merge(POSITION_BIAS[position])
  merge(candidate.bias)
  for (const q of picked) merge(q.bias)
  // Height first (sample frame range, position bias, role cap).
  const rawHeight = rng.int(frame.heightInches[0], frame.heightInches[1])
  const heightInches = adjustHeightForPosition(rawHeight, position, isPitcher)
  // Weight DERIVED FROM HEIGHT (not from frame weight range). Real young
  // athletes scale weight with height — a 6'6" player isn't 150 lb. Each
  // frame has a different BMI-like "build factor" so LANKY guys land
  // toward the bottom of the realistic range for their height and STOCKY
  // guys toward the top, but no frame can produce an unrealistic combo.
  const weightLbs = computeRealisticWeight(heightInches, frame.key, pool, rng)
  // Mature target weight — the weight the player will reach by SR after
  // filling out (or trimming down). HS guys have the most room to grow.
  let targetWeightDelta
  if (pool === 'HS_SR') {
    targetWeightDelta = Math.round(Math.max(-5, Math.min(30, rng.gaussian(18, 6))))
  } else if (pool === 'JUCO') {
    targetWeightDelta = Math.round(Math.max(-4, Math.min(16, rng.gaussian(8, 4))))
  } else {
    targetWeightDelta = Math.round(rng.gaussian(2, 6))
  }
  // Target weight also clamped to a realistic ceiling for the player's height
  const maxRealistic = realisticWeightCeiling(heightInches, frame.key)
  const targetMatureWeightLbs = Math.min(
    maxRealistic,
    Math.max(150, weightLbs + targetWeightDelta),
  )
  return {
    frame, archetype: candidate, quirks: picked, biases,
    measurables: { heightInches, weightLbs, targetMatureWeightLbs },
    isLateBloomer: candidate.key === 'LATE_BLOOMER_HIT' || candidate.key === 'LATE_BLOOMER_P',
  }
}

/**
 * Real young-adult athletes scale weight with height. A 6'2" lanky kid is
 * ~180-200; a 6'2" stocky kid is ~220-240. A 5'8" stocky kid is ~190-210;
 * a 5'8" lanky kid is ~155-170. NEVER produces 6'6"/150 lb absurdities.
 *
 * Strategy: per-inch baseline derived from BMI ranges typical for athletes,
 * adjusted by frame "build" (LANKY = thinner BMI, STOCKY = thicker), then
 * a small pool adjustment (HS pulls ~12 lb down, JUCO ~5 lb).
 *
 *   heightInches → baseline weight (athletic BMI ~24-26):
 *     66 (5'6) → 165 lb
 *     68 (5'8) → 175
 *     70 (5'10) → 185
 *     72 (6'0)  → 195
 *     74 (6'2)  → 205
 *     76 (6'4)  → 215
 *     78 (6'6)  → 225
 *     80 (6'8)  → 235
 *
 * Frame build factor (multiplier on baseline):
 *   UNDERSIZED: 0.94    LANKY: 0.92      WIRY: 0.95
 *   ATHLETIC: 1.00      STOCKY: 1.10     TOWERING: 1.08
 */
function computeRealisticWeight(heightInches, frameKey, pool, rng) {
  // Baseline: starts at 165 lb at 5'6" (66 in), +5 lb per inch up to ~80 in
  const baseline = 165 + (heightInches - 66) * 5
  const buildFactor = {
    UNDERSIZED: 0.94, LANKY: 0.92, WIRY: 0.95,
    ATHLETIC: 1.00, STOCKY: 1.10, TOWERING: 1.08,
  }[frameKey] || 1.0
  // Pool maturity: HS pulled down ~12 lb, JUCO ~5 lb (still filling out)
  const poolShift = pool === 'HS_SR' ? -12 : pool === 'JUCO' ? -5 : 0
  // Small natural variance (±6 lb)
  const noise = rng.gaussian(0, 5)
  const weight = baseline * buildFactor + poolShift + noise
  // Hard floors so we never produce an absurd combo
  const floor = Math.max(145, baseline * 0.85)
  const ceiling = realisticWeightCeiling(heightInches, frameKey)
  return Math.round(Math.max(floor, Math.min(ceiling, weight)))
}

/**
 * Upper bound on realistic weight for a given height + frame. Used both to
 * clamp the initial roll AND to cap targetMatureWeightLbs after growth.
 */
function realisticWeightCeiling(heightInches, frameKey) {
  // Heaviest reasonable athlete weight at a height is roughly BMI 32.
  // 5'6" → 247, 6'0" → 290, 6'6" → 320 — these are upper bounds, not norms.
  // STOCKY / TOWERING can reach higher; LANKY caps lower.
  const baseCeiling = 220 + (heightInches - 66) * 6.5
  const frameMult = {
    UNDERSIZED: 0.92, LANKY: 0.95, WIRY: 0.95,
    ATHLETIC: 1.00, STOCKY: 1.12, TOWERING: 1.10,
  }[frameKey] || 1.0
  return Math.round(baseCeiling * frameMult)
}

const STAR_ARCHETYPES = new Set(['FIVE_TOOL', 'FLAMETHROWER', 'CLOSER_PROFILE'])
function isStarArchetype(key) { return STAR_ARCHETYPES.has(key) }

/**
 * Format height (in inches) → e.g. "6'2"".
 */
export function formatHeight(inches) {
  const ft = Math.floor(inches / 12)
  const inch = inches % 12
  return `${ft}'${inch}"`
}

/** Lookup archetype by key for UI display. */
export function getArchetype(key) {
  return [...HITTER_ARCHETYPES, ...PITCHER_ARCHETYPES].find(a => a.key === key)
}

/**
 * Star archetypes promise a signature tool — a "Defensive Wizard" with 55
 * fielding is a contradiction. After ratings roll, enforce minimum values
 * on the archetype's signature stats so the visible profile matches the
 * label. Applied INSIDE the role-specific cap (still 99) so we never
 * generate absurdly high ratings; we just bring weak rolls UP to a
 * believable floor for that archetype.
 *
 * @param {string} archetypeKey
 * @param {object} hitterBlock   mutated in place if hitter archetype
 * @param {object} pitcherBlock  mutated in place if pitcher archetype
 */
export function enforceArchetypeFloors(archetypeKey, hitterBlock, pitcherBlock) {
  const floors = ARCHETYPE_FLOORS[archetypeKey]
  if (!floors) return
  const block = (archetypeKey in PITCHER_FLOOR_KEYS) ? pitcherBlock : hitterBlock
  if (!block) return
  for (const [stat, min] of Object.entries(floors)) {
    if (typeof block[stat] === 'number' && block[stat] < min) {
      block[stat] = min
    }
  }
}

// Per-archetype minimum signature ratings. Tuned so a labeled "Defensive
// Wizard" always has plus defense, a "Power Bat" always has plus power, etc.
const ARCHETYPE_FLOORS = {
  // Hitter archetypes
  FIVE_TOOL:         { contact_l: 70, contact_r: 70, power_l: 65, power_r: 65, speed: 70, fielding: 70, arm: 68 },
  POWER_BAT:         { power_l: 78, power_r: 78 },
  CONTACT_WIZARD:    { contact_l: 80, contact_r: 80, discipline: 70 },
  SPEED_DEMON:       { speed: 85, fielding: 65 },
  LEADOFF:           { contact_l: 70, contact_r: 70, discipline: 75, speed: 72 },
  DEFENSIVE_WIZARD:  { fielding: 82, arm: 72 },
  GLOVE_FIRST_IF:    { fielding: 75, arm: 68 },
  CANNON_OF:         { arm: 85, fielding: 65 },
  POWER_C:           { power_l: 70, power_r: 70 },
  DEFENSIVE_C:       { fielding: 78, arm: 80 },
  CLEANUP:           { power_l: 72, power_r: 72 },
  GAP_POWER:         { power_l: 68, power_r: 68, contact_l: 68, contact_r: 68 },
  SLAP_HITTER:       { contact_l: 75, contact_r: 75, speed: 70 },
  TOOLS_RAW:         { speed: 70, power_l: 65, power_r: 65 },
  // Pitcher archetypes — FLAMETHROWER no longer requires high stuff
  // (its signature is velocity, not movement). The velocityBias on the
  // archetype handles the "throws hard" guarantee. Keep a small stuff
  // floor so they're not absurdly bad shape on top of being wild.
  FLAMETHROWER:      { stuff: 55 },
  POWER_ARM:         { stuff: 78 },
  PITCH_SHAPER:      { stuff: 82, command: 70 },
  CONTROL_ARTIST:    { control: 80, command: 78 },
  CRAFTY_LEFTY:      { command: 78, control: 75, vs_l: 80 },
  WORKHORSE:         { stamina: 78, durability: 72 },
  CLOSER_PROFILE:    { stuff: 78, composure: 75 },
  GROUND_BALL:       { command: 78, control: 75 },
  STRIKEOUT_ARTIST:  { stuff: 78, command: 70 },
  TWO_PITCH_RP:      { stuff: 75 },
  DECEPTIVE:         { stuff: 70, vs_l: 70, vs_r: 70 },
  SOFT_TOSSING_VETERAN: { command: 80, composure: 75, control: 75 },
}

// Quick lookup so enforceArchetypeFloors knows which block to mutate.
const PITCHER_FLOOR_KEYS = Object.fromEntries(
  Object.keys(ARCHETYPE_FLOORS)
    .filter(k => PITCHER_ARCHETYPES.some(a => a.key === k))
    .map(k => [k, true])
)

/** Lookup quirk by key for UI display. */
export function getQuirk(key) {
  return QUIRKS.find(q => q.key === key)
}
