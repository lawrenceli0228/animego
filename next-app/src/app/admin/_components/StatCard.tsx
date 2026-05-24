interface StatCardProps {
  label: string;
  value: number | string;
  hint?: string;
}

export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <div style={styles.card}>
      <div style={styles.label}>{label}</div>
      <div style={styles.value}>
        {typeof value === "number" ? value.toLocaleString("zh-CN") : value}
      </div>
      {hint ? <div style={styles.hint}>{hint}</div> : null}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    padding: "20px 22px",
    background: "#15151f",
    border: "1px solid #1f1f2a",
    borderRadius: 10,
  },
  label: {
    fontSize: 12,
    color: "#9090a0",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  value: {
    fontSize: 28,
    fontWeight: 600,
    color: "#f4f4f8",
    fontFeatureSettings: '"tnum"',
  },
  hint: {
    marginTop: 6,
    fontSize: 12,
    color: "#7c7c8c",
  },
};
