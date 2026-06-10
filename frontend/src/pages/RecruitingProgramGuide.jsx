// NWBB Program Guide — premium, view-only PDF of all 57 PNW program profiles.
// The bytes come from a premium-gated backend endpoint (the raw URL 401s without
// a token), and we render page-by-page to canvas with no text layer, no
// download/print UI, and right-click disabled — so there's no easy way to pull
// the file down.
import { useState, useEffect, useRef } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { supabase } from '../lib/supabase'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export default function RecruitingProgramGuide() {
  const [file, setFile] = useState(null)      // { data: Uint8Array } — set once
  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(1)
  const [width, setWidth] = useState(820)
  const [error, setError] = useState(null)
  const wrapRef = useRef(null)

  // Fetch the gated PDF bytes with the Supabase bearer token.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data: sess } = await supabase.auth.getSession()
        const token = sess?.session?.access_token
        const resp = await fetch('/api/v1/recruiting/program-guide', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (!resp.ok) {
          throw new Error(resp.status === 401 || resp.status === 403 ? 'premium' : resp.status === 404 ? 'missing' : `HTTP ${resp.status}`)
        }
        const buf = await resp.arrayBuffer()
        if (!cancelled) setFile({ data: new Uint8Array(buf) })
      } catch (e) {
        if (!cancelled) setError(e.message || 'load')
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Fit page width to the container.
  useEffect(() => {
    const onResize = () => {
      if (wrapRef.current) setWidth(Math.max(280, Math.min(900, wrapRef.current.clientWidth - 8)))
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [file])

  const go = (n) => setPage((p) => Math.min(numPages || 1, Math.max(1, n)))

  // Keyboard arrows for page nav.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(page + 1)
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(page - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [page, numPages])

  const Bar = () => (
    <div className="sticky top-0 z-10 flex items-center justify-center gap-3 py-2.5 px-3 bg-white/95 dark:bg-gray-900/95 backdrop-blur border-b border-gray-200 dark:border-gray-700">
      <button onClick={() => go(page - 1)} disabled={page <= 1}
        className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 disabled:opacity-40 hover:border-nw-teal hover:text-nw-teal transition-colors">
        ‹ Prev
      </button>
      <div className="text-sm text-gray-600 dark:text-gray-300 tabular-nums">
        Page{' '}
        <input
          type="number" min={1} max={numPages || 1} value={page}
          onChange={(e) => go(parseInt(e.target.value, 10) || 1)}
          className="w-14 text-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 py-0.5 mx-1 tabular-nums"
        />
        of {numPages || '—'}
      </div>
      <button onClick={() => go(page + 1)} disabled={numPages ? page >= numPages : true}
        className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 disabled:opacity-40 hover:border-nw-teal hover:text-nw-teal transition-colors">
        Next ›
      </button>
    </div>
  )

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 py-6">
      <div className="text-center mb-4">
        <div className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-nw-teal bg-teal-50 dark:bg-teal-900/30 px-3 py-1 rounded-full mb-2">
          Premium · Program Guide
        </div>
        <h1 className="text-2xl sm:text-3xl font-black text-nw-teal dark:text-gray-100">NWBB Program Guide</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          In-depth profiles on all 57 PNW college baseball programs. Viewing only.
        </p>
      </div>

      <div
        ref={wrapRef}
        onContextMenu={(e) => e.preventDefault()}
        className="rounded-2xl overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700 bg-gray-100 dark:bg-gray-800 select-none"
        style={{ WebkitUserSelect: 'none', userSelect: 'none' }}
      >
        {error === 'premium' ? (
          <div className="p-10 text-center text-sm text-gray-600 dark:text-gray-300">
            The Program Guide is a premium feature. <a href="/pricing" className="text-nw-teal font-semibold hover:underline">View plans →</a>
          </div>
        ) : error ? (
          <div className="p-10 text-center text-sm text-gray-500 dark:text-gray-400">
            The Program Guide couldn't be loaded right now. Please try again later.
          </div>
        ) : !file ? (
          <div className="p-16 text-center text-sm text-gray-400 dark:text-gray-500">Loading the program guide…</div>
        ) : (
          <>
            <Bar />
            <div className="flex justify-center py-4 px-2">
              <Document
                file={file}
                onLoadSuccess={({ numPages: n }) => setNumPages(n)}
                onLoadError={() => setError('load')}
                loading={<div className="p-16 text-sm text-gray-400">Rendering…</div>}
                error={<div className="p-16 text-sm text-gray-500">Couldn't render the guide.</div>}
              >
                <Page
                  pageNumber={page}
                  width={width}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  loading={<div style={{ height: width * 1.3 }} className="flex items-center justify-center text-sm text-gray-400">Loading page…</div>}
                  className="shadow-lg"
                />
              </Document>
            </div>
            <Bar />
          </>
        )}
      </div>
    </div>
  )
}
