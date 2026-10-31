import { GLOSSARY_LIBRARIES, GLOSSARY_SOURCE } from './glossary-data.js';

// CSV follows RFC 4180 quoting; whitespace outside quoted fields is trimmed.
function glossaryCsvRows(text) {
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else field += ch;
    } else if (ch === '"') {
      if (field.trim() || closed) throw new Error('CSV 引号格式错误');
      field = ''; quoted = true;
    } else if (ch === ',' || ch === '\n' || ch === '\r') {
      row.push(field.trim()); field = ''; closed = false;
      if (ch !== ',') { rows.push(row); row = []; if (ch === '\r' && text[i + 1] === '\n') i++; }
    } else {
      if (closed && !/\s/.test(ch)) throw new Error('CSV 引号后存在多余内容');
      field += ch;
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  if (field || row.length || closed) { row.push(field.trim()); rows.push(row); }
  return rows;
}

function firstUnquoted(value, needle) {
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') {
      if (quoted && value[index + 1] === '"') { index += 1; continue; }
      quoted = !quoted;
    } else if (!quoted && char === needle) return index;
  }
  return -1;
}

export function parseCustomTerms(text, defaultTarget = '*') {
  text = String(text || '').replace(/^﻿/, '');
  if (!text.trim()) return [];
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  const header = /^\s*source\s*,\s*target(?:\s*,|\s*$)/i.test(lines[0]);
  const equalsLines = lines.map(line => {
    const equal = firstUnquoted(line, '=');
    const comma = firstUnquoted(line, ',');
    const spacedEquals = equal > 0 && line[equal - 1] === ' ' && line[equal + 1] === ' ';
    return equal >= 0 && (comma < 0 || equal < comma || spacedEquals);
  });
  // Decide the format before parsing CSV: commas in the right-hand side of
  // `source = target` are ordinary text, not CSV delimiters.
  if (!header && equalsLines.every(Boolean)) {
    return lines.map((line, index) => {
      const separator = firstUnquoted(line, '=');
      const source = line.slice(0, separator).trim();
      if (!source) throw new Error(`第 ${index + 1} 行格式错误：原文不能为空`);
      return { source, target: line.slice(separator + 1).trim(), targetLanguage: defaultTarget || '*' };
    });
  }
  const rows = glossaryCsvRows(text); const entries = [];
  for (let i = 0; i < rows.length; i++) {
    let row = rows[i];
    if (row.every(v => !v.trim())) continue;
    if (i === 0 && row[0].toLowerCase() === 'source' && row[1]?.toLowerCase() === 'target') {
      if (row.length > 3 || (row[2] && row[2].toLowerCase() !== 'tgt_lng')) throw new Error('CSV 表头应为 source,target,tgt_lng');
      continue;
    }
    if (row.length === 1) {
      const pos = row[0].indexOf('=');
      if (pos < 0) throw new Error(`第 ${i + 1} 行格式错误：请使用原文 = 译文或 CSV`);
      row = [row[0].slice(0, pos).trim(), row[0].slice(pos + 1).trim()];
    }
    if (row.length < 2 || row.length > 3 || !row[0].trim()) throw new Error(`第 ${i + 1} 行格式错误：需要原文、译文和可选目标语言`);
    const unescapeSpreadsheetCell = value => value.startsWith("'") && /^[\s﻿]*[=+@-]/.test(value.slice(1)) ? value.slice(1) : value;
    entries.push({ source: unescapeSpreadsheetCell(row[0].trim()), target: unescapeSpreadsheetCell(row[1].trim()), targetLanguage: (row[2] || defaultTarget || '*').trim() || '*' });
  }
  return entries;
}

export function serializeGlossaryCsv(entries) {
  const quote = value => {
    let text = String(value ?? '');
    // Prevent spreadsheet formula execution while retaining ordinary CSV text.
    // Import removes exactly this safety prefix before restoring the term.
    if (/^[\s﻿]*[=+@]/.test(text) || /^[\s﻿]*-[\d=+@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }
  return ['source,target,tgt_lng', ...entries.map(e => [e.source, e.target, e.targetLanguage || '*'].map(quote).join(','))].join('\n');
}

export function normalizeGlossarySettings(raw, legacyText = '', target = 'zh-CN') {
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: raw.enabled !== false,
    machineTranslation: raw.machineTranslation === true,
    libraryIds: Array.isArray(raw.libraryIds) ? [...new Set(raw.libraryIds.filter(id => GLOSSARY_LIBRARIES.some(library => library.id === id)))] : [],
    customTerms: typeof raw.customTerms === 'string' ? raw.customTerms : (typeof legacyText === 'string' ? legacyText : ''),
    customTargetLanguage: typeof raw.customTargetLanguage === 'string' && raw.customTargetLanguage.trim() ? raw.customTargetLanguage.trim() : '*'
  };
}

function glossaryLanguage(value) { return String(value || '*').trim().toLowerCase().replace(/_/g, '-'); }
function glossaryUniversal(value) { return ['*', 'auto', ''].includes(glossaryLanguage(value)); }
export function resolveGlossary(settings, target) {
  const cfg = normalizeGlossarySettings(settings?.glossary, settings?.ai?.glossary, target);
  if (!cfg.enabled) return [];
  const wanted = glossaryLanguage(target); const chosen = new Map(); let order = 0;
  function add(entry, custom) {
    if (!entry || typeof entry.source !== 'string' || !entry.source.trim()) return;
    const lang = glossaryLanguage(entry.targetLanguage); const specific = !glossaryUniversal(lang);
    if (specific && lang !== wanted) return;
    const key = entry.source.trim().toLowerCase(); const score = (custom ? 2 : 0) + (specific ? 1 : 0);
    const previous = chosen.get(key);
    if (!previous || score > previous.score) chosen.set(key, { score, order: order++, entry: { source: entry.source.trim(), target: typeof entry.target === 'string' ? entry.target : '', targetLanguage: entry.targetLanguage || '*' } });
  }
  for (const id of cfg.libraryIds) {
    const library = GLOSSARY_LIBRARIES.find(item => item.id === id);
    if (library) for (const entry of library.entries) add(entry, false);
  }
  for (const entry of parseCustomTerms(cfg.customTerms, cfg.customTargetLanguage)) add(entry, true);
  return [...chosen.values()].sort ( (a,b) => a.order - b.order).map(item => item.entry);
}

export function glossarySalt(settings, target, isAI) {
  const cfg = normalizeGlossarySettings(settings?.glossary, settings?.ai?.glossary, target);
  if (!cfg.enabled || (!isAI && !cfg.machineTranslation)) return '';
  const entries = resolveGlossary(settings, target);
  return entries.length ? JSON.stringify([GLOSSARY_SOURCE.revision, target, entries]) : '';
}

// Case-insensitive Unicode matching, longest first. Latin/digit/underscore terms have
// word boundaries; CJK and other scripts without spaces can match inside sentences.
// Existing privacy and glossary markers are never scanned as ordinary text.
const GLOSSARY_RESERVED = /__\s*OT_(?:PRIVATE|GLOSSARY)\s*_[A-Za-z0-9_\s-]*?__/gi;
const GLOSSARY_WORD = /[\p{Script=Latin}\p{N}_]/u;
function glossarySpans(text, entries) {
  text = String(text); const blocked = [...text.matchAll(GLOSSARY_RESERVED)].map(m => [m.index, m.index + m[0].length]);
  const occupied = []; const matches = [];
  const candidates = entries.map((entry, index) => ({entry, index})).filter(x => x.entry && typeof x.entry.source === 'string' && x.entry.source.length).sort((a,b) => b.entry.source.length - a.entry.source.length || a.index - b.index);
  for (const {entry} of candidates) {
    const escaped = entry.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'giu'); let match;
    while ((match = re.exec(text))) {
      const start = match.index, end = start + match[0].length;
      const first = Array.from(entry.source)[0], last = Array.from(entry.source).at(-1);
      const before = Array.from(text.slice(0, start)).at(-1), after = Array.from(text.slice(end))[0];
      if ((GLOSSARY_WORD.test(first) && before && GLOSSARY_WORD.test(before)) || (GLOSSARY_WORD.test(last) && after && GLOSSARY_WORD.test(after))) continue;
      if ([...blocked, ...occupied].some(([a,b]) => start < b && end > a)) continue;
      occupied.push([start,end]); matches.push({start,end,entry, original: match[0]});
    }
  }
  return matches.sort((a,b) => a.start - b.start);
}
export function matchGlossary(texts, entries) {
  const found = new Set();
  for (const text of texts) for (const span of glossarySpans(text, entries)) found.add(span.entry);
  return entries.filter(entry => found.has(entry));
}
export function formatGlossary(texts, entries) {
  const matches = matchGlossary(texts, entries);
  return matches.length ? JSON.stringify(matches.map(e => ({source: e.source, target: e.target || e.source}))) : '';
}
export function protectGlossary(texts, entries) {
  const originals = texts.map(String); let nonce;
  do { nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); } while (originals.some(t => t.toLowerCase().includes(`__ot_glossary_${nonce}_`)));
  const maps = [];
  const safe = originals.map((text, segment) => {
    const spans = glossarySpans(text, entries); let result = '', offset = 0; const map = [];
    for (const span of spans) {
      const token = `__OT_GLOSSARY_${nonce}_${segment}_${map.length}__`;
      map.push({ token, value: span.entry.target || span.original }); result += text.slice(offset, span.start) + token; offset = span.end;
    }
    maps.push(map); return result + text.slice(offset);
  });
  return { safe, restore(output, index) {
    let text = String(output); const map = maps[index];
    if (!map) return { text, valid: false };
    for (const item of map) if (text.split(item.token).length !== 2) return { text, valid: false };
    // Reject introduced or cross-segment tokens; never replace arbitrary translator output.
    const tokens = [...text.matchAll(new RegExp(`__OT_GLOSSARY_${nonce}_[0-9]+_[0-9]+__`, 'g'))];
    if (tokens.length !== map.length || tokens.some(m => !map.some(item => item.token === m[0]))) return { text, valid: false };
    for (const item of map) text = text.replace(item.token, () => item.value);
    return { text, valid: true };
  }};
}
