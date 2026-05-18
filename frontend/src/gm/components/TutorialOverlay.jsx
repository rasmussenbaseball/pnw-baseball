/**
 * TutorialOverlay — a skippable slideshow that runs the first time the user
 * loads a new dynasty, and is re-openable from the Extras nav at any time.
 *
 * Each slide is a self-contained piece of context covering one game system.
 * The user can advance with arrow keys / Next button, or skip to the end.
 * Persistence: state.flags.tutorialSeen = true once dismissed (saved via
 * the parent component's saveDynasty call).
 */

import { useEffect, useState } from 'react'

// Level-specific bits used inside the slide content.
const LEVEL_DETAILS = {
  D1:   { rosterCap: 40, champName: 'College World Series (CWS)', champLocation: 'Charles Schwab Field, Omaha NE',  divName: 'NCAA D1' },
  D2:   { rosterCap: 40, champName: 'D2 World Series',            champLocation: 'USA Baseball NTC, Cary NC',         divName: 'NCAA D2' },
  D3:   { rosterCap: 40, champName: 'D3 World Series',            champLocation: 'Veterans Memorial Stadium, Cedar Rapids IA', divName: 'NCAA D3' },
  NAIA: { rosterCap: 50, champName: 'Avista NAIA World Series',   champLocation: 'Harris Field, Lewiston ID',         divName: 'NAIA' },
  NWAC: { rosterCap: 30, champName: 'NWAC Championship',          champLocation: 'Longview WA',                       divName: 'NWAC (JUCO)' },
}

function buildSlides(level = 'NAIA') {
  const L = LEVEL_DETAILS[level] || LEVEL_DETAILS.NAIA
  return [
  {
    title: 'Welcome to PNW Coach Simulator',
    body: (
      <>
        <p>You're the head coach of a Pacific Northwest college baseball program. Your job is to recruit, develop, win games, and stay employed long enough to build a contender.</p>
        <p className="mt-3">The game runs week-by-week across a 52-week year. Sim one week at a time, or sim ahead with presets when you have nothing pressing to do. Every decision compounds.</p>
      </>
    ),
  },
  {
    title: 'The 52-week year',
    body: (
      <>
        <p>The dynasty year starts <strong>August 1</strong> and runs through the next July 31. Each week falls into one of seven distinct PERIODS, each with its own rules:</p>
        <ul className="mt-3 space-y-1 text-sm list-disc list-inside">
          <li><strong>Late Summer</strong> (Aug) — setup: schedule, hire staff, set budget, open scouting</li>
          <li><strong>Fall Camp</strong> (Sep–Oct) — practice + scrimmages, players develop normally</li>
          <li><strong>November</strong> — conditioning only. Players still improve, but at half speed</li>
          <li><strong>December</strong> — dead period. No practice, no conditioning, <strong>no improvement</strong></li>
          <li><strong>January</strong> — winter practice ramp before the season</li>
          <li><strong>Spring Season</strong> (Feb–Apr) — non-conference + conference play</li>
          <li><strong>Postseason</strong> (May) — conf tournament → opening round → World Series</li>
          <li><strong>Summer Recruiting</strong> (Jun–Jul) — portal, MLB draft, class finalize</li>
        </ul>
        <p className="mt-3 text-sm text-gray-300">The home page color-codes the current period and pops a notification when you cross into a new one.</p>
      </>
    ),
  },
  {
    title: 'Action Points (AP)',
    body: (
      <>
        <p>You get a weekly allowance of <strong>Action Points</strong> — typically 20-50 per week, driven by your coaching staff's ratings. AP is the currency for almost every decision:</p>
        <ul className="mt-3 space-y-1 text-sm list-disc list-inside">
          <li>Recruiting actions (Text=1, Call=1, Scout Trip=4, Home Visit=5, Campus Visit=6)</li>
          <li>Weekly team boosts (practice drills, position work)</li>
          <li>1-on-1 development (8 AP per session for a +3 rating bump)</li>
          <li>Study Hall (2 AP for a GPA boost)</li>
          <li>Fundraising (10 AP for ~$8K-11K to add to your budget)</li>
        </ul>
        <p className="mt-3 text-sm text-gray-300"><strong>AP does NOT carry over.</strong> Unused AP at week's end is lost. The Dashboard will warn you if you advance with unspent AP.</p>
      </>
    ),
  },
  {
    title: 'Required actions (Wks 1-4 + Wk 13)',
    body: (
      <>
        <p>A few weeks have a <strong>required action</strong> that hard-blocks sim until you complete it:</p>
        <ul className="mt-3 space-y-1 text-sm list-disc list-inside">
          <li><strong>Wk 1</strong> — Set your schedule (non-conference weekends)</li>
          <li><strong>Wk 2</strong> — Hire assistant coaches (pitching / hitting / bench)</li>
          <li><strong>Wk 3</strong> — Lock your annual budget</li>
          <li><strong>Wk 4</strong> — Open scouting + spend all AP on your recruit board</li>
          <li><strong>Wk 13</strong> — Run the annual Prospect Camp</li>
          <li><strong>Wk 52</strong> — Mandatory cuts (only if you're over the {L.rosterCap}-player roster cap)</li>
        </ul>
        <p className="mt-3 text-sm text-gray-300">If you don't want to manage these by hand, turn on <strong>Auto mode</strong> from the hero header. Auto handles every required action plus weekly AP for you.</p>
      </>
    ),
  },
  {
    title: 'Player development',
    body: (
      <>
        <p>Players improve in four distinct ways. Knowing how each works lets you set up your year intentionally:</p>
        <ul className="mt-3 space-y-2 text-sm">
          <li><strong className="text-emerald-300">Fall scrimmages (Sep-Oct)</strong> — every player in your lineup for a fall scrimmage gets a chance at a small rating bump. The more games they play, the more chances. Fall scrimmages also sharpen the team for the spring.</li>
          <li><strong className="text-emerald-300">In-season weekly dev (Spring)</strong> — players who put up real stats get rating bumps. Better stats = bigger bumps. Stamina also factors in for pitchers.</li>
          <li><strong className="text-emerald-300">Offseason practice (Fall Camp / Winter Practice)</strong> — passive small bumps every week. Half rate in November (conditioning only). Zero in December and Summer.</li>
          <li><strong className="text-emerald-300">Summer ball</strong> — sending a player to a summer league (Cape Cod, Northwoods, etc.) develops them aggressively over the summer. Top leagues develop faster but are harder to get into.</li>
        </ul>
        <p className="mt-3 text-sm text-gray-300">Players have a <strong>hidden potential</strong> per stat. They can't grow past it without their potential drifting (which it does based on real performance + your scouting). High potential = faster growth from every dev source above.</p>
      </>
    ),
  },
  {
    title: 'Player ratings',
    body: (
      <>
        <p>Each player has a 0–99 rating per skill plus physical measurables:</p>
        <ul className="mt-3 space-y-1 text-sm list-disc list-inside">
          <li><strong>Hitters</strong> — contact_L/R, power_L/R, discipline, speed, fielding, arm, composure, durability</li>
          <li><strong>Pitchers</strong> — stuff (pitch shape), control, command, stamina, vs_L/R, composure, durability</li>
          <li><strong>Measurables</strong> — height, weight, 60-yard time, max exit velocity, pop time (C), <strong>FB velocity</strong> (P)</li>
        </ul>
        <p className="mt-3"><strong>Stuff and velocity are independent.</strong> A pitcher can have great stuff (movement) at 85 mph, or weak stuff at 95 mph. Velocity actually drives more strikeouts and less hard contact in the sim.</p>
        <p className="mt-3 text-sm text-gray-300">Hitters also have <strong>L/R splits</strong> — most are stronger against opposite-handed pitching, but ~12% are reverse-split (rare but real).</p>
      </>
    ),
  },
  {
    title: 'Recruiting',
    body: (
      <>
        <p>Recruits come from three pools: HS seniors, JUCO transfers, and 4-year transfer portal (D1/D2/D3 + NAIA). Each pool refreshes annually.</p>
        <p className="mt-3">Recruiting is a multi-step funnel:</p>
        <ul className="mt-3 space-y-1 text-sm list-disc list-inside">
          <li><strong>Scout</strong> with AP actions to clarify ratings (fog reduces with each action)</li>
          <li><strong>Build interest</strong> with calls, visits, assistants</li>
          <li><strong>Extend a scholarship offer</strong> (uses $ from your scholarship pool, not AP)</li>
          <li><strong>Win them over</strong> — they evaluate your offer + 7 other preferences (proximity, playing time, coaching, etc.)</li>
          <li><strong>Sign</strong> — they commit and join your roster Wk 52</li>
        </ul>
        <p className="mt-3 text-sm text-gray-300"><strong>Prospect Camp</strong> in Wk 13 is the year's biggest recruiting lever. Invite top targets in Wks 5 & 10. Attendance dramatically reduces scouting fog + bumps interest.</p>
      </>
    ),
  },
  {
    title: 'Academics — the GPA cliff',
    body: (
      <>
        <p>Every player has a <strong>GPA</strong> that ticks weekly during semesters (Wks 5-18 Fall, Wks 23-42 Spring). End-of-term, GPA gets a final update.</p>
        <p className="mt-3"><strong>Eligibility rules:</strong></p>
        <ul className="mt-3 space-y-1 text-sm list-disc list-inside">
          <li>GPA ≥ 2.25 → eligible</li>
          <li>GPA 2.00–2.24 → probation (still eligible, warning)</li>
          <li>GPA &lt; 2.00 → ineligible (can't play next semester)</li>
          <li>2 consecutive sub-2.0 semesters → dismissed (auto-cut from roster)</li>
        </ul>
        <p className="mt-3"><strong>Study Hall</strong> in Weekly Actions is your main GPA lever. Each week stacks a small permanent boost on every player's end-of-term GPA. Open the new <strong>Academics page</strong> from the Stats nav to see who's at risk.</p>
      </>
    ),
  },
  {
    title: 'Budget + coaching staff',
    body: (
      <>
        <p>Your annual budget gets divided into 8 categories. Travel is locked from your schedule; you allocate the rest.</p>
        <p className="mt-3"><strong>Heaviest levers:</strong></p>
        <ul className="mt-3 space-y-1 text-sm list-disc list-inside">
          <li><strong>Scholarships</strong> (~55%) — the pool you offer to recruits</li>
          <li><strong>Coaching salaries</strong> (~18%) — what you pay your staff</li>
          <li><strong>Facilities + S&C + Medical</strong> — passive dev boosts + injury reduction</li>
          <li><strong>Recruiting</strong> — travel + camp costs</li>
        </ul>
        <p className="mt-3"><strong>Coaches</strong> drive your weekly AP. Strong staffs push you near the 50 AP cap; weak ones stay closer to 20. Coach ratings (developer / motivator / recruiter / tactician) also affect skill dev, happiness, recruit fit scores, and in-game decisions.</p>
      </>
    ),
  },
  {
    title: 'Auto mode (optional)',
    body: (
      <>
        <p>If you'd rather watch the season unfold than manage every weekly micro-decision, hit the <strong>AUTO</strong> button in the hero header.</p>
        <p className="mt-3">Auto mode handles:</p>
        <ul className="mt-3 space-y-1 text-sm list-disc list-inside">
          <li>All required actions (schedule, hire, budget, scout, prospect camp, mandatory cuts)</li>
          <li>Weekly AP allocation — smart picks across study hall, recruiting, fundraising</li>
          <li>Prospect-camp invites in Wks 5 & 10</li>
          <li>Recruiting actions on your top targets each week</li>
        </ul>
        <p className="mt-3 text-sm text-gray-300">You can flip between AUTO and MANUAL at any time. Auto plays the games for you only if you choose Sim Games when the game-week modal pops; you can still play games yourself when you want.</p>
      </>
    ),
  },
  {
    title: 'Winning the dynasty',
    body: (
      <>
        <p>The trophy ladder for {L.divName}:</p>
        <ul className="mt-3 space-y-1 text-sm list-disc list-inside">
          <li><strong>Conference Tournament</strong> (Wk 40) — winner gets the auto-bid to the national bracket.</li>
          <li><strong>Regional / Opening Round</strong> (Wk 41) — multi-team site bracket. Winner advances.</li>
          <li><strong>{L.champName}</strong> (Wk 42+) — {L.champLocation}. Win it and you've built a national contender.</li>
        </ul>
        <p className="mt-3"><strong>Job security</strong> is your long-game stat. Lose seasons, run a bad GPA, over-recruit past {L.rosterCap} — it drops. Develop pros, win banners, keep grades up — it climbs. Drop below ~20 and the AD may move on from you.</p>
        <p className="mt-3 text-sm text-gray-300">You can reopen this tutorial any time from <strong>Extras → Tutorial</strong>.</p>
      </>
    ),
  },
  ]
}

export default function TutorialOverlay({ onClose, school, level }) {
  const [idx, setIdx] = useState(0)
  const SLIDES = buildSlides(level || school?.level || 'NAIA')
  const slide = SLIDES[idx]

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'ArrowRight') setIdx(i => Math.min(SLIDES.length - 1, i + 1))
      else if (e.key === 'ArrowLeft') setIdx(i => Math.max(0, i - 1))
      else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const accent = school?.colors?.[0] || '#fbbf24'
  const isLast = idx === SLIDES.length - 1

  return (
    <div className="fixed inset-0 bg-black/80 z-[100] flex items-center justify-center px-4 py-8">
      <div className="max-w-2xl w-full bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded-2xl shadow-2xl overflow-hidden">
        {/* Progress strip */}
        <div className="flex gap-1 p-3 bg-[#23233d]">
          {SLIDES.map((_, i) => (
            <div
              key={i}
              className="flex-1 h-1.5 rounded transition"
              style={{ backgroundColor: i <= idx ? accent : '#3a3a5e' }}
            />
          ))}
        </div>

        {/* Slide */}
        <div className="p-6 text-[#e8e8e8] min-h-[360px]">
          <div className="text-[10px] uppercase tracking-widest text-[#a8a8c8] font-bold mb-1">
            {idx + 1} of {SLIDES.length} · Tutorial
          </div>
          <h2 className="font-pixel-display text-xl tracking-widest text-white mb-4" style={{ color: accent }}>
            {slide.title}
          </h2>
          <div className="text-base font-pixel leading-relaxed">
            {slide.body}
          </div>
        </div>

        {/* Footer controls */}
        <div className="flex items-center justify-between p-4 bg-[#23233d] border-t border-[#3a3a5e]">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-[#a8a8c8] hover:text-white underline-offset-4 hover:underline"
          >
            Skip tutorial
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setIdx(i => Math.max(0, i - 1))}
              disabled={idx === 0}
              className="px-4 py-2 bg-[#3a3a5e] text-white rounded text-sm font-bold uppercase tracking-wider disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#4a4a6e]"
            >
              Back
            </button>
            {isLast ? (
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2 text-[#1a1a2e] rounded text-sm font-bold uppercase tracking-wider hover:opacity-90"
                style={{ backgroundColor: accent }}
              >
                Start playing
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIdx(i => Math.min(SLIDES.length - 1, i + 1))}
                className="px-5 py-2 text-[#1a1a2e] rounded text-sm font-bold uppercase tracking-wider hover:opacity-90"
                style={{ backgroundColor: accent }}
              >
                Next →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
