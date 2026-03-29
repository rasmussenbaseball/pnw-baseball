import { useState, useEffect, useRef } from 'react'
import { useTeams } from '../hooks/useApi'

// ─── Team coordinates (lat, lng) by short_name ───
// These map DB short_name to [lat, lng] for map placement.
const TEAM_COORDS = {
  // D1
  "UW":         [47.6507, -122.3015],   // Seattle, WA
  "Oregon":     [44.0582, -123.0684],   // Eugene, OR
  "Oregon St.": [44.5646, -123.2620],   // Corvallis, OR
  "Wash. St.":  [46.7324, -117.1572],   // Pullman, WA
  "Gonzaga":    [47.6672, -117.4017],   // Spokane, WA
  "Portland":   [45.5732, -122.7249],   // Portland, OR
  "Seattle U":  [47.6128, -122.3205],   // Seattle, WA

  // D2 (GNAC)
  "CWU":   [46.9965, -120.5478],   // Ellensburg, WA
  "SMU":   [47.0073, -122.7982],   // Lacey, WA
  "MSUB":  [45.7833, -108.5007],   // Billings, MT
  "WOU":   [44.8490, -123.2340],   // Monmouth, OR
  "NNU":   [43.5826, -116.5596],   // Nampa, ID

  // D3 (NWC)
  "UPS":       [47.2620, -122.4825],   // Tacoma, WA
  "PLU":       [47.1456, -122.4465],   // Tacoma/Parkland, WA
  "Whitman":   [46.0708, -118.3281],   // Walla Walla, WA
  "Whitworth": [47.7529, -117.4184],   // Spokane, WA
  "L&C":       [45.4497, -122.6702],   // Portland, OR
  "Pacific":   [45.5240, -123.1124],   // Forest Grove, OR
  "Linfield":  [45.2039, -123.1975],   // McMinnville, OR
  "GFU":       [45.3048, -122.7695],   // Newberg, OR
  "Willamette": [44.9362, -123.0244],  // Salem, OR

  // NAIA (CCC)
  "LCSC":          [46.4147, -117.0146],   // Lewiston, ID
  "EOU":           [45.6710, -118.0783],   // La Grande, OR
  "OIT":           [42.2685, -122.2828],   // Klamath Falls, OR
  "C of I":        [43.6631, -116.6874],   // Caldwell, ID
  "Corban":        [44.8890, -123.0102],   // Salem, OR
  "Bushnell":      [44.0393, -123.0722],   // Eugene, OR
  "Warner Pacific": [45.4793, -122.6042],  // Portland, OR
  "UBC":           [49.2606, -123.2460],   // Vancouver, BC

  // NWAC (JUCO)
  "Bellevue":        [47.6154, -122.1442],   // Bellevue, WA
  "Big Bend":        [47.1263, -119.2769],   // Moses Lake, WA
  "Blue Mountain":   [45.6727, -118.7888],   // Pendleton, OR
  "Centralia":       [46.7171, -122.9497],   // Centralia, WA
  "Chemeketa":       [44.9882, -122.9849],   // Salem, OR
  "Clackamas":       [45.3672, -122.5759],   // Oregon City, OR
  "Clark":           [45.6355, -122.6520],   // Vancouver, WA
  "Columbia Basin":  [46.2679, -119.2732],   // Pasco, WA
  "Douglas":         [49.2057, -122.9110],   // New Westminster, BC
  "Edmonds":         [47.8101, -122.3408],   // Lynnwood, WA
  "Everett":         [47.9799, -122.2029],   // Everett, WA
  "Grays Harbor":    [46.9768, -123.7919],   // Aberdeen, WA
  "Lane":            [44.0280, -123.0230],   // Eugene, OR
  "Linn-Benton":     [44.5659, -123.2575],   // Albany, OR
  "Lower Columbia":  [46.1409, -122.9360],   // Longview, WA
  "Mt. Hood":        [45.4900, -122.3888],   // Gresham, OR
  "Olympic":         [47.5979, -122.6390],   // Bremerton, WA
  "Pierce":          [47.1555, -122.4447],   // Lakewood, WA
  "Shoreline":       [47.7545, -122.3448],   // Shoreline, WA
  "Skagit":          [48.4545, -122.3363],   // Mt. Vernon, WA
  "SW Oregon":       [43.3601, -124.2139],   // Coos Bay, OR
  "Spokane":         [47.6893, -117.3869],   // Spokane, WA
  "Tacoma":          [47.2227, -122.4370],   // Tacoma, WA
  "Treasure Valley": [43.9724, -116.9664],   // Ontario, OR
  "Umpqua":          [43.2580, -123.3424],   // Roseburg, OR
  "Walla Walla":     [46.0646, -118.3430],   // Walla Walla, WA
  "Wenatchee Valley": [47.4235, -120.3103],  // Wenatchee, WA
  "Yakima Valley":   [46.5800, -120.5060],   // Yakima, WA
}

// ─── State/region views with center + zoom ───
const VIEWS = {
  all: { center: [46.5, -120.5], zoom: 6, label: 'All PNW' },
  WA:  { center: [47.3, -120.7], zoom: 7, label: 'Washington' },
  OR:  { center: [44.1, -122.5], zoom: 7, label: 'Oregon' },
  ID:  { center: [44.5, -115.5], zoom: 7, label: 'Idaho' },
  MT:  { center: [46.0, -108.5], zoom: 7, label: 'Montana' },
  BC:  { center: [49.26, -123.25], zoom: 9, label: 'British Columbia' },
}

// Division colors for badges
const DIV_COLORS = {
  'NCAA D1': '#1e40af',
  'NCAA D2': '#059669',
  'NCAA D3': '#7c3aed',
  'NAIA':    '#dc2626',
  'NWAC':    '#d97706',
}

export default function RecruitingMap() {
  const { data: teams, loading } = useTeams()
  const [activeView, setActiveView] = useState('all')
  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const markersRef = useRef([])

  // Build the map once teams are loaded
  useEffect(() => {
    if (!teams || !window.L || mapInstanceRef.current) return

    const L = window.L
    const view = VIEWS[activeView]

    // Create map
    const map = L.map(mapRef.current, {
      center: view.center,
      zoom: view.zoom,
      scrollWheelZoom: true,
      zoomControl: true,
    })

    // Use CartoDB Positron (clean, light, free)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map)

    mapInstanceRef.current = map
    addMarkers(map, teams, activeView)

    // Cleanup
    return () => {
      map.remove()
      mapInstanceRef.current = null
    }
  }, [teams])

  // Update view when tab changes
  useEffect(() => {
    if (!mapInstanceRef.current || !teams) return
    const view = VIEWS[activeView]
    mapInstanceRef.current.flyTo(view.center, view.zoom, { duration: 0.8 })
    addMarkers(mapInstanceRef.current, teams, activeView)
  }, [activeView, teams])

  function addMarkers(map, teams, view) {
    const L = window.L

    // Clear existing markers
    markersRef.current.forEach(m => map.removeLayer(m))
    markersRef.current = []

    // Filter teams by state if viewing a specific state
    const filteredTeams = view === 'all'
      ? teams
      : teams.filter(t => {
          if (view === 'BC') return t.state === 'BC'
          return t.state === view
        })

    filteredTeams.forEach(team => {
      const coords = TEAM_COORDS[team.short_name]
      if (!coords) return

      const divColor = DIV_COLORS[team.division_name] || '#6b7280'

      // Create custom icon using team logo
      const icon = L.divIcon({
        className: 'team-map-marker',
        html: `
          <div style="
            width: 36px; height: 36px;
            background: white;
            border: 2.5px solid ${divColor};
            border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            cursor: pointer;
            transition: transform 0.15s;
          ">
            <img src="${team.logo_url || ''}" alt="${team.short_name}"
              style="width: 24px; height: 24px; object-fit: contain; border-radius: 50%;"
              onerror="this.style.display='none'; this.parentNode.innerHTML='<span style=font-size:10px;font-weight:bold;color:${divColor}>${team.short_name}</span>'"
            />
          </div>
        `,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
        popupAnchor: [0, -20],
      })

      const marker = L.marker(coords, { icon }).addTo(map)

      // Popup with team card
      const record = team.wins != null ? `${team.wins}-${team.losses}${team.ties ? `-${team.ties}` : ''}` : ''
      const confRecord = team.conf_wins != null ? `(${team.conf_wins}-${team.conf_losses})` : ''

      marker.bindPopup(`
        <div style="min-width: 180px; font-family: Inter, sans-serif;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
            ${team.logo_url ? `<img src="${team.logo_url}" style="width: 32px; height: 32px; object-fit: contain;" />` : ''}
            <div>
              <div style="font-weight: 600; font-size: 14px; color: #1e293b;">${team.name}</div>
              <div style="font-size: 11px; color: #64748b;">${team.conference_name || ''}</div>
            </div>
          </div>
          <div style="display: flex; gap: 6px; align-items: center; margin-bottom: 6px;">
            <span style="
              background: ${divColor}; color: white;
              font-size: 10px; font-weight: 600;
              padding: 1px 6px; border-radius: 4px;
            ">${team.division_level || team.division_name}</span>
            ${record ? `<span style="font-size: 12px; color: #334155; font-weight: 500;">${record} ${confRecord}</span>` : ''}
          </div>
          <a href="/team/${team.id}"
            style="
              display: inline-block; margin-top: 4px;
              font-size: 12px; color: #00687a; font-weight: 500;
              text-decoration: none;
            "
          >View Team Page →</a>
        </div>
      `, { maxWidth: 260 })

      markersRef.current.push(marker)
    })
  }

  // Count teams per region for the tab badges
  const teamCounts = {}
  if (teams) {
    teamCounts.all = teams.length
    ;['WA', 'OR', 'ID', 'MT', 'BC'].forEach(st => {
      teamCounts[st] = teams.filter(t => t.state === st).length
    })
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-pnw-slate mb-4">Program Map</h1>
      <p className="text-sm text-gray-500 mb-4">
        Every PNW college baseball program across all 5 divisions. Click a logo for team details.
      </p>

      {/* Region tabs */}
      <div className="flex flex-wrap gap-2 mb-4">
        {Object.entries(VIEWS).map(([key, v]) => (
          <button
            key={key}
            onClick={() => setActiveView(key)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              activeView === key
                ? 'bg-nw-teal text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {v.label}
            {teamCounts[key] != null && (
              <span className={`ml-1.5 text-xs ${activeView === key ? 'text-white/70' : 'text-gray-400'}`}>
                ({teamCounts[key]})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Division legend */}
      <div className="flex flex-wrap gap-3 mb-4">
        {Object.entries(DIV_COLORS).map(([div, color]) => (
          <div key={div} className="flex items-center gap-1.5 text-xs text-gray-600">
            <span
              style={{ background: color }}
              className="w-3 h-3 rounded-full inline-block"
            />
            {div}
          </div>
        ))}
      </div>

      {/* Map container */}
      {loading ? (
        <div className="h-[600px] bg-gray-100 rounded-lg flex items-center justify-center text-gray-400 animate-pulse">
          Loading map...
        </div>
      ) : (
        <div
          ref={mapRef}
          className="h-[600px] rounded-lg border border-gray-200 shadow-sm"
          style={{ zIndex: 0 }}
        />
      )}
    </div>
  )
}
