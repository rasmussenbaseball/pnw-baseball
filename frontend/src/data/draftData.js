// ─── School → Logo mapping ──────────────────────────────────
// Exact school name → logo. Only college/CC teams get logos.
// High school names (with state abbreviations like "(WA)", "(OR)") get the NW logo.
const SCHOOL_LOGOS = {
  // Pac-12 / D1
  'Oregon': '/logos/teams/oregon.svg',
  'Oregon State': '/logos/teams/oregon_st.svg',
  'Oregon St': '/logos/teams/oregon_st.svg',
  'Washington': '/logos/teams/uw.svg',
  'Washington St': '/logos/washington_state.png',
  'Washington State': '/logos/washington_state.png',
  'Gonzaga': '/logos/teams/gonzaga.png',
  'Portland': '/logos/teams/portland.svg',
  'Seattle U': '/logos/teams/seattle_u.svg',
  'Pacific': '/logos/teams/pacific.png',
  // NAIA / small schools
  'Bushnell': '/logos/bushnell.png',
  'LC State': '/logos/teams/lcsc.svg',
  'Eastern Oregon': '/logos/teams/eou.png',
  'Warner Pacific': '/logos/teams/warner_pacific.png',
  'British Columbia': '/logos/teams/ubc.svg',
  'UBC': '/logos/teams/ubc.svg',
  'George Fox': '/logos/george_fox.png',
  'Linfield': '/logos/teams/linfield.svg',
  'Corban': '/logos/teams/corban.svg',
  'Whitworth': '/logos/whitworth.png',
  'Whitman': '/logos/teams/whitman.svg',
  'Willamette': '/logos/willamette.svg',
  // Community colleges
  'Lower Columbia': '/logos/nwac/lower_columbia.png',
  'Everett': '/logos/nwac/everett.png',
}

const NW_LOGO = '/favicon.png'

export function getSchoolLogo(school) {
  // Exact match first (handles "Oregon", "Oregon State", "Gonzaga", etc.)
  if (SCHOOL_LOGOS[school]) return SCHOOL_LOGOS[school]

  // If school has a parenthetical like "(WA)" or "(OR)" or "(BC)" it's a high school
  if (/\([A-Z]{2}\)/.test(school)) return NW_LOGO

  // Try exact-start match: check if school name starts with a known key
  // Sort keys longest-first so "Oregon State" matches before "Oregon"
  const sortedKeys = Object.keys(SCHOOL_LOGOS).sort((a, b) => b.length - a.length)
  for (const key of sortedKeys) {
    if (school === key || school.startsWith(key + ' ')) return SCHOOL_LOGOS[key]
  }

  return NW_LOGO
}

export const DRAFT_DATA = {
  '26': {
    year: 2026,
    lastUpdated: '2026-06-11',
    prospects: [
      { rank: 1, name: 'Sean Duncan', pos: 'LHP', year: 'PREP', school: 'Terry Fox Secondary (BC)', commit: 'Vanderbilt', playerId: null, report: 'Sean Duncan, the top arm in the PNW, is a heralded veteran despite being barely 18 years old on draft day. Duncan moves out of an unorthodox setup but gets into some really good positions on the mound, allowing him to work into the mid to upper 90s. Working with above-average extension, Duncan has a full arsenal with a true putaway changeup and a slider that has trended up as of late. Duncan has experience playing against professionals already. Like most Canadian stars, he\'s played against Dominican stars and even pitched in the MLB Draft League. His combination of present stuff, command, and projectability makes him a first-round caliber player that should slot in nicely to the middle of day one come July. A reported arm injury as of ~May 2026 has made Duncan\'s draft future much more uncertain.', reportDate: '2026-05-29' },
      { rank: 2, movement: 'up', name: 'Teagan Scott', pos: 'C', year: 'PREP', school: 'South Salem (OR)', commit: 'Oregon St', playerId: null, report: 'Teagan Scott is one of the most interesting prep profiles in the \'26 draft. The South Salem catcher has the frame and tools to be a catcher for a long time, with a great arm and solid receiving skills that will intrigue teams. Offensively, Scott is confusing. It\'s a future power over hit profile that makes contact at an incredibly high clip due to swing decisions. Scott hits the ball on the ground too much, and rarely gets to his pullside, anchoring his power output but giving hope for the future. Plus bat speed gives Scott advanced exit velocities for a 17-year-old, but his approach at the plate isn\'t pro-ready. His passivity can often cross a line toward hurting the quality of his at bats. Early adjustments in 2026 point toward a player that has continued to level up his game. A strong late spring with some slight adjustments could shoot Scott up draft boards, giving him early day two upside.', reportDate: '2026-04-13' },
      { rank: 3, name: 'Cal Scolari', pos: 'RHP', year: 'JR', school: 'Oregon', playerId: 3632 },
      { rank: 4, name: 'Ethan Kleinschmit', pos: 'LHP', year: 'JR', school: 'Oregon State', playerId: 3644, report: 'Kleinschmit, a Linn-Benton CC product, has been Dax Whitney\'s running mate for two years, solidifying the Beaver rotation as one of the best in the country. The lefty has some funk to him, with unique release traits helping his below average velocity succeed. After a stellar 2025, Kleinschmit has all but replicated the same numbers in 2026, striking out 31% of batters while running average walk rates and weak quality of contact numbers. While there is always some reliever risk with a funky lefty, Kleinschmit will be drafted and developed as a starter with the hope of expanding his offerings in the future.', reportDate: '2026-04-13' },
      { rank: 5, name: 'Sawyer Nelson', pos: 'SS', year: 'PREP', school: 'South Salem (OR)', commit: 'LMU', playerId: null },
      { rank: 6, name: 'Ryan Cooney', pos: 'IF', year: 'JR', school: 'Oregon', playerId: 3502, report: 'Cooney arrived on campus two years ago and immediately made an impact for the Ducks, playing in 47 games his freshman year. While he started off rocky with the bat, his sophomore season was a true breakout, with a .416 wOBA and .155 wRC+ placing him toward the top of the PNW leaderboards. Walking more than he struck out, Cooney is a contact first second baseman at the next level, which will inevitably push him down draft boards. His in-game power has continued to grow this year, though, with a .204 ISO making him a true extra-base threat in the Big Ten. Cooney struggled on the Cape last summer, hitting a mere .227 with some swing and miss issues, but it\'s no stretch to put a plus hit tool on him based on his track record. His swing is compact and sound, allowing him to spray the ball to all fields, stretching singles into doubles with 70-grade speed. Cooney could easily sneak his way into the first half of day two with a strong finish to his junior campaign.', reportDate: '2026-04-13' },
      { rank: 7, movement: 'down', name: 'Eli Herst', pos: 'RHP', year: 'PREP', school: 'Seattle Academy (WA)', commit: 'Vanderbilt', playerId: null, report: 'Eli Herst has long been a heralded prospect in the Pacific Northwest, the brother of standout D3 pitcher Aaron Herst. Eli has long levers and an athletic build that allows him to be a smooth operator on the mound. His velocity can fluctuate at times, often working in the low 90s with some deception in his release. His fastball shape is suboptimal and will likely need to be protected at the next level. Both his breaker and changeup are strong secondary offerings that point to Herst being a starter for a long time.', reportDate: '2026-04-13' },
      { rank: 8, name: 'Eric Segura', pos: 'RHP', year: 'JR', school: 'Oregon State', playerId: 3643 },
      { rank: 9, movement: 'down', name: 'Maddox Molony', pos: 'SS', year: 'JR', school: 'Oregon', playerId: 3506, report: 'Maddox Molony has had a tumultuous 2026, but make no mistake, Molony is a day one talent in the draft. Previously seen as a possible top-ten pick in July, Molony is hitting just .238 in April with a lesser power output than last season. While his quality of contact hasn\'t been great, a .245 BABIP points toward poor batted ball luck hurting his baseline statistics. Molony projects to stick at shortstop at the next level, with a plus glove and above average run times on the bases. Power at the next level as always been a sticking point with Molony, and scouts will have to take a hard look at his underlying metrics to properly rate him in July. For now, he fits into the mid to backend of day one.', reportDate: '2026-04-13' },
      { rank: 10, name: 'Wyatt Queen', pos: 'RHP', year: 'JR', school: 'Oregon State', playerId: 3649 },
      { rank: 11, name: 'Grady Saunders', pos: 'RHP', year: 'PREP', school: 'Thurston (OR)', commit: 'Oregon St', playerId: null },
      { rank: 12, movement: 'up', name: 'Mikey Bell', pos: 'INF', year: 'SR', school: 'Gonzaga', playerId: 3550 },
      { rank: 13, name: 'Bryce Collins', pos: 'RHP', year: 'PREP', school: 'Kelso (WA)', commit: 'Mississippi', playerId: null },
      { rank: 14, movement: 'up', name: 'Miles Gosztola', pos: 'LHP', year: 'JR', school: 'Oregon', playerId: 3637, report: 'Miles Gosztola is a 20-year-old LHP who just finished his junior year with the Oregon Ducks. This was his first year with the Ducks, as he transferred from Gonzaga, where he played the previous two years. He started off the year in the bullpen and worked his way up to becoming a midweek starter, and by the end of the year, he showed out as one of the Ducks\' best weekend starters. He throws from a 3/4 slot and lives in the low 90s with a devastating changeup that gets a lot of whiffs due to its sharp fade as well as its velocity difference, which is 10 MPH slower than his fastball. His fastball has a lot of sink and natural run due to his arm slot. He also has a big sweeper, with which he is able to generate a lot of whiffs against LHH. He has a good strikeout rate of 25.5% and average command with a 9.2 BB%. He can command all three of his pitches, but prefers his changeup to RHH. All around, he is a very cerebral pitcher with good command of his mix who has had a lot of success. With his solid frame of 6\'3, 200 lbs and his ability to limit hard contact and strike batters out, he definitely has a future at the next level, especially if his velocity ticks up just a bit.', reportDate: '2026-06-10' },
      { rank: 15, movement: 'down', name: 'Noah Kenney', pos: 'RHP', year: 'JR', school: 'Washington', playerId: 3611, report: 'Noah Kenney joined UW from the juco ranks this fall and has quickly emerged as the Huskies best arm. Kenney was a high performer at Folsom Lake CC, punching out 58 batters in 51 innings with a sub-3 ERA. This year, Kenney has a 3.79 FIP in the Big Ten, while increasing his strikeouts to 28.4%. Kenney employs a good changeup and a tight slider. His fastball plays angles well and consistently works above hitters\' barrels. Kenney also works his fastball well at the bottom of the zone as a freeze pitch. There\'s enough clay with Kenney to warrant him being the next UW arm selected in July, after Max Banks was taken last year on day two.', reportDate: '2026-04-13' },
      { rank: 16, movement: 'up', name: 'Albert Roblez', pos: 'RHP', year: 'SR', school: 'Oregon State', playerId: 3647, report: 'Albert Roblez is a 5th-year senior, transferring to Oregon State from Long Beach State. Roblez was elite last year at LBSU, and now anchors an OSU bullpen that might be the best in the country. While a 5th-year closer isn\'t a prime draft demographic, Roblez is so damn good that he\'ll get a chance at pro ball. The righty is striking out 55.3% of batters this season, while walking just 4.3%. His 0.31 FIP is the best in the PNW and one of the best marks in the country for pitchers with 10+ IP. He\'s pitched in 11 games and collected 10 saves. It\'s an extreme over-the-top arm action that creates shapes batters rarely see. Roblez can create some really tough secondary shapes with big vertical separation off of his fastball. It\'s the type of deception and funk that organizations covet, especially in a way-underslot deal come July.', reportDate: '2026-04-13' },
      { rank: 17, name: 'Anthony Karis', pos: 'OF', year: 'PREP', school: 'Gonzaga Prep (WA)', commit: 'Uncommitted', playerId: null },
      { rank: 18, movement: 'up', name: 'Zach Edwards', pos: 'RHP', year: 'SO', school: 'Oregon State', playerId: 3657, report: 'Zach Edwards is one of the best examples of why reliever ERA can be a flawed statistic. At 20 years old, he posted a 5.61 ERA while ranking in the 35th percentile. The stocky right-hander is the definition of a power pitcher, featuring a mid-to-upper-90s four-seam fastball and a hard mid-80s tight slider. His third pitch is a changeup that he mostly attacks hitters with after establishing his electric fastball-slider combination. His biggest strength is his strikeout ability, as he posted a 33% strikeout rate this past season, making him one of Oregon State\'s best relievers. Similar to many hard-throwing, high-strikeout pitchers, he can struggle with command at times, as evidenced by his near 10% walk rate. Edwards is a strikeout machine with a powerful fastball who does not give up many base hits. Last summer, he pitched for the Hyannis Harbor Hawks in the Cape Cod League and had tremendous success, throwing 16 innings with 16 strikeouts, five walks, and only three earned runs allowed. He quickly became one of the club\'s most reliable arms out of the bullpen. He projects as a reliever with late-inning upside if he can become more consistent with his command and continue to refine his off-speed offerings.', reportDate: '2026-06-11' },
      { rank: 19, movement: 'down', name: 'Collin Clarke', pos: 'P', year: 'JR', school: 'Oregon', playerId: 3624 },
      { rank: 20, movement: 'up', name: 'Dylan Hicks', pos: 'P', year: 'JC-2', school: 'Everett', playerId: 934 },
      { rank: 21, name: 'Toby Twist', pos: 'P', year: 'JR', school: 'Oregon', playerId: 3635 },
      { rank: 22, movement: 'up', name: 'Payton Knowles', pos: 'UTIL', year: 'JR', school: 'Seattle U', playerId: 3687 },
      { rank: 23, movement: 'up', name: 'Nick Lewis', pos: 'LHP', year: 'R-SO', school: 'Washington State', playerId: 3658, report: 'Nick Lewis, a LHP out of Washington State, won the Mountain West pitcher of the year this spring in his second full season with the Cougs. His ERA dropped from 6.69 to a conference-leading 2.97 in 100 innings. He has a unique low 3/4 release with elite command, which lets his high 80s fastball play up. He has a great feel for all three of his pitches, and this shows, as he has the ability to zone all of his pitches, which led him to an above-average 6.4 BB%, which was in the 82nd percentile. His strengths are his ability to create soft contact and go deep into games, as he averaged 8.1 IP in his last four games of the season with an impressive complete-game win against Oregon St to end his year. His changeup and breaking ball are not going to wow stuff models away, but his ability to throw them consistently and often with unique release traits have let him have tremendous success this past year, showing a true number one at the Division I level.', reportDate: '2026-06-10' },
      { rank: 24, name: 'Drew Smith', pos: '3B', year: 'SR', school: 'Oregon', playerId: 3500 },
      { rank: 25, movement: 'up', name: 'Max Hartman', pos: 'OF', year: 'SR', school: 'Washington State', playerId: 3534 },
      { rank: 26, name: 'Colton Bower', pos: 'C', year: 'R-JR', school: 'Washington', playerId: 3484 },
      { rank: 27, movement: 'up', name: 'Jace Taylor', pos: 'RHP', year: 'SR', school: 'LC State', playerId: 2737, report: 'Jace Taylor is a big 6-foot-5 RHP from LC State who relies heavily on his high ride fastball coming from an over-the-top slot. He does not get much extension down the mound, but has strong vertical movement on the heater, and lives up in the zone with it, normally in the low 90s, touching the mid 90s. He has a four-pitch mix, with a curveball, slider, and changeup, with his best off-speed being his depthy curveball. The pitch garners swing and miss and plays well off of his top-shelf heater. He had a lot of success this past year, playing for nationally ranked LCSC, which has had plenty of draft picks throughout its history. He has always had the strikeout ability, as he has been in the 98th K percentile the past three years at LC State as well as for the Wenatchee Applesox in the WCL. He threw to a 0.86 ERA with 45 Ks to 13 BBs, showing average command with his control still burgeoning. He is a big body with a lot of confidence in his strikeout ability; however, he has not thrown many innings in the past three years (51.1 at LC State with 31.1 coming this past year). He does not have great feel for his off-speed, which causes him to throw it mostly when he is ahead in the count. His present velocity and frame are pro-ready, with questions coming from the other parts of the operation. There is plenty of clay for a professional organization to mold into a strong reliever.', reportDate: '2026-06-09' },
      { rank: 28, name: 'Kealoha Kepo\'o-Sabate', pos: 'RHP', year: 'PREP', school: 'Meadowdale (WA)', commit: 'Texas Tech', playerId: null },
      { rank: 29, movement: 'up', name: 'Neal Burtis', pos: 'LHP', year: 'PREP', school: 'Tahoma (WA)', commit: 'Oregon St', playerId: null },
      { rank: 30, name: 'Trenton Hertzog', pos: 'UTIL', year: 'PREP', school: 'Tualatin (OR)', commit: 'Oregon', playerId: null },
      { rank: 31, movement: 'down', name: 'Finbar O\'Brien', pos: 'RHP', year: 'JR', school: 'Gonzaga', playerId: 3575 },
      { rank: 32, name: 'Erik Hoffberg', pos: 'LHP', year: 'JR', school: 'Gonzaga', playerId: 3568 },
      { rank: 33, name: 'August Ware', pos: 'LHP', year: 'PREP', school: 'Glencoe (OR)', commit: 'Oregon St', playerId: null },
      { rank: 34, name: 'Jackson Jaha', pos: 'UTIL', year: 'R-JR', school: 'LC State', playerId: 2714, report: 'Jackson Jaha was selected in the 15th round of the 2022 draft by the New York Mets, with Jaha electing to head to Oregon instead. After a forgettable freshman year with the Ducks, Jaha reemerged at Linn-Benton CC in 2025. He then transferred to LC State, the most decorated school in the PNW, for his 2026 season. As of right now, Jaha is putting up the best batting season in the last decade of baseball in the region. He\'s batting .483 with a .448 ISO, while walking and striking out at a 19% rate. Jaha has split time between 3B and DH, with a move to 1B likely at the next level. The story of Jaha is complicated, but there has never been a question about his raw talent, which has been on full display this year. With LC State ranked as the #1 NAIA team in the country, Jaha will have a chance to continue to prove his prowess into the summer.', reportDate: '2026-04-13' },
      { rank: 35, name: 'Jacob Wrubleski', pos: 'C', year: 'JR', school: 'Gonzaga', playerId: 3560 },
      { rank: 36, movement: 'down', name: 'Trey Newmann', pos: 'RHP', year: 'JR', school: 'Portland', playerId: 3601 },
      { rank: 37, name: 'Easton Talt', pos: 'CF', year: 'SR', school: 'Oregon State', playerId: 3519 },
      { rank: 38, name: 'Gavin Roy', pos: 'SS-2B', year: 'SR', school: 'Washington State', playerId: 3532 },
      { rank: 39, name: 'Isaac Yeager', pos: 'P', year: 'SR', school: 'Oregon State', playerId: 3650 },
      { rank: 40, name: 'Devin Bell', pos: 'RHP', year: 'SR', school: 'Oregon', playerId: 3634 },
      { rank: 41, movement: 'down', name: 'Dominic Hellman', pos: 'UTIL', year: 'SR', school: 'Oregon', playerId: 3504 },
      { rank: 42, name: 'Austin Wolfe', pos: 'LHP', year: 'JR', school: 'Bushnell', playerId: 2921, report: 'Austin Wolfe, whom I happen to coach, has a similar career arc to Anderson. Starting as a freshman, Wolfe has eaten innings for Bushnell, but this year, he flipped a switch. After a solid sophomore season, Wolfe spent the summer in the Northwoods, where he was an all-star with a sub-3 ERA. D1\'s were all over him looking for a lefty transfer, but he chose to remain at Bushnell in 2026. This spring, Wolfe is frequently in the upper 80s while touching low 9\'s. The emergence of a cutter to pair with a high-spin slider has helped reduce Wolfe\'s hard-hit rate. His strikeout rate has jumped 6% to 26%, while his walk rate has remained steady below 6%. By FIP, Wolfe is the best starter in the CCC.', reportDate: '2026-04-13' },
      { rank: 43, name: 'Will Anderson', pos: 'LHP', year: 'JR', school: 'British Columbia', playerId: 2994, report: 'Will Anderson has been a workhorse since arriving on campus at British Columbia. Often sitting in the upper 80s, Anderson has a strong left-handed four-pitch mix with great command. His best putaway offering is a changeup that he\'ll throw in any count to any hitter. The lack of present velocity is the one thing holding Anderson back. If he can work further into the 90\'s this spring, he may be the next UBC arm to make the jump to the pros.', reportDate: '2026-04-13' },
      { rank: 44, movement: 'down', name: 'Zach Bowman', pos: 'LHP', year: 'JR', school: 'Gonzaga', playerId: 3570 },
      { rank: 45, name: 'Maddox Haley', pos: 'DH-RF', year: 'JR', school: 'Gonzaga', playerId: 3558 },
      { rank: 46, name: 'Zack Hankins', pos: 'LHP', year: 'PREP', school: 'Taft (OR)', commit: 'Oregon', playerId: null },
      { rank: 47, name: 'Jack Brooks', pos: 'CF', year: 'SR', school: 'Oregon', playerId: 3507 },
      { rank: 48, name: 'Blake Smith', pos: 'P', year: 'SR', school: 'Seattle U', playerId: 3690 },
      { rank: 49, name: 'Justin Feld', pos: 'RHP', year: 'SR', school: 'Gonzaga', playerId: 3574 },
      { rank: 50, name: 'Ryan Featherston', pos: 'P', year: 'JR', school: 'Oregon', playerId: 3631 },
      { rank: 51, name: 'James Brock', pos: 'RHP', year: 'SR', school: 'British Columbia', playerId: 2993 },
      { rank: 52, name: 'Evan Canfield', pos: 'RHP', year: 'R-JR', school: 'LC State', playerId: 2731 },
      { rank: 53, name: 'Donny Tober', pos: 'RHP', year: 'R-JR', school: 'Warner Pacific', playerId: 2950, report: 'Donny Tober has emerged from out of the blue as one of the most talented arms in the PNW. Frequenting 91-94mph from the right side, Tober has competed on both sides of the ball for Warner Pacific. Tober has a 4.75 FIP, with only a 18.3% K rate, but his stuff plays better than his numbers suggest. It\'s a fastball-heavy approach with good secondaries. Tober has frequently thrown 110+ pitches on a week-to-week basis, which may drag down some of his overall numbers a bit. Tober could be a sneaky arm for teams late that want a well-rounded pitcher that is just scratching the surface.', reportDate: '2026-04-13' },
    ],
  },
  '27': {
    year: 2027,
    lastUpdated: '2026-03-15',
    prospects: [
      { rank: 1, name: 'Dax Whitney', pos: 'RHP', school: 'Oregon St', playerId: 3642 },
      { rank: 2, name: 'Jackson Hotchkiss', pos: 'OF', school: 'Washington', playerId: 3492 },
      { rank: 3, name: 'Will Sanford', pos: 'RHP', school: 'Oregon', playerId: 3623 },
      { rank: 4, name: 'Rylan Howe', pos: 'RHP', school: 'Union (WA)', playerId: null },
      { rank: 5, name: 'Tanner Bradley', pos: 'RHP', school: 'Oregon', playerId: 3629 },
      { rank: 6, name: 'Joe Mendazona Jr.', pos: 'C', school: 'Central (OR)', playerId: null },
      { rank: 7, name: 'Brayden Landry', pos: 'SS', school: 'Puyallup (WA)', playerId: null },
      { rank: 8, name: 'Karsten Sweum', pos: 'LHP', school: 'Gonzaga', playerId: 3569 },
      { rank: 9, name: 'Wyatt Plyler', pos: 'OF', school: 'Sumner (WA)', playerId: null },
      { rank: 10, name: 'Luke Overbay', pos: 'OF', school: 'Tumwater (WA)', playerId: null },
      { rank: 11, name: 'Jax Gimenez', pos: 'OF', school: 'Oregon', playerId: 3503 },
      { rank: 12, name: 'Reece Johnson', pos: 'OF', school: 'King\'s Way (WA)', playerId: null },
      { rank: 13, name: 'Adam Haight', pos: 'OF', school: 'Oregon St', playerId: 3518 },
      { rank: 14, name: 'Tyler Ransom', pos: 'LHP', school: 'Sugar-Salem (ID)', playerId: null },
      { rank: 15, name: 'Cole Katayma-Stall', pos: 'SS', school: 'Portland', playerId: 3586 },
    ],
  },
  '28': {
    year: 2028,
    lastUpdated: '2026-03-15',
    prospects: [
      { rank: 1, name: 'Angel Laya', pos: 'OF', school: 'Oregon', playerId: 3501 },
      { rank: 2, name: 'Lincoln Moore', pos: 'SS', school: 'Kentlake (WA)', playerId: null },
      { rank: 3, name: 'Josh Proctor', pos: 'OF/3B', school: 'Oregon St', playerId: 3522 },
      { rank: 4, name: 'Brayden Jaksa', pos: 'C', school: 'Oregon', playerId: 3510 },
      { rank: 5, name: 'Madden Pike', pos: 'SS', school: 'Puyallup (WA)', playerId: null },
      { rank: 6, name: 'Mason Pike', pos: 'TWP', school: 'Oregon St', playerId: 3656 },
      { rank: 7, name: 'Collin McGowan', pos: 'C', school: 'Battle Ground (WA)', playerId: null },
      { rank: 8, name: 'Daniel Porras', pos: 'OF', school: 'Washington', playerId: 3489 },
      { rank: 9, name: 'Sam Smith', pos: 'OF', school: 'Central Catholic (OR)', playerId: null },
      { rank: 10, name: 'Zeke Thomas', pos: 'RHP', school: 'Willamette (OR)', playerId: null },
    ],
  },
}

export const DRAFT_YEARS = ['26', '27', '28']
