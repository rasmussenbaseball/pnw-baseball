// Recruiting Boards API helpers. Every call attaches the Supabase access
// token; the backend enforces the recruiting tier + per-board access.
import { supabase } from './supabase'

const BASE = '/api/v1/recruiting-boards'

async function headers() {
  const { data } = await supabase.auth.getSession()
  const t = data?.session?.access_token
  return {
    'Content-Type': 'application/json',
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  }
}

async function req(method, path = '', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: await headers(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    let detail = `Request failed (${res.status})`
    try { detail = (await res.json()).detail || detail } catch { /* ignore */ }
    const err = new Error(detail)
    err.status = res.status
    throw err
  }
  return res.json()
}

export const listBoards   = () => req('GET')
export const createBoard  = (title) => req('POST', '', { title })
export const getBoard     = (id) => req('GET', `/${id}`)
export const renameBoard  = (id, title) => req('PATCH', `/${id}`, { title })
export const deleteBoard  = (id) => req('DELETE', `/${id}`)
export const addMember    = (id, email) => req('POST', `/${id}/members`, { email })
export const removeMember = (id, memberId) => req('DELETE', `/${id}/members/${memberId}`)
export const addPlayer    = (id, payload) => req('POST', `/${id}/players`, payload)
export const updatePlayer = (id, rbpId, payload) => req('PATCH', `/${id}/players/${rbpId}`, payload)
export const removePlayer = (id, rbpId) => req('DELETE', `/${id}/players/${rbpId}`)
