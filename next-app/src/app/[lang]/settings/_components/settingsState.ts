function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/** Read both legacy `{error:string}` and standard `{error:{message}}` bodies. */
export function settingsErrorMessage(
  value: unknown,
  fallback = "保存失败",
): string {
  const body = record(value);
  if (!body) return fallback;
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  const nested = record(body.error);
  if (typeof nested?.message === "string" && nested.message.trim()) {
    return nested.message;
  }
  if (typeof body.message === "string" && body.message.trim()) return body.message;
  return fallback;
}
