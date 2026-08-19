// Stat glossary for the TrackMan Suite — every metric the portal coins or
// borrows, in plain coach language. Opened from the suite header so a staff
// member who never read the docs can decode any table on any tab.
import { useEffect, useState } from 'react'

const SECTIONS = [
  ['Run values', [
    ['RV (run value)', 'Every pitch changes the expected runs of the plate appearance: a ball helps the hitter, a strike helps the pitcher, and a ball in play swaps the count for the result (single, out, homer...). RV adds those changes up. For pitchers, positive = runs saved; for hitters, positive = runs created. Centered on your own data, so 0 = average here, and the number reads like runs on the scoreboard.'],
    ['RV/100', 'Run value per 100 pitches — the rate version, fair to compare between a starter and a reliever. +2 per 100 is a real weapon; -2 is getting hurt.'],
    ['Swing/take RV', "A hitter's run value split by decision: what their swings earned and what their takes earned, in each attack zone. Good takes on chase pitches show up as real positive runs."],
  ]],
  ['Attack zones', [
    ['Heart', 'The middle two-thirds of the strike zone. Pitches to hit — and pitches that get hurt.'],
    ['Shadow', "The band around the zone's edges, from just inside to about one ball-width outside. Where strikes are stolen and calls are lost; the best pitchers live here."],
    ['Chase', 'Beyond the shadow, up to a full zone-width off the plate. A swing here is a free strike for the pitcher.'],
    ['Waste', 'Everything farther out. Noncompetitive unless it sets something up.'],
    ['Shadow%', "How often a pitcher's pitches land in the shadow band — an edge-living score. Heart% is the same idea for the middle."],
  ]],
  ['Pitching', [
    ['Stuff', 'Physical nastiness of the pitch: velo, movement, spin, extension, and separation off the fastball, graded by the site\'s trained model and re-centered on your own corpus, so 100 = the average pitch of that type in your data and every pitch type shares one scale. Says nothing about command.'],
    ['Location+', 'Command score: edge presence plus pitch-type height targets. 100 = average.'],
    ['CSW%', 'Called strikes + swinging strikes, per pitch. The quickest single pitch-quality check.'],
    ['Whiff%', 'Misses per swing. Chase% = swings at pitches outside the zone, per out-of-zone pitch.'],
    ['VAA', 'Vertical approach angle at the plate. Flatter fastballs (closer to level) play up at the top of the zone.'],
  ]],
  ['Hitting', [
    ['EV / Hard-hit%', 'Exit velocity off the bat; hard-hit = 90+ mph. Sweet-spot% = launch angle between 8 and 32 degrees.'],
    ['xAVG / xSLG / xwOBA', "What the batted-ball profile (exit velo, launch angle, and spray direction) says the hitter SHOULD be hitting, on a curve calibrated to college contact. A gap vs the actual number means luck, speed, or defense — and it usually closes."],
    ['Transfer gap', 'Live hard-hit% minus BP hard-hit%. Negative means the cage swing is not carrying into games.'],
  ]],
  ['Defense', [
    ['OAE (Outs Above Expected)', "For every batted ball with fielder positioning, physics sets the chance an average college defender makes the play (distance to cover vs hang time for air balls; lateral range vs ball speed for grounders). OAE = outs actually made minus those chances, summed. Our version of Statcast's OAA, centered on your own data."],
    ['Star buckets', '5★ = under a 25% play, routine = 90%+. Same idea as the Savant catch-probability stars.'],
    ['In / Back / Left / Right', "OAE split by which way the fielder had to move (left = the first-base side, from the fielder's view)."],
    ['E vs Thru', 'E = reached the ball but the glove or throw failed (scored an error). Thru = the ball got past cleanly — that is range, not hands.'],
  ]],
  ['Catching', [
    ['SAE (Strikes Above Expected)', 'On taken pitches near the zone edge, a location model sets the expected called-strike rate, calibrated so your whole corpus nets zero. SAE is the strikes a catcher gained or lost versus that expectation. Framing runs = SAE x 0.125.'],
    ['Blended CS%', "Caught-stealing rate that mixes the catcher's pop-time expectation (worth about 15 attempts of evidence) with their ACTUAL season throw-out record. Arm runs price that blend against the corpus rate on real attempts."],
    ['Pop time', 'Catch to the moment the throw reaches second base. College average is about 2.10; sub-2.00 is elite.'],
  ]],
  ['Values page', [
    ['Offense', 'wRAA: season wOBA versus the division average, scaled by plate appearances.'],
    ['Pitching', 'Season FIP versus the division average, scaled by innings. RV (trk) beside it is the pitch-level run value from tracked sessions — same innings, two lenses.'],
    ['Position adjustment', 'WAR-style credit for premium spots (C, SS, CF...) scaled by playing time.'],
    ['Runs to wins', 'Rough rule: about 10 runs = 1 win in college ball. A +15 player is worth about a win and a half.'],
  ]],
]

export default function TrackmanGlossary() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <button onClick={() => setOpen(true)}
        className="text-[12px] font-semibold text-portal-purple dark:text-indigo-300 hover:underline whitespace-nowrap">
        ⓘ Stat glossary
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
          onClick={() => setOpen(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-2xl ring-1 ring-gray-200 dark:ring-gray-700 max-w-3xl w-full my-6 p-5"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">TrackMan Suite glossary</h2>
              <button onClick={() => setOpen(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none px-1">×</button>
            </div>
            <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
              {SECTIONS.map(([title, items]) => (
                <div key={title}>
                  <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">{title}</div>
                  <dl className="space-y-1.5">
                    {items.map(([term, def]) => (
                      <div key={term} className="text-[13px] leading-snug">
                        <dt className="font-bold text-gray-900 dark:text-gray-100 inline">{term}.</dt>{' '}
                        <dd className="text-gray-600 dark:text-gray-300 inline">{def}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
            <p className="text-[10.5px] text-gray-400 mt-3">
              Every model here compares players inside YOUR uploaded data (0 or 100 = average in this corpus),
              not against MLB numbers.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
