/**
 * NewDynasty — four-step builder for starting a new dynasty.
 *   1. Program — pick from any Cascade Collegiate Conference school
 *   2. Mode    — Traditional (locked) or Custom (game-option toggles)
 *   3. Coach   — name, headshot, primary + secondary recruiting regions, archetype
 *   4. Confirm — review + start
 *
 * Pixel theme matches the rest of the GM shell. Star-rated school cards
 * replace the old "MID tier · PEAR 1.23" copy.
 */

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadSchools } from '../../gm/engine/loadSchools'
import { newDynasty } from '../../gm/engine/newDynasty'
import { newDynastyMultiLevel } from '../../gm/engine/newDynastyMultiLevel'
import { buildExpansionSchool, validateExpansionInput, FUNDING_BY_LEVEL, PNW_STATE_OPTIONS } from '../../gm/engine/expansionTeam'
import { getLevelForSchool, isPreviewLevel } from '../../gm/engine/levelHelpers'
import { saveDynasty, listDynasties } from '../../gm/engine/save'
import { buildProgramRatings, starsToBar, expectedTeamOvr, teamOvrToStars } from '../../gm/engine/programRating'
import { REGIONS, REGION_LABELS, REGION_BLURBS } from '../../gm/engine/regions'
import { ARCHETYPES } from '../../gm/engine/archetypes'
import { PNW_DIVISIONS, PNW_CONFERENCES, pnwProgramsAtLevel } from '../../gm/engine/pnwPlayoffs'
import { DIFFICULTY_TUNING, pickStoryStart, roleLabel } from '../../gm/engine/storyMode'
import pnwFinancials from '../../gm/data/pnw_school_financials.json'
const PNW_CONFERENCES_FOR_CONFIRM = PNW_CONFERENCES
import TeamLogo from '../../gm/components/TeamLogo'
import GMShell, { PixelCard, PixelButton, gmToast } from '../../gm/components/GMShell'
import CoachHeadshot, { COACH_LOOKS } from '../../gm/components/CoachHeadshot'
import { prettyLabel } from '../../gm/engine/format'

// Level tabs. All levels are playable now — the engine has the per-level
// budgets, rosters, conference schedules, recruiting tier-shifts, and
// postseason brackets wired up. PNW programs at every level work the same.
const LEVEL_TABS = [
  { key: 'NAIA', label: 'NAIA', status: 'PLAYABLE', blurb: '4-year programs. Deep recruiting, full sim, real budgets.' },
  { key: 'D1',   label: 'D1',   status: 'PLAYABLE', blurb: 'NCAA Division I — 4-year. Bigger budgets, NIL deals, tougher recruiting.' },
  { key: 'D2',   label: 'D2',   status: 'PLAYABLE', blurb: 'NCAA Division II — 4-year. Big scholarship pools, regional play.' },
  { key: 'D3',   label: 'D3',   status: 'PLAYABLE', blurb: 'NCAA Division III — 4-year, NO athletic scholarships. Coach + facilities matter more.' },
  { key: 'NWAC', label: 'NWAC', status: 'PLAYABLE', blurb: 'JUCO — 2-year. Only FR/SO eligible. Players transfer to 4-yr programs after SO year.' },
]

// Legacy — Year-1 alpha only allowed CCC. Now we surface all NAIA programs
// in the PNW + every PNW conference at every level.
const ALLOWED_CONFERENCE_ID = 'cascade-collegiate'

const RATING_DESCRIPTIONS = {
  developer: 'Drives offseason player progression — bigger gains for everyone on the roster.',
  motivator: 'Team chemistry + GPA boost + clutch/composure in big moments + fundraising yield.',
  recruiter: 'Weekly AP earned + how fast you build recruit interest + closing rate on verbals.',
  tactician: 'In-game AI calls — lineup, pitching changes, defensive positioning.',
}

const GAME_MODE_PRESETS = {
  TRADITIONAL: {
    label: 'Traditional Experience',
    blurb: 'Hard sim. Injuries on. Real-world NAIA constraints. The full dynasty experience.',
    difficulty: 'HARD',
    injuriesEnabled: true,
    coachFiringEnabled: true,
    transferPortalEnabled: true,
    budgetConstraintsEnabled: true,
  },
  CUSTOM: {
    label: 'Custom',
    blurb: 'Tweak the sim — turn injuries off, run a low-difficulty starter dynasty, etc.',
    difficulty: 'NORMAL',
    injuriesEnabled: true,
    coachFiringEnabled: false,
    transferPortalEnabled: true,
    budgetConstraintsEnabled: true,
  },
}

export default function NewDynasty() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { schools, conferences } = useMemo(() => loadSchools(), [])
  const programRatings = useMemo(() => buildProgramRatings(schools, conferences), [schools, conferences])

  // All 8 Cascade Conference schools, sorted by star rating descending
  const allowedSchools = useMemo(() => {
    const list = Object.values(schools)
      .filter(s => s.conferenceId === ALLOWED_CONFERENCE_ID)
      .map(s => ({ ...s, _rating: programRatings[s.id] || { stars: 2.5, nationalRank: null } }))
      .sort((a, b) => b._rating.stars - a._rating.stars)
    return list
  }, [schools, programRatings])

  const [step, setStep] = useState(1)
  const [selectedSchoolId, setSelectedSchoolId] = useState(null)

  // NEW: storyMode = 'STORY' (career climb) | 'REGULAR' (locked to school).
  // Difficulty is decoupled from the legacy TRADITIONAL/CUSTOM modeKey.
  const [storyMode, setStoryMode] = useState('REGULAR')
  const [difficulty, setDifficulty] = useState('NORMAL')
  // Story-mode start variant: 'TRADITIONAL' (random bottom JUCO bench coach)
  // or 'CUSTOM' (user picks school + role). Traditional is the recommended
  // grind-from-the-bottom experience; custom is for sandbox players.
  const [storyStartMode, setStoryStartMode] = useState('TRADITIONAL')
  const [customStartRole, setCustomStartRole] = useState('BENCH_COACH')

  const [modeKey, setModeKey] = useState('TRADITIONAL')
  const [customOptions, setCustomOptions] = useState(GAME_MODE_PRESETS.CUSTOM)

  // Expansion Team mode — build a brand-new program from scratch instead of
  // picking from the PNW roster. Story mode forces NWAC + STARTUP funding;
  // regular mode lets the user pick anything.
  const [expansionMode, setExpansionMode] = useState(false)
  const [expansionInput, setExpansionInput] = useState({
    name: '', city: '', state: 'OR', nickname: '',
    primaryColor: '#1e40af', secondaryColor: '#fbbf24',
    level: 'NWAC', conferenceId: 'NWAC_SOUTH',
    fundingTier: 'GRASSROOTS',
  })

  // Story-mode start:
  //   TRADITIONAL → random bottom-tier NWAC school, role driven by difficulty
  //                 (Easy: PitchingCoach, Normal: BenchCoach, Brutal: GA)
  //   CUSTOM      → user picks school (selectedSchoolId) + role (customStartRole)
  //                 directly. Difficulty still affects offer/firing tuning.
  const storyStart = useMemo(() => {
    if (storyMode !== 'STORY') return null

    // Custom path — user is picking their own school + role. Resolved school
    // comes from selectedSchoolId in step 2. If unset, the wizard hasn't
    // gotten to step 2 yet; return a placeholder for the preview text only.
    if (storyStartMode === 'CUSTOM') {
      if (!selectedSchoolId) return null
      const info = getLevelForSchool(selectedSchoolId, schools)
      if (!info) return null
      return {
        schoolId: selectedSchoolId,
        level: info.level,
        role: customStartRole,
        conferenceId: info.conferenceId,
      }
    }

    // Traditional path — auto-pick a random bottom-tier NWAC program.
    const nwacPnw = pnwProgramsAtLevel('NWAC')
    const nwacById = {}
    for (const p of nwacPnw) nwacById[p.id] = { ...p, level: 'NWAC' }
    const bucket = pnwFinancials?.tuitionAndBudget?.NWAC || {}
    for (const id of Object.keys(nwacById)) {
      nwacById[id].totalAthleticBudget = (bucket[id] || bucket.default || {}).totalBudget
    }
    const seed = Math.floor(Math.random() * 1e9)
    try {
      return pickStoryStart(nwacById, difficulty, seed)
    } catch (err) {
      console.warn('story start failed:', err)
      return null
    }
  }, [storyMode, difficulty, storyStartMode, selectedSchoolId, customStartRole, schools])

  const [coachFirst, setCoachFirst] = useState('')
  const [coachLast, setCoachLast] = useState('')
  const [coachLookId, setCoachLookId] = useState(0)
  const [primaryRegion, setPrimaryRegion] = useState(null)
  const [secondaryRegion, setSecondaryRegion] = useState(null)
  const [archetype, setArchetype] = useState('GENERALIST')

  const ratings = ARCHETYPES[archetype]?.fixedRatings || ARCHETYPES.GENERALIST.fixedRatings
  // Story mode auto-resolves the starting school; regular mode uses the
  // user's pick. Effective school is whichever applies.
  const effectiveSchoolId = storyMode === 'STORY' ? storyStart?.schoolId : selectedSchoolId
  // Multi-level routing: NAIA goes through the original newDynasty path;
  // D1/D2/D3/NWAC goes through newDynastyMultiLevel (preview engine).
  // Look up the chosen school in BOTH datasets to figure out which one.
  const levelInfo = useMemo(
    () => effectiveSchoolId ? getLevelForSchool(effectiveSchoolId, schools) : null,
    [effectiveSchoolId, schools],
  )
  const expansionValid = expansionMode
    ? !validateExpansionInput(
        storyMode === 'STORY'
          ? { ...expansionInput, level: 'NWAC', fundingTier: 'STARTUP' }
          : expansionInput,
      )
    : true
  const canSubmit = (
    (expansionMode && expansionValid) ||
    (!expansionMode && effectiveSchoolId && levelInfo)
  ) && coachFirst && coachLast && primaryRegion && secondaryRegion && archetype

  function getGameOptions() {
    const base = modeKey === 'TRADITIONAL'
      ? { mode: 'TRADITIONAL', ...GAME_MODE_PRESETS.TRADITIONAL }
      : { mode: 'CUSTOM', ...customOptions }
    // Override difficulty with the user's pick from step 1 and stamp story
    // mode. Story mode forces coachFiringEnabled (you can be fired in
    // story mode regardless of the custom toggles).
    return {
      ...base,
      storyMode,
      difficulty,
      coachFiringEnabled: storyMode === 'STORY' ? true : base.coachFiringEnabled,
    }
  }

  function handleCreate() {
    const userId = user?.id || 'guest'
    const existing = listDynasties(userId)
    const usedSlots = new Set(existing.map(d => d.slot))
    let slot = 1
    while (slot <= 3 && usedSlots.has(slot)) slot++
    if (slot > 3) {
      gmToast('All 3 save slots are used. Delete one to start a new dynasty.', 'warn')
      return
    }
    const isStory = storyMode === 'STORY'

    // EXPANSION TEAM path — bypasses the pre-loaded schools entirely.
    // Story mode forces NWAC + STARTUP funding (the rags-to-riches climb
    // Nate described); regular mode honors whatever the user picked.
    if (expansionMode) {
      const finalInput = isStory
        ? { ...expansionInput, level: 'NWAC', fundingTier: 'STARTUP', storyMode: true }
        : { ...expansionInput, storyMode: false }
      const err = validateExpansionInput(finalInput)
      if (err) { gmToast(err, 'warn'); return }
      let expansionSchool
      try { expansionSchool = buildExpansionSchool(finalInput) }
      catch (e) { gmToast('Failed to build expansion team: ' + (e.message || 'unknown'), 'error'); return }
      const baseInput = {
        userSupabaseId: userId,
        saveSlot: slot,
        dynastyName: isStory
          ? `${coachFirst} ${coachLast}'s Career`
          : `${coachFirst} ${coachLast}'s ${expansionSchool.name}`,
        userSchoolId: expansionSchool.id,
        gameOptions: getGameOptions(),
        ...(isStory ? { storyRole: 'HEAD_COACH' } : {}),
        userCoach: {
          firstName: coachFirst, lastName: coachLast,
          lookId: coachLookId, primaryRegion, secondaryRegion,
          regions: [primaryRegion, secondaryRegion].filter(Boolean),
          archetype, recruiter_type: 'BALANCED', ...ratings,
        },
        level: expansionSchool.level,
        conferenceId: expansionSchool.conferenceId,
        expansionSchool,
      }
      let state
      try { state = newDynastyMultiLevel(baseInput) }
      catch (e) {
        console.error('Expansion dynasty creation failed:', e)
        gmToast('Expansion dynasty creation failed: ' + (e.message || 'unknown'), 'error')
        return
      }
      const result = saveDynasty(state)
      if (!result.ok) { gmToast('Failed to save: ' + result.error, 'error'); return }
      navigate(`/gm/dashboard?slot=${slot}`)
      return
    }

    if (!levelInfo) { gmToast('Could not resolve the selected program.', 'error'); return }
    const schoolName = levelInfo.school.name
    const baseInput = {
      userSupabaseId: userId,
      saveSlot: slot,
      dynastyName: isStory
        ? `${coachFirst} ${coachLast}'s Career`
        : `${coachFirst} ${coachLast}'s ${schoolName}`,
      userSchoolId: effectiveSchoolId,
      gameOptions: getGameOptions(),
      // Story-mode role override — passed into newDynastyMultiLevel to make
      // the user an assistant rather than the HC.
      ...(isStory && storyStart ? { storyRole: storyStart.role } : {}),
      userCoach: {
        firstName: coachFirst,
        lastName: coachLast,
        lookId: coachLookId,
        primaryRegion,
        secondaryRegion,
        regions: [primaryRegion, secondaryRegion].filter(Boolean),
        archetype,
        recruiter_type: 'BALANCED',
        ...ratings,
      },
    }
    let state
    try {
      if (levelInfo.level === 'NAIA' && !isStory) {
        state = newDynasty(baseInput)
      } else {
        state = newDynastyMultiLevel({
          ...baseInput,
          level: levelInfo.level,
          conferenceId: levelInfo.conferenceId,
        })
      }
    } catch (err) {
      console.error('Dynasty creation failed:', err)
      gmToast('Dynasty creation failed: ' + (err.message || 'unknown error'), 'error')
      return
    }
    const result = saveDynasty(state)
    if (!result.ok) { gmToast('Failed to save: ' + result.error, 'error'); return }
    navigate(`/gm/dashboard?slot=${slot}`)
  }

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <GMShell>
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <button onClick={() => navigate('/gm')} className="text-xs text-amber-300 hover:underline mb-2 font-pixel uppercase tracking-widest">
            ← Back to GM home
          </button>
          <h1 className="font-pixel-display text-xl tracking-widest text-white mb-1">NEW DYNASTY</h1>
          <p className="font-pixel text-base text-[#a8a8c8]">Set up your run, pick your school, build your coach.</p>
        </div>

        <div className="flex gap-2 mb-6 flex-wrap">
          <StepDot active={step === 1} done={step > 1} num={1} label="Setup" onClick={() => setStep(1)} />
          <StepDot active={step === 2} done={step > 2} num={2} label="Program" onClick={() => setStep(2)} />
          <StepDot active={step === 3} done={step > 3} num={3} label="Coach" onClick={() => setStep(3)} />
          <StepDot active={step === 4} done={step > 4} num={4} label="Confirm" onClick={() => setStep(4)} />
        </div>

        {step === 1 && (
          <SetupStep
            storyMode={storyMode}
            setStoryMode={setStoryMode}
            difficulty={difficulty}
            setDifficulty={setDifficulty}
            storyStartMode={storyStartMode}
            setStoryStartMode={setStoryStartMode}
            storyStart={storyStart}
            modeKey={modeKey}
            setModeKey={setModeKey}
            customOptions={customOptions}
            setCustomOptions={setCustomOptions}
            expansionMode={expansionMode}
            setExpansionMode={setExpansionMode}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && (
          expansionMode
            ? <ExpansionTeamStep
                input={expansionInput}
                setInput={setExpansionInput}
                isStory={storyMode === 'STORY'}
                onBack={() => setStep(1)}
                onNext={() => setStep(3)}
              />
            : storyMode === 'STORY' && storyStartMode === 'TRADITIONAL'
            ? <StoryProgramReveal
                storyStart={storyStart}
                schools={schools}
                onBack={() => setStep(1)}
                onNext={() => setStep(3)}
              />
            : storyMode === 'STORY' && storyStartMode === 'CUSTOM'
              ? <StoryCustomStartStep
                  schools={schools}
                  conferences={conferences}
                  selectedSchoolId={selectedSchoolId}
                  setSelectedSchoolId={setSelectedSchoolId}
                  customStartRole={customStartRole}
                  setCustomStartRole={setCustomStartRole}
                  onBack={() => setStep(1)}
                  onNext={() => setStep(3)}
                />
              : <ProgramStep
                  schools={allowedSchools}
                  conferences={conferences}
                  programRatings={programRatings}
                  selectedSchoolId={selectedSchoolId}
                  setSelectedSchoolId={setSelectedSchoolId}
                  onBack={() => setStep(1)}
                  onNext={() => setStep(3)}
                />
        )}
        {step === 3 && (
          <CoachStep
            coachFirst={coachFirst} setCoachFirst={setCoachFirst}
            coachLast={coachLast} setCoachLast={setCoachLast}
            coachLookId={coachLookId} setCoachLookId={setCoachLookId}
            primaryRegion={primaryRegion} setPrimaryRegion={setPrimaryRegion}
            secondaryRegion={secondaryRegion} setSecondaryRegion={setSecondaryRegion}
            archetype={archetype} setArchetype={setArchetype}
            ratings={ratings}
            onBack={() => setStep(2)}
            onNext={() => setStep(4)}
            canNext={!!(coachFirst && coachLast && primaryRegion && secondaryRegion && archetype)}
          />
        )}
        {step === 4 && expansionMode && (
          <ConfirmStep
            school={{
              id: 'expansion_preview',
              name: expansionInput.name || '(unnamed expansion)',
              nickname: expansionInput.nickname || 'Expansion',
              city: expansionInput.city,
              state: expansionInput.state,
              colors: { primary: expansionInput.primaryColor, secondary: expansionInput.secondaryColor },
              level: storyMode === 'STORY' ? 'NWAC' : expansionInput.level,
              conferenceId: storyMode === 'STORY' ? 'NWAC_SOUTH' : expansionInput.conferenceId,
            }}
            conf={{
              name: (storyMode === 'STORY' ? 'NWAC_SOUTH' : expansionInput.conferenceId)
                .replace(/_/g, ' ')
                .replace(/\b\w/g, c => c.toUpperCase())
                .replace(/Nwac/g, 'NWAC').replace(/Naia/g, 'NAIA'),
              abbreviation: storyMode === 'STORY' ? 'NWAC_SOUTH' : expansionInput.conferenceId,
            }}
            level={storyMode === 'STORY' ? 'NWAC' : expansionInput.level}
            mode={GAME_MODE_PRESETS[modeKey].label}
            storyMode={storyMode}
            difficulty={difficulty}
            storyRole={storyMode === 'STORY' ? 'HEAD_COACH' : null}
            coachFirst={coachFirst}
            coachLast={coachLast}
            coachLookId={coachLookId}
            primaryRegion={primaryRegion}
            secondaryRegion={secondaryRegion}
            ratings={ratings}
            archetype={archetype}
            canSubmit={canSubmit}
            onBack={() => setStep(3)}
            onSubmit={handleCreate}
          />
        )}
        {step === 4 && !expansionMode && effectiveSchoolId && levelInfo && (
          <ConfirmStep
            school={levelInfo.school}
            conf={
              levelInfo.level === 'NAIA'
                ? conferences[levelInfo.school.conferenceId]
                : {
                    name: (
                      PNW_CONFERENCES_FOR_CONFIRM[levelInfo.conferenceId]?.name
                      // Prettify ids like "NWAC_NORTH" → "NWAC North" when no
                      // lookup hit (avoids displaying raw schema ids per Nate).
                      || (levelInfo.conferenceId || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/Nwac/g, 'NWAC').replace(/Wcc/g, 'WCC').replace(/Naia/g, 'NAIA').replace(/Ccc/g, 'CCC').replace(/Gnac/g, 'GNAC').replace(/Nwc/g, 'NWC')
                    ),
                    abbreviation: levelInfo.conferenceId,
                  }
            }
            level={levelInfo.level}
            mode={GAME_MODE_PRESETS[modeKey].label}
            storyMode={storyMode}
            difficulty={difficulty}
            storyRole={storyStart?.role}
            coachFirst={coachFirst}
            coachLast={coachLast}
            coachLookId={coachLookId}
            primaryRegion={primaryRegion}
            secondaryRegion={secondaryRegion}
            ratings={ratings}
            archetype={archetype}
            canSubmit={canSubmit}
            onBack={() => setStep(3)}
            onSubmit={handleCreate}
          />
        )}
      </div>
    </GMShell>
  )
}

// ─── Step 1: Program ────────────────────────────────────────────────────────

// ─── Step 1: Setup (Path + Mode merged) ─────────────────────────────────
//
// Combines the formerly separate Path step (story-vs-regular + difficulty
// + story-start-mode) and Mode step (TRADITIONAL/CUSTOM + game-option
// toggles) into one screen. They overlapped — difficulty was set on both
// pages, presets duplicated rule defaults. One pane is much clearer.

function SetupStep({ storyMode, setStoryMode, difficulty, setDifficulty, storyStartMode, setStoryStartMode, storyStart, modeKey, setModeKey, customOptions, setCustomOptions, expansionMode, setExpansionMode, onNext }) {
  return (
    <PixelCard accent="#fbbf24" title="STEP 1 · GAME SETUP">
      <p className="text-[#a8a8c8] text-sm mb-3 font-pixel">
        Two ways to play. Pick how your career arc works, then choose how unforgiving the game is.
      </p>

      {/* Story vs Regular cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
        <button
          onClick={() => setStoryMode('REGULAR')}
          className={
            'text-left p-4 rounded-lg border-2 transition ' +
            (storyMode === 'REGULAR'
              ? 'border-amber-300 bg-[#3a3a5e]'
              : 'border-[#3a3a5e] hover:border-[#5a5a8e] bg-[#23233d]')
          }
        >
          <div className="text-white font-bold text-base">Regular Dynasty</div>
          <div className="text-[11px] text-[#a8a8c8] mt-2 leading-snug">
            Pick a program. You are the HEAD COACH there forever. Build a multi-decade dynasty at the
            school of your choice. No switching schools.
          </div>
          <div className="text-[10px] text-amber-300 mt-2 uppercase tracking-wider font-bold">
            Recommended for first run
          </div>
        </button>
        <button
          onClick={() => setStoryMode('STORY')}
          className={
            'text-left p-4 rounded-lg border-2 transition ' +
            (storyMode === 'STORY'
              ? 'border-amber-300 bg-[#3a3a5e]'
              : 'border-[#3a3a5e] hover:border-[#5a5a8e] bg-[#23233d]')
          }
        >
          <div className="text-white font-bold text-base">Story Mode — Climb the Ranks</div>
          <div className="text-[11px] text-[#a8a8c8] mt-2 leading-snug">
            Start as a low-tier assistant at a random NWAC program. Each offseason, receive coaching
            offers from across the PNW. Accept to switch jobs and roles.
            <strong className="text-amber-200"> Goal:</strong> reach a D1 head-coach seat.
            <strong className="text-red-300"> You can get fired.</strong>
          </div>
          <div className="text-[10px] text-amber-300 mt-2 uppercase tracking-wider font-bold">
            For the long career arc
          </div>
        </button>
      </div>

      {/* Difficulty */}
      <div className="mb-4">
        <div className="text-white font-pixel uppercase tracking-widest text-sm mb-2">Difficulty</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {Object.entries(DIFFICULTY_TUNING).map(([key, t]) => {
            const active = difficulty === key
            return (
              <button
                key={key}
                onClick={() => setDifficulty(key)}
                className={
                  'p-3 rounded-lg border-2 text-left transition ' +
                  (active
                    ? 'border-amber-300 bg-[#3a3a5e]'
                    : 'border-[#3a3a5e] hover:border-[#5a5a8e] bg-[#23233d]')
                }
              >
                <div className="text-white font-bold text-sm">{t.label}</div>
                <div className="text-[10px] text-[#a8a8c8] mt-1.5 leading-snug">{t.blurb}</div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Story-mode starting variant — Traditional vs Custom */}
      {storyMode === 'STORY' && (
        <div className="mb-4">
          <div className="text-white font-pixel uppercase tracking-widest text-sm mb-2">Starting Position</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <button
              onClick={() => setStoryStartMode('TRADITIONAL')}
              className={
                'p-3 rounded-lg border-2 text-left transition ' +
                (storyStartMode === 'TRADITIONAL'
                  ? 'border-amber-300 bg-[#3a3a5e]'
                  : 'border-[#3a3a5e] hover:border-[#5a5a8e] bg-[#23233d]')
              }
            >
              <div className="text-white font-bold text-sm">Traditional Story</div>
              <div className="text-[10px] text-[#a8a8c8] mt-1.5 leading-snug">
                <strong className="text-amber-200">Recommended.</strong> Random bottom-tier NWAC program.
                Bench coach (or GA on Brutal / Pitching Coach on Easy). Grind from the bottom.
              </div>
            </button>
            <button
              onClick={() => setStoryStartMode('CUSTOM')}
              className={
                'p-3 rounded-lg border-2 text-left transition ' +
                (storyStartMode === 'CUSTOM'
                  ? 'border-amber-300 bg-[#3a3a5e]'
                  : 'border-[#3a3a5e] hover:border-[#5a5a8e] bg-[#23233d]')
              }
            >
              <div className="text-white font-bold text-sm">Custom Start</div>
              <div className="text-[10px] text-[#a8a8c8] mt-1.5 leading-snug">
                Sandbox mode. Pick any PNW school + role yourself. Skip the grind; start where you want.
                Offers + firings still apply per your difficulty.
              </div>
            </button>
          </div>
        </div>
      )}

      {/* Story-mode preview banner */}
      {storyMode === 'STORY' && storyStartMode === 'TRADITIONAL' && storyStart && (
        <div className="bg-[#0f0f1e] border-2 border-amber-400/40 rounded p-3 mb-3 text-[11px]">
          <div className="font-pixel uppercase tracking-widest text-amber-300 text-[10px] mb-1.5">
            Random Starting Position
          </div>
          <div className="text-[#e8e8e8] leading-snug">
            You'll begin as <strong className="text-amber-200">{roleLabel(storyStart.role)}</strong> at a
            bottom-tier NWAC program (revealed on the next screen). Build credibility, win, get offers,
            and climb up to a D1 head-coach seat.
          </div>
        </div>
      )}
      {storyMode === 'STORY' && storyStartMode === 'CUSTOM' && (
        <div className="bg-[#0f0f1e] border-2 border-purple-400/40 rounded p-3 mb-3 text-[11px]">
          <div className="font-pixel uppercase tracking-widest text-purple-300 text-[10px] mb-1.5">
            Custom Start
          </div>
          <div className="text-[#e8e8e8] leading-snug">
            On the next screen, pick any PNW program at any level and choose your starting role. Career
            offers + firings still fire based on your performance + difficulty tuning.
          </div>
        </div>
      )}

      {/* ─── Game-rules section (was Mode step) ──────────────────────── */}
      <div className="border-t-2 border-[#3a3a5e] pt-4 mt-2">
        <div className="text-white font-pixel uppercase tracking-widest text-sm mb-2">Game Rules</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3">
          {Object.entries(GAME_MODE_PRESETS).map(([key, preset]) => (
            <button
              key={key}
              onClick={() => setModeKey(key)}
              className={
                'text-left p-3 rounded-lg border-2 transition ' +
                (modeKey === key ? 'border-amber-300 bg-[#3a3a5e]' : 'border-[#3a3a5e] hover:border-[#5a5a8e] bg-[#23233d]')
              }
            >
              <div className="font-bold text-white text-sm">{preset.label}</div>
              <div className="text-[10px] text-[#a8a8c8] mt-1 leading-snug">{preset.blurb}</div>
            </button>
          ))}
        </div>

        {modeKey === 'CUSTOM' && (
          <div className="p-3 bg-[#23233d] rounded space-y-2 border-2 border-[#3a3a5e]">
            <Toggle
              label="Injuries"
              sub="Players can get hurt in games + practice."
              value={customOptions.injuriesEnabled}
              onChange={v => setCustomOptions({ ...customOptions, injuriesEnabled: v })}
            />
            <Toggle
              label="Transfer portal"
              sub="Inbound + outbound transfers each offseason."
              value={customOptions.transferPortalEnabled}
              onChange={v => setCustomOptions({ ...customOptions, transferPortalEnabled: v })}
            />
            <Toggle
              label="Budget constraints"
              sub="Hard cap on annual athletic budget."
              value={customOptions.budgetConstraintsEnabled}
              onChange={v => setCustomOptions({ ...customOptions, budgetConstraintsEnabled: v })}
            />
            <Toggle
              label="Head coach can be fired"
              sub={storyMode === 'STORY' ? 'Always ON in Story Mode.' : 'Job security can hit zero and end the run.'}
              value={storyMode === 'STORY' ? true : customOptions.coachFiringEnabled}
              onChange={v => storyMode !== 'STORY' && setCustomOptions({ ...customOptions, coachFiringEnabled: v })}
            />
          </div>
        )}
      </div>

      {/* EXPANSION TEAM TOGGLE — build a brand-new program from scratch
          instead of picking from the existing PNW roster. Story mode forces
          NWAC + STARTUP funding; regular mode unlocks every level + funding
          tier. Per Nate (June 2026). */}
      <div className="mb-4 mt-2 p-3 rounded-lg border-2 border-purple-500/50 bg-purple-950/20">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={!!expansionMode}
            onChange={(e) => setExpansionMode(e.target.checked)}
            className="mt-1 w-4 h-4 accent-purple-400"
          />
          <div>
            <div className="text-purple-200 font-bold text-sm">Build an Expansion Team</div>
            <div className="text-[11px] text-[#a8a8c8] mt-1 leading-snug">
              Create your own program from scratch — pick the name, city, colors, conference, and
              funding level. {storyMode === 'STORY'
                ? <span className="text-amber-200">Story mode locks you into NWAC with no
                  budget and no history. Build a JUCO from nothing.</span>
                : <span>Regular mode lets you join any conference at any level with any funding tier.</span>}
            </div>
          </div>
        </label>
      </div>

      <div className="flex justify-end mt-4">
        <PixelButton onClick={onNext}>Next: {expansionMode ? 'Expansion Team' : 'Program'} →</PixelButton>
      </div>
    </PixelCard>
  )
}

// ─── Expansion Team Step ────────────────────────────────────────────────────
//
// Per Nate (June 2026): let the user spin up a brand-new program. Form
// captures team identity + level + conference + funding. Story mode locks
// the level/funding fields. Regular mode unlocks them all.
function ExpansionTeamStep({ input, setInput, isStory, onBack, onNext }) {
  const set = (k, v) => setInput({ ...input, [k]: v })
  const LEVEL_OPTS = [
    { key: 'NWAC', label: 'NWAC (JUCO)' },
    { key: 'NAIA', label: 'NAIA' },
    { key: 'D3',   label: 'D3 (NCAA)' },
    { key: 'D2',   label: 'D2 (NCAA)' },
    { key: 'D1',   label: 'D1 (NCAA)' },
  ]
  // Available conferences per level. NWAC has 4 regions. Other levels
  // expose the PNW conferences we know about; the engine accepts any
  // conferenceId so power users with a custom save could go further.
  const CONF_OPTS = {
    NWAC: [
      { key: 'NWAC_NORTH', label: 'NWAC North' },
      { key: 'NWAC_SOUTH', label: 'NWAC South' },
      { key: 'NWAC_EAST',  label: 'NWAC East' },
      { key: 'NWAC_WEST',  label: 'NWAC West' },
    ],
    NAIA: [
      { key: 'CCC', label: 'Cascade Collegiate (CCC)' },
    ],
    D3: [
      { key: 'NWC', label: 'Northwest Conference (NWC)' },
    ],
    D2: [
      { key: 'GNAC', label: 'Great Northwest Athletic (GNAC)' },
    ],
    D1: [
      { key: 'BIG_TEN', label: 'Big Ten' },
      { key: 'WCC',     label: 'West Coast Conference' },
      { key: 'WAC',     label: 'Western Athletic Conference' },
    ],
  }
  const lvl = isStory ? 'NWAC' : input.level
  const confOpts = CONF_OPTS[lvl] || []
  // Auto-select first conference if current pick isn't valid for the level
  const currentConfValid = confOpts.some(o => o.key === input.conferenceId)
  const effectiveConfId = currentConfValid ? input.conferenceId : (confOpts[0]?.key || '')
  // Level-aware funding tiers (NWAC budgets are way smaller than D1 etc.)
  const fundingTiers = FUNDING_BY_LEVEL[lvl] || FUNDING_BY_LEVEL.NAIA

  return (
    <PixelCard accent="#c084fc" title="STEP 2 · YOUR EXPANSION TEAM">
      <p className="text-[#a8a8c8] text-sm mb-4 font-pixel">
        {isStory
          ? 'Story mode: NWAC junior college, no scholarship money, no history. Pick your name + colors and grind from the bottom.'
          : 'Regular mode: pick everything. Level, conference, funding tier, identity.'}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <Field label="Team Name *">
          <input
            type="text"
            value={input.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Cascade Mariners"
            maxLength={40}
            className="w-full bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded px-3 py-2 text-white text-sm focus:border-amber-400 outline-none"
          />
        </Field>
        <Field label="Nickname / Mascot">
          <input
            type="text"
            value={input.nickname}
            onChange={(e) => set('nickname', e.target.value)}
            placeholder="Mariners"
            maxLength={24}
            className="w-full bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded px-3 py-2 text-white text-sm focus:border-amber-400 outline-none"
          />
        </Field>
        <Field label="City *">
          <input
            type="text"
            value={input.city}
            onChange={(e) => set('city', e.target.value)}
            placeholder="Bend"
            maxLength={40}
            className="w-full bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded px-3 py-2 text-white text-sm focus:border-amber-400 outline-none"
          />
        </Field>
        <Field label="State *  (PNW only)">
          <select
            value={input.state}
            onChange={(e) => set('state', e.target.value)}
            className="w-full bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded px-3 py-2 text-white text-sm focus:border-amber-400 outline-none"
          >
            {PNW_STATE_OPTIONS.map(opt => (
              <option key={opt.code} value={opt.code}>{opt.code} — {opt.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Primary Color">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={input.primaryColor}
              onChange={(e) => set('primaryColor', e.target.value)}
              className="w-10 h-10 bg-transparent border-2 border-[#3a3a5e] rounded cursor-pointer"
            />
            <span className="text-xs font-mono text-[#a8a8c8]">{input.primaryColor}</span>
          </div>
        </Field>
        <Field label="Secondary Color">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={input.secondaryColor}
              onChange={(e) => set('secondaryColor', e.target.value)}
              className="w-10 h-10 bg-transparent border-2 border-[#3a3a5e] rounded cursor-pointer"
            />
            <span className="text-xs font-mono text-[#a8a8c8]">{input.secondaryColor}</span>
          </div>
        </Field>
      </div>

      <div className="mb-4">
        <div className="text-white font-pixel uppercase tracking-widest text-xs mb-2">
          Level {isStory && <span className="text-amber-300 normal-case ml-2">(locked to NWAC in Story Mode)</span>}
        </div>
        <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
          {LEVEL_OPTS.map(opt => {
            const active = lvl === opt.key
            const disabled = isStory && opt.key !== 'NWAC'
            return (
              <button
                key={opt.key}
                onClick={() => !disabled && set('level', opt.key)}
                disabled={disabled}
                className={
                  'p-2 rounded border-2 text-xs font-bold transition ' +
                  (active ? 'border-amber-300 bg-[#3a3a5e] text-white'
                    : disabled ? 'border-[#2a2a44] bg-[#1a1a2e] text-[#5a5a7a] cursor-not-allowed'
                    : 'border-[#3a3a5e] hover:border-[#5a5a8e] bg-[#23233d] text-white')
                }
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="mb-4">
        <div className="text-white font-pixel uppercase tracking-widest text-xs mb-2">Conference / Region</div>
        <div className="flex flex-wrap gap-2">
          {confOpts.map(opt => {
            const active = effectiveConfId === opt.key
            return (
              <button
                key={opt.key}
                onClick={() => set('conferenceId', opt.key)}
                className={
                  'px-3 py-2 rounded border-2 text-xs transition ' +
                  (active
                    ? 'border-amber-300 bg-[#3a3a5e] text-white'
                    : 'border-[#3a3a5e] hover:border-[#5a5a8e] bg-[#23233d] text-[#cbd5e1]')
                }
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="mb-4">
        <div className="text-white font-pixel uppercase tracking-widest text-xs mb-2">
          Funding Tier
          {isStory && <span className="text-amber-300 normal-case ml-2">(locked to Startup in Story Mode)</span>}
          {!isStory && <span className="text-[#a8a8c8] normal-case ml-2">— numbers scaled to {lvl} reality</span>}
        </div>
        <div className="grid grid-cols-1 gap-2">
          {Object.entries(fundingTiers).map(([key, preset]) => {
            const active = (isStory ? 'STARTUP' : input.fundingTier) === key
            const disabled = isStory && key !== 'STARTUP'
            return (
              <button
                key={key}
                onClick={() => !disabled && set('fundingTier', key)}
                disabled={disabled}
                className={
                  'p-3 rounded border-2 text-left transition flex items-center justify-between ' +
                  (active ? 'border-amber-300 bg-[#3a3a5e]'
                    : disabled ? 'border-[#2a2a44] bg-[#1a1a2e] opacity-50 cursor-not-allowed'
                    : 'border-[#3a3a5e] hover:border-[#5a5a8e] bg-[#23233d]')
                }
              >
                <span className="text-white text-sm font-bold">{preset.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex justify-between mt-4">
        <PixelButton onClick={onBack}>← Back</PixelButton>
        <PixelButton
          onClick={() => {
            // Ensure conferenceId matches the (possibly locked) level before
            // we proceed — Story mode forces NWAC_SOUTH if user hadn't picked.
            if (isStory) setInput({ ...input, level: 'NWAC', conferenceId: effectiveConfId || 'NWAC_SOUTH', fundingTier: 'STARTUP' })
            else if (effectiveConfId !== input.conferenceId) setInput({ ...input, conferenceId: effectiveConfId })
            onNext()
          }}
        >
          Next: Coach →
        </PixelButton>
      </div>
    </PixelCard>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-widest text-[#a8a8c8] mb-1 font-pixel">{label}</div>
      {children}
    </div>
  )
}

// ─── Step 2 (Story): Reveal Your Starting Position ─────────────────────────

function StoryProgramReveal({ storyStart, schools, onBack, onNext }) {
  if (!storyStart) {
    return (
      <PixelCard accent="#fbbf24" title="STEP 2 · STARTING POSITION">
        <p className="text-red-300 text-sm">Couldn't resolve a starting position. Go back to step 1 and try again.</p>
        <div className="flex justify-between mt-4">
          <PixelButton onClick={onBack}>← Back</PixelButton>
        </div>
      </PixelCard>
    )
  }
  const allPnw = pnwProgramsAtLevel('NWAC')
  const school = allPnw.find(p => p.id === storyStart.schoolId) || { name: storyStart.schoolId }
  return (
    <PixelCard accent="#fbbf24" title="STEP 2 · YOUR STARTING POSITION">
      <p className="text-[#a8a8c8] text-sm mb-4 font-pixel">
        Story mode randomly assigns your starting job. Here's where you land:
      </p>
      <div className="bg-[#0f0f1e] border-2 border-amber-300 rounded-lg p-6 text-center mb-4">
        <div className="text-[#a8a8c8] text-xs uppercase tracking-widest mb-2">Year 1 Assignment</div>
        <div className="text-3xl font-bold text-amber-300 mb-1">{roleLabel(storyStart.role)}</div>
        <div className="text-white text-xl font-pixel-display">{school.name}</div>
        <div className="text-[#a8a8c8] text-sm mt-2">NWAC · {school.state || ''}</div>
      </div>
      <div className="text-[11px] text-[#a8a8c8] leading-snug mb-4">
        <strong className="text-amber-200">What this means:</strong> You're an assistant, not the head coach. The HC
        is an NPC. You'll learn the school's pieces in Year 1; at the end of the season, you'll either get a contract
        renewal, an offer to move up, or get cut. Make a name for yourself.
      </div>
      <div className="flex justify-between">
        <PixelButton onClick={onBack}>← Back</PixelButton>
        <PixelButton onClick={onNext}>Next: Mode →</PixelButton>
      </div>
    </PixelCard>
  )
}

// ─── Step 2 (Story Custom): pick school + role yourself ────────────────────

const STORY_CUSTOM_ROLES = [
  { key: 'GRADUATE_ASSISTANT',     label: 'Graduate Assistant', tier: 'Entry' },
  { key: 'BENCH_COACH',            label: 'Bench Coach',         tier: 'Entry' },
  { key: 'STRENGTH_CONDITIONING',  label: 'S&C Coach',           tier: 'Entry' },
  { key: 'HITTING_COACH',          label: 'Hitting Coach',       tier: 'Position' },
  { key: 'PITCHING_COACH',         label: 'Pitching Coach',      tier: 'Position' },
  { key: 'RECRUITING_COORDINATOR', label: 'Recruiting Coord.',   tier: 'Senior' },
  { key: 'DIRECTOR_OF_OPERATIONS', label: 'Director of Ops',     tier: 'Senior' },
  { key: 'DATA_ANALYTICS_MANAGER', label: 'Analytics Director',  tier: 'Senior' },
  { key: 'HEAD_COACH',             label: 'Head Coach',          tier: 'Top' },
]

function StoryCustomStartStep({ schools, conferences, selectedSchoolId, setSelectedSchoolId, customStartRole, setCustomStartRole, onBack, onNext }) {
  const [activeLevel, setActiveLevel] = useState('NWAC')

  // Per-level program lists. NAIA from schools.json; D1/D2/D3/NWAC from playoff formats.
  const naiaPnwSchools = useMemo(() => {
    return Object.values(schools)
      .filter(s => s.conferenceId === 'cascade-collegiate')
      .map(s => ({
        id: s.id, name: s.name, nickname: s.nickname,
        city: s.city, state: s.state,
        conference: conferences[s.conferenceId]?.abbreviation || 'NAIA',
        level: 'NAIA',
        // Needed by the Team-OVR badge on each program tile.
        programHistory: s.programHistory,
        pearRank: s.pearRank,
        colors: s.colors,
      }))
  }, [schools, conferences])

  const programsForLevel = useMemo(() => {
    if (activeLevel === 'NAIA') return naiaPnwSchools
    return pnwProgramsAtLevel(activeLevel).map(p => ({
      ...p,
      conference: PNW_CONFERENCES[p.conferenceId]?.name || '',
    }))
  }, [activeLevel, naiaPnwSchools])

  const canNext = !!selectedSchoolId && !!customStartRole

  return (
    <PixelCard accent="#fbbf24" title="STEP 2 · PICK YOUR STARTING POSITION">
      <p className="text-[#a8a8c8] text-sm mb-3 font-pixel">
        Sandbox start. Pick any PNW program at any level + the role you want to start in. Career
        progression, offers, and firings all still apply.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-4">
        {/* School picker — left column */}
        <div>
          <div className="text-[10px] uppercase tracking-widest text-amber-300 font-bold mb-2">School</div>
          <div className="flex gap-1 mb-2 flex-wrap">
            {LEVEL_TABS.map(tab => {
              const isActive = activeLevel === tab.key
              return (
                <button
                  key={tab.key}
                  onClick={() => { setActiveLevel(tab.key); setSelectedSchoolId(null) }}
                  className={
                    'px-2.5 py-1 rounded text-[10px] font-pixel uppercase tracking-widest border-2 transition ' +
                    (isActive ? 'bg-amber-400 text-[#1a1a2e] border-amber-300 font-bold'
                              : 'bg-[#23233d] text-[#e8e8e8] border-[#3a3a5e] hover:border-amber-300')
                  }
                >
                  {tab.label}
                </button>
              )
            })}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-[400px] overflow-y-auto pr-1">
            {programsForLevel.length === 0 && (
              <div className="col-span-2 text-center text-[#a8a8c8] py-4 italic text-xs">
                No PNW programs at this level.
              </div>
            )}
            {programsForLevel.map(p => {
              const isSelected = selectedSchoolId === p.id
              // Pass pearRank so expectedTeamOvr uses the rank-bucketed
              // primary path (matches what the loaded team will show).
              // Without this, the PH formula fallback was producing a
              // different OVR than the actual loaded team. Per Nate.
              const teamOvr = expectedTeamOvr({
                programHistory: p.programHistory,
                level: p.level,
                pearRank: p.pearRank,
              })
              const stars = teamOvrToStars(teamOvr)
              return (
                <button
                  key={p.id}
                  onClick={() => setSelectedSchoolId(p.id)}
                  className={
                    'flex items-center gap-2 p-2 rounded border-2 text-left transition ' +
                    (isSelected ? 'border-amber-300 bg-[#3a3a5e]' : 'border-[#3a3a5e] hover:border-[#5a5a8e] bg-[#23233d]')
                  }
                >
                  <TeamLogo school={p} size={28} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <div className="text-white font-bold text-xs truncate">{p.name}</div>
                      <div className={'shrink-0 font-mono font-bold text-[10px] px-1 py-0.5 rounded ' + teamOvrColorClass(teamOvr)} title="Expected starting Team OVR">
                        {teamOvr}
                      </div>
                    </div>
                    <div className="text-[9px] text-[#a8a8c8]">{p.state} · {p.conference}</div>
                    <div className="mt-0.5"><StarRow stars={stars} /></div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Role picker — right column */}
        <div>
          <div className="text-[10px] uppercase tracking-widest text-amber-300 font-bold mb-2">Role</div>
          <div className="space-y-1.5">
            {STORY_CUSTOM_ROLES.map(r => {
              const active = customStartRole === r.key
              return (
                <button
                  key={r.key}
                  onClick={() => setCustomStartRole(r.key)}
                  className={
                    'w-full text-left p-2 rounded-lg border-2 transition ' +
                    (active ? 'border-amber-300 bg-[#3a3a5e]' : 'border-[#3a3a5e] hover:border-[#5a5a8e] bg-[#23233d]')
                  }
                >
                  <div className="text-white font-bold text-xs">{r.label}</div>
                  <div className="text-[9px] text-[#a8a8c8] mt-0.5">{r.tier} tier</div>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="flex justify-between mt-4">
        <PixelButton onClick={onBack}>← Back</PixelButton>
        <PixelButton disabled={!canNext} onClick={onNext}>Next: Mode →</PixelButton>
      </div>
    </PixelCard>
  )
}

function ProgramStep({ schools, conferences, programRatings, selectedSchoolId, setSelectedSchoolId, onBack, onNext }) {
  const [activeLevel, setActiveLevel] = useState('NAIA')

  // NAIA list: the Cascade Collegiate Conference (the only NAIA conference
  // with full PNW representation in our schools dataset). Frontier-conf
  // member rosters need a separate data fix before they're playable.
  const naiaPnwSchools = useMemo(() => {
    return Object.values(schools)
      .filter(s => s.conferenceId === 'cascade-collegiate')
      .map(s => ({
        id: s.id, name: s.name, nickname: s.nickname,
        city: s.city, state: s.state,
        conference: conferences[s.conferenceId]?.abbreviation || 'NAIA',
        confId: s.conferenceId,
        colors: s.colors,
        level: 'NAIA',
        // programHistory drives the expected-Team-OVR badge + star rating
        // on the program tile. NAIA values come from loadSchools.js (PEAR
        // + hand-coded overrides). pearRank (also from loadSchools.js,
        // sorted by pearRating) feeds the rank-bucketed OVR primary path
        // so the displayed badge matches the loaded team exactly.
        programHistory: s.programHistory,
        pearRank: s.pearRank,
      }))
  }, [schools, conferences])

  const programsForLevel = useMemo(() => {
    if (activeLevel === 'NAIA') return naiaPnwSchools
    // D1/D2/D3/NWAC come from the playoff-formats dataset
    return pnwProgramsAtLevel(activeLevel).map(p => ({
      ...p,
      conference: PNW_CONFERENCES[p.conferenceId]?.name || '',
    }))
  }, [activeLevel, naiaPnwSchools])

  const currentTab = LEVEL_TABS.find(t => t.key === activeLevel)
  const isPreviewLevel = currentTab?.status === 'PREVIEW'
  const selectedProgram = programsForLevel.find(p => p.id === selectedSchoolId)

  return (
    <PixelCard accent="#fbbf24" title="STEP 2 · CHOOSE YOUR PROGRAM">
      <p className="text-[#a8a8c8] text-sm mb-3 font-pixel">
        Pick any <strong className="text-amber-300">PNW program</strong> at any level. Stars reflect
        roster talent + recent results — they're a quick read on how strong a program is heading into Year 1.
      </p>

      {/* Level tabs */}
      <div className="flex gap-1 mb-3 flex-wrap">
        {LEVEL_TABS.map(tab => {
          const isActive = activeLevel === tab.key
          return (
            <button
              key={tab.key}
              onClick={() => { setActiveLevel(tab.key); setSelectedSchoolId(null) }}
              className={
                'px-3 py-1.5 rounded text-xs font-pixel uppercase tracking-widest border-2 transition ' +
                (isActive
                  ? 'bg-amber-400 text-[#1a1a2e] border-amber-300 font-bold'
                  : 'bg-[#23233d] text-[#e8e8e8] border-[#3a3a5e] hover:border-amber-300')
              }
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Per-level blurb */}
      <div className="text-[11px] mb-3 p-2 rounded border bg-[#23233d] border-[#3a3a5e] text-[#a8a8c8]">
        {currentTab?.blurb}
      </div>

      {/* Programs grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-4 max-h-[440px] overflow-y-auto pr-1">
        {programsForLevel.length === 0 && (
          <div className="col-span-2 text-center text-[#a8a8c8] py-6 italic text-xs">
            No PNW programs at this level in the dataset.
          </div>
        )}
        {programsForLevel.map(p => {
          const isSelected = selectedSchoolId === p.id
          // Compute expected starting Team OVR — same number the Roster
          // page will show once the dynasty is created. Stars derived
          // directly from Team OVR (0.5★ ≈ 66 OVR, 5★ ≈ 91 OVR). pearRank
          // is REQUIRED so expectedTeamOvr uses the rank-bucketed primary
          // path (D1 80-98, D2/NAIA 60-84, D3 58-82, NWAC 51-75) — without
          // it the PH formula fallback returns a stale value that doesn't
          // match the loaded team. Per Nate (Everett-OVR-mismatch fix).
          const teamOvr = expectedTeamOvr({
            programHistory: p.programHistory,
            level: p.level,
            pearRank: p.pearRank,
          })
          const stars = teamOvrToStars(teamOvr)
          const rating = programRatings?.[p.id]
          const nationalRank = rating?.nationalRank ?? p.pearRank
          return (
            <button
              key={p.id}
              onClick={() => setSelectedSchoolId(p.id)}
              className={
                'flex items-center gap-4 p-3 rounded-lg border-2 text-left transition ' +
                (isSelected
                  ? 'border-amber-300 bg-[#3a3a5e]'
                  : 'border-[#3a3a5e] hover:border-[#5a5a8e] bg-[#23233d]')
              }
            >
              <TeamLogo school={p} size={64} className="shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <div className="text-white font-bold text-sm truncate">{p.name}</div>
                  <div
                    className={'shrink-0 font-mono font-bold text-xs px-1.5 py-0.5 rounded ' + teamOvrColorClass(teamOvr)}
                    title="Expected starting Team OVR — top-9 hitters × 0.55 + top-5 pitchers × 0.45"
                  >
                    {teamOvr} OVR
                  </div>
                </div>
                <div className="text-[10px] text-[#a8a8c8] mt-0.5">
                  {p.city || '—'}{p.city && p.state ? ', ' : ''}{p.state} · {p.conference}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <StarRow stars={stars} />
                  {nationalRank && (
                    <span className="text-[9px] text-amber-300 font-bold">#{nationalRank}</span>
                  )}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="flex justify-between">
        <PixelButton onClick={onBack}>← Back</PixelButton>
        <PixelButton
          disabled={!selectedSchoolId}
          onClick={onNext}
        >
          Next: Coach →
        </PixelButton>
      </div>
    </PixelCard>
  )
}

/**
 * Shows what to expect when picking a non-NAIA preview program — playoff
 * format, roster eligibility, current engine integration status.
 */
function PreviewBlurb({ level, program }) {
  const division = PNW_DIVISIONS[level]
  const conf = PNW_CONFERENCES[program.conferenceId]
  const elig = division?.eligibility
  const cap = division?.rosterCap
  return (
    <div className="space-y-1.5">
      <div className="text-[#e8e8e8]">
        <strong className="text-amber-200">Conference:</strong> {conf?.name || '—'} ({conf?.tournament?.fieldSize}-team {conf?.tournament?.format?.toLowerCase()})
      </div>
      <div className="text-[#e8e8e8]">
        <strong className="text-amber-200">Eligibility:</strong> {elig?.classYears?.join(', ') || '—'} ({elig?.maxSeasonsPerPlayer} yrs max)
      </div>
      <div className="text-[#e8e8e8]">
        <strong className="text-amber-200">Roster cap:</strong> {cap || '—'} players
      </div>
      <div className="text-[#e8e8e8]">
        <strong className="text-amber-200">Postseason:</strong> {conf?.tournament?.details}
      </div>
    </div>
  )
}

/**
 * Colored chip class for the Team OVR badge on each program tile. Mirrors
 * the standard OVR tier coloring used elsewhere in the GM UI — elite
 * programs stand out, weak ones recede.
 */
function teamOvrColorClass(ovr) {
  if (ovr >= 90) return 'bg-emerald-500 text-emerald-950'      // elite (top D1)
  if (ovr >= 85) return 'bg-lime-500 text-lime-950'             // strong (top NAIA, mid D1)
  if (ovr >= 80) return 'bg-yellow-400 text-yellow-950'         // above average
  if (ovr >= 75) return 'bg-amber-500 text-amber-950'           // average
  if (ovr >= 70) return 'bg-orange-500 text-orange-950'         // below average
  return 'bg-red-500 text-red-950'                              // weak
}

function StarRow({ stars }) {
  const bar = starsToBar(stars)
  return (
    <div className="flex gap-0.5">
      {bar.map((kind, i) => {
        if (kind === 'full') return <span key={i} className="text-amber-300">★</span>
        if (kind === 'empty') return <span key={i} className="text-[#3a3a5e]">★</span>
        // Half — overlay an amber clipped star on top of an empty gray star
        return (
          <span key={i} className="relative inline-block">
            <span className="text-[#3a3a5e]">★</span>
            <span
              className="absolute inset-0 text-amber-300 overflow-hidden"
              style={{ width: '50%' }}
            >★</span>
          </span>
        )
      })}
      <span className="ml-1 text-[10px] text-[#a8a8c8] tabular-nums font-mono">{stars.toFixed(1)}</span>
    </div>
  )
}

// ─── ModeStep was merged into SetupStep (May 2026) ──────────────────────
// Old standalone Mode step removed — its UI lives at the bottom of SetupStep
// now. ModeStep was here in the file; replacing with a no-op marker so any
// lingering reference fails loudly rather than silently rendering nothing.

function _DeprecatedModeStep() {
  return null
}

// ─── Step 3: Coach ──────────────────────────────────────────────────────────

function CoachStep({
  coachFirst, setCoachFirst, coachLast, setCoachLast,
  coachLookId, setCoachLookId,
  primaryRegion, setPrimaryRegion,
  secondaryRegion, setSecondaryRegion,
  archetype, setArchetype, ratings,
  onBack, onNext, canNext,
}) {
  return (
    <PixelCard accent="#fbbf24" title="STEP 3 · BUILD YOUR COACH">
      {/* Name + headshot */}
      <div className="grid grid-cols-1 md:grid-cols-[120px_1fr] gap-4 mb-5">
        <div>
          <label className="text-[10px] uppercase tracking-widest text-amber-300 font-bold block mb-2">Portrait</label>
          <div className="bg-[#1a1a2e] border-4 border-[#3a3a5e] rounded-lg p-2 flex items-center justify-center">
            <CoachHeadshot lookId={coachLookId} size={96} />
          </div>
        </div>
        <div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-[10px] uppercase tracking-widest text-amber-300 font-bold">First Name</label>
              <input
                className="block w-full mt-1 bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded px-3 py-2 text-sm text-white"
                value={coachFirst} onChange={e => setCoachFirst(e.target.value)}
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-amber-300 font-bold">Last Name</label>
              <input
                className="block w-full mt-1 bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded px-3 py-2 text-sm text-white"
                value={coachLast} onChange={e => setCoachLast(e.target.value)}
              />
            </div>
          </div>
          <div className="text-[10px] text-[#a8a8c8] uppercase tracking-widest mb-1">Pick a look</div>
          <div className="grid grid-cols-10 gap-1">
            {COACH_LOOKS.map(look => (
              <button
                key={look.id}
                onClick={() => setCoachLookId(look.id)}
                className={
                  'p-0.5 rounded transition ' +
                  (coachLookId === look.id ? 'bg-amber-300' : 'bg-[#3a3a5e] hover:bg-[#5a5a8e]')
                }
              >
                <CoachHeadshot lookId={look.id} size={28} />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Regions */}
      <div className="mb-5">
        <label className="text-[10px] uppercase tracking-widest text-amber-300 font-bold mb-1 block">
          Recruiting Regions
        </label>
        <p className="text-[10px] text-[#a8a8c8] mb-2">
          Pick a <strong className="text-amber-300">primary region (3× boost)</strong> and a
          <strong className="text-amber-300"> secondary region (1.7× boost)</strong>. Recruits from
          these regions flow to you more often and arrive on the board with some interest already.
        </p>
        <RegionPicker
          label="Primary"
          value={primaryRegion}
          setValue={(r) => {
            setPrimaryRegion(r)
            if (secondaryRegion === r) setSecondaryRegion(null)
          }}
          excludeValue={secondaryRegion}
          accent="#fbbf24"
        />
        <div className="mt-3">
          <RegionPicker
            label="Secondary"
            value={secondaryRegion}
            setValue={setSecondaryRegion}
            excludeValue={primaryRegion}
            disabled={!primaryRegion}
            accent="#94a3b8"
          />
        </div>
      </div>

      {/* Archetype */}
      <div className="mb-5">
        <label className="text-[10px] uppercase tracking-widest text-amber-300 font-bold mb-1 block">
          Coaching Archetype
        </label>
        <p className="text-[10px] text-[#a8a8c8] mb-2">
          Your coaching identity. Ratings always sum to 200 — specialists trade their weak areas for a headline strength.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
          {Object.values(ARCHETYPES).map(a => {
            const selected = archetype === a.key
            return (
              <button
                key={a.key}
                onClick={() => setArchetype(a.key)}
                className={
                  'text-left p-2.5 rounded-lg border-4 transition bg-[#23233d] ' +
                  (selected ? 'border-amber-300' : 'border-[#3a3a5e] hover:border-[#5a5a8e]')
                }
              >
                <div className={'font-bold text-sm ' + (selected ? 'text-amber-300' : 'text-white')}>{a.label}</div>
                <div className="text-[10px] text-[#a8a8c8] mt-1 leading-snug">{a.blurb}</div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Ratings */}
      <div className="mb-3">
        <label className="text-[10px] uppercase tracking-widest text-amber-300 font-bold block mb-1">
          Your Ratings · Total {Object.values(ratings).reduce((s, v) => s + v, 0)}
        </label>
        <p className="text-[10px] text-[#a8a8c8] mb-2">
          Locked to your archetype. The four numbers always add up to 200.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(ratings).map(([key, val]) => (
            <div key={key} className="border-2 border-[#3a3a5e] rounded-lg p-3 bg-[#23233d]">
              <div className="flex justify-between items-baseline">
                <span className="text-[10px] text-[#a8a8c8] uppercase tracking-widest font-bold">{prettyLabel(key)}</span>
                <span className="font-mono text-amber-300 font-bold text-xl">{val}</span>
              </div>
              <p className="text-[10px] text-[#a8a8c8] mt-1 leading-snug">{RATING_DESCRIPTIONS[key]}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-between mt-5">
        <PixelButton onClick={onBack} accent="#3a3a5e">← Back</PixelButton>
        <PixelButton disabled={!canNext} onClick={onNext}>Next: Confirm →</PixelButton>
      </div>
    </PixelCard>
  )
}

function RegionPicker({ label, value, setValue, excludeValue, disabled = false, accent }) {
  return (
    <div className={disabled ? 'opacity-50 pointer-events-none' : ''}>
      <div className="text-[10px] uppercase tracking-widest font-bold mb-1" style={{ color: accent }}>
        {label} region {value ? '· ' + REGION_LABELS[value] : '· (select one)'}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {REGIONS.map(r => {
          const selected = value === r
          const isExcluded = excludeValue === r
          return (
            <button
              key={r}
              disabled={isExcluded}
              onClick={() => setValue(r)}
              className={
                'text-left p-2 rounded border-2 transition ' +
                (selected
                  ? 'border-current text-[#1a1a2e]'
                  : isExcluded
                  ? 'bg-[#1a1a2e] text-[#3a3a5e] border-[#3a3a5e] cursor-not-allowed'
                  : 'bg-[#23233d] text-white border-[#3a3a5e] hover:border-[#5a5a8e]')
              }
              style={selected ? { backgroundColor: accent, borderColor: accent } : {}}
            >
              <div className="font-bold text-sm">{REGION_LABELS[r]}</div>
              <div className={'text-[10px] mt-0.5 ' + (selected ? 'text-[#1a1a2e]/70' : 'text-[#a8a8c8]')}>{REGION_BLURBS[r]}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── Step 4: Confirm ────────────────────────────────────────────────────────

function ConfirmStep({ school, conf, level, mode, storyMode, difficulty, storyRole, coachFirst, coachLast, coachLookId, primaryRegion, secondaryRegion, ratings, archetype, canSubmit, onBack, onSubmit }) {
  const isStory = storyMode === 'STORY'
  return (
    <PixelCard accent="#fbbf24" title="STEP 4 · CONFIRM AND START">
      {/* Path summary banner */}
      <div className={'rounded p-3 mb-4 border-2 ' + (isStory ? 'bg-purple-900/30 border-purple-400/40' : 'bg-[#0f0f1e] border-amber-400/40')}>
        <div className="font-pixel uppercase tracking-widest text-amber-300 text-[10px] mb-1">
          {isStory ? 'Story Mode' : 'Regular Dynasty'} · {DIFFICULTY_TUNING[difficulty]?.label || difficulty} Difficulty
        </div>
        <p className="text-xs text-[#e8e8e8]">
          {isStory
            ? `You'll start as ${roleLabel(storyRole || 'BENCH_COACH')} at ${school.name}. Climb up. Goal: D1 head coach.`
            : `You're the head coach at ${school.name}. Build a dynasty. No school changes.`}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[120px_1fr] gap-4 mb-6">
        <div className="bg-[#1a1a2e] border-4 border-[#3a3a5e] rounded-lg p-2 flex items-center justify-center">
          <CoachHeadshot lookId={coachLookId} size={96} />
        </div>
        <div className="space-y-1.5 text-sm font-pixel text-[#e8e8e8]">
          <div className="flex items-center gap-2">
            <TeamLogo school={school} size={28} />
            <div className="font-bold text-base">{school.name}</div>
            <span className="text-[#a8a8c8] text-xs">({conf?.abbreviation || ''})</span>
            {level && level !== 'NAIA' && (
              <span className="text-[10px] bg-amber-400 text-[#1a1a2e] font-bold px-1.5 py-0.5 rounded">{level}</span>
            )}
          </div>
          <div><span className="text-[#a8a8c8]">Mode:</span> <strong>{mode}</strong></div>
          <div><span className="text-[#a8a8c8]">Coach:</span> <strong>{coachFirst} {coachLast}</strong></div>
          <div>
            <span className="text-[#a8a8c8]">Regions:</span>{' '}
            <strong>{primaryRegion && REGION_LABELS[primaryRegion]}</strong>
            {' '}(primary, 3× boost) ·{' '}
            <strong>{secondaryRegion && REGION_LABELS[secondaryRegion]}</strong>
            {' '}(secondary, 1.7×)
          </div>
          <div>
            <span className="text-[#a8a8c8]">Archetype:</span>{' '}
            <strong>{ARCHETYPES[archetype]?.label}</strong>
          </div>
          <div className="grid grid-cols-4 gap-2 mt-2">
            {Object.entries(ratings).map(([k, v]) => (
              <div key={k} className="bg-[#23233d] rounded p-1.5 text-center">
                <div className="text-[9px] uppercase tracking-widest text-[#a8a8c8]">{prettyLabel(k)}</div>
                <div className="font-mono font-bold text-amber-300">{v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="text-[10px] text-[#a8a8c8] mb-4 italic">
        Generating the world: 199 NAIA programs, ~7,000 players, ~1,000 coaches, full {school?.region || 'PNW'} schedule. Should take less than a second.
      </p>
      <div className="flex justify-between">
        <PixelButton onClick={onBack} accent="#3a3a5e">← Back</PixelButton>
        <PixelButton disabled={!canSubmit} onClick={onSubmit}>Start Dynasty →</PixelButton>
      </div>
    </PixelCard>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function StepDot({ active, done, num, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className={
        'flex-1 px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-widest transition flex items-center gap-2 ' +
        (active
          ? 'bg-amber-300 text-[#1a1a2e]'
          : done
          ? 'bg-[#3a3a5e] text-amber-300'
          : 'bg-[#23233d] text-[#a8a8c8]')
      }
    >
      <span className="w-5 h-5 rounded-full bg-black/30 flex items-center justify-center text-[10px] font-mono">{num}</span>
      <span>{label}</span>
    </button>
  )
}

function Toggle({ label, sub, value, onChange }) {
  return (
    <label className="flex items-start justify-between cursor-pointer gap-3 py-1">
      <div className="flex-1">
        <div className="text-sm text-white font-semibold">{label}</div>
        {sub && <div className="text-[10px] text-[#a8a8c8] mt-0.5">{sub}</div>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={'w-10 h-6 rounded-full relative transition shrink-0 mt-0.5 ' + (value ? 'bg-amber-300' : 'bg-[#3a3a5e]')}
      >
        <span
          className={'absolute top-0.5 w-5 h-5 bg-white rounded-full transition ' + (value ? 'left-[18px]' : 'left-0.5')}
        />
      </button>
    </label>
  )
}
