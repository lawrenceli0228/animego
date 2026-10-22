// Keeps a saved setting in step with the last value asked for, one request at
// a time. For a switch that saves the moment it is flipped: a flip made while
// a save is out is not dropped (the switch would snap back) and does not race
// it (the slower answer would win); it is sent when the first one settles.
// Only the final answer is reported, so a toast never says 已保存 about a
// value the page no longer shows.
//
// Pure apart from the `send` it is given: no React, no DOM.

/** What a save attempt came back with: an empty `error` when it worked. */
export interface SendResult {
  ok: boolean;
  error: string;
}

export interface LatestWinsOptions<T> {
  /** What the server holds to begin with. */
  saved: T;
  send: (value: T) => Promise<SendResult>;
  /** True while requests are out, false once the last one has settled. */
  onBusy?: (busy: boolean) => void;
  /** Everything asked for is saved; `value` is what the server now holds. */
  onSaved: (value: T) => void;
  /** A save failed. Later asks are dropped; `value` is what the server still holds. */
  onFailed: (value: T, error: string) => void;
}

export interface LatestWins<T> {
  /** Ask for `value`. Saves it unless it is what the server already holds. */
  want: (value: T) => void;
}

export function latestWins<T>({ saved, send, onBusy, onSaved, onFailed }: LatestWinsOptions<T>): LatestWins<T> {
  let held = saved;
  let wanted = saved;
  let running = false;

  const run = async () => {
    running = true;
    onBusy?.(true);
    let error: string | null = null;
    while (wanted !== held) {
      const target = wanted;
      let result: SendResult;
      try {
        result = await send(target);
      } catch (thrown) {
        result = { ok: false, error: thrown instanceof Error ? thrown.message : String(thrown) };
      }
      if (!result.ok) {
        error = result.error;
        wanted = held;
        break;
      }
      held = target;
    }
    running = false;
    onBusy?.(false);
    if (error === null) onSaved(held);
    else onFailed(held, error);
  };

  return {
    want(value: T) {
      wanted = value;
      if (running || wanted === held) return;
      void run();
    },
  };
}
