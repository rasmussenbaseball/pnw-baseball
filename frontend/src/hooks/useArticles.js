// Article hooks (public + portal). Mirrors the auth-header pattern used
// by useFavorites: the public list/detail hooks don't need auth, but the
// portal write/list hooks attach the Supabase Bearer token.
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'

const API_BASE = '/api/v1'

function authHeaders(session) {
  if (!session?.access_token) return {}
  return { Authorization: `Bearer ${session.access_token}` }
}

// ── Public ──────────────────────────────────────────────────────

export function usePublishedArticles(limit = 50) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  useEffect(() => {
    let alive = true
    setLoading(true)
    fetch(`${API_BASE}/articles?limit=${limit}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => { if (alive) { setData(d); setLoading(false) } })
      .catch(e => { if (alive) { setError(e.message); setLoading(false) } })
    return () => { alive = false }
  }, [limit])
  return { data, loading, error }
}

export function usePublishedArticle(slug) {
  // Send the Bearer token so the backend can resolve the viewer's tier.
  // Without it every viewer looks anonymous and the paywall locks even
  // free articles for signed-in free/premium/coach users.
  const { session } = useAuth()
  const token = session?.access_token || null
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  useEffect(() => {
    if (!slug) return
    let alive = true
    setLoading(true)
    fetch(`${API_BASE}/articles/${encodeURIComponent(slug)}`, { headers: authHeaders(session) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => { if (alive) { setData(d); setLoading(false) } })
      .catch(e => { if (alive) { setError(e.message); setLoading(false) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, token])
  return { data, loading, error }
}

// ── Portal (authenticated) ─────────────────────────────────────

export function useMyArticles() {
  const { session, user } = useAuth()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const refetch = useCallback(async () => {
    if (!user || !session) { setData({ articles: [] }); setLoading(false); return }
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/portal/articles`, { headers: authHeaders(session) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [user, session])
  useEffect(() => { refetch() }, [refetch])
  return { data, loading, error, refetch }
}

export function useMyArticle(articleId) {
  const { session, user } = useAuth()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  useEffect(() => {
    if (!articleId || !user || !session) { setLoading(false); return }
    let alive = true
    setLoading(true)
    fetch(`${API_BASE}/portal/articles/${articleId}`, { headers: authHeaders(session) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => { if (alive) { setData(d); setLoading(false) } })
      .catch(e => { if (alive) { setError(e.message); setLoading(false) } })
    return () => { alive = false }
  }, [articleId, user, session])
  return { data, loading, error }
}

/** Returns { create, update, togglePublish, archive } — all auth-aware. */
export function useArticleMutations() {
  const { session } = useAuth()
  const headers = { 'Content-Type': 'application/json', ...authHeaders(session) }

  const create = async (payload) => {
    const r = await fetch(`${API_BASE}/portal/articles`, {
      method: 'POST', headers, body: JSON.stringify(payload),
    })
    if (!r.ok) throw new Error((await r.json())?.detail || `HTTP ${r.status}`)
    return r.json()
  }
  const update = async (id, payload) => {
    const r = await fetch(`${API_BASE}/portal/articles/${id}`, {
      method: 'PUT', headers, body: JSON.stringify(payload),
    })
    if (!r.ok) throw new Error((await r.json())?.detail || `HTTP ${r.status}`)
    return r.json()
  }
  const togglePublish = async (id, publish) => {
    const r = await fetch(`${API_BASE}/portal/articles/${id}/publish`, {
      method: 'PATCH', headers, body: JSON.stringify({ publish }),
    })
    if (!r.ok) throw new Error((await r.json())?.detail || `HTTP ${r.status}`)
    return r.json()
  }
  const archive = async (id) => {
    const r = await fetch(`${API_BASE}/portal/articles/${id}`, {
      method: 'DELETE', headers,
    })
    if (!r.ok) throw new Error((await r.json())?.detail || `HTTP ${r.status}`)
    return r.json()
  }

  return { create, update, togglePublish, archive }
}
