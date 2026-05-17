/**
 * NIL (Name / Image / Likeness) — D1-specific recruiting + retention $.
 *
 * NIL is real money offered to college players ON TOP OF scholarships.
 * The amounts vary wildly by program tier and individual recruit profile.
 *
 * Realistic D1 baseball NIL figures (2024-25 reporting):
 *   - Elite SEC/ACC top recruits:  $200K-$1M+  (Vandy, LSU, Tennessee)
 *   - Mid P5 D1 top recruits:      $50K-$200K
 *   - Non-P5 D1 starters:          $5K-$50K
 *   - Group-of-5 D1 mid-tier:      $1K-$10K
 *   - Low D1 / WAC / etc.:         $500-$5K
 *   - D2:                          $0-$1K (rare, just emerging)
 *   - D3 / NAIA / NWAC:            $0 (NIL almost nonexistent at these levels)
 *
 * Each program has an annual NIL POOL — total $ they can offer across
 * all recruits in a recruiting cycle. The pool scales with:
 *   - Level (D1 base, others ~$0)
 *   - Program prestige (top-25 D1 has 5-10x what bottom-100 D1 has)
 *   - Resource tier from the school object
 *
 * Per-recruit NIL is a NEW field on liveOffer:
 *   liveOffer.nilAmount — $/yr promised as NIL (in addition to scholarship)
 *
 * In the commit calc, NIL stacks with scholarship $ — and matters MORE
 * for recruits whose top priority is financial. A kid with 'financial'
 * as a top-3 priority weighs NIL ~2x as heavily as scholarship $ because
 * NIL is cash in hand (scholarship covers tuition you might have gotten
 * a discount on anyway).
 */

/**
 * Compute the school's annual NIL pool ($/yr) based on level + prestige.
 *
 * @param {object} school — must have level + programHistory + resourceTier
 * @returns {number} annual NIL pool in $
 */
export function annualNilPoolForSchool(school) {
  if (!school) return 0
  const level = school.level || 'NAIA'
  if (level !== 'D1') return 0   // NIL is a D1 thing (and SEC-ish at that)

  // Use programHistory (0-100) as a prestige proxy. Elite P5 program at
  // ph=92 lands a ~$700K pool; mid D1 at ph=70 gets ~$80K; low D1 at
  // ph=45 gets ~$3K.
  const ph = school.programHistory || 50
  if (ph >= 88) return 700_000
  if (ph >= 80) return 300_000
  if (ph >= 72) return 120_000
  if (ph >= 64) return 40_000
  if (ph >= 56) return 12_000
  if (ph >= 48) return 4_000
  return 1_500
}

/** Cap on what you can offer ONE recruit, also tier-aware. */
export function nilOfferCapForSchool(school) {
  const pool = annualNilPoolForSchool(school)
  if (pool === 0) return 0
  // Per-recruit cap = ~25% of pool. Big programs can drop $175K on a single
  // elite recruit; mid-D1 caps at maybe $10K per kid.
  return Math.round(pool * 0.25)
}

/**
 * Total NIL committed across all live offers from this school.
 * Used to enforce the pool cap.
 *
 * @param {object} state
 * @returns {number}
 */
export function totalNilCommitted(state) {
  if (!state.recruits) return 0
  let total = 0
  for (const r of Object.values(state.recruits)) {
    if (r.liveOffer?.schoolId === state.userSchoolId) {
      total += r.liveOffer.nilAmount || 0
    }
  }
  return total
}

/** Remaining NIL pool available. */
export function nilPoolRemaining(state) {
  const school = state.schools?.[state.userSchoolId]
  return annualNilPoolForSchool(school) - totalNilCommitted(state)
}

/**
 * Convert a NIL offer into a "financial-fit boost" for the commit calc.
 *
 * Logic:
 *   - $0 NIL → no boost
 *   - $1K → small bump (kids notice)
 *   - $10K → meaningful (lower D1 territory)
 *   - $50K → strong (mid-major eye-catcher)
 *   - $200K+ → killer offer
 *
 * Returned as an additive ADJUSTMENT to offerAdvantage in the existing
 * tryAdvanceRecruit calc. Range typically 0..4 (where +3 is "blown away").
 */
export function nilAdvantage(nilAmount, recruitPrefersFinancial) {
  if (!nilAmount || nilAmount <= 0) return 0
  // log scale: log10($1K) = 3, log10($10K) = 4, log10($100K) = 5, log10($1M) = 6
  const score = Math.max(0, Math.log10(nilAmount) - 2.5)   // $300 → 0, $10K → 1.5, $100K → 2.5
  // Recruits who care about $ weigh NIL more heavily
  return recruitPrefersFinancial ? score * 1.5 : score * 1.0
}

/**
 * Format a $ amount as a short string ($175K / $1.2M / $850).
 */
export function formatNil(amount) {
  if (!amount || amount <= 0) return '$0'
  if (amount >= 1_000_000) return '$' + (amount / 1_000_000).toFixed(1) + 'M'
  if (amount >= 1_000) return '$' + (amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1) + 'K'
  return '$' + amount.toFixed(0)
}
