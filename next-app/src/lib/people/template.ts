// {{key}} templates, for client components.
//
// lib/i18n.ts has `fill`, but importing that module pulls both server
// dictionaries into a client chunk, so the two lines are restated here.

/** Replace every {{key}} in `template`. */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(String(value));
  }
  return out;
}

/**
 * The text either side of {{key}}, so a caller can put an element there — a
 * number in the mono face, inside a sentence in the sans one. A template
 * without the key is all "before".
 */
export function splitTemplate(template: string, key: string): [string, string] {
  const token = `{{${key}}}`;
  const at = template.indexOf(token);
  return at < 0 ? [template, ""] : [template.slice(0, at), template.slice(at + token.length)];
}
