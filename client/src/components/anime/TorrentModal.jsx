import { useState, useEffect, useCallback, useMemo } from 'react'
import { useLang } from '../../context/LanguageContext'
import { useTorrents } from '../../hooks/useAnime'

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseTags(title) {
  const res    = title.match(/\b(4K|2160[Pp]|1080[Pp]|720[Pp]|480[Pp])\b/)?.[1]?.toUpperCase() ?? null
  const codec  = title.match(/\b(HEVC|AVC|x265|x264|H\.?265|H\.?264)\b/i)?.[1] ?? null
  const source = title.match(/\b(WEB-?DL|WebRip|BDRip|Blu-?[Rr]ay)\b/i)?.[1] ?? null
  return { resolution: res, tags: [codec, source].filter(Boolean) }
}

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// Score 1 if title contains this specific episode number (common patterns)
function epRelevance(title, epPad) {
  const epNum = String(parseInt(epPad)) // non-padded e.g. "1"
  return [
    `- ${epPad}`, `- ${epNum} `, `- ${epNum}]`, `- ${epNum}.`,
    `[${epPad}]`, `[${epNum}]`,
    ` ${epPad} `, ` ${epPad}.`,
  ].some(p => title.includes(p)) ? 1 : 0
}

function resScore(title) {
  if (/2160[Pp]|4K/i.test(title)) return 4
  if (/1080[Pp]/i.test(title)) return 3
  if (/720[Pp]/i.test(title)) return 2
  if (/480[Pp]/i.test(title)) return 1
  return 0
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function GroupRow({ label, count, active, onClick }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', padding: '7px 8px', borderRadius: 8,
        background: active ? 'rgba(10,132,255,0.25)' : hovered ? 'rgba(255,255,255,0.04)' : 'transparent',
        border: active ? '1px solid rgba(10,132,255,0.45)' : '1px solid transparent',
        color: active ? '#0a84ff' : 'rgba(235,235,245,0.60)',
        cursor: 'pointer', fontSize: 13, fontWeight: active ? 600 : 400,
        textAlign: 'left', transition: 'all 0.15s',
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 118 }}>
        {label}
      </span>
      <span style={{
        flexShrink: 0, marginLeft: 6, fontSize: 10, fontWeight: 700,
        padding: '1px 6px', borderRadius: 10,
        background: active ? 'rgba(10,132,255,0.4)' : 'rgba(120,120,128,0.12)',
        color: active ? '#0a84ff' : 'rgba(235,235,245,0.30)',
      }}>{count}</span>
    </button>
  )
}

function TorrentRow({ item, copied, onCopy, onOpen }) {
  const { resolution, tags } = parseTags(item.title)
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '10px 12px', borderRadius: 10,
        background: hovered ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
        border: `1px solid ${hovered ? 'rgba(10,132,255,0.3)' : 'rgba(84,84,88,0.30)'}`,
        display: 'flex', alignItems: 'flex-start', gap: 10, transition: 'all 0.15s',
      }}
    >
      {/* Main info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontSize: 12, color: '#ffffff', lineHeight: 1.5,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          marginBottom: 5,
        }} title={item.title}>{item.title}</p>

        {/* Meta row */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5 }}>
          {resolution && (
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 4, fontWeight: 700,
              background: 'rgba(90,200,250,0.15)', color: '#5ac8fa',
            }}>{resolution}</span>
          )}
          {tags.map(tag => (
            <span key={tag} style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 4, fontWeight: 500,
              background: 'rgba(120,120,128,0.12)', color: 'rgba(235,235,245,0.60)',
            }}>{tag}</span>
          ))}
          {item.size && (
            <span style={{ fontSize: 10, color: 'rgba(235,235,245,0.30)' }}>{item.size}</span>
          )}
          {item.date && (
            <span style={{ fontSize: 10, color: 'rgba(235,235,245,0.30)' }}>{fmtDate(item.date)}</span>
          )}
          {item.source && (
            <span style={{
              fontSize: 9, padding: '1px 5px', borderRadius: 3, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.5px',
              background: item.source === 'nyaa'  ? 'rgba(90,200,250,0.1)'
                        : item.source === 'dmhy'  ? 'rgba(52,211,153,0.1)'
                        : 'rgba(84,84,88,0.30)',
              color: item.source === 'nyaa'  ? '#5ac8fa'
                   : item.source === 'dmhy'  ? '#34d399'
                   : 'rgba(235,235,245,0.30)',
            }}>{item.source === 'dmhy' ? '花园' : item.source}</span>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 5, flexShrink: 0, alignItems: 'center', paddingTop: 1 }}>
        <button
          onClick={onCopy}
          title="Copy magnet"
          style={{
            padding: '5px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
            background: copied ? 'rgba(16,185,129,0.2)' : 'rgba(10,132,255,0.2)',
            color: copied ? '#34d399' : '#0a84ff',
            fontSize: 12, fontWeight: 700, transition: 'all 0.2s', whiteSpace: 'nowrap',
          }}
        >
          {copied ? '✓' : '⎘'}
        </button>
        <button
          onClick={onOpen}
          title="Open magnet"
          style={{
            padding: '5px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
            background: 'rgba(90,200,250,0.15)', color: '#5ac8fa',
            fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
          }}
        >↗</button>
      </div>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function TorrentModal({ anime, onClose }) {
  const { t } = useLang()

  const defaultQ = anime.titleRomaji || anime.titleEnglish || ''

  const [query, setQuery]               = useState(defaultQ)
  const [searchQ, setSearchQ]           = useState(defaultQ)
  const [copied, setCopied]             = useState(null)
  const [selectedGroup, setSelectedGroup] = useState('ALL')
  const [selectedEp, setSelectedEp]     = useState(null)

  const { data: torrents, isLoading } = useTorrents(searchQ)

  // Escape key closes modal
  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const copyMagnet = useCallback((magnet, idx) => {
    navigator.clipboard.writeText(magnet).catch(() => {})
    setCopied(idx)
    setTimeout(() => setCopied(c => c === idx ? null : c), 2000)
  }, [])

  // Title variant pills for quick search switching
  const titleOptions = useMemo(() => {
    const opts = [
      anime.titleChinese && { label: '中文', value: anime.titleChinese },
      anime.titleRomaji  && { label: 'Romaji', value: anime.titleRomaji },
      anime.titleEnglish && anime.titleEnglish !== anime.titleRomaji
        && { label: 'English', value: anime.titleEnglish },
      anime.titleNative  && { label: '日本語', value: anime.titleNative },
    ].filter(Boolean)
    return opts.filter((opt, i) => opts.findIndex(o => o.value === opt.value) === i)
  }, [anime])

  const triggerSearch = useCallback((newQ) => {
    setSearchQ(newQ)
    setSelectedGroup('ALL')
  }, [])

  const applyTitle = (title) => {
    setQuery(title)
    triggerSearch(title)
  }

  // Build fansub groups + sorted results
  const { groups, groupNames, filteredTorrents } = useMemo(() => {
    const epPad = selectedEp ? String(selectedEp).padStart(2, '0') : null

    const groups = {}
    for (const item of torrents ?? []) {
      const g = item.fansub ?? 'Unknown'
      if (!groups[g]) groups[g] = []
      groups[g].push(item)
    }
    const groupNames = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length)

    const base = !torrents ? []
      : selectedGroup === 'ALL' ? torrents
      : (groups[selectedGroup] ?? [])

    // Client-side episode filter with fallback to all if no match
    let filtered = base
    if (epPad) {
      const epFiltered = base.filter(item => epRelevance(item.title, epPad) > 0)
      filtered = epFiltered.length > 0 ? epFiltered : base
    }

    // Sort: episode-match first (when ep selected) → resolution desc → date desc
    const sorted = [...filtered].sort((a, b) => {
      if (epPad) {
        const epDiff = epRelevance(b.title, epPad) - epRelevance(a.title, epPad)
        if (epDiff !== 0) return epDiff
      }
      const resDiff = resScore(b.title) - resScore(a.title)
      if (resDiff !== 0) return resDiff
      return new Date(b.date || 0) - new Date(a.date || 0)
    })

    return { groups, groupNames, filteredTorrents: sorted }
  }, [torrents, selectedGroup, selectedEp])

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.80)', backdropFilter: 'blur(8px)',
        zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#000000',
          border: '1px solid rgba(120,120,128,0.12)',
          borderRadius: 16, width: '100%', maxWidth: 1060,
          height: 'min(88vh, 700px)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── HEADER ── */}
        <div style={{
          padding: '14px 18px 12px',
          borderBottom: '1px solid rgba(84,84,88,0.30)',
          flexShrink: 0,
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ color: '#0a84ff', fontSize: 11, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase' }}>
              {t('torrent.title')}
            </span>
            <button
              onClick={onClose}
              style={{ background: 'none', border: 'none', color: 'rgba(235,235,245,0.30)', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 4 }}
              onMouseEnter={e => e.currentTarget.style.color = '#ffffff'}
              onMouseLeave={e => e.currentTarget.style.color = 'rgba(235,235,245,0.30)'}
            >✕</button>
          </div>

          {/* Title variant pills */}
          {titleOptions.length > 1 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {titleOptions.map(opt => (
                <button
                  key={opt.label}
                  onClick={() => applyTitle(opt.value)}
                  style={{
                    padding: '3px 10px', borderRadius: 20,
                    border: '1px solid rgba(84,84,88,0.65)',
                    background: 'transparent', color: 'rgba(235,235,245,0.50)',
                    fontSize: 11, fontWeight: 500, cursor: 'pointer',
                    transition: 'all 0.15s', whiteSpace: 'nowrap',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = 'rgba(10,132,255,0.6)'
                    e.currentTarget.style.color = '#0a84ff'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = 'rgba(84,84,88,0.65)'
                    e.currentTarget.style.color = 'rgba(235,235,245,0.50)'
                  }}
                >
                  <span style={{ color: 'rgba(235,235,245,0.35)', marginRight: 4 }}>{opt.label}</span>
                  {opt.value.length > 18 ? opt.value.slice(0, 18) + '…' : opt.value}
                </button>
              ))}
            </div>
          )}

          {/* Episode selector pills */}
          {anime.episodes > 0 && (
            <div style={{ display: 'flex', gap: 5, overflowX: 'auto', scrollbarWidth: 'none', paddingBottom: 1 }}>
              <button
                onClick={() => setSelectedEp(null)}
                style={{
                  padding: '3px 10px', borderRadius: 20, border: 'none', cursor: 'pointer',
                  background: selectedEp === null ? '#0a84ff' : 'rgba(255,255,255,0.06)',
                  color: selectedEp === null ? '#fff' : 'rgba(235,235,245,0.50)',
                  fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', transition: 'all 0.15s',
                }}
              >{t('torrent.epAll')}</button>
              {Array.from({ length: anime.episodes }, (_, i) => i + 1).map(ep => (
                <button
                  key={ep}
                  onClick={() => setSelectedEp(ep)}
                  style={{
                    padding: '3px 10px', borderRadius: 20, border: 'none', cursor: 'pointer',
                    background: selectedEp === ep ? '#0a84ff' : 'rgba(255,255,255,0.06)',
                    color: selectedEp === ep ? '#fff' : 'rgba(235,235,245,0.50)',
                    fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', transition: 'all 0.15s',
                  }}
                >{String(ep).padStart(2, '0')}</button>
              ))}
            </div>
          )}

          {/* Search bar */}
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') triggerSearch(query) }}
              style={{
                flex: 1, padding: '8px 13px', borderRadius: 9,
                border: '1px solid #38383a',
                background: 'rgba(255,255,255,0.04)', color: '#ffffff',
                fontSize: 13, outline: 'none', fontFamily: 'inherit',
              }}
              placeholder={t('torrent.placeholder')}
            />
            <button
              onClick={() => triggerSearch(query)}
              style={{
                padding: '8px 18px', borderRadius: 9, flexShrink: 0,
                background: '#0a84ff',
                color: '#fff', fontWeight: 700, fontSize: 13, border: 'none', cursor: 'pointer',
              }}
            >{t('torrent.searchBtn')}</button>
          </div>
        </div>

        {/* ── BODY (three columns) ── */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* LEFT — fansub group list */}
          <div style={{
            width: 185, flexShrink: 0,
            borderRight: '1px solid rgba(84,84,88,0.30)',
            overflowY: 'auto', padding: '10px 8px',
            background: '#1c1c1e',
            display: 'flex', flexDirection: 'column', gap: 3,
          }}>
            <p style={{
              fontSize: 10, color: 'rgba(235,235,245,0.30)', fontWeight: 600,
              letterSpacing: '1.5px', textTransform: 'uppercase',
              padding: '2px 6px 8px',
            }}>
              {anime.titleRomaji || anime.titleEnglish}
            </p>
            <GroupRow
              label={t('torrent.groupAll')}
              count={torrents?.length ?? 0}
              active={selectedGroup === 'ALL'}
              onClick={() => setSelectedGroup('ALL')}
            />
            {groupNames.map(g => (
              <GroupRow
                key={g}
                label={g}
                count={groups[g].length}
                active={selectedGroup === g}
                onClick={() => setSelectedGroup(g)}
              />
            ))}
          </div>

          {/* CENTER — torrent list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
            {isLoading ? (
              <p style={{ color: 'rgba(235,235,245,0.30)', textAlign: 'center', padding: '60px 0' }}>
                {t('torrent.loading')}
              </p>
            ) : !filteredTorrents.length ? (
              <p style={{ color: 'rgba(235,235,245,0.30)', textAlign: 'center', padding: '60px 0' }}>
                {t('torrent.noResults')}
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {filteredTorrents.map((item, i) => (
                  <TorrentRow
                    key={i}
                    item={item}
                    copied={copied === i}
                    onCopy={() => copyMagnet(item.magnet, i)}
                    onOpen={() => window.open(item.magnet)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* RIGHT — cover image */}
          <div style={{
            width: 128, flexShrink: 0,
            borderLeft: '1px solid rgba(84,84,88,0.30)',
            background: '#1c1c1e',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '14px 10px',
          }}>
            {anime.coverImageUrl && (
              <img
                src={anime.coverImageUrl}
                alt={anime.titleRomaji}
                style={{
                  width: 106, height: 152,
                  objectFit: 'cover', borderRadius: 10,
                  border: '2px solid rgba(10,132,255,0.35)',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                }}
              />
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
