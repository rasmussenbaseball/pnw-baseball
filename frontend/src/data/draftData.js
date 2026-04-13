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
  'Warner Pacific': '/logos/warner_pacific.png',
  'British Columbia': '/logos/teams/ubc.svg',
  'UBC': '/logos/teams/ubc.svg',
  'George Fox': '/logos/george_fox.png',
  'Linfield': '/logos/teams/linfield.svg',
  'Corban': '/logos/teams/corban.svg',
  'Whitworth': '/logos/teams/whitworth.png',
  'Whitman': '/logos/teams/whitman.svg',
  'Willamette': '/logos/willamette.svg',
  // Community colleges
  'Lower Columbia': '/logos/nwac/lower_columbia.png',
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
    lastUpdated: '2026-04-13',
    prospects: [
      { rank: 1, name: 'Sean Duncan', pos: 'LHP', school: 'Terry Fox Secondary (BC)', playerId: null, report: 'Sean Duncan, the top arm in the PNW is a heralded veteran despite being barely 18 years old on draft day. Duncan moves out of an unorthodox setup but gets into some really good positions on the mound, allowing him to work into the mid to upper 90s. Working with above average extension, Duncan has a full arsenal with a true putaway changeup, and a slider that has trended up as of late. Duncan has experience playing against professionals already, like most Canadian stars he\'s played against Dominican stars and even pitched in the MLB Draft League. His combination of present stuff, command, and projectability make him a first round caliber player that should slot in nicely to the middle of day one come July.', reportDate: '2026-04-13' },
      { rank: 2, name: 'Maddox Molony', pos: 'SS', school: 'Oregon', playerId: 3506, report: 'Maddox Molony has had a tumultuous 2026, but make no mistake, Molony is a day one talent in the draft. Previously seen as a possible top-ten pick in July, Molony is hitting just .238 in April with a lesser power output than last season. While his quality of contact hasn\'t been great, a .245 BABIP points toward poor batted ball luck hurting his baseline statistics. Molony projects to stick at shortstop at the next level, with a plus glove and above average run times on the bases. Power at the next level as always been a sticking point with Molony, and scouts will have to take a hard look at his underlying metrics to properly rate him in July. For now, he fits into the mid to backend of day one.', reportDate: '2026-04-13' },
      { rank: 3, name: 'Ethan Kleinschmit', pos: 'LHP', school: 'Oregon State', playerId: 3644, report: 'Kleinschmit, a Linn-Benton CC product, has been Dax Whitney\'s running mate for two years, solidifying the Beaver rotation as one of the best in the country. The lefty has some funk to him, with unique release traits helping his below average velocity succeed. After a stellar 2025, Kleinschmit has all but replicated the same numbers in 2026, striking out 31% of batters while running average walk rates and weak quality of contact numbers. While there is always some reliever risk with a funky lefty, Kleinschmit will be drafted and developed as a starter with the hope of expanding his offerings in the future.', reportDate: '2026-04-13' },
      { rank: 4, name: 'Teagan Scott', pos: 'C', school: 'South Salem (OR)', playerId: null, report: 'Teagan Scott is one of the most interesting prep profiles in the \'26 draft. The South Salem catcher has the frame and tools to be a catcher for a long time, with a great arm and solid receiving skills that will intrigue teams. Offensively, Scott is confusing. It\'s a future power over hit profile that makes contact at an incredibly high clip due to swing decisions. Scott hits the ball on the ground too much, and rarely gets to his pullside, anchoring his power output but giving hope for the future. Plus bat speed gives Scott advanced exit velocities for a 17-year-old, but his approach at the plate isn\'t pro-ready. His passivity can often cross a line toward hurting the quality of his at bats. Early adjustments in 2026 point toward a player that has continued to level up his game. A strong late spring with some slight adjustments could shoot Scott up draft boards, giving him early day two upside.', reportDate: '2026-04-13' },
      { rank: 5, name: 'Eli Herst', pos: 'RHP', school: 'Seattle Academy (WA)', playerId: null, report: 'Eli Herst has long been a heralded prospect in the Pacific Northwest, the brother of standout D3 pitcher Aaron Herst. Eli has long levers and an athletic build that allows him to be a smooth operator on the mound. His velocity can fluctuate at times, often working in the low 90s with some deception in his release. His fastball shape is suboptimal and will likely need to be protected at the next level. Both his breaker and changeup are strong secondary offerings that point to Herst being a starter for a long time.', reportDate: '2026-04-13' },
      { rank: 6, name: 'Cal Scolari', pos: 'RHP', school: 'Oregon', playerId: 3632 },
      { rank: 7, name: 'Eric Segura', pos: 'RHP', school: 'Oregon State', playerId: 3643 },
      { rank: 8, name: 'Sawyer Nelson', pos: 'SS', school: 'South Salem (OR)', playerId: null },
      { rank: 9, name: 'Wyatt Queen', pos: 'RHP', school: 'Oregon State', playerId: 3649 },
      { rank: 10, name: 'Ryan Cooney', pos: 'IF', school: 'Oregon', playerId: 3502 },
      { rank: 11, name: 'Bryce Collins', pos: 'RHP', school: 'Kelso (WA)', playerId: null },
      { rank: 12, name: 'Collin Clarke', pos: 'P', school: 'Oregon', playerId: 3624 },
      { rank: 13, name: 'Grady Saunders', pos: 'RHP', school: 'Thurston (OR)', playerId: null },
      { rank: 14, name: 'Noah Kenney', pos: 'RHP', school: 'Washington', playerId: 3611 },
      { rank: 15, name: 'Miles Gosztola', pos: 'LHP', school: 'Oregon', playerId: 3637 },
      { rank: 16, name: 'Anthony Karis', pos: 'OF', school: 'Gonzaga Prep (WA)', playerId: null },
      { rank: 17, name: 'Kealoha Kepo\'o-Sabate', pos: 'RHP', school: 'Meadowdale (WA)', playerId: null },
      { rank: 18, name: 'Finbar O\'Brien', pos: 'RHP', school: 'Gonzaga', playerId: 3575 },
      { rank: 19, name: 'Will Rohrbacher', pos: 'IF', school: 'Bainbridge (WA)', playerId: null },
      { rank: 20, name: 'Erik Hoffberg', pos: 'LHP', school: 'Gonzaga', playerId: 3568 },
      { rank: 21, name: 'Drew Smith', pos: '3B', school: 'Oregon', playerId: null },
      { rank: 22, name: 'Trenton Hertzog', pos: 'UTIL', school: 'Tualatin (OR)', playerId: null },
      { rank: 23, name: 'Colton Bower', pos: 'C', school: 'Washington', playerId: 3484 },
      { rank: 24, name: 'Zach Bowman', pos: 'LHP', school: 'Gonzaga', playerId: 3570 },
      { rank: 25, name: 'Trey Newmann', pos: 'RHP', school: 'Portland', playerId: 3601 },
      { rank: 26, name: 'Mikey Bell', pos: 'INF', school: 'Gonzaga', playerId: 3550 },
      { rank: 27, name: 'Dominic Hellman', pos: 'UTIL', school: 'Oregon', playerId: 3504 },
      { rank: 28, name: 'Albert Roblez', pos: 'RHP', school: 'Oregon State', playerId: 3647 },
      { rank: 29, name: 'Jackson Jaha', pos: 'UTIL', school: 'LC State', playerId: 2714 },
      { rank: 30, name: 'Will Anderson', pos: 'LHP', school: 'British Columbia', playerId: 2994 },
      { rank: 31, name: 'Austin Wolfe', pos: 'LHP', school: 'Bushnell', playerId: 2921 },
      { rank: 32, name: 'Gavin Roy', pos: 'SS', school: 'Washington St', playerId: null },
      { rank: 33, name: 'Payton Knowles', pos: 'UTIL', school: 'Seattle U', playerId: 3687 },
      { rank: 34, name: 'Maddox Haley', pos: 'UTIL', school: 'Gonzaga', playerId: null },
      { rank: 35, name: 'August Ware', pos: 'LHP', school: 'Glencoe (OR)', playerId: null },
      { rank: 36, name: 'Jacob Courtney', pos: 'RHP', school: 'Bushnell', playerId: 2928 },
      { rank: 37, name: 'Michael Revell', pos: 'RHP', school: 'Richland (WA)', playerId: null },
      { rank: 38, name: 'Easton Talt', pos: 'CF', school: 'Oregon State', playerId: null },
      { rank: 39, name: 'James Brock', pos: 'RHP', school: 'UBC', playerId: 2993 },
      { rank: 40, name: 'Jace Taylor', pos: 'RHP', school: 'LC State', playerId: 2737 },
      { rank: 41, name: 'Jack Brooks', pos: 'CF', school: 'Oregon', playerId: null },
      { rank: 42, name: 'Donny Tober', pos: 'RHP', school: 'Warner Pacific', playerId: 2950 },
      { rank: 43, name: 'Neal Burtis', pos: 'LHP', school: 'Tahoma (WA)', playerId: null },
      { rank: 44, name: 'Jace Nagler', pos: 'SS', school: 'Eastern Oregon', playerId: 2744 },
      { rank: 45, name: 'Zach Edwards', pos: 'RHP', school: 'Oregon State', playerId: null },
      { rank: 46, name: 'Albert Jennings', pos: 'OF', school: 'Bushnell', playerId: 2894 },
      { rank: 47, name: 'Quinn Hubbs', pos: 'LHP', school: 'Lower Columbia', playerId: 160 },
      { rank: 48, name: 'Jacob Rolling', pos: 'SS', school: 'Jesuit (OR)', playerId: null },
      { rank: 49, name: 'Christopher Moore', pos: 'SS', school: 'Eastlake (WA)', playerId: null },
      { rank: 50, name: 'Will Shelor', pos: 'CF', school: 'Pacific', playerId: 3350 },
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
