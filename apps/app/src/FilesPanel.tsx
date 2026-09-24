import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, Download, File, FileArchive, FileCode2, FileImage, FileSpreadsheet, FileText, FolderOpen, Grid2X2, List, RefreshCw, Search, X } from 'lucide-react'
import Markdown from './Markdown'
import './FilesPanel.css'

const code = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'html', 'css', 'json', 'yaml', 'yml', 'toml', 'sh', 'sql', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'xml'])
const sheets = new Set(['csv', 'tsv', 'xlsx', 'xls', 'ods'])
function category(file) { return file.preview === 'image' || file.extension === 'svg' ? 'images' : code.has(file.extension) ? 'code' : sheets.has(file.extension) ? 'sheets' : 'documents' }
function FileIcon({ file, size = 52 }) {
  const Icon = file.preview === 'image' ? FileImage : code.has(file.extension) ? FileCode2 : sheets.has(file.extension) ? FileSpreadsheet : ['zip', 'gz', 'tar', '7z'].includes(file.extension) ? FileArchive : ['pdf', 'docx', 'md', 'txt'].includes(file.extension) ? FileText : File
  return <Icon size={size} strokeWidth={1.25} aria-hidden="true" />
}
const sizeLabel = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
const fileUrl = (botId, id, action) => `/api/bots/${encodeURIComponent(botId)}/files/${encodeURIComponent(id)}/${action}`
async function readJson(url, signal) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Could not load files.')
  return body
}

export default function FilesPanel({ botId, botName, onClose, onSettings }) {
  const [files, setFiles] = useState(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [layout, setLayout] = useState('grid')
  const [sort, setSort] = useState('recent')
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [previewError, setPreviewError] = useState('')
  const heading = useRef(null)
  useEffect(() => {
    const controller = new AbortController()
    let timer
    const load = async () => {
      try {
        const data = await readJson(`/api/bots/${encodeURIComponent(botId)}/files`, controller.signal)
        if (!Array.isArray(data.files)) throw new Error('Bunji returned an incomplete file list.')
        if (!controller.signal.aborted) { setFiles(data.files); setError('') }
      } catch (cause) { if (!controller.signal.aborted) setError(cause.message || 'Cannot reach Bunji.') }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 3500) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [botId, refresh])
  const selectedFile = files?.find(file => file.id === selected)
  const version = selectedFile?.updatedAt
  const available = selectedFile?.available
  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    readJson(fileUrl(botId, selected, 'preview'), controller.signal).then(data => {
      if (!controller.signal.aborted) setDetail(data)
    }).catch(cause => { if (!controller.signal.aborted) setPreviewError(cause.message || 'Could not preview this file.') })
    heading.current?.focus()
    return () => controller.abort()
  }, [botId, selected, version, available])
  const selectFile = id => { setDetail(null); setPreviewError(''); setSelected(id) }
  const shown = (files || []).filter(file => (filter === 'all' || category(file) === filter) && `${file.name} ${file.path}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : b.updatedAt - a.updatedAt)
  const file = detail?.file || selectedFile
  return <section className="files-panel" aria-label={`${botName} files`}>
    <header className="panel-heading">
      {selected ? <button className="files-icon-button" aria-label="Back to files" onClick={() => setSelected(null)}><ArrowLeft size={17} /></button> : <span className="files-title"><FolderOpen size={17} /><h2>Files</h2>{files && <small>{files.length}</small>}</span>}
      {selected && <h2 ref={heading} tabIndex={-1}>Preview</h2>}
      <div className="files-heading-actions">{!selected && <button className="files-icon-button" aria-label="Refresh files" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} /></button>}<button className="files-icon-button" aria-label="Close files" onClick={onClose}><X size={17} /></button></div>
    </header>
    {selected ? <div className="files-preview panel-scroll">
      {file && <><div className={`file-preview-identity ${category(file)}`}><FileIcon file={file} size={34} /><div><h3>{file.name}</h3><span>{file.extension.toUpperCase() || 'FILE'} · {sizeLabel(file.size)}</span></div></div><p className="file-location">{file.path}</p></>}
      {previewError ? <div role="alert" className="files-error">{previewError}</div> : !detail ? <p role="status" className="files-muted">Loading preview…</p> : <>
        <a className="file-download" href={fileUrl(botId, selected, 'download')} download={file.name}><Download size={15} />Download file</a>
        <div className="file-preview-content">
          {file.preview === 'image' ? <img src={fileUrl(botId, selected, 'content') + '?v=' + version} alt={file.name} onError={() => setPreviewError('Image preview is unavailable. Try refreshing the file list.')} />
            : detail.text !== null ? file.preview === 'markdown' ? <Markdown text={detail.text} /> : <pre tabIndex={0}>{detail.text}</pre>
              : <div className="file-no-preview"><FileIcon file={file} /><p>Download this file to open it in its app.</p></div>}
        </div>
        {detail.truncated && <p className="files-muted">Showing the first 128 KB. Download for the full file.</p>}
        <p className="files-muted">Updated {new Date(file.updatedAt).toLocaleString()}</p>
      </>}
    </div> : <>
      <div className="files-controls"><label className="files-search"><Search size={14} /><input aria-label="Search agent files" placeholder="Search files…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="files-toolbar"><select aria-label="Filter files" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All types</option><option value="images">Images</option><option value="documents">Documents</option><option value="code">Code</option><option value="sheets">Spreadsheets</option></select><select aria-label="Sort files" value={sort} onChange={event => setSort(event.target.value)}><option value="recent">Newest</option><option value="name">Name</option></select><div className="file-view-toggle" role="group" aria-label="File view"><button aria-label="Grid view" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><Grid2X2 size={15} /></button><button aria-label="List view" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><List size={16} /></button></div></div>
      </div>
      <div className="files-scroll">
        {error && <div className="files-error" role="alert">{error}<button onClick={() => setRefresh(value => value + 1)}>Try again</button></div>}
        {files === null && !error && <p className="files-muted" role="status">Loading files…</p>}
        {files?.length === 0 && <div className="files-empty"><div className="files-empty-icon"><FolderOpen size={42} strokeWidth={1.2} /></div><h3>A home for the work.</h3><p>Files {botName} creates or edits will show up here. Preview them, then download to any device.</p><button onClick={onSettings}>Agent settings <ChevronRight size={13} /></button></div>}
        {Boolean(files?.length) && !shown.length && <p className="files-muted">No files match your search.</p>}
        <div className={`agent-files ${layout}`} aria-label="Agent files">{shown.map(item => <button key={item.id} className={`file-card ${category(item)}${item.available ? '' : ' unavailable'}`} title={item.path} onClick={() => selectFile(item.id)} aria-label={`Preview ${item.name}`}>
          <span className="file-card-icon">{item.preview === 'image' && item.available ? <img loading="lazy" src={fileUrl(botId, item.id, 'content') + '?v=' + item.updatedAt} alt="" /> : <FileIcon file={item} />}</span>
          <span className="file-card-label"><strong>{item.name}</strong><small>{item.available ? `${item.extension.toUpperCase() || 'FILE'} · ${sizeLabel(item.size)}` : 'Moved or missing'}</small></span>
        </button>)}</div>
      </div>
      <footer className="files-footnote">Shared across your devices · Updates automatically</footer>
    </>}
  </section>
}
