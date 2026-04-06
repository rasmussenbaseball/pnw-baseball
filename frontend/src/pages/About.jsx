import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

// ─── Site Updates / Changelog ───
const UPDATES = [
  {
    version: '1.4',
    date: 'April 5, 2026',
    title: 'NWAC Automation, Expanded Coverage & Scoreboard Improvements',
    changes: [
      'Fully automated NWAC player stats scraping via GitHub Actions with ScraperAPI (no more manual Mac runs)',
      'Added Willamette (D3) and Seattle U (D1) to the automated stats pipeline alongside NWAC',
      'NWAC game results now scrape every 2 hours during game hours (11 AM to 9 PM PT)',
      'League-adjusted stats (wRC+, FIP+, ERA-) automatically recalculate after each scrape',
      'Homepage recent scores widget now always shows the 15 latest results across all divisions',
      'Live games ticker and recent results ticker now display simultaneously on game days',
      'Fixed timezone handling so NWAC games and stat timestamps display correctly in Pacific time',
      'Fixed duplicate NWAC game records on the scoreboard',
    ],
  },
  {
    version: '1.3',
    date: 'April 4, 2026',
    title: 'Scoreboard Overhaul, Live Scores & Infrastructure',
    changes: [
      'Consolidated Scoreboard and Results into a single page with date navigation arrows - browse any day\'s games in one place',
      'Added live score auto-refresh (every 2 minutes) with LIVE badge and game state display',
      'Scoreboard now groups games by level: D1 → D2 → D3 → NAIA → NWAC',
      'Added division filter buttons to the scoreboard (All, D1, D2, D3, NAIA, JUCO)',
      'Player headshots now served from persistent storage (nginx) - no longer disappear on deploys',
      'Team logos moved to persistent storage - summer/WCL logos no longer vanish after site updates',
      'Added WCL team logos to the homepage WCL Leaders widget',
      'Automated scraping schedule: daily updates at 2 PM, 6 PM, 11 PM PT; live scores every 10 min during game hours (8 AM – 8 PM PT)',
      'Added nightly game deduplication job to keep data clean',
      'Fixed scoreboard showing stale data after deploys (live_scores.json no longer tracked in git)',
    ],
  },
  {
    version: '1.2',
    date: 'April 1, 2026',
    title: 'Recruiting Tools, Draft Board & Homepage Refresh',
    changes: [
      'Added Recruiting Breakdown page - sortable table of every PNW team with W-L% trends, freshman PA% and IP%, WAR/G, wRC+, FIP, and national/PPI rankings',
      'Overhauled Recruiting Guide - added year-by-year W-L history, fixed roster counts, position matching, and freshman production calculations',
      'Moved Recruiting Classes under the Recruiting tab with division-level filters on stat leaders',
      'Built 2026 MLB Draft Board featuring 12 PNW prospects linked to their college player pages',
      'Homepage refresh - draft board widget, WCL summer leaders section, improved text readability, and D1 label on PNW Grid',
      'JUCO Tracker now shows committed NWAC players with a green commitment tag',
      'Renamed Glossary to About and redesigned the page with bio, run environments, updates log, and stat glossary',
      'Added site footer with brand info, site links, data sources, and social links',
      'Fixed PNW Grid daily mode - clicking a player in the dropdown now works correctly',
      'Fixed summer stat totals filtering and various roster display bugs',
    ],
  },
  {
    version: '1.1',
    date: 'March 31, 2026',
    title: 'Player Pages, Feature Requests & UI Polish',
    changes: [
      'Added Player Pages under Misc - search any player and get a shareable stat graphic with core stats, advanced stats, Savant-style percentile bars, and leaderboard badges',
      'Added Feature Request page under Misc - users can submit ideas and feedback for the site',
      'Updated the OG banner image (the preview that shows when you share the site link) with the new NW logo',
      'Player Pages include career and per-season views with percentile rankings vs. division',
    ],
  },
  {
    version: '1.0',
    date: 'March 30, 2026',
    title: 'Launch Features & Core Improvements',
    changes: [
      'Added beta intro banner to homepage with feature highlights and signup CTA',
      'Sticky table headers on leaderboards - column headers stay visible when scrolling',
      'Mobile improvements - sticky rank & player columns on leaderboard tables, sticky season on player stat pages',
      'Added PNW Grid link and signup CTA to homepage',
      'Gated Coaching and Misc tabs behind authentication',
      'Fixed transfer player pages to show most recent team in header and sort schools oldest to newest',
      'Fixed homepage ticker to always show recent scores',
      'Fixed summer player links using spring_player_id',
      'Added WAF safeguard to skip NWAC scrape when blocked',
    ],
  },
]

// ─── Stat definition component ───
function StatDef({ abbr, name, children }) {
  return (
    <div className="py-3 border-b border-gray-100 last:border-0">
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-sm font-bold text-nw-teal font-mono">{abbr}</span>
        <span className="text-sm font-semibold text-gray-800">{name}</span>
      </div>
      <p className="text-sm text-gray-600 leading-relaxed">{children}</p>
    </div>
  )
}

// ─── Card wrapper ───
function Card({ title, subtitle, children }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden mb-4">
      {title && (
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
          <h3 className="text-base font-bold text-gray-800">{title}</h3>
          {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
      )}
      <div className="px-5 py-2">{children}</div>
    </div>
  )
}

// ─── Prose paragraph helper ───
function P({ children }) {
  return <p className="text-sm text-gray-600 leading-relaxed mb-3">{children}</p>
}

// ─── Formula display ───
function Formula({ children }) {
  return (
    <div className="bg-gray-50 border border-gray-200 rounded px-3 py-2 my-2 font-mono text-xs text-gray-700 overflow-x-auto">
      {children}
    </div>
  )
}

// ─── Section anchor link ───
function SectionHeading({ id, children }) {
  return (
    <h2 id={id} className="text-lg font-bold text-pnw-slate mt-8 mb-3 scroll-mt-20 flex items-center gap-2">
      {children}
    </h2>
  )
}

// ============================================================
// BIO / ABOUT SECTION
// ============================================================
function BioSection() {
  return (
    <div>
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden mb-4">
        <div className="px-5 py-5">
          <div className="flex flex-col sm:flex-row gap-5">
            {/* Bio text */}
            <div className="flex-1">
              <h3 className="text-lg font-bold text-gray-800 mb-2">Nate Rasmussen</h3>
              <p className="text-xs text-gray-400 uppercase tracking-wider font-semibold mb-3">Creator & Developer</p>
              <p className="text-sm text-gray-600 leading-relaxed mb-3">
                Pitching coach at{' '}
                <Link to="/team/bushnell-beacons" className="text-nw-teal hover:underline">Bushnell University</Link>.
                Former pitcher at{' '}
                <Link to="/player/5882" className="text-nw-teal hover:underline">Bellevue College</Link> and{' '}
                <Link to="/player/3925" className="text-nw-teal hover:underline">Bushnell University</Link>.
                Amateur scout with Over-Slot Baseball. MiLB content creator with Just Baseball.
              </p>
              <p className="text-sm text-gray-600 leading-relaxed mb-4">
                NW Baseball Stats was built to bring the same advanced analytics that MLB fans take for granted to every level of Pacific Northwest college baseball. From D1 down to the NWAC, every player deserves to have their performance measured fairly with modern stats.
              </p>
              <div className="flex items-center gap-3">
                <a
                  href="https://x.com/RasmussenBase"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-900 text-white text-xs font-medium hover:bg-gray-700 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                  @RasmussenBase
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Card title="Why This Site Exists">
        <P>
          While MLB has FanGraphs, Baseball Reference, and Statcast, college baseball - especially at the D2, D3, NAIA, and JUCO levels - has almost no publicly available advanced statistics. A catcher at a JUCO putting up a 150 wRC+ should be visible to four-year programs. A D3 pitcher with a 2.50 FIP should be recognized even if their ERA is inflated by poor defense. That's the gap this site fills.
        </P>
      </Card>

      <Card title="How the Site Was Built" subtitle="Full transparency into our tech stack and process">
        <P>
          This entire site - frontend, backend, database, scrapers, advanced stats engine, and all - was built collaboratively by a human and an AI (Claude by Anthropic). The AI handled the coding implementation while the human drove the vision, design decisions, data validation, and quality control.
        </P>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 my-3">
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs font-bold text-gray-700 mb-1">Frontend</p>
            <p className="text-xs text-gray-500">React 18 · Vite · Tailwind CSS · Recharts</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs font-bold text-gray-700 mb-1">Backend</p>
            <p className="text-xs text-gray-500">Python FastAPI · PostgreSQL · DigitalOcean</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs font-bold text-gray-700 mb-1">Data Collection</p>
            <p className="text-xs text-gray-500">Custom scrapers · Sidearm · PrestoSports</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs font-bold text-gray-700 mb-1">Analytics Engine</p>
            <p className="text-xs text-gray-500">wOBA · FIP · WAR · Division-calibrated weights</p>
          </div>
        </div>
      </Card>

      <Card title="Coverage">
        <P>
          We currently track 57 teams across five divisions in the Pacific Northwest, plus summer collegiate leagues:
        </P>
        <div className="my-3 space-y-1.5">
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">NCAA D1 (7):</span> Oregon, Oregon State, Washington, Washington State, Gonzaga, Portland, Seattle U</p>
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">NCAA D2 (5):</span> Central Washington, Montana State Billings, Northwest Nazarene, Saint Martin's, Western Oregon</p>
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">NCAA D3 (9):</span> George Fox, Lewis & Clark, Linfield, Pacific, PLU, UPS, Whitman, Whitworth, Willamette</p>
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">NAIA (8):</span> Bushnell, College of Idaho, Corban, Eastern Oregon, Lewis-Clark State, Oregon Tech, UBC, Warner Pacific</p>
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">NWAC (28):</span> All community college programs across four sub-conferences</p>
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">Summer:</span> West Coast League (WCL) and other PNW summer leagues</p>
        </div>
      </Card>

      <Card title="Data Sources">
        <P>
          All player statistics are scraped from official team athletics websites. We do not fabricate or estimate raw stats. Advanced stats are computed from these raw numbers using the formulas described below.
        </P>
        <div className="my-3 space-y-1.5">
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">D1/D2/D3/NAIA:</span> Sidearm Sports platforms, individual team stats pages.</p>
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">NWAC:</span> PrestoSports (nwacsports.com).</p>
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">Summer:</span> PointStreak and league-hosted stat pages.</p>
        </div>
      </Card>
    </div>
  )
}

// ============================================================
// RUN ENVIRONMENT SECTION (with WCL added)
// ============================================================
function EnvironmentSection() {
  return (
    <div>
      <Card title="What is a Run Environment?" subtitle="Why context matters when comparing stats across divisions">
        <P>
          Not all leagues are created equal. A .300 batting average in the NWAC means something very different than a .300 average in D1. The quality of pitching, defense, ballparks, bats, and weather all affect how many runs are scored. The "run environment" describes the overall offensive context of a league.
        </P>
        <P>
          This is why we use adjusted stats like wRC+ and FIP+. They normalize raw numbers to a common scale (100 = league average) so you can compare a D3 hitter to a D1 hitter on equal footing, at least relative to their peers.
        </P>
        <P>
          All run environment figures below are averaged across 2022-2026 PNW data to provide stable baselines. These are the same averages used to compute wRC+, FIP+, and other league-adjusted stats.
        </P>
      </Card>

      <Card title="NCAA Division I" subtitle="Big Ten, WCC, Mountain West">
        <P>
          D1 is the highest level of college baseball in the PNW. These programs feature the best pitching, with strikeout rates near 9 K/9 and the lowest walk rates. The run environment is moderate compared to other divisions.
        </P>
        <div className="grid grid-cols-2 gap-3 my-3 text-center">
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">.280</p><p className="text-[10px] text-gray-500">Avg BA</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">.816</p><p className="text-[10px] text-gray-500">Avg OPS</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">5.43</p><p className="text-[10px] text-gray-500">Avg ERA</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">8.8</p><p className="text-[10px] text-gray-500">Avg K/9</p></div>
        </div>
      </Card>

      <Card title="NCAA Division II" subtitle="Great Northwest Athletic Conference (GNAC)">
        <P>
          The GNAC features five PNW schools. D2 has a high-scoring environment with the highest walk rates and ERAs near 6.00. Pitching depth is at a premium.
        </P>
        <div className="grid grid-cols-2 gap-3 my-3 text-center">
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">.283</p><p className="text-[10px] text-gray-500">Avg BA</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">.786</p><p className="text-[10px] text-gray-500">Avg OPS</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">5.99</p><p className="text-[10px] text-gray-500">Avg ERA</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">7.2</p><p className="text-[10px] text-gray-500">Avg K/9</p></div>
        </div>
      </Card>

      <Card title="NCAA Division III" subtitle="Northwest Conference (NWC)">
        <P>
          The Northwest Conference is a nine-team D3 league with strong competitive balance. D3 has a hitter-friendly environment with solid batting averages and OPS figures.
        </P>
        <div className="grid grid-cols-2 gap-3 my-3 text-center">
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">.280</p><p className="text-[10px] text-gray-500">Avg BA</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">.795</p><p className="text-[10px] text-gray-500">Avg OPS</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">5.80</p><p className="text-[10px] text-gray-500">Avg ERA</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">7.4</p><p className="text-[10px] text-gray-500">Avg K/9</p></div>
        </div>
      </Card>

      <Card title="NAIA" subtitle="Cascade Collegiate Conference (CCC)">
        <P>
          The CCC is an eight-team NAIA conference. NAIA has the highest OPS of any PNW division (.828), with the most offense-friendly run environment.
        </P>
        <div className="grid grid-cols-2 gap-3 my-3 text-center">
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">.288</p><p className="text-[10px] text-gray-500">Avg BA</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">.828</p><p className="text-[10px] text-gray-500">Avg OPS</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">6.11</p><p className="text-[10px] text-gray-500">Avg ERA</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">7.7</p><p className="text-[10px] text-gray-500">Avg K/9</p></div>
        </div>
      </Card>

      <Card title="NWAC" subtitle="Northwest Athletic Conference: East, North, South, West Divisions">
        <P>
          The NWAC is the two-year college (JUCO) conference covering Washington and Oregon, with 28 programs across four divisions. Batting averages are substantially lower (.243) and OPS is the lowest of any division (.670). NWAC pitching ERAs and strikeout rates are competitive with higher divisions, suggesting pitching development outpaces hitting at this level.
        </P>
        <div className="grid grid-cols-2 gap-3 my-3 text-center">
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">.243</p><p className="text-[10px] text-gray-500">Avg BA</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">.670</p><p className="text-[10px] text-gray-500">Avg OPS</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">4.52</p><p className="text-[10px] text-gray-500">Avg ERA</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">7.6</p><p className="text-[10px] text-gray-500">Avg K/9</p></div>
        </div>
      </Card>

      <Card title="West Coast League (WCL)" subtitle="Premier summer collegiate wood-bat league">
        <P>
          The WCL is the top summer collegiate league in the Pacific Northwest, with teams across Washington, Oregon, and British Columbia. Players use wood bats (unlike the aluminum bats used during the college season), which significantly changes the run environment. Batting averages and power numbers drop compared to the spring, making it a truer test of a hitter's raw ability. The WCL is a key development league for MLB Draft prospects.
        </P>
        <div className="grid grid-cols-2 gap-3 my-3 text-center">
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">.248</p><p className="text-[10px] text-gray-500">Avg BA</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">.688</p><p className="text-[10px] text-gray-500">Avg OPS</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">4.18</p><p className="text-[10px] text-gray-500">Avg ERA</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">8.4</p><p className="text-[10px] text-gray-500">Avg K/9</p></div>
        </div>
      </Card>
    </div>
  )
}

// ============================================================
// UPDATES SECTION
// ============================================================
function UpdatesSection() {
  return (
    <div className="space-y-6">
      <Card title="Site Updates" subtitle="A running log of features, fixes, and improvements.">
        <div className="space-y-6">
          {UPDATES.map((update) => (
            <div key={update.version} className="pb-5 border-b border-gray-100 last:border-0 last:pb-0">
              <div className="flex items-baseline gap-3 mb-2">
                <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold bg-nw-teal text-white">
                  v{update.version}
                </span>
                <span className="text-sm font-semibold text-gray-800">{update.title}</span>
                <span className="text-xs text-gray-400 ml-auto shrink-0">{update.date}</span>
              </div>
              <ul className="space-y-1.5 ml-1">
                {update.changes.map((change, i) => (
                  <li key={i} className="flex gap-2 text-sm text-gray-600">
                    <span className="text-nw-teal mt-1 shrink-0">•</span>
                    <span>{change}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

// ============================================================
// BATTING STATS GLOSSARY
// ============================================================
function BattingSection() {
  return (
    <div>
      <Card title="Traditional Batting Stats" subtitle="Standard counting and rate statistics">
        <StatDef abbr="AVG" name="Batting Average">
          Hits divided by at-bats. The most traditional measure of hitting ability, though it doesn't account for walks, extra-base power, or how a player reaches base. A .300 AVG is considered excellent at any level.
        </StatDef>
        <StatDef abbr="OBP" name="On-Base Percentage">
          How often a batter reaches base, including hits, walks, and hit-by-pitches. Calculated as (H + BB + HBP) / (AB + BB + HBP + SF). OBP correlates more strongly with run scoring than AVG.
        </StatDef>
        <StatDef abbr="SLG" name="Slugging Percentage">
          Total bases divided by at-bats. Measures raw power by weighting extra-base hits more heavily (1B = 1, 2B = 2, 3B = 3, HR = 4).
        </StatDef>
        <StatDef abbr="OPS" name="On-Base Plus Slugging">
          Simply OBP + SLG. A quick-and-dirty measure combining a hitter's ability to get on base and hit for power.
        </StatDef>
        <StatDef abbr="ISO" name="Isolated Power">
          SLG minus AVG. Measures raw extra-base power by stripping out singles. A .200 ISO is elite power; below .100 is minimal.
          <Formula>ISO = SLG - AVG</Formula>
        </StatDef>
        <StatDef abbr="BABIP" name="Batting Average on Balls in Play">
          (H - HR) / (AB - K - HR + SF). Measures how often non-home-run batted balls fall for hits. League average is typically around .300. Extreme values often regress.
        </StatDef>
        <StatDef abbr="BB%" name="Walk Rate">
          Walks divided by plate appearances. Elite hitters walk 12%+ of the time; league average is around 8-9%.
        </StatDef>
        <StatDef abbr="K%" name="Strikeout Rate">
          Strikeouts divided by plate appearances. Lower is generally better for hitters.
        </StatDef>
      </Card>

      <Card title="Advanced Batting Stats" subtitle="Sabermetric metrics that adjust for context">
        <StatDef abbr="wOBA" name="Weighted On-Base Average">
          A comprehensive rate stat that weights each way of reaching base by its actual run value. Our linear weights are calibrated per division.
          <Formula>wOBA = (0.69×uBB + 0.72×HBP + 0.88×1B + 1.24×2B + 1.56×3B + 2.00×HR) / (AB + uBB + SF + HBP)</Formula>
          Weights shown are D1 defaults. They vary by division. Above .370 is excellent; below .300 is below average.
        </StatDef>
        <StatDef abbr="wRAA" name="Weighted Runs Above Average">
          Converts wOBA into a counting stat representing runs above or below the league-average hitter. A wRAA of 0 is exactly average; +15 over a college season is elite.
        </StatDef>
        <StatDef abbr="wRC" name="Weighted Runs Created">
          Estimates total runs a player created through their offensive contributions. Built on the same wOBA framework as wRAA.
        </StatDef>
        <StatDef abbr="wRC+" name="Weighted Runs Created Plus">
          The gold standard offensive metric. 100 is exactly league average. A wRC+ of 130 means the hitter was 30% better than average. The single best number for comparing hitters across divisions.
          <Formula>wRC+ = 100 × (wRAA/PA + lgR/PA) / (Park Factor × lgR/PA)</Formula>
        </StatDef>
      </Card>
    </div>
  )
}

// ============================================================
// PITCHING STATS GLOSSARY
// ============================================================
function PitchingSection() {
  return (
    <div>
      <Card title="Traditional Pitching Stats" subtitle="Standard rate and per-9 statistics">
        <StatDef abbr="ERA" name="Earned Run Average">
          Earned runs allowed per nine innings pitched. Heavily influenced by defense, sequencing, and luck. A 3.00 ERA in D1 is excellent.
        </StatDef>
        <StatDef abbr="WHIP" name="Walks + Hits per Inning Pitched">
          (BB + H) / IP. Below 1.00 is elite; above 1.50 indicates too many baserunners.
        </StatDef>
        <StatDef abbr="K/9" name="Strikeouts per Nine Innings">
          (K × 9) / IP. Higher is better. 9+ K/9 indicates a dominant strikeout pitcher.
        </StatDef>
        <StatDef abbr="BB/9" name="Walks per Nine Innings">
          (BB × 9) / IP. Lower is better. Below 3.0 is good control; above 5.0 is a concern.
        </StatDef>
        <StatDef abbr="K/BB" name="Strikeout-to-Walk Ratio">
          Strikeouts divided by walks. Above 3.0 is good; above 5.0 is elite.
        </StatDef>
        <StatDef abbr="K%" name="Strikeout Percentage">
          Strikeouts divided by batters faced. More accurate than K/9 because it's based on actual batters faced.
        </StatDef>
        <StatDef abbr="BB%" name="Walk Percentage">
          Walks divided by batters faced. More accurate than BB/9.
        </StatDef>
        <StatDef abbr="K-BB%" name="Strikeout Minus Walk Percentage">
          K% minus BB%. Above 20% is very good; above 30% is elite. One of the best single-number indicators of pitching skill.
        </StatDef>
      </Card>

      <Card title="Advanced Pitching Stats" subtitle="Defense-independent and predictive metrics">
        <StatDef abbr="FIP" name="Fielding Independent Pitching">
          Estimates what a pitcher's ERA "should" be based only on outcomes they control: strikeouts, walks, HBP, and home runs. Better predictor of future performance than ERA.
          <Formula>FIP = ((13×HR + 3×(BB+HBP) - 2×K) / IP) + FIP Constant</Formula>
        </StatDef>
        <StatDef abbr="xFIP" name="Expected Fielding Independent Pitching">
          Like FIP, but replaces actual home runs with expected home runs based on a league-average HR/FB rate.
        </StatDef>
        <StatDef abbr="SIERA" name="Skill-Interactive ERA">
          A more sophisticated ERA estimator that accounts for the interaction between strikeout rate, walk rate, and ground ball rate.
          <Formula>SIERA ≈ 6.145 - 16.986×K% + 11.434×BB% - 1.858×GB% + interaction terms</Formula>
        </StatDef>
        <StatDef abbr="kwERA" name="Strikeout-Walk ERA">
          The simplest ERA estimator. Uses only strikeouts and walks.
          <Formula>kwERA = 5.40 - 12 × ((K - BB) / BF)</Formula>
        </StatDef>
        <StatDef abbr="FIP+" name="FIP Plus">
          FIP adjusted to a scale where 100 is league average. Higher is better. Allows comparison across divisions.
          <Formula>FIP+ = 100 × (League FIP / (Player FIP / Park Factor))</Formula>
        </StatDef>
        <StatDef abbr="ERA+" name="ERA Plus">
          ERA adjusted to a scale where 100 is league average. Higher is better.
          <Formula>ERA+ = 100 × (League ERA / (Player ERA / Park Factor))</Formula>
        </StatDef>
        <StatDef abbr="BABIP" name="Batting Average on Balls in Play (Against)">
          Same formula as the batting version, but from the pitcher's perspective. Pitchers have limited control over their BABIP. League average is around .300.
        </StatDef>
        <StatDef abbr="LOB%" name="Left on Base Percentage">
          The percentage of baserunners a pitcher strands. League average is around 72%. Very high LOB% often regresses.
        </StatDef>
      </Card>
    </div>
  )
}

// ============================================================
// WAR METHODOLOGY SECTION
// ============================================================
function WarSection() {
  return (
    <div>
      <Card title="What is WAR?" subtitle="Wins Above Replacement: our single-number player value metric">
        <P>
          WAR attempts to answer one question: how many wins did this player contribute compared to a freely available replacement-level player? A WAR of 0 means replacement level. A WAR of 2.0+ over a college season is outstanding.
        </P>
        <P>
          Our WAR is "box score WAR." It's directionally useful for comparing players within the same division, but the exact numbers should be taken with appropriate context.
        </P>
      </Card>

      <Card title="Offensive WAR (oWAR)" subtitle="How we measure position player value">
        <P>
          Offensive WAR has three components summed and converted from runs to wins:
        </P>
        <div className="bg-gray-50 rounded-lg p-4 my-3 space-y-3">
          <div>
            <span className="text-xs font-bold text-nw-teal">1. Batting Runs (wRAA)</span>
            <p className="text-xs text-gray-600 mt-1">
              How many runs above or below average the player created through hitting. Derived from wOBA using division-specific linear weights.
            </p>
          </div>
          <div>
            <span className="text-xs font-bold text-nw-teal">2. Positional Adjustment</span>
            <p className="text-xs text-gray-600 mt-1">
              Harder defensive positions get a bonus; easier ones get a penalty. We scale MLB positional adjustments to the college season length with a 50% confidence discount.
            </p>
          </div>
          <div>
            <span className="text-xs font-bold text-nw-teal">3. Replacement Level</span>
            <p className="text-xs text-gray-600 mt-1">
              A playing-time credit for being on the field. Scaled from the MLB standard of 20 runs per 600 PA.
            </p>
          </div>
        </div>
        <Formula>oWAR = (Batting Runs + Positional Adjustment + Replacement Level) / Runs Per Win</Formula>
        <P>
          Runs Per Win varies by division: 9.0 for D1, 9.5 for D2/NAIA, 10.0 for D3/NWAC.
        </P>
      </Card>

      <Card title="Pitching WAR (pWAR)" subtitle="How we measure pitcher value">
        <P>
          Pitching WAR is built on FIP, not ERA - measuring a pitcher's value based on outcomes they control.
        </P>
        <Formula>pWAR = ((League FIP - Player FIP) / Runs Per Win) × (IP / 9) + Replacement Level</Formula>
      </Card>

      <Card title="Division-Specific Linear Weights" subtitle="How we calibrate stats across divisions">
        <P>
          Each division has its own run environment. A home run is worth more in a low-scoring NWAC game than in a high-scoring NAIA game.
        </P>
        <div className="overflow-x-auto my-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase tracking-wider bg-gray-50">
                <th className="text-left px-3 py-2">Weight</th>
                <th className="text-center px-2 py-2">D1</th>
                <th className="text-center px-2 py-2">D2</th>
                <th className="text-center px-2 py-2">D3</th>
                <th className="text-center px-2 py-2">NAIA</th>
                <th className="text-center px-2 py-2">NWAC</th>
              </tr>
            </thead>
            <tbody className="text-gray-700">
              <tr className="border-t border-gray-100"><td className="px-3 py-1.5 font-medium">Walk (uBB)</td><td className="text-center px-2">0.69</td><td className="text-center px-2">0.69</td><td className="text-center px-2">0.70</td><td className="text-center px-2">0.70</td><td className="text-center px-2">0.70</td></tr>
              <tr className="border-t border-gray-100"><td className="px-3 py-1.5 font-medium">HBP</td><td className="text-center px-2">0.72</td><td className="text-center px-2">0.72</td><td className="text-center px-2">0.73</td><td className="text-center px-2">0.73</td><td className="text-center px-2">0.73</td></tr>
              <tr className="border-t border-gray-100"><td className="px-3 py-1.5 font-medium">Single</td><td className="text-center px-2">0.88</td><td className="text-center px-2">0.89</td><td className="text-center px-2">0.89</td><td className="text-center px-2">0.90</td><td className="text-center px-2">0.90</td></tr>
              <tr className="border-t border-gray-100"><td className="px-3 py-1.5 font-medium">Double</td><td className="text-center px-2">1.24</td><td className="text-center px-2">1.25</td><td className="text-center px-2">1.26</td><td className="text-center px-2">1.27</td><td className="text-center px-2">1.27</td></tr>
              <tr className="border-t border-gray-100"><td className="px-3 py-1.5 font-medium">Triple</td><td className="text-center px-2">1.56</td><td className="text-center px-2">1.58</td><td className="text-center px-2">1.59</td><td className="text-center px-2">1.60</td><td className="text-center px-2">1.60</td></tr>
              <tr className="border-t border-gray-100"><td className="px-3 py-1.5 font-medium">Home Run</td><td className="text-center px-2">2.00</td><td className="text-center px-2">2.02</td><td className="text-center px-2">2.03</td><td className="text-center px-2">2.05</td><td className="text-center px-2">2.05</td></tr>
              <tr className="border-t border-gray-100 bg-gray-50"><td className="px-3 py-1.5 font-medium">Runs/PA</td><td className="text-center px-2">0.125</td><td className="text-center px-2">0.130</td><td className="text-center px-2">0.135</td><td className="text-center px-2">0.135</td><td className="text-center px-2">0.140</td></tr>
              <tr className="border-t border-gray-100 bg-gray-50"><td className="px-3 py-1.5 font-medium">Runs/Win</td><td className="text-center px-2">9.0</td><td className="text-center px-2">9.5</td><td className="text-center px-2">10.0</td><td className="text-center px-2">9.5</td><td className="text-center px-2">10.0</td></tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Known Limitations" subtitle="What our WAR can't capture">
        <div className="py-2 space-y-2">
          <div className="text-sm text-gray-600 space-y-2">
            <p><span className="font-semibold text-gray-700">No defensive metrics.</span> We don't have fielding data beyond roster position.</p>
            <p><span className="font-semibold text-gray-700">No batted-ball data.</span> Without exit velocity or launch angle, our xFIP and SIERA rely on estimates.</p>
            <p><span className="font-semibold text-gray-700">No baserunning value.</span> oWAR slightly undervalues elite baserunners.</p>
            <p><span className="font-semibold text-gray-700">Small samples.</span> College seasons are 40-56 games. Use WAR as a guide, not a verdict.</p>
            <p><span className="font-semibold text-gray-700">Cross-division comparisons are imperfect.</span> We normalize within each division, but can't account for the talent gap between levels.</p>
          </div>
        </div>
      </Card>
    </div>
  )
}

// ─── Jump-link navigation ───
const PAGE_SECTIONS = [
  { id: 'about', label: 'About' },
  { id: 'environments', label: 'Run Environments' },
  { id: 'updates', label: 'Updates' },
  { id: 'glossary', label: 'Stat Glossary' },
]

// ============================================================
// MAIN ABOUT PAGE
// ============================================================
export default function About() {
  const [activeGlossary, setActiveGlossary] = useState('batting')
  const [siteStats, setSiteStats] = useState(null)

  useEffect(() => {
    fetch('/api/v1/site-stats')
      .then(r => r.json())
      .then(d => setSiteStats(d))
      .catch(() => {})
  }, [])

  const scrollTo = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">About NW Baseball Stats</h1>
      <p className="text-sm text-gray-500 mb-4">The story behind the site, our methodology, and every stat we track.</p>

      {/* Site-wide counters */}
      {siteStats && (
        <div className="flex gap-4 mb-5">
          <div className="flex-1 bg-white rounded-lg shadow-sm border border-gray-200 px-5 py-4 text-center">
            <p className="text-2xl font-bold text-nw-teal">{siteStats.total_players.toLocaleString()}</p>
            <p className="text-xs text-gray-500 mt-0.5 font-medium uppercase tracking-wider">Players Tracked</p>
          </div>
          <div className="flex-1 bg-white rounded-lg shadow-sm border border-gray-200 px-5 py-4 text-center">
            <p className="text-2xl font-bold text-nw-teal">{siteStats.total_games.toLocaleString()}</p>
            <p className="text-xs text-gray-500 mt-0.5 font-medium uppercase tracking-wider">Games Tracked</p>
          </div>
        </div>
      )}

      {/* Jump-link nav */}
      <div className="flex gap-1 mb-5 overflow-x-auto pb-1">
        {PAGE_SECTIONS.map(s => (
          <button
            key={s.id}
            onClick={() => scrollTo(s.id)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors bg-gray-100 text-gray-600 hover:bg-nw-teal hover:text-white"
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="max-w-3xl">
        {/* ─── About / Bio ─── */}
        <SectionHeading id="about">About</SectionHeading>
        <BioSection />

        {/* ─── Run Environments ─── */}
        <SectionHeading id="environments">Run Environments</SectionHeading>
        <EnvironmentSection />

        {/* ─── Updates ─── */}
        <SectionHeading id="updates">Site Updates</SectionHeading>
        <UpdatesSection />

        {/* ─── Stat Glossary ─── */}
        <SectionHeading id="glossary">Stat Glossary</SectionHeading>
        <div className="flex gap-1 mb-4">
          {[
            { id: 'batting', label: 'Batting' },
            { id: 'pitching', label: 'Pitching' },
            { id: 'war', label: 'WAR Methodology' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveGlossary(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                activeGlossary === tab.id
                  ? 'bg-nw-teal text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {activeGlossary === 'batting' && <BattingSection />}
        {activeGlossary === 'pitching' && <PitchingSection />}
        {activeGlossary === 'war' && <WarSection />}
      </div>
    </div>
  )
}
