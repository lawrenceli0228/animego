import { Link } from 'react-router-dom'
import { useLang } from '../../context/LanguageContext'

const s = {
  footer: {
    borderTop: '1px solid rgba(84,84,88,0.65)',
    background: '#000',
    padding: '48px 24px 32px',
  },
  inner: {
    maxWidth: 1400, margin: '0 auto',
  },
  columns: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 32,
  },
  colTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 14, fontWeight: 600,
    color: '#fff',
    marginBottom: 16,
    letterSpacing: '-0.02em',
  },
  siteDesc: {
    fontSize: 13,
    color: 'rgba(235,235,245,0.30)',
    lineHeight: 1.5,
    marginBottom: 16,
    maxWidth: 220,
  },
  linkList: {
    listStyle: 'none', padding: 0, margin: 0,
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  link: {
    fontSize: 13, fontWeight: 400,
    color: 'rgba(235,235,245,0.60)',
    textDecoration: 'none',
    transition: 'color 150ms ease-out',
  },
  bottom: {
    marginTop: 40,
    paddingTop: 24,
    borderTop: '1px solid rgba(84,84,88,0.35)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
  },
  copyright: {
    fontSize: 12,
    color: 'rgba(235,235,245,0.30)',
    fontFamily: "'DM Sans', sans-serif",
  },
  credits: {
    fontSize: 12,
    color: 'rgba(235,235,245,0.30)',
    fontFamily: "'DM Sans', sans-serif",
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  creditLink: {
    color: 'rgba(235,235,245,0.60)',
    textDecoration: 'none',
    transition: 'color 150ms ease-out',
  },
  dot: {
    color: 'rgba(235,235,245,0.18)',
  },
}

export default function Footer() {
  const { t } = useLang()
  const year = new Date().getFullYear()

  const browseLinks = [
    { to: '/season', label: t('footer.seasonal') },
    { to: '/', label: t('footer.trending') },
    { to: '/search', label: t('footer.search') },
    { label: t('footer.topRated') },
    { label: t('footer.upcoming') },
  ]

  const socialLinks = [
    { href: 'https://github.com/lawrenceli0228/animego', label: t('footer.github') },
    { href: '#', label: t('footer.twitter') },
    { href: '#', label: t('footer.discord') },
    { href: '#', label: t('footer.telegram') },
  ]

  const supportLinks = [
    { label: t('footer.faq') },
    { label: t('footer.contact') },
    { label: t('footer.feedback') },
    { label: t('footer.api') },
    { label: t('footer.terms') },
    { label: t('footer.privacy') },
  ]

  return (
    <footer style={s.footer}>
      <div style={s.inner}>
        <div style={s.columns}>
          {/* Site column */}
          <div>
            <div style={s.colTitle}>{t('footer.siteCol')}</div>
            <p style={s.siteDesc}>{t('footer.siteDesc')}</p>
            <ul style={s.linkList}>
              <li><Link to="/about" style={s.link} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>{t('nav.about')}</Link></li>
              <li><a href="#" style={s.link} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>{t('footer.donate')}</a></li>
              <li><a href="#" style={s.link} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>{t('footer.apps')}</a></li>
              <li><a href="#" style={s.link} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>{t('footer.siteStats')}</a></li>
              <li><a href="#" style={s.link} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>{t('footer.recommendations')}</a></li>
            </ul>
          </div>

          {/* Browse column */}
          <div>
            <div style={s.colTitle}>{t('footer.browseCol')}</div>
            <ul style={s.linkList}>
              {browseLinks.map(({ to, href, label }) => (
                <li key={label}>
                  {to ? (
                    <Link to={to} style={s.link} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>{label}</Link>
                  ) : (
                    <a href={href || '#'} style={s.link} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>{label}</a>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {/* Social column */}
          <div>
            <div style={s.colTitle}>{t('footer.socialCol')}</div>
            <ul style={s.linkList}>
              {socialLinks.map(({ href, label }) => (
                <li key={label}>
                  <a href={href} target="_blank" rel="noreferrer" style={s.link}
                    onMouseEnter={hoverIn} onMouseLeave={hoverOut}>{label}</a>
                </li>
              ))}
            </ul>
          </div>

          {/* Support column */}
          <div>
            <div style={s.colTitle}>{t('footer.supportCol')}</div>
            <ul style={s.linkList}>
              {supportLinks.map(({ label }) => (
                <li key={label}>
                  <a href="#" style={s.link} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>{label}</a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div style={s.bottom}>
          <span style={s.copyright}>
            {t('footer.copyright').replace('{year}', year)}
          </span>
          <span style={s.credits}>
            {t('footer.dataCredits')}
            <a href="https://anilist.co" target="_blank" rel="noreferrer"
              style={s.creditLink} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>AniList</a>
            <span style={s.dot}>&middot;</span>
            <a href="https://bgm.tv" target="_blank" rel="noreferrer"
              style={s.creditLink} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>Bangumi</a>
          </span>
        </div>
      </div>
    </footer>
  )
}

function hoverIn(e) { e.currentTarget.style.color = '#fff' }
function hoverOut(e) { e.currentTarget.style.color = 'rgba(235,235,245,0.60)' }
