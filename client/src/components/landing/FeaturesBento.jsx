/**
 * 2x2 bento with unequal weights.
 * Each cell carries an OKLCH chapter bar (4px × 48px) — reuses the product's
 * poster-accent identity system instead of generic brand colors.
 */

const features = [
  {
    key: 'poster',
    size: 'lg', // spans 7 cols, 2 rows — headline feature
    hue: 330,
    eyebrow: '01 · 海报色身份',
    title: '颜色就是身份证。',
    body:
      '每部番的主色都从封面里真正提出来 —— 不是 Material You、不是主题色映射,是 OKLCH 归一化后的 accent,贯穿详情页、骨架、播放器。封面换了,身份就换了。',
    visual: 'poster',
  },
  {
    key: 'danmaku',
    size: 'md',
    hue: 210,
    eyebrow: '02 · 弹幕同屏',
    title: '保留集体观看感。',
    body: '不做孤岛。你发的弹幕,别人看得见;别人飘过的那条,替你讲了下一句。',
    visual: 'danmaku',
  },
  {
    key: 'multi',
    size: 'md',
    hue: 155,
    eyebrow: '03 · 多源聚合',
    title: '一部番,多源,一个播放器。',
    body: '源出问题就切下一个,不用跳站、不用搜索。播放器自己做决定。',
    visual: 'multi',
  },
  {
    key: 'manual',
    size: 'xl', // full-width bottom row
    hue: 40,
    eyebrow: '04 · 手动选集',
    title: '匹配不了?你来点。',
    body:
      '我们不装懂。自动匹配搞砸的时候,给你一个"选一次就记住"的 UI —— 比 AI 猜对更可靠,比每次都猜错更体面。',
    visual: 'manual',
  },
]

const s = {
  section: {
    position: 'relative',
    padding: 'clamp(80px, 7vw, 120px) 0',
    background: '#000',
  },
  sectionNum: {
    position: 'absolute',
    top: 28, right: 32,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: '0.14em',
    color: 'rgba(235,235,245,0.30)',
    textTransform: 'uppercase',
  },
  header: {
    maxWidth: 720,
    marginBottom: 64,
  },
  sectionEyebrow: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    letterSpacing: '0.12em',
    color: 'rgba(235,235,245,0.30)',
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  sectionTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 'clamp(2rem, 1rem + 3vw, 3.5rem)',
    fontWeight: 800,
    color: '#fff',
    letterSpacing: '-0.03em',
    lineHeight: 1.1,
    marginBottom: 20,
  },
  sectionSub: {
    fontSize: 16,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.6,
    maxWidth: 560,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(12, 1fr)',
    gridAutoRows: 'minmax(240px, auto)',
    gap: 20,
  },
  card: (hue) => ({
    position: 'relative',
    padding: 32,
    borderRadius: 18,
    background: '#0d0d0f',
    border: '1px solid rgba(84,84,88,0.35)',
    transition: 'transform 250ms var(--ease-out-expo), border-color 250ms var(--ease-out-expo), box-shadow 250ms var(--ease-out-expo)',
    overflow: 'hidden',
    cursor: 'default',
    '--hue': hue,
  }),
  chapterBar: (hue) => ({
    position: 'absolute',
    top: 32, left: 32,
    width: 3, height: 48,
    background: `oklch(62% 0.19 ${hue})`,
    borderRadius: 2,
    boxShadow: `0 0 24px oklch(62% 0.19 ${hue} / 0.55)`,
  }),
  cardEyebrow: {
    marginLeft: 16,
    paddingTop: 2,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: 'rgba(235,235,245,0.60)',
    letterSpacing: '0.08em',
    marginBottom: 28,
  },
  cardTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 26,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: '-0.02em',
    lineHeight: 1.2,
    marginBottom: 14,
  },
  cardBody: {
    fontSize: 15,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.65,
    maxWidth: '58ch',
  },
  visualWrap: {
    marginTop: 28,
    position: 'relative',
    minHeight: 120,
  },
}

/* ———————— visual helpers (pure CSS, no images) ———————— */

function PosterVisual({ hue }) {
  return (
    <div style={{ display: 'flex', gap: 12, marginTop: 28 }}>
      {[hue, hue + 40, hue - 55].map((h, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            aspectRatio: '3/4',
            borderRadius: 10,
            background: `radial-gradient(80% 60% at 50% 30%, oklch(58% 0.2 ${h}) 0%, oklch(25% 0.11 ${h}) 55%, oklch(10% 0.04 ${h}) 100%)`,
            border: '1px solid rgba(255,255,255,0.05)',
            boxShadow: `0 12px 32px -8px oklch(58% 0.2 ${h} / 0.28)`,
          }}
        />
      ))}
    </div>
  )
}

function DanmakuVisual() {
  const lines = [
    { t: '这集画面神了', y: 10 },
    { t: '前面高能', y: 38 },
    { t: 'op 又来了', y: 66 },
  ]
  return (
    <div style={{
      position: 'relative',
      marginTop: 28,
      aspectRatio: '16/6',
      borderRadius: 10,
      background: 'linear-gradient(135deg, #141422 0%, #0a0a14 100%)',
      border: '1px solid rgba(255,255,255,0.05)',
      overflow: 'hidden',
    }}>
      {lines.map((l, i) => (
        <span key={i} style={{
          position: 'absolute',
          top: `${l.y}%`,
          left: `${10 + i * 12}%`,
          padding: '2px 8px',
          fontSize: 11,
          color: '#fff',
          fontFamily: "'DM Sans', sans-serif",
          textShadow: '0 1px 2px rgba(0,0,0,0.85)',
          whiteSpace: 'nowrap',
        }}>{l.t}</span>
      ))}
    </div>
  )
}

function MultiSourceVisual({ hue }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 28 }}>
      {['源 A · 1080p', '源 B · 720p · 熟肉', '源 C · 4K · 生肉'].map((label, i) => (
        <div
          key={i}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 12px',
            borderRadius: 8,
            background: i === 0 ? `oklch(22% 0.07 ${hue} / 0.6)` : 'rgba(255,255,255,0.03)',
            border: i === 0 ? `1px solid oklch(62% 0.19 ${hue} / 0.45)` : '1px solid rgba(255,255,255,0.05)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: i === 0 ? '#fff' : 'rgba(235,235,245,0.60)',
            letterSpacing: '0.04em',
          }}
        >
          <span style={{
            width: 6, height: 6, borderRadius: 9999,
            background: i === 0 ? `oklch(70% 0.2 ${hue})` : 'rgba(235,235,245,0.30)',
          }} />
          {label}
          {i === 0 && <span style={{ marginLeft: 'auto', color: 'rgba(235,235,245,0.60)' }}>当前</span>}
        </div>
      ))}
    </div>
  )
}

function ManualPickVisual({ hue }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6, marginTop: 28 }}>
      {Array.from({ length: 12 }).map((_, i) => {
        const picked = i === 5
        return (
          <div
            key={i}
            style={{
              aspectRatio: '1',
              borderRadius: 6,
              background: picked ? `oklch(62% 0.19 ${hue})` : 'rgba(255,255,255,0.04)',
              border: picked ? `1px solid oklch(78% 0.19 ${hue})` : '1px solid rgba(255,255,255,0.06)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              color: picked ? '#000' : 'rgba(235,235,245,0.30)',
              fontWeight: picked ? 700 : 500,
              boxShadow: picked ? `0 0 16px oklch(62% 0.19 ${hue} / 0.5)` : 'none',
            }}
          >
            {i + 1}
          </div>
        )
      })}
    </div>
  )
}

function Visual({ type, hue }) {
  if (type === 'poster') return <PosterVisual hue={hue} />
  if (type === 'danmaku') return <DanmakuVisual />
  if (type === 'multi') return <MultiSourceVisual hue={hue} />
  if (type === 'manual') return <ManualPickVisual hue={hue} />
  return null
}

export default function FeaturesBento() {
  return (
    <section style={s.section} aria-labelledby="features-title">
      <span style={s.sectionNum} aria-hidden>§03</span>
      <style>{`
        .bento-card[data-size="lg"] { grid-column: span 7; grid-row: span 2; }
        .bento-card[data-size="md"] { grid-column: span 5; }
        .bento-card[data-size="xl"] { grid-column: span 12; }
        @media (max-width: 880px) {
          .bento-grid { grid-template-columns: 1fr !important; grid-auto-rows: auto !important; }
          .bento-card { grid-column: 1 / -1 !important; grid-row: auto !important; }
        }
        .bento-card:hover {
          transform: translateY(-3px);
          border-color: rgba(84,84,88,0.75) !important;
          box-shadow: 0 16px 40px -12px oklch(62% 0.19 var(--hue) / 0.18) !important;
        }
      `}</style>
      <div className="container">
        <header style={s.header}>
          <div style={s.sectionEyebrow}>Features / 核心能力</div>
          <h2 id="features-title" style={s.sectionTitle}>
            为"认真追番"做的四件事。
          </h2>
          <p style={s.sectionSub}>
            不是更多功能,是更少废话。下面这四件事,动漫站普遍没做好,我们挨个做了。
          </p>
        </header>

        <div className="bento-grid" style={s.grid}>
          {features.map((f) => (
            <article
              key={f.key}
              className="bento-card"
              data-size={f.size}
              style={s.card(f.hue)}
            >
              <span style={s.chapterBar(f.hue)} />
              <div style={s.cardEyebrow}>{f.eyebrow}</div>
              <h3 style={s.cardTitle}>{f.title}</h3>
              <p style={s.cardBody}>{f.body}</p>
              <Visual type={f.visual} hue={f.hue} />
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
