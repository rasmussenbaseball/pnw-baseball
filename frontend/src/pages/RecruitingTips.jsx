// Recruiting Tips — how recruiting works in the PNW + a data hook showing the
// average freshman line at each level (D1/D2/NAIA/D3/JUCO). Premium page in the
// Recruiting dropdown. Brand rule: no em-dashes in displayed copy.
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const LEVELS = {
  D1: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  D2: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  NAIA: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  D3: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
  JUCO: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
}
const LEVEL_LABEL = { D1: 'NCAA D1', D2: 'NCAA D2', NAIA: 'NAIA', D3: 'NCAA D3', JUCO: 'NWAC (JUCO)' }

function Card({ title, kicker, children }) {
  return (
    <section className="rounded-2xl bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 p-5 sm:p-6 mb-4">
      {kicker && <div className="text-[10px] font-bold uppercase tracking-widest text-nw-teal mb-1">{kicker}</div>}
      <h2 className="text-lg sm:text-xl font-black text-pnw-slate dark:text-gray-100 mb-3">{title}</h2>
      <div className="text-[14px] leading-relaxed text-gray-700 dark:text-gray-300 space-y-3">{children}</div>
    </section>
  )
}
const LI = ({ children }) => <li className="ml-4 list-disc marker:text-nw-teal">{children}</li>

function FreshmanByDivision() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        const { data: sess } = await supabase.auth.getSession()
        const token = sess?.session?.access_token
        const r = await fetch('/api/v1/recruiting/freshman-by-division?season=2026', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (!r.ok) throw new Error()
        const j = await r.json()
        if (!cancel) setData(j)
      } catch { if (!cancel) setErr(true) }
    })()
    return () => { cancel = true }
  }, [])

  const rows = data?.divisions || []
  const juco = rows.find(r => r.level === 'JUCO')
  const fmt = (v, d = 0) => (v == null ? '—' : Number(v).toFixed(d))

  return (
    <section className="rounded-2xl bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 p-5 sm:p-6 mb-4">
      <div className="text-[10px] font-bold uppercase tracking-widest text-nw-teal mb-1">By the numbers</div>
      <h2 className="text-lg sm:text-xl font-black text-pnw-slate dark:text-gray-100">Freshman production by level ({data?.season || 2026})</h2>
      <p className="text-[13px] text-gray-500 dark:text-gray-400 mt-1 mb-4">
        Where do PNW players land, and how much do they actually play as freshmen? This is the average first-year line at each level of PNW college baseball. Playing time (PA, IP) counts every freshman who appeared; rate stats (AVG, OPS, wRC+, ERA) use freshmen who got real reps.
      </p>
      {err ? (
        <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">Stats are unavailable right now.</div>
      ) : !data ? (
        <div className="text-sm text-gray-400 py-6 text-center">Loading…</div>
      ) : (
        <>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-[13px] tabular-nums">
              <thead>
                <tr className="text-gray-400 dark:text-gray-500 text-[11px] uppercase tracking-wide border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left py-2 pl-1 font-semibold">Level</th>
                  <th className="text-right px-2" title="Freshman hitters who appeared">Hitters</th>
                  <th className="text-right px-2">Avg PA</th>
                  <th className="text-right px-2">Avg AB</th>
                  <th className="text-right px-2">AVG</th>
                  <th className="text-right px-2">OPS</th>
                  <th className="text-right px-2" title="100 = league average">wRC+</th>
                  <th className="text-right px-2 border-l border-gray-200 dark:border-gray-700" title="Freshman pitchers who appeared">Pitchers</th>
                  <th className="text-right px-2">Avg IP</th>
                  <th className="text-right pr-1">ERA</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.level} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="py-2 pl-1"><span className={`text-[10px] font-bold px-2 py-0.5 rounded ${LEVELS[r.level] || ''}`}>{LEVEL_LABEL[r.level] || r.level}</span></td>
                    <td className="text-right px-2 font-semibold text-gray-800 dark:text-gray-100">{r.hitters}</td>
                    <td className="text-right px-2">{fmt(r.avg_pa, 1)}</td>
                    <td className="text-right px-2">{fmt(r.avg_ab, 1)}</td>
                    <td className="text-right px-2">{r.avg_avg == null ? '—' : Number(r.avg_avg).toFixed(3).replace(/^0/, '')}</td>
                    <td className="text-right px-2">{r.avg_ops == null ? '—' : Number(r.avg_ops).toFixed(3).replace(/^0/, '')}</td>
                    <td className="text-right px-2 font-semibold">{r.avg_wrc ?? '—'}</td>
                    <td className="text-right px-2 border-l border-gray-200 dark:border-gray-700 font-semibold text-gray-800 dark:text-gray-100">{r.pitchers}</td>
                    <td className="text-right px-2">{fmt(r.avg_ip, 1)}</td>
                    <td className="text-right pr-1">{fmt(r.avg_era, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {juco && (
            <div className="mt-4 text-[13px] rounded-lg bg-teal-50/70 dark:bg-teal-900/20 border-l-2 border-teal-300 dark:border-teal-700 px-3 py-2.5 text-gray-700 dark:text-gray-300">
              <span className="font-semibold">The opportunity gap:</span> {juco.hitters} NWAC freshmen took at-bats this year, many times more than any four-year level. If a freshman would sit behind upperclassmen at a four-year school, junior college is usually the fastest path to real reps, and the numbers above show it.
            </div>
          )}
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-3">
            Freshmen at four-year schools are identified by their true class from that year's roster. At the NWAC level (where class is not consistently published) a freshman is a player in their first season in our data. wRC+ of 100 equals the league average that year, so freshmen sitting below 100 is normal.
          </p>
        </>
      )}
    </section>
  )
}

const EMAIL_TEMPLATE = `Subject: 2027 RHP / OF | Lincoln HS (Portland, OR) | 88 mph, 3.7 GPA

Coach [Last Name],

My name is [Your Name], a 2027 right-handed pitcher and outfielder at
Lincoln HS in Portland, OR. I am very interested in [School] because
[one specific, genuine reason: your major, the program's development, a
conversation you had, the campus].

Measurables:
- 6'1", 185 lbs
- FB 86-88 mph, CB 72, CH 79
- OF velo 88 mph, 60 time 6.9
- 3.7 GPA, 1180 SAT

2026 stats (junior year): .340 / .420 / .510, 22 K in 31 IP, 1.90 ERA

Video (clear, multiple angles): [link]
PBR / Baseball Northwest profile: [link]

I would love the chance to get on campus or talk more. My summer schedule
is attached. Thank you for your time.

[Your Name]
[Phone] | [Email] | [Grad year]`

export default function RecruitingTips() {
  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 py-6">
      <div className="text-center mb-5">
        <div className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-nw-teal bg-teal-50 dark:bg-teal-900/30 px-3 py-1 rounded-full mb-2">
          Recruiting Tips
        </div>
        <h1 className="text-3xl sm:text-4xl font-black text-pnw-slate dark:text-gray-100 leading-tight">How to get recruited</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 max-w-xl mx-auto">
          A straight-talk guide to how college baseball recruiting really works in the Pacific Northwest, plus the data on where players land and how much they play.
        </p>
      </div>

      <FreshmanByDivision />

      <Card kicker="Start here" title="How recruiting actually works">
        <p>Almost nobody gets "found." Outside of the very top D1 prospects, recruiting is something you go do, not something that happens to you. The player and family drive it: you build a profile, you reach out, you get in front of coaches. Coaches are busy and have limited spots, so the ones who hear from you, with the right information, get the look.</p>
        <p>Start as early as your sophomore or junior year, but understand it is never too late. Players commit late every cycle, especially at the D2, D3, NAIA, and JUCO levels where most PNW kids end up. Be realistic about your level (the table above is a good gut-check) and cast a wide, honest net.</p>
      </Card>

      <Card kicker="The most important step" title="Reaching out to coaches">
        <p>Go to the team's website and look for a <span className="font-semibold">recruiting coordinator</span> on the staff page. That is the person whose job is to read your email. If a team does not list a recruiting coordinator, email the <span className="font-semibold">head coach</span> directly. A short, specific, personalized email beats a long one every time.</p>
        <p className="font-semibold text-gray-800 dark:text-gray-200">A strong intro email has:</p>
        <ul className="space-y-1">
          <LI>Who you are: grad year, position(s), high school, hometown, club/travel team</LI>
          <LI>Measurables (see the next section)</LI>
          <LI>A few relevant stats from your most recent season</LI>
          <LI>Academics: GPA and test scores (huge at D3 and for aid everywhere)</LI>
          <LI>A clear video link and your PBR or Baseball Northwest profile</LI>
          <LI>One genuine, specific reason you are interested in THAT school</LI>
        </ul>
        <div className="rounded-lg bg-gray-900 text-gray-100 text-[12px] leading-relaxed p-4 overflow-x-auto whitespace-pre-wrap font-mono">{EMAIL_TEMPLATE}</div>
        <p className="text-[13px]"><span className="font-semibold">Do not mass-blast.</span> Sending the same generic email to 200 schools is obvious and gets ignored. Personalize each one, even a little. And do not over-expose yourself: chasing every camp, every showcase, and every paid service rarely helps and burns time and money. Be intentional.</p>
      </Card>

      <Card kicker="Have these ready" title="Measurables coaches want">
        <p>Coaches need numbers to evaluate you. Have these current and honest:</p>
        <ul className="space-y-1">
          <LI><span className="font-semibold">Position players:</span> height/weight, 60-yard dash, exit velocity, infield/outfield throwing velocity, and pop time for catchers</LI>
          <LI><span className="font-semibold">Pitchers:</span> fastball velocity (and whether it is trending up), off-speed pitches and velos, strike-throwing ability</LI>
          <LI><span className="font-semibold">Everyone:</span> recent stats, GPA and test scores, and projectability (frame, age, room to grow)</LI>
        </ul>
        <p>Video is your resume. Film from <span className="font-semibold">multiple clear angles</span>: hitting from the side and the open side, throwing/defense, and pitchers from behind and from the side of the mound. Keep it short and high quality. Do NOT send GameChanger or grainy stands footage as your primary video. If a coach has to squint, they move on.</p>
      </Card>

      <Card kicker="In person" title="Camps and showcases">
        <p>The highest-value camp is one run by a school you are genuinely interested in. A coach seeing you in person at their own camp is worth far more than a name on a showcase roster. Pick a few targeted camps over a dozen random ones.</p>
        <p>Showcases like PBR (Prep Baseball Report) and regional events are useful for getting verified data (velo, exit velo, 60 time) and a profile coaches trust. Get the data, build the profile, then use it in your outreach. You do not need to attend everything.</p>
      </Card>

      <Card kicker="The edge" title="What coaches want, and how to stand out">
        <p>Tools get you looked at; makeup gets you recruited. Beyond the measurables, coaches are watching how you carry yourself: hustle, body language, how you treat teammates and umpires, and whether you compete. Academics matter everywhere and are often the difference in the money you get, especially below D1.</p>
        <p>Stand out by being easy to recruit: respond quickly and professionally, follow up after camps, send updated video and stats, and be coachable. A player who communicates well and clearly wants to be there beats a slightly more talented player who is a hassle.</p>
      </Card>

      <Card kicker="Know the landscape" title="The PNW path right now">
        <ul className="space-y-1.5">
          <LI><span className="font-semibold">The D1 roster squeeze.</span> New D1 roster limits (a 34-man cap) and the shift to more scholarships across fewer spots mean D1 rosters are tighter than ever. Many players who would have ridden a D1 bench are choosing to play elsewhere.</LI>
          <LI><span className="font-semibold">The JUCO boom.</span> As the table at the top shows, the NWAC is where the most freshmen actually play. Two years of real at-bats and innings, then transfer up with a track record, is one of the best paths in the region. Plenty of NWAC players move on to D1, D2, and NAIA programs.</LI>
          <LI><span className="font-semibold">5 for 5.</span> JUCO gives you up to two years to develop, get bigger and stronger, and put up numbers before your four-year clock really matters. Use it.</LI>
          <LI><span className="font-semibold">Fit over level.</span> The "highest" level is not always the best fit. Playing time, development, coaching, academics, cost, and where you will be happy all matter more than a logo.</LI>
        </ul>
        <p className="text-[13px]">Use the <Link to="/recruiting/quiz" className="text-nw-teal font-semibold hover:underline">Recruit Matchmaker</Link> to find programs that fit you, and the <Link to="/recruiting/guide" className="text-nw-teal font-semibold hover:underline">Recruiting Guide</Link> and <Link to="/recruiting/program-guide" className="text-nw-teal font-semibold hover:underline">Program Guide</Link> to research every PNW program in depth.</p>
      </Card>
    </div>
  )
}
