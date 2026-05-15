const btn = (disabled) => ({
  padding: '8px 20px',
  borderRadius: 8,
  border: `1px solid ${disabled ? 'rgba(84,84,88,0.30)' : 'rgba(84,84,88,0.65)'}`,
  color: disabled ? 'rgba(235,235,245,0.18)' : '#ffffff',
  background: disabled ? 'transparent' : 'rgba(120,120,128,0.12)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontFamily: "'DM Sans', sans-serif",
  fontSize: 14, fontWeight: 500,
  transition: 'all 0.2s'
})

export default function Pagination({ page, totalPages, onPageChange }) {
  if (!totalPages || totalPages <= 1) return null
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:16, padding:'32px 0' }}>
      <button style={btn(page <= 1)} disabled={page <= 1} onClick={() => onPageChange(page - 1)}>← 上一页</button>
      <span style={{ color:'rgba(235,235,245,0.60)', fontSize:14, fontFamily:"'Sora',sans-serif" }}>
        <span style={{ color:'#ffffff', fontWeight:700 }}>{page}</span>
        {' / '}{totalPages}
      </span>
      <button style={btn(page >= totalPages)} disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>下一页 →</button>
    </div>
  )
}
