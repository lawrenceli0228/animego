// The small pieces every card view shares: the score with its face, and the
// genre pills in the show's colour.

import { scoreBand } from "@/components/anime/scoreStyle";
import { scoreText } from "@/lib/seasonal/display";
import { FaceIcon } from "./icons";
import cards from "./cards.module.css";

interface ScoreProps {
  /** 0–100, or null for an unrated show. */
  score: number | null;
  /** Shown in place of the number when there is none (the table's "—"). */
  placeholder?: string;
  /** The chart card's smaller size on a phone. */
  inChart?: boolean;
}

/** Green / amber / red by the site's bands (scoreStyle.ts), with the face to match. */
export function Score({ score, placeholder, inChart = false }: ScoreProps) {
  const text = scoreText(score);
  if (!text && placeholder === undefined) return null;
  return (
    <span className={inChart ? `${cards.score} ${cards.scoreChart}` : cards.score} data-band={score ? scoreBand(score) : undefined}>
      <FaceIcon className={cards.face} />
      {text ?? placeholder}
    </span>
  );
}

interface PillsProps {
  labels: readonly string[];
  /** The show's tone: the pill's ground. */
  tone: string;
  /** Its darkest step: the pill's text. */
  onTone: string;
  small?: boolean;
  /** One line that clips rather than wraps. */
  inline?: boolean;
  /** Only the first two on a phone. */
  twoOnPhone?: boolean;
  className?: string;
}

export function Pills({ labels, tone, onTone, small, inline, twoOnPhone, className }: PillsProps) {
  if (labels.length === 0) return null;
  const cls = [
    cards.pills,
    small ? cards.pillsSm : "",
    inline ? cards.pillsInline : "",
    twoOnPhone ? cards.pillsTwo : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
      {labels.map((label) => (
        <span key={label} className={cards.pill} style={{ background: tone, color: onTone }}>
          {label}
        </span>
      ))}
    </div>
  );
}
