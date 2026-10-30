// /year/[year] — retired. A year's page is now its ranking, /top/[year]; the
// old address (and any ?page=N of its old paginated listing) answers 308
// there, so search engines move the page rather than drop it.
//
// A year with nothing ranked has no ranking page, so its old page is a 404
// here too rather than a redirect to one.
//
// No loading.tsx: a streamed response could answer neither 308 nor 404.

import { notFound, permanentRedirect } from "next/navigation";
import { yearPath } from "@/lib/hubs/paths";
import { localizePath } from "@/lib/i18n/locale";
import { resolveLocale } from "@/lib/i18n/route";
import { fetchTopRows, fetchTopYears } from "@/lib/top/fetch";
import { NO_FILTERS } from "@/lib/top/query";
import { isRankedYear, parseTopYear } from "@/lib/top/years";

// A literal: Next reads segment config statically.
export const revalidate = 300;

type Props = PageProps<"/[lang]/year/[year]">;

/** Whether `year` has a ranking page: by the list of years, or — that list lagging — by its ranking. */
async function hasRanking(year: number): Promise<boolean> {
  const years = await fetchTopYears();
  if (years === null || isRankedYear(years, year)) return true;
  return ((await fetchTopRows({ year, ...NO_FILTERS })) ?? []).length > 0;
}

export default async function LegacyYearPage({ params }: Props) {
  const year = parseTopYear((await params).year);
  if (year === null) notFound();
  const { locale } = await resolveLocale(params);
  if (!(await hasRanking(year))) notFound();
  permanentRedirect(localizePath(yearPath(year), locale));
}
