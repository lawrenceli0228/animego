/**
 * `warn` tints the card and its number amber. It is opt-in and the default is
 * byte-identical to the untinted card, so the overview grid — where every
 * number is a neutral fact — is unaffected.
 *
 * It exists because the drift block has two cards whose whole job is to be
 * read as a verdict rather than a measurement: a non-zero "synopses behind"
 * means rows are currently serving Simplified prose to Traditional readers.
 * Rendering that in the same grey as "users: 802" is what makes a dashboard
 * something people stop looking at.
 */
type StatTone = "default" | "warn";

interface StatCardProps {
  label: string;
  value: number | string;
  hint?: string;
  tone?: StatTone;
}

export function StatCard({ label, value, hint, tone = "default" }: StatCardProps) {
  const warn = tone === "warn";
  return (
    <div style={warn ? styles.cardWarn : styles.card}>
      <div style={styles.label}>{label}</div>
      <div style={warn ? styles.valueWarn : styles.value}>
        {typeof value === "number" ? value.toLocaleString("zh-CN") : value}
      </div>
      {hint ? <div style={styles.hint}>{hint}</div> : null}
    </div>
  );
}

const cardBase: React.CSSProperties = {
  padding: "20px 22px",
  background: "#15151f",
  border: "1px solid #1f1f2a",
  borderRadius: 10,
};

const valueBase: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 600,
  color: "#f4f4f8",
  fontFeatureSettings: '"tnum"',
};

const styles: Record<string, React.CSSProperties> = {
  card: cardBase,
  cardWarn: {
    ...cardBase,
    background: "#211705",
    border: "1px solid #ff9f0a",
  },
  label: {
    fontSize: 12,
    color: "#9090a0",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  value: valueBase,
  valueWarn: { ...valueBase, color: "#ffb967" },
  hint: {
    marginTop: 6,
    fontSize: 12,
    color: "#7c7c8c",
  },
};
