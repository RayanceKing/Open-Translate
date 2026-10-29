// Local, best-effort redaction of secrets before any text leaves the browser.
// Values are swapped for stable placeholders and restored after translation.

const PATTERNS = [
  // e-mail
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  // phone numbers (8-16 digits with optional separators)
  /\b(?:\+?\d[\s-]?){8,16}\b/g,
  // well-known API key shapes
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|xox[abp]-[A-Za-z0-9-]{10,})\b/g
];

export function maskText(text) {
  const values = [];
  const put = value => `__OT_PRIVATE_${values.push(value) - 1}__`;
  let safe = String(text);
  for (const pattern of PATTERNS) safe = safe.replace(pattern, put);
  return {
    safe,
    restore: output => String(output).replace(/__\s*OT_PRIVATE\s*_(\d+)\s*__/gi, (whole, index) => values[Number(index)] ?? whole)
  };
}

export function maskAll(texts) {
  const values = [];
  const put = value => `__OT_PRIVATE_${values.push(value) - 1}__`;
  const safe = texts.map(text => {
    let output = String(text);
    for (const pattern of PATTERNS) output = output.replace(pattern, put);
    return output;
  });
  return {
    safe,
    restore: output => String(output).replace(/__\s*OT_PRIVATE\s*_(\d+)\s*__/gi, (whole, index) => values[Number(index)] ?? whole)
  };
}
