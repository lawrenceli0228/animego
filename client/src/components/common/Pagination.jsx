const btn = (disabled) => ({
  padding: '8px 20px',
  borderRadius: 8,
  border: '1px solid',
  borderColor: disabled ? 'rgba(148,163,184,0.15)' : 'rgba(124,58,237,0.5)',
  color: disabled ? '#64748b' : '#f1f5f9',
  background: disabled ? 'transparent' : 'rgba(124,58,237,0.15)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontFamily: "'Sora', sans-serif",
  fontSize: 14, fontWeight: 600,
  transition: 'all 0.2s'
})

export default function Pagination({ page, totalPages, onPageChange }) {
  if (!totalPages || totalPages <= 1) return null
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:16, padding:'32px 0' }}>
      <button style={btn(page <= 1)} disabled={page <= 1} onClick={() => onPageChange(page - 1)}>← 上一页</button>
      <span style={{ color:'#94a3b8', fontSize:14, fontFamily:"'Sora',sans-serif" }}>
        <span style={{ color:'#f1f5f9', fontWeight:700 }}>{page}</span>
        {' / '}{totalPages}
      </span>
      <button style={btn(page >= totalPages)} disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>下一页 →</button>
    </div>
  )
}
