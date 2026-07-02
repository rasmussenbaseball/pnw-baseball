/**
 * Pre-built starter templates for the Custom Player Card.
 *
 * These ship with the app (read-only) so a coach can pick a proven layout in
 * one click instead of assembling blocks by hand. They're split into HITTER
 * and PITCHER sets because the useful blocks differ by player type. Each layout
 * is designed to FILL the page: rows are sized so their block widths sum to a
 * full row (¼+¼+¼+¼, ½+½, or full), and short stat blocks are dropped to a
 * quarter so they pack tightly instead of leaving whitespace.
 *
 * Block shape mirrors the live builder: { type, w:'quarter'|'half'|'full', filter? }.
 * `for` sets the side ('hitter' → batting, 'pitcher' → pitching).
 */

const Q = 'quarter'
const H = 'half'
const F = 'full'
const b = (type, w = H, extra = {}) => ({ type, w, ...extra })

export const STARTER_TEMPLATES = [
  // ── HITTERS ──
  {
    id: 'hit_standard', name: 'Hitter · Standard', for: 'hitter',
    desc: 'Everyday card: percentiles + spray up top, a tight row of discipline/batted/splits/counts, season line.',
    blocks: [
      b('header', F),
      b('percentiles', H), b('spray', H, { filter: 'all' }),
      b('discipline', Q), b('batted', Q), b('splits', Q), b('counts', Q),
      b('season', F),
    ],
  },
  {
    id: 'hit_sprays', name: 'Hitter · Advanced Sprays', for: 'hitter',
    desc: 'Four spray views (all / vs RHP / vs LHP / extra-base), batted-ball mix, splits and how-to-attack.',
    blocks: [
      b('header', F),
      b('spray', H, { filter: 'all' }), b('spray', H, { filter: 'vs_rhp' }),
      b('spray', H, { filter: 'vs_lhp' }), b('spray', H, { filter: 'xbh' }),
      b('batted', Q), b('splits', Q), b('tendencies', H),
    ],
  },
  {
    id: 'hit_defense', name: 'Hitter · Defensive Alignment', for: 'hitter',
    desc: 'Where to play the defense: field diagram + position grid + spray, with a quarter-row of context stats.',
    blocks: [
      b('header', F),
      b('fielddiagram', H), b('spray', H, { filter: 'all' }),
      b('fieldgrid', H), b('tendencies', H),
      b('batted', Q), b('splits', Q), b('counts', Q), b('bench', Q),
    ],
  },
  {
    id: 'hit_advanced', name: 'Hitter · Advanced', for: 'hitter',
    desc: 'Spray + defensive alignment up top, percentiles beside the detailed count grid, a row of advanced splits, then season line and notes.',
    blocks: [
      b('header', F),
      b('spray', H, { filter: 'all' }), b('fielddiagram', H),
      b('percentiles', H), b('countdetail', H),
      b('velite', Q), b('bench', Q), b('batted', Q), b('counts', Q),
      b('season', F),
      b('notes', F),
    ],
  },

  // ── PITCHERS ──
  {
    id: 'pit_standard', name: 'Pitcher · Standard', for: 'pitcher',
    desc: 'Everyday card: percentiles + opp spray, a tight row of discipline/batted/splits/counts, season line.',
    blocks: [
      b('header', F),
      b('percentiles', H), b('spray', H, { filter: 'all' }),
      b('discipline', Q), b('batted', Q), b('splits', Q), b('counts', Q),
      b('season', F),
    ],
  },
  {
    id: 'pit_attack', name: 'Pitcher · Attack Plan', for: 'pitcher',
    desc: 'Times-through-the-order + per-count induced swing/whiff up top, a quarter-row of splits, then how-to-attack and recent Ks.',
    blocks: [
      b('header', F),
      b('tto', H), b('countdetail', H),
      b('discipline', Q), b('splits', Q), b('counts', Q), b('batted', Q),
      b('tendencies', H), b('recentk', H),
    ],
  },
  {
    id: 'pit_full', name: 'Pitcher · Full Scout', for: 'pitcher',
    desc: 'Everything: percentiles + spray, TTO + detailed counts, a quarter-row of splits plus a blank pitch-mix, grades and a write-up.',
    blocks: [
      b('header', F),
      b('percentiles', H), b('spray', H, { filter: 'all' }),
      b('tto', H), b('countdetail', H),
      b('discipline', Q), b('batted', Q), b('splits', Q), b('pitchmix', Q, { title: 'Pitch Mix' }),
      b('grades', H), b('measurables', H),
      b('scouttake', F),
    ],
  },
]

export function starterTemplatesFor(side) {
  const want = side === 'pitching' ? 'pitcher' : 'hitter'
  return STARTER_TEMPLATES.filter(t => t.for === want)
}
