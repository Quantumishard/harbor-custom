const REF_H = 720;
const MIN_SCALE = 0.2;
const MAX_SCALE = 6;
const MIN_FRAC = 0.02;
const MAX_FRAC = 0.22;
const SIGN_TAGS = /\\(?:pos|move|i?clip|p[1-9])/i;
const DIALOGUE_NAME = /^(?:default|dialogue|dialog|main|regular)$/i;
// A Matroska ASS header (mpv's `sub-ass-extradata`) carries the styles but not the
// dialogue events, so the dominant style has to be guessed from the style names.
const DIALOGUE_STYLE_NAME = /(?:^|[\s._-])(?:default|dialogue|dialog|main|regular)(?:\s*\d+)?$/i;
const SIGN_STYLE_NAME =
  /(?:^|[\s._-])(?:sign|signs|signage|title|song|lyrics?|credit|credits|note|notes|op|ed|opening|ending|insert|card)(?:$|[\s._-])/i;

export type AssStyle = { size: number; order: number };

type StyleChoice = { name: string; confident: boolean };

export type AssBaseFactorInfo = {
  factor: number;
  /** Dialogue events, or a conventional dialogue style name, picked the style. */
  confident: boolean;
};

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function matchSection(text: string, header: RegExp): string | null {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (header.test(lines[i].trim())) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.+\]\s*$/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

function matchInt(text: string, key: RegExp): number {
  const m = key.exec(text);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : 0;
}

function splitFields(line: string, colCount: number): string[] {
  if (colCount <= 0) return line.split(",");
  const parts: string[] = [];
  let rest = line;
  for (let i = 0; i < colCount - 1; i++) {
    const idx = rest.indexOf(",");
    if (idx < 0) {
      parts.push(rest);
      rest = "";
      continue;
    }
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  parts.push(rest);
  return parts;
}

function visibleLen(body: string): number {
  return body
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\[Nnh]/g, " ")
    .trim().length;
}

export function inferPlayResY(text: string): number {
  const ry = matchInt(text, /^PlayResY:\s*(\d+)/im);
  if (ry > 0) return ry;
  const rx = matchInt(text, /^PlayResX:\s*(\d+)/im);
  if (rx > 0) return rx === 1280 ? 1024 : Math.floor((rx * 3) / 4);
  return 288;
}

export function parseAssStyles(text: string): Map<string, AssStyle> {
  const styles = new Map<string, AssStyle>();
  const section = matchSection(text, /^\[v4\+? styles\]$/i);
  if (!section) return styles;
  let nameCol = -1;
  let sizeCol = -1;
  let order = 0;
  for (const line of section.split(/\r?\n/)) {
    const fmt = /^Format:\s*(.*)$/i.exec(line);
    if (fmt) {
      const cols = fmt[1].split(",").map((c) => c.trim().toLowerCase());
      nameCol = cols.indexOf("name");
      sizeCol = cols.indexOf("fontsize");
      continue;
    }
    const st = /^Style:\s*(.*)$/i.exec(line);
    if (!st || nameCol < 0 || sizeCol < 0) continue;
    const fields = st[1].split(",");
    const name = (fields[nameCol] ?? "").trim();
    const size = parseFloat((fields[sizeCol] ?? "").trim());
    if (!name || !Number.isFinite(size)) continue;
    const prev = styles.get(name);
    styles.set(name, { size, order: prev ? prev.order : order++ });
  }
  return styles;
}

function fallbackStyle(styles: Map<string, AssStyle>): StyleChoice {
  let exactDefault = "";
  let dialogue = "";
  let firstPositive = "";
  let first = "";
  for (const [name, st] of styles) {
    if (!first) first = name;
    if (!(st.size > 0)) continue;
    if (!firstPositive) firstPositive = name;
    // Keep preferring an exact "Default"; only when it is absent fall back to
    // a group-prefixed dialogue style instead of whatever style is listed first.
    if (/^default$/i.test(name)) {
      if (!exactDefault) exactDefault = name;
    } else if (!dialogue && DIALOGUE_STYLE_NAME.test(name) && !SIGN_STYLE_NAME.test(name)) {
      dialogue = name;
    }
  }
  if (exactDefault) return { name: exactDefault, confident: true };
  if (dialogue) return { name: dialogue, confident: true };
  return { name: firstPositive || first, confident: false };
}

function dominantDialogueChoice(text: string, styles: Map<string, AssStyle>): StyleChoice {
  const section = matchSection(text, /^\[events\]$/i);
  const tally = new Map<string, { count: number; chars: number }>();
  if (section) {
    let styleCol = -1;
    let textCol = -1;
    let colCount = 0;
    for (const line of section.split(/\r?\n/)) {
      const fmt = /^Format:\s*(.*)$/i.exec(line);
      if (fmt) {
        const cols = fmt[1].split(",").map((c) => c.trim().toLowerCase());
        colCount = cols.length;
        styleCol = cols.indexOf("style");
        textCol = cols.indexOf("text");
        continue;
      }
      const ev = /^Dialogue:\s*(.*)$/i.exec(line);
      if (!ev || styleCol < 0 || textCol < 0) continue;
      const fields = splitFields(ev[1], colCount);
      const name = (fields[styleCol] ?? "").trim();
      const body = fields[textCol] ?? "";
      if (SIGN_TAGS.test(body)) continue;
      if (!styles.has(name)) continue;
      const prev = tally.get(name) ?? { count: 0, chars: 0 };
      prev.count += 1;
      prev.chars += visibleLen(body);
      tally.set(name, prev);
    }
  }
  const names = [...tally.keys()];
  if (names.length > 0) {
    names.sort((a, b) => {
      const ta = tally.get(a) as { count: number; chars: number };
      const tb = tally.get(b) as { count: number; chars: number };
      if (tb.count !== ta.count) return tb.count - ta.count;
      if (tb.chars !== ta.chars) return tb.chars - ta.chars;
      const da = DIALOGUE_NAME.test(a) ? 1 : 0;
      const db = DIALOGUE_NAME.test(b) ? 1 : 0;
      if (db !== da) return db - da;
      return (styles.get(a)?.order ?? 0) - (styles.get(b)?.order ?? 0);
    });
    return { name: names[0], confident: true };
  }
  return fallbackStyle(styles);
}

export function dominantDialogueStyle(text: string, styles: Map<string, AssStyle>): string {
  return dominantDialogueChoice(text, styles).name;
}

export function computeAssBaseFactorInfo(text: string): AssBaseFactorInfo | null {
  const styles = parseAssStyles(text);
  if (styles.size === 0) return null;
  const ry = inferPlayResY(text);
  const choice = dominantDialogueChoice(text, styles);
  const style = styles.get(choice.name);
  if (!style || !(style.size > 0)) return null;
  const fdom = style.size;
  const frac = fdom / ry;
  if (frac < MIN_FRAC || frac > MAX_FRAC) return null;
  const factor = ry / (REF_H * fdom);
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return { factor, confident: choice.confident };
}

export function computeAssBaseFactor(text: string): number | null {
  return computeAssBaseFactorInfo(text)?.factor ?? null;
}

export function assScaleFromFactor(factor: number, targetFontSize: number): number {
  const target = Number.isFinite(targetFontSize) ? targetFontSize : 32;
  return clamp(factor * target, MIN_SCALE, MAX_SCALE);
}
