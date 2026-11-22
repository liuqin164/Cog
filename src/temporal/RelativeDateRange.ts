import { TEMPORAL_KEYWORDS } from '../core/IntentParser.js';
import { localDateFor, localDateRange, nextCivilDate } from '../utils/LocalDateContext.js';

export interface RelativeDateRange {
  from: number;
  to: number;
  expression: string;
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
  const daysAgo = query.match(/(\d{1,3})\s*(?:天|日)\s*(?:前|以前)|(\d{1,3})\s+days?\s+ago/i);
  if (daysAgo) return dayRange(-Number(daysAgo[1] ?? daysAgo[2]));
  if (/前天|day before yesterday/i.test(query)) return dayRange(-2);
  if (/刚才|刚刚|方才|just now|moments ago/i.test(query)) return dayRange(0);
  const lowerQuery = query.toLowerCase();
  const relative = Object.entries(TEMPORAL_KEYWORDS).find(([keyword]) => lowerQuery.includes(keyword))?.[1].relative;
  if (!relative) return undefined;
  if (relative === 'today' || relative === 'yesterday') return dayRange(relative === 'today' ? 0 : -1);
  if (relative === 'this_week' || relative === 'last_week') {
    const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
    const monday = nextCivilDate(year!, month!, day!, -((weekday + 6) % 7) - (relative === 'last_week' ? 7 : 0), options.timeZone);
    const end = nextCivilDate(monday[0], monday[1], monday[2], 7, options.timeZone);
    return { ...localDateRange(monday[0], monday[1], monday[2], end[0], end[1], end[2], options.timeZone), expression: relative };
  }
  if (relative === 'this_month' || relative === 'last_month') {
    const shift = relative === 'last_month' ? -1 : 0;
    const startYear = month! + shift < 1 ? year! - 1 : year!;
    const startMonth = month! + shift < 1 ? 12 : month! + shift;
    const endYear = startMonth === 12 ? startYear + 1 : startYear;
    const endMonth = startMonth === 12 ? 1 : startMonth + 1;
    return { ...localDateRange(startYear, startMonth, 1, endYear, endMonth, 1, options.timeZone), expression: relative };
  }
  if (relative === 'this_year' || relative === 'last_year') {
    const startYear = relative === 'last_year' ? year! - 1 : year!;
    return { ...localDateRange(startYear, 1, 1, startYear + 1, 1, 1, options.timeZone), expression: relative };
  }
  if (relative === 'past_six_months' || relative === 'past_year') {
    const days = relative === 'past_six_months' ? -183 : -365;
    const start = nextCivilDate(year!, month!, day!, days, options.timeZone);
    const end = nextCivilDate(year!, month!, day!, 1, options.timeZone);
    return { ...localDateRange(start[0], start[1], start[2], end[0], end[1], end[2], options.timeZone), expression: relative };
  }
  if (relative === 'around_half_year_ago') {
    const start = nextCivilDate(year!, month!, day!, -200, options.timeZone);
    const end = nextCivilDate(year!, month!, day!, -160, options.timeZone);
    return { ...localDateRange(start[0], start[1], start[2], end[0], end[1], end[2], options.timeZone), expression: relative };
  }
  return undefined;
}
