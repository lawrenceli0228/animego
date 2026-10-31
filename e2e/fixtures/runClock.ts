// The time this test run started: the same number in every worker and in
// every retry.
//
// A spec that seeds times relative to "now" and computes them as its module
// loads gets a different "now" in each worker, and a retry is a new worker.
// The pages it reads are cached for minutes, so a retry would re-seed rows
// with other times while the page still answers with the first attempt's,
// and fail on that difference instead of on whatever failed first.
//
// globalSetup records the start in the main process; workers inherit the
// environment. A run without globalSetup falls back to this worker's load.

export const RUN_STARTED_AT_ENV = "E2E_RUN_STARTED_AT";

const fallback = Date.now();

export function runStartedAt(): number {
  const recorded = Number(process.env[RUN_STARTED_AT_ENV]);
  return Number.isFinite(recorded) && recorded > 0 ? recorded : fallback;
}
