import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLang } from '../context/LanguageContext'
import { useAdminStats, useEnrichmentList, useUpdateEnrichment, useResetEnrichment, useFlagEnrichment, useReEnrich, useHealCnTitles, usePauseHeal, useResumeHeal, useUserList, useCreateUser, useUpdateUser, useDeleteUser } from '../hooks/useAdmin'
import LoadingSpinner from '../components/common/LoadingSpinner'

const FILTERS = [
  { value: '', label: 'admin.filterAll' },
  { value: 'needs-review', label: 'admin.filterNeedsReview' },
  { value: 'manually-corrected', label: 'admin.filterCorrected' },
  { value: 'unenriched', label: 'admin.filterUnenriched' },
  { value: 'no-cn', label: 'admin.filterNoCn' },
]

// --- Styles ---

const S = {
  container: { paddingTop: 40, paddingBottom: 60 },
  header: { fontSize: 'clamp(20px,3vw,28px)', color: '#ffffff', fontWeight: 800, marginBottom: 32 },
  // Stats cards
  statsGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 12, marginBottom: 40,
  },
  statCard: {
    background: '#1c1c1e', borderRadius: 12, padding: '20px 20px 16px',
    border: '1px solid #38383a',
  },
  statValue: { fontSize: 28, fontWeight: 800, color: '#ffffff', lineHeight: 1, marginBottom: 4 },
  statLabel: { fontSize: 12, color: 'rgba(235,235,245,0.45)' },
  // Enrichment bar
  enrichBar: { display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 8 },
  enrichSeg: (color, pct) => ({ width: `${pct}%`, background: color, minWidth: pct > 0 ? 2 : 0 }),
  enrichLegend: { display: 'flex', gap: 16, flexWrap: 'wrap' },
  legendItem: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'rgba(235,235,245,0.60)' },
  legendDot: (color) => ({ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }),
  // Section
  sectionTitle: { fontSize: 18, fontWeight: 700, color: '#ffffff', marginBottom: 16 },
  divider: { height: 1, background: '#38383a', margin: '0 0 32px' },
  // Search + filters
  toolbar: { display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' },
  searchInput: {
    padding: '8px 14px', borderRadius: 8, fontSize: 13,
    border: '1px solid #38383a', background: '#1c1c1e', color: '#ffffff',
    outline: 'none', width: 240,
  },
  filterBtn: (active) => ({
    padding: '6px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: active ? '1px solid #0a84ff' : '1px solid #38383a',
    background: active ? 'rgba(10,132,255,0.15)' : 'transparent',
    color: active ? '#0a84ff' : 'rgba(235,235,245,0.60)',
  }),
  // Table
  table: { width: '100%', borderCollapse: 'collapse' },
  th: {
    textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 700,
    color: 'rgba(235,235,245,0.45)', textTransform: 'uppercase', letterSpacing: '1px',
    borderBottom: '1px solid #38383a',
  },
  td: {
    padding: '10px 12px', fontSize: 13, color: 'rgba(235,235,245,0.80)',
    borderBottom: '1px solid rgba(56,56,58,0.5)',
  },
  titleCell: { color: '#ffffff', fontWeight: 600 },
  badge: (color) => ({
    display: 'inline-block', padding: '2px 8px', borderRadius: 99,
    fontSize: 11, fontWeight: 600, background: `${color}20`, color,
  }),
  actionBtn: {
    padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: '1px solid #38383a', background: 'transparent', color: 'rgba(235,235,245,0.60)',
    marginRight: 6,
  },
  deleteBtn: {
    padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: '1px solid rgba(255,69,58,0.4)', background: 'rgba(255,69,58,0.08)', color: '#ff453a',
  },
  createForm: {
    display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center',
  },
  formInput: {
    padding: '8px 14px', borderRadius: 8, fontSize: 13,
    border: '1px solid #38383a', background: '#1c1c1e', color: '#ffffff',
    outline: 'none', width: 180,
  },
  createBtn: {
    padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: '1px solid rgba(48,209,88,0.4)', background: 'rgba(48,209,88,0.12)', color: '#30d158',
  },
  saveBtn: {
    padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: '1px solid rgba(10,132,255,0.4)', background: 'rgba(10,132,255,0.08)', color: '#0a84ff',
    marginRight: 6,
  },
  cancelBtn: {
    padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: '1px solid #38383a', background: 'transparent', color: 'rgba(235,235,245,0.60)',
  },
  editInput: {
    padding: '4px 8px', borderRadius: 6, fontSize: 13,
    border: '1px solid #38383a', background: '#1c1c1e', color: '#ffffff',
    outline: 'none', width: 140,
  },
  resetBtn: {
    padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: '1px solid rgba(255,69,58,0.4)', background: 'rgba(255,69,58,0.08)', color: '#ff453a',
    marginRight: 6,
  },
  pageRow: { display: 'flex', justifyContent: 'center', gap: 12, marginTop: 24 },
  pageBtn: (disabled) => ({
    padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
    border: '1px solid #38383a', background: 'transparent',
    color: disabled ? 'rgba(235,235,245,0.20)' : 'rgba(235,235,245,0.60)',
  }),
  stat: { fontSize: 12, color: 'rgba(235,235,245,0.35)', marginBottom: 16 },
}

// --- Small components ---

function StatCard({ value, label, color }) {
  return (
    <div style={S.statCard}>
      <div style={{ ...S.statValue, color: color || '#ffffff' }}>{value}</div>
      <div style={S.statLabel}>{label}</div>
    </div>
  )
}

function HealSmallBtn({ onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '3px 10px', fontSize: 11, borderRadius: 6,
        border: 'none', cursor: disabled ? 'default' : 'pointer',
        background: disabled ? '#48484a' : '#0a84ff',
        color: '#fff', opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  )
}

function EnrichmentBar({ v0, v1, v2, v3, noCn, queue, total, onHeal, onPause, onResume, healing, onReEnrich, reEnriching }) {
  if (!total) return null
  const pct = (n) => (n / total) * 100
  const queueTotal = queue ? queue.phase1 + queue.phase4 + queue.v3 : 0
  const prog = queue?.v3Progress
  const v3Active = prog && prog.total > 0 && prog.processed < prog.total
  const v3Pct = prog && prog.total > 0 ? Math.round((prog.processed / prog.total) * 100) : 0
  return (
    <div style={{ ...S.statCard, gridColumn: 'span 2' }}>
      <div style={{ fontSize: 12, color: 'rgba(235,235,245,0.45)', marginBottom: 10 }}>
        Enrichment Status
      </div>
      <div style={S.enrichBar}>
        <div style={S.enrichSeg('#5ac8fa', pct(v3))} />
        <div style={S.enrichSeg('#30d158', pct(v2))} />
        <div style={S.enrichSeg('#ff9f0a', pct(v1))} />
        <div style={S.enrichSeg('#ff453a', pct(v0))} />
      </div>
      <div style={S.enrichLegend}>
        <span style={S.legendItem}><span style={S.legendDot('#5ac8fa')} /> v3 {v3}</span>
        <span style={S.legendItem}>
          <span style={S.legendDot('#30d158')} /> v2 {v2}
          {v2 > 0 && <HealSmallBtn onClick={() => onReEnrich(2)} disabled={reEnriching}>Re-enrich</HealSmallBtn>}
        </span>
        <span style={S.legendItem}>
          <span style={S.legendDot('#ff9f0a')} /> v1 {v1}
          {v1 > 0 && <HealSmallBtn onClick={() => onReEnrich(1)} disabled={reEnriching}>Re-enrich</HealSmallBtn>}
        </span>
        <span style={S.legendItem}>
          <span style={S.legendDot('#ff453a')} /> v0 {v0}
          {v0 > 0 && <HealSmallBtn onClick={() => onReEnrich(0)} disabled={reEnriching}>Re-enrich</HealSmallBtn>}
        </span>
      </div>

      {/* V3 batch progress */}
      {v3Active && (
        <div style={{ marginTop: 12 }}>
          <style>{`
            @keyframes v3-stripe {
              0% { background-position: 0 0; }
              100% { background-position: 20px 0; }
            }
          `}</style>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'rgba(235,235,245,0.8)', marginBottom: 6 }}>
            <span>
              V3 Heal: {prog.processed}/{prog.total} ({v3Pct}%)
              {prog.healed > 0 && <span style={{ color: '#30d158', marginLeft: 8 }}>+{prog.healed} healed</span>}
              {prog.paused && <span style={{ color: '#ff9f0a', marginLeft: 8 }}>PAUSED</span>}
            </span>
            <span style={{ display: 'flex', gap: 6 }}>
              {prog.paused
                ? <HealSmallBtn onClick={onResume}>Resume</HealSmallBtn>
                : <HealSmallBtn onClick={onPause}>Pause</HealSmallBtn>
              }
            </span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: '#2c2c2e', overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 3, transition: 'width 0.4s ease',
              width: `${v3Pct}%`,
              ...(prog.paused
                ? { background: '#ff9f0a' }
                : {
                    backgroundImage: 'linear-gradient(135deg, rgba(255,255,255,0.15) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.15) 50%, rgba(255,255,255,0.15) 75%, transparent 75%)',
                    backgroundSize: '20px 20px',
                    backgroundColor: '#5ac8fa',
                    animation: 'v3-stripe 0.6s linear infinite',
                  }
              ),
            }} />
          </div>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(235,235,245,0.6)', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {noCn > 0 && !v3Active && (
          <>
            <span style={{ color: '#ff9f0a' }}>Missing CN title: {noCn}</span>
            <HealSmallBtn onClick={onHeal} disabled={healing || queueTotal > 0}>
              {healing ? 'Healing...' : 'Heal All'}
            </HealSmallBtn>
          </>
        )}
        {queueTotal > 0 && (
          <span>Queue: P1-3 {queue.phase1} / P4 {queue.phase4} / V3 {queue.v3}</span>
        )}
      </div>
    </div>
  )
}

function VersionBadge({ version }) {
  if (version >= 3) return <span style={S.badge('#5ac8fa')}>v{version}</span>
  if (version === 2) return <span style={S.badge('#30d158')}>v{version}</span>
  if (version === 1) return <span style={S.badge('#ff9f0a')}>v{version}</span>
  return <span style={S.badge('#ff453a')}>v{version ?? 0}</span>
}

function FlagBadge({ flag, t }) {
  if (flag === 'needs-review') return <span style={S.badge('#ff9f0a')}>{t('admin.needsReview')}</span>
  if (flag === 'manually-corrected') return <span style={S.badge('#5ac8fa')}>{t('admin.corrected')}</span>
  return null
}

// --- Main ---

export default function AdminDashboard() {
  const { user } = useAuth()
  const { t } = useLang()
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState('')
  const [search, setSearch] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  // User management state
  const [userPage, setUserPage] = useState(1)
  const [userSearch, setUserSearch] = useState('')
  const [userSearchQuery, setUserSearchQuery] = useState('')
  const [newUser, setNewUser] = useState({ username: '', email: '', password: '' })
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({ username: '', email: '' })
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  // Enrichment editing state
  const [enrichEditId, setEnrichEditId] = useState(null)
  const [enrichEditForm, setEnrichEditForm] = useState({ titleChinese: '', bgmId: '', bangumiScore: '' })

  const { data: stats } = useAdminStats()
  const { data, isLoading, isError } = useEnrichmentList(page, filter, searchQuery)
  const enrichUpdateMut = useUpdateEnrichment()
  const resetMut = useResetEnrichment()
  const flagMut = useFlagEnrichment()
  const reEnrichMut = useReEnrich()
  const healMut = useHealCnTitles()
  const pauseMut = usePauseHeal()
  const resumeMut = useResumeHeal()
  const { data: userData, isLoading: usersLoading, isError: usersError } = useUserList(userPage, userSearchQuery)
  const createMut = useCreateUser()
  const updateMut = useUpdateUser()
  const deleteMut = useDeleteUser()

  if (!user || user.role !== 'admin') return <Navigate to="/" replace />

  const handleFilter = (f) => { setFilter(f); setPage(1) }
  const handleSearch = (e) => {
    e.preventDefault()
    setSearchQuery(search)
    setPage(1)
  }
  const startEnrichEdit = (item) => {
    setEnrichEditId(item.anilistId)
    setEnrichEditForm({
      titleChinese: item.titleChinese || '',
      bgmId: item.bgmId ?? '',
      bangumiScore: item.bangumiScore ?? '',
    })
  }
  const handleSaveEnrichEdit = (anilistId) => {
    const payload = {}
    if (enrichEditForm.titleChinese) payload.titleChinese = enrichEditForm.titleChinese
    if (enrichEditForm.bgmId !== '') payload.bgmId = Number(enrichEditForm.bgmId) || null
    if (enrichEditForm.bangumiScore !== '') payload.bangumiScore = Number(enrichEditForm.bangumiScore) || null
    enrichUpdateMut.mutate({ anilistId, data: payload }, { onSuccess: () => setEnrichEditId(null) })
  }
  const handleUserSearch = (e) => {
    e.preventDefault()
    setUserSearchQuery(userSearch)
    setUserPage(1)
  }
  const handleCreateUser = (e) => {
    e.preventDefault()
    if (!newUser.username || !newUser.email || !newUser.password) return
    createMut.mutate(newUser, { onSuccess: () => setNewUser({ username: '', email: '', password: '' }) })
  }
  const startEdit = (u) => {
    setEditingId(u._id)
    setEditForm({ username: u.username, email: u.email })
  }
  const handleSaveEdit = (userId) => {
    updateMut.mutate({ userId, data: editForm }, { onSuccess: () => setEditingId(null) })
  }
  const handleDelete = (userId) => {
    deleteMut.mutate(userId, { onSuccess: () => setDeleteConfirm(null) })
  }

  return (
    <div className="container" style={S.container}>
      <h1 style={S.header}>{t('admin.title')}</h1>

      {/* ===== Dashboard Overview ===== */}
      {stats && (
        <div style={S.statsGrid}>
          <StatCard value={stats.users} label={t('admin.statUsers')} />
          <StatCard value={stats.anime} label={t('admin.statAnime')} />
          <StatCard value={stats.subscriptions} label={t('admin.statSubs')} />
          <StatCard value={stats.follows} label={t('admin.statFollows')} />
          <StatCard value={stats.flagged} label={t('admin.statFlagged')} color={stats.flagged > 0 ? '#ff9f0a' : undefined} />
          <EnrichmentBar v0={stats.enrichment.v0} v1={stats.enrichment.v1} v2={stats.enrichment.v2} v3={stats.enrichment.v3} noCn={stats.enrichment.noCn} queue={stats.queue} total={stats.anime} onHeal={() => healMut.mutate()} onPause={() => pauseMut.mutate()} onResume={() => resumeMut.mutate()} healing={healMut.isPending} onReEnrich={(v) => reEnrichMut.mutate(v)} reEnriching={reEnrichMut.isPending} />
        </div>
      )}

      <div style={S.divider} />

      {/* ===== Enrichment Management ===== */}
      <h2 style={S.sectionTitle}>{t('admin.enrichmentTitle')}</h2>

      {/* Search + Filters */}
      <div style={S.toolbar}>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('admin.searchPlaceholder')}
            style={S.searchInput}
          />
          <button type="submit" style={S.filterBtn(false)}>{t('admin.searchBtn')}</button>
          {searchQuery && (
            <button type="button" style={S.filterBtn(false)} onClick={() => { setSearch(''); setSearchQuery(''); setPage(1) }}>
              {t('admin.clearSearch')}
            </button>
          )}
        </form>
      </div>
      <div style={{ ...S.toolbar, marginBottom: 24 }}>
        {FILTERS.map(f => (
          <button key={f.value} style={S.filterBtn(filter === f.value)} onClick={() => handleFilter(f.value)}>
            {t(f.label)}
          </button>
        ))}
      </div>

      {isLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}>
          <LoadingSpinner />
        </div>
      )}

      {isError && (
        <p style={{ color: '#ff453a', textAlign: 'center', paddingTop: 40 }}>{t('admin.loadError')}</p>
      )}

      {data && (
        <>
          <p style={S.stat}>{t('admin.totalPrefix')} {data.total} {t('admin.totalSuffix')}</p>

          <div style={{ overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>AniList ID</th>
                  <th style={S.th}>{t('admin.colTitle')}</th>
                  <th style={S.th}>{t('admin.colTitleCn')}</th>
                  <th style={S.th}>BGM ID</th>
                  <th style={S.th}>{t('admin.colVersion')}</th>
                  <th style={S.th}>{t('admin.colScore')}</th>
                  <th style={S.th}>{t('admin.colFlag')}</th>
                  <th style={S.th}>{t('admin.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map(item => {
                  const isEditing = enrichEditId === item.anilistId
                  return (
                    <tr key={item.anilistId}>
                      <td style={S.td}>
                        <a href={`/anime/${item.anilistId}`} style={{ color: '#0a84ff', textDecoration: 'none' }}>
                          {item.anilistId}
                        </a>
                      </td>
                      <td style={{ ...S.td, ...S.titleCell }}>{item.titleRomaji || '—'}</td>
                      <td style={S.td}>
                        {isEditing
                          ? <input style={S.editInput} value={enrichEditForm.titleChinese} onChange={e => setEnrichEditForm({ ...enrichEditForm, titleChinese: e.target.value })} placeholder={t('admin.colTitleCn')} />
                          : item.titleChinese || '—'
                        }
                      </td>
                      <td style={S.td}>
                        {isEditing
                          ? <input style={{ ...S.editInput, width: 80 }} value={enrichEditForm.bgmId} onChange={e => setEnrichEditForm({ ...enrichEditForm, bgmId: e.target.value })} placeholder="BGM ID" />
                          : item.bgmId || '—'
                        }
                      </td>
                      <td style={S.td}><VersionBadge version={item.bangumiVersion} /></td>
                      <td style={S.td}>
                        {isEditing
                          ? <input style={{ ...S.editInput, width: 60 }} value={enrichEditForm.bangumiScore} onChange={e => setEnrichEditForm({ ...enrichEditForm, bangumiScore: e.target.value })} placeholder={t('admin.colScore')} />
                          : item.bangumiScore?.toFixed(1) || '—'
                        }
                      </td>
                      <td style={S.td}><FlagBadge flag={item.adminFlag} t={t} /></td>
                      <td style={S.td}>
                        {isEditing ? (
                          <>
                            <button style={S.saveBtn} onClick={() => handleSaveEnrichEdit(item.anilistId)} disabled={enrichUpdateMut.isPending}>
                              {t('admin.save')}
                            </button>
                            <button style={S.cancelBtn} onClick={() => setEnrichEditId(null)}>
                              {t('admin.cancel')}
                            </button>
                          </>
                        ) : (
                          <>
                            <button style={S.actionBtn} onClick={() => startEnrichEdit(item)}>
                              {t('admin.edit')}
                            </button>
                            <button
                              style={S.resetBtn}
                              onClick={() => resetMut.mutate(item.anilistId)}
                              disabled={resetMut.isPending}
                            >
                              {t('admin.reset')}
                            </button>
                            {item.adminFlag !== 'needs-review' && (
                              <button
                                style={S.actionBtn}
                                onClick={() => flagMut.mutate({ anilistId: item.anilistId, flag: 'needs-review' })}
                                disabled={flagMut.isPending}
                              >
                                {t('admin.markReview')}
                              </button>
                            )}
                            {item.adminFlag && (
                              <button
                                style={S.actionBtn}
                                onClick={() => flagMut.mutate({ anilistId: item.anilistId, flag: null })}
                                disabled={flagMut.isPending}
                              >
                                {t('admin.clearFlag')}
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {data.data.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ ...S.td, textAlign: 'center', color: 'rgba(235,235,245,0.30)' }}>
                      {t('admin.noResults')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div style={S.pageRow}>
            <button
              style={S.pageBtn(page <= 1)}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              {t('admin.prev')}
            </button>
            <span style={{ color: 'rgba(235,235,245,0.60)', fontSize: 13, alignSelf: 'center' }}>
              {page}
            </span>
            <button
              style={S.pageBtn(!data.hasMore)}
              onClick={() => setPage(p => p + 1)}
              disabled={!data.hasMore}
            >
              {t('admin.next')}
            </button>
          </div>
        </>
      )}

      {/* ===== User Management ===== */}
      <div style={{ ...S.divider, marginTop: 40 }} />
      <h2 style={S.sectionTitle}>{t('admin.usersTitle')}</h2>

      {/* Create User */}
      <form onSubmit={handleCreateUser} style={S.createForm}>
        <input
          type="text"
          value={newUser.username}
          onChange={e => setNewUser({ ...newUser, username: e.target.value })}
          placeholder={t('admin.colUsername')}
          style={S.formInput}
        />
        <input
          type="email"
          value={newUser.email}
          onChange={e => setNewUser({ ...newUser, email: e.target.value })}
          placeholder={t('admin.colEmail')}
          style={S.formInput}
        />
        <input
          type="password"
          value={newUser.password}
          onChange={e => setNewUser({ ...newUser, password: e.target.value })}
          placeholder={t('admin.password')}
          style={{ ...S.formInput, width: 150 }}
        />
        <button type="submit" style={S.createBtn} disabled={createMut.isPending}>
          {t('admin.createUser')}
        </button>
      </form>

      {/* Search */}
      <div style={S.toolbar}>
        <form onSubmit={handleUserSearch} style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={userSearch}
            onChange={e => setUserSearch(e.target.value)}
            placeholder={t('admin.userSearchPlaceholder')}
            style={S.searchInput}
          />
          <button type="submit" style={S.filterBtn(false)}>{t('admin.searchBtn')}</button>
          {userSearchQuery && (
            <button type="button" style={S.filterBtn(false)} onClick={() => { setUserSearch(''); setUserSearchQuery(''); setUserPage(1) }}>
              {t('admin.clearSearch')}
            </button>
          )}
        </form>
      </div>

      {usersLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}>
          <LoadingSpinner />
        </div>
      )}

      {usersError && (
        <p style={{ color: '#ff453a', textAlign: 'center', paddingTop: 40 }}>{t('admin.loadError')}</p>
      )}

      {userData && (
        <>
          <p style={S.stat}>{t('admin.totalPrefix')} {userData.total} {t('admin.totalSuffix')}</p>
          <div style={{ overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>{t('admin.colUsername')}</th>
                  <th style={S.th}>{t('admin.colEmail')}</th>
                  <th style={S.th}>{t('admin.colSubs')}</th>
                  <th style={S.th}>{t('admin.colFollowers')}</th>
                  <th style={S.th}>{t('admin.colJoined')}</th>
                  <th style={S.th}>{t('admin.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {userData.data.map(u => (
                  <tr key={u._id}>
                    <td style={{ ...S.td, ...S.titleCell }}>
                      {editingId === u._id
                        ? <input style={S.editInput} value={editForm.username} onChange={e => setEditForm({ ...editForm, username: e.target.value })} />
                        : u.username
                      }
                    </td>
                    <td style={S.td}>
                      {editingId === u._id
                        ? <input style={S.editInput} value={editForm.email} onChange={e => setEditForm({ ...editForm, email: e.target.value })} />
                        : u.email
                      }
                    </td>
                    <td style={S.td}>{u.subscriptions}</td>
                    <td style={S.td}>{u.followers}</td>
                    <td style={S.td}>{new Date(u.createdAt).toLocaleDateString()}</td>
                    <td style={S.td}>
                      {editingId === u._id ? (
                        <>
                          <button style={S.saveBtn} onClick={() => handleSaveEdit(u._id)} disabled={updateMut.isPending}>
                            {t('admin.save')}
                          </button>
                          <button style={S.cancelBtn} onClick={() => setEditingId(null)}>
                            {t('admin.cancel')}
                          </button>
                        </>
                      ) : deleteConfirm === u._id ? (
                        <>
                          <button style={S.deleteBtn} onClick={() => handleDelete(u._id)} disabled={deleteMut.isPending}>
                            {t('admin.confirmDelete')}
                          </button>
                          <button style={S.cancelBtn} onClick={() => setDeleteConfirm(null)}>
                            {t('admin.cancel')}
                          </button>
                        </>
                      ) : (
                        <>
                          <button style={S.actionBtn} onClick={() => startEdit(u)}>
                            {t('admin.edit')}
                          </button>
                          <button style={S.deleteBtn} onClick={() => setDeleteConfirm(u._id)}>
                            {t('admin.delete')}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {userData.data.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ ...S.td, textAlign: 'center', color: 'rgba(235,235,245,0.30)' }}>
                      {t('admin.noResults')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={S.pageRow}>
            <button
              style={S.pageBtn(userPage <= 1)}
              onClick={() => setUserPage(p => Math.max(1, p - 1))}
              disabled={userPage <= 1}
            >
              {t('admin.prev')}
            </button>
            <span style={{ color: 'rgba(235,235,245,0.60)', fontSize: 13, alignSelf: 'center' }}>
              {userPage}
            </span>
            <button
              style={S.pageBtn(!userData.hasMore)}
              onClick={() => setUserPage(p => p + 1)}
              disabled={!userData.hasMore}
            >
              {t('admin.next')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
