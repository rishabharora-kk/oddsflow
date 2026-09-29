/**
 * Parse a Panta market title into a priced contract.
 *
 * Principle: if anything is ambiguous, return null. A wrong contract shows a
 * wrong probability; a null contract just shows nothing.
 */

export type Contract =
  | { kind: "close_above" | "close_below" | "touch_above" | "touch_below"; asset: string; strike: number; expiry: number }
  | { kind: "mcap_touch_above"; asset: string; mcap: number; expiry: number };

const ALIASES: Record<string, string> = {
  bitcoin: "BTC",
  btc: "BTC",
  ethereum: "ETH",
  eth: "ETH",
  solana: "SOL",
  sol: "SOL",
  zcash: "ZEC",
  zec: "ZEC",
  hyperliquid: "HYPE",
  hype: "HYPE",
};
const ALIAS_RE = new RegExp(`\\b(${Object.keys(ALIASES).join("|")})\\b`, "gi");

// Time-zone abbreviations that can appear in parentheses; never an asset.
const TZ_WORDS = new Set(["BST", "GMT", "UTC", "ET", "EST", "EDT", "CT", "CST", "CDT", "PT", "PST", "PDT"]);

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4,
  june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sept: 8, sep: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};
const MONTH_PAT = "(?:january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)";
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2, wednesday: 3, wed: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const WEEKDAY_PAT = "(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)";

// ---------------------------------------------------------------- assets

type AssetScan = { explicit: string[]; aliases: string[] };

function scanAssets(text: string): AssetScan {
  const explicit: string[] = [];
  for (const m of text.matchAll(/\(([A-Z][A-Z0-9.]{1,9})\)/g)) {
    if (!TZ_WORDS.has(m[1])) explicit.push(m[1]);
  }
  for (const m of text.matchAll(/\$([A-Za-z][A-Za-z0-9]{0,14})\b/g)) {
    explicit.push(m[1].toUpperCase());
  }
  const aliases: string[] = [];
  for (const m of text.matchAll(ALIAS_RE)) aliases.push(ALIASES[m[1].toLowerCase()]);
  return { explicit, aliases };
}

/** Spec order: (TICKER) first, then $TICKER, then alias. Returns null when a comparison of two assets is detected. */
function pickAsset(text: string): string | null {
  const parens: string[] = [];
  for (const m of text.matchAll(/\(([A-Z][A-Z0-9.]{1,9})\)/g)) {
    if (!TZ_WORDS.has(m[1])) parens.push(m[1]);
  }
  const dollars: string[] = [];
  for (const m of text.matchAll(/\$([A-Za-z][A-Za-z0-9]{0,14})\b/g)) dollars.push(m[1].toUpperCase());

  const { explicit, aliases } = scanAssets(text);
  const distinctExplicit = new Set(explicit);
  if (distinctExplicit.size > 1) return null; // two assets named: a relational market
  if (parens.length > 0) return parens[0];
  if (dollars.length > 0) return dollars[0];
  const distinctAliases = new Set(aliases);
  if (distinctAliases.size > 1) return null;
  return aliases.length > 0 ? aliases[0] : null;
}

// ---------------------------------------------------------------- money

const MULT: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
};

function findMoney(text: string): number[] {
  const out: number[] = [];
  const dollar = /\$\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(billion|million|thousand|bn|mn|b|m|k)\b)?/gi;
  for (const m of text.matchAll(dollar)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    out.push(n * (m[2] ? MULT[m[2].toLowerCase()] : 1));
  }
  // Bare "58k" (no dollar sign, not part of a larger token).
  const bare = /(?<![\w$.,])(\d+(?:\.\d+)?)k\b/gi;
  for (const m of text.matchAll(bare)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n * 1e3);
  }
  return out;
}

// ---------------------------------------------------------------- time zones

function fixedOffsetMinutes(tz: string): number | null {
  switch (tz.toUpperCase()) {
    case "BST": return 60;
    case "GMT":
    case "UTC": return 0;
    default: return null;
  }
}

const IANA: Record<string, string> = { ET: "America/New_York", CT: "America/Chicago", PT: "America/Los_Angeles" };

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Local wall-clock time in `tz` to unix ms. Null for unknown zones and for nonexistent/ambiguous (DST) local times. */
function localToUtcMs(y: number, mo: number, d: number, h: number, mi: number, tz: string): number | null {
  const fixed = fixedOffsetMinutes(tz);
  const wall = Date.UTC(y, mo, d, h, mi, 0);
  if (fixed !== null) return wall - fixed * 60_000;
  const zone = IANA[tz.toUpperCase()];
  if (!zone) return null;
  const DAY = 86_400_000;
  const offBefore = zoneOffsetMs(wall - DAY, zone);
  const offAfter = zoneOffsetMs(wall + DAY, zone);
  const candidates = new Set([wall - offBefore, wall - offAfter]);
  const valid: number[] = [];
  for (const utc of candidates) {
    if (zoneOffsetMs(utc, zone) + utc === wall) valid.push(utc);
  }
  return valid.length === 1 ? valid[0] : null;
}

// ---------------------------------------------------------------- dates

function validDate(y: number, mo: number, d: number): boolean {
  if (y < 2000 || y > 2200 || mo < 0 || mo > 11 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo && dt.getUTCDate() === d;
}

const endOfDayUtcSec = (y: number, mo: number, d: number) => Date.UTC(y, mo, d, 23, 59, 59) / 1000;

type DateHit = { expiry: number; exactTime: boolean };

/** All distinct dates found. The caller requires exactly one. */
function findDates(text: string): DateHit[] | "invalid" {
  const hits: DateHit[] = [];
  let invalid = false;

  // on [Weekday,] Month D, YYYY, at h[:mm] AM|PM TZ
  const exact = new RegExp(
    `\\bon\\s+(?:(${WEEKDAY_PAT})\\.?,?\\s+)?(${MONTH_PAT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4}),?\\s+at\\s+(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\s*\\(?([A-Za-z]{2,4})\\)?(?![A-Za-z])`,
    "gi",
  );
  for (const m of text.matchAll(exact)) {
    const mo = MONTHS[m[2].toLowerCase()];
    const d = Number(m[3]);
    const y = Number(m[4]);
    let h = Number(m[5]);
    const mi = m[6] === undefined ? 0 : Number(m[6]);
    if (!validDate(y, mo, d) || h < 1 || h > 12 || mi > 59) { invalid = true; continue; }
    if (m[1] !== undefined) {
      const wd = WEEKDAYS[m[1].toLowerCase()];
      if (new Date(Date.UTC(y, mo, d)).getUTCDay() !== wd) { invalid = true; continue; } // weekday contradicts date
    }
    const pm = m[7].toLowerCase() === "pm";
    h = (h % 12) + (pm ? 12 : 0);
    const ms = localToUtcMs(y, mo, d, h, mi, m[8]);
    if (ms === null) { invalid = true; continue; }
    hits.push({ expiry: ms / 1000, exactTime: true });
  }

  // "by D" includes day D (end of day, UTC); "before D" excludes it (start of day, UTC).
  const deadlineSec = (word: string, y: number, mo: number, d: number): number =>
    word.toLowerCase() === "before" ? endOfDayUtcSec(y, mo, d) - 86399 : endOfDayUtcSec(y, mo, d);

  // by|before Month D, YYYY
  const byMDY = new RegExp(`\\b(by|before)\\s+(${MONTH_PAT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi");
  for (const m of text.matchAll(byMDY)) {
    const mo = MONTHS[m[2].toLowerCase()];
    const d = Number(m[3]);
    const y = Number(m[4]);
    if (!validDate(y, mo, d)) { invalid = true; continue; }
    hits.push({ expiry: deadlineSec(m[1], y, mo, d), exactTime: false });
  }
  // by|before D Mon YYYY
  const byDMY = new RegExp(`\\b(by|before)\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PAT})\\.?,?\\s+(\\d{4})\\b`, "gi");
  for (const m of text.matchAll(byDMY)) {
    const d = Number(m[2]);
    const mo = MONTHS[m[3].toLowerCase()];
    const y = Number(m[4]);
    if (!validDate(y, mo, d)) { invalid = true; continue; }
    hits.push({ expiry: deadlineSec(m[1], y, mo, d), exactTime: false });
  }
  // in YYYY
  for (const m of text.matchAll(/\bin\s+(20\d{2})\b/gi)) {
    hits.push({ expiry: endOfDayUtcSec(Number(m[1]), 11, 31), exactTime: false });
  }

  if (invalid) return "invalid";
  const distinct = new Map<number, DateHit>();
  for (const h of hits) distinct.set(h.expiry, h);
  return [...distinct.values()];
}

// ---------------------------------------------------------------- kinds

type Kind = "close_above" | "close_below" | "touch_above" | "touch_below";

function findKinds(text: string): Array<{ kind: Kind; verb: string; end: number }> {
  const defs: Array<[Kind, RegExp]> = [
    ["close_above", /\b(?:close|closes|settle|settles)\s+(?:at\s+or\s+)?above\b/gi],
    ["close_below", /\b(?:close|closes|settle|settles)\s+(?:at\s+or\s+)?below\b/gi],
    ["touch_below", /\b(?:drop|drops|fall|falls|dip|dips)\s+below\b/gi],
    ["touch_above", /\b(?:reach|reaches|hit|hits|surpass|surpasses|exceed|exceeds|break\s+above)\b/gi],
  ];
  const out: Array<{ kind: Kind; verb: string; end: number }> = [];
  for (const [kind, re] of defs) {
    for (const m of text.matchAll(re)) {
      out.push({ kind, verb: m[0].toLowerCase().replace(/\s+/g, " "), end: (m.index ?? 0) + m[0].length });
    }
  }
  return out;
}

const RELATIVE_TIME = [
  /\b(?:within|in)\s+the\s+next\b/i,
  /\bnext\s+\d+\s*(?:hr|hrs|hour|hours|h|min|mins|minute|minutes|day|days|d|week|weeks)\b/i,
  /\b(?:within|in)\s+\d+\s*(?:hr|hrs|hour|hours|h|min|mins|minute|minutes|day|days|week|weeks|month|months)\b/i,
];
const NEGATION = /\b(?:not|never|fail|fails|failed|without|won't|doesn't|don't|isn't)\b/i;

export function parseMarket(m: { title?: string | null; question?: string | null }): Contract | null {
  const title = typeof m?.title === "string" ? m.title.trim() : "";
  const question = typeof m?.question === "string" ? m.question.trim() : "";
  const text = title !== "" ? title : question;
  if (text === "") return null;

  if (RELATIVE_TIME.some((re) => re.test(text))) return null;
  if (NEGATION.test(text)) return null;

  const asset = pickAsset(text);
  if (asset === null) return null;

  const kinds = findKinds(text);
  if (kinds.length === 0) return null;
  if (new Set(kinds.map((k) => k.kind)).size !== 1) return null;
  const { kind, verb } = kinds[0];

  // A second asset right after the verb (before any number) is a comparison, e.g. "surpass Solana ($SOL) in ...".
  for (const k of kinds) {
    const firstDigit = text.slice(k.end).search(/\d/);
    const segment = text.slice(k.end, firstDigit === -1 ? undefined : k.end + firstDigit);
    const s = scanAssets(segment);
    if (s.explicit.length > 0 || s.aliases.length > 0) return null;
  }

  const money = findMoney(text);
  if (money.length === 0) return null;
  if (new Set(money).size !== 1) return null; // several different amounts: ambiguous
  const amount = money[0];
  if (!(amount > 0)) return null;

  const dates = findDates(text);
  if (dates === "invalid" || dates.length !== 1) return null;
  const { expiry, exactTime } = dates[0];

  const isMcap = /\bmarket\s+cap(?:itali[sz]ation)?\b/i.test(text);
  if (isMcap) {
    // Only "reach"/"surpass a $X market cap" is supported; everything else is null, never a price contract.
    if (kind !== "touch_above" || !/^(?:reach|reaches|surpass|surpasses)$/.test(verb)) return null;
    return { kind: "mcap_touch_above", asset, mcap: amount, expiry };
  }

  // A close needs an exact settlement time; "close above $X by <date>" is ambiguous.
  if ((kind === "close_above" || kind === "close_below") && !exactTime) return null;

  return { kind, asset, strike: amount, expiry };
}
