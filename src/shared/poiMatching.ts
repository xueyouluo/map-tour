import { candidateFitsRegion, placeSearchContext } from './placeContext';
import type {
  Itinerary,
  PoiCandidate,
  PoiSearchContext,
  Stop
} from './itinerary';

export function pickBestPoiCandidate(
  candidates: PoiCandidate[],
  stop: Stop,
  searchCity: string,
  tripScope: Itinerary['tripScope'],
  context?: PoiSearchContext
): PoiCandidate | undefined {
  return candidates
    .filter((candidate) =>
      candidateFitsRegion(
        candidate,
        context || placeSearchContext(stop, tripScope)
      )
    )
    .map((candidate, index) => ({
      candidate,
      score:
        scorePoiCandidate(candidate, stop, searchCity, tripScope) - index * 0.01
    }))
    .filter((item) => item.score >= 30)
    .sort((a, b) => b.score - a.score)[0]?.candidate;
}

export function estimatePoiConfidence(
  candidate: PoiCandidate,
  stop: Stop,
  searchCity: string,
  tripScope: Itinerary['tripScope']
): number {
  const score = scorePoiCandidate(candidate, stop, searchCity, tripScope);
  if (score >= 80) return 0.92;
  if (score >= 55) return 0.86;
  if (score >= 30) return 0.72;
  return 0.6;
}

function scorePoiCandidate(
  candidate: PoiCandidate,
  stop: Stop,
  searchCity: string,
  tripScope: Itinerary['tripScope']
): number {
  const stopName = normalizeSearchText(stop.activity?.searchName || stop.name);
  const candidateName = normalizeSearchText(candidate.name);
  const scopeText = normalizeSearchText(
    `${candidate.name} ${candidate.address || ''} ${candidate.type || ''} ${candidate.province || ''} ${candidate.city || ''} ${candidate.district || ''}`
  );
  const cityHints = [searchCity, stop.city || '', ...(tripScope?.cities || [])]
    .map(normalizeSearchText)
    .filter(Boolean);

  const templeAlias = (value: string) => value.replace(/讲寺|禅寺/g, '寺');
  const sharedPrefix = [...stopName].findIndex(
    (char, index) => candidateName[index] !== char
  );
  const prefixLength = sharedPrefix === -1 ? stopName.length : sharedPrefix;
  const nameRelated =
    candidateName.includes(stopName) ||
    stopName.includes(candidateName) ||
    scopeText.includes(stopName) ||
    prefixLength >= 3 ||
    (/寺$/.test(stopName) &&
      templeAlias(candidateName).endsWith(templeAlias(stopName)));
  if (!stopName || !candidateName || !nameRelated) return -Infinity;
  let score = 0;
  const scenicCore = normalizeSearchText(
    candidate.name.split(/[·.。]/).at(-1) || ''
  );
  if (candidateName === stopName || scenicCore === stopName) score += 100;
  else if (
    candidateName &&
    (candidateName.includes(stopName) || stopName.includes(candidateName))
  )
    score += 36;
  else if (stopName.length >= 3 && scopeText.includes(stopName)) score += 22;
  else if (prefixLength >= 3) score += 28;

  for (const city of cityHints) {
    if (scopeText.includes(city)) {
      score += 18;
      break;
    }
  }

  if (
    /景区|风景|公园|博物馆|寺|街区|商场|餐饮|酒店|交通设施/.test(
      candidate.type || ''
    )
  )
    score += 6;
  // Prefer the place itself over businesses, entrances and tiny features named after it.
  const areaAnchor = stop.activity?.placeKind === 'area';
  const wantsHotel = stop.activity?.kind === 'stay' && !areaAnchor;
  if (/住宿服务|宾馆|酒店/.test(candidate.type || '') && !wantsHotel)
    score -= 65;
  if (
    areaAnchor &&
    /交通地名;道路名|特色商业街|地铁站/.test(candidate.type || '')
  )
    score += 15;
  if (
    /寺$/.test(stopName) &&
    templeAlias(candidateName).endsWith(templeAlias(stopName))
  )
    score += 70;
  if (
    /白玉兰|斋堂|天王殿|管委会/.test(candidate.name) &&
    !/白玉兰|斋堂|天王殿|管委会/.test(stop.name)
  )
    score -= 40;
  if (
    /政府|村委会|服务站|委员会|派出所|停车场|检票口|售票处|休息亭|战壕遗址/.test(
      candidate.name
    ) &&
    !/政府|村委会|服务站|委员会|派出所|停车场|检票口|售票处|休息亭|战壕遗址/.test(
      stop.name
    )
  )
    score -= 80;
  if (/风景名胜;风景名胜;风景名胜|风景名胜;公园广场/.test(candidate.type || ''))
    score += 18;
  const ancillary =
    /公交站|地铁站|停车场|售票|法物流通|商店|餐厅|饭店|小吃/.test(
      candidate.name
    );
  const seekingAncillary =
    /公交站|地铁站|停车场|售票|商店|餐厅|饭店|小吃/.test(stop.name) ||
    stop.activity?.kind === 'meal' ||
    /restaurant|shop|cafe/.test(stop.category || '');
  if (
    /餐饮服务|购物服务|商务住宅/.test(candidate.type || '') &&
    !seekingAncillary &&
    !wantsHotel
  )
    score -= 70;
  if (ancillary && !seekingAncillary && stop.activity?.placeKind !== 'area')
    score -= 65;
  if (
    /国家级景点|风景名胜;风景名胜(?:;|$)|公园|寺庙/.test(
      candidate.type || ''
    ) &&
    !seekingAncillary
  )
    score += 15;
  return score;
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/沙滩/g, '海滩')
    .replace(/\s+/g, '')
    .replace(/[（）()[\]·,，.。:：;；'"“”‘’_-]/g, '')
    .trim();
}
