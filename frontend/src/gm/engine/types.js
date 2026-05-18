/**
 * GM Engine — Type definitions (JSDoc).
 *
 * The codebase is plain JS, so we use JSDoc typedefs for editor type-hinting.
 * No runtime cost. All types here are pure data shapes — engine logic lives
 * in sibling files (rng, generate, sim, recruiting, ...).
 *
 * See ../docs/ for the design behind each shape.
 */

// ─── Primitives ──────────────────────────────────────────────────────────────

/** @typedef {'C'|'1B'|'2B'|'SS'|'3B'|'LF'|'CF'|'RF'|'DH'|'SP'|'RP'} Position */

/** @typedef {'L'|'R'|'S'} BatsHand */
/** @typedef {'L'|'R'} ThrowsHand */
/** @typedef {'FR'|'SO'|'JR'|'SR'} ClassYear */

/** @typedef {'eligible'|'redshirt'|'graduated'|'transferred'} EligibilityStatus */

/** @typedef {'D1_LITE'|'WELL_FUNDED'|'MID'|'SHOESTRING'} ResourceTier */

/** @typedef {'NE'|'SE'|'MW'|'SW'|'W'|'NW'} Region */

/** @typedef {'rural'|'small'|'medium'|'large'} MetroSize */

/** @typedef {'HS_GRINDER'|'JUCO_HUNTER'|'PORTAL_PRO'|'BALANCED'} RecruiterType */

/**
 * @typedef {'NWAC'|'CALIFORNIA_JUCO'|'TEXAS_JUCO'|'FLORIDA_JUCO'|'MIDWEST_JUCO'
 *   |'PUERTO_RICO'|'DOMINICAN_REPUBLIC'|'VENEZUELA'|'AUSTRALIA'|'JAPAN'
 *   |'D1_PORTAL'|'HBCU'|'JUCO_GENERAL'} PipelineFlag
 */

/**
 * @typedef {'HEAD_COACH'|'PITCHING_COACH'|'HITTING_COACH'|'BENCH_COACH'
 *   |'RECRUITING_COORDINATOR'|'STRENGTH_CONDITIONING'|'DIRECTOR_OF_OPERATIONS'} CoachRole
 */

/** @typedef {'HS_SR'|'JUCO'|'NAIA_TRANSFER'|'D1_TRANSFER'} RecruitPool */

/** @typedef {'SEASON'|'POSTSEASON'|'OFFSEASON'} CalendarMode */

// ─── Player ──────────────────────────────────────────────────────────────────

/**
 * @typedef HitterRatings
 * @property {number} contact_l
 * @property {number} contact_r
 * @property {number} power_l
 * @property {number} power_r
 * @property {number} discipline
 * @property {number} speed
 * @property {number} fielding
 * @property {number} arm
 */

/**
 * @typedef PitcherRatings
 * @property {number} stuff
 * @property {number} control
 * @property {number} command
 * @property {number} stamina
 * @property {number} vs_l
 * @property {number} vs_r
 * @property {number} composure
 * @property {number} durability
 */

/**
 * @typedef PlayerHidden
 * @property {HitterRatings} potential_hitter
 * @property {PitcherRatings} potential_pitcher
 * @property {number} work_ethic    // 0-99
 * @property {number} clutch        // 0-99
 * @property {number} injury_prone  // 0-99
 * @property {number} loyalty       // 0-99
 * @property {number} academic_aptitude  // 0-99, hidden; drives baseline GPA + risk
 */

/**
 * @typedef Scholarship
 * @property {number} annualAmount     // $ this year
 * @property {number} yearsCommitted   // remaining years guaranteed
 */

/**
 * @typedef Hometown
 * @property {string} city
 * @property {string} state  // 2-letter
 */

/**
 * @typedef Player
 * @property {string} id
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} birthDate                // ISO yyyy-mm-dd
 * @property {Hometown} hometown
 * @property {string|null} schoolId            // null = recruit not yet enrolled
 * @property {string|null} previousSchoolName  // for portal/JUCO transfers (their last school)
 * @property {string|null} previousLeagueId    // 'NWAC' / 'CCCAA' / NAIA conf id, for pipeline matching
 * @property {ClassYear} classYear
 * @property {number} seasonsUsed              // 0-4
 * @property {number} semestersUsed            // 0-10
 * @property {EligibilityStatus} eligibilityStatus
 * @property {Position} primaryPosition
 * @property {Position[]} positions
 * @property {BatsHand} bats
 * @property {ThrowsHand} throws
 * @property {boolean} isPitcher
 * @property {boolean} isHitter
 * @property {HitterRatings} hitter
 * @property {PitcherRatings} pitcher
 * @property {PlayerHidden} hidden
 * @property {Scholarship} scholarship
 * @property {number} gpa                  // current term GPA, 0.0-4.0
 * @property {'eligible'|'probation'|'ineligible'|'dismissed'} academicStanding
 */

// ─── Coach ───────────────────────────────────────────────────────────────────

/**
 * @typedef Coach
 * @property {string} id
 * @property {string} firstName
 * @property {string} lastName
 * @property {number} age
 * @property {string} schoolId
 * @property {CoachRole} role
 * @property {number} yearsAtSchool
 * @property {number} yearsInRole
 * @property {number} developer    // 0-99
 * @property {number} motivator    // 0-99
 * @property {number} recruiter    // 0-99
 * @property {number} tactician    // 0-99
 * @property {RecruiterType} recruiter_type
 * @property {string[]} regions    // 2-letter state codes
 * @property {PipelineFlag[]} pipelines
 * @property {number} salary               // $ per year
 * @property {number} contractYearsRemaining
 * @property {number} ambition     // 0-99, hidden
 * @property {number} loyalty      // 0-99, hidden
 */

// ─── School ──────────────────────────────────────────────────────────────────

/**
 * @typedef SchoolColors
 * @property {string} primary    // hex
 * @property {string} secondary  // hex
 */

/**
 * @typedef School
 * @property {string} id
 * @property {string} name
 * @property {string} city
 * @property {string} state
 * @property {string|null} nickname
 * @property {SchoolColors|null} colors
 * @property {string} conferenceId
 * @property {ResourceTier} resourceTier
 * @property {number} tuitionPerYear
 * @property {number} roomAndBoardPerYear
 * @property {number} scholarshipPool       // $ annual athletic-aid budget for baseball
 * @property {number} coachingBudget        // $ annual staff-salary budget
 * @property {number} facilityRating        // 0-100
 * @property {number} programHistory        // 0-100, seeded from PEAR rating
 * @property {number} academicReputation    // 0-100
 * @property {Region} region
 * @property {MetroSize} metroSize
 * @property {number} pearRating            // raw PEAR rating, for reference
 */

/**
 * @typedef Conference
 * @property {string} id
 * @property {string} name
 * @property {string} abbreviation
 * @property {boolean} sponsorsBaseball
 * @property {boolean} hasConferenceTournament
 * @property {number} typicalNationalQualifiers
 * @property {string[]} schoolIds
 */

// ─── Team (school + roster + staff combined) ─────────────────────────────────

/**
 * @typedef Team
 * @property {string} schoolId
 * @property {string[]} rosterPlayerIds
 * @property {string} headCoachId
 * @property {string[]} assistantCoachIds
 * @property {number} wins
 * @property {number} losses
 * @property {number} confWins
 * @property {number} confLosses
 * @property {number} runDiff
 */

// ─── Recruit ─────────────────────────────────────────────────────────────────

/**
 * @typedef RecruitPreferences  // weights 0-10 each; recruit personality
 * @property {number} financial
 * @property {number} proximity
 * @property {number} playing_time
 * @property {number} program_history
 * @property {number} facilities
 * @property {number} academics
 * @property {number} coaching
 * @property {number} pipeline_fit
 */

/**
 * @typedef ScoutGrade
 * @property {HitterRatings} estimatedHitter
 * @property {PitcherRatings} estimatedPitcher
 * @property {number} noise       // current rating noise band (±points)
 * @property {Partial<RecruitPreferences>} revealedPreferences
 */

/**
 * @typedef Recruit
 * @property {string} id
 * @property {string} firstName
 * @property {string} lastName
 * @property {Hometown} hometown
 * @property {RecruitPool} pool
 * @property {string|null} previousSchoolName   // for JUCO/portal recruits
 * @property {string|null} previousLeagueId
 * @property {Position} primaryPosition
 * @property {Position[]} positions
 * @property {BatsHand} bats
 * @property {ThrowsHand} throws
 * @property {HitterRatings} trueHitter
 * @property {PitcherRatings} truePitcher
 * @property {HitterRatings} truePotentialHitter
 * @property {PitcherRatings} truePotentialPitcher
 * @property {RecruitPreferences} preferences        // hidden until visits
 * @property {Object<string,ScoutGrade>} scoutGrades // keyed by schoolId
 * @property {'open'|'interested'|'visiting'|'verbal'|'signed'|'lost'} status
 * @property {string[]} interestedSchools            // schoolIds actively recruiting
 * @property {string|null} verbalTo
 * @property {string|null} signedTo
 */

// ─── Calendar ────────────────────────────────────────────────────────────────

/**
 * @typedef Calendar
 * @property {number} year
 * @property {number} week                  // 1-50
 * @property {CalendarMode} mode
 * @property {number|null} seasonWeek       // 1-16 if SEASON
 * @property {number|null} offseasonWeek    // 1-12 if OFFSEASON
 * @property {string|null} forcedPauseReason
 */

// ─── AP / Budget ─────────────────────────────────────────────────────────────

/**
 * @typedef ActionPointsState
 * @property {number} currentWeek           // AP earned this week
 * @property {number} spentThisWeek
 * @property {Object<string,number>} spentByCategory   // 'recruiting','development','team_boost','program','staff'
 */

/**
 * @typedef BudgetState
 * @property {number} totalAthleticBudget                 // $ for the year
 * @property {Object<string,number>} allocations          // $ allocated by category
 * @property {Object<string,number>} actuallySpent        // $ spent so far this year by category
 * @property {boolean} overBudgetWarning                  // true once any category goes over
 * @property {number} jobSecurity                         // 0-100, drives firing risk
 * @property {number} yearsAtSchool                       // tenure (informational)
 */

// ─── Save / World ────────────────────────────────────────────────────────────

/**
 * @typedef GameOptions
 * @property {'TRADITIONAL'|'CUSTOM'} mode             // legacy ruleset toggle group
 * @property {'STORY'|'REGULAR'} storyMode             // 'STORY' = climb-the-ladder career; 'REGULAR' = locked to one school
 * @property {'EASY'|'NORMAL'|'HARD'|'BRUTAL'} difficulty
 * @property {boolean} injuriesEnabled
 * @property {boolean} coachFiringEnabled
 * @property {boolean} transferPortalEnabled
 * @property {boolean} budgetConstraintsEnabled
 */

/**
 * @typedef SaveState
 * @property {number} saveVersion           // for migrations
 * @property {string} saveId
 * @property {string} dynastyName
 * @property {string} userSupabaseId
 * @property {string} userSchoolId          // the school the user coaches
 * @property {number} saveSlot              // 1-3
 * @property {string} createdAt             // ISO
 * @property {string} lastSavedAt
 * @property {GameOptions} gameOptions
 * @property {Calendar} calendar
 * @property {Object<string,School>} schools         // keyed by id
 * @property {Object<string,Conference>} conferences
 * @property {Object<string,Player>} players
 * @property {Object<string,Coach>} coaches
 * @property {Object<string,Team>} teams              // keyed by schoolId
 * @property {Object<string,Recruit>} recruits        // current year's recruit pools
 * @property {Array<import('./schedule.js').Game>} schedule    // full season schedule
 * @property {ActionPointsState} ap
 * @property {BudgetState} budget
 * @property {number} rngSeed
 * @property {Array<NewsEvent>} newsfeed
 */

/**
 * @typedef NewsEvent
 * @property {string} id
 * @property {number} year
 * @property {number} week
 * @property {'TRANSFER_OUT'|'TRANSFER_IN'|'COACH_HIRED'|'COACH_LEFT'|'RECRUIT_VERBAL'|'RECRUIT_FLIPPED'|'INJURY'|'AWARD'|'GAME_RESULT'|'POSTSEASON'} type
 * @property {string} headline
 * @property {Object} payload   // event-specific data
 */

// Empty export to make this an ES module
export {}
