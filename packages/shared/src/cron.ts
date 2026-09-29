/**
 * Cron parsing and timezone-aware next-fire computation.
 *
 * Written rather than depended on, for one reason that matters: most small cron libraries compute
 * the next fire using a fixed UTC offset. That is correct until a DST boundary, at which point a
 * "daily at 02:30" job either fires twice or not at all. This implementation walks calendar
 * minutes in the target IANA zone via `Intl.DateTimeFormat`, so a spring-forward gap and an
 * autumn fall-back duplicate both behave correctly. Both are tested.
 *
 * Five fields: minute hour day-of-month month day-of-week.
 * Supported: `*`, `N`, `a-b`, `a-b/s`, `*​/s`, `a,b,c`, and the usual aliases.
 */

export interface CronFields {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /**
   * Whether the expression restricted DOM and/or DOW.
   *
   * Cron's oddest rule: when BOTH day-of-month and day-of-week are restricted, they are ORed, not
   * ANDed. `0 0 13 * 5` means "the 13th, OR any Friday" — not "Friday the 13th". Getting this
   * wrong is the classic cron bug, so the flags are carried explicitly.
   */
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

export interface CronParseResult {
  readonly ok: boolean;
  readonly fields?: CronFields;
  readonly error?: string;
}

const MONTH_ALIASES: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_ALIASES: Readonly<Record<string, number>> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

function parseField(
  raw: string,
  min: number,
  max: number,
  aliases: Readonly<Record<string, number>> = {},
): { values: Set<number>; restricted: boolean } | { error: string } {
  const out = new Set<number>();
  const restricted = raw.trim() !== '*';

  for (const part of raw.split(',')) {
    const token = part.trim().toLowerCase();
    if (token === '') return { error: `Empty value in "${raw}".` };

    let range = token;
    let step = 1;

    const slash = token.indexOf('/');
    if (slash >= 0) {
      range = token.slice(0, slash);
      const stepRaw = token.slice(slash + 1);
      const parsed = Number.parseInt(stepRaw, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { error: `"${stepRaw}" is not a valid step.` };
      }
      step = parsed;
    }

    let lo: number;
    let hi: number;

    if (range === '*') {
      lo = min;
      hi = max;
    } else {
      const dash = range.indexOf('-', 1); // from 1: a leading '-' is not a range separator
      if (dash > 0) {
        const a = resolveValue(range.slice(0, dash), aliases);
        const b = resolveValue(range.slice(dash + 1), aliases);
        if (a === null || b === null) return { error: `"${range}" is not a valid range.` };
        lo = a;
        hi = b;
      } else {
        const v = resolveValue(range, aliases);
        if (v === null) return { error: `"${range}" is not a valid value.` };
        lo = v;
        hi = slash >= 0 ? max : v; // `5/10` means "from 5 to max, every 10"
      }
    }

    if (lo < min || hi > max || lo > hi) {
      return { error: `"${token}" is outside the allowed range ${min}-${max}.` };
    }

    for (let v = lo; v <= hi; v += step) out.add(v);
  }

  return { values: out, restricted };
}

function resolveValue(raw: string, aliases: Readonly<Record<string, number>>): number | null {
  const token = raw.trim().toLowerCase();
  if (token in aliases) return aliases[token] ?? null;
  const n = Number.parseInt(token, 10);
  return Number.isInteger(n) && String(n) === token ? n : null;
}

export function parseCron(expression: string): CronParseResult {
  const trimmed = expression.trim().toLowerCase();
  const expanded = MACROS[trimmed] ?? trimmed;

  const parts = expanded.split(/\s+/).filter((p) => p !== '');
  if (parts.length !== 5) {
    return {
      ok: false,
      error: `A schedule needs 5 fields (minute hour day month weekday); got ${parts.length}.`,
    };
  }

  const [minRaw, hourRaw, domRaw, monRaw, dowRaw] = parts as [
    string, string, string, string, string,
  ];

  const minutes = parseField(minRaw, 0, 59);
  if ('error' in minutes) return { ok: false, error: `Minute: ${minutes.error}` };

  const hours = parseField(hourRaw, 0, 23);
  if ('error' in hours) return { ok: false, error: `Hour: ${hours.error}` };

  const daysOfMonth = parseField(domRaw, 1, 31);
  if ('error' in daysOfMonth) return { ok: false, error: `Day of month: ${daysOfMonth.error}` };

  const months = parseField(monRaw, 1, 12, MONTH_ALIASES);
  if ('error' in months) return { ok: false, error: `Month: ${months.error}` };

  const dow = parseField(dowRaw, 0, 7, DOW_ALIASES);
  if ('error' in dow) return { ok: false, error: `Day of week: ${dow.error}` };

  // Both 0 and 7 mean Sunday.
  const daysOfWeek = new Set(dow.values);
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }

  return {
    ok: true,
    fields: {
      minutes: minutes.values,
      hours: hours.values,
      daysOfMonth: daysOfMonth.values,
      months: months.values,
      daysOfWeek,
      domRestricted: daysOfMonth.restricted,
      dowRestricted: dow.restricted,
    },
  };
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Wall-clock parts of an instant, as seen in a given IANA zone. */
function partsInZone(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });

  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }

  return {
    year: Number(out['year'] ?? '1970'),
    month: Number(out['month'] ?? '1'),
    day: Number(out['day'] ?? '1'),
    // Intl renders midnight as "24" in some locales/zones; normalise it.
    hour: Number(out['hour'] ?? '0') % 24,
    minute: Number(out['minute'] ?? '0'),
    weekday: WEEKDAY_INDEX[out['weekday'] ?? 'Sun'] ?? 0,
  };
}

/** The UTC offset (ms) in force in `timeZone` at `date`. */
function offsetMs(date: Date, timeZone: string): number {
  const p = partsInZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
  // Discard seconds/ms from the instant: we only ever schedule to minute precision.
  const floored = Math.floor(date.getTime() / 60_000) * 60_000;
  return asUtc - floored;
}

/**
 * The instant at which a given wall-clock time occurs in a zone.
 *
 * Two-pass, because the offset depends on the instant we are trying to find. The second pass
 * catches a DST boundary crossed by the first guess.
 *
 * Returns null when that wall-clock time does not exist — the spring-forward gap, where 02:30
 * simply never happens. Callers skip the day rather than inventing a fire time.
 */
function instantForWallClock(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date | null {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  let guess = new Date(target - offsetMs(new Date(target), timeZone));
  const check1 = partsInZone(guess, timeZone);
  if (matchesWallClock(check1, year, month, day, hour, minute)) return guess;

  guess = new Date(target - offsetMs(guess, timeZone));
  const check2 = partsInZone(guess, timeZone);
  if (matchesWallClock(check2, year, month, day, hour, minute)) return guess;

  return null;
}

function matchesWallClock(
  p: ZonedParts,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): boolean {
  return (
    p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute
  );
}

function dayMatches(fields: CronFields, day: number, weekday: number): boolean {
  // The OR rule: when both DOM and DOW are restricted, either matching is enough.
  if (fields.domRestricted && fields.dowRestricted) {
    return fields.daysOfMonth.has(day) || fields.daysOfWeek.has(weekday);
  }
  return fields.daysOfMonth.has(day) && fields.daysOfWeek.has(weekday);
}

/**
 * Next fire strictly after `after`, in `timeZone`. Returns null if none within ~4 years.
 *
 * Walks candidate days (cheap), then candidate hour/minute combinations within a matching day,
 * rather than minute-by-minute — an hourly job would otherwise cost 1440 iterations per day.
 */
export function nextFireAt(
  expression: string,
  after: Date,
  timeZone = 'UTC',
): Date | null {
  const parsed = parseCron(expression);
  if (!parsed.ok || parsed.fields === undefined) return null;
  if (!isValidTimezone(timeZone)) return null;

  const fields = parsed.fields;
  const sortedHours = [...fields.hours].sort((a, b) => a - b);
  const sortedMinutes = [...fields.minutes].sort((a, b) => a - b);

  // Start from the minute after `after`, since the fire must be strictly later.
  const start = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const startParts = partsInZone(start, timeZone);

  let y = startParts.year;
  let mo = startParts.month;
  let d = startParts.day;

  // ~4 years of days, enough for "Feb 29" to come around.
  for (let dayCount = 0; dayCount < 1500; dayCount += 1) {
    const isFirstDay = dayCount === 0;

    if (fields.months.has(mo)) {
      const weekday = weekdayOf(y, mo, d);
      if (dayMatches(fields, d, weekday)) {
        for (const h of sortedHours) {
          if (isFirstDay && h < startParts.hour) continue;
          for (const mi of sortedMinutes) {
            if (isFirstDay && h === startParts.hour && mi < startParts.minute) continue;
            const instant = instantForWallClock(timeZone, y, mo, d, h, mi);
            // null = this wall-clock time does not exist (spring-forward gap). Skip it.
            if (instant !== null && instant.getTime() > after.getTime()) return instant;
          }
        }
      }
    }

    // Advance one calendar day.
    const nextDay = new Date(Date.UTC(y, mo - 1, d + 1));
    y = nextDay.getUTCFullYear();
    mo = nextDay.getUTCMonth() + 1;
    d = nextDay.getUTCDate();
  }

  return null;
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The next N fires. Used by the builder's "next 5 runs" preview. */
export function nextFires(
  expression: string,
  after: Date,
  timeZone = 'UTC',
  count = 5,
): Date[] {
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < count; i += 1) {
    const next = nextFireAt(expression, cursor, timeZone);
    if (next === null) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

export function describeCron(expression: string): string {
  const trimmed = expression.trim().toLowerCase();
  const parsed = parseCron(expression);
  if (!parsed.ok || parsed.fields === undefined) return 'Invalid schedule';

  const parts = (MACROS[trimmed] ?? trimmed).split(/\s+/);
  const [mi, h, dom, mon, dow] = parts as [string, string, string, string, string];

  const everyMinute = mi === '*';
  const everyHour = h === '*';
  const everyDay = dom === '*' && mon === '*' && dow === '*';

  // Step expressions (*/15) describe a FREQUENCY, so they need their own phrasing. Rendering
  // them positionally produces nonsense like "Every hour at :*/15".
  const minuteStep = /^\*\/(\d+)$/.exec(mi);
  const hourStep = /^\*\/(\d+)$/.exec(h);

  if (everyMinute && everyHour && everyDay) return 'Every minute';

  if (minuteStep?.[1] !== undefined && everyHour && everyDay) {
    const n = Number(minuteStep[1]);
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  if (hourStep?.[1] !== undefined && everyDay) {
    const n = Number(hourStep[1]);
    const at = everyMinute ? '' : ` at :${pad(mi)}`;
    return n === 1 ? `Every hour${at}` : `Every ${n} hours${at}`;
  }

  if (everyHour && everyDay) return `Every hour at :${pad(mi)}`;

  // A list of minutes or hours (0,30) is also a frequency, not a single time.
  if (mi.includes(',') && everyHour && everyDay) {
    return `Every hour at :${mi.split(',').map(pad).join(', :')}`;
  }

  const time = `${pad(h)}:${pad(mi)}`;

  if (everyDay) return `Every day at ${time}`;
  if (dom === '*' && mon === '*') return `${describeWeekdays(dow)} at ${time}`;
  if (mon === '*') return `Monthly on day ${dom} at ${time}`;
  return `${describeMonths(mon)} on day ${dom} at ${time}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function describeWeekdays(dow: string): string {
  if (dow === '1-5') return 'Weekdays';
  if (dow === '0,6' || dow === '6,0') return 'Weekends';
  const parsed = parseCron(`0 0 * * ${dow}`);
  const days = [...(parsed.fields?.daysOfWeek ?? [])].sort((a, b) => a - b);
  if (days.length === 0) return 'Weekly';
  if (days.length === 1) return `Every ${DAY_NAMES[days[0] ?? 0] ?? ''}`;
  return `Every ${days.map((d) => (DAY_NAMES[d] ?? '').slice(0, 3)).join(', ')}`;
}

function describeMonths(mon: string): string {
  const parsed = parseCron(`0 0 1 ${mon} *`);
  const months = [...(parsed.fields?.months ?? [])].sort((a, b) => a - b);
  if (months.length === 1) return MONTH_NAMES[(months[0] ?? 1) - 1] ?? 'Yearly';
  return months.map((m) => (MONTH_NAMES[m - 1] ?? '').slice(0, 3)).join(', ');
}

function pad(v: string): string {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) ? String(n).padStart(2, '0') : v;
}
