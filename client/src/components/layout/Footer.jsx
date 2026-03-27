export default function Footer() {
  return (
    <footer style={{
      borderTop: '1px solid rgba(148,163,184,0.08)',
      padding: '24px',
      textAlign: 'center',
      color: 'rgba(235,235,245,0.30)',
      fontSize: 13,
      fontFamily: "'DM Sans', sans-serif",
      marginTop: 'auto'
    }}>
      © 2025 AnimeGo · 数据来自{' '}
      <a href="https://anilist.co" target="_blank" rel="noreferrer"
        style={{ color: '#0a84ff' }}>AniList</a>
    </footer>
  )
}
