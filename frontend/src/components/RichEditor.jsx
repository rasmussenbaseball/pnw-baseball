// RichEditor — a Google-Docs-style WYSIWYG body editor (TipTap / ProseMirror).
//
// Features: real inline formatting (bold/italic/underline/strike/highlight),
// headings, lists, quotes, links, images (uploaded), tables (incl. paste from
// Google Docs, since TipTap parses pasted HTML), a bubble menu on text
// selection, and a "+" block menu on empty lines for inserting blocks — plus a
// "Free preview ends here" paywall break. Emits HTML via onChange.
import { useRef, useState, useEffect } from 'react'
import { Node } from '@tiptap/core'
import { useEditor, EditorContent } from '@tiptap/react'
import { BubbleMenu, FloatingMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'

// Paywall break: a block <hr data-paywall> that marks where the free preview
// ends. The backend splits the stored HTML on it to gate paid content.
const PaywallBreak = Node.create({
  name: 'paywallBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML() { return [{ tag: 'hr[data-paywall]' }] },
  renderHTML() { return ['hr', { 'data-paywall': 'true', class: 'paywall-break' }] },
})

const MBtn = ({ active, onClick, title, children }) => (
  <button type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
    className={`px-2 py-1 text-sm rounded font-semibold leading-none ${active ? 'bg-nw-teal text-white' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
    {children}
  </button>
)

export default function RichEditor({ value = '', onChange, uploadImage }) {
  const fileRef = useRef(null)
  const [plusOpen, setPlusOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  // Tracks the HTML we last emitted/synced so external `value` changes (e.g. an
  // article body that loads AFTER mount) get pushed into the editor, while our
  // own onUpdate echoes are ignored (no clobbering in-progress typing).
  const lastHtml = useRef(value)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      Highlight,
      Image.configure({ inline: false, allowBase64: false }),
      Placeholder.configure({ placeholder: "Write your article… select text to format, or click the + on an empty line to add images, tables, links, or the paywall break." }),
      Table.configure({ resizable: true }),
      TableRow, TableHeader, TableCell,
      PaywallBreak,
    ],
    content: value || '',
    editorProps: {
      attributes: {
        // `markdown` is the SAME wrapper class the published article + preview
        // pane use (index.css `.markdown …` rules), so what you type renders
        // identically here and on the live site. The `prose` classes are kept
        // for parity with those wrappers but are inert (no typography plugin).
        class: 'markdown prose prose-sm sm:prose-base max-w-none focus:outline-none min-h-[420px] px-1 py-2',
      },
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML()
      lastHtml.current = html
      onChange?.(html)
    },
  })

  // TipTap only applies `content` at mount. When editing an existing article
  // the body loads asynchronously AFTER the editor mounts, so without this the
  // editor stays empty — and a subsequent save would overwrite the stored body
  // with that empty content (the data-loss bug). Sync external value changes in,
  // guarded by lastHtml so we never reset the doc mid-typing.
  useEffect(() => {
    if (!editor) return
    if (value !== lastHtml.current && value !== editor.getHTML()) {
      lastHtml.current = value
      editor.commands.setContent(value || '', { emitUpdate: false })
    }
  }, [value, editor])

  if (!editor) return null

  const setLink = () => {
    const prev = editor.getAttributes('link').href || 'https://'
    const url = window.prompt('Link URL', prev)
    if (url === null) return
    if (url === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  const pickImage = () => { setPlusOpen(false); fileRef.current?.click() }
  const onFile = async (e) => {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file || !uploadImage) return
    setUploading(true)
    try {
      const { url } = await uploadImage(file)
      const alt = (file.name || 'image').replace(/\.[^.]+$/, '')
      editor.chain().focus().setImage({ src: url, alt }).run()
    } catch (err) { window.alert(err.message || 'Image upload failed') }
    finally { setUploading(false) }
  }

  const insertTable = () => { setPlusOpen(false); editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() }
  const insertPaywall = () => {
    setPlusOpen(false)
    if (editor.getHTML().includes('data-paywall')) { window.alert('This article already has a free-preview break.'); return }
    editor.chain().focus().insertContent({ type: 'paywallBreak' }).run()
  }

  return (
    <div className="rich-editor border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900">
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />

      {/* Selection bubble menu */}
      <BubbleMenu editor={editor}>
        <div className="flex items-center gap-0.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg px-1 py-0.5">
          <MBtn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold"><b>B</b></MBtn>
          <MBtn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic"><i>I</i></MBtn>
          <MBtn active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline"><u>U</u></MBtn>
          <MBtn active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough"><s>S</s></MBtn>
          <MBtn active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight().run()} title="Highlight">▒</MBtn>
          <span className="w-px h-5 bg-gray-200 dark:bg-gray-600 mx-0.5" />
          <MBtn active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading">H2</MBtn>
          <MBtn active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Subheading">H3</MBtn>
          <MBtn active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">•</MBtn>
          <MBtn active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Quote">❝</MBtn>
          <MBtn active={editor.isActive('link')} onClick={setLink} title="Link">🔗</MBtn>
        </div>
      </BubbleMenu>

      {/* Empty-line "+" block menu */}
      <FloatingMenu editor={editor} options={{ placement: 'left-start' }}>
        <div className="relative">
          <button type="button" title="Add a block"
            onMouseDown={(e) => e.preventDefault()} onClick={() => setPlusOpen((o) => !o)}
            className="w-7 h-7 -ml-9 flex items-center justify-center rounded-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-500 hover:text-nw-teal hover:border-nw-teal text-lg leading-none">+</button>
          {plusOpen && (
            <div className="absolute z-30 left-0 top-8 w-52 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-xl py-1 text-sm">
              {[
                ['H2  Heading', () => { setPlusOpen(false); editor.chain().focus().toggleHeading({ level: 2 }).run() }],
                ['H3  Subheading', () => { setPlusOpen(false); editor.chain().focus().toggleHeading({ level: 3 }).run() }],
                ['•  Bullet list', () => { setPlusOpen(false); editor.chain().focus().toggleBulletList().run() }],
                ['1.  Numbered list', () => { setPlusOpen(false); editor.chain().focus().toggleOrderedList().run() }],
                ['❝  Quote', () => { setPlusOpen(false); editor.chain().focus().toggleBlockquote().run() }],
                ['🖼  Image', pickImage],
                ['🔗  Link', () => { setPlusOpen(false); setLink() }],
                ['▦  Table', insertTable],
                ['── Divider', () => { setPlusOpen(false); editor.chain().focus().setHorizontalRule().run() }],
              ].map(([label, fn]) => (
                <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={fn}
                  className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200">{label}</button>
              ))}
              <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={insertPaywall}
                className="w-full text-left px-3 py-1.5 hover:bg-amber-50 dark:hover:bg-amber-900/20 text-amber-700 dark:text-amber-400 font-semibold">🔒  Paywall break</button>
            </div>
          )}
        </div>
      </FloatingMenu>

      <EditorContent editor={editor} />
      {uploading && <div className="px-3 py-1 text-xs text-gray-500">Uploading image…</div>}

      <style>{`
        .rich-editor table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; }
        .rich-editor td, .rich-editor th { border: 1px solid #d1d5db; padding: 4px 8px; vertical-align: top; }
        .rich-editor th { background: #f3f4f6; font-weight: 700; }
        .dark .rich-editor td, .dark .rich-editor th { border-color: #4b5563; }
        .dark .rich-editor th { background: #374151; }
        .rich-editor hr.paywall-break { border: none; border-top: 2px dashed #d97706; margin: 1.5rem 0; position: relative; }
        .rich-editor hr.paywall-break::before { content: '🔒 FREE PREVIEW ENDS HERE'; position: absolute; left: 50%; top: -0.7rem; transform: translateX(-50%); background: #fffbeb; color: #b45309; font-size: 10px; font-weight: 800; letter-spacing: 0.05em; padding: 1px 8px; border-radius: 4px; border: 1px solid #fcd34d; white-space: nowrap; }
        .rich-editor .ProseMirror p.is-editor-empty:first-child::before { content: attr(data-placeholder); float: left; color: #9ca3af; pointer-events: none; height: 0; }
        .rich-editor .ProseMirror:focus { outline: none; }
      `}</style>
    </div>
  )
}
