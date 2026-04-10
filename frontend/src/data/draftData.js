// ─── School → Logo mapping ──────────────────────────────────
// College teams use their actual logo; high school / unknown use NW logo
const SCHOOL_LOGOS = {
  'Oregon': '/logos/teams/oregon.svg',
  'Oregon State': '/logos/teams/oregon_st.svg',
  'Washington': '/logos/teams/uw.svg',
  'Washington St': '/logos/teams/washington_state.png',
  'Gonzaga': '/logos/teams/gonzaga.png',
  'Portland': '/logos/teams/portland.svg',
  'Seattle U': '/logos/teams/seattle_u.svg',
  'Pacific': '/logos/teams/pacific.png',
  'Bushnell': '/logos/bushnell.png',
  'LC State': '/logos/teams/lcsc.svg',
  'Eastern Oregon': '/logos/teams/eou.png',
  'Warner Pacific': '/logos/warner_pacific.png',
  'British Columbia': '/logos/teams/ubc.svg',
  'UBC': '/logos/teams/ubc.svg',
  'Lower Columbia': '/logos/teams/landc.png',
  'George Fox': '/logos/george_fox.png',
  'Linfield': '/logos/teams/linfield.svg',
  'Corban': '/logos/teams/corban.svg',
  'Whitworth': '/logos/teams/whitworth.png',
  'Whitman': '/logos/teams/whitman.svg',
}

const NW_LOGO = '/favicon.png'

export function getSchoolLogo(school) {
  // Try exact match first
  if (SCHOOL_LOGOS[school]) return SCHOOL_LOGOS[school]
  // Try matching school name as a substring (e.g. "Oregon" in "Oregon State")
  for (const [key, logo] of Object.entries(SCHOOL_LOGOS)) {
    if (school.includes(key)) return logo
  }
  // Fallback to NW logo for high schoolers etc.
  return NW_LOGO
}

export const DRAFT_DATA = {
  '26': {
    year: 2026,
    lastUpdated: '2026-04-10',
    prospects: [
      { rank: 1, name: 'Sean Duncan', pos: 'LHP', school: 'Terry Fox Secondary (BC)', playerId: null },
      { rank: 2, name: 'Maddox Molony', pos: 'SS', school: 'Oregon', playerId: 3506 },
      { rank: 3, name: 'Ethan Kleinschmit', pos: 'LHP', school: 'Oregon State', playerId: 3644 },
      { rank: 4, name: 'Teagan Scott', pos: 'C', school: 'South Salem (OR)', playerId: null },
      { rank: 5, name: 'Eli Herst', pos: 'RHP', school: 'Seattle Academy (WA)', playerId: null },
      { rank: 6, name: 'Cal Scolari', pos: 'RHP', school: 'Oregon', playerId: 3632 },
      { rank: 7, name: 'Eric Segura', pos: 'RHP', school: 'Oregon State', playerId: 3643 },
      { rank: 8, name: 'Sawyer Nelson', pos: 'SS', school: 'South Salem (OR)', playerId: null },
      { rank: 9, name: 'Wyatt Queen', pos: 'RHP', school: 'Oregon State', playerId: 3649 },
      { rank: 10, name: 'Bryce Collins', pos: 'RHP', school: 'Kelso (WA)', playerId: null },
      { rank: 11, name: 'Finbar O\'Brien', pos: 'RHP', school: 'Gonzaga', playerId: 3575 },
      { rank: 12, name: 'Grady Saunders', pos: 'RHP', school: 'Thurston (OR)', playerId: null },
      { rank: 13, name: 'Collin Clarke', pos: 'P', school: 'Oregon', playerId: 3624 },
      { rank: 14, name: 'Anthony Karis', pos: 'OF', school: 'Gonzaga Prep (WA)', playerId: null },
      { rank: 15, name: 'Kealoha Kepo\'o-Sabate', pos: 'RHP', school: 'Meadowdale (WA)', playerId: null },
      { rank: 16, name: 'Ryan Cooney', pos: 'IF', school: 'Oregon', playerId: 3502 },
      { rank: 17, name: 'Miles Gosztola', pos: 'LHP', school: 'Oregon', playerId: 3637 },
      { rank: 18, name: 'Will Rohrbacher', pos: 'IF', school: 'Bainbridge (WA)', playerId: null },
      { rank: 19, name: 'Erik Hoffberg', pos: 'LHP', school: 'Gonzaga', playerId: 3568 },
      { rank: 20, name: 'Drew Smith', pos: '3B', school: 'Oregon', playerId: null },
      { rank: 21, name: 'Colton Bower', pos: 'C', school: 'Washington', playerId: 3484 },
      { rank: 22, name: 'Noah Kenney', pos: 'RHP', school: 'Washington', playerId: 3611 },
      { rank: 23, name: 'Jackson Jaha', pos: 'UTIL', school: 'LC State', playerId: 2714 },
      { rank: 24, name: 'Trenton Hertzog', pos: 'UTIL', school: 'Tualatin (OR)', playerId: null },
      { rank: 25, name: 'Zach Bowman', pos: 'LHP', school: 'Gonzaga', playerId: 3570 },
      { rank: 26, name: 'Trey Newmann', pos: 'RHP', school: 'Portland', playerId: 3601 },
      { rank: 27, name: 'Mikey Bell', pos: 'INF', school: 'Gonzaga', playerId: 3550 },
      { rank: 28, name: 'Donny Tober', pos: 'RHP', school: 'Warner Pacific', playerId: 2950 },
      { rank: 29, name: 'Dominic Hellman', pos: 'UTIL', school: 'Oregon', playerId: 3504 },
      { rank: 30, name: 'Gavin Roy', pos: 'SS', school: 'Washington St', playerId: null },
      { rank: 31, name: 'Albert Roblez', pos: 'RHP', school: 'Oregon State', playerId: 3647 },
      { rank: 32, name: 'Payton Knowles', pos: 'UTIL', school: 'Seattle U', playerId: 3687 },
      { rank: 33, name: 'Maddox Haley', pos: 'UTIL', school: 'Gonzaga', playerId: null },
      { rank: 34, name: 'Will Anderson', pos: 'LHP', school: 'British Columbia', playerId: 2994 },
      { rank: 35, name: 'Austin Wolfe', pos: 'LHP', school: 'Bushnell', playerId: 2921 },
      { rank: 36, name: 'August Ware', pos: 'LHP', school: 'Glencoe (OR)', playerId: null },
      { rank: 37, name: 'Michael Revell', pos: 'RHP', school: 'Richland (WA)', playerId: null },
      { rank: 38, name: 'James Brock', pos: 'RHP', school: 'UBC', playerId: 2993 },
      { rank: 39, name: 'Easton Talt', pos: 'CF', school: 'Oregon State', playerId: null },
      { rank: 40, name: 'Jack Brooks', pos: 'CF', school: 'Oregon', playerId: null },
      { rank: 41, name: 'Neal Burtis', pos: 'LHP', school: 'Tahoma (WA)', playerId: null },
      { rank: 42, name: 'Jacob Courtney', pos: 'RHP', school: 'Bushnell', playerId: 2928 },
      { rank: 43, name: 'Jace Nagler', pos: 'SS', school: 'Eastern Oregon', playerId: 2744 },
      { rank: 44, name: 'Zach Edwards', pos: 'RHP', school: 'Oregon State', playerId: null },
      { rank: 45, name: 'Jace Taylor', pos: 'RHP', school: 'LC State', playerId: 2737 },
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
