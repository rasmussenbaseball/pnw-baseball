/**
 * AttrTooltip — small hover-tooltip wrapper for showing what an attribute does.
 * Used in roster/player tables and the player detail page.
 *
 * Usage: <AttrTooltip text="What this rating drives in the sim..."><span>...</span></AttrTooltip>
 */

import { useState } from 'react'

export const ATTR_DESCRIPTIONS = {
  // Hitter
  contact_l: 'Contact (vs LHP): drives BA + K avoidance vs left-handed pitchers.',
  contact_r: 'Contact (vs RHP): drives BA + K avoidance vs right-handed pitchers.',
  power_l:   'Power (vs LHP): drives ISO + HR rate vs left-handed pitchers.',
  power_r:   'Power (vs RHP): drives ISO + HR rate vs right-handed pitchers.',
  discipline:'Plate Discipline: drives BB rate, K avoidance, plate approach.',
  speed:     'Speed: drives infield singles, doubles on gappers, SB attempts, advancement.',
  fielding:  'Fielding: drives outs converted at the position they\'re playing.',
  arm:       'Arm: drives OF assists, IF cutoff accuracy, C pop time.',
  // Pitcher
  stuff:     'Stuff: whiff rate + contact-quality suppression. Big driver of K/9.',
  control:   'Control: BB rate + HBP rate. Bad control = lots of free bases.',
  command:   'Command: HR rate suppression + leverage performance. Ability to pitch to spots.',
  stamina:   'Stamina: innings per outing before fatigue penalties.',
  vs_l:      'vs LHB: modifier vs left-handed batters.',
  vs_r:      'vs RHB: modifier vs right-handed batters.',
  composure: 'Composure: performance in high-leverage / late innings.',
  durability:'Durability: day-to-day recovery, injury odds.',
  // Coach
  developer: 'Developer (DEV): drives how fast your players progress toward their potential. Higher = faster offseason ratings gains for everyone.',
  motivator: 'Motivator (MOT): drives team chemistry, GPA boost from coaching, clutch/composure in big moments, and fundraising yield.',
  recruiter: 'Recruiter (REC): drives weekly AP, how fast you build interest with recruits, and the program\'s closing rate on verbal commitments.',
  tactician: 'Tactician (TAC): drives in-game AI decisions — lineup construction, pitching changes, defensive positioning.',
}

export default function AttrTooltip({ attr, text, children }) {
  const [hover, setHover] = useState(false)
  const desc = text || ATTR_DESCRIPTIONS[attr] || ''
  if (!desc) return children
  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
      {hover && (
        <span className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-pnw-slate text-white text-[10px] rounded whitespace-nowrap shadow-lg max-w-xs">
          {desc}
        </span>
      )}
    </span>
  )
}
