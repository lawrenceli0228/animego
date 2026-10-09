"use client";

// The site's report flow (components/safety/ReportDialog) for a review,
// thread or reply, loaded when it is first needed.
//
// next/dynamic with ssr:false rather than a static import: ReportDialog pulls
// react-hot-toast, which touches `document` at import time and would make
// every component that shows a 举报 link unimportable from a bun test (see
// testImportHygiene.test.ts), and it is the router-bound half of a list that
// is otherwise plain markup. Nothing about it needs to be in the cached HTML.

import dynamic from "next/dynamic";

const ReportDialog = dynamic(() => import("@/components/safety/ReportDialog"), { ssr: false });

export type CommunityReportTarget = "review" | "thread" | "reply";

export default function ReportButton({
  targetType,
  targetId,
  authenticated,
}: {
  targetType: CommunityReportTarget;
  targetId: string;
  authenticated: boolean;
}) {
  return <ReportDialog targetType={targetType} targetId={targetId} authenticated={authenticated} />;
}
