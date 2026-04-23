/**
 * Native <details>/<summary> for zero-JS accessibility.
 * No rotating chevrons, no animated plus-signs — just a hairline reveal.
 */

const faqs = [
  {
    q: 'animego 是免费的吗?',
    a: '是。没有会员、没有集数锁、没有"开通 VIP 解锁"。运营成本靠开源捐赠和自付。',
    hue: 330,
  },
  {
    q: '为什么要手动选集?自动不行吗?',
    a: '自动能解决 90% 的情况,剩下 10% 会出岔 —— 番名重复、集数错位、季度拆分。比起让用户发现问题,不如在它发生时给一个一秒选对的 UI。',
    hue: 40,
  },
  {
    q: '弹幕从哪里来?',
    a: '站内弹幕 + 弹弹Play API 聚合。你看到的那条可能是昨天别人飘过的,这是设计如此。',
    hue: 210,
  },
  {
    q: '会不会哪天挂掉?',
    a: '会。我们是一个维护阶段的项目,不承诺 SLA。但会尽量让挂掉的时候,数据不丢。',
    hue: 155,
  },
  {
    q: '有移动端 App 吗?',
    a: '目前只有网页。浏览器打开能用就是能用,不想做一个只为"装上去"的 App。',
    hue: 330,
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
  header: {
    maxWidth: 720,
    marginBottom: 48,
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
    fontSize: 'clamp(2rem, 1rem + 3vw, 3rem)',
    fontWeight: 800,
    color: '#fff',
    letterSpacing: '-0.03em',
    lineHeight: 1.1,
  },
  list: {
    maxWidth: 760,
    borderTop: '1px solid rgba(84,84,88,0.30)',
  },
  item: (hue) => ({
    position: 'relative',
    borderBottom: '1px solid rgba(84,84,88,0.30)',
    '--faq-hue': hue,
  }),
  hueBar: (hue) => ({
    position: 'absolute',
    left: -20, top: 22,
    width: 3, height: 28,
    background: `oklch(62% 0.19 ${hue})`,
    borderRadius: 2,
    opacity: 0,
    transform: 'translateX(8px)',
    transition: 'opacity 200ms var(--ease-out-expo), transform 200ms var(--ease-out-expo)',
    boxShadow: `0 0 16px oklch(62% 0.19 ${hue} / 0.5)`,
    pointerEvents: 'none',
  }),
  summary: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '24px 4px',
    cursor: 'pointer',
    listStyle: 'none',
    fontFamily: "'Sora', sans-serif",
    fontSize: 18,
    fontWeight: 600,
    color: '#fff',
    letterSpacing: '-0.01em',
    transition: 'color 150ms var(--ease-out-expo)',
  },
  marker: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 16,
    color: 'rgba(235,235,245,0.30)',
    marginLeft: 16,
    transition: 'transform 200ms var(--ease-out-expo), color 200ms',
  },
  body: {
    padding: '0 4px 24px',
    maxWidth: '65ch',
    fontSize: 15,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.7,
  },
}

export default function FaqSection() {
  return (
    <section style={s.section} aria-labelledby="faq-title">
      <style>{`
        details > summary { list-style: none; }
        details > summary::-webkit-details-marker { display: none; }
        details[open] .faq-marker { transform: rotate(45deg); color: #fff; }
        details[open] .faq-huebar { opacity: 1 !important; transform: translateX(0) !important; }
        details:hover > summary { color: #fff; }
        details > summary:focus-visible { outline: 2px solid oklch(62% 0.19 210); outline-offset: 4px; border-radius: 4px; }
      `}</style>
      <span style={s.sectionNum} aria-hidden>§07</span>
      <div className="container">
        <header style={s.header}>
          <div style={s.eyebrow}>FAQ / 常见疑问</div>
          <h2 id="faq-title" style={s.title}>回答一些你可能在想的事。</h2>
        </header>

        <div style={s.list}>
          {faqs.map((f) => (
            <details key={f.q} style={s.item(f.hue)}>
              <span className="faq-huebar" style={s.hueBar(f.hue)} aria-hidden />
              <summary style={s.summary}>
                <span>{f.q}</span>
                <span className="faq-marker" style={s.marker}>+</span>
              </summary>
              <p style={s.body}>{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}
