import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'

const API_BASE = '/api/v1'

function authHeaders(session) {
  if (!session?.access_token) return {}
  return { Authorization: `Bearer ${session.access_token}` }
}

/**
 * Hook to check and toggle a single favorite.
 * Usage: const { isFavorited, toggle, loading } = useFavorite('team', teamId)
 */
export function useFavorite(favoriteType, targetId) {
  const { session, user } = useAuth()
  const [isFavorited, setIsFavorited] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!user || !targetId) {
      setIsFavorited(false)
      return
    }
    fetch(`${API_BASE}/favorites/check?favorite_type=${favoriteType}&target_ids=${targetId}`, {
      headers: authHeaders(session),
    })
      .then(r => r.json())
      .then(data => {
        setIsFavorited(!!data.favorited?.[targetId])
      })
      .catch(() => {})
  }, [user, session, favoriteType, targetId])

  const toggle = useCallback(async () => {
    if (!user || !session) return false
    setLoading(true)
    try {
      const method = isFavorited ? 'DELETE' : 'POST'
      const res = await fetch(`${API_BASE}/favorites`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(session),
        },
        body: JSON.stringify({ favorite_type: favoriteType, target_id: targetId }),
      })
      if (res.ok) {
        setIsFavorited(!isFavorited)
        return true
      }
      return false
    } catch {
      return false
    } finally {
      setLoading(false)
    }
  }, [user, session, favoriteType, targetId, isFavorited])

  return { isFavorited, toggle, loading }
}

/**
 * Hook to fetch all favorites for the current user.
 * Usage: const { teams, players, loading, refresh } = useAllFavorites()
 */
export function useAllFavorites() {
  const { session, user } = useAuth()
  const [teams, setTeams] = useState([])
  const [players, setPlayers] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(() => {
    if (!user || !session) {
      setTeams([])
      setPlayers([])
      setLoading(false)
      return
    }
    setLoading(true)
    fetch(`${API_BASE}/favorites`, {
      headers: authHeaders(session),
    })
      .then(r => r.json())
      .then(data => {
        setTeams(data.teams || [])
        setPlayers(data.players || [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [user, session])

  useEffect(() => { refresh() }, [refresh])

  return { teams, players, loading, refresh }
}
