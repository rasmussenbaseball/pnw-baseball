import { useState, useEffect } from 'react'
import { useSeasons } from '../hooks/useApi'

/**
 * FilterBar - the main control panel for the dashboard.
 * Lets users filter by division, conference, state, season,
 * and set PA/IP minimums for qualified leaderboards.
 */
export default function FilterBar({ filters, onChange, divisions, conferences }) {
  const { data: availableSeasons } = useSeasons()
  const seasons = availableSeasons && availableSeasons.length > 0
    ? availableSeasons
    : [2026, 2025, 2024, 2023, 2022]  // fallback
  const states = ['WA', 'OR', 'ID', 'MT']
  const classYears = [
    { value: 'Fr', label: 'Fr' },
    { value: 'So', label: 'So' },
    { value: 'Jr', label: 'Jr' },
    { value: 'Sr', label: 'Sr' },
  ]
  const positionGroups = [
    { value: 'IF', label: 'IF' },
    { value: 'OF', label: 'OF' },
    { value: 'C', label: 'C' },
    { value: 'UT', label: 'UT/DH' },
    { value: 'P', label: 'P' },
  ]

  const handleChange = (key, value) => {
    onChange({ ...filters, [key]: value || null })
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3 sm:p-4 mb-4">
      <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 sm:gap-3 items-end">

        {/* Season */}
        <div className="flex flex-col">
          <label className="text-xs font-medium text-gray-500 mb-1">Season</label>
          <select
            value={filters.season || 2026}
            onChange={(e) => handleChange('season', parseInt(e.target.value))}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky focus:border-transparent"
          >
            {seasons.map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>

        {/* Division */}
        <div className="flex flex-col">
          <label className="text-xs font-medium text-gray-500 mb-1">Division</label>
          <select
            value={filters.division_id || ''}
            onChange={(e) => handleChange('division_id', e.target.value ? parseInt(e.target.value) : null)}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
          >
            <option value="">All Levels</option>
            {divisions?.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>

        {/* Conference */}
        <div className="flex flex-col">
          <label className="text-xs font-medium text-gray-500 mb-1">Conference</label>
          <select
            value={filters.conference_id || ''}
            onChange={(e) => handleChange('conference_id', e.target.value ? parseInt(e.target.value) : null)}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
          >
            <option value="">All Conferences</option>
            {conferences
              ?.filter(c => !filters.division_id || c.division_id === filters.division_id)
              .map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
          </select>
        </div>

        {/* State */}
        <div className="flex flex-col">
          <label className="text-xs font-medium text-gray-500 mb-1">State</label>
          <select
            value={filters.state || ''}
            onChange={(e) => handleChange('state', e.target.value || null)}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
          >
            <option value="">All States</option>
            {states.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* Class Year */}
        <div className="flex flex-col">
          <label className="text-xs font-medium text-gray-500 mb-1">Class</label>
          <select
            value={filters.year_in_school || ''}
            onChange={(e) => handleChange('year_in_school', e.target.value || null)}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
          >
            <option value="">All Classes</option>
            {classYears.map(y => (
              <option key={y.value} value={y.value}>{y.label}</option>
            ))}
          </select>
        </div>

        {/* Position Group (show for batting and WAR leaderboards) */}
        {(filters._type === 'batting' || filters._type === 'war') && (
          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">Position</label>
            <select
              value={filters.position_group || ''}
              onChange={(e) => handleChange('position_group', e.target.value || null)}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
            >
              <option value="">All Positions</option>
              {positionGroups.map(pg => (
                <option key={pg.value} value={pg.value}>{pg.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* PA Minimum (batting) */}
        {filters._type !== 'pitching' && (
          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">Min PA</label>
            <input
              type="number"
              value={filters.min_pa || 0}
              onChange={(e) => handleChange('min_pa', parseInt(e.target.value) || 0)}
              min={0}
              max={300}
              step={10}
              className="w-20 rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
            />
          </div>
        )}

        {/* IP Minimum (pitching and WAR) */}
        {(filters._type === 'pitching' || filters._type === 'war') && (
          <div className="flex flex-col">
            <label className="text-xs font-medium text-gray-500 mb-1">Min IP</label>
            <input
              type="number"
              value={filters.min_ip || 0}
              onChange={(e) => handleChange('min_ip', parseFloat(e.target.value) || 0)}
              min={0}
              max={150}
              step={5}
              className="w-20 rounded border border-gray-300 px-3 py-1.5 text-sm focus:ring-2 focus:ring-pnw-sky"
            />
          </div>
        )}

        {/* Qualified checkbox */}
        <div className="flex flex-col justify-end">
          <label className="flex items-center gap-1.5 cursor-pointer py-1.5">
            <input
              type="checkbox"
              checked={!!filters.qualified}
              onChange={(e) => handleChange('qualified', e.target.checked)}
              className="rounded border-gray-300 text-pnw-teal focus:ring-pnw-sky h-4 w-4"
            />
            <span className="text-sm font-medium text-gray-700">Qualified</span>
          </label>
        </div>

        {/* Conference Only checkbox */}
        <div className="flex flex-col justify-end">
          <label className="flex items-center gap-1.5 cursor-pointer py-1.5">
            <input
              type="checkbox"
              checked={!!filters.conference_only}
              onChange={(e) => handleChange('conference_only', e.target.checked)}
              className="rounded border-gray-300 text-pnw-teal focus:ring-pnw-sky h-4 w-4"
            />
            <span className="text-sm font-medium text-gray-700">Conf. Only</span>
          </label>
        </div>

        {/* Reset */}
        <button
          onClick={() => onChange({ season: filters.season, _type: filters._type })}
          className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-800 border border-gray-300 rounded hover:bg-gray-100"
        >
          Reset Filters
        </button>
      </div>
    </div>
  )
}
