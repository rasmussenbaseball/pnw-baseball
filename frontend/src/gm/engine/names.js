/**
 * Name pools for generating fictional players, recruits, and coaches.
 *
 * Two pools (first / last) are sampled independently. Regional weighting is
 * applied by light bias on a small set of "more common in region X" surnames,
 * not by maintaining separate full pools per region — keeps the JSON small.
 *
 * These pools are deliberately broad. Adjust if you want a different feel.
 */

// ─── First names ─────────────────────────────────────────────────────────────
//
// Tilted toward male names common in college baseball cohorts (HS classes of
// roughly the last 5-10 years). Mix of traditional, contemporary, and regional.

const FIRST_NAMES = [
  'Aaron','Adam','Adrian','Aidan','Alex','Alexander','Andre','Andrew','Andy','Angel',
  'Anthony','Antonio','Asher','Ashton','Austin','Avery','Beau','Ben','Benjamin','Bennett',
  'Blaine','Blake','Bobby','Braden','Bradley','Brady','Brandon','Brayden','Brennan','Brett',
  'Brian','Brock','Brody','Bryce','Bryson','Cade','Caden','Caleb','Cameron','Camden',
  'Carlos','Carson','Carter','Case','Cason','Chad','Chase','Christian','Christopher','Clay',
  'Clayton','Cody','Colby','Cole','Colin','Collin','Colton','Connor','Cooper','Corey',
  'Cory','Craig','Cruz','Curtis','Dakota','Dallas','Damian','Daniel','Danny','Darren',
  'David','Davis','Dawson','Dean','Declan','Denver','Derek','Derrick','Devin','Diego',
  'Dillon','Dominic','Donovan','Drake','Drew','Dustin','Dylan','Easton','Eddie','Eduardo',
  'Eli','Elijah','Elliot','Emilio','Emmett','Eric','Erik','Ethan','Evan','Everett',
  'Ezra','Felix','Finn','Franco','Frank','Gabe','Gabriel','Gage','Garrett','Gavin',
  'George','Gerardo','Giovanni','Grady','Graham','Grant','Grayson','Greg','Griffin','Hank',
  'Hayden','Hector','Henry','Hudson','Hunter','Ian','Isaac','Isaiah','Ivan','Jace',
  'Jack','Jackson','Jacob','Jaden','Jake','Jalen','James','Jameson','Jared','Jaret',
  'Jaron','Jason','Javier','Jaxon','Jayce','Jaylen','Jayson','Jefferson','Jeremiah','Jeremy',
  'Jesse','Jesus','Joaquin','Joel','John','Johnny','Jonah','Jonathan','Jordan','Jorge',
  'Jose','Josh','Joshua','Josiah','Juan','Judah','Julian','Julio','Justin','Kade',
  'Kai','Kaden','Kaleb','Karson','Kason','Keegan','Keenan','Kellen','Kendall','Kenny',
  'Kevin','Killian','Kingston','Knox','Kobe','Kody','Kolton','Kris','Kyle','Kyler',
  'Lance','Landon','Lane','Lawson','Leo','Leon','Levi','Liam','Lincoln','Logan',
  'Lorenzo','Louis','Lucas','Luis','Luke','Mac','Mack','Mackenzie','Manuel','Marco',
  'Marcus','Mario','Mark','Martin','Mason','Mateo','Matt','Matthew','Maverick','Max',
  'Maxwell','Micah','Michael','Miguel','Mike','Miles','Milo','Mitchell','Morgan','Moses',
  'Nathan','Nathaniel','Nelson','Nicholas','Nick','Nico','Nicolas','Nikolas','Noah','Nolan',
  'Oliver','Omar','Orlando','Oscar','Owen','Pablo','Parker','Patrick','Paul','Paxton',
  'Pedro','Peter','Peyton','Phil','Phillip','Pierce','Preston','Quinn','Quincy','Rafael',
  'Ramon','Randy','Raphael','Raul','Ray','Reagan','Reece','Reed','Reese','Remy',
  'Rene','Rex','Rhett','Ricardo','Richard','Ricky','Riley','River','Robert','Roberto',
  'Rocco','Roger','Roman','Ronaldo','Ronnie','Rory','Roy','Royce','Ryan','Ryder',
  'Ryker','Ryland','Sam','Samuel','Santiago','Sawyer','Scott','Sean','Sebastian','Seth',
  'Shane','Shawn','Silas','Simon','Skyler','Spencer','Stephen','Steven','Stone','Sullivan',
  'Talon','Tanner','Tate','Taylor','Theo','Theodore','Thomas','Tim','Timothy','Tobias',
  'Todd','Tony','Travis','Trent','Trenton','Trevor','Trey','Tripp','Tristan','Troy',
  'Tucker','Tyler','Tyson','Vance','Victor','Vincent','Walker','Walter','Warren','Wesley',
  'Weston','William','Wyatt','Xander','Xavier','Zach','Zachary','Zane','Zion'
]

// ─── Last names (general US pool, no regional split here) ────────────────────

const LAST_NAMES = [
  'Adams','Aguilar','Alexander','Allen','Alvarado','Alvarez','Anderson','Andrews','Arias','Armstrong',
  'Arnold','Atkinson','Austin','Avery','Ayala','Bailey','Baker','Baldwin','Banks','Barber',
  'Barker','Barnes','Barnett','Barrett','Barton','Bass','Bates','Bauer','Baxter','Beasley',
  'Beck','Becker','Bell','Bender','Bennett','Benson','Bentley','Berg','Bernard','Berry',
  'Best','Bishop','Black','Blackwell','Blair','Blake','Blanchard','Blankenship','Bloom','Bolton',
  'Bond','Booker','Boone','Booth','Bowen','Bowers','Bowman','Boyd','Boyer','Boyle',
  'Bradford','Bradley','Brady','Brennan','Brewer','Bridges','Briggs','Bright','Brock','Brooks',
  'Brown','Browning','Bryant','Buchanan','Buckley','Bullock','Burch','Burgess','Burke','Burnett',
  'Burns','Burton','Bush','Butler','Byrd','Caballero','Cabrera','Cain','Calderon','Caldwell',
  'Calhoun','Callahan','Calvert','Camacho','Cameron','Campbell','Cannon','Cantrell','Cantu','Cardenas',
  'Carey','Carlson','Carpenter','Carr','Carrillo','Carroll','Carson','Carter','Casey','Cash',
  'Castillo','Castro','Caudill','Cervantes','Chambers','Chan','Chandler','Chang','Chapman','Charles',
  'Chase','Chavez','Chen','Cherry','Christian','Christianson','Church','Clark','Clarke','Clay',
  'Clayton','Clemons','Cline','Cobb','Cochran','Coffey','Cohen','Cole','Coleman','Collier',
  'Collins','Colon','Combs','Compton','Conley','Conner','Conrad','Conway','Cook','Cooke',
  'Cooley','Cooper','Copeland','Corbin','Cordero','Cortez','Costa','Cox','Craft','Craig',
  'Cramer','Crane','Crawford','Crockett','Crosby','Cross','Cruz','Cummings','Cunningham','Curry',
  'Curtis','Dalton','Daniel','Daniels','Daugherty','Davenport','Davidson','Davies','Davis','Dawson',
  'Dean','Decker','Delacruz','Delarosa','Deleon','Delgado','Dennis','Denton','Diaz','Dickerson',
  'Dickson','Dillon','Dixon','Dodson','Dominguez','Donaldson','Donovan','Dorsey','Dotson','Douglas',
  'Downs','Doyle','Drake','Duarte','Dudley','Duffy','Duke','Duncan','Dunn','Duran',
  'Durham','Dyer','Easley','Eaton','Edwards','Elder','Elliott','Ellis','Elmore','Emerson',
  'Engle','English','Epps','Erickson','Espinoza','Estes','Estrada','Evans','Everett','Ewing',
  'Faulkner','Felix','Ferguson','Fernandez','Ferrell','Fields','Figueroa','Fink','Finley','Fischer',
  'Fisher','Fitzgerald','Fitzpatrick','Fleming','Fletcher','Flores','Flowers','Floyd','Flynn','Foley',
  'Forbes','Ford','Foreman','Forrest','Foster','Fowler','Fox','Francis','Franco','Frank',
  'Franklin','Frazier','Freeman','French','Frost','Frye','Fuentes','Fuller','Fulton','Gaines',
  'Gallagher','Galloway','Gamble','Garcia','Gardner','Garner','Garrett','Garrison','Garza','Gates',
  'Gentry','George','Gibbs','Gibson','Gilbert','Giles','Gill','Gillespie','Gilmore','Glass',
  'Glenn','Glover','Goff','Goldman','Gomez','Gonzales','Gonzalez','Good','Goodman','Goodwin',
  'Gordon','Gould','Grady','Graham','Grant','Graves','Gray','Greene','Greer','Gregory',
  'Griffin','Griffith','Grimes','Gross','Guerrero','Guevara','Gunn','Gutierrez','Guzman','Hahn',
  'Hale','Haley','Hall','Hamilton','Hammond','Hampton','Hancock','Hanson','Hardin','Harding',
  'Hardy','Harmon','Harper','Harrell','Harrington','Harris','Harrison','Hart','Hartman','Harvey',
  'Hatfield','Hawkins','Hayes','Haynes','Hays','Heath','Hebert','Henderson','Hendricks','Henry',
  'Hensley','Henson','Herman','Hernandez','Herrera','Hess','Hester','Hicks','Hill','Hines',
  'Hinton','Hobbs','Hodge','Hoffman','Hogan','Holden','Holland','Holloway','Holmes','Holt',
  'Hood','Hooper','Hoover','Hopkins','Horn','Horne','Horton','Houston','Howard','Howe',
  'Howell','Hubbard','Hudson','Huff','Huffman','Huggins','Hughes','Hull','Humphrey','Hunt',
  'Hunter','Hurley','Hurst','Hutchinson','Hyde','Ingram','Irwin','Jackson','Jacobs','James',
  'Jefferson','Jenkins','Jennings','Jensen','Jimenez','Johns','Johnson','Johnston','Jones','Jordan',
  'Joyce','Juarez','Kane','Kaufman','Keenan','Keith','Keller','Kelley','Kelly','Kemp',
  'Kennedy','Kent','Kerr','Key','Keys','Kim','King','Kinney','Kirby','Kirk',
  'Kline','Knight','Knox','Koch','Kramer','Krause','Krueger','Lamb','Lambert','Lancaster',
  'Lane','Lang','Lara','Larkin','Larsen','Larson','Lawrence','Lawson','Le','Leach',
  'Leary','Lee','Leon','Leonard','Lester','Levine','Levy','Lewis','Lim','Lin',
  'Lind','Lindsay','Lindsey','Little','Livingston','Lloyd','Logan','Long','Lopez','Love',
  'Lowe','Lowery','Lucas','Lugo','Luna','Lynch','Lyons','Mack','Madden','Maddox',
  'Madison','Maldonado','Mallory','Mann','Manning','Manuel','Marin','Marks','Marquez','Marsh',
  'Marshall','Martin','Martinez','Mason','Massey','Mata','Mathews','Mathis','Matthews','Maxwell',
  'May','Mayer','Maynard','Mayo','Mays','McBride','McCabe','McCall','McCarthy','McCarty',
  'McClain','McCormick','McCoy','McCullough','McDaniel','McDonald','McDowell','McFadden','McGee','McGrath',
  'McGuire','McIntosh','McIntyre','McKay','McKee','McKenzie','McKinney','McLaughlin','McLean','McLeod',
  'McMahon','McMillan','McNeil','Meadows','Medina','Mejia','Melendez','Melton','Mendez','Mendoza',
  'Mercado','Merritt','Meyer','Meyers','Michael','Middleton','Miles','Miller','Mills','Miranda',
  'Mitchell','Molina','Monroe','Montgomery','Montoya','Moody','Mooney','Moore','Mora','Morales',
  'Moran','Moreno','Morgan','Morris','Morrison','Morrow','Morse','Morton','Moses','Mosley',
  'Moss','Mueller','Mullen','Mullins','Munoz','Murphy','Murray','Myers','Nash','Navarro',
  'Neal','Nelson','Newman','Newton','Nguyen','Nichols','Nicholson','Nielsen','Nieves','Nix',
  'Nixon','Noble','Nolan','Norman','Norris','Norton','Nunez','Obrien','Ochoa','Oconnell',
  'Oconnor','Odom','Olsen','Olson','Oneal','Oneill','Orozco','Orr','Ortega','Ortiz',
  'Osborne','Owen','Owens','Pace','Pacheco','Padilla','Page','Palacios','Palmer','Park',
  'Parker','Parks','Parrish','Parsons','Patel','Patrick','Patterson','Patton','Paul','Payne',
  'Pearson','Peck','Pena','Pennington','Perez','Perkins','Perry','Peters','Petersen','Peterson',
  'Phelps','Phillips','Pierce','Pierson','Pineda','Pittman','Pitts','Pollard','Ponce','Pope',
  'Porter','Potter','Powell','Powers','Pratt','Preston','Price','Prince','Pruitt','Pugh',
  'Quinn','Ramirez','Ramos','Ramsey','Randall','Randolph','Rangel','Rasmussen','Ray','Reed',
  'Reese','Reeves','Reid','Reilly','Reyes','Reynolds','Rhodes','Rice','Rich','Richards',
  'Richardson','Richmond','Riddle','Riggs','Riley','Rios','Rivas','Rivera','Roach','Robbins',
  'Roberts','Robertson','Robinson','Robles','Rodgers','Rodriguez','Rogers','Rollins','Roman','Romero',
  'Rosales','Rosario','Rose','Ross','Roth','Rowe','Rowland','Roy','Rubio','Ruiz',
  'Rush','Russell','Russo','Ryan','Salazar','Salinas','Sampson','Sanchez','Sanders','Sandoval',
  'Santana','Santiago','Santos','Saunders','Savage','Sawyer','Schaefer','Schmidt','Schneider','Schroeder',
  'Schultz','Schwartz','Scott','Sellers','Serrano','Sexton','Shaffer','Shah','Shannon','Sharp',
  'Shaw','Shelton','Shepard','Shepherd','Sheppard','Sherman','Shields','Shore','Short','Silva',
  'Simmons','Simon','Simpson','Sims','Singh','Singleton','Skinner','Sloan','Small','Smith',
  'Smithson','Snow','Snyder','Solis','Solomon','Sosa','Soto','Sparks','Spears','Spence',
  'Spencer','Stafford','Stanley','Stanton','Stark','Steele','Stein','Stephens','Stephenson','Stevens',
  'Stevenson','Stewart','Stokes','Stone','Stout','Stovall','Strickland','Strong','Stuart','Suarez',
  'Sullivan','Summers','Sutton','Swanson','Sweeney','Tanner','Tate','Taylor','Terrell','Terry',
  'Thomas','Thompson','Thornton','Tillman','Todd','Torres','Townsend','Tran','Travis','Trevino',
  'Trujillo','Tucker','Turner','Tyler','Tyson','Underwood','Valdez','Valencia','Valentine','Vance',
  'Vargas','Vasquez','Vaughan','Vaughn','Vazquez','Vega','Velasquez','Velazquez','Vincent','Wade',
  'Wagner','Walker','Wall','Wallace','Walls','Walsh','Walter','Walters','Walton','Ward',
  'Ware','Warner','Warren','Washington','Waters','Watkins','Watson','Watts','Weaver','Webb',
  'Weber','Webster','Welch','Wells','West','Wheeler','Whitaker','White','Whitehead','Whitfield',
  'Whitley','Wiggins','Wilcox','Wilder','Wiley','Wilkerson','Wilkins','Wilkinson','Williams','Williamson',
  'Willis','Wilson','Winters','Wise','Wolf','Wolfe','Wong','Wood','Woodard','Woods',
  'Woodward','Wright','Wyatt','Yang','Yates','York','Young','Zamora','Zhang','Zimmerman'
]

// Lighter regional touches — surnames more common in particular regions get
// a small frequency bump when the recruit's state is in that region.
const REGIONAL_SURNAME_BOOSTS = {
  SW: ['Garcia','Martinez','Hernandez','Lopez','Gonzalez','Rodriguez','Perez','Sanchez',
       'Ramirez','Torres','Flores','Reyes','Ortiz','Castillo','Diaz','Mendoza','Soto','Vargas'],
  W:  ['Nguyen','Tran','Chen','Wang','Lee','Kim','Park','Singh','Patel','Lopez','Garcia',
       'Hernandez','Rodriguez','Martinez','Sanchez','Gonzalez'],
  SE: ['Williams','Johnson','Jackson','Robinson','Thomas','Harris','Davis','Hill','Washington',
       'Mitchell','Bryant'],
  MW: ['Schmidt','Schneider','Becker','Hoffman','Fischer','Wagner','Schultz','Schroeder','Mueller',
       'Bauer','Krueger','Larson','Anderson','Johnson','Olson','Olsen','Peterson','Nelson','Hansen'],
  NW: ['Anderson','Johnson','Hansen','Olsen','Larson','Carlson','Peterson','Lindsey','Lindquist','Berg'],
  NE: ['Murphy','Sullivan','Kelly','Ryan','Donovan','OBrien','Walsh','Russo','Romano','Esposito','Costa'],
}

/**
 * Pick a first name using the rng's `pick`.
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @returns {string}
 */
export function pickFirstName(rng) {
  return rng.pick(FIRST_NAMES)
}

/**
 * Pick a last name with regional bias when a region is provided.
 * @param {ReturnType<import('./rng.js').makeRng>} rng
 * @param {string|null} region
 * @returns {string}
 */
export function pickLastName(rng, region = null) {
  const boost = region && REGIONAL_SURNAME_BOOSTS[region]
  if (boost && rng.chance(0.35)) {
    return rng.pick(boost)
  }
  return rng.pick(LAST_NAMES)
}

/** @returns {{ first: string, last: string }} */
export function pickFullName(rng, region = null) {
  return { first: pickFirstName(rng), last: pickLastName(rng, region) }
}

export const __pools = { FIRST_NAMES, LAST_NAMES, REGIONAL_SURNAME_BOOSTS }
