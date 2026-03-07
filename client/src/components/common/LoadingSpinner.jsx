const s = {
  wrap: { display:'flex', justifyContent:'center', alignItems:'center', padding:'60px 0' },
  spinner: {
    width: 44, height: 44,
    border: '3px solid rgba(124,58,237,0.2)',
    borderTop: '3px solid #7c3aed',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite'
  }
}
export default function LoadingSpinner() {
  return <div style={s.wrap}><div style={s.spinner} /></div>
}
