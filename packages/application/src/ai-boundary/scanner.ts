export const REMOVED_MARKER = "[removed]";

export interface ScanResult {
  /** Names of D4 patterns found. Never the matched text. */
  d4: string[];
  /** Spans of D3 text to remove. */
  d3Spans: Array<{ start: number; end: number }>;
}

const D4_PATTERNS: Array<[string, RegExp]> = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["api_key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["national_id", /\bGHA-\d{9}-\d\b/i],
  ["password", /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i],
];

const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Deliberately small: a backstop, not a classifier (spec §14.2). */
const D3_PATTERNS: RegExp[] = [
  /\b(?:diagnosed with|diagnosis of|prescribed|prescription for)\b[^.\n]{0,80}/gi,
  /\b(?:HIV|AIDS|tuberculosis|hepatitis [BC]|psychiatric|mental health condition)\b/gi,
];

export function scanText(text: string): ScanResult {
  const d4 = D4_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    const digits = match[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      d4.push("card_number");
      break;
    }
  }
  const d3Spans: ScanResult["d3Spans"] = [];
  for (const re of D3_PATTERNS) {
    for (const match of text.matchAll(re)) d3Spans.push({ start: match.index!, end: match.index! + match[0].length });
  }
  return { d4, d3Spans };
}

export function removeSpans(text: string, spans: ScanResult["d3Spans"]): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: ScanResult["d3Spans"] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  let out = "";
  let cursor = 0;
  for (const { start, end } of merged) {
    out += text.slice(cursor, start) + REMOVED_MARKER;
    cursor = end;
  }
  return out + text.slice(cursor);
}
