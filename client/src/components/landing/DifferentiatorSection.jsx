/**
 * Three bold manifesto statements + explanations.
 * Explicitly NOT a ✓/✗ comparison table (too SaaS).
 */

const items = [
  {
    num: '01',
    claim: '我们不做信息流推荐。',
    body:
      '没有"猜你喜欢"、没有无限刷。按季追番是时间的结构,算法不该替你拆掉它。',
  },
  {
    num: '02',
    claim: '我们不藏 VIP 集数。',
    body:
      '你看到的就是你能看到的。没有会员票、没有"本集仅限 12 小时"。',
  },
  {
    num: '03',
    claim: '我们承认聚合会脏。',
    body:
      '自动匹配会错、源会挂、番名会撞。所以选集这件事,最终还是交还给你。',
  },
]

const s = {
  section: {
    position: 'relative',
    padding: 'clamp(80px, 7vw, 120px) 0',
    background: '#000',
    borderTop: '1px solid rgba(84,84,88,0.30)',
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
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 0.8fr) minmax(0, 1fr)',
    gap: 'clamp(32px, 5vw, 96px)',
    alignItems: 'start',
  },
  stickyLeft: {
    position: 'sticky',
    top: 96,
  },
  eyebrow: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    letterSpacing: '0.12em',
    color: 'rgba(235,235,245,0.30)',
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 'clamp(2rem, 1rem + 3vw, 3.25rem)',
    fontWeight: 800,
    color: '#fff',
    letterSpacing: '-0.03em',
    lineHeight: 1.1,
  },
  subtle: {
    marginTop: 20,
    fontSize: 15,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.6,
    maxWidth: 420,
  },
  list: { display: 'flex', flexDirection: 'column' },
  row: {
    display: 'grid',
    gridTemplateColumns: '64px 1fr',
    gap: 24,
    padding: '32px 0',
    borderBottom: '1px solid rgba(84,84,88,0.30)',
  },
  rowLast: {
    borderBottom: 'none',
  },
  num: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.08em',
    paddingTop: 6,
  },
  claim: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 'clamp(1.5rem, 1rem + 1vw, 2rem)',
    fontWeight: 700,
    color: '#fff',
    letterSpacing: '-0.02em',
    lineHeight: 1.2,
    marginBottom: 12,
  },
  body: {
    fontSize: 15,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.7,
    maxWidth: '58ch',
  },
}

export default function DifferentiatorSection() {
  return (
    <section style={s.section} aria-labelledby="diff-title">
      <style>{`
        @media (max-width: 880px) {
          .diff-grid { grid-template-columns: 1fr !important; gap: 40px !important; }
          .diff-sticky { position: static !important; }
        }
      `}</style>
      <span style={s.sectionNum} aria-hidden>§05</span>
      <div className="container">
        <div className="diff-grid" style={s.grid}>
          <div className="diff-sticky" style={s.stickyLeft}>
            <div style={s.eyebrow}>Why animego</div>
            <h2 id="diff-title" style={s.title}>
              三件我们不做的事。
            </h2>
            <p style={s.subtle}>
              一个产品的性格,一半是"我们做了什么",一半是"我们坚持不做什么"。
            </p>
          </div>
          <div style={s.list}>
            {items.map((it, i) => (
              <div
                key={it.num}
                style={{ ...s.row, ...(i === items.length - 1 ? s.rowLast : null) }}
              >
                <div style={s.num}>{it.num}</div>
                <div>
                  <h3 style={s.claim}>{it.claim}</h3>
                  <p style={s.body}>{it.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
