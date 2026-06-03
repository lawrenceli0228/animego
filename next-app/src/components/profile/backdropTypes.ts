// Shared option shape for choosing the profile's cinematic backdrop anime.
export interface BackdropOption {
  anilistId: number;
  title: string;
  /** Portrait cover — picker thumbnail + the card face. */
  coverUrl: string | null;
  /** Wide landscape banner — the cinematic page backdrop. */
  bannerUrl: string | null;
}
