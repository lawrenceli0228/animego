const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export interface TrailerWireValue {
  id: string | null;
  site: string | null;
}

export interface YouTubeTrailer {
  id: string;
  site: "youtube";
}

/**
 * Keep every YouTube URL builder behind the same validation boundary.
 *
 * The Go API already rejects malformed trailer pairs before they reach the
 * wire. This client-side guard is still useful during mixed-version deploys:
 * a trailer id is interpolated into an iframe URL, so an older or hand-built
 * response should fail closed instead of becoming navigation markup.
 */
export function asYouTubeTrailer(
  trailer: TrailerWireValue | null | undefined,
): YouTubeTrailer | null {
  if (
    !trailer?.id ||
    trailer.site?.toLowerCase() !== "youtube" ||
    !YOUTUBE_ID.test(trailer.id)
  ) {
    return null;
  }

  return { id: trailer.id, site: "youtube" };
}

export type YouTubeThumbnailQuality = "maxresdefault" | "hqdefault";

export function youtubeThumbnailUrl(
  id: string,
  quality: YouTubeThumbnailQuality = "maxresdefault",
): string {
  return `https://i.ytimg.com/vi/${id}/${quality}.jpg`;
}

export function youtubeEmbedUrl(id: string): string {
  const query = new URLSearchParams({
    autoplay: "1",
    rel: "0",
    playsinline: "1",
  });
  return `https://www.youtube-nocookie.com/embed/${id}?${query.toString()}`;
}

export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}
