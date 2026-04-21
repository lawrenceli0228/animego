import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatScore, stripHtml, truncate, pickTitle } from '../../utils/formatters'
import { hexToRgbCss } from '../../utils/color'
import { useLang } from '../../context/LanguageContext'

const scoreColor = (s) => s >= 75 ? '#30d158' : s >= 50 ? '#ff9f0a' : '#ff453a'

const SOURCE_LABEL = {
  ORIGINAL:     { zh: '原创',    en: 'Original' },
  MANGA:        { zh: '漫改',    en: 'Manga' },
  LIGHT_NOVEL:  { zh: '轻小说改', en: 'Light Novel' },
  VISUAL_NOVEL: { zh: '视觉小说改', en: 'Visual Novel' },
  VIDEO_GAME:   { zh: '游戏改',  en: 'Video Game' },
  NOVEL:        { zh: '小说改',  en: 'Novel' },
  WEB_NOVEL:    { zh: '网文改',  en: 'Web Novel' },
  GAME:         { zh: '游戏改',  en: 'Game' },
}

const RELATION_LABEL = {
  PREQUEL:    { zh: '前作', en: 'Prequel' },
  SEQUEL:     { zh: '续作', en: 'Sequel' },
  PARENT:     { zh: '原作', en: 'Parent' },
  SIDE_STORY: { zh: '外传', en: 'Side Story' },
  SPIN_OFF:   { zh: '衍生', en: 'Spin-off' },
  ADAPTATION: { zh: '改编', en: 'Adaptation' },
}
const SHOWN_RELATIONS = new Set(['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'SPIN_OFF'])

// --- Static styles (extracted to avoid re-creation on every render) ---

const S = {
  bannerOverlay: {
    position:'absolute', inset:0,
    background:'linear-gradient(to bottom, rgba(var(--poster-accent-rgb), 0.35) 0%, rgba(0,0,0,0.35) 35%, rgba(0,0,0,0.92) 100%)',
  },
  cover: {
    width:210, height:300, objectFit:'cover', borderRadius:12,
    border:'1px solid var(--poster-accent)',
    boxShadow:'0 16px 48px rgba(0,0,0,0.60), 0 0 60px rgba(var(--poster-accent-rgb), 0.45)',
  },
  title: { fontSize:'clamp(22px,4vw,36px)', color:'#ffffff', marginBottom:4 },
  subtitle: { color:'rgba(235,235,245,0.60)', fontSize:15, marginBottom:16 },
  badgeRow: { display:'flex', flexWrap:'wrap', gap:10, marginBottom:16 },
  badge: (bg, color) => ({ padding:'4px 12px', borderRadius:9999, background:bg, color, fontSize:13 }),
  scoreBadge: (color) => ({
    padding:'4px 12px', borderRadius:9999, background:'rgba(255,159,10,0.12)',
    color, fontWeight:700, fontSize:13, fontFamily:"'JetBrains Mono',monospace",
  }),
  bgmScoreBadge: {
    padding:'4px 12px', borderRadius:9999, background:'rgba(255,69,58,0.10)',
    color:'#ff453a', fontWeight:700, fontSize:13,
    display:'inline-flex', alignItems:'center', gap:5,
    fontFamily:"'JetBrains Mono',monospace",
  },
  bgmLabel: { fontSize:10, opacity:0.7, fontFamily:"'DM Sans',sans-serif" },
  bgmVotes: { fontSize:11, opacity:0.6, fontWeight:400 },
  bgmLink: {
    padding:'4px 12px', borderRadius:9999,
    background:'rgba(255,69,58,0.10)', color:'#ff453a', fontSize:13,
    textDecoration:'none',
    display:'inline-flex', alignItems:'center', gap:4, fontWeight:500,
    transition:'background 0.2s',
  },
  shimmer: (width) => ({
    display:'inline-block', width, height:26, borderRadius:9999,
    background:'linear-gradient(90deg, #2c2c2e 25%, #3a3a3c 50%, #2c2c2e 75%)',
    backgroundSize:'200% 100%', animation:'shimmer 1.4s ease-in-out infinite',
  }),
  titleShimmer: {
    width:'60%', height:36, borderRadius:8, marginBottom:8,
    background:'linear-gradient(90deg, #2c2c2e 25%, #3a3a3c 50%, #2c2c2e 75%)',
    backgroundSize:'200% 100%', animation:'shimmer 1.4s ease-in-out infinite',
  },
  metaRow: { display:'flex', flexWrap:'wrap', gap:'4px 12px', marginBottom:16, alignItems:'center' },
  metaStudio: { color:'rgba(235,235,245,0.75)', fontSize:13 },
  metaDot: { color:'rgba(84,84,88,0.65)', fontSize:13 },
  metaDetail: { color:'rgba(235,235,245,0.50)', fontSize:12 },
  genreRow: { display:'flex', flexWrap:'wrap', gap:6, marginBottom:20 },
  genreTag: {
    padding:'4px 10px', borderRadius:9999,
    background:'rgba(120,120,128,0.12)', color:'rgba(235,235,245,0.60)', fontSize:12,
    fontWeight:500,
  },
  descText: { color:'rgba(235,235,245,0.60)', fontSize:14, lineHeight:1.8 },
  readMoreBtn: {
    color:'#0a84ff', fontSize:13, fontWeight:600, marginTop:8, cursor:'pointer',
    background:'none', border:'none', padding:0,
  },
  relationsRow: { display:'flex', flexWrap:'wrap', gap:8 },
  relationBtn: {
    display:'inline-flex', alignItems:'center', gap:6,
    padding:'5px 12px', borderRadius:8, cursor:'pointer',
    background:'rgba(120,120,128,0.12)', border:'1px solid rgba(84,84,88,0.65)',
    color:'rgba(235,235,245,0.60)', fontSize:12, fontWeight:500,
    transition:'all 0.2s',
  },
  relationLabel: { color:'rgba(235,235,245,0.35)', fontSize:11 },
}

export default function AnimeDetailHero({ anime }) {
  const [expanded, setExpanded] = useState(false)
  const { t, lang } = useLang()
  const navigate = useNavigate()
  const {
    titleRomaji, titleEnglish, titleNative,
    coverImageUrl, bannerImageUrl, description,
    episodes, status, season, seasonYear,
    averageScore, genres = [], format, bgmId,
    studios = [], source, duration, startDate,
    bangumiScore, bangumiVotes, relations = [],
    coverImageColor,
  } = anime
  const accent = coverImageColor || '#8B5CF6'
  const accentRgb = hexToRgbCss(coverImageColor)
  const isEnriching = (anime.bangumiVersion ?? 0) < 2 ||
    (anime.bangumiVersion === 2 && anime.bgmId && !anime.titleChinese)

  const desc = stripHtml(description || '')
  const displayDesc = expanded ? desc : truncate(desc, 300)
  const statusLabel = {
    RELEASING: t('detail.releasing'), FINISHED: t('detail.finished'),
    NOT_YET_RELEASED: t('detail.notYetReleased'), CANCELLED: t('detail.cancelled')
  }[status] || status

  const sourceLabel = SOURCE_LABEL[source]?.[lang] ?? null
  const durationLabel = duration ? (lang === 'zh' ? `${duration}分/集` : `${duration} min/ep`) : null

  let startDateLabel = null
  if (startDate?.year) {
    startDateLabel = lang === 'zh'
      ? `${startDate.year}年${startDate.month ? startDate.month + '月' : ''}${startDate.day ? startDate.day + '日' : ''}`
      : new Date(startDate.year, (startDate.month || 1) - 1, startDate.day || 1)
          .toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: startDate.day ? 'numeric' : undefined })
  }

  const visibleRelations = relations.filter(r => SHOWN_RELATIONS.has(r.relationType))

  return (
    <div style={{ '--poster-accent': accent, '--poster-accent-rgb': accentRgb }}>
      {/* Banner */}
      <div style={{
        position:'relative', height: bannerImageUrl ? 400 : 120,
        background: bannerImageUrl ? `url(${bannerImageUrl}) center/cover` : '#000000',
        overflow:'hidden'
      }}>
        <div style={S.bannerOverlay} />
      </div>

      {/* Content */}
      <div className="container" style={{ display:'flex', gap:32, marginTop: bannerImageUrl ? -80 : 24, position:'relative', zIndex:1, paddingBottom:40 }}>
        {/* Cover */}
        <div style={{ flexShrink:0 }}>
          <img src={coverImageUrl} alt={titleRomaji}
            style={S.cover}
            onError={e => { e.target.style.background='#2c2c2e' }}
          />
        </div>

        {/* Meta */}
        <div style={{ flex:1, paddingTop: bannerImageUrl ? 60 : 0 }}>
          {lang === 'zh' && isEnriching && !anime.titleChinese ? (
            <>
              <div style={S.titleShimmer} />
              {titleNative && <p style={S.subtitle}>{titleNative}</p>}
            </>
          ) : (
            <>
              <h1 style={S.title}>{pickTitle(anime, lang)}</h1>
              {lang === 'zh' && titleNative && <p style={S.subtitle}>{titleNative}</p>}
            </>
          )}

          {/* Badges row */}
          <div style={S.badgeRow}>
            {averageScore && (
              <span style={S.scoreBadge(scoreColor(averageScore))}>
                ★ {formatScore(averageScore)}
              </span>
            )}
            {bangumiScore > 0 && (
              <span style={S.bgmScoreBadge}>
                <span style={S.bgmLabel}>BGM</span>
                ★ {bangumiScore.toFixed(1)}
                {bangumiVotes > 0 && <span style={S.bgmVotes}>({bangumiVotes.toLocaleString()})</span>}
              </span>
            )}
            {format && <span style={S.badge('rgba(10,132,255,0.12)', '#0a84ff')}>{format}</span>}
            {status && <span style={S.badge('rgba(90,200,250,0.10)', '#5ac8fa')}>{statusLabel}</span>}
            {episodes && <span style={S.badge('rgba(120,120,128,0.12)', 'rgba(235,235,245,0.60)')}>{episodes} {t('detail.epUnit')}</span>}
            {season && seasonYear && (
              <span style={S.badge('rgba(120,120,128,0.12)', 'rgba(235,235,245,0.60)')}>
                {t(`season.${season}`)} {seasonYear}
              </span>
            )}
            {bgmId && (
              <a
                href={`https://bgm.tv/subject/${bgmId}`}
                target="_blank"
                rel="noopener noreferrer"
                style={S.bgmLink}
                onMouseEnter={e => { e.currentTarget.style.background='rgba(255,69,58,0.20)' }}
                onMouseLeave={e => { e.currentTarget.style.background='rgba(255,69,58,0.10)' }}
              >
                <span style={{ fontSize:10, opacity:0.8 }}>▶</span>
                {t('detail.viewOnBgm')}
              </a>
            )}
            {isEnriching && !bangumiScore && <span style={S.shimmer(80)} />}
            {isEnriching && !bgmId && <span style={S.shimmer(110)} />}
          </div>

          {/* Meta info row */}
          {(studios.length > 0 || sourceLabel || durationLabel || startDateLabel) && (
            <div style={S.metaRow}>
              {studios.length > 0 && <span style={S.metaStudio}>{studios.join(' · ')}</span>}
              {(studios.length > 0 && (sourceLabel || durationLabel || startDateLabel)) && (
                <span style={S.metaDot}>·</span>
              )}
              {sourceLabel && <span style={S.metaDetail}>{sourceLabel}</span>}
              {durationLabel && <span style={S.metaDetail}>{durationLabel}</span>}
              {startDateLabel && <span style={S.metaDetail}>{startDateLabel}</span>}
            </div>
          )}

          {/* Genres */}
          <div style={S.genreRow}>
            {genres.map(g => <span key={g} style={S.genreTag}>{g}</span>)}
          </div>

          {/* Description */}
          {desc && (
            <div style={{ marginBottom: visibleRelations.length > 0 ? 20 : 0 }}>
              <p style={S.descText}>{displayDesc}</p>
              {desc.length > 300 && (
                <button onClick={() => setExpanded(!expanded)} style={S.readMoreBtn}>
                  {expanded ? t('detail.collapse') : t('detail.readMore')}
                </button>
              )}
            </div>
          )}

          {/* Relations */}
          {visibleRelations.length > 0 && (
            <div style={S.relationsRow}>
              {visibleRelations.map(r => {
                const label = RELATION_LABEL[r.relationType]?.[lang] ?? r.relationType
                return (
                  <button
                    key={`${r.relationType}-${r.anilistId}`}
                    onClick={() => navigate(`/anime/${r.anilistId}`)}
                    style={S.relationBtn}
                    onMouseEnter={e => { e.currentTarget.style.borderColor='var(--poster-accent)'; e.currentTarget.style.color='var(--poster-accent)' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor='rgba(84,84,88,0.65)'; e.currentTarget.style.color='rgba(235,235,245,0.60)' }}
                  >
                    <span style={S.relationLabel}>{label}</span>
                    {r.title}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
