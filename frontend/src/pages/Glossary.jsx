import { useState } from 'react'

// ─── Section nav tabs ───
const SECTIONS = [
  { id: 'batting', label: 'Batting Stats' },
  { id: 'pitching', label: 'Pitching Stats' },
  { id: 'war', label: 'WAR Methodology' },
  { id: 'environment', label: 'Run Environments' },
  { id: 'about', label: 'About the Site' },
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

// ============================================================
// BATTING STATS SECTION
// ============================================================
function BattingSection() {
  return (
    <div>
      <Card title="Traditional Batting Stats" subtitle="Standard counting and rate statistics">
        <StatDef abbr="AVG" name="Batting Average">
          Hits divided by at-bats. The most traditional measure of hitting ability, though it doesn't account for walks, extra-base power, or how a player reaches base. A .300 AVG is considered excellent at any level.
        </StatDef>
        <StatDef abbr="OBP" name="On-Base Percentage">
          How often a batter reaches base, including hits, walks, and hit-by-pitches. Calculated as (H + BB + HBP) / (AB + BB + HBP + SF). Getting on base is the most important thing a hitter can do. OBP correlates more strongly with run scoring than AVG.
        </StatDef>
        <StatDef abbr="SLG" name="Slugging Percentage">
          Total bases divided by at-bats. Measures raw power by weighting extra-base hits more heavily (1B = 1, 2B = 2, 3B = 3, HR = 4). Unlike AVG, it rewards the type of hit, not just whether the batter reached base.
        </StatDef>
        <StatDef abbr="OPS" name="On-Base Plus Slugging">
          Simply OBP + SLG. A quick-and-dirty measure combining a hitter's ability to get on base and hit for power. Not perfect. It overweights SLG relative to OBP, but widely used as a single-number snapshot of offensive performance.
        </StatDef>
        <StatDef abbr="ISO" name="Isolated Power">
          SLG minus AVG. Measures raw extra-base power by stripping out singles. A player with a .200 ISO has elite power; below .100 is minimal power. Useful for isolating a hitter's power production from their contact ability.
          <Formula>ISO = SLG - AVG</Formula>
        </StatDef>
        <StatDef abbr="BABIP" name="Batting Average on Balls in Play">
          (H - HR) / (AB - K - HR + SF). Measures how often non-home-run batted balls fall for hits. The league average is typically around .300. Extreme BABIP values often regress toward the mean, making this useful for identifying players who may be over- or under-performing.
        </StatDef>
        <StatDef abbr="BB%" name="Walk Rate">
          Walks divided by plate appearances. Measures a hitter's plate discipline and ability to take free bases. Elite hitters walk 12%+ of the time; league average is typically around 8-9%.
        </StatDef>
        <StatDef abbr="K%" name="Strikeout Rate">
          Strikeouts divided by plate appearances. Lower is generally better for hitters. College averages tend to be higher than pro ball due to the use of aluminum bats affecting approach and the development curve of pitchers.
        </StatDef>
      </Card>

      <Card title="Advanced Batting Stats" subtitle="Sabermetric metrics that adjust for context">
        <StatDef abbr="wOBA" name="Weighted On-Base Average">
          A comprehensive rate stat that weights each way of reaching base by its actual run value. Unlike OPS, wOBA properly weights walks, singles, doubles, triples, and home runs based on how many runs each event is actually worth. Our linear weights are calibrated per division to reflect each level's run environment.
          <Formula>wOBA = (0.69×uBB + 0.72×HBP + 0.88×1B + 1.24×2B + 1.56×3B + 2.00×HR) / (AB + uBB + SF + HBP)</Formula>
          Weights shown are D1 defaults. They vary slightly by division. A wOBA above .370 is excellent; below .300 is below average.
        </StatDef>
        <StatDef abbr="wRAA" name="Weighted Runs Above Average">
          Converts wOBA into a counting stat representing runs above or below the league-average hitter. A wRAA of 0 is exactly average; +15 over a college season is elite. Calculated as ((wOBA - lgwOBA) / wOBA Scale) × PA.
        </StatDef>
        <StatDef abbr="wRC" name="Weighted Runs Created">
          Estimates the total number of runs a player has created through their offensive contributions. Built on the same wOBA framework as wRAA but adds league-average run creation back in, so it's always positive.
        </StatDef>
        <StatDef abbr="wRC+" name="Weighted Runs Created Plus">
          The gold standard offensive metric. Measures a hitter's total offensive value adjusted for league and park context. 100 is exactly league average. A wRC+ of 130 means the hitter was 30% better than average, while 80 means 20% worse. This is the single best number for comparing hitters across different divisions and ballparks.
          <Formula>wRC+ = 100 × (wRAA/PA + lgR/PA) / (Park Factor × lgR/PA)</Formula>
        </StatDef>
      </Card>
    </div>
  )
}

// ============================================================
// PITCHING STATS SECTION
// ============================================================
function PitchingSection() {
  return (
    <div>
      <Card title="Traditional Pitching Stats" subtitle="Standard rate and per-9 statistics">
        <StatDef abbr="ERA" name="Earned Run Average">
          Earned runs allowed per nine innings pitched. The most well-known pitching stat, but heavily influenced by defense, sequencing, and luck. A 3.00 ERA in D1 is excellent; league averages vary significantly by division.
        </StatDef>
        <StatDef abbr="WHIP" name="Walks + Hits per Inning Pitched">
          (BB + H) / IP. Measures how many baserunners a pitcher allows per inning. Below 1.00 is elite; above 1.50 indicates a pitcher is putting too many runners on base.
        </StatDef>
        <StatDef abbr="K/9" name="Strikeouts per Nine Innings">
          (K × 9) / IP. Measures strikeout ability on a per-nine basis. Higher is better. 9+ K/9 indicates a dominant strikeout pitcher. D1 averages tend to be higher than lower divisions.
        </StatDef>
        <StatDef abbr="BB/9" name="Walks per Nine Innings">
          (BB × 9) / IP. Measures control. Lower is better. Below 3.0 indicates good control; above 5.0 suggests a pitcher is struggling to throw strikes consistently.
        </StatDef>
        <StatDef abbr="K/BB" name="Strikeout-to-Walk Ratio">
          Strikeouts divided by walks. A simple measure of a pitcher's ability to miss bats while limiting free passes. Above 3.0 is good; above 5.0 is elite.
        </StatDef>
        <StatDef abbr="K%" name="Strikeout Percentage">
          Strikeouts divided by batters faced. More accurate than K/9 because it's based on actual batters faced rather than innings, which can be skewed by defense.
        </StatDef>
        <StatDef abbr="BB%" name="Walk Percentage">
          Walks divided by batters faced. Like K%, this is a more accurate measure of control than BB/9 because it's based on actual batters faced.
        </StatDef>
        <StatDef abbr="K-BB%" name="Strikeout Minus Walk Percentage">
          K% minus BB%. Combines a pitcher's two most controllable skills: missing bats and throwing strikes. Into one number. Above 20% is very good; above 30% is elite. One of the best single-number indicators of pitching skill.
        </StatDef>
      </Card>

      <Card title="Advanced Pitching Stats" subtitle="Defense-independent and predictive metrics">
        <StatDef abbr="FIP" name="Fielding Independent Pitching">
          Estimates what a pitcher's ERA "should" be based only on the outcomes they control: strikeouts, walks, hit-by-pitches, and home runs. FIP strips out the effects of defense and sequencing luck, making it a better predictor of future performance than ERA.
          <Formula>FIP = ((13×HR + 3×(BB+HBP) - 2×K) / IP) + FIP Constant</Formula>
          The FIP constant is calibrated per division so that average FIP equals average ERA for that level.
        </StatDef>
        <StatDef abbr="xFIP" name="Expected Fielding Independent Pitching">
          Like FIP, but replaces actual home runs with expected home runs based on a league-average HR/FB rate. Since home run rates can fluctuate on small samples, xFIP is often a better predictor than FIP for pitchers with extreme HR rates. Because we lack fly ball data at the college level, we estimate fly balls from balls in play.
        </StatDef>
        <StatDef abbr="SIERA" name="Skill-Interactive ERA">
          A more sophisticated ERA estimator that accounts for the interaction between strikeout rate, walk rate, and ground ball rate. Unlike FIP, SIERA recognizes that the value of a strikeout changes based on a pitcher's ground ball tendencies. Our implementation is simplified since college baseball lacks batted-ball data. We estimate ground ball rate from a pitcher's profile.
          <Formula>SIERA ≈ 6.145 - 16.986×K% + 11.434×BB% - 1.858×GB% + interaction terms</Formula>
        </StatDef>
        <StatDef abbr="kwERA" name="Strikeout-Walk ERA">
          The simplest ERA estimator. Uses only strikeouts and walks. Less precise than FIP or SIERA but useful as a quick sanity check because it relies on the most reliable, defense-independent stats.
          <Formula>kwERA = 5.40 - 12 × ((K - BB) / BF)</Formula>
        </StatDef>
        <StatDef abbr="FIP+" name="FIP Plus">
          FIP adjusted to a scale where 100 is league average, similar to how wRC+ works for hitters. A FIP+ of 120 means the pitcher's FIP was 20% better than the league average for their division. Higher is better. Allows comparison across divisions with different run environments.
          <Formula>FIP+ = 100 × (League FIP / (Player FIP / Park Factor))</Formula>
        </StatDef>
        <StatDef abbr="ERA+" name="ERA Plus">
          ERA adjusted to a scale where 100 is league average. Like FIP+, higher is better. An ERA+ of 130 means the pitcher's ERA was 30% better than the league average for their division. Useful for cross-division comparisons.
          <Formula>ERA+ = 100 × (League ERA / (Player ERA / Park Factor))</Formula>
        </StatDef>
        <StatDef abbr="BABIP" name="Batting Average on Balls in Play (Against)">
          Same formula as the batting version, but from the pitcher's perspective. Pitchers have limited control over their BABIP. League average is around .300. A very low BABIP against suggests a pitcher may have been getting lucky with balls in play.
        </StatDef>
        <StatDef abbr="LOB%" name="Left on Base Percentage">
          The percentage of baserunners a pitcher strands (doesn't allow to score). League average is around 72%. Very high LOB% (above 80%) often regresses, meaning a pitcher's ERA may rise even if their underlying stuff hasn't changed.
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
          WAR (Wins Above Replacement) attempts to answer one question: how many wins did this player contribute compared to a freely available replacement-level player? A replacement-level player is the kind of talent a team could easily acquire from the bench, the transfer portal, or the open market. Roughly the caliber of a fringe roster player.
        </P>
        <P>
          WAR is not perfect. At the college level, we lack the granular data (pitch tracking, batted-ball data, defensive metrics) available in MLB. Think of our WAR as "box score WAR". It's directionally useful for comparing players within the same division, but the exact numbers should be taken with appropriate context.
        </P>
        <P>
          A WAR of 0 means the player performed at replacement level. A WAR of 2.0+ over a college season is outstanding. Negative WAR means the player was below replacement level. A team would have theoretically been better off with a random available player.
        </P>
      </Card>

      <Card title="Offensive WAR (oWAR)" subtitle="How we measure position player value">
        <P>
          Offensive WAR has three components that are summed and then converted from runs to wins:
        </P>

        <div className="bg-gray-50 rounded-lg p-4 my-3 space-y-3">
          <div>
            <span className="text-xs font-bold text-nw-teal">1. Batting Runs (wRAA)</span>
            <p className="text-xs text-gray-600 mt-1">
              How many runs above or below average the player created through hitting. Derived from wOBA using division-specific linear weights. A player with a .400 wOBA in D1 creates substantially more batting runs than one with a .400 wOBA in NWAC because the run environment differs.
            </p>
          </div>
          <div>
            <span className="text-xs font-bold text-nw-teal">2. Positional Adjustment</span>
            <p className="text-xs text-gray-600 mt-1">
              Harder defensive positions get a bonus; easier ones get a penalty. Catchers and shortstops receive the largest positive adjustment; DHs and first basemen receive the largest negative. We scale MLB positional adjustments (from FanGraphs) to the college season length and apply a 50% confidence discount because we only have roster positions, not actual game-log defensive data.
            </p>
          </div>
          <div>
            <span className="text-xs font-bold text-nw-teal">3. Replacement Level</span>
            <p className="text-xs text-gray-600 mt-1">
              A playing-time credit for simply being on the field. Scaled from the MLB standard of 20 runs per 600 PA. A full-season college starter (~220 PA) earns roughly 2.0 runs of replacement-level credit.
            </p>
          </div>
        </div>

        <Formula>oWAR = (Batting Runs + Positional Adjustment + Replacement Level) / Runs Per Win</Formula>

        <P>
          Runs Per Win varies by division: 9.0 for D1, 9.5 for D2/NAIA, 10.0 for D3/NWAC. These values are lower than the MLB standard (~10) because college seasons are shorter and individual games carry more weight.
        </P>
      </Card>

      <Card title="Pitching WAR (pWAR)" subtitle="How we measure pitcher value">
        <P>
          Pitching WAR is built on FIP, not ERA. This means we're measuring a pitcher's value based on the outcomes they control (strikeouts, walks, HBP, home runs) rather than results that depend on their defense and sequencing luck.
        </P>
        <Formula>pWAR = ((League FIP - Player FIP) / Runs Per Win) × (IP / 9) + Replacement Level</Formula>
        <P>
          The replacement level for pitchers is approximately 0.03 WAR per 9 innings pitched. Meaning even a league-average pitcher accumulates value just by eating innings, since replacing them would cost the team wins.
        </P>
      </Card>

      <Card title="Division-Specific Linear Weights" subtitle="How we calibrate stats across divisions">
        <P>
          Each division has its own run environment. A home run is worth more in a low-scoring NWAC game than in a high-scoring NAIA game. We use division-specific linear weights to account for this:
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
          <P>
            Our WAR is transparent about what it can and cannot measure. These are real limitations we want you to know about:
          </P>
          <div className="text-sm text-gray-600 space-y-2">
            <p><span className="font-semibold text-gray-700">No defensive metrics.</span> We don't have fielding data beyond roster position. A Gold Glove-caliber shortstop and a below-average one look the same in our model. The positional adjustment helps, but it's a blunt instrument.</p>
            <p><span className="font-semibold text-gray-700">No batted-ball data.</span> Without line drive rates, ground ball rates, or exit velocity, our xFIP and SIERA calculations rely on estimates. MLB-level precision isn't possible.</p>
            <p><span className="font-semibold text-gray-700">No baserunning value.</span> Stolen bases are counted in the raw stats, but we don't have a comprehensive baserunning model (extra bases taken, base-out advancement). oWAR slightly undervalues elite baserunners.</p>
            <p><span className="font-semibold text-gray-700">Small samples.</span> College seasons are 40-56 games. Stats are noisier than MLB. A hot or cold two-week stretch has an outsized impact. Use WAR as a guide, not a verdict.</p>
            <p><span className="font-semibold text-gray-700">Cross-division comparisons are imperfect.</span> A 2.0 WAR in D1 and a 2.0 WAR in NWAC don't mean the same thing in terms of absolute talent level. We normalize within each division, but we can't account for the talent gap between levels.</p>
          </div>
        </div>
      </Card>
    </div>
  )
}

// ============================================================
// RUN ENVIRONMENT SECTION
// ============================================================
function EnvironmentSection() {
  return (
    <div>
      <Card title="What is a Run Environment?" subtitle="Why context matters when comparing stats across divisions">
        <P>
          Not all leagues are created equal. A .300 batting average in the NWAC means something very different than a .300 average in D1. The quality of pitching, defense, ballparks, bats, and even weather all affect how many runs are scored. The "run environment" describes the overall offensive context of a league.
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
          D1 is the highest level of college baseball in the PNW. These programs feature the best pitching, with strikeout rates near 9 K/9 and the lowest walk rates. The run environment is moderate compared to other divisions. D1 programs also play the most non-conference games against other high-level opponents, which can further suppress batting stats.
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
          The GNAC features five PNW schools: Central Washington, Montana State Billings, Northwest Nazarene, Saint Martin's, and Western Oregon. D2 has a high-scoring environment with the highest walk rates and ERAs near 6.00. Pitching depth is at a premium, and strikeout rates are moderate compared to D1.
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
          The Northwest Conference is a nine-team D3 league with strong competitive balance. D3 has a hitter-friendly environment with solid batting averages and OPS figures. Pitching depth is the biggest challenge, as ERAs run higher and strikeout rates are moderate. D3 uses the same aluminum bats as other college divisions but generally faces less dominant pitching.
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
          The CCC is an eight-team NAIA conference with programs across Oregon, Idaho, and British Columbia. NAIA has the highest OPS of any PNW division (.828), with strong batting averages and the most offense-friendly run environment. Some programs (like Lewis-Clark State) have historically competed at a very high level nationally.
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
          The NWAC is the two-year college (JUCO) conference covering Washington and Oregon, with 28 programs across four divisions. The run environment here is the most unique in the PNW. Batting averages are substantially lower (.243) and OPS is the lowest of any division (.670). This reflects a combination of shorter seasons, less experienced hitters, and the development-oriented nature of JUCO programs. NWAC pitching ERAs (4.52) and strikeout rates (7.6 K/9) are competitive with higher divisions, suggesting that pitching development outpaces hitting at this level.
        </P>
        <div className="grid grid-cols-2 gap-3 my-3 text-center">
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">.243</p><p className="text-[10px] text-gray-500">Avg BA</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">.670</p><p className="text-[10px] text-gray-500">Avg OPS</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">4.52</p><p className="text-[10px] text-gray-500">Avg ERA</p></div>
          <div className="bg-gray-50 rounded p-2"><p className="text-lg font-bold text-gray-800">7.6</p><p className="text-[10px] text-gray-500">Avg K/9</p></div>
        </div>
      </Card>
    </div>
  )
}

// ============================================================
// ABOUT SECTION
// ============================================================
function AboutSection() {
  return (
    <div>
      <Card title="Why This Site Exists">
        <P>
          NW Baseball Stats was created to bring modern analytics to Northwest baseball. While MLB has FanGraphs, Baseball Reference, and Statcast, college baseball, especially at the D2, D3, NAIA, and JUCO levels, has almost no publicly available advanced statistics. We wanted to change that.
        </P>
        <P>
          Every player at every level deserves to have their contributions measured fairly. A catcher at a JUCO who's putting up a 150 wRC+ should be visible to four-year programs looking for transfers. A D3 pitcher with a 2.50 FIP should be recognized even if their ERA is inflated by poor defense. That's the gap this site fills.
        </P>
      </Card>

      <Card title="How the Site Was Built" subtitle="Full transparency into our tech stack and process">
        <P>
          This entire site (frontend, backend, database, scrapers, advanced stats engine, and all) was built collaboratively by a human and an AI (Claude by Anthropic). The AI handled the coding implementation while the human drove the vision, design decisions, data validation, and quality control. Neither could have built this alone.
        </P>

        <div className="my-4 space-y-4">
          <div>
            <h4 className="text-sm font-bold text-gray-800 mb-1">Frontend</h4>
            <p className="text-sm text-gray-600">
              React 18 with React Router for navigation. Styled with Tailwind CSS for a consistent, responsive design. Vite as the build tool for fast development. Recharts and TanStack Table for data visualization and sortable tables.
            </p>
          </div>
          <div>
            <h4 className="text-sm font-bold text-gray-800 mb-1">Backend</h4>
            <p className="text-sm text-gray-600">
              Python FastAPI serving a REST API. SQLite as the database, which is lightweight, portable, and more than sufficient for our data volume. The entire database is a single file that can be backed up or moved easily.
            </p>
          </div>
          <div>
            <h4 className="text-sm font-bold text-gray-800 mb-1">Data Collection</h4>
            <p className="text-sm text-gray-600">
              Five custom Python scrapers (one per division) collect stats from each team's official athletics website. D1/D2/D3/NAIA teams use Sidearm Sports platforms; NWAC uses PrestoSports. The scrapers handle multiple site formats, JavaScript-rendered pages, and various HTML structures using BeautifulSoup and Requests. Win-loss records are automatically extracted during each scraper run.
            </p>
          </div>
          <div>
            <h4 className="text-sm font-bold text-gray-800 mb-1">Advanced Stats Engine</h4>
            <p className="text-sm text-gray-600">
              A custom Python module computes all advanced statistics from raw box score data. wOBA uses division-specific linear weights. FIP uses a division-calibrated constant. WAR combines batting runs, positional adjustments, replacement level, and FIP-based pitching value. All formulas are derived from public sabermetric research (primarily FanGraphs methodology) and adapted for the college context.
            </p>
          </div>
          <div>
            <h4 className="text-sm font-bold text-gray-800 mb-1">Data Pipeline</h4>
            <p className="text-sm text-gray-600">
              Scrape raw stats → compute traditional rates → compute advanced metrics (wOBA, FIP, SIERA) → compute league averages per division → recalculate league-adjusted stats (wRC+, FIP+, ERA+) → compute WAR. This pipeline runs on demand and can be triggered for individual divisions or all at once.
            </p>
          </div>
        </div>
      </Card>

      <Card title="Data Sources">
        <P>
          All player statistics are scraped from official team athletics websites. We do not fabricate or estimate raw stats. Every at-bat, strikeout, and inning pitched comes from the official source. Advanced stats are then computed from these raw numbers using the formulas described on this page.
        </P>
        <div className="my-3 space-y-1.5">
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">D1, D2, D3, NAIA:</span> Sidearm Sports platform, individual team stats pages hosted on each school's athletics domain.</p>
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">NWAC:</span> PrestoSports (nwacsports.com), centralized stats platform for all NWAC teams.</p>
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">D3 (Willamette):</span> PrestoSports (nwcsports.com), Northwest Conference stats platform.</p>
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">Win-loss records:</span> Automatically extracted from stats/schedule pages during each scraper run, with fallback to conference standings pages.</p>
        </div>
      </Card>

      <Card title="Coverage">
        <P>
          We currently track 57 teams across five divisions in the Northwest, covering Washington, Oregon, Idaho, Montana, and British Columbia:
        </P>
        <div className="my-3 space-y-1.5">
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">NCAA D1 (7 teams):</span> Oregon, Oregon State, Washington, Washington State, Gonzaga, Portland, Seattle U</p>
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">NCAA D2 (5 teams):</span> Central Washington, Montana State Billings, Northwest Nazarene, Saint Martin's, Western Oregon</p>
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">NCAA D3 (9 teams):</span> George Fox, Lewis & Clark, Linfield, Pacific, PLU, UPS, Whitman, Whitworth, Willamette</p>
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">NAIA (8 teams):</span> Bushnell, College of Idaho, Corban, Eastern Oregon, Lewis-Clark State, Oregon Tech, UBC, Warner Pacific</p>
          <p className="text-sm text-gray-600"><span className="font-semibold text-gray-700">NWAC (28 teams):</span> All community college programs across four divisions (East, North, South, West)</p>
        </div>
      </Card>

      <Card title="Open Questions & Future Work">
        <P>
          This is a living project. Things we're actively working on or thinking about:
        </P>
        <div className="my-3 space-y-1.5 text-sm text-gray-600">
          <p><span className="font-semibold text-gray-700">Park factors:</span> We plan to develop team-specific park factors based on home/away run differentials once we have enough game-level data.</p>
          <p><span className="font-semibold text-gray-700">Baserunning value:</span> Adding stolen base and baserunning components to oWAR when we can source game-level base advancement data.</p>
          <p><span className="font-semibold text-gray-700">Historical data:</span> Building out prior seasons to enable year-over-year comparisons and development tracking for multi-year players.</p>
          <p><span className="font-semibold text-gray-700">Feedback welcome:</span> If you spot a data error, have a methodology suggestion, or just want to talk PNW baseball, we'd love to hear from you.</p>
        </div>
      </Card>
    </div>
  )
}

// ============================================================
// MAIN GLOSSARY PAGE
// ============================================================
export default function Glossary() {
  const [activeSection, setActiveSection] = useState('batting')

  const renderSection = () => {
    switch (activeSection) {
      case 'batting': return <BattingSection />
      case 'pitching': return <PitchingSection />
      case 'war': return <WarSection />
      case 'environment': return <EnvironmentSection />
      case 'about': return <AboutSection />
      default: return <BattingSection />
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-1">Glossary & Methodology</h1>
      <p className="text-sm text-gray-500 mb-4">Full transparency into every stat, formula, and decision behind this site.</p>

      {/* Section tabs */}
      <div className="flex gap-1 mb-5 overflow-x-auto pb-1">
        {SECTIONS.map(s => (
          <button
            key={s.id}
            onClick={() => setActiveSection(s.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              activeSection === s.id
                ? 'bg-nw-teal text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Active section content */}
      <div className="max-w-3xl">
        {renderSection()}
      </div>
    </div>
  )
}
