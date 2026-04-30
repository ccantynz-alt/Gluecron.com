/**
 * Tiny cron-expression parser + matcher.
 *
 * Standard 5-field UNIX cron:
 *
 *   minute hour day-of-month month day-of-week
 *      0-59  0-23     1-31   1-12  0-6 (Sun=0; Sat=6; 7 also accepted as Sun)
 *
 * Supports: literal numbers, `*`, ranges (`a-b`), step (`*\/n` or `a-b/n`),
 * and comma-lists (`1,3,5`). No named months / weekdays, no `@hourly`,
 * no `L`/`W`/`#` — those raise a parse error so callers can surface a
 * useful message rather than silently never firing.
 *
 * Day-of-month and day-of-week interact via OR (POSIX semantics): if both
 * are restricted, the schedule fires when EITHER matches. If one is `*`
 * we conjoin with the other (the practical common case).
 *
 * Pure module — no DB, no clock side effects. Callers pass a Date.
 */

export type CronField = number[]; // sorted, deduped

export type ParsedCron = {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
  /** Original expression after trimming + collapsing whitespace. */
  raw: string;
};

export type CronParseResult =
  | { ok: true; cron: ParsedCron }
  | { ok: false; error: string };

const FIELD_BOUNDS: Record<string, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 7], // 7 normalised to 0 below
};

/**
 * Parse one field of a cron expression against [lo, hi]. Returns a sorted,
 * de-duplicated list of valid integers, or `null` if the field is
 * malformed. Supports `*`, `a`, `a-b`, `*\/n`, `a-b/n`, `a,b,c`.
 */
function parseField(
  raw: string,
  lo: number,
  hi: number
): CronField | null {
  const out = new Set<number>();
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  for (const part of parts) {
    let baseLo = lo;
    let baseHi = hi;
    let step = 1;
    let body = part;

    const slash = body.indexOf("/");
    if (slash >= 0) {
      const stepStr = body.slice(slash + 1);
      const stepN = Number.parseInt(stepStr, 10);
      if (!Number.isInteger(stepN) || stepN <= 0) return null;
      step = stepN;
      const before = body.slice(0, slash);
      // Empty before-slash (e.g. "/5") is a syntax error — must be either
      // "*" or a literal range. Don't silently default to "*".
      if (before === "") return null;
      body = before;
    }

    if (body === "*") {
      // baseLo / baseHi already span the full field.
    } else if (body.includes("-")) {
      const [aS, bS] = body.split("-");
      const a = Number.parseInt(aS, 10);
      const b = Number.parseInt(bS, 10);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      if (a < lo || b > hi || a > b) return null;
      baseLo = a;
      baseHi = b;
    } else {
      const n = Number.parseInt(body, 10);
      if (!Number.isInteger(n) || n < lo || n > hi) return null;
      if (step !== 1) return null; // n/step makes no sense without a range
      out.add(n);
      continue;
    }

    for (let v = baseLo; v <= baseHi; v += step) {
      out.add(v);
    }
  }

  return [...out].sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron expression. Returns `{ok:true, cron}` or
 * `{ok:false, error}`. Whitespace-tolerant; rejects unsupported syntax.
 */
export function parseCron(expr: string): CronParseResult {
  const raw = (expr || "").replace(/\s+/g, " ").trim();
  if (!raw) return { ok: false, error: "empty cron expression" };

  // Fail fast on syntax we don't yet support so the user gets a clear
  // error instead of a schedule that silently never fires.
  if (/^@/.test(raw)) {
    return {
      ok: false,
      error: `cron alias '${raw.split(" ")[0]}' is not supported (use 5-field expression)`,
    };
  }
  if (/[LW#?]/i.test(raw)) {
    return {
      ok: false,
      error: "cron contains unsupported characters (L, W, #, ?)",
    };
  }

  const fields = raw.split(" ");
  if (fields.length !== 5) {
    return {
      ok: false,
      error: `cron must have 5 space-separated fields, got ${fields.length}`,
    };
  }

  const [mField, hField, domField, monField, dowField] = fields;

  const minute = parseField(mField, ...FIELD_BOUNDS.minute);
  const hour = parseField(hField, ...FIELD_BOUNDS.hour);
  const dom = parseField(domField, ...FIELD_BOUNDS.dom);
  const month = parseField(monField, ...FIELD_BOUNDS.month);
  const dowRaw = parseField(dowField, ...FIELD_BOUNDS.dow);

  if (!minute) return { ok: false, error: `invalid minute field: ${mField}` };
  if (!hour) return { ok: false, error: `invalid hour field: ${hField}` };
  if (!dom) return { ok: false, error: `invalid day-of-month field: ${domField}` };
  if (!month) return { ok: false, error: `invalid month field: ${monField}` };
  if (!dowRaw) return { ok: false, error: `invalid day-of-week field: ${dowField}` };

  // Normalise dow so 7 → 0 (both mean Sunday).
  const dow = [...new Set(dowRaw.map((d) => (d === 7 ? 0 : d)))].sort(
    (a, b) => a - b
  );

  return {
    ok: true,
    cron: {
      raw,
      minute,
      hour,
      dom,
      month,
      dow,
    },
  };
}

/**
 * Does the cron fire on this exact minute (UTC)? `date` is rounded down
 * to the start of its minute internally so callers can pass any Date.
 */
export function cronMatches(cron: ParsedCron, date: Date): boolean {
  if (!cron) return false;
  const m = date.getUTCMinutes();
  const h = date.getUTCHours();
  const d = date.getUTCDate();
  const mo = date.getUTCMonth() + 1; // JS is 0-indexed
  const dw = date.getUTCDay(); // 0..6, Sun=0

  if (!cron.minute.includes(m)) return false;
  if (!cron.hour.includes(h)) return false;
  if (!cron.month.includes(mo)) return false;

  // POSIX OR semantics for dom & dow: if either is restricted (not full
  // wildcard), match if EITHER matches. If both unrestricted, both pass.
  const domRestricted = cron.dom.length !== 31;
  const dowRestricted = cron.dow.length !== 7;
  const domMatch = cron.dom.includes(d);
  const dowMatch = cron.dow.includes(dw);

  if (!domRestricted && !dowRestricted) return true;
  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  if (domRestricted) return domMatch;
  return dowMatch;
}

/**
 * Did the cron fire at any minute in the half-open interval (since, until]?
 * Useful for "did this schedule trip in the last tick?" checks where
 * `since` is the prior tick wall and `until` is the current wall. Caps
 * the loop at 1 day so a misconfigured `since` from 2010 can't blow up.
 */
export function cronFiredBetween(
  cron: ParsedCron,
  since: Date,
  until: Date
): boolean {
  if (!cron) return false;
  const startMs = Math.floor(since.getTime() / 60000) * 60000 + 60000;
  const endMs = Math.floor(until.getTime() / 60000) * 60000;
  if (endMs < startMs) return false;

  const ONE_DAY_MIN = 24 * 60;
  const minuteCount = (endMs - startMs) / 60000 + 1;
  const cap = Math.min(minuteCount, ONE_DAY_MIN);

  for (let i = 0; i < cap; i++) {
    const t = new Date(startMs + i * 60000);
    if (cronMatches(cron, t)) return true;
  }
  return false;
}

/**
 * Test-only export of the field parser so unit tests can pin parsing
 * edge cases without going through parseCron's plumbing.
 */
export const __test = { parseField };
