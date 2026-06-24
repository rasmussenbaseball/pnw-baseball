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
  "26": {
    "year": 2026,
    "lastUpdated": "2026-06-23",
    "prospects": [
      {
        "rank": 1,
        "name": "Sean Duncan",
        "pos": "LHP",
        "year": "PREP",
        "school": "Terry Fox Secondary (BC)",
        "commit": "Vanderbilt",
        "playerId": null,
        "report": "Sean Duncan, the top arm in the PNW, is a heralded veteran despite being barely 18 years old on draft day. Duncan moves out of an unorthodox setup but gets into some really good positions on the mound, allowing him to work into the mid to upper 90s. Working with above-average extension, Duncan has a full arsenal with a true putaway changeup and a slider that has trended up as of late. Duncan has experience playing against professionals already. Like most Canadian stars, he's played against Dominican stars and even pitched in the MLB Draft League. His combination of present stuff, command, and projectability makes him a first-round caliber player that should slot in nicely to the middle of day one come July. A reported arm injury as of ~May 2026 has made Duncan's draft future much more uncertain.",
        "reportAuthor": "Nate Rasmussen",
        "reportDate": "2026-05-29"
      },
      {
        "rank": 2,
        "movement": "up",
        "name": "Teagan Scott",
        "pos": "C",
        "year": "PREP",
        "school": "South Salem (OR)",
        "commit": "Oregon St",
        "playerId": null,
        "report": "Teagan Scott is one of the most interesting prep profiles in the '26 draft. The South Salem catcher has the frame and tools to be a catcher for a long time, with a great arm and solid receiving skills that will intrigue teams. Offensively, Scott is confusing. It's a future power over hit profile that makes contact at an incredibly high clip due to swing decisions. Scott hits the ball on the ground too much, and rarely gets to his pullside, anchoring his power output but giving hope for the future. Plus bat speed gives Scott advanced exit velocities for a 17-year-old, but his approach at the plate isn't pro-ready. His passivity can often cross a line toward hurting the quality of his at bats. Early adjustments in 2026 point toward a player that has continued to level up his game. A strong late spring with some slight adjustments could shoot Scott up draft boards, giving him early day two upside.",
        "reportAuthor": "Nate Rasmussen",
        "reportDate": "2026-04-13"
      },
      {
        "rank": 3,
        "name": "Cal Scolari",
        "pos": "RHP",
        "year": "JR",
        "school": "Oregon",
        "playerId": 3632
      },
      {
        "rank": 4,
        "name": "Ethan Kleinschmit",
        "pos": "LHP",
        "year": "JR",
        "school": "Oregon State",
        "playerId": 3644,
        "report": "Kleinschmit, a Linn-Benton CC product, has been Dax Whitney's running mate for two years, solidifying the Beaver rotation as one of the best in the country. The lefty has some funk to him, with unique release traits helping his below average velocity succeed. After a stellar 2025, Kleinschmit has all but replicated the same numbers in 2026, striking out 31% of batters while running average walk rates and weak quality of contact numbers. While there is always some reliever risk with a funky lefty, Kleinschmit will be drafted and developed as a starter with the hope of expanding his offerings in the future.",
        "reportAuthor": "Nate Rasmussen",
        "reportDate": "2026-04-13"
      },
      {
        "rank": 5,
        "movement": "up",
        "name": "Sawyer Nelson",
        "pos": "SS",
        "year": "PREP",
        "school": "South Salem (OR)",
        "commit": "LMU",
        "playerId": null
      },
      {
        "rank": 6,
        "name": "Ryan Cooney",
        "pos": "IF",
        "year": "JR",
        "school": "Oregon",
        "playerId": 3502,
        "report": "Cooney arrived on campus two years ago and immediately made an impact for the Ducks, playing in 47 games his freshman year. While he started off rocky with the bat, his sophomore season was a true breakout, with a .416 wOBA and .155 wRC+ placing him toward the top of the PNW leaderboards. Walking more than he struck out, Cooney is a contact first second baseman at the next level, which will inevitably push him down draft boards. His in-game power has continued to grow this year, though, with a .204 ISO making him a true extra-base threat in the Big Ten. Cooney struggled on the Cape last summer, hitting a mere .227 with some swing and miss issues, but it's no stretch to put a plus hit tool on him based on his track record. His swing is compact and sound, allowing him to spray the ball to all fields, stretching singles into doubles with 70-grade speed. Cooney could easily sneak his way into the first half of day two with a strong finish to his junior campaign.",
        "reportAuthor": "Nate Rasmussen",
        "reportDate": "2026-04-13"
      },
      {
        "rank": 7,
        "movement": "down",
        "name": "Eli Herst",
        "pos": "RHP",
        "year": "PREP",
        "school": "Seattle Academy (WA)",
        "commit": "Vanderbilt",
        "playerId": null,
        "report": "Eli Herst has long been a heralded prospect in the Pacific Northwest, the brother of standout D3 pitcher Aaron Herst. Eli has long levers and an athletic build that allows him to be a smooth operator on the mound. His velocity can fluctuate at times, often working in the low 90s with some deception in his release. His fastball shape is suboptimal and will likely need to be protected at the next level. Both his breaker and changeup are strong secondary offerings that point to Herst being a starter for a long time.",
        "reportAuthor": "Nate Rasmussen",
        "reportDate": "2026-04-13"
      },
      {
        "rank": 8,
        "name": "Eric Segura",
        "pos": "RHP",
        "year": "JR",
        "school": "Oregon State",
        "playerId": 3643
      },
      {
        "rank": 9,
        "movement": "down",
        "name": "Maddox Molony",
        "pos": "SS",
        "year": "JR",
        "school": "Oregon",
        "playerId": 3506,
        "report": "Maddox Molony has had a tumultuous 2026, but make no mistake, Molony is a day one talent in the draft. Previously seen as a possible top-ten pick in July, Molony is hitting just .238 in April with a lesser power output than last season. While his quality of contact hasn't been great, a .245 BABIP points toward poor batted ball luck hurting his baseline statistics. Molony projects to stick at shortstop at the next level, with a plus glove and above average run times on the bases. Power at the next level has always been a sticking point with Molony, and scouts will have to take a hard look at his underlying metrics to properly rate him in July. For now, he fits into the mid to backend of day one.",
        "reportAuthor": "Nate Rasmussen",
        "reportDate": "2026-04-13"
      },
      {
        "rank": 10,
        "name": "Wyatt Queen",
        "pos": "RHP",
        "year": "JR",
        "school": "Oregon State",
        "playerId": 3649
      },
      {
        "rank": 11,
        "movement": "down",
        "name": "Grady Saunders",
        "pos": "RHP",
        "year": "PREP",
        "school": "Thurston (OR)",
        "commit": "Oregon St",
        "playerId": null
      },
      {
        "rank": 12,
        "name": "Bryce Collins",
        "pos": "RHP",
        "year": "PREP",
        "school": "Kelso (WA)",
        "commit": "Mississippi",
        "playerId": null
      },
      {
        "rank": 13,
        "name": "Miles Gosztola",
        "pos": "LHP",
        "year": "JR",
        "school": "Oregon",
        "playerId": 3637,
        "report": "Miles Gosztola is a 20-year-old LHP who just finished his junior year with the Oregon Ducks. This was his first year with the Ducks, as he transferred from Gonzaga, where he played the previous two years. He started off the year in the bullpen and worked his way up to becoming a midweek starter, and by the end of the year, he showed out as one of the Ducks' best weekend starters. He throws from a 3/4 slot and lives in the low 90s with a devastating changeup that gets a lot of whiffs due to its sharp fade as well as its velocity difference, which is 10 MPH slower than his fastball. His fastball has a lot of sink and natural run due to his arm slot. He also has a big sweeper, with which he is able to generate a lot of whiffs against LHH. He has a good strikeout rate of 25.5% and average command with a 9.2 BB%. He can command all three of his pitches, but prefers his changeup to RHH. All around, he is a very cerebral pitcher with good command of his mix who has had a lot of success. With his solid frame of 6'3, 200 lbs and his ability to limit hard contact and strike batters out, he definitely has a future at the next level, especially if his velocity ticks up just a bit.",
        "reportAuthor": "Oliver Duthie",
        "reportDate": "2026-06-10"
      },
      {
        "rank": 14,
        "name": "Anthony Karis",
        "pos": "OF",
        "year": "PREP",
        "school": "Gonzaga Prep (WA)",
        "commit": "Uncommitted",
        "playerId": null
      },
      {
        "rank": 15,
        "name": "Albert Roblez",
        "pos": "RHP",
        "year": "SR",
        "school": "Oregon State",
        "playerId": 3647,
        "report": "Albert Roblez is a 5th-year senior, transferring to Oregon State from Long Beach State. Roblez was elite last year at LBSU, and now anchors an OSU bullpen that might be the best in the country. While a 5th-year closer isn't a prime draft demographic, Roblez is so damn good that he'll get a chance at pro ball. The righty is striking out 55.3% of batters this season, while walking just 4.3%. His 0.31 FIP is the best in the PNW and one of the best marks in the country for pitchers with 10+ IP. He's pitched in 11 games and collected 10 saves. It's an extreme over-the-top arm action that creates shapes batters rarely see. Roblez can create some really tough secondary shapes with big vertical separation off of his fastball. It's the type of deception and funk that organizations covet, especially in a way-underslot deal come July.",
        "reportAuthor": "Nate Rasmussen",
        "reportDate": "2026-04-13"
      },
      {
        "rank": 16,
        "movement": "up",
        "name": "Toby Twist",
        "pos": "P",
        "year": "JR",
        "school": "Oregon",
        "playerId": 3635
      },
      {
        "rank": 17,
        "name": "Dylan Hicks",
        "pos": "P",
        "year": "JC-2",
        "school": "Everett CC",
        "commit": "Oregon St",
        "playerId": 934
      },
      {
        "rank": 18,
        "name": "Drew Smith",
        "pos": "3B",
        "year": "SR",
        "school": "Oregon",
        "playerId": 3500
      },
      {
        "rank": 19,
        "name": "Kealoha Kepo'o-Sabate",
        "pos": "RHP",
        "year": "PREP",
        "school": "Meadowdale (WA)",
        "commit": "Texas Tech",
        "playerId": null
      },
      {
        "rank": 20,
        "movement": "up",
        "name": "Nick Lewis",
        "pos": "LHP",
        "year": "R-SO",
        "school": "Washington St",
        "playerId": 3658,
        "report": "Nick Lewis, a LHP out of Washington State, won the Mountain West pitcher of the year this spring in his second full season with the Cougs. His ERA dropped from 6.69 to a conference-leading 2.97 in 100 innings. He has a unique low 3/4 release with elite command, which lets his high 80s fastball play up. He has a great feel for all three of his pitches, and this shows, as he has the ability to zone all of his pitches, which led him to an above-average 6.4 BB%, which was in the 82nd percentile. His strengths are his ability to create soft contact and go deep into games, as he averaged 8.1 IP in his last four games of the season with an impressive complete-game win against Oregon St to end his year. His changeup and breaking ball are not going to wow stuff models away, but his ability to throw them consistently and often with unique release traits have let him have tremendous success this past year, showing a true number one at the Division I level.",
        "reportAuthor": "Oliver Duthie",
        "reportDate": "2026-06-10"
      },
      {
        "rank": 21,
        "movement": "up",
        "name": "Max Hartman",
        "pos": "OF",
        "year": "SR",
        "school": "Washington St",
        "playerId": 3534
      },
      {
        "rank": 22,
        "name": "Colton Bower",
        "pos": "C",
        "year": "R-JR",
        "school": "Washington",
        "playerId": 3484
      },
      {
        "rank": 23,
        "movement": "up",
        "name": "Neal Burtis",
        "pos": "LHP",
        "year": "PREP",
        "school": "Tahoma (WA)",
        "commit": "Oregon St",
        "playerId": null
      },
      {
        "rank": 24,
        "name": "Trenton Hertzog",
        "pos": "UTIL",
        "year": "PREP",
        "school": "Tualatin (OR)",
        "commit": "Oregon",
        "playerId": null
      },
      {
        "rank": 25,
        "name": "Jace Taylor",
        "pos": "RHP",
        "year": "SR",
        "school": "LC State",
        "playerId": 2737,
        "report": "Jace Taylor is a big 6-foot-5 RHP from LC State who relies heavily on his high ride fastball coming from an over-the-top slot. He does not get much extension down the mound, but has strong vertical movement on the heater, and lives up in the zone with it, normally in the low 90s, touching the mid 90s. He has a four-pitch mix, with a curveball, slider, and changeup, with his best off-speed being his depthy curveball. The pitch garners swing and miss and plays well off of his top-shelf heater. He had a lot of success this past year, playing for nationally ranked LCSC, which has had plenty of draft picks throughout its history. He has always had the strikeout ability, as he has been in the 98th K percentile the past three years at LC State as well as for the Wenatchee Applesox in the WCL. He threw to a 0.86 ERA with 45 Ks to 13 BBs, showing average command with his control still burgeoning. He is a big body with a lot of confidence in his strikeout ability; however, he has not thrown many innings in the past three years (51.1 at LC State with 31.1 coming this past year). He does not have great feel for his off-speed, which causes him to throw it mostly when he is ahead in the count. His present velocity and frame are pro-ready, with questions coming from the other parts of the operation. There is plenty of clay for a professional organization to mold into a strong reliever.",
        "reportAuthor": "Oliver Duthie",
        "reportDate": "2026-06-09"
      },
      {
        "rank": 26,
        "movement": "down",
        "name": "Finbar O'Brien",
        "pos": "RHP",
        "year": "JR",
        "school": "Gonzaga",
        "playerId": 3575
      },
      {
        "rank": 27,
        "name": "Trey Newmann",
        "pos": "RHP",
        "year": "JR",
        "school": "Portland",
        "playerId": 3601
      },
      {
        "rank": 28,
        "name": "Jackson Jaha",
        "pos": "UTIL",
        "year": "R-JR",
        "school": "LC State",
        "playerId": 2714,
        "report": "Jackson Jaha was selected in the 15th round of the 2022 draft by the New York Mets, with Jaha electing to head to Oregon instead. After a forgettable freshman year with the Ducks, Jaha reemerged at Linn-Benton CC in 2025. He then transferred to LC State, the most decorated school in the PNW, for his 2026 season. As of right now, Jaha is putting up the best batting season in the last decade of baseball in the region. He's batting .483 with a .448 ISO, while walking and striking out at a 19% rate. Jaha has split time between 3B and DH, with a move to 1B likely at the next level. The story of Jaha is complicated, but there has never been a question about his raw talent, which has been on full display this year. With LC State ranked as the #1 NAIA team in the country, Jaha will have a chance to continue to prove his prowess into the summer.",
        "reportAuthor": "Nate Rasmussen",
        "reportDate": "2026-04-13"
      },
      {
        "rank": 29,
        "name": "August Ware",
        "pos": "LHP",
        "year": "PREP",
        "school": "Glencoe (OR)",
        "commit": "Oregon St",
        "playerId": null
      },
      {
        "rank": 30,
        "name": "Erik Hoffberg",
        "pos": "LHP",
        "year": "JR",
        "school": "Gonzaga",
        "playerId": 3568
      },
      {
        "rank": 31,
        "name": "Jacob Wrubleski",
        "pos": "C",
        "year": "JR",
        "school": "Gonzaga",
        "playerId": 3560
      },
      {
        "rank": 32,
        "name": "Easton Talt",
        "pos": "CF",
        "year": "SR",
        "school": "Oregon State",
        "playerId": 3519
      },
      {
        "rank": 33,
        "name": "Gavin Roy",
        "pos": "SS-2B",
        "year": "SR",
        "school": "Washington St",
        "playerId": 3532
      },
      {
        "rank": 34,
        "name": "Isaac Yeager",
        "pos": "P",
        "year": "SR",
        "school": "Oregon St",
        "playerId": 3650
      },
      {
        "rank": 35,
        "movement": "up",
        "name": "Devin Bell",
        "pos": "RHP",
        "year": "SR",
        "school": "Oregon",
        "playerId": 3634
      },
      {
        "rank": 36,
        "movement": "down",
        "name": "Dominic Hellman",
        "pos": "UTIL",
        "year": "SR",
        "school": "Oregon",
        "playerId": 3504
      },
      {
        "rank": 37,
        "name": "Joe Thornton",
        "pos": "RHP",
        "year": "R-SO",
        "school": "Gonzaga",
        "playerId": null
      }
    ]
  },
  "27": {
    "year": 2027,
    "lastUpdated": "2026-06-23",
    "prospects": [
      {
        "rank": 1,
        "name": "Dax Whitney",
        "pos": "RHP",
        "school": "Oregon St",
        "playerId": 3642
      },
      {
        "rank": 2,
        "name": "Will Sanford",
        "pos": "RHP",
        "school": "Oregon",
        "playerId": 3623
      },
      {
        "rank": 3,
        "movement": "up",
        "name": "Karsten Sweum",
        "pos": "LHP",
        "school": "Gonzaga",
        "playerId": 3569
      },
      {
        "rank": 4,
        "name": "Joe Mendazona Jr.",
        "pos": "C",
        "school": "Central (OR)",
        "commit": "TCU",
        "playerId": null
      },
      {
        "rank": 5,
        "name": "Rylan Howe",
        "pos": "RHP",
        "school": "Union (WA)",
        "commit": "Oregon",
        "playerId": null
      },
      {
        "rank": 6,
        "name": "Tanner Bradley",
        "pos": "RHP",
        "school": "Oregon",
        "playerId": 3629
      },
      {
        "rank": 7,
        "name": "Brayden Landry",
        "pos": "SS",
        "school": "Puyallup (WA)",
        "commit": "Washington",
        "playerId": null
      },
      {
        "rank": 8,
        "name": "Wyatt Plyler",
        "pos": "OF",
        "school": "Sumner (WA)",
        "commit": "Wake Forest",
        "playerId": null
      },
      {
        "rank": 9,
        "movement": "up",
        "name": "Tyler Ransom",
        "pos": "LHP",
        "school": "Sugar-Salem (ID)",
        "commit": "Texas A&M",
        "playerId": null
      },
      {
        "rank": 10,
        "movement": "up",
        "name": "JT Girod",
        "pos": "SS",
        "school": "Central (OR)",
        "commit": "Oregon",
        "playerId": null
      },
      {
        "rank": 11,
        "name": "Luke Overbay",
        "pos": "OF",
        "school": "Tumwater (WA)",
        "commit": "Michigan",
        "playerId": null
      },
      {
        "rank": 12,
        "movement": "down",
        "name": "Eli Jones",
        "pos": "RHP",
        "school": "Woodinville (WA)",
        "commit": "Oregon St",
        "playerId": null
      },
      {
        "rank": 13,
        "name": "Jax Giminez",
        "pos": "OF",
        "school": "Oregon",
        "playerId": 3503
      },
      {
        "rank": 14,
        "name": "Reece Johnson",
        "pos": "OF",
        "school": "King's Way (WA)",
        "commit": "Oregon St",
        "playerId": null
      },
      {
        "rank": 15,
        "name": "Cole Katayma-Stall",
        "pos": "SS",
        "school": "Portland",
        "playerId": 3586
      },
      {
        "rank": 16,
        "movement": "down",
        "name": "Adam Haight",
        "pos": "OF",
        "school": "Oregon St",
        "playerId": 3518
      },
      {
        "rank": 17,
        "name": "Mickey McClaskey",
        "pos": "RHP",
        "school": "Gonzaga",
        "playerId": null
      },
      {
        "rank": 18,
        "name": "Paul Vazquez",
        "pos": "3B",
        "school": "Oregon St",
        "playerId": null
      },
      {
        "rank": 19,
        "name": "Luke Morgan",
        "pos": "RHP",
        "school": "Oregon",
        "playerId": null
      },
      {
        "rank": 20,
        "name": "Manny Ehinger",
        "pos": "SS",
        "school": "Sherwood (OR)",
        "commit": "Oregon",
        "playerId": null
      },
      {
        "rank": 21,
        "name": "Harrison Buckingham",
        "pos": "RHP",
        "school": "South Salem (OR)",
        "commit": "Oregon St",
        "playerId": null
      },
      {
        "rank": 22,
        "name": "Trey Swygart",
        "pos": "1B/P",
        "school": "Portland",
        "playerId": null
      }
    ]
  },
  "28": {
    "year": 2028,
    "lastUpdated": "2026-03-15",
    "prospects": [
      {
        "rank": 1,
        "name": "Angel Laya",
        "pos": "OF",
        "school": "Oregon",
        "playerId": 3501
      },
      {
        "rank": 2,
        "name": "Lincoln Moore",
        "pos": "SS",
        "school": "Kentlake (WA)",
        "playerId": null
      },
      {
        "rank": 3,
        "name": "Josh Proctor",
        "pos": "OF/3B",
        "school": "Oregon St",
        "playerId": 3522
      },
      {
        "rank": 4,
        "name": "Brayden Jaksa",
        "pos": "C",
        "school": "Oregon",
        "playerId": 3510
      },
      {
        "rank": 5,
        "name": "Madden Pike",
        "pos": "SS",
        "school": "Puyallup (WA)",
        "playerId": null
      },
      {
        "rank": 6,
        "name": "Mason Pike",
        "pos": "TWP",
        "school": "Oregon St",
        "playerId": 3656
      },
      {
        "rank": 7,
        "name": "Collin McGowan",
        "pos": "C",
        "school": "Battle Ground (WA)",
        "playerId": null
      },
      {
        "rank": 8,
        "name": "Daniel Porras",
        "pos": "OF",
        "school": "Washington",
        "playerId": 3489
      },
      {
        "rank": 9,
        "name": "Sam Smith",
        "pos": "OF",
        "school": "Central Catholic (OR)",
        "playerId": null
      },
      {
        "rank": 10,
        "name": "Zeke Thomas",
        "pos": "RHP",
        "school": "Willamette (OR)",
        "playerId": null
      }
    ]
  }
}

export const DRAFT_YEARS = ['26', '27', '28']
