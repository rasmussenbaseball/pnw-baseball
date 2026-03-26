/**
 * StatPresetBar — quick toggles to switch between stat views.
 * e.g., "Standard", "Advanced", "Power", "Discipline" for batting.
 */
export default function StatPresetBar({ presets, activePreset, onSelect }) {
  return (
    <div className="flex flex-wrap gap-1.5 sm:gap-2 mb-2 sm:mb-3">
      <span className="text-[10px] sm:text-xs text-gray-500 self-center mr-0.5 sm:mr-1">View:</span>
      {Object.keys(presets).map(preset => (
        <button
          key={preset}
          onClick={() => onSelect(preset)}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors
            ${activePreset === preset
              ? 'bg-pnw-green text-white'
              : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
            }`}
        >
          {preset}
        </button>
      ))}
    </div>
  )
}
