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
import { saveDynasty, listDynasties } from '../../gm/engine/save'
import { buildProgramRatings, starsToBar } from '../../gm/engine/programRating'
import { REGIONS, REGION_LABELS, REGION_BLURBS } from '../../gm/engine/regions'
import { ARCHETYPES } from '../../gm/engine/archetypes'
import { PNW_DIVISIONS, PNW_CONFERENCES, pnwProgramsAtLevel } from '../../gm/engine/pnwPlayoffs'
import TeamLogo from '../../gm/components/TeamLogo'
import GMShell, { PixelCard, PixelButton } from '../../gm/components/GMShell'
import CoachHeadshot, { COACH_LOOKS } from '../../gm/components/CoachHeadshot'
import { prettyLabel } from '../../gm/engine/format'

// Level pickers — NAIA is the fully-shipped path; others are PREVIEW (engine
// integration is still partial; expect rough edges on schedule generation
// and recruiting flows for non-NAIA).
const LEVEL_TABS = [
  { key: 'NAIA', label: 'NAIA',  status: 'PLAYABLE',   blurb: 'Full alpha experience. 4-year programs, deep recruiting, full sim.' },
  { key: 'D1',   label: 'D1',    status: 'PREVIEW',    blurb: 'NCAA Division I — 4-year. Engine support partial; schedule + national-bracket integration coming.' },
  { key: 'D2',   label: 'D2',    status: 'PREVIEW',    blurb: 'NCAA Division II — 4-year. Engine support partial.' },
  { key: 'D3',   label: 'D3',    status: 'PREVIEW',    blurb: 'NCAA Division III — 4-year, no athletic scholarships. Engine support partial.' },
  { key: 'NWAC', label: 'NWAC',  status: 'PREVIEW',    blurb: 'JUCO — 2-year. Only FR/SO eligible. Players transfer out after SO year. Engine support partial.' },
]

// Legacy — Year-1 alpha only allowed CCC. Now we surface all NAIA programs
// in the PNW + every PNW conference at every level.
const ALLOWED_CONFERENCE_ID = 'cascade-collegiate'

const RATING_DESCRIPTIONS = {
  developer: 'Drives offseason player progression — bigger gains for everyone on the roster.',
  motivator: 'Team chemistry + GPA boost + clutch/composure in big moments + fundraising yield.',
  recruiter: 'Weekly AP earned + closing rate on verbals + prospect-camp turnout.',
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

  const [modeKey, setModeKey] = useState('TRADITIONAL')
  const [customOptions, setCustomOptions] = useState(GAME_MODE_PRESETS.CUSTOM)

  const [coachFirst, setCoachFirst] = useState('')
  const [coachLast, setCoachLast] = useState('')
  const [coachLookId, setCoachLookId] = useState(0)
  const [primaryRegion, setPrimaryRegion] = useState(null)
  const [secondaryRegion, setSecondaryRegion] = useState(null)
  const [archetype, setArchetype] = useState('GENERALIST')

  const ratings = ARCHETYPES[archetype]?.fixedRatings || ARCHETYPES.GENERALIST.fixedRatings
  // Block dynasty creation when the selected program isn't NAIA — the
  // engine plumbing for non-NAIA levels (schedule generation, recruiting
  // pools, postseason routing) isn't wired up yet. Picker still surfaces
  // them so the user can preview formats / rosters.
  const selectedIsNaia = !!schools[selectedSchoolId]
  const canSubmit = selectedSchoolId && selectedIsNaia
    && coachFirst && coachLast && primaryRegion && secondaryRegion && archetype

  function getGameOptions() {
    if (modeKey === 'TRADITIONAL') return { mode: 'TRADITIONAL', ...GAME_MODE_PRESETS.TRADITIONAL }
    return { mode: 'CUSTOM', ...customOptions }
  }

  function handleCreate() {
    const userId = user?.id || 'guest'
    const existing = listDynasties(userId)
    const usedSlots = new Set(existing.map(d => d.slot))
    let slot = 1
    while (slot <= 3 && usedSlots.has(slot)) slot++
    if (slot > 3) {
      alert('All 3 save slots are used. Delete one to start a new dynasty.')
      return
    }
    const school = schools[selectedSchoolId]
    const state = newDynasty({
      userSupabaseId: userId,
      saveSlot: slot,
      dynastyName: `${coachFirst} ${coachLast}'s ${school.name}`,
      userSchoolId: selectedSchoolId,
      gameOptions: getGameOptions(),
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
    })
    const result = saveDynasty(state)
    if (!result.ok) { alert('Failed to save: ' + result.error); return }
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
          <p className="font-pixel text-base text-[#a8a8c8]">Pick your school, choose your mode, build your coach.</p>
        </div>

        <div className="flex gap-2 mb-6 flex-wrap">
          <StepDot active={step === 1} done={step > 1} num={1} label="Program" onClick={() => setStep(1)} />
          <StepDot active={step === 2} done={step > 2} num={2} label="Mode" onClick={() => setStep(2)} />
          <StepDot active={step === 3} done={step > 3} num={3} label="Coach" onClick={() => setStep(3)} />
          <StepDot active={step === 4} done={step > 4} num={4} label="Confirm" onClick={() => setStep(4)} />
        </div>

        {step === 1 && (
          <ProgramStep
            schools={allowedSchools}
            conferences={conferences}
            selectedSchoolId={selectedSchoolId}
            setSelectedSchoolId={setSelectedSchoolId}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <ModeStep
            modeKey={modeKey}
            setModeKey={setModeKey}
            customOptions={customOptions}
            setCustomOptions={setCustomOptions}
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
        {step === 4 && selectedSchoolId && schools[selectedSchoolId] && (
          <ConfirmStep
            school={schools[selectedSchoolId]}
            conf={conferences[schools[selectedSchoolId].conferenceId]}
            mode={GAME_MODE_PRESETS[modeKey].label}
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
        {step === 4 && selectedSchoolId && !schools[selectedSchoolId] && (
          <PixelCard accent="#fbbf24" title="STEP 4 · PREVIEW LEVEL — NOT PLAYABLE YET">
            <div className="text-amber-200 bg-amber-900/30 border-2 border-amber-400/40 rounded p-4 mb-4">
              <div className="font-pixel uppercase tracking-widest text-amber-300 text-xs mb-2">Engine integration incomplete</div>
              <p className="text-sm text-[#e8e8e8] mb-2">
                The non-NAIA program you selected isn't dynasty-playable yet. The schedule
                generator, recruiting pools, and postseason routing for D1/D2/D3/NWAC are
                still being wired into the engine.
              </p>
              <p className="text-sm text-[#e8e8e8]">
                For now, head back to <strong className="text-amber-300">Step 1</strong> and pick a
                NAIA program — those are fully playable. We'll surface non-NAIA paths as
                each one's engine integration ships.
              </p>
            </div>
            <div className="flex justify-between">
              <PixelButton onClick={() => setStep(1)} accent="#3a3a5e">← Back to Step 1</PixelButton>
            </div>
          </PixelCard>
        )}
      </div>
    </GMShell>
  )
}

// ─── Step 1: Program ────────────────────────────────────────────────────────

function ProgramStep({ schools, conferences, selectedSchoolId, setSelectedSchoolId, onNext }) {
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
    <PixelCard accent="#fbbf24" title="STEP 1 · CHOOSE YOUR PROGRAM">
      <p className="text-[#a8a8c8] text-sm mb-3 font-pixel">
        Pick any <strong className="text-amber-300">PNW program</strong> at any level. NAIA is the fully shipped path;
        other levels are PREVIEW while engine integration finishes.
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
              {tab.status === 'PREVIEW' && (
                <span className="ml-1.5 text-[8px] font-bold tracking-wider opacity-75">PREVIEW</span>
              )}
            </button>
          )
        })}
      </div>

      {/* Per-level blurb */}
      <div className={
        'text-[11px] mb-3 p-2 rounded border ' +
        (isPreviewLevel ? 'bg-amber-900/30 border-amber-400/40 text-amber-200' : 'bg-[#23233d] border-[#3a3a5e] text-[#a8a8c8]')
      }>
        {isPreviewLevel && <strong>PREVIEW: </strong>}
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
          return (
            <button
              key={p.id}
              onClick={() => setSelectedSchoolId(p.id)}
              className={
                'flex items-center gap-3 p-2.5 rounded-lg border-2 text-left transition ' +
                (isSelected
                  ? 'border-amber-300 bg-[#3a3a5e]'
                  : 'border-[#3a3a5e] hover:border-[#5a5a8e] bg-[#23233d]')
              }
            >
              <TeamLogo school={p} size={36} />
              <div className="flex-1 min-w-0">
                <div className="text-white font-bold text-sm truncate">{p.name}</div>
                <div className="text-[10px] text-[#a8a8c8] mt-0.5">
                  {p.city || '—'}{p.city && p.state ? ', ' : ''}{p.state} · {p.conference}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {/* Selected-program detail (shows playoff path + roster info for non-NAIA) */}
      {selectedProgram && isPreviewLevel && (
        <div className="bg-[#0f0f1e] border-2 border-amber-400/40 rounded p-3 mb-3 text-[11px]">
          <div className="font-pixel uppercase tracking-widest text-amber-300 text-[10px] mb-1.5">
            {selectedProgram.name} — {activeLevel} preview
          </div>
          <PreviewBlurb level={activeLevel} program={selectedProgram} />
        </div>
      )}

      <div className="flex justify-end">
        <PixelButton
          disabled={!selectedSchoolId}
          onClick={onNext}
        >
          Next: Mode →
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
      <div className="text-amber-300/80 italic mt-2 text-[10px]">
        Engine integration in progress: schedule generation, recruiting pools, and
        national-bracket routing for non-NAIA levels are still being wired in. Selection works;
        season flow may have gaps until full integration ships.
      </div>
    </div>
  )
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

// ─── Step 2: Mode ───────────────────────────────────────────────────────────

function ModeStep({ modeKey, setModeKey, customOptions, setCustomOptions, onBack, onNext }) {
  return (
    <PixelCard accent="#fbbf24" title="STEP 2 · PICK YOUR MODE">
      {Object.entries(GAME_MODE_PRESETS).map(([key, preset]) => (
        <button
          key={key}
          onClick={() => setModeKey(key)}
          className={
            'w-full text-left p-4 rounded-xl border-4 mb-3 transition ' +
            (modeKey === key ? 'border-amber-300 bg-[#3a3a5e]' : 'border-[#3a3a5e] hover:border-[#5a5a8e] bg-[#23233d]')
          }
        >
          <div className="font-bold text-white text-base">{preset.label}</div>
          <div className="text-xs text-[#a8a8c8] mt-1">{preset.blurb}</div>
        </button>
      ))}

      {modeKey === 'CUSTOM' && (
        <div className="mt-4 p-4 bg-[#23233d] rounded-xl space-y-3 border-4 border-[#3a3a5e]">
          <div>
            <label className="text-[10px] uppercase tracking-widest text-amber-300 font-bold">Difficulty</label>
            <p className="text-[10px] text-[#a8a8c8] mb-1">Affects AI rival strength and overall challenge.</p>
            <select
              className="block w-full mt-1 bg-[#1a1a2e] border-2 border-[#3a3a5e] rounded px-3 py-2 text-sm text-white"
              value={customOptions.difficulty}
              onChange={e => setCustomOptions({ ...customOptions, difficulty: e.target.value })}
            >
              {['EASY', 'NORMAL', 'HARD', 'BRUTAL'].map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <Toggle
            label="Injuries"
            sub="Players can get hurt in games + practice. Recommended on for realism."
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
            sub="Hard cap on annual athletic budget. Off = unlimited spending."
            value={customOptions.budgetConstraintsEnabled}
            onChange={v => setCustomOptions({ ...customOptions, budgetConstraintsEnabled: v })}
          />
          <Toggle
            label="Head coach can be fired"
            sub="Job security can drop to zero and end your dynasty."
            value={customOptions.coachFiringEnabled}
            onChange={v => setCustomOptions({ ...customOptions, coachFiringEnabled: v })}
          />
          <div className="text-[10px] text-amber-300 italic">
            Some Custom toggles are wired (injuries, difficulty); others are scaffolded for upcoming releases.
          </div>
        </div>
      )}

      <div className="flex justify-between mt-4">
        <PixelButton onClick={onBack} accent="#3a3a5e">← Back</PixelButton>
        <PixelButton onClick={onNext}>Next: Coach →</PixelButton>
      </div>
    </PixelCard>
  )
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

function ConfirmStep({ school, conf, mode, coachFirst, coachLast, coachLookId, primaryRegion, secondaryRegion, ratings, archetype, canSubmit, onBack, onSubmit }) {
  return (
    <PixelCard accent="#fbbf24" title="STEP 4 · CONFIRM AND START">
      <div className="grid grid-cols-1 md:grid-cols-[120px_1fr] gap-4 mb-6">
        <div className="bg-[#1a1a2e] border-4 border-[#3a3a5e] rounded-lg p-2 flex items-center justify-center">
          <CoachHeadshot lookId={coachLookId} size={96} />
        </div>
        <div className="space-y-1.5 text-sm font-pixel text-[#e8e8e8]">
          <div className="flex items-center gap-2">
            <TeamLogo school={school} size={28} />
            <div className="font-bold text-base">{school.name}</div>
            <span className="text-[#a8a8c8] text-xs">({conf.abbreviation})</span>
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
