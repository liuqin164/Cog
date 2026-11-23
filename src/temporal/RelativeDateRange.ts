import { TEMPORAL_KEYWORDS } from '../core/IntentParser.js';
import { localDateFor, localDateRange, nextCivilDate } from '../utils/LocalDateContext.js';

export interface RelativeDateRange {
  from: number;
  to: number;
  expression: string;
  rest?: string;
}

interface TemporalMatch { start: number; end: number; relative: string; offset?: number }

const CHINESE_DIGITS = '零一二三四五六七八九十';

function chineseNumber(value: string): number {
  const digits = value.replace(/两/g, '二');
  const ten = digits.indexOf('十');
  return ten < 0
    ? CHINESE_DIGITS.indexOf(digits)
    : (ten === 0 ? 1 : CHINESE_DIGITS.indexOf(digits[0]!)) * 10 + (digits.length > ten + 1 ? CHINESE_DIGITS.indexOf(digits[ten + 1]!) : 0);
}

function collectTemporalMatches(query: string): TemporalMatch[] {
  const matches: TemporalMatch[] = [];
  const add = (start: number, text: string, relative: string, offset?: number): void => {
    matches.push({ start, end: start + text.length, relative, ...(offset === undefined ? {} : { offset }) });
  };
  const lower = query.toLowerCase();
  for (const [keyword, constraint] of Object.entries(TEMPORAL_KEYWORDS)) {
    for (let at = lower.indexOf(keyword); at >= 0; at = lower.indexOf(keyword, at + 1)) add(at, keyword, constraint.relative ?? '');
  }
  for (const match of query.matchAll(/大前天|前天|day before yesterday|上上周|上上个月|上上個月/giu)) {
    const relative = /周/.test(match[0]) ? 'last_week' : /月/.test(match[0]) ? 'last_month' : 'day_offset';
    add(match.index!, match[0], relative, relative === 'day_offset' ? (/大/.test(match[0]) ? -3 : -2) : 2);
  }
  for (const match of query.matchAll(/(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(?:天|日)\s*(?:前|以前)|(\d{1,3})\s+days?\s+ago/giu)) {
    const count = match[1] ? (/^\d+$/.test(match[1]) ? Number(match[1]) : chineseNumber(match[1])) : Number(match[2]);
    add(match.index!, match[0], 'day_offset', -count);
  }
  return matches;
}

function longestTemporalMatches(matches: TemporalMatch[]): TemporalMatch[] {
  const kept = matches.sort((left, right) => (right.end - right.start) - (left.end - left.start) || left.start - right.start)
    .filter((match, index, all) => !all.slice(0, index).some((other) => match.start < other.end && other.start < match.end));
  return kept.sort((left, right) => left.start - right.start);
}

function chooseTemporalMatch(query: string, matches: TemporalMatch[]): TemporalMatch | undefined {
  if (matches.length <= 1) return matches[0];
  const cue = /说过|聊过|提过|讨论过/.exec(query);
  if (!cue) return undefined;
  return matches.filter((match) => match.end <= cue.index).sort((left, right) => right.end - left.end)[0]
    ?? matches.filter((match) => match.start >= cue.index + cue[0].length).sort((left, right) => left.start - right.start)[0];
}

function withoutTemporalMatches(query: string, matches: TemporalMatch[]): string {
  return [...matches].sort((left, right) => right.start - left.start)
    .reduce((rest, match) => `${rest.slice(0, match.start)} ${rest.slice(match.end)}`, query);
}

export function inferYearForMonth(
  month: number,
  options: { now?: number; localDateNow?: string; timeZone?: string } = {},
): number {
  const today = options.localDateNow ?? localDateFor(options.now ?? Date.now(), options.timeZone);
  const [year, currentMonth] = today.split('-').map(Number);
  return month > currentMonth! ? year! - 1 : year!;
}

export function relativeDateRange(
  query: string,
  options: { now?: number; localDateNow?: string; timeZone?: string } = {},
): RelativeDateRange | undefined {
  const today = options.localDateNow ?? localDateFor(options.now ?? Date.now(), options.timeZone);
  const [year, month, day] = today.split('-').map(Number);
  const dayRange = (offset: number): RelativeDateRange => {
    const start = nextCivilDate(year!, month!, day!, offset, options.timeZone);
    const end = nextCivilDate(start[0], start[1], start[2], 1, options.timeZone);
    return { ...localDateRange(start[0], start[1], start[2], end[0], end[1], end[2], options.timeZone), expression: 'relative day' };
  };
  if (/刚才|刚刚|方才|just now|moments ago/i.test(query)) {
    const now = options.now ?? Date.now();
    return { from: now - 7_200_000, to: now + 1, expression: 'just now' };
  }
  const matches = longestTemporalMatches(collectTemporalMatches(query));
  const match = chooseTemporalMatch(query, matches);
  if (!match) return undefined;
  const rest = withoutTemporalMatches(query, matches);
  const withRest = (range: RelativeDateRange): RelativeDateRange => ({ ...range, rest });
  const relative = match.relative;
  if (relative === 'day_offset') return withRest(dayRange(match.offset ?? 0));
  if (relative === 'today' || relative === 'yesterday') return withRest(dayRange(relative === 'today' ? 0 : -1));
  if (relative === 'this_week' || relative === 'last_week') {
    const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
    const weeks = relative === 'last_week' ? match.offset ?? 1 : 0;
    const monday = nextCivilDate(year!, month!, day!, -((weekday + 6) % 7) - weeks * 7, options.timeZone);
    const end = nextCivilDate(monday[0], monday[1], monday[2], 7, options.timeZone);
    return withRest({ ...localDateRange(monday[0], monday[1], monday[2], end[0], end[1], end[2], options.timeZone), expression: relative });
  }
  if (relative === 'this_month' || relative === 'last_month') {
    const total = year! * 12 + month! - 1 - (relative === 'last_month' ? match.offset ?? 1 : 0);
    const startYear = Math.floor(total / 12);
    const startMonth = total - startYear * 12 + 1;
    const endYear = Math.floor((total + 1) / 12);
    const endMonth = total + 1 - endYear * 12 + 1;
    return withRest({ ...localDateRange(startYear, startMonth, 1, endYear, endMonth, 1, options.timeZone), expression: relative });
  }
  if (relative === 'this_year' || relative === 'last_year') {
    const startYear = relative === 'last_year' ? year! - 1 : year!;
    return withRest({ ...localDateRange(startYear, 1, 1, startYear + 1, 1, 1, options.timeZone), expression: relative });
  }
  if (relative === 'past_six_months' || relative === 'past_year') {
    const days = relative === 'past_six_months' ? -183 : -365;
    const start = nextCivilDate(year!, month!, day!, days, options.timeZone);
    const end = nextCivilDate(year!, month!, day!, 1, options.timeZone);
    return withRest({ ...localDateRange(start[0], start[1], start[2], end[0], end[1], end[2], options.timeZone), expression: relative });
  }
  if (relative === 'around_half_year_ago') {
    const start = nextCivilDate(year!, month!, day!, -200, options.timeZone);
    const end = nextCivilDate(year!, month!, day!, -160, options.timeZone);
    return withRest({ ...localDateRange(start[0], start[1], start[2], end[0], end[1], end[2], options.timeZone), expression: relative });
  }
  return undefined;
}
