import type { ParsedDay, ParsedItinerary, ParsedStop } from '../src/shared/itinerary';

const KNOWN_CITIES = [
  '宁波',
  '杭州',
  '上海',
  '北京',
  '南京',
  '苏州',
  '无锡',
  '绍兴',
  '嘉兴',
  '湖州',
  '舟山',
  '温州',
  '台州',
  '金华',
  '广州',
  '深圳',
  '成都',
  '重庆',
  '西安',
  '武汉',
  '长沙',
  '厦门',
  '青岛',
  '天津'
];

const NON_PLACE_LINE =
  /^(住宿推荐|出行时间|限制|优势|备注|说明|不含|包含|含Meland|今日|日期|时间|地点|标题|美食推荐|餐厅推荐|店铺推荐|商场推荐|title|date)(?:\b|[：:（(]|$)/i;
const TRANSPORT_BACK = /^(?:地铁|打车|步行|公交|骑车)?\s*(?:回|返回)(?:酒店|宾馆|住处|鄞州酒店|.*酒店)(?:休息)?$/;
const RETURN_CITY_ONLY = /^(?:发车|返程|回程|返回|回|出发回)[\u4e00-\u9fa5]{2,6}$/;
const GENERIC_ACTIVITY = /^(?:酒店|宾馆|住处)(?:午餐|晚餐|早餐|午休|休息|入住|退房|存行李)?/;
const PLACE_HINT =
  /(站|馆|园|寺|阁|庙|滩|街|城|广场|百货|商场|银泰|Meland|乐园|公园|博物馆|图书馆|展览馆|火车站|高铁站)$/i;
const TRIP_CITY_SUFFIX = /(亲子|旅行|旅游|行程|攻略|三日游|两日游|一日游|游)$/;

export function cleanParsedItinerary(parsed: ParsedItinerary, rawText = ''): ParsedItinerary {
  const rawTitle = cleanTitle(parsed.title, rawText);
  const tripCity = inferTripCity(rawTitle, rawText, parsed);
  const dateRange = inferDateRange(parsed.dateRange, `${rawTitle}\n${rawText}`);

  const days = (parsed.days || [])
    .map((day) => cleanDay(day, tripCity))
    .filter((day): day is ParsedDay => Boolean(day && (day.stops?.length || 0) > 0));

  const alternatives = (parsed.alternatives || [])
    .map((stop, index) => cleanStop(stop, tripCity, index + 1))
    .filter((stop): stop is ParsedStop => Boolean(stop));

  return {
    ...parsed,
    title: summarizeTripTitle(rawTitle, rawText, tripCity, days),
    language: parsed.language || (/[\u4e00-\u9fa5]/.test(rawText) ? 'zh-CN' : 'auto'),
    dateRange,
    days,
    alternatives
  };
}

export function cleanStop(stop: ParsedStop, tripCity = '', fallbackOrder = 1): ParsedStop | null {
  const source = normalizeWhitespace(stop.name || '');
  if (!source || NON_PLACE_LINE.test(source) || TRANSPORT_BACK.test(source) || GENERIC_ACTIVITY.test(source)) {
    return null;
  }

  const time = stop.time || extractTime(source);
  const withoutTime = source.replace(/^\s*\d{1,2}[:：]\d{2}(?:\s*[-–—]\s*\d{1,2}[:：]\d{2})?\s*/, '');
  if (RETURN_CITY_ONLY.test(withoutTime) && !PLACE_HINT.test(withoutTime)) return null;
  const parentheticalNotes = Array.from(withoutTime.matchAll(/[（(]([^）)]+)[）)]/g)).map((match) => match[1]);
  const withoutParen = withoutTime.replace(/[（(][^）)]+[）)]/g, '').trim();
  const extracted = extractDestination(withoutParen);
  const rawName = extracted || withoutParen.split(/[，,；;]/)[0] || withoutParen;
  const name = polishPlaceName(rawName);

  if (!isUsefulPlaceName(name)) return null;

  const notes = [
    stop.note,
    ...parentheticalNotes,
    extracted ? withoutParen.replace(rawName, '').replace(/^[，,；;\s]+/, '') : ''
  ]
    .map((value) => normalizeWhitespace(value || ''))
    .filter(Boolean);

  return {
    order: stop.order && stop.order > 0 ? stop.order : fallbackOrder,
    name,
    note: dedupeText(notes).join('；'),
    city: stop.city || tripCity,
    time,
    category: stop.category || ''
  };
}

function cleanDay(day: ParsedDay, tripCity: string): ParsedDay | null {
  const rawTitle = normalizeWhitespace(day.title || `Day ${day.dayIndex || ''}`) || `Day ${day.dayIndex || ''}`;
  const date = day.date || extractDate(rawTitle);
  const stops = (day.stops || [])
    .map((stop, index) => cleanStop(stop, tripCity, index + 1))
    .filter((stop): stop is ParsedStop => Boolean(stop))
    .map((stop, index) => ({ ...stop, order: index + 1 }));

  const alternatives = (day.alternatives || [])
    .map((stop, index) => cleanStop(stop, tripCity, index + 1))
    .filter((stop): stop is ParsedStop => Boolean(stop));

  if (stops.length === 0 && alternatives.length === 0) return null;

  return {
    ...day,
    date,
    title: summarizeDayTitle(rawTitle, day.dayIndex || 0, stops),
    stops,
    alternatives
  };
}

function cleanTitle(title: string | undefined, rawText: string): string {
  const firstLine = rawText
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .find((line) => line && !NON_PLACE_LINE.test(line));
  const candidate = normalizeWhitespace(title || firstLine || 'Untitled itinerary');
  if (NON_PLACE_LINE.test(candidate)) return firstLine || 'Untitled itinerary';
  return candidate.slice(0, 60);
}

function summarizeTripTitle(title: string, rawText: string, tripCity: string, days: ParsedDay[]): string {
  const candidate = stripDecorations(title);
  if (isConciseTripTitle(candidate)) return candidate;

  const city = tripCity || inferCityFromText(`${title}\n${rawText}`) || '旅行';
  const dayCount = days.length || countExplicitDays(rawText);
  const theme = inferTripTheme(`${title}\n${rawText}`);
  const noun = /自驾/.test(theme) ? '路线' : '行程';
  return normalizeWhitespace(`${city}${dayCount ? ` ${dayCount} 日` : ''}${theme}${noun}`);
}

function summarizeDayTitle(rawTitle: string, dayIndex: number, stops: ParsedStop[]): string {
  const candidate = stripDayTitle(rawTitle, dayIndex);
  if (isConciseDayTitle(candidate)) return candidate;

  const titleStops = stops.filter((stop) => !/(?:站|机场|酒店|宾馆|住处)$/.test(stop.name));
  const usableStops = titleStops.length ? titleStops : stops;
  if (usableStops.length >= 2) {
    const first = shortenTitlePlace(usableStops[0].name);
    const last = shortenTitlePlace(usableStops[usableStops.length - 1].name);
    return first === last ? first : `${first}到${last}`;
  }
  if (usableStops.length === 1) return shortenTitlePlace(usableStops[0].name);
  return `Day ${dayIndex || ''}`.trim();
}

function isConciseTripTitle(title: string): boolean {
  if (!title || title.length > 28) return false;
  return !/(?:^|\s)(?:Day|D)\s*\d+|第\s*\d+\s*天|→|->|\d{1,2}[:：]\d{2}|高铁|地铁|放行李|存行李|不跑|只玩/i.test(title);
}

function isConciseDayTitle(title: string): boolean {
  if (!title || title.length < 2 || title.length > 24) return false;
  return !/(?:^|\s)(?:Day|D)\s*\d+|第\s*\d+\s*天|→|->|\d{1,2}[:：]\d{2}|高铁|地铁|酒店|放行李|存行李|不跑|只玩|上午|下午|晚上/i.test(title);
}

function stripDayTitle(title: string, dayIndex: number): string {
  const dayPattern = dayIndex
    ? new RegExp(`^(?:第\\s*${dayIndex}\\s*天|Day\\s*${dayIndex}|D\\s*${dayIndex})\\s*`, 'i')
    : /^(?:第\s*\d+\s*天|Day\s*\d+|D\s*\d+)\s*/i;
  return stripDecorations(title)
    .replace(dayPattern, '')
    .replace(/^[｜|:：.)、\-\s]+/, '')
    .replace(/^\d{1,2}[./月-]\d{1,2}[日号]?\s*/, '')
    .replace(/^[（(]?(?:周[一二三四五六日天]|星期[一二三四五六日天])?[·.\s]*[）)]?/, '')
    .replace(/^[（(]|[）)]$/g, '')
    .replace(/^[-–—·\s]+/, '')
    .trim();
}

function stripDecorations(value: string): string {
  return normalizeWhitespace(value)
    .replace(/^#+\s*/, '')
    .replace(/[📍🚶‍♀️🚶🚌☀️😭]+/gu, '')
    .replace(/\s*[|｜]\s*/g, ' ')
    .trim();
}

function shortenTitlePlace(name: string): string {
  const normalized = name.replace(/[（(].*?[）)]/g, '').replace(/\s+/g, '').trim();
  return normalized.length > 10 ? `${normalized.slice(0, 10)}…` : normalized;
}

function inferTripTheme(text: string): string {
  if (/亲子/.test(text)) return '亲子';
  if (/自驾/.test(text)) return '自驾';
  if (/Citywalk|citywalk/i.test(text)) return 'Citywalk';
  if (/逛吃|美食/.test(text)) return '逛吃';
  if (/懒人|不费腿/.test(text)) return '懒人';
  return '';
}

function inferCityFromText(text: string): string {
  return KNOWN_CITIES.find((city) => new RegExp(`${city}(?:${TRIP_CITY_SUFFIX.source})?`).test(text)) || '';
}

function countExplicitDays(rawText: string): number {
  const matches = rawText.match(/(?:^|\n)\s*(?:第\s*\d+\s*天|Day\s*\d+|D\s*\d+)(?=\s|[：:|｜.)、-]|$)/gi);
  return matches ? new Set(matches.map((match) => match.replace(/\D/g, ''))).size : 0;
}

function inferTripCity(title: string, rawText: string, parsed: ParsedItinerary): string {
  const titleCity = KNOWN_CITIES.find((city) => new RegExp(`${city}(?:${TRIP_CITY_SUFFIX.source})?`).test(title));
  if (titleCity) return titleCity;

  const haystack = [
    title,
    rawText,
    ...(parsed.days || []).flatMap((day) => [
      day.title || '',
      ...(day.stops || []).map((stop) => stop.name || '')
    ])
  ].join('\n');

  const counts = KNOWN_CITIES.map((city) => ({
    city,
    count: (haystack.match(new RegExp(city, 'g')) || []).length
  })).filter((entry) => entry.count > 0);

  counts.sort((a, b) => b.count - a.count);
  return counts[0]?.city || '';
}

function inferDateRange(dateRange: ParsedItinerary['dateRange'], text: string) {
  if (dateRange?.label || dateRange?.start || dateRange?.end) return dateRange;
  const match = text.match(/(\d{1,2}[./-]\d{1,2})\s*[-~至—]\s*(\d{1,2}[./-]\d{1,2})/);
  if (!match) return { start: '', end: '', label: '' };
  return {
    start: match[1],
    end: match[2],
    label: `${match[1]}-${match[2]}`
  };
}

function extractDestination(value: string): string {
  const arrow = value.match(/→\s*([^，,；;]+)/);
  if (arrow) return arrow[1];

  const segmentPlace = value
    .split(/[，,；;]/)
    .map(polishPlaceName)
    .find((name) => PLACE_HINT.test(name) || /Meland/i.test(name));
  if (segmentPlace) return segmentPlace;

  const matches = Array.from(value.matchAll(/(?:到|至|去|前往|抵达|回)([^，,；;]+)/g))
    .map((match) => match[1])
    .map(polishPlaceName)
    .filter((name) => name && !GENERIC_ACTIVITY.test(name));

  const placeLike = matches.find((name) => PLACE_HINT.test(name) || /Meland/i.test(name));
  return placeLike || matches[0] || '';
}

function polishPlaceName(value: string): string {
  return normalizeWhitespace(value)
    .replace(/^[✅✔️☑️📍🍜🏨🚇☀️\-\s]+/gu, '')
    .replace(/^(?:乘坐|搭乘|坐)?(?:地铁|公交|高铁|火车|打车|步行|骑行)?\d*号?线?\s*/, '')
    .replace(/^高铁\s*/, '')
    .replace(/^出发\s*/, '')
    .replace(/^回\s*/, '')
    .replace(/^(?:到|至|去|前往|抵达)\s*/, '')
    .replace(/(?:午餐|晚餐|早餐|简餐|午休|休息|散步|消食|逛吃|夜景|小吃|存行李|候车|发车|入场|入园|参观|预约|放电|顺走|即达|简单).*$/i, '')
    .replace(/[，,；;].*$/, '')
    .replace(/\s+/g, '')
    .trim();
}

function isUsefulPlaceName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 28) return false;
  if (NON_PLACE_LINE.test(name) || TRANSPORT_BACK.test(name) || GENERIC_ACTIVITY.test(name)) return false;
  if (/^(?:上午|下午|晚上|周一|周二|周三|周四|周五|周六|周日)$/.test(name)) return false;
  if (/^(?:地铁|步行|打车|高铁|火车|公交|发车|出发)/.test(name) && !PLACE_HINT.test(name)) return false;
  return true;
}

function extractTime(value: string): string {
  return value.match(/^\s*(\d{1,2}[:：]\d{2}(?:\s*[-–—]\s*\d{1,2}[:：]\d{2})?)/)?.[1] || '';
}

function extractDate(value: string): string {
  return value.match(/\d{1,2}[./月-]\d{1,2}[日号]?/)?.[0] || '';
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function dedupeText(values: string[]): string[] {
  return Array.from(new Set(values));
}
