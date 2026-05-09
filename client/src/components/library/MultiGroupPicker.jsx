// @ts-check
import { mono, PLAYER_HUE } from '../shared/hud-tokens';

/** @typedef {import('../../lib/library/types').Group} Group */

const HUE = PLAYER_HUE.ingest;

const s = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    background: `oklch(14% 0.04 ${HUE} / 0.55)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.40)`,
    borderRadius: 4,
    cursor: 'pointer',
    textAlign: 'left',
    color: '#fff',
    transition: 'background 150ms ease-out',
  },
  label: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 600,
    fontSize: 14,
    color: '#fff',
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  count: {
    ...mono,
    fontSize: 11,
    color: `oklch(72% 0.15 ${HUE} / 0.85)`,
  },
  badge: {
    ...mono,
    fontSize: 10,
    padding: '2px 6px',
    background: `oklch(62% 0.17 40 / 0.25)`,
    border: `1px solid oklch(62% 0.17 40 / 0.50)`,
    color: `oklch(72% 0.15 40)`,
    borderRadius: 2,
    textTransform: 'uppercase',
    letterSpacing: '0.10em',
  },
  sortBadge: {
    ...mono,
    fontSize: 10,
    padding: '2px 6px',
    background: `oklch(62% 0.17 ${HUE} / 0.20)`,
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.35)`,
    color: `oklch(72% 0.15 ${HUE})`,
    borderRadius: 2,
    textTransform: 'uppercase',
    letterSpacing: '0.10em',
  },
  pickAll: {
    ...mono,
    marginTop: 4,
    padding: '8px 16px',
    background: 'none',
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.40)`,
    borderRadius: 4,
    color: `oklch(72% 0.15 ${HUE})`,
    cursor: 'pointer',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    alignSelf: 'flex-start',
  },
};

/**
 * MultiGroupPicker — renders a list of group cards for multi-folder selection.
 * Renders nothing when groups.length <= 1.
 *
 * @param {{
 *   groups: Group[],
 *   onPick: (group: Group) => void,
 *   onPickAll?: () => void,
 * }} props
 */
export default function MultiGroupPicker({ groups, onPick, onPickAll }) {
  if (!groups || groups.length <= 1) return null;

  return (
    <div style={s.container}>
      {groups.map((group) => (
        <button
          key={group.id}
          style={s.card}
          onClick={() => onPick(group)}
          type="button"
        >
          <span style={s.label}>{group.label}</span>
          <span style={s.meta}>
            <span style={s.count}>{group.items.length}</span>
            <span style={s.sortBadge}>{group.sortMode}</span>
            {group.hasAmbiguity && (
              <span
                style={s.badge}
                data-testid={`ambiguity-badge-${group.id}`}
              >
                !
              </span>
            )}
          </span>
        </button>
      ))}
      {onPickAll && (
        <button style={s.pickAll} onClick={onPickAll} type="button" aria-label="Pick all">
          Pick all
        </button>
      )}
    </div>
  );
}
