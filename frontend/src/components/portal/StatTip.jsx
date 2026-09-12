// Hover cards for every stat in the TrackMan suite.
//
// One registry, one component. STAT_DEFS keys match the data keys the API
// already returns, so a column header only has to name its key and group;
// the card fills in the plain-English definition, the formula, and what
// average looks like in this coach's own data (fetched once per suite and
// shared through StatAvgContext).
import { createContext, useContext } from 'react'

export const StatAvgContext = createContext({ averages: {}, context: 'all' })
export const useStatAvg = () => useContext(StatAvgContext)

// [what it is, how it is computed, decimals, unit]
export const STAT_DEFS = {
  // ── shared / hitting ──
  pitches: ['Tracked pitches seen.', 'Count of pitches with this batter at the plate.', 0],
  bbe: ['Batted-ball events: tracked balls off the bat.', 'Count of pitches with a measured exit velo (fouls included).', 0],
  pa: ['Plate appearances reconstructed from the pitch sequence.', 'Terminal pitch per (session, inning, half, PA number).', 0],
  avg_ev: ['Average exit velocity off the bat.', 'Sum of exit velo / batted balls.', 1, ' mph'],
  p90_ev: ['90th-percentile exit velo: the top-end contact a hitter repeats.', '90th percentile of his batted-ball exit velos.', 1, ' mph'],
  max_ev: ['Hardest ball he hit.', 'Max exit velo.', 1, ' mph'],
  avg_la: ['Average launch angle.', 'Sum of launch angle / batted balls. 8 to 32 degrees is the damage window.', 1, '°'],
  hh_pct: ['Hard-hit rate.', 'Batted balls at 90+ mph / batted balls x 100.', 1, '%'],
  barrel_pct: ['Barrel rate: the best combination of speed and angle.', 'Balls at 95+ mph with launch angle 8-32 / batted balls x 100 (college-scaled).', 1, '%'],
  gb_pct: ['Ground-ball rate.', 'Batted balls under 10 degrees / batted balls with a launch angle x 100.', 1, '%'],
  ld_pct: ['Line-drive rate.', 'Batted balls 10-25 degrees / batted balls with a launch angle x 100.', 1, '%'],
  fb_pct: ['Fly-ball rate.', 'Batted balls 25-50 degrees / batted balls with a launch angle x 100.', 1, '%'],
  airpull_pct: ['Air-pull rate: how often he lifts AND pulls, where power lives.', 'Air balls (10+ degrees) pulled 10+ degrees / all air balls x 100.', 1, '%'],
  depth: ['Contact depth: how far in front of the plate he meets the ball.', 'Average contact position toward the pitcher. 0 = back of plate, 1.4 = front edge; damage peaks 1.3-2.7 ft.', 2, ' ft'],
  max_dist: ['Longest tracked batted ball.', 'Max projected distance.', 0, ' ft'],
  swing_pct: ['Swing rate.', 'Swings / called pitches x 100.', 1, '%'],
  contact_pct: ['Contact rate: how often a swing finds the ball.', 'Swings with contact / total swings x 100.', 1, '%'],
  zone_contact_pct: ['Zone contact: bat-to-ball on pitches he should handle.', 'Contact on swings at in-zone pitches / in-zone swings x 100.', 1, '%'],
  ozone_contact_pct: ['Out-of-zone contact. High is not always good: weak contact on a pitcher’s pitch makes outs.', 'Contact on swings at out-of-zone pitches / out-of-zone swings x 100.', 1, '%'],
  chase_pct: ['Chase rate: swinging at balls.', 'Swings at out-of-zone pitches / out-of-zone pitches x 100.', 1, '%'],
  fp_swing_pct: ['First-pitch swing rate: his 0-0 aggression.', 'Swings on 0-0 / 0-0 pitches x 100.', 1, '%'],
  k2_contact_pct: ['Two-strike contact: the battle skill.', 'Contact on two-strike swings / two-strike swings x 100.', 1, '%'],
  k_pct: ['Strikeout rate.', 'Strikeouts / completed plate appearances x 100.', 1, '%'],
  bb_pct: ['Walk rate.', 'Walks / completed plate appearances x 100.', 1, '%'],
  xavg: ['Expected batting average from contact quality, not results.', 'Each ball in play scored by an exit-velo/launch-angle/spray model, summed / at-bats.', 3],
  xslg: ['Expected slugging from contact quality.', 'Model expected total bases / at-bats.', 3],
  xwoba: ['Expected wOBA: one number for total offensive value earned.', 'Model contact value plus real walks and hit-by-pitches, per plate appearance.', 3],
  xwobacon: ['Expected wOBA on contact only (walks excluded).', 'Average model wOBA value of his batted balls.', 3],
  rv: ['Run value: runs created versus an average plate appearance here.', 'Every pitch priced by count, summed, then re-centered so the corpus nets zero.', 1, ' runs'],
  heart_rv: ['Run value on pitches over the middle.', 'Run value summed on heart-zone pitches (swings and takes).', 1, ' runs'],
  shadow_rv: ['Run value on the edges.', 'Run value summed on shadow-zone pitches.', 1, ' runs'],
  chase_rv: ['Run value on pitches off the plate: mostly a take-discipline score.', 'Run value summed on chase and waste pitches.', 1, ' runs'],
  transfer: ['Transfer gap: does the cage swing show up in games?', 'Live hard-hit% minus BP hard-hit%. Negative means it is not carrying.', 1, ' pts'],
  contact_per_pitch: ['Balls in play per machine pitch. NOT contact%: BP files carry no swing calls.', 'Batted balls / pitches x 100.', 1, '%'],
  oz_contact_pct: ['Share of BP contact that came on out-of-zone pitches: a floor on chasing.', 'Batted balls on out-of-zone pitches / located batted balls x 100.', 1, '%'],
  // ── pitching ──
  stuff: ['Stuff: physical nastiness only (velo, movement, spin, extension, separation). Says nothing about command.', 'Model grade re-centered per pitch type on your corpus: 100 = average here.', 0],
  loc: ['Location+: command score from edge presence and pitch-type height targets.', '100 = average in this corpus.', 0],
  usage_pct: ['How often he throws this pitch.', 'Pitches of this type / his total pitches x 100.', 1, '%'],
  velo: ['Average release speed.', 'Mean velo of this pitch type.', 1, ' mph'],
  max_velo: ['Top release speed on this pitch.', 'Max velo of this pitch type.', 1, ' mph'],
  spin: ['Average spin rate.', 'Mean spin of this pitch type.', 0, ' rpm'],
  ivb: ['Induced vertical break: ride (+) or drop (-) beyond gravity.', 'Mean IVB of this pitch type, in inches.', 1, '"'],
  hb: ['Horizontal break: arm-side (+) or glove-side (-) movement.', 'Mean horizontal break, in inches.', 1, '"'],
  extension: ['Release extension down the mound: more extension plays up the velo.', 'Mean extension in feet.', 1, ' ft'],
  rel_height: ['Release height.', 'Mean release height in feet.', 1, ' ft'],
  vaa: ['Vertical approach angle at the plate: flatter fastballs play up at the top.', 'Mean VAA in degrees (negative is downward).', 2, '°'],
  zone_pct: ['Zone rate.', 'Pitches in the strike zone / pitches of this type x 100.', 1, '%'],
  shadow_pct: ['Shadow rate: living on the edges.', 'Pitches in the shadow band around the zone / pitches x 100.', 1, '%'],
  heart_pct: ['Heart rate: pitches over the middle.', 'Pitches in the heart zone / pitches x 100.', 1, '%'],
  whiff_pct: ['Whiff rate: swings that miss.', 'Whiffs / swings at this pitch x 100.', 1, '%'],
  csw_pct: ['Called strikes plus whiffs: the quickest single pitch-quality check.', '(Called strikes + whiffs) / pitches x 100.', 1, '%'],
  ev_against: ['Exit velo allowed on this pitch.', 'Mean exit velo of balls hit off it.', 1, ' mph'],
  rv100: ['Run value per 100 pitches: the rate version, fair between a starter and a reliever.', 'Run value / pitches x 100, pitcher perspective (positive = runs saved).', 2],
  // ── catching ──
  sae: ['Strikes Above Expected: framing skill on taken pitches at the edge.', 'Actual called strikes minus the location model’s expectation, calibrated so the corpus nets zero.', 1],
  framing_runs: ['Framing runs.', 'SAE x 0.125 runs per stolen strike.', 1, ' runs'],
  arm_runs: ['Arm runs: throwing value against the corpus rate.', 'Attempts x (blended CS% - corpus CS%) x 0.85 runs per caught steal.', 1, ' runs'],
  total_runs: ['Total value: everything this page credits, in runs.', 'Sum of the component run columns.', 1, ' runs'],
  avg_pop: ['Pop time: catch to the throw arriving at second.', 'Mean pop time. College average is about 2.10; sub-2.00 is elite.', 2, 's'],
  best_pop: ['Best pop time recorded.', 'Minimum pop time.', 2, 's'],
  avg_exchange: ['Exchange: glove to release.', 'Mean exchange time.', 2, 's'],
  avg_throw: ['Throwing velocity to second.', 'Mean throw speed.', 1, ' mph'],
  blended_cs_pct: ['Blended caught-stealing rate.', 'Actual season throw-out record regressed toward the pop-time expectation (prior worth ~15 attempts).', 1, '%'],
  // ── defense ──
  oae: ['Outs Above Expected: plays made versus what an average fielder makes.', 'Outs made minus summed catch/range probability for his chances.', 1, ' outs'],
  opps: ['Chances: batted balls he was responsible for.', 'Count of opportunities with fielder positioning tracked.', 0],
  conv_pct: ['Conversion: share of his chances turned into outs.', 'Outs / chances x 100.', 1, '%'],
  x_conv_pct: ['Expected conversion given the difficulty he faced.', 'Summed play probability / chances x 100.', 1, '%'],
  // ── values ──
  off_runs: ['Offensive runs above average.', 'wRAA: season wOBA versus the division average, scaled by plate appearances.', 1, ' runs'],
  bsr_runs: ['Baserunning runs.', 'Stolen bases x 0.2 minus caught stealing x 0.4.', 1, ' runs'],
  if_runs: ['Infield defensive runs.', 'Infield OAE x 0.70 runs per out.', 1, ' runs'],
  of_runs: ['Outfield defensive runs.', 'Outfield OAE x 0.80 runs per out.', 1, ' runs'],
  catch_runs: ['Catching runs.', 'Framing runs plus blended arm runs.', 1, ' runs'],
  pitch_runs: ['Pitching runs above average.', '(Division average FIP minus his FIP) / 9 x innings pitched.', 1, ' runs'],
  tracked_rv: ['Run value from tracked pitches, shown beside the season-FIP value as a second lens.', 'Pitch-level run value over tracked sessions (never summed into the total).', 1, ' runs'],
}

const fmtAvg = (v, dec, unit) =>
  v == null ? null : `${Number(v).toFixed(dec ?? 1)}${unit || ''}`

// Header cell content with a hover card. Wrap any label; pass the data key
// and which average group it belongs to.
export default function StatTip({ k, group = 'hitting', label, className = '', align = 'right',
                                 avg: avgProp, n: nProp, fallback }) {
  const def = STAT_DEFS[k]
  const { averages } = useStatAvg()
  // An explicit avg (the cohort actually on screen) beats the corpus number.
  const avg = avgProp != null ? avgProp : (def ? averages?.[group]?.[k] : null)
  const n = avgProp != null ? nProp : averages?.[group]?._n
  if (!def) return <span title={fallback || undefined}>{label}</span>
  const [what, formula, dec, unit] = def
  return (
    <span className={`relative group/tip cursor-help ${className}`}>
      <span className="border-b border-dotted border-gray-300 dark:border-gray-600">{label}</span>
      <span
        className={`pointer-events-none invisible group-hover/tip:visible opacity-0 group-hover/tip:opacity-100
          transition-opacity absolute z-50 top-full mt-1.5 w-64 p-2.5 rounded-lg
          bg-gray-900 text-gray-100 dark:bg-gray-700 shadow-xl text-left normal-case tracking-normal
          ${align === 'right' ? 'right-0' : 'left-0'}`}>
        <span className="block text-[11px] font-bold text-white mb-1">{label}</span>
        <span className="block text-[11px] leading-snug text-gray-200">{what}</span>
        <span className="block text-[10.5px] leading-snug text-gray-400 mt-1.5">
          <b className="text-gray-300">How:</b> {formula}
        </span>
        {avg != null && (
          <span className="block text-[10.5px] text-emerald-300 mt-1.5 font-semibold tabular-nums">
            Your average: {fmtAvg(avg, dec, unit)}
            {n ? <span className="text-gray-400 font-normal"> (across {n})</span> : null}
          </span>
        )}
      </span>
    </span>
  )
}
