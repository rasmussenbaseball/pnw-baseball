#!/usr/bin/env node
/**
 * Build frontend/src/gm/data/non_naia_teams.json from a comprehensive list
 * of NCAA D1, D2, D3 baseball programs plus the existing NWAC JUCO list.
 *
 * Strength scale: -15 to +15. Calibrated so:
 *    13+  national championship favorites (Tier S+)
 *     9-12 College World Series perennials (Tier S)
 *     6-9  regional regulars (Tier A)
 *     3-6  bubble teams / strong mid-major (Tier B)
 *     0-3  conference contender / weak P5 (Tier C)
 *    -2..1 mid-major also-rans (Tier D)
 *    -4..-1 cellar dwellers (Tier E)
 *
 * Non-NAIA strength values are BEST-EFFORT estimates from widely-known
 * program reputation. Swap in real PEAR data when available.
 *
 * Run with:  node scripts/gm/generate_non_naia_teams.js
 */

const fs = require('fs')
const path = require('path')

// ─── Conference defaults — used when a team's strength isn't tuned ────────
// (each conference's "median" team gets this; tuned teams below override it)
const DEFAULT_STRENGTH = {
  // D1
  SEC: 9.0, ACC: 7.0, BIG12: 6.5, BIG_TEN: 4.0,
  WCC: 4.0, BIG_WEST: 4.5, SUN_BELT: 4.5,
  C_USA: 3.5, AAC: 3.0, ASUN: 3.5, BIG_SOUTH: 2.5, SOCON: 4.0,
  BIG_EAST: 3.0, MWC: 2.5, WAC: 2.5, ATLANTIC_10: 1.5,
  AMERICA_EAST: 0.5, CAA: 2.0, PATRIOT: 0.5, IVY: 1.5,
  HORIZON: 1.0, MAAC: 0.5, MAC: 1.5, NEC: -0.5, OVC: 1.5,
  SOUTHLAND: 2.0, SUMMIT: 1.5, SWAC: -1.0, MEAC: -2.0,
  D1_IND: 1.0,
  // D2
  GSC: 6.0, SSC: 6.5, LSC: 5.0, MIAA: 4.0, GMAC: 3.0,
  GNAC: 3.0, PSAC: 2.5, CACC: 3.0, GAC: 3.0, NSIC: 2.5,
  CCAA: 3.0, MEC: 2.5, NE10: 2.0, EAST_COAST: 1.5, GLIAC: 2.5,
  PEACH_BELT: 4.0, SIAC: 0.0, CIAA: -1.0, D2_IND: 1.0,
  // D3
  CCC: 2.0, NESCAC: 3.0, UAA: 1.5, CCIW: 3.0, CCS: 2.5,
  MAC_COMM: 2.5, ODAC: 3.5, OAC: 2.5, NWC: -2.0, USA_SOUTH: 1.0,
  SAA: 1.5, NACC: 1.0, MWC_D3: 1.0, NEWMAC: 1.5, NJAC: 2.0,
  CUNY: -1.0, LL: 1.0, LITTLE_EAST: 1.5, NEC_D3: 1.0,
  SCIAC: 2.0, ASC: 3.0, SLIAC: 0.0, UMAC: 0.0, CCIW_2: 2.5,
  D3_IND: 0.5,
}

// ─── Helper to produce a single team entry ────────────────────────────────
function slugify(name) {
  return name.toLowerCase()
    .replace(/'/g, '')              // drop apostrophes: "Saint Martin's" → "saint-martins"
    .replace(/&/g, 'and')
    .replace(/\./g, '')              // drop periods: "St. John's" → "st-johns"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function mkTeam(name, city, state, nickname, strength, divisionSuffix, colors = null) {
  return {
    id: slugify(name) + '-' + divisionSuffix,
    name, city, state, nickname,
    strength: typeof strength === 'number' ? strength : 0,
    colors,
  }
}

// ─── D1 — by conference. [name, city, state, nickname, strength_override?] ──
// Strength values calibrated to widely-known program tier as of 2024-25.

const D1 = {
  // Sun Belt powers + new SEC arrivals get top strength
  SEC: [
    ['LSU',                'Baton Rouge',     'LA', 'Tigers',       13.0],
    ['Tennessee',          'Knoxville',       'TN', 'Volunteers',   12.5],
    ['Vanderbilt',         'Nashville',       'TN', 'Commodores',   12.0],
    ['Arkansas',           'Fayetteville',    'AR', 'Razorbacks',   12.0],
    ['Florida',            'Gainesville',     'FL', 'Gators',       11.5],
    ['Texas',              'Austin',          'TX', 'Longhorns',    11.5],
    ['Texas A&M',          'College Station', 'TX', 'Aggies',       11.0],
    ['Mississippi State',  'Starkville',      'MS', 'Bulldogs',     10.5],
    ['Ole Miss',           'Oxford',          'MS', 'Rebels',       10.0],
    ['Auburn',             'Auburn',          'AL', 'Tigers',       10.5],
    ['Georgia',            'Athens',          'GA', 'Bulldogs',     9.5],
    ['Kentucky',           'Lexington',       'KY', 'Wildcats',     9.5],
    ['South Carolina',     'Columbia',        'SC', 'Gamecocks',    9.0],
    ['Alabama',            'Tuscaloosa',      'AL', 'Crimson Tide', 8.5],
    ['Oklahoma',           'Norman',          'OK', 'Sooners',      8.0],
    ['Missouri',           'Columbia',        'MO', 'Tigers',       6.5],
  ],
  ACC: [
    ['Florida State',      'Tallahassee',     'FL', 'Seminoles',          10.5],
    ['Wake Forest',        'Winston-Salem',   'NC', 'Demon Deacons',      11.0],
    ['Virginia',           'Charlottesville', 'VA', 'Cavaliers',          10.5],
    ['NC State',           'Raleigh',         'NC', 'Wolfpack',           10.0],
    ['Stanford',           'Stanford',        'CA', 'Cardinal',           11.0],
    ['Clemson',            'Clemson',         'SC', 'Tigers',             10.0],
    ['Miami',              'Coral Gables',    'FL', 'Hurricanes',         9.5],
    ['North Carolina',     'Chapel Hill',     'NC', 'Tar Heels',          10.0],
    ['Duke',               'Durham',          'NC', 'Blue Devils',        9.0],
    ['Louisville',         'Louisville',      'KY', 'Cardinals',          10.0],
    ['Virginia Tech',      'Blacksburg',      'VA', 'Hokies',             7.5],
    ['Georgia Tech',       'Atlanta',         'GA', 'Yellow Jackets',     7.5],
    ['Notre Dame',         'Notre Dame',      'IN', 'Fighting Irish',     7.0],
    ['Pitt',               'Pittsburgh',      'PA', 'Panthers',           6.0],
    ['Boston College',     'Chestnut Hill',   'MA', 'Eagles',             5.5],
    ['Cal',                'Berkeley',        'CA', 'Golden Bears',       7.5],
    ['SMU',                'University Park', 'TX', 'Mustangs',           6.5],
  ],
  BIG12: [
    ['Oklahoma State',     'Stillwater',      'OK', 'Cowboys',     9.5],
    ['TCU',                'Fort Worth',      'TX', 'Horned Frogs',10.5],
    ['Arizona',            'Tucson',          'AZ', 'Wildcats',    9.5],
    ['Arizona State',      'Tempe',           'AZ', 'Sun Devils',  8.5],
    ['Baylor',             'Waco',            'TX', 'Bears',       7.0],
    ['BYU',                'Provo',           'UT', 'Cougars',     6.0],
    ['Texas Tech',         'Lubbock',         'TX', 'Red Raiders', 9.0],
    ['Houston',            'Houston',         'TX', 'Cougars',     6.5],
    ['Cincinnati',         'Cincinnati',      'OH', 'Bearcats',    4.5],
    ['UCF',                'Orlando',         'FL', 'Knights',     7.0],
    ['West Virginia',      'Morgantown',      'WV', 'Mountaineers',7.5],
    ['Kansas',             'Lawrence',        'KS', 'Jayhawks',    5.5],
    ['Kansas State',       'Manhattan',       'KS', 'Wildcats',    6.0],
    ['Utah',               'Salt Lake City',  'UT', 'Utes',        4.0],
  ],
  BIG_TEN: [
    ['Oregon',             'Eugene',          'OR', 'Ducks',          9.5],
    ['Oregon State',       'Corvallis',       'OR', 'Beavers',        10.5],
    ['UCLA',               'Los Angeles',     'CA', 'Bruins',         10.0],
    ['USC',                'Los Angeles',     'CA', 'Trojans',        9.0],
    ['Washington',         'Seattle',         'WA', 'Huskies',        8.0],
    ['Indiana',            'Bloomington',     'IN', 'Hoosiers',       6.5],
    ['Maryland',           'College Park',    'MD', 'Terrapins',      6.0],
    ['Michigan',           'Ann Arbor',       'MI', 'Wolverines',     5.5],
    ['Michigan State',     'East Lansing',    'MI', 'Spartans',       4.5],
    ['Illinois',           'Champaign',       'IL', 'Fighting Illini',5.5],
    ['Iowa',               'Iowa City',       'IA', 'Hawkeyes',       5.0],
    ['Minnesota',          'Minneapolis',     'MN', 'Golden Gophers', 4.0],
    ['Nebraska',           'Lincoln',         'NE', 'Cornhuskers',    6.0],
    ['Ohio State',         'Columbus',        'OH', 'Buckeyes',       5.5],
    ['Penn State',         'University Park', 'PA', 'Nittany Lions',  3.5],
    ['Purdue',             'West Lafayette',  'IN', 'Boilermakers',   4.0],
    ['Rutgers',            'Piscataway',      'NJ', 'Scarlet Knights',4.0],
  ],
  WCC: [
    ['Gonzaga',            'Spokane',         'WA', 'Bulldogs',    7.0],
    ['Portland',           'Portland',        'OR', 'Pilots',      6.5],
    ['Loyola Marymount',   'Los Angeles',     'CA', 'Lions',       4.5],
    ['Pepperdine',         'Malibu',          'CA', 'Waves',       5.5],
    ['San Diego',          'San Diego',       'CA', 'Toreros',     4.0],
    ['Santa Clara',        'Santa Clara',     'CA', 'Broncos',     3.5],
    ['Saint Marys',        'Moraga',          'CA', 'Gaels',       2.5],
    ['San Francisco',      'San Francisco',   'CA', 'Dons',        2.0],
    ['Pacific',            'Stockton',        'CA', 'Tigers',      2.0],
  ],
  BIG_WEST: [
    ['UC Irvine',          'Irvine',          'CA', 'Anteaters',         7.5],
    ['UC Santa Barbara',   'Santa Barbara',   'CA', 'Gauchos',           7.0],
    ['Cal State Fullerton','Fullerton',       'CA', 'Titans',            7.0],
    ['Long Beach State',   'Long Beach',      'CA', 'Beach',             5.5],
    ['UC Davis',           'Davis',           'CA', 'Aggies',            4.5],
    ['UC Riverside',       'Riverside',       'CA', 'Highlanders',       4.0],
    ['UC San Diego',       'La Jolla',        'CA', 'Tritons',           4.0],
    ['CSU Bakersfield',    'Bakersfield',     'CA', 'Roadrunners',       3.5],
    ['CSU Northridge',     'Northridge',      'CA', 'Matadors',          3.5],
    ['Hawaii',             'Honolulu',        'HI', 'Rainbow Warriors',  5.0],
  ],
  SUN_BELT: [
    ['Coastal Carolina',   'Conway',          'SC', 'Chanticleers',      9.0],
    ['East Carolina',      'Greenville',      'NC', 'Pirates',           9.5],
    ['Troy',               'Troy',            'AL', 'Trojans',           5.5],
    ['South Alabama',      'Mobile',          'AL', 'Jaguars',           5.5],
    ['Louisiana',          'Lafayette',       'LA', 'Ragin\' Cajuns',    6.5],
    ['Louisiana-Monroe',   'Monroe',          'LA', 'Warhawks',          3.5],
    ['Texas State',        'San Marcos',      'TX', 'Bobcats',           6.0],
    ['Arkansas State',     'Jonesboro',       'AR', 'Red Wolves',        4.0],
    ['Georgia Southern',   'Statesboro',      'GA', 'Eagles',            6.0],
    ['Georgia State',      'Atlanta',         'GA', 'Panthers',          4.5],
    ['App State',          'Boone',           'NC', 'Mountaineers',      5.5],
    ['Marshall',           'Huntington',      'WV', 'Thundering Herd',   4.0],
    ['Old Dominion',       'Norfolk',         'VA', 'Monarchs',          5.5],
    ['James Madison',      'Harrisonburg',    'VA', 'Dukes',             5.5],
    ['Southern Miss',      'Hattiesburg',     'MS', 'Golden Eagles',     6.5],
  ],
  C_USA: [
    ['Dallas Baptist',     'Dallas',          'TX', 'Patriots',          7.5],
    ['UTSA',               'San Antonio',     'TX', 'Roadrunners',       4.5],
    ['Florida Atlantic',   'Boca Raton',      'FL', 'Owls',              5.0],
    ['Florida International','Miami',         'FL', 'Panthers',          3.5],
    ['Liberty',            'Lynchburg',       'VA', 'Flames',            5.5],
    ['Louisiana Tech',     'Ruston',          'LA', 'Bulldogs',          4.5],
    ['Middle Tennessee',   'Murfreesboro',    'TN', 'Blue Raiders',      3.0],
    ['New Mexico State',   'Las Cruces',      'NM', 'Aggies',            2.5],
    ['UTEP',               'El Paso',         'TX', 'Miners',            2.0],
    ['Western Kentucky',   'Bowling Green',   'KY', 'Hilltoppers',       2.5],
    ['Kennesaw State',     'Kennesaw',        'GA', 'Owls',              4.5],
    ['Sam Houston',        'Huntsville',      'TX', 'Bearkats',          3.5],
    ['Jacksonville State', 'Jacksonville',    'AL', 'Gamecocks',         3.5],
  ],
  AAC: [
    ['Tulane',             'New Orleans',     'LA', 'Green Wave',        6.5],
    ['Memphis',            'Memphis',         'TN', 'Tigers',            4.0],
    ['South Florida',      'Tampa',           'FL', 'Bulls',             5.5],
    ['North Texas',        'Denton',          'TX', 'Mean Green',        3.0],
    ['UAB',                'Birmingham',      'AL', 'Blazers',           4.0],
    ['Wichita State',      'Wichita',         'KS', 'Shockers',          6.0],
    ['Charlotte',          'Charlotte',       'NC', '49ers',             4.5],
    ['East Carolina2',     'Greenville',      'NC', 'Pirates',           0.0], // placeholder, ECU already exists — set 0 strength to filter
    ['Florida Atlantic2',  'Boca Raton',      'FL', 'Owls',              0.0],
    ['Rice',               'Houston',         'TX', 'Owls',              5.0],
    ['Temple',             'Philadelphia',    'PA', 'Owls',              2.0],
    ['Tulsa',              'Tulsa',           'OK', 'Golden Hurricane',  2.5],
  ],
  ASUN: [
    ['Lipscomb',           'Nashville',       'TN', 'Bisons',            5.0],
    ['Florida Gulf Coast', 'Fort Myers',      'FL', 'Eagles',            5.0],
    ['Jacksonville',       'Jacksonville',    'FL', 'Dolphins',          4.0],
    ['North Alabama',      'Florence',        'AL', 'Lions',             3.5],
    ['Stetson',            'DeLand',          'FL', 'Hatters',           4.5],
    ['North Florida',      'Jacksonville',    'FL', 'Ospreys',           3.5],
    ['Bellarmine',         'Louisville',      'KY', 'Knights',           2.5],
    ['Central Arkansas',   'Conway',          'AR', 'Bears',             3.0],
    ['Eastern Kentucky',   'Richmond',        'KY', 'Colonels',          2.5],
    ['West Georgia',       'Carrollton',      'GA', 'Wolves',            2.0],
    ['Queens',             'Charlotte',       'NC', 'Royals',            1.5],
    ['Austin Peay',        'Clarksville',     'TN', 'Governors',         2.5],
  ],
  BIG_SOUTH: [
    ['High Point',         'High Point',      'NC', 'Panthers',          3.5],
    ['Charleston Southern','Charleston',      'SC', 'Buccaneers',        2.5],
    ['Gardner-Webb',       'Boiling Springs', 'NC', 'Runnin\' Bulldogs', 2.5],
    ['Longwood',           'Farmville',       'VA', 'Lancers',           2.5],
    ['Presbyterian',       'Clinton',         'SC', 'Blue Hose',         1.0],
    ['Radford',            'Radford',         'VA', 'Highlanders',       2.0],
    ['Winthrop',           'Rock Hill',       'SC', 'Eagles',            3.5],
    ['UNC Asheville',      'Asheville',       'NC', 'Bulldogs',          1.5],
    ['USC Upstate',        'Spartanburg',     'SC', 'Spartans',          2.0],
  ],
  SOCON: [
    ['Mercer',             'Macon',           'GA', 'Bears',             4.5],
    ['Wofford',            'Spartanburg',     'SC', 'Terriers',          3.5],
    ['Furman',             'Greenville',      'SC', 'Paladins',          4.0],
    ['Samford',            'Birmingham',      'AL', 'Bulldogs',          4.0],
    ['Citadel',            'Charleston',      'SC', 'Bulldogs',          3.0],
    ['UNC Greensboro',     'Greensboro',      'NC', 'Spartans',          3.5],
    ['Western Carolina',   'Cullowhee',       'NC', 'Catamounts',        4.0],
    ['ETSU',               'Johnson City',    'TN', 'Buccaneers',        3.5],
    ['VMI',                'Lexington',       'VA', 'Keydets',           1.0],
  ],
  BIG_EAST: [
    ['UConn',              'Storrs',          'CT', 'Huskies',           6.5],
    ['Creighton',          'Omaha',           'NE', 'Bluejays',          4.0],
    ['Xavier',             'Cincinnati',      'OH', 'Musketeers',        3.0],
    ['Villanova',          'Villanova',       'PA', 'Wildcats',          2.5],
    ['Seton Hall',         'South Orange',    'NJ', 'Pirates',           3.0],
    ['Georgetown',         'Washington',      'DC', 'Hoyas',             1.5],
    ['Butler',             'Indianapolis',    'IN', 'Bulldogs',          1.5],
    ['DePaul',             'Chicago',         'IL', 'Blue Demons',       1.0],
    ['Providence',         'Providence',      'RI', 'Friars',            1.0],
    ['St. John\'s',        'Queens',          'NY', 'Red Storm',         3.5],
  ],
  MWC: [
    ['Air Force',          'USAF Academy',    'CO', 'Falcons',           2.5],
    ['Fresno State',       'Fresno',          'CA', 'Bulldogs',          4.5],
    ['Nevada',             'Reno',            'NV', 'Wolf Pack',         3.5],
    ['New Mexico',         'Albuquerque',     'NM', 'Lobos',             3.5],
    ['San Diego State',    'San Diego',       'CA', 'Aztecs',            4.0],
    ['San Jose State',     'San Jose',        'CA', 'Spartans',          3.0],
    ['UNLV',               'Las Vegas',       'NV', 'Rebels',            3.0],
  ],
  WAC: [
    ['Grand Canyon',       'Phoenix',         'AZ', 'Lopes',             5.0],
    ['Utah Valley',        'Orem',            'UT', 'Wolverines',        3.5],
    ['Tarleton State',     'Stephenville',    'TX', 'Texans',            2.5],
    ['Abilene Christian',  'Abilene',         'TX', 'Wildcats',          2.5],
    ['Stephen F. Austin',  'Nacogdoches',     'TX', 'Lumberjacks',       2.5],
    ['Southern Utah',      'Cedar City',      'UT', 'Thunderbirds',      1.5],
    ['Seattle U',          'Seattle',         'WA', 'Redhawks',          5.5],
  ],
  ATLANTIC_10: [
    ['Saint Joseph\'s',    'Philadelphia',    'PA', 'Hawks',             1.5],
    ['Dayton',             'Dayton',          'OH', 'Flyers',            1.5],
    ['VCU',                'Richmond',        'VA', 'Rams',              2.0],
    ['Davidson',           'Davidson',        'NC', 'Wildcats',          2.5],
    ['Fordham',            'Bronx',           'NY', 'Rams',              1.5],
    ['George Mason',       'Fairfax',         'VA', 'Patriots',          1.5],
    ['George Washington',  'Washington',      'DC', 'Revolutionaries',   1.0],
    ['La Salle',           'Philadelphia',    'PA', 'Explorers',         0.5],
    ['Loyola Chicago',     'Chicago',         'IL', 'Ramblers',          0.5],
    ['Massachusetts',      'Amherst',         'MA', 'Minutemen',         1.5],
    ['Rhode Island',       'Kingston',        'RI', 'Rams',              1.0],
    ['Richmond',           'Richmond',        'VA', 'Spiders',           1.5],
    ['Saint Louis',        'St. Louis',       'MO', 'Billikens',         1.0],
    ['St. Bonaventure',    'Allegany',        'NY', 'Bonnies',           0.5],
  ],
  AMERICA_EAST: [
    ['UMaine',             'Orono',           'ME', 'Black Bears',       1.0],
    ['UMBC',               'Catonsville',     'MD', 'Retrievers',        1.5],
    ['Binghamton',         'Vestal',          'NY', 'Bearcats',          1.5],
    ['Bryant',             'Smithfield',      'RI', 'Bulldogs',          1.0],
    ['Albany',             'Albany',          'NY', 'Great Danes',       0.5],
    ['Hartford',           'West Hartford',   'CT', 'Hawks',            -0.5],
    ['New Hampshire',      'Durham',          'NH', 'Wildcats',          0.5],
    ['UMass Lowell',       'Lowell',          'MA', 'River Hawks',       0.0],
  ],
  CAA: [
    ['Charleston',         'Charleston',      'SC', 'Cougars',           4.0],
    ['UNCW',               'Wilmington',      'NC', 'Seahawks',          5.0],
    ['Northeastern',       'Boston',          'MA', 'Huskies',           3.5],
    ['William & Mary',     'Williamsburg',    'VA', 'Tribe',             2.5],
    ['Towson',             'Towson',          'MD', 'Tigers',            2.5],
    ['Hofstra',            'Hempstead',       'NY', 'Pride',             2.0],
    ['Delaware',           'Newark',          'DE', 'Blue Hens',         2.5],
    ['Elon',               'Elon',            'NC', 'Phoenix',           3.0],
    ['Stony Brook',        'Stony Brook',     'NY', 'Seawolves',         2.5],
    ['Hampton',            'Hampton',         'VA', 'Pirates',           1.0],
    ['Monmouth',           'West Long Branch','NJ', 'Hawks',             1.5],
    ['North Carolina A&T', 'Greensboro',      'NC', 'Aggies',            0.0],
  ],
  PATRIOT: [
    ['Army',               'West Point',      'NY', 'Black Knights',     2.0],
    ['Navy',               'Annapolis',       'MD', 'Midshipmen',        2.0],
    ['Lehigh',             'Bethlehem',       'PA', 'Mountain Hawks',    1.0],
    ['Bucknell',           'Lewisburg',       'PA', 'Bison',             1.5],
    ['Holy Cross',         'Worcester',       'MA', 'Crusaders',         0.5],
    ['Lafayette',          'Easton',          'PA', 'Leopards',          1.0],
    ['Loyola Maryland',    'Baltimore',       'MD', 'Greyhounds',        0.0],
    ['Boston U',           'Boston',          'MA', 'Terriers',         -0.5],
  ],
  IVY: [
    ['Harvard',            'Cambridge',       'MA', 'Crimson',           1.5],
    ['Yale',               'New Haven',       'CT', 'Bulldogs',          2.0],
    ['Princeton',          'Princeton',       'NJ', 'Tigers',            2.0],
    ['Columbia',           'New York',        'NY', 'Lions',             1.5],
    ['Penn',               'Philadelphia',    'PA', 'Quakers',           1.5],
    ['Cornell',            'Ithaca',          'NY', 'Big Red',           1.5],
    ['Dartmouth',          'Hanover',         'NH', 'Big Green',         1.5],
    ['Brown',              'Providence',      'RI', 'Bears',             1.5],
  ],
  HORIZON: [
    ['Wright State',       'Dayton',          'OH', 'Raiders',           3.0],
    ['Oakland',            'Rochester',       'MI', 'Golden Grizzlies',  2.5],
    ['Youngstown State',   'Youngstown',      'OH', 'Penguins',          2.0],
    ['Northern Kentucky',  'Highland Heights','KY', 'Norse',             1.0],
    ['Milwaukee',          'Milwaukee',       'WI', 'Panthers',          1.0],
    ['Purdue Fort Wayne',  'Fort Wayne',      'IN', 'Mastodons',         0.5],
    ['UIC',                'Chicago',         'IL', 'Flames',            1.5],
    ['Cleveland State',    'Cleveland',       'OH', 'Vikings',           0.5],
    ['Robert Morris',      'Moon Township',   'PA', 'Colonials',         0.5],
  ],
  MAAC: [
    ['Fairfield',          'Fairfield',       'CT', 'Stags',             2.5],
    ['Canisius',           'Buffalo',         'NY', 'Golden Griffins',   1.5],
    ['Iona',               'New Rochelle',    'NY', 'Gaels',             1.0],
    ['Manhattan',          'Riverdale',       'NY', 'Jaspers',           0.5],
    ['Marist',             'Poughkeepsie',    'NY', 'Red Foxes',         1.5],
    ['Mount St. Mary\'s',  'Emmitsburg',      'MD', 'Mountaineers',      1.0],
    ['Niagara',            'Lewiston',        'NY', 'Purple Eagles',     0.0],
    ['Quinnipiac',         'Hamden',          'CT', 'Bobcats',           1.0],
    ['Rider',              'Lawrenceville',   'NJ', 'Broncs',            1.0],
    ['Saint Peter\'s',     'Jersey City',     'NJ', 'Peacocks',          0.0],
    ['Siena',              'Loudonville',     'NY', 'Saints',            1.0],
  ],
  MAC: [
    ['Central Michigan',   'Mount Pleasant',  'MI', 'Chippewas',         3.0],
    ['Eastern Michigan',   'Ypsilanti',       'MI', 'Eagles',            2.0],
    ['Western Michigan',   'Kalamazoo',       'MI', 'Broncos',           2.5],
    ['Northern Illinois',  'DeKalb',          'IL', 'Huskies',           1.0],
    ['Ball State',         'Muncie',          'IN', 'Cardinals',         2.5],
    ['Bowling Green',      'Bowling Green',   'OH', 'Falcons',           2.0],
    ['Kent State',         'Kent',            'OH', 'Golden Flashes',    3.5],
    ['Miami (OH)',         'Oxford',          'OH', 'RedHawks',          2.5],
    ['Ohio',               'Athens',          'OH', 'Bobcats',           2.5],
    ['Toledo',             'Toledo',          'OH', 'Rockets',           1.5],
  ],
  NEC: [
    ['Le Moyne',           'Syracuse',        'NY', 'Dolphins',          0.5],
    ['Sacred Heart',       'Fairfield',       'CT', 'Pioneers',          0.5],
    ['Wagner',             'Staten Island',   'NY', 'Seahawks',         -0.5],
    ['Long Island U',      'Brooklyn',        'NY', 'Sharks',            0.0],
    ['Stonehill',          'Easton',          'MA', 'Skyhawks',         -0.5],
    ['Central Connecticut','New Britain',     'CT', 'Blue Devils',       0.0],
    ['Fairleigh Dickinson','Teaneck',         'NJ', 'Knights',          -0.5],
  ],
  OVC: [
    ['Tennessee Tech',     'Cookeville',      'TN', 'Golden Eagles',     2.5],
    ['Belmont',            'Nashville',       'TN', 'Bruins',            2.5],
    ['Morehead State',     'Morehead',        'KY', 'Eagles',            2.0],
    ['SE Missouri State',  'Cape Girardeau',  'MO', 'Redhawks',          2.5],
    ['Murray State',       'Murray',          'KY', 'Racers',            2.5],
    ['SIU Edwardsville',   'Edwardsville',    'IL', 'Cougars',           2.0],
    ['Tennessee State',    'Nashville',       'TN', 'Tigers',           -0.5],
    ['UT Martin',          'Martin',          'TN', 'Skyhawks',          1.0],
    ['Western Illinois',   'Macomb',          'IL', 'Leathernecks',      1.0],
    ['Lindenwood',         'St. Charles',     'MO', 'Lions',             1.5],
  ],
  SOUTHLAND: [
    ['McNeese',            'Lake Charles',    'LA', 'Cowboys',           3.5],
    ['Nicholls',           'Thibodaux',       'LA', 'Colonels',          3.0],
    ['Northwestern State', 'Natchitoches',    'LA', 'Demons',            2.5],
    ['Southeastern Louisiana','Hammond',      'LA', 'Lions',             3.0],
    ['HCU',                'Houston',         'TX', 'Huskies',           1.5],
    ['Incarnate Word',     'San Antonio',     'TX', 'Cardinals',         2.0],
    ['Lamar',              'Beaumont',        'TX', 'Cardinals',         2.0],
    ['New Orleans',        'New Orleans',     'LA', 'Privateers',        2.5],
    ['Texas A&M-Corpus Christi','Corpus Christi','TX','Islanders',       2.5],
    ['East Texas A&M',     'Commerce',        'TX', 'Lions',             1.5],
  ],
  SUMMIT: [
    ['North Dakota State', 'Fargo',           'ND', 'Bison',             2.5],
    ['South Dakota State', 'Brookings',       'SD', 'Jackrabbits',       2.0],
    ['Oral Roberts',       'Tulsa',           'OK', 'Golden Eagles',     4.5],
    ['Omaha',              'Omaha',           'NE', 'Mavericks',         2.0],
    ['Western Illinois2',  'Macomb',          'IL', 'Leathernecks',      0.0],
    ['St. Thomas',         'St. Paul',        'MN', 'Tommies',           1.0],
  ],
  SWAC: [
    ['Alabama State',      'Montgomery',      'AL', 'Hornets',           0.5],
    ['Bethune-Cookman',    'Daytona Beach',   'FL', 'Wildcats',          0.5],
    ['Florida A&M',        'Tallahassee',     'FL', 'Rattlers',          0.5],
    ['Grambling',          'Grambling',       'LA', 'Tigers',           -1.5],
    ['Jackson State',      'Jackson',         'MS', 'Tigers',            1.5],
    ['Mississippi Valley', 'Itta Bena',       'MS', 'Delta Devils',     -2.5],
    ['Prairie View A&M',   'Prairie View',    'TX', 'Panthers',         -1.5],
    ['Southern',           'Baton Rouge',     'LA', 'Jaguars',           0.0],
    ['Texas Southern',     'Houston',         'TX', 'Tigers',           -1.0],
    ['Alabama A&M',        'Normal',          'AL', 'Bulldogs',         -0.5],
    ['Alcorn State',       'Lorman',          'MS', 'Braves',           -1.5],
    ['Arkansas-Pine Bluff','Pine Bluff',      'AR', 'Golden Lions',     -1.5],
  ],
  MEAC: [
    ['Coppin State',       'Baltimore',       'MD', 'Eagles',           -2.0],
    ['Delaware State',     'Dover',           'DE', 'Hornets',          -1.5],
    ['Howard',             'Washington',      'DC', 'Bison',            -1.0],
    ['Norfolk State',      'Norfolk',         'VA', 'Spartans',         -1.0],
    ['Maryland Eastern Shore','Princess Anne','MD', 'Hawks',            -2.5],
  ],
  D1_IND: [
    ['Tarleton State2',    'Stephenville',    'TX', 'Texans',            0.0], // placeholder
  ],
}

// ─── D2 — top conferences with key programs (national coverage) ─────────────

const D2 = {
  GSC: [   // Gulf South Conference
    ['North Greenville',   'Tigerville',      'SC', 'Trailblazers',      8.0],
    ['Auburn-Montgomery',  'Montgomery',      'AL', 'Warhawks',          6.5],
    ['West Alabama',       'Livingston',      'AL', 'Tigers',            6.0],
    ['Delta State',        'Cleveland',       'MS', 'Statesmen',         6.5],
    ['West Florida',       'Pensacola',       'FL', 'Argonauts',         7.0],
    ['Mississippi College','Clinton',         'MS', 'Choctaws',          5.0],
    ['Lee',                'Cleveland',       'TN', 'Flames',            5.5],
    ['Union (TN)',         'Jackson',         'TN', 'Bulldogs',          5.0],
    ['Christian Brothers', 'Memphis',         'TN', 'Buccaneers',        4.5],
    ['Trevecca Nazarene',  'Nashville',       'TN', 'Trojans',           4.0],
    ['Valdosta State',     'Valdosta',        'GA', 'Blazers',           6.0],
  ],
  SSC: [   // Sunshine State Conference
    ['Tampa',              'Tampa',           'FL', 'Spartans',          9.0],
    ['Nova Southeastern',  'Davie',           'FL', 'Sharks',            7.5],
    ['Lynn',               'Boca Raton',      'FL', 'Fighting Knights',  6.5],
    ['Saint Leo',          'Saint Leo',       'FL', 'Lions',             6.0],
    ['Eckerd',             'St. Petersburg',  'FL', 'Tritons',           5.5],
    ['Embry-Riddle',       'Daytona Beach',   'FL', 'Eagles',            5.5],
    ['Barry',              'Miami Shores',    'FL', 'Buccaneers',        5.0],
    ['Florida Southern',   'Lakeland',        'FL', 'Moccasins',         5.0],
    ['Palm Beach Atlantic','West Palm Beach', 'FL', 'Sailfish',          4.5],
    ['Florida Tech',       'Melbourne',       'FL', 'Panthers',          4.0],
  ],
  LSC: [   // Lone Star Conference
    ['Angelo State',       'San Angelo',      'TX', 'Rams',              8.0],
    ['West Texas A&M',     'Canyon',          'TX', 'Buffaloes',         6.5],
    ['Texas A&M-Kingsville','Kingsville',     'TX', 'Javelinas',         5.5],
    ['Cameron',            'Lawton',          'OK', 'Aggies',            5.0],
    ['UT Tyler',           'Tyler',           'TX', 'Patriots',          5.0],
    ['UT Permian Basin',   'Odessa',          'TX', 'Falcons',           4.5],
    ['DBU2',               'Dallas',          'TX', 'Patriots',          0.0],
    ['Lubbock Christian',  'Lubbock',         'TX', 'Chaparrals',        4.5],
    ['Eastern New Mexico', 'Portales',        'NM', 'Greyhounds',        4.0],
  ],
  MIAA: [   // Mid-America Intercollegiate Athletics Association
    ['Central Missouri',   'Warrensburg',     'MO', 'Mules',             7.0],
    ['Pittsburg State',    'Pittsburg',       'KS', 'Gorillas',          5.5],
    ['Missouri Southern',  'Joplin',          'MO', 'Lions',             4.5],
    ['Missouri Western',   'St. Joseph',      'MO', 'Griffons',          4.0],
    ['Washburn',           'Topeka',          'KS', 'Ichabods',          4.0],
    ['Emporia State',      'Emporia',         'KS', 'Hornets',           3.5],
    ['Fort Hays State',    'Hays',            'KS', 'Tigers',            3.0],
    ['Newman',             'Wichita',         'KS', 'Jets',              3.0],
    ['Northwest Missouri', 'Maryville',       'MO', 'Bearcats',          3.0],
    ['Nebraska-Kearney',   'Kearney',         'NE', 'Lopers',            3.0],
    ['Lincoln',            'Jefferson City',  'MO', 'Blue Tigers',       1.5],
  ],
  PEACH_BELT: [
    ['Augusta',            'Augusta',         'GA', 'Jaguars',           5.5],
    ['Columbus State',     'Columbus',        'GA', 'Cougars',           5.0],
    ['Flagler',            'St. Augustine',   'FL', 'Saints',            5.0],
    ['Georgia College',    'Milledgeville',   'GA', 'Bobcats',           5.0],
    ['Georgia Southwestern','Americus',       'GA', 'Hurricanes',        4.0],
    ['Lander',             'Greenwood',       'SC', 'Bearcats',          5.0],
    ['UNC Pembroke',       'Pembroke',        'NC', 'Braves',            4.0],
    ['USC Aiken',          'Aiken',           'SC', 'Pacers',            4.5],
    ['USC Beaufort',       'Bluffton',        'SC', 'Sand Sharks',       3.5],
    ['Young Harris',       'Young Harris',    'GA', 'Mountain Lions',    3.0],
  ],
  CCAA: [
    ['Cal Poly Pomona',    'Pomona',          'CA', 'Broncos',           6.0],
    ['Chico State',        'Chico',           'CA', 'Wildcats',          5.5],
    ['CSU Stanislaus',     'Turlock',         'CA', 'Warriors',          5.0],
    ['CSU Dominguez Hills','Carson',          'CA', 'Toros',             4.0],
    ['CSU Los Angeles',    'Los Angeles',     'CA', 'Golden Eagles',     3.5],
    ['CSU East Bay',       'Hayward',         'CA', 'Pioneers',          4.0],
    ['Cal State Monterey Bay','Seaside',      'CA', 'Otters',            3.5],
    ['Cal State San Marcos','San Marcos',     'CA', 'Cougars',           4.0],
    ['Point Loma',         'San Diego',       'CA', 'Sea Lions',         4.5],
    ['San Francisco State','San Francisco',   'CA', 'Gators',            3.0],
    ['Sonoma State',       'Rohnert Park',    'CA', 'Seawolves',         3.0],
  ],
  NE10: [
    ['New Haven',          'West Haven',      'CT', 'Chargers',          4.0],
    ['Southern Connecticut','New Haven',      'CT', 'Owls',              3.0],
    ['Saint Anselm',       'Manchester',      'NH', 'Hawks',             3.0],
    ['Franklin Pierce',    'Rindge',          'NH', 'Ravens',            3.5],
    ['Saint Michael\'s',   'Colchester',      'VT', 'Purple Knights',    2.5],
    ['Bentley',            'Waltham',         'MA', 'Falcons',           2.5],
    ['Pace',               'Pleasantville',   'NY', 'Setters',           2.0],
    ['American International','Springfield',  'MA', 'Yellow Jackets',    2.5],
    ['Adelphi',            'Garden City',     'NY', 'Panthers',          3.5],
  ],
  NSIC: [
    ['Augustana (SD)',     'Sioux Falls',     'SD', 'Vikings',           7.5],
    ['MSU Mankato',        'Mankato',         'MN', 'Mavericks',         5.0],
    ['Wayne State (NE)',   'Wayne',           'NE', 'Wildcats',          4.0],
    ['Minnesota Duluth',   'Duluth',          'MN', 'Bulldogs',          4.0],
    ['Bemidji State',      'Bemidji',         'MN', 'Beavers',           3.0],
    ['Minnesota State Moorhead','Moorhead',   'MN', 'Dragons',           3.0],
    ['Northern State',     'Aberdeen',        'SD', 'Wolves',            3.0],
    ['Sioux Falls',        'Sioux Falls',     'SD', 'Cougars',           3.5],
    ['Concordia-St. Paul', 'St. Paul',        'MN', 'Golden Bears',      3.0],
    ['Southwest Minnesota','Marshall',        'MN', 'Mustangs',          3.0],
  ],
  GMAC: [
    ['Cedarville',         'Cedarville',      'OH', 'Yellow Jackets',    3.5],
    ['Findlay',            'Findlay',         'OH', 'Oilers',            3.0],
    ['Hillsdale',          'Hillsdale',       'MI', 'Chargers',          3.0],
    ['Northwood',          'Midland',         'MI', 'Timberwolves',      2.5],
    ['Ashland',            'Ashland',         'OH', 'Eagles',            3.0],
    ['Walsh',              'North Canton',    'OH', 'Cavaliers',         2.5],
    ['Ohio Dominican',     'Columbus',        'OH', 'Panthers',          2.5],
    ['Tiffin',             'Tiffin',          'OH', 'Dragons',           2.5],
  ],
  GAC: [   // Great American Conference
    ['Henderson State',    'Arkadelphia',     'AR', 'Reddies',           4.0],
    ['Southern Arkansas',  'Magnolia',        'AR', 'Muleriders',        4.0],
    ['Arkansas Tech',      'Russellville',    'AR', 'Wonder Boys',       3.5],
    ['Harding',            'Searcy',          'AR', 'Bisons',            3.5],
    ['Ouachita Baptist',   'Arkadelphia',     'AR', 'Tigers',            3.5],
    ['Southeastern Oklahoma','Durant',        'OK', 'Savage Storm',      3.0],
    ['East Central',       'Ada',             'OK', 'Tigers',            3.0],
    ['Northwestern Oklahoma','Alva',          'OK', 'Rangers',           2.5],
    ['Oklahoma Baptist',   'Shawnee',         'OK', 'Bison',             3.0],
  ],
  GNAC: [
    ['Central Washington', 'Ellensburg',      'WA', 'Wildcats',          4.0],
    ['Saint Martin\'s',    'Lacey',           'WA', 'Saints',            2.5],
    ['Montana State-Billings','Billings',     'MT', 'Yellowjackets',     2.0],
    ['Western Oregon',     'Monmouth',        'OR', 'Wolves',            3.0],
    ['Northwest Nazarene', 'Nampa',           'ID', 'Nighthawks',        3.5],
    ['Concordia (OR)',     'Portland',        'OR', 'Cavaliers',         1.5],
  ],
  PSAC: [
    ['Mercyhurst',         'Erie',            'PA', 'Lakers',            3.0],
    ['Seton Hill',         'Greensburg',      'PA', 'Griffins',          3.5],
    ['Slippery Rock',      'Slippery Rock',   'PA', 'Rock',              3.5],
    ['West Chester',       'West Chester',    'PA', 'Golden Rams',       3.0],
    ['Millersville',       'Millersville',    'PA', 'Marauders',         2.5],
    ['Kutztown',           'Kutztown',        'PA', 'Golden Bears',      2.5],
    ['Pitt-Johnstown',     'Johnstown',       'PA', 'Mountain Cats',     2.0],
    ['IUP',                'Indiana',         'PA', 'Crimson Hawks',     3.0],
    ['Mansfield',          'Mansfield',       'PA', 'Mountaineers',      1.5],
    ['Edinboro',           'Edinboro',        'PA', 'Fighting Scots',    2.5],
    ['Shippensburg',       'Shippensburg',    'PA', 'Raiders',           2.0],
  ],
  GLIAC: [
    ['Saginaw Valley',     'University Center','MI','Cardinals',         3.0],
    ['Davenport',          'Grand Rapids',    'MI', 'Panthers',          2.5],
    ['Ferris State',       'Big Rapids',      'MI', 'Bulldogs',          3.0],
    ['Grand Valley State', 'Allendale',       'MI', 'Lakers',            3.0],
    ['Northwood2',         'Midland',         'MI', 'Timberwolves',      0.0],
    ['Wayne State (MI)',   'Detroit',         'MI', 'Warriors',          2.5],
    ['Purdue Northwest',   'Hammond',         'IN', 'Pride',             2.0],
    ['Parkside',           'Kenosha',         'WI', 'Rangers',           2.5],
    ['Lake Superior State','Sault Ste. Marie','MI', 'Lakers',            1.5],
  ],
  CACC: [
    ['Wilmington',         'New Castle',      'DE', 'Wildcats',          3.5],
    ['Goldey-Beacom',      'Wilmington',      'DE', 'Lightning',         2.0],
    ['Bloomfield',         'Bloomfield',      'NJ', 'Bears',             2.0],
    ['Caldwell',           'Caldwell',        'NJ', 'Cougars',           2.0],
    ['Chestnut Hill',      'Philadelphia',    'PA', 'Griffins',          1.5],
    ['Felician',           'Lodi',            'NJ', 'Golden Falcons',    1.5],
    ['Holy Family',        'Philadelphia',    'PA', 'Tigers',            1.5],
    ['Jefferson',          'Philadelphia',    'PA', 'Rams',              2.5],
    ['Dominican (NY)',     'Orangeburg',      'NY', 'Chargers',          1.0],
    ['Post',               'Waterbury',       'CT', 'Eagles',            1.0],
  ],
}

// ─── D3 — major regional conferences ──────────────────────────────────────

const D3 = {
  NESCAC: [
    ['Tufts',              'Medford',         'MA', 'Jumbos',            4.5],
    ['Amherst',            'Amherst',         'MA', 'Mammoths',          3.5],
    ['Bates',              'Lewiston',        'ME', 'Bobcats',           2.5],
    ['Bowdoin',            'Brunswick',       'ME', 'Polar Bears',       3.0],
    ['Colby',              'Waterville',      'ME', 'Mules',             2.5],
    ['Connecticut College','New London',      'CT', 'Camels',            2.5],
    ['Hamilton',           'Clinton',         'NY', 'Continentals',      3.0],
    ['Middlebury',         'Middlebury',      'VT', 'Panthers',          3.0],
    ['Trinity (CT)',       'Hartford',        'CT', 'Bantams',           3.0],
    ['Wesleyan',           'Middletown',      'CT', 'Cardinals',         3.5],
    ['Williams',           'Williamstown',    'MA', 'Ephs',              3.5],
  ],
  CCIW: [
    ['North Central (IL)', 'Naperville',      'IL', 'Cardinals',         3.5],
    ['Wheaton (IL)',       'Wheaton',         'IL', 'Thunder',           3.5],
    ['Augustana (IL)',     'Rock Island',     'IL', 'Vikings',           3.0],
    ['Carthage',           'Kenosha',         'WI', 'Firebirds',         3.0],
    ['Elmhurst',           'Elmhurst',        'IL', 'Bluejays',          2.5],
    ['Illinois Wesleyan',  'Bloomington',     'IL', 'Titans',            3.0],
    ['Millikin',           'Decatur',         'IL', 'Big Blue',          2.5],
    ['North Park',         'Chicago',         'IL', 'Vikings',           2.0],
  ],
  ODAC: [
    ['Lynchburg',          'Lynchburg',       'VA', 'Hornets',           3.5],
    ['Randolph-Macon',     'Ashland',         'VA', 'Yellow Jackets',    3.0],
    ['Roanoke',            'Salem',           'VA', 'Maroons',           3.0],
    ['Bridgewater',        'Bridgewater',     'VA', 'Eagles',            3.5],
    ['Eastern Mennonite',  'Harrisonburg',    'VA', 'Royals',            2.5],
    ['Emory & Henry',      'Emory',           'VA', 'Wasps',             2.5],
    ['Ferrum',             'Ferrum',          'VA', 'Panthers',          2.0],
    ['Guilford',           'Greensboro',      'NC', 'Quakers',           2.5],
    ['Hampden-Sydney',     'Hampden-Sydney',  'VA', 'Tigers',            3.0],
    ['Shenandoah',         'Winchester',      'VA', 'Hornets',           2.5],
    ['Washington and Lee', 'Lexington',       'VA', 'Generals',          3.0],
  ],
  SCIAC: [
    ['Chapman',            'Orange',          'CA', 'Panthers',          3.0],
    ['Cal Lutheran',       'Thousand Oaks',   'CA', 'Kingsmen',          2.5],
    ['Claremont-Mudd-Scripps','Claremont',    'CA', 'Stags',             2.5],
    ['La Verne',           'La Verne',        'CA', 'Leopards',          2.5],
    ['Pomona-Pitzer',      'Claremont',       'CA', 'Sagehens',          2.0],
    ['Redlands',           'Redlands',        'CA', 'Bulldogs',          2.0],
    ['Whittier',           'Whittier',        'CA', 'Poets',             1.5],
    ['Caltech',            'Pasadena',        'CA', 'Beavers',          -3.0],
    ['Occidental',         'Los Angeles',     'CA', 'Tigers',            1.5],
  ],
  NWC: [   // Northwest Conference (already partially in DB — covered by Linfield, PLU, etc.)
    ['Puget Sound',        'Tacoma',          'WA', 'Loggers',          -1.0],
    ['Pacific Lutheran',   'Tacoma',          'WA', 'Lutes',            -2.0],
    ['Whitman',            'Walla Walla',     'WA', 'Blues',            -2.5],
    ['Whitworth',          'Spokane',         'WA', 'Pirates',          -1.5],
    ['Linfield',           'McMinnville',     'OR', 'Wildcats',          0.5],
    ['Lewis & Clark',      'Portland',        'OR', 'Pioneers',         -3.0],
    ['Willamette',         'Salem',           'OR', 'Bearcats',         -1.5],
    ['Pacific (OR)',       'Forest Grove',    'OR', 'Boxers',           -3.5],
    ['George Fox',         'Newberg',         'OR', 'Bruins',           -1.0],
  ],
  UAA: [
    ['Emory',              'Atlanta',         'GA', 'Eagles',            3.5],
    ['Washington U',       'St. Louis',       'MO', 'Bears',             3.0],
    ['Chicago',            'Chicago',         'IL', 'Maroons',           2.0],
    ['Brandeis',           'Waltham',         'MA', 'Judges',            2.0],
    ['Case Western',       'Cleveland',       'OH', 'Spartans',          2.0],
    ['NYU',                'New York',        'NY', 'Violets',           2.0],
    ['Rochester',          'Rochester',       'NY', 'Yellowjackets',     2.0],
    ['Carnegie Mellon',    'Pittsburgh',      'PA', 'Tartans',           1.5],
  ],
  CCS: [   // College Conference of the South — placeholder for SAA / SCAC etc.
    ['Trinity (TX)',       'San Antonio',     'TX', 'Tigers',            4.0],
    ['Texas Lutheran',     'Seguin',          'TX', 'Bulldogs',          3.5],
    ['Schreiner',          'Kerrville',       'TX', 'Mountaineers',      2.5],
    ['Centenary',          'Shreveport',      'LA', 'Gents',             2.0],
    ['Concordia (TX)',     'Austin',          'TX', 'Tornados',          2.5],
    ['Southwestern (TX)',  'Georgetown',      'TX', 'Pirates',           2.5],
    ['Sewanee',            'Sewanee',         'TN', 'Tigers',            2.0],
    ['Berry',              'Mount Berry',     'GA', 'Vikings',           3.0],
    ['Birmingham-Southern','Birmingham',      'AL', 'Panthers',          3.0],
  ],
  USA_SOUTH: [
    ['Christopher Newport','Newport News',    'VA', 'Captains',          4.0],
    ['Wesley',             'Dover',           'DE', 'Wolverines',        2.0],
    ['Salisbury',          'Salisbury',       'MD', 'Sea Gulls',         5.0],
    ['Greensboro',         'Greensboro',      'NC', 'Pride',             2.0],
    ['Mary Washington',    'Fredericksburg',  'VA', 'Eagles',            3.0],
    ['William Peace',      'Raleigh',         'NC', 'Pacers',            1.5],
    ['Methodist',          'Fayetteville',    'NC', 'Monarchs',          1.5],
    ['North Carolina Wesleyan','Rocky Mount', 'NC', 'Battling Bishops',  2.0],
  ],
  NEWMAC: [
    ['WPI',                'Worcester',       'MA', 'Engineers',         4.0],
    ['MIT',                'Cambridge',       'MA', 'Engineers',         2.5],
    ['Coast Guard',        'New London',      'CT', 'Bears',             2.5],
    ['Springfield',        'Springfield',     'MA', 'Pride',             3.0],
    ['Babson',             'Wellesley',       'MA', 'Beavers',           3.0],
    ['Clark (MA)',         'Worcester',       'MA', 'Cougars',           2.0],
  ],
  ASC: [   // American Southwest
    ['UT Dallas',          'Richardson',      'TX', 'Comets',            3.0],
    ['East Texas Baptist', 'Marshall',        'TX', 'Tigers',            3.0],
    ['Hardin-Simmons',     'Abilene',         'TX', 'Cowboys',           3.0],
    ['Howard Payne',       'Brownwood',       'TX', 'Yellow Jackets',    2.5],
    ['Mary Hardin-Baylor', 'Belton',          'TX', 'Crusaders',         3.0],
    ['McMurry',            'Abilene',         'TX', 'War Hawks',         2.0],
    ['Ozarks (AR)',        'Clarksville',     'AR', 'Eagles',            1.5],
    ['LeTourneau',         'Longview',        'TX', 'YellowJackets',     1.5],
  ],
  CCC: [   // Commonwealth Coast Conference
    ['Endicott',           'Beverly',         'MA', 'Gulls',             2.5],
    ['Eastern Nazarene',   'Quincy',          'MA', 'Lions',             1.0],
    ['Gordon',             'Wenham',          'MA', 'Fighting Scots',    2.0],
    ['New England',        'Henniker',        'NH', 'Pilgrims',          1.5],
    ['Nichols',            'Dudley',          'MA', 'Bison',             1.5],
    ['Roger Williams',     'Bristol',         'RI', 'Hawks',             2.0],
    ['Salve Regina',       'Newport',         'RI', 'Seahawks',          2.0],
    ['Suffolk',            'Boston',          'MA', 'Rams',              1.5],
    ['Western New England','Springfield',     'MA', 'Golden Bears',      1.5],
  ],
  CCIW_2: [   // Liberty League + Centennial
    ['Vassar',             'Poughkeepsie',    'NY', 'Brewers',           2.0],
    ['RIT',                'Rochester',       'NY', 'Tigers',            2.5],
    ['Skidmore',           'Saratoga Springs','NY', 'Thoroughbreds',     2.5],
    ['Union (NY)',         'Schenectady',     'NY', 'Garnet Chargers',   2.0],
    ['Bard',               'Annandale-on-Hudson','NY','Raptors',         1.0],
    ['Clarkson',           'Potsdam',         'NY', 'Golden Knights',    2.0],
    ['Hobart',             'Geneva',          'NY', 'Statesmen',         2.5],
    ['RPI',                'Troy',            'NY', 'Engineers',         2.0],
    ['Ithaca',             'Ithaca',          'NY', 'Bombers',           3.0],
  ],
  OAC: [   // Ohio Athletic Conference
    ['Marietta',           'Marietta',        'OH', 'Pioneers',          4.0],
    ['Capital',            'Bexley',          'OH', 'Comets',            3.5],
    ['Heidelberg',         'Tiffin',          'OH', 'Student Princes',   3.0],
    ['Baldwin Wallace',    'Berea',           'OH', 'Yellow Jackets',    3.0],
    ['John Carroll',       'University Heights','OH','Blue Streaks',     3.0],
    ['Mount Union',        'Alliance',        'OH', 'Purple Raiders',    2.5],
    ['Otterbein',          'Westerville',     'OH', 'Cardinals',         2.5],
    ['Wilmington (OH)',    'Wilmington',      'OH', 'Quakers',           2.0],
    ['Muskingum',          'New Concord',     'OH', 'Fighting Muskies',  2.0],
  ],
  NJAC: [
    ['Rowan',              'Glassboro',       'NJ', 'Profs',             4.0],
    ['Montclair State',    'Montclair',       'NJ', 'Red Hawks',         3.5],
    ['William Paterson',   'Wayne',           'NJ', 'Pioneers',          3.0],
    ['Kean',               'Union',           'NJ', 'Cougars',           3.0],
    ['Rutgers-Camden',     'Camden',          'NJ', 'Scarlet Raptors',   2.5],
    ['Rutgers-Newark',     'Newark',          'NJ', 'Scarlet Raiders',   2.0],
    ['NJ City',            'Jersey City',     'NJ', 'Gothic Knights',    1.5],
    ['TCNJ',               'Ewing',           'NJ', 'Lions',             3.0],
    ['Stockton',           'Galloway',        'NJ', 'Ospreys',           2.5],
  ],
}

// ─── Manual extras (national powers I want to make sure are in the DB) ────
// These have unique IDs so they won't collide with conference-derived IDs.

const MANUAL = {
  D3: [
    ['Cortland',           'Cortland',        'NY', 'Red Dragons',       4.5],
    ['Johns Hopkins',      'Baltimore',       'MD', 'Blue Jays',         4.5],
    ['Wisconsin-Whitewater','Whitewater',     'WI', 'Warhawks',          4.5],
    ['Washington & Jefferson','Washington',   'PA', 'Presidents',        3.5],
    ['Misericordia',       'Dallas',          'PA', 'Cougars',           3.0],
  ],
}

// ─── Assemble final JSON ──────────────────────────────────────────────────

function flatten(divKey, conferences, divisionSuffix) {
  const seen = new Set()
  const teams = []
  for (const [confKey, list] of Object.entries(conferences)) {
    const base = DEFAULT_STRENGTH[confKey] ?? 0
    for (const row of list) {
      const [name, city, state, nickname, strength] = row
      // Skip placeholders with strength === 0 we intentionally inserted
      // to mark "already exists elsewhere"
      if (strength === 0 && (name.endsWith('2') || name.includes('placeholder'))) continue
      const t = mkTeam(name, city, state, nickname, strength ?? base, divisionSuffix)
      if (seen.has(t.id)) continue
      seen.add(t.id)
      teams.push(t)
    }
  }
  return teams
}

// Build per-division team lists
const d1Teams = flatten('D1', D1, 'd1')
const d2Teams = flatten('D2', D2, 'd2')
const d3Teams = flatten('D3', D3, 'd3')

// Add manual extras
for (const row of MANUAL.D3 || []) {
  const [name, city, state, nickname, strength] = row
  const t = mkTeam(name, city, state, nickname, strength, 'd3')
  if (!d3Teams.some(x => x.id === t.id)) d3Teams.push(t)
}

// ─── Preserve existing NWAC list from current data ────────────────────────
const existingPath = path.join(__dirname, '..', '..', 'frontend', 'src', 'gm', 'data', 'non_naia_teams.json')
let existingNwac = []
try {
  const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'))
  const nwacDiv = (existing.divisions || []).find(d => d.id === 'JUCO_NWAC')
  existingNwac = nwacDiv?.teams || []
} catch (e) {
  console.error('Could not read existing file (will write fresh):', e.message)
}

// Preserve any teams from existing D1/D2/D3 that have explicit colors set —
// we want to keep the hand-tuned colors for the PNW + initial national powers.
let existingColors = {}
try {
  const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'))
  for (const div of existing.divisions || []) {
    for (const t of div.teams || []) {
      if (t.colors) existingColors[t.id] = t.colors
    }
  }
} catch (e) { /* noop */ }

// Apply preserved colors to the new lists where IDs match
function applyColors(teams) {
  for (const t of teams) {
    if (existingColors[t.id]) t.colors = existingColors[t.id]
  }
  return teams
}
applyColors(d1Teams)
applyColors(d2Teams)
applyColors(d3Teams)

const out = {
  _meta: {
    purpose: 'Non-NAIA programs (D1/D2/D3 + JUCOs) that NAIA teams can schedule for non-conference games. Strength values feed nonNaiaToUniversal() in nwbbRating.js for cross-division ratings.',
    scope: 'Comprehensive D1/D2/D3 + PNW JUCO. Generated via scripts/gm/generate_non_naia_teams.js — edit the script to add/tune teams.',
    fields: 'Strength rating (-15 to +15 scale) determines sim outcomes + universal-strength rating. Tier-aware: a D1 at strength 10 outranks a D2 at strength 10.',
    sourceNotes: 'D1/D2/D3 strength values are best-effort estimates from widely-known program reputation, NOT actual PEAR data (PEAR publishes for those divisions but our local data file only has NAIA). Swap in real PEAR values when available.',
    generated: new Date().toISOString().slice(0, 10),
  },
  divisions: [
    { id: 'D1', name: 'NCAA Division I',  teams: d1Teams },
    { id: 'D2', name: 'NCAA Division II', teams: d2Teams },
    { id: 'D3', name: 'NCAA Division III', teams: d3Teams },
    { id: 'JUCO_NWAC', name: 'Northwest Athletic Conference (JUCO)', teams: existingNwac },
  ],
}

fs.writeFileSync(existingPath, JSON.stringify(out, null, 2))
console.log(`Wrote ${existingPath}`)
console.log(`  D1: ${d1Teams.length}`)
console.log(`  D2: ${d2Teams.length}`)
console.log(`  D3: ${d3Teams.length}`)
console.log(`  JUCO_NWAC: ${existingNwac.length}`)
console.log(`  TOTAL: ${d1Teams.length + d2Teams.length + d3Teams.length + existingNwac.length}`)
