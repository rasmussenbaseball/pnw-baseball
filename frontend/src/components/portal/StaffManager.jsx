// Unified "My Staff" widget — ONE list that shares a Coach & Scout
// subscription with the rest of the staff. Adding an email grants:
//   - a full membership seat (their own login gets coach-tier access),
//     when the owner has a paying Coach & Scout sub (or dev account)
//   - the shared TrackMan Suite + Rapsodo Lab data workspaces (always)
// Backed by /portal/my-staff (see backend _tracking_share.py). Shown as
// a banner on the portal home and a card on the TrackMan Overview tab;
// the Account page's staff section manages the same list.
import { useState } from 'react'
import { useApi } from '../../hooks/useApi'
import { supabase } from '../../lib/supabase'

async function authHeaders() {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export default function StaffManager({ variant = 'card' }) {
  const { data, refetch } = useApi('/portal/my-staff')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const members = data?.members || []
  const max = data?.max ?? 3
  const canSeats = !!data?.can_seats

  async function add() {
    const e = email.trim().toLowerCase()
    if (!e) return
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/v1/portal/my-staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ email: e }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`)
      setEmail(''); refetch()
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  async function toggleUpload(m) {
    await fetch(`/api/v1/portal/my-staff/${encodeURIComponent(m.email)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ can_upload: !(m.can_upload !== false) ? true : false }),
    })
    refetch()
  }

  async function remove(memberEmail) {
    await fetch(`/api/v1/portal/my-staff/${encodeURIComponent(memberEmail)}`, {
      method: 'DELETE', headers: await authHeaders(),
    })
    refetch()
  }

  if (data?.viewing_shared) {
    return (
      <div className={variant === 'banner'
        ? 'mt-4 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 ring-1 ring-indigo-200 dark:ring-indigo-800 px-4 py-3'
        : 'bg-indigo-50 dark:bg-indigo-900/30 rounded-xl ring-1 ring-indigo-200 dark:ring-indigo-800 p-4'}>
        <div className="text-[13px] font-semibold text-indigo-900 dark:text-indigo-200">
          You're on a coach's staff list
        </div>
        <p className="mt-0.5 text-[12px] text-indigo-800/80 dark:text-indigo-300/80">
          Your access and the TrackMan / Rapsodo data you see are shared by your head coach.
          Uploads and edits you make go to the staff's shared data pool.
        </p>
      </div>
    )
  }

  const seatsMax = data?.seats_max ?? 3
  const seatsLine = canSeats
    ? `Add up to ${max} coaches to share your TrackMan Suite, Rapsodo Lab, and Camp Report
       data. The first ${seatsMax} added also get a full Coach & Scout membership seat on
       their own login. Use each coach's Uploads toggle to control who can add or delete CSVs.`
    : `Add up to ${max} coaches to share your TrackMan Suite, Rapsodo Lab, and Camp Report
       data. Use each coach's Uploads toggle to control who can add or delete CSVs. Full
       membership seats come with a paid Coach & Scout subscription.`

  const inner = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <div className={variant === 'banner'
          ? 'text-[15px] font-bold text-portal-purple dark:text-portal-accent-light'
          : 'text-[11px] font-bold uppercase tracking-wide text-gray-400'}>
          {variant === 'banner' ? 'Your staff is included' : 'My staff'}
        </div>
        <span className="text-[10px] text-gray-400 whitespace-nowrap">{members.length}/{max} coaches</span>
      </div>
      <p className="mt-1 text-[12px] leading-snug text-gray-500 dark:text-gray-400 max-w-2xl">
        {seatsLine}
      </p>

      {members.length > 0 && (
        <ul className="mt-2.5 flex flex-wrap gap-2">
          {members.map(m => (
            <li key={m.email}
                className="flex items-center gap-2 rounded-full bg-gray-50 dark:bg-gray-900/40
                           ring-1 ring-gray-200 dark:ring-gray-700 pl-3 pr-2 py-1">
              <span className="text-[12px] font-mono text-gray-700 dark:text-gray-200">{m.email}</span>
              <span className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full
                ${m.seat
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                  : 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300'}`}>
                {m.seat ? 'Membership + data' : 'Data sharing'}
              </span>
              <button onClick={() => toggleUpload(m)}
                title={m.can_upload !== false
                  ? 'Can upload and delete CSVs — click to make view-only'
                  : 'View-only — click to allow uploads'}
                className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full
                  ${m.can_upload !== false
                    ? 'bg-portal-purple/10 text-portal-purple dark:bg-indigo-900/40 dark:text-indigo-300'
                    : 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400'}`}>
                {m.can_upload !== false ? 'Uploads: on' : 'Uploads: off'}
              </button>
              <button onClick={() => remove(m.email)} title="Remove"
                      className="text-gray-400 hover:text-rose-500 text-[13px] leading-none px-0.5">×</button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2.5 flex gap-2">
        <input value={email} onChange={e => setEmail(e.target.value)} type="email"
          onKeyDown={e => { if (e.key === 'Enter') add() }}
          placeholder="assistant.coach@school.edu"
          className="flex-1 max-w-xs rounded-lg border border-gray-200 dark:border-gray-700
                     dark:bg-gray-900 px-3 py-1.5 text-sm" />
        <button onClick={add} disabled={busy || !email.trim() || members.length >= max}
          className="rounded-lg bg-portal-purple text-white text-sm font-semibold px-3.5 py-1.5 disabled:opacity-50">
          {busy ? 'Adding…' : 'Add coach'}
        </button>
      </div>
      {error && <div className="mt-1.5 text-[12px] text-rose-600">{error}</div>}
    </>
  )

  if (variant === 'banner') {
    return (
      <div className="mt-4 rounded-xl bg-white dark:bg-gray-800 ring-1 ring-gray-200 dark:ring-gray-700
                      border-l-4 border-portal-accent px-4 sm:px-5 py-3.5">
        {inner}
      </div>
    )
  }
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl ring-1 ring-gray-200 dark:ring-gray-700 p-4">
      {inner}
    </div>
  )
}
