import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { loadSchools } from '../../gm/engine/loadSchools'
import { newDynasty } from '../../gm/engine/newDynasty'
import { saveDynasty, listDynasties } from '../../gm/engine/save'
import TeamLogo from '../../gm/components/TeamLogo'
import { prettyLabel } from '../../gm/engine/format'

import { REGIONS, REGION_LABELS, REGION_BLURBS } from '../../gm/engine/regions'
import { ARCHETYPES } from '../../gm/engine/archetypes'

const COACH_BUILDER_TOTAL_POINTS = 250
const COACH_BUILDER_BASE_RATING = 40
const COACH_BUILDER_MAX = 90

// Plain-English blurbs shown next to each rating slider so the user understands
// what they're spending points on. Kept short — full descriptions live in
// AttrTooltip.ATTR_DESCRIPTIONS for hover tooltips elsewhere.
const RATING_DESCRIPTIONS = {
  developer: 'How fast your players progress toward their potential. Higher = bigger offseason gains for everyone on the roster.',
  motivator: 'Drives team chemistry, GPA boost from coaching, clutch/composure in big moments, and fundraising yield.',
  recruiter: 'Drives weekly AP earned, the program\'s closing rate on verbals, and how many recruits show up to your prospect camp.',
  tactician: 'In-game AI decisions — lineup construction, pitching changes, defensive positioning, situational calls.',
}

// v1.5 — Bushnell only. Architecture is school-agnostic, just gate selection.
const ALLOWED_SCHOOL_IDS = ['bushnell']

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
    blurb: 'Pick your own difficulty + feature toggles.',
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

  const allowedSchools = useMemo(
    () => ALLOWED_SCHOOL_IDS.map(id => schools[id]).filter(Boolean),
    [schools],
  )

  const [step, setStep] = useState(1)
  const [selectedSchoolId, setSelectedSchoolId] = useState(allowedSchools[0]?.id || null)

  // Game mode
  const [modeKey, setModeKey] = useState('TRADITIONAL')
  const [customOptions, setCustomOptions] = useState(GAME_MODE_PRESETS.CUSTOM)

  // Coach
  const [coachFirst, setCoachFirst] = useState('')
  const [coachLast, setCoachLast] = useState('')
  const [regions, setRegions] = useState(['NW'])
  const [archetype, setArchetype] = useState('GENERALIST')

  // Ratings are now FULLY determined by the picked archetype — the user
  // doesn't customize. Identity is the choice; ratings flow from it.
  const ratings = ARCHETYPES[archetype]?.fixedRatings || ARCHETYPES.GENERALIST.fixedRatings
  const canSubmit = selectedSchoolId && coachFirst && coachLast && archetype

  function getGameOptions() {
    if (modeKey === 'TRADITIONAL') {
      return { mode: 'TRADITIONAL', ...GAME_MODE_PRESETS.TRADITIONAL }
    }
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
        regions,
        archetype,
        recruiter_type: 'BALANCED',
        ...ratings,
      },
    })

    const result = saveDynasty(state)
    if (!result.ok) {
      alert('Failed to save: ' + result.error)
      return
    }
    navigate(`/gm/dashboard?slot=${slot}`)
  }

  return (
    <div className="max-w-5xl mx-auto py-8">
      <div className="mb-6">
        <button onClick={() => navigate('/gm')} className="text-sm text-pnw-green hover:underline mb-2">
          ← Back to GM home
        </button>
        <h1 className="text-3xl font-bold text-pnw-slate">New Dynasty</h1>
        <p className="text-sm text-gray-600 mt-1">Pick your school, choose your mode, build your coach.</p>
      </div>

      <div className="flex gap-2 mb-6">
        <StepDot active={step === 1} done={step > 1} label="1. Program" onClick={() => setStep(1)} />
        <StepDot active={step === 2} done={step > 2} label="2. Mode" onClick={() => setStep(2)} />
        <StepDot active={step === 3} done={step > 3} label="3. Coach" onClick={() => setStep(3)} />
        <StepDot active={step === 4} done={step > 4} label="4. Confirm" onClick={() => setStep(4)} />
      </div>

      {step === 1 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <h2 className="text-lg font-semibold mb-3">Choose your program</h2>
          <p className="text-sm text-gray-600 mb-4">
            <strong>v1.5 alpha:</strong> the game launches with Bushnell as the only playable program.
            Coming weeks will add the rest of the PNW NAIA + the full country.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            {allowedSchools.map(s => (
              <button
                key={s.id}
                onClick={() => setSelectedSchoolId(s.id)}
                className={'flex items-center gap-3 p-4 rounded-xl border-2 text-left transition ' +
                  (selectedSchoolId === s.id ? 'border-pnw-green bg-pnw-cream' : 'border-gray-200 hover:border-gray-300')
                }
              >
                <TeamLogo school={s} size={48} />
                <div>
                  <div className="font-semibold">{s.name} {s.nickname}</div>
                  <div className="text-xs text-gray-500">{s.city}, {s.state} • {conferences[s.conferenceId]?.abbreviation}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{s.resourceTier} tier • PEAR rating: {s.pearRating.toFixed(2)}</div>
                </div>
              </button>
            ))}
          </div>

          <div className="text-xs text-gray-500 mb-4">
            <strong>Locked:</strong> 198 other NAIA schools, all D1/D2/D3 PNW programs, full national expansion. Available in coming releases.
          </div>

          <div className="flex justify-end">
            <button
              disabled={!selectedSchoolId}
              onClick={() => setStep(2)}
              className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold disabled:bg-gray-300"
            >
              Next: Mode →
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <h2 className="text-lg font-semibold mb-3">Pick your mode</h2>

          {Object.entries(GAME_MODE_PRESETS).map(([key, preset]) => (
            <button
              key={key}
              onClick={() => setModeKey(key)}
              className={'w-full text-left p-4 rounded-xl border-2 mb-3 transition ' +
                (modeKey === key ? 'border-pnw-green bg-pnw-cream' : 'border-gray-200 hover:border-gray-300')
              }
            >
              <div className="font-semibold text-pnw-slate">{preset.label}</div>
              <div className="text-xs text-gray-600 mt-1">{preset.blurb}</div>
            </button>
          ))}

          {modeKey === 'CUSTOM' && (
            <div className="mt-4 p-4 bg-gray-50 rounded-xl space-y-3">
              <div>
                <label className="text-xs uppercase tracking-wider text-gray-500">Difficulty</label>
                <select
                  className="block w-full mt-1 border rounded px-3 py-2 text-sm"
                  value={customOptions.difficulty}
                  onChange={e => setCustomOptions({ ...customOptions, difficulty: e.target.value })}
                >
                  {['EASY', 'NORMAL', 'HARD', 'BRUTAL'].map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <Toggle label="Injuries" value={customOptions.injuriesEnabled} onChange={v => setCustomOptions({ ...customOptions, injuriesEnabled: v })} />
              <Toggle label="Head coach can be fired" value={customOptions.coachFiringEnabled} onChange={v => setCustomOptions({ ...customOptions, coachFiringEnabled: v })} />
              <Toggle label="Transfer portal" value={customOptions.transferPortalEnabled} onChange={v => setCustomOptions({ ...customOptions, transferPortalEnabled: v })} />
              <Toggle label="Budget constraints" value={customOptions.budgetConstraintsEnabled} onChange={v => setCustomOptions({ ...customOptions, budgetConstraintsEnabled: v })} />
            </div>
          )}

          <div className="flex justify-between mt-4">
            <button onClick={() => setStep(1)} className="px-4 py-2 border rounded text-sm">← Back</button>
            <button onClick={() => setStep(3)} className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold">
              Next: Coach →
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <h2 className="text-lg font-semibold mb-3">Build your coach</h2>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="text-xs text-gray-500 uppercase tracking-wider">First Name</label>
              <input className="block w-full mt-1 border rounded px-3 py-2 text-sm" value={coachFirst} onChange={e => setCoachFirst(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-gray-500 uppercase tracking-wider">Last Name</label>
              <input className="block w-full mt-1 border rounded px-3 py-2 text-sm" value={coachLast} onChange={e => setCoachLast(e.target.value)} />
            </div>
          </div>

          <div className="mb-4">
            <label className="text-xs text-gray-500 uppercase tracking-wider mb-2 flex justify-between">
              <span>Recruiting Regions</span>
              <span className={'normal-case font-mono ' + (regions.length >= 2 ? 'text-amber-700' : 'text-gray-500')}>
                {regions.length}/2 selected
              </span>
            </label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {REGIONS.map(r => {
                const selected = regions.includes(r)
                const disabled = !selected && regions.length >= 2
                return (
                  <button
                    key={r}
                    disabled={disabled}
                    onClick={() => setRegions(selected ? regions.filter(x => x !== r) : [...regions, r])}
                    className={'text-left p-2 rounded border ' +
                      (selected ? 'bg-pnw-green text-white border-pnw-green'
                        : disabled ? 'bg-gray-50 text-gray-300 border-gray-100 cursor-not-allowed'
                          : 'bg-white text-gray-700 border-gray-200 hover:border-pnw-green')}
                  >
                    <div className="font-semibold text-sm">{REGION_LABELS[r]}</div>
                    <div className={'text-[10px] mt-0.5 ' + (selected ? 'text-pnw-cream' : 'text-gray-500')}>{REGION_BLURBS[r]}</div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* HC archetype — biases what kind of staff syncs with you */}
          <div className="mb-5">
            <label className="text-xs text-gray-500 uppercase tracking-wider mb-2 block">Coaching Archetype</label>
            <p className="text-[11px] text-gray-500 mb-2">
              Defines your coaching identity. Hiring assistants who share your archetype creates an "echo staff" (+5%);
              hiring opposites creates a "balanced staff" (+4%).
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
              {Object.values(ARCHETYPES).map(a => {
                const selected = archetype === a.key
                return (
                  <button
                    key={a.key}
                    onClick={() => setArchetype(a.key)}
                    className={'text-left p-2.5 rounded-lg border-2 transition ' +
                      (selected
                        ? 'border-pnw-green bg-pnw-cream'
                        : 'border-gray-200 bg-white hover:border-gray-400')}
                  >
                    <div className={'font-bold text-sm ' + a.color}>{a.label}</div>
                    <div className="text-[10px] text-gray-600 mt-1 leading-snug">{a.blurb}</div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Read-only ratings preview based on selected archetype */}
          <div className="mb-2">
            <label className="text-xs text-gray-500 uppercase tracking-wider block mb-1">Your Ratings</label>
            <p className="text-[11px] text-gray-500 mb-2">
              Locked to your archetype. Identity is the choice — ratings flow from it.
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Object.entries(ratings).map(([key, val]) => (
              <div key={key} className="border border-gray-100 rounded-lg p-3 bg-gray-50">
                <div className="flex justify-between items-baseline">
                  <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">{prettyLabel(key)}</span>
                  <span className="font-mono text-pnw-green font-bold text-xl">{val}</span>
                </div>
                <p className="text-[10px] text-gray-600 mt-1 leading-snug">
                  {RATING_DESCRIPTIONS[key]}
                </p>
              </div>
            ))}
          </div>

          <div className="flex justify-between mt-4">
            <button onClick={() => setStep(2)} className="px-4 py-2 border rounded text-sm">← Back</button>
            <button
              disabled={!coachFirst || !coachLast || !archetype}
              onClick={() => setStep(4)}
              className="px-4 py-2 bg-pnw-green text-white rounded text-sm font-semibold disabled:bg-gray-300"
            >
              Next: Confirm →
            </button>
          </div>
        </div>
      )}

      {step === 4 && selectedSchoolId && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
          <h2 className="text-lg font-semibold mb-3">Confirm and start dynasty</h2>
          <div className="text-sm space-y-2 mb-6">
            <div><strong>School:</strong> {schools[selectedSchoolId].name} ({conferences[schools[selectedSchoolId].conferenceId].abbreviation})</div>
            <div><strong>Mode:</strong> {GAME_MODE_PRESETS[modeKey].label}</div>
            <div><strong>Coach:</strong> {coachFirst} {coachLast}</div>
            <div><strong>Regions of expertise:</strong> {regions.length ? regions.map(r => REGION_LABELS[r]).join(', ') : 'none'}</div>
            <div><strong>Coach ratings:</strong> {Object.entries(ratings).map(([k, v]) => `${k}=${v}`).join(' • ')}</div>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            Generating the world: 199 schools, ~7,000 players, ~1,000 coaches, full 2027 schedule. Should take less than a second.
          </p>
          <div className="flex justify-between">
            <button onClick={() => setStep(3)} className="px-4 py-2 border rounded text-sm">← Back</button>
            <button
              disabled={!canSubmit}
              onClick={handleCreate}
              className="px-6 py-2 bg-pnw-green text-white rounded text-sm font-semibold disabled:bg-gray-300"
            >
              Start Dynasty
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function StepDot({ active, done, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className={'flex-1 px-3 py-2 rounded text-xs font-semibold ' +
        (active ? 'bg-pnw-green text-white' : done ? 'bg-pnw-cream text-pnw-slate' : 'bg-gray-100 text-gray-500')
      }
    >
      {label}
    </button>
  )
}

function Toggle({ label, value, onChange }) {
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-sm text-gray-700">{label}</span>
      <button
        onClick={() => onChange(!value)}
        className={'w-10 h-6 rounded-full relative transition ' + (value ? 'bg-pnw-green' : 'bg-gray-300')}
      >
        <span
          className={'absolute top-0.5 w-5 h-5 bg-white rounded-full transition ' + (value ? 'left-[18px]' : 'left-0.5')}
        />
      </button>
    </label>
  )
}
