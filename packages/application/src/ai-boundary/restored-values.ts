import type { PlaceholderMap } from "./placeholders.js";

const MIN_FORM_LENGTH = 3;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive match of a form on Unicode word boundaries, so "Esi" does not match inside "design". */
const containsForm = (text: string, form: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(form).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu").test(text);

const EMAIL_LIKE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const WHOLE_EMAIL = new RegExp(`^${EMAIL_LIKE.source}$`, "u");
const HEADER = /^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/;

/** Lowercased, with a "+tag" dropped from the local part, so "Ama+news@X.com" and "ama@x.com" compare equal. */
function normaliseEmail(address: string): string {
  const at = address.lastIndexOf("@");
  // Leading punctuation is not part of the address ("_ama@x.com_", "-ama@x.com"), so it is stripped before the "+tag".
  const local = address.slice(0, at).replace(/^[._%+-]+/, "").split("+")[0];
  return `${local}@${address.slice(at + 1)}`.toLowerCase();
}

const emailsIn = (text: string): Set<string> => new Set((text.match(EMAIL_LIKE) ?? []).map(normaliseEmail));

interface Forms {
  /** Matched as text on word boundaries. */
  texts: string[];
  /** Matched as normalised email addresses. */
  emails: string[];
}

/** Every form the map restored for one entry (final review C1, follow-up F1). */
function formsOf(entity: { type: string; id: string }, display: string): Forms {
  const forms: Forms = { texts: [], emails: [] };
  const add = (form: string): void => {
    if (form.length < MIN_FORM_LENGTH) return;
    if (WHOLE_EMAIL.test(form)) forms.emails.push(normaliseEmail(form));
    else forms.texts.push(form);
  };
  add(display);
  if (entity.type.toLowerCase() === "person") {
    add(entity.id);
    const header = HEADER.exec(display);
    if (header) {
      add(normaliseEmail(header[2]));
      const name = header[1].trim().replace(/^"(.*)"$/, "$1").trim();
      if (name.length >= MIN_FORM_LENGTH && !/^\d+$/.test(name)) forms.texts.push(name);
    }
  }
  return forms;
}

/**
 * The token of the first entry in the map whose real value, in any form, appears in `text` and was not typed by the person
 * (`exemptText`), or null. Forms: the display string; a person's id (the bare address); the name part of a "Name <addr>"
 * display; and email addresses compared in normalised form. Exemption applies per form: a form the person typed (`exemptText`)
 * is exempt, and a non-address form that also appears in Oneon-authored text (`authoredText`: instructions, tool catalog,
 * salutation) is exempt too. An address is exempt only if the person typed it. Returns only the token, never the
 * matched text. A value transformed beyond these forms (a translated or reformatted name) is not detected.
 */
export function findRestoredValue(text: string, map: PlaceholderMap, exemptText = "", authoredText = ""): { token: string } | null {
  const textEmails = emailsIn(text);
  const exemptEmails = emailsIn(exemptText);
  for (const { token, entity, display } of map.entries()) {
    const forms = formsOf(entity, display);
    if (forms.texts.some((f) => containsForm(text, f) && !containsForm(exemptText, f) && !containsForm(authoredText, f))) return { token };
    if (forms.emails.some((e) => textEmails.has(e) && !exemptEmails.has(e))) return { token };
  }
  return null;
}
