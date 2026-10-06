// The tab ↔ panel id wiring. The schedule board renders once per page, so
// fixed ids are enough, and they are identical on the server and the client —
// which the aria-controls / aria-labelledby pairs need to resolve at all.

export const tabId = (index: number) => `schedule-tab-${index}`;
export const panelId = (index: number) => `schedule-panel-${index}`;
