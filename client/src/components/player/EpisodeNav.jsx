const s = {
  container: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: 8, padding: '16px 0', overflowX: 'auto',
    flexWrap: 'wrap',
  },
  btn: (active) => ({
    padding: '8px 16px', borderRadius: 8, border: 'none',
    background: active ? '#0a84ff' : 'rgba(120,120,128,0.12)',
    color: active ? '#fff' : 'rgba(235,235,245,0.60)',
    fontSize: 14, fontWeight: active ? 600 : 500,
    cursor: active ? 'default' : 'pointer',
    transition: 'all 150ms',
    flexShrink: 0,
  }),
};

export default function EpisodeNav({ episodes, currentEpisode, onSelect }) {
  return (
    <div style={s.container}>
      {episodes.map((ep) => (
        <button
          key={ep}
          style={s.btn(ep === currentEpisode)}
          onClick={() => ep !== currentEpisode && onSelect(ep)}
        >
          EP{String(ep).padStart(2, '0')}
        </button>
      ))}
    </div>
  );
}
