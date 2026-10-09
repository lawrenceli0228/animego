// Labels the hero and the overview's information table both print.

import type { Dict } from "@/lib/i18n";

export function statusLabel(dict: Dict, status: string | null): string {
  if (!status) return "";
  const map: Record<string, string> = {
    RELEASING: dict.detail.releasing,
    FINISHED: dict.detail.finished,
    NOT_YET_RELEASED: dict.detail.notYetReleased,
    CANCELLED: dict.detail.cancelled,
  };
  return map[status] ?? status;
}

export function seasonLabel(dict: Dict, season: string | null): string | null {
  if (!season) return null;
  const seasons = dict.season as unknown as Record<string, string>;
  return seasons[season] ?? season;
}
