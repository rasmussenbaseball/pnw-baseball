/**
 * Pre-built starter templates for the Custom Player Card.
 *
 * These ship with the app (read-only) so a coach can pick a proven layout in
 * one click instead of assembling blocks by hand. They're split into HITTER
 * and PITCHER sets because the useful blocks differ by player type — e.g. only
 * hitters get the defensive-alignment blocks, only pitchers get times-through-
 * the-order. Loading one drops its blocks into the builder (with the correct
 * side locked) where the coach can still tweak, then Save-As to keep a copy.
 *
 * Block shape mirrors the live builder: { type, w, filter? }.
 * `for` sets the side ('hitter' → batting, 'pitcher' → pitching).
 */

const H = 'half'
const F = 'full'
const b = (type, w = H, extra = {}) => ({ type, w, ...extra })

export const STARTER_TEMPLATES = [
  // ── HITTERS ──
  {
    id: 'hit_standard', name: 'Hitter · Standard', for: 'hitter',
    desc: 'The everyday card: percentiles, spray, discipline, batted ball, splits, season line.',
    blocks: [
      b('header', F), b('percentiles'), b('spray', H, { filter: 'all' }),
      b('discipline'), b('batted'), b('splits'), b('counts'), b('season', F),
    ],
  },
  {
    id: 'hit_sprays', name: 'Hitter · Advanced Sprays', for: 'hitter',
    desc: 'Four spray views (all / vs RHP / vs LHP / extra-base) plus batted-ball mix and how-to-attack.',
    blocks: [
      b('header', F),
      b('spray', H, { filter: 'all' }), b('spray', H, { filter: 'vs_rhp' }),
      b('spray', H, { filter: 'vs_lhp' }), b('spray', H, { filter: 'xbh' }),
      b('batted'), b('tendencies'),
    ],
  },
  {
    id: 'hit_defense', name: 'Hitter · Defensive Alignment', for: 'hitter',
    desc: 'Where to play the defense: field diagram + position grid, with spray and batted-ball context.',
    blocks: [
      b('header', F),
      b('fielddiagram'), b('fieldgrid'),
      b('spray', H, { filter: 'all' }), b('batted'),
      b('tendencies'), b('counts'),
    ],
  },
  {
    id: 'hit_full', name: 'Hitter · Full Scout', for: 'hitter',
    desc: 'Everything: percentiles, spray, discipline, detailed counts, splits, attack plan, 20-80 grades, write-up.',
    blocks: [
      b('header', F), b('percentiles'), b('spray', H, { filter: 'all' }),
      b('discipline'), b('batted'), b('countdetail'), b('splits'),
      b('tendencies'), b('grades'), b('scouttake', F),
    ],
  },

  // ── PITCHERS ──
  {
    id: 'pit_standard', name: 'Pitcher · Standard', for: 'pitcher',
    desc: 'The everyday card: percentiles, opp spray, discipline, batted ball, splits, season line.',
    blocks: [
      b('header', F), b('percentiles'), b('spray', H, { filter: 'all' }),
      b('discipline'), b('batted'), b('splits'), b('counts'), b('season', F),
    ],
  },
  {
    id: 'pit_attack', name: 'Pitcher · Attack Plan', for: 'pitcher',
    desc: 'Times-through-the-order, per-count induced swing/whiff, discipline, splits and how-to-attack.',
    blocks: [
      b('header', F), b('tto'), b('discipline'),
      b('countdetail'), b('splits'), b('tendencies'),
      b('spray', H, { filter: 'all' }), b('recentk'),
    ],
  },
  {
    id: 'pit_full', name: 'Pitcher · Full Scout', for: 'pitcher',
    desc: 'Everything: percentiles, discipline, TTO, detailed counts, batted ball, splits, grades, write-up.',
    blocks: [
      b('header', F), b('percentiles'), b('discipline'), b('tto'),
      b('countdetail'), b('batted'), b('splits'), b('tendencies'),
      b('grades'), b('scouttake', F),
    ],
  },
]

export function starterTemplatesFor(side) {
  const want = side === 'pitching' ? 'pitcher' : 'hitter'
  return STARTER_TEMPLATES.filter(t => t.for === want)
}
