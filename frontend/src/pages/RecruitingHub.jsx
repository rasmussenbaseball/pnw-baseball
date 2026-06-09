// Recruiting Hub — the public, all-tiers landing page for the Recruiting tab.
// This is the page Nate sends to prospective subscribers: it explains every
// recruiting tool on the site, who each one is for, and what unlocks it, then
// funnels to the Matchmaker and the pricing page. It is intentionally NOT gated
// (open to anonymous + every tier) so it can do its job as the top of the funnel.
// The tools it links to ARE gated; clicking one while signed out shows the upsell.
// Brand rule: no em-dashes in displayed copy.
import { Link } from 'react-router-dom'

// ── tiny inline line icons (stroke = currentColor) ────────────────
const ic = (paths) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">{paths}</svg>
)
const ICONS = {
  target: ic(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" /></>),
  book: ic(<><path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z" /><path d="M8 3v18" /></>),
  pdf: ic(<><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /><path d="M10 13h4M10 17h4" /></>),
  bulb: ic(<><path d="M9 18h6" /><path d="M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" /></>),
  chart: ic(<><path d="M4 20V4" /><path d="M4 20h16" /><rect x="7" y="11" width="3" height="6" /><rect x="12" y="7" width="3" height="10" /><rect x="17" y="13" width="3" height="4" /></>),
  pin: ic(<><path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></>),
  map: ic(<><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z" /><path d="M9 4v14M15 6v14" /></>),
  users: ic(<><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 6a3 3 0 0 1 0 6M21 20a6 6 0 0 0-5-5.9" /></>),
  swap: ic(<><path d="M4 8h13l-3-3M20 16H7l3 3" /></>),
  portal: ic(<><path d="M7 4 3 8l4 4" /><path d="M3 8h13a5 5 0 0 1 0 10h-3" /></>),
  check: ic(<><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>),
}

// ── tools (recruit-facing unlock at Premium $5/mo) ────────────────
const RECRUIT_TOOLS = [
  { to: '/recruiting/quiz', icon: 'target', tier: 'premium', name: 'Recruit Matchmaker',
    blurb: 'Answer a handful of honest questions about your level, academics, budget, and what you want out of college, and get your best-fit PNW programs ranked.',
    why: 'Set hard dealbreakers (cost, division, distance) and the list rebuilds around them, so you only see schools that actually make sense for you.' },
  { to: '/recruiting/guide', icon: 'book', tier: 'premium', name: 'Recruiting Guide',
    blurb: 'A complete profile on all 57 PNW programs: coaching staff and contacts, academics, cost and aid, facilities, campus and location, plus on-field analytics.',
    why: 'The off-field research that usually takes weeks of digging through 57 different athletic sites, gathered and kept current in one place.' },
  { to: '/recruiting/program-guide', icon: 'pdf', tier: 'premium', name: 'Program Guide (book)',
    blurb: 'The entire program guide as a clean, page-by-page book covering every Pacific Northwest college baseball program.',
    why: 'Read it like a recruiting handbook. One document, every program, no jumping between tabs.' },
  { to: '/recruiting/tips', icon: 'bulb', tier: 'premium', name: 'Recruiting Tips',
    blurb: 'A straight-talk guide to how recruiting really works: how to reach coaches, a copy-paste email template, video and measurables advice, camps, and showcases.',
    why: 'Paired with freshman production by level, so you can see how much players actually play as freshmen at D1, D2, NAIA, D3, and the NWAC before you choose a level.' },
  { to: '/recruiting/breakdown', icon: 'chart', tier: 'premium', name: 'Recruiting Breakdown',
    blurb: 'Team-level recruiting metrics and trends: how programs build their rosters, where their production comes from, and how much they lean on transfers.',
    why: 'Know whether a program develops freshmen or reloads through the portal before you commit four years to it.' },
  { to: '/recruiting/hometown', icon: 'pin', tier: 'premium', name: 'Hometown Search',
    blurb: 'Search for players by hometown to see which PNW programs recruit your area, and which players from your city have gone where.',
    why: 'Recruiting pipelines are real. Find the programs that already trust players from where you are from.' },
  { to: '/recruiting/map', icon: 'map', tier: 'premium', name: 'Program Map',
    blurb: 'Every PNW college baseball program on one map, by division.',
    why: 'See your options by geography and figure out how far from home you are willing to go.' },
  { to: '/recruiting-classes', icon: 'users', tier: 'soon', name: 'Recruiting Classes',
    blurb: 'Incoming class breakdowns for PNW programs.',
    why: 'Coming soon: see who each program is bringing in and how your class stacks up.' },
]

// ── tools (coach-facing unlock at Recruiting $10/mo) ──────────────
const COACH_TOOLS = [
  { to: '/coaching/juco-tracker', icon: 'swap', tier: 'recruiting', name: 'JUCO Tracker',
    blurb: 'NWAC players who are available to move up to a four-year program, with the stats to evaluate them.',
    why: 'A live board of junior college transfer targets across the Pacific Northwest.' },
  { to: '/coaching/transfer-portal', icon: 'portal', tier: 'recruiting', name: 'Transfer Portal Tracker',
    blurb: 'PNW four-year players who have entered the transfer portal, split by hitters and pitchers, with commitments noted.',
    why: 'Track who is on the move and where they land, without refreshing a dozen Twitter accounts.' },
  { to: '/news/commitments', icon: 'check', tier: 'recruiting', name: 'Commitments',
    blurb: 'A running list of new commitments, starting with NWAC players committing to four-year programs.',
    why: 'Stay on top of who is coming and going across the region as it happens.' },
]

const TIER_PILL = {
  premium: { label: 'Premium', cls: 'bg-teal-50 text-nw-teal dark:bg-teal-900/30 dark:text-teal-300' },
  recruiting: { label: 'Recruiting plan', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  soon: { label: 'Coming soon', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' },
}

function ToolCard({ tool }) {
  const pill = TIER_PILL[tool.tier]
  const soon = tool.tier === 'soon'
  const Inner = (
    <>
      <div className="flex items-start justify-between gap-3 mb-2">
        <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-teal-50 text-nw-teal dark:bg-teal-900/30 dark:text-teal-300 shrink-0">
          {ICONS[tool.icon]}
        </span>
        <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${pill.cls}`}>{pill.label}</span>
      </div>
      <h3 className="text-base font-extrabold text-pnw-slate dark:text-gray-100 flex items-center gap-1.5">
        {tool.name}
        {!soon && <span className="text-nw-teal text-sm transition-transform group-hover:translate-x-0.5">&rsaquo;</span>}
      </h3>
      <p className="mt-1 text-[13px] leading-relaxed text-gray-600 dark:text-gray-400">{tool.blurb}</p>
      <p className="mt-2 text-[12.5px] leading-relaxed text-gray-500 dark:text-gray-500 border-l-2 border-teal-200 dark:border-teal-800 pl-2.5">{tool.why}</p>
    </>
  )
  const base = 'group block rounded-2xl bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 p-5 transition-all'
  if (soon) return <div className={`${base} opacity-80`}>{Inner}</div>
  return <Link to={tool.to} className={`${base} hover:ring-nw-teal hover:shadow-lg hover:-translate-y-0.5`}>{Inner}</Link>
}

function Stat({ big, label }) {
  return (
    <div className="text-center px-3">
      <div className="text-2xl sm:text-3xl font-black text-nw-teal">{big}</div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 mt-0.5">{label}</div>
    </div>
  )
}

function PlanCard({ name, price, per, note, points, highlight, cta, to }) {
  return (
    <div className={`rounded-2xl p-5 ring-1 ${highlight ? 'ring-2 ring-nw-teal bg-teal-50/40 dark:bg-teal-900/20' : 'ring-gray-200 dark:ring-gray-700 bg-white dark:bg-gray-800'}`}>
      <div className="flex items-baseline justify-between">
        <h3 className="text-lg font-black text-pnw-slate dark:text-gray-100">{name}</h3>
        {highlight && <span className="text-[10px] font-bold uppercase tracking-wide text-nw-teal bg-white dark:bg-gray-900 px-2 py-0.5 rounded-full">Best for recruits</span>}
      </div>
      <div className="mt-1 mb-1">
        <span className="text-3xl font-black text-pnw-slate dark:text-gray-100">${price}</span>
        <span className="text-sm text-gray-500 dark:text-gray-400">/{per}</span>
      </div>
      {note && <p className="text-[12px] text-gray-500 dark:text-gray-400 mb-3">{note}</p>}
      <ul className="space-y-1.5 mb-4">
        {points.map((p, i) => (
          <li key={i} className="flex gap-2 text-[13px] text-gray-700 dark:text-gray-300">
            <span className="text-nw-teal mt-0.5">{ICONS.check}</span><span>{p}</span>
          </li>
        ))}
      </ul>
      <Link to={to} className={`block text-center text-sm font-bold rounded-lg py-2.5 transition-colors ${highlight ? 'bg-nw-teal text-white hover:bg-teal-700' : 'border border-nw-teal text-nw-teal hover:bg-teal-50 dark:hover:bg-teal-900/30'}`}>{cta}</Link>
    </div>
  )
}

export default function RecruitingHub() {
  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-4 py-6">

      {/* Hero */}
      <section className="text-center rounded-3xl bg-gradient-to-b from-teal-50 to-white dark:from-teal-900/20 dark:to-gray-900 ring-1 ring-gray-200 dark:ring-gray-700 px-5 py-10 sm:py-14 mb-8">
        <div className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-nw-teal bg-white dark:bg-gray-900 px-3 py-1 rounded-full mb-3 ring-1 ring-teal-100 dark:ring-teal-800">
          Pacific Northwest College Baseball
        </div>
        <h1 className="text-3xl sm:text-5xl font-black text-pnw-slate dark:text-gray-100 leading-tight max-w-3xl mx-auto">
          The clearest path to playing college baseball in the Northwest
        </h1>
        <p className="mt-4 text-base sm:text-lg text-gray-600 dark:text-gray-300 max-w-2xl mx-auto leading-relaxed">
          The most complete recruiting research on PNW college baseball. Every program from Division I to the NWAC, profiled in depth, paired with the stats coaches actually use. Find where you fit, learn how to get recruited, and stop guessing.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link to="/recruiting/quiz" className="px-5 py-2.5 rounded-lg bg-nw-teal text-white text-sm font-bold hover:bg-teal-700 transition-colors">
            Find your best-fit programs
          </Link>
          <Link to="/pricing" className="px-5 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 text-sm font-bold hover:border-nw-teal hover:text-nw-teal transition-colors">
            See plans and pricing
          </Link>
        </div>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-y-4 divide-x divide-gray-200 dark:divide-gray-700">
          <Stat big="57" label="PNW programs" />
          <Stat big="5" label="levels, D1 to NWAC" />
          <Stat big="Every" label="player tracked" />
          <Stat big="Live" label="updated all season" />
        </div>
      </section>

      {/* Why */}
      <section className="mb-10">
        <div className="grid sm:grid-cols-3 gap-4">
          {[
            { t: 'Know every program', d: 'Coaching, academics, cost, aid, facilities, and on-field data on all 57 PNW schools, in one consistent format.' },
            { t: 'See where you fit', d: 'Match your level, budget, and goals to real programs instead of guessing from a logo and a campus visit.' },
            { t: 'Use the real numbers', d: 'The same advanced stats analysts and coaches use, from wRC+ and FIP to freshman playing time by level.' },
          ].map((v) => (
            <div key={v.t} className="rounded-2xl bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 p-5">
              <h3 className="font-extrabold text-pnw-slate dark:text-gray-100">{v.t}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-gray-600 dark:text-gray-400">{v.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Recruit tools */}
      <section className="mb-10">
        <div className="text-[10px] font-bold uppercase tracking-widest text-nw-teal mb-1">For recruits and families</div>
        <h2 className="text-xl sm:text-2xl font-black text-pnw-slate dark:text-gray-100">Everything you need to get recruited</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 mb-5">These tools unlock with Premium. Click any one to open it.</p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {RECRUIT_TOOLS.map((t) => <ToolCard key={t.name} tool={t} />)}
        </div>
      </section>

      {/* Coach tools */}
      <section className="mb-10">
        <div className="text-[10px] font-bold uppercase tracking-widest text-amber-600 dark:text-amber-400 mb-1">For coaches and recruiters</div>
        <h2 className="text-xl sm:text-2xl font-black text-pnw-slate dark:text-gray-100">Recruit smarter, with live boards</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 mb-5">These tools unlock with the Recruiting plan.</p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {COACH_TOOLS.map((t) => <ToolCard key={t.name} tool={t} />)}
        </div>
      </section>

      {/* Why our data is different */}
      <section className="rounded-2xl bg-pnw-slate dark:bg-gray-800 text-white ring-1 ring-gray-700 p-6 sm:p-8 mb-10">
        <h2 className="text-xl sm:text-2xl font-black">Why this is different from a spreadsheet</h2>
        <p className="mt-2 text-[14px] text-gray-200 dark:text-gray-300 max-w-2xl leading-relaxed">
          Most recruiting advice is generic and most program lists are out of date. This is built on a live database of Pacific Northwest college baseball, the only one of its kind.
        </p>
        <div className="mt-5 grid sm:grid-cols-2 gap-x-8 gap-y-3">
          {[
            'All 57 programs across five levels: D1, D2, D3, NAIA, and the NWAC',
            'Advanced metrics on every player: wRC+, FIP, WAR, and percentile rankings',
            'Freshman production by level, so you know how much players really play',
            'Transfer portal and JUCO transfer tracking, updated continuously',
            'Coaching staff, academics, cost, aid, and facilities for every school',
            'Real records and rosters, not a static guide that ages out',
          ].map((p) => (
            <div key={p} className="flex gap-2 text-[13.5px] text-gray-100">
              <span className="text-teal-300 mt-0.5 shrink-0">{ICONS.check}</span><span>{p}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Who it's for */}
      <section className="mb-10">
        <h2 className="text-xl sm:text-2xl font-black text-pnw-slate dark:text-gray-100 mb-4">Who it is for</h2>
        <div className="grid sm:grid-cols-3 gap-4">
          {[
            { t: 'Recruits and parents', d: 'High school and JUCO players, and the families helping them, who want a clear, honest read on their options and a real plan to reach coaches.' },
            { t: 'Transfers', d: 'Players in or considering the portal who want to know which PNW programs fit and how each one builds its roster.' },
            { t: 'Coaches and recruiters', d: 'College staffs who need a live view of NWAC and portal talent and the data to evaluate it quickly.' },
          ].map((w) => (
            <div key={w.t} className="rounded-2xl bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700 p-5">
              <h3 className="font-extrabold text-pnw-slate dark:text-gray-100">{w.t}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-gray-600 dark:text-gray-400">{w.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Plans */}
      <section className="mb-10">
        <div className="text-center mb-5">
          <h2 className="text-xl sm:text-2xl font-black text-pnw-slate dark:text-gray-100">Pick a plan and get started</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Cancel anytime. See the <Link to="/pricing" className="text-nw-teal font-semibold hover:underline">full plan comparison</Link> for everything included.</p>
        </div>
        <div className="grid sm:grid-cols-2 gap-4 max-w-3xl mx-auto">
          <PlanCard
            name="Premium" price="5" per="mo" highlight
            note="Or $50/year. 7-day free trial on monthly."
            cta="Start with Premium" to="/pricing"
            points={[
              'Recruit Matchmaker, Recruiting Guide, and the program book',
              'Recruiting Tips, Breakdown, Hometown Search, and Map',
              'Plus the full site: player pages, advanced stats, and the coaching sim',
            ]}
          />
          <PlanCard
            name="Recruiting" price="10" per="mo"
            note="Or $100/year. Built for college coaches and recruiters."
            cta="Go with Recruiting" to="/pricing"
            points={[
              'Everything in Premium',
              'JUCO Tracker and Transfer Portal Tracker',
              'Commitments tracker and advanced discipline stats',
            ]}
          />
        </div>
      </section>

      {/* Final CTA */}
      <section className="text-center rounded-2xl bg-teal-50 dark:bg-teal-900/20 ring-1 ring-teal-100 dark:ring-teal-800 px-5 py-8">
        <h2 className="text-xl sm:text-2xl font-black text-pnw-slate dark:text-gray-100">Not sure where to start?</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300 max-w-xl mx-auto">Take the Matchmaker. A few questions and you will have a ranked list of PNW programs that actually fit you.</p>
        <Link to="/recruiting/quiz" className="inline-block mt-4 px-6 py-2.5 rounded-lg bg-nw-teal text-white text-sm font-bold hover:bg-teal-700 transition-colors">
          Take the Recruit Matchmaker
        </Link>
      </section>
    </div>
  )
}
