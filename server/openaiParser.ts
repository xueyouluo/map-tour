import { completeDailyActivities } from '../src/shared/activities';
import OpenAI from 'openai';
import {
  normalizeParsedItinerary,
  type ParsedDay,
  type ParsedItinerary
} from '../src/shared/itinerary';
import { cleanParsedItinerary } from './itineraryCleanup';
import { assertMainlandItinerary } from './serviceRegion';
import { HttpError } from './httpSecurity';
import { MAINLAND_ONLY_MESSAGE } from '../src/shared/serviceRegion';

export interface ParseInput {
  text?: string;
  image?: {
    buffer: Buffer;
    mimeType: string;
  };
}

export interface ParseResult {
  itinerary: ReturnType<typeof normalizeParsedItinerary>;
  source: 'openai' | 'local-fallback';
  warning?: string;
}

export interface ParseProgressEvent {
  type: 'status' | 'progress';
  message: string;
  receivedChars?: number;
}

interface AiRuntime {
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

interface ParseOptions {
  stream?: boolean;
  onProgress?: (event: ParseProgressEvent) => void;
}

const parseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'serviceRegion',
    'language',
    'dateRange',
    'tripScope',
    'days',
    'alternatives',
    'recommendations'
  ],
  properties: {
    title: { type: 'string' },
    serviceRegion: { type: 'string', enum: ['CN_MAINLAND', 'UNSUPPORTED', 'UNKNOWN'] },
    language: { type: 'string' },
    dateRange: {
      type: 'object',
      additionalProperties: false,
      required: ['start', 'end', 'label'],
      properties: {
        start: { type: 'string' },
        end: { type: 'string' },
        label: { type: 'string' }
      }
    },
    tripScope: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'primaryCity', 'cities', 'confidence', 'reason'],
      properties: {
        mode: {
          type: 'string',
          enum: ['single_city', 'multi_city', 'unknown']
        },
        primaryCity: { type: 'string' },
        cities: {
          type: 'array',
          items: { type: 'string' }
        },
        confidence: { type: 'number' },
        reason: { type: 'string' }
      }
    },
    days: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'dayIndex',
          'date',
          'title',
          'stops',
          'alternatives',
          'activityOptions'
        ],
        properties: {
          dayIndex: { type: 'number' },
          date: { type: 'string' },
          title: { type: 'string' },
          stops: {
            type: 'array',
            items: parsedStopSchema()
          },
          activityOptions: { type: 'array', items: parsedStopSchema() },
          alternatives: {
            type: 'array',
            items: parsedStopSchema()
          }
        }
      }
    },
    recommendations: {
      type: 'object',
      additionalProperties: false,
      required: ['lodging', 'dining'],
      properties: {
        lodging: { type: 'array', items: parsedStopSchema() },
        dining: { type: 'array', items: parsedStopSchema() }
      }
    },
    alternatives: {
      type: 'array',
      items: parsedStopSchema()
    }
  }
} as const;

function parsedStopSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'order',
      'name',
      'note',
      'city',
      'province',
      'countryCode',
      'district',
      'locationHint',
      'time',
      'category',
      'activity',
      'arrival'
    ],
    properties: {
      order: { type: 'number' },
      name: { type: 'string' },
      note: { type: 'string' },
      city: { type: 'string' },
      province: { type: 'string' },
      countryCode: { type: 'string' },
      district: { type: 'string' },
      locationHint: { type: 'string' },
      time: { type: 'string' },
      category: { type: 'string' },
      activity: {
        type: 'object',
        additionalProperties: false,
        required: [
          'kind',
          'source',
          'placeKind',
          'meal',
          'quote',
          'searchName',
          'alsoVisit'
        ],
        properties: {
          kind: { type: 'string', enum: ['visit', 'meal', 'stay'] },
          source: { type: 'string', enum: ['explicit', 'default'] },
          placeKind: { type: 'string', enum: ['venue', 'area'] },
          meal: {
            type: 'string',
            enum: ['breakfast', 'lunch', 'dinner', 'none']
          },
          quote: { type: 'string' },
          searchName: { type: 'string' },
          alsoVisit: { type: 'boolean' }
        }
      },
      arrival: {
        type: 'object',
        additionalProperties: false,
        required: [
          'mode',
          'label',
          'quote',
          'source',
          'confidence',
          'reason',
          'fromName',
          'durationMinutes',
          'distanceKm',
          'departureTime',
          'arrivalTime',
          'steps'
        ],
        properties: {
          mode: {
            type: 'string',
            enum: [
              'auto',
              'walking',
              'driving',
              'transit',
              'rail',
              'ferry',
              'bus',
              'subway',
              'flight'
            ]
          },
          source: { type: 'string', enum: ['explicit', 'inferred', 'unknown'] },
          confidence: { type: 'number' },
          reason: { type: 'string' },
          fromName: { type: 'string' },
          durationMinutes: { type: 'number' },
          distanceKm: { type: 'number' },
          departureTime: { type: 'string' },
          arrivalTime: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'mode',
                'fromName',
                'toName',
                'line',
                'durationMinutes',
                'distanceKm',
                'note'
              ],
              properties: {
                mode: {
                  type: 'string',
                  enum: [
                    'walking',
                    'driving',
                    'bus',
                    'subway',
                    'transit',
                    'rail',
                    'flight',
                    'ferry'
                  ]
                },
                fromName: { type: 'string' },
                toName: { type: 'string' },
                line: { type: 'string' },
                durationMinutes: { type: 'number' },
                distanceKm: { type: 'number' },
                note: { type: 'string' }
              }
            }
          },
          label: { type: 'string' },
          quote: { type: 'string' }
        }
      }
    }
  } as const;
}

export async function parseItinerary(
  input: ParseInput,
  options: ParseOptions = {}
): Promise<ParseResult> {
  const runtime = resolveAiRuntime();
  const { apiKey, model, baseURL } = runtime;

  if (!apiKey || !model) {
    if (input.image) {
      throw new Error(
        '截图识别需要先在服务设置中配置行程解析模型、API 地址和密钥。'
      );
    }

    const itinerary = normalizeParsedItinerary(
      cleanParsedItinerary(localParse(input.text || ''), input.text || '')
    );
    assertMainlandItinerary(itinerary);
    return {
      itinerary,
      source: 'local-fallback',
      warning: '未配置文本解析模型，已使用本地规则解析。'
    };
  }

  try {
    const client = new OpenAI({
      apiKey,
      baseURL,
      timeout: 120000,
      maxRetries: 1
    });

    options.onProgress?.({
      type: 'status',
      message: input.image
        ? '行程解析模型已连接，正在识别截图...'
        : '行程解析模型已连接，正在解析文字...'
    });
    const jsonText = await parseWithOpenAI(
      client,
      model,
      input,
      baseURL,
      options
    );
    options.onProgress?.({
      type: 'progress',
      message: '模型返回完成，正在校验结构化结果...'
    });
    const parsed = parseModelJson(jsonText) as ParsedItinerary;
    if (parsed.serviceRegion !== 'CN_MAINLAND')
      throw new HttpError(422, MAINLAND_ONLY_MESSAGE + '请提供明确的中国大陆目的地。');
    // Check the raw stops as well: cleanup must not erase an unsupported place.
    assertMainlandItinerary(normalizeParsedItinerary(parsed));
    const cleaned = completeDailyActivities(
      cleanParsedItinerary(parsed, input.text || '')
    );
    assertUsableAiParse(cleaned, input.text || '');
    const itinerary = normalizeParsedItinerary(cleaned);
    assertMainlandItinerary(itinerary);
    return {
      itinerary,
      source: 'openai'
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (input.image && isUnsupportedImageError(error)) {
      throw new Error(
        '截图识别失败：当前行程解析模型不支持图片输入，请在服务设置中选择支持图文输入的模型。'
      );
    }
    throw new Error(
      `${input.image ? '截图识别' : '文字行程'}解析失败：${message}`
    );
  }
}

export function resolveAiRuntime(): AiRuntime {
  return {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
    baseURL: process.env.OPENAI_BASE_URL || undefined
  };
}

function hasOpenAiRuntime(): boolean {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
}

export function hasConfiguredAiRuntime(): boolean {
  return hasOpenAiRuntime();
}

function countExplicitDays(rawText: string): number {
  const matches = rawText.match(
    /(?:^|\n)\s*(?:第\s*\d+\s*天|Day\s*\d+|D\s*\d+)(?=\s|[：:|｜.)、-]|$)/gi
  );
  return matches
    ? new Set(matches.map((match) => match.replace(/\D/g, ''))).size
    : 0;
}

function assertUsableAiParse(parsed: ParsedItinerary, rawText: string): void {
  const parsedDayCount = (parsed.days || []).filter(
    (day) => (day.stops?.length || 0) > 0
  ).length;
  const explicitDayCount = countExplicitDays(rawText);
  if (parsedDayCount === 0) {
    throw new Error('AI parser returned no usable travel days.');
  }
  if (explicitDayCount > 0 && parsedDayCount < explicitDayCount) {
    throw new Error(
      `AI parser returned ${parsedDayCount} travel days, expected at least ${explicitDayCount}.`
    );
  }
}

async function parseWithOpenAI(
  client: OpenAI,
  model: string,
  input: ParseInput,
  baseURL?: string,
  options: ParseOptions = {}
): Promise<string> {
  if (options.stream && shouldPreferChatCompletions(baseURL)) {
    return parseWithChatCompletionsStream(
      client,
      model,
      input,
      baseURL,
      options.onProgress
    );
  }

  if (shouldPreferChatCompletions(baseURL)) {
    try {
      return await parseWithChatCompletions(client, model, input, baseURL);
    } catch (chatError) {
      if (!shouldTryResponsesFallback(chatError)) throw chatError;
      return parseWithResponses(client, model, input);
    }
  }

  try {
    return await parseWithResponses(client, model, input);
  } catch (error) {
    if (!shouldTryChatFallback(error)) throw error;
    return parseWithChatCompletions(client, model, input, baseURL);
  }
}

async function parseWithChatCompletionsStream(
  client: OpenAI,
  model: string,
  input: ParseInput,
  baseURL: string | undefined,
  onProgress?: (event: ParseProgressEvent) => void
): Promise<string> {
  try {
    return await parseWithChatCompletionsStreamUsingFormat(
      client,
      model,
      input,
      baseURL,
      onProgress,
      { type: 'json_object' }
    );
  } catch (error) {
    if (
      (input.image && isUnsupportedImageError(error)) ||
      !shouldRetryWithoutJsonSchema(error)
    )
      throw error;
  }

  return parseWithChatCompletionsStreamUsingFormat(
    client,
    model,
    input,
    baseURL,
    onProgress
  );
}

async function parseWithChatCompletionsStreamUsingFormat(
  client: OpenAI,
  model: string,
  input: ParseInput,
  baseURL: string | undefined,
  onProgress?: (event: ParseProgressEvent) => void,
  responseFormat?: unknown
): Promise<string> {
  const stream = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: `${buildParserInstructions()}\nReturn only one JSON object. Do not wrap it in Markdown.`
      },
      {
        role: 'user',
        content: buildChatInputContent(input) as any
      }
    ],
    temperature: 0,
    max_tokens: 32768,
    stream: true,
    ...(responseFormat ? { response_format: responseFormat as any } : {})
  } as any);

  let text = '';
  let sawReasoning = false;
  let sawContent = false;
  let lastProgressAt = 0;

  for await (const chunk of stream as any) {
    if (chunk?.choices?.[0]?.finish_reason === 'length')
      throw new Error(
        '模型输出达到长度上限，请缩短行程或提高模型输出限制后重试，未保存不完整行程。'
      );
    const delta = chunk?.choices?.[0]?.delta || {};
    const reasoningDelta = extractReasoningDelta(delta);
    if (reasoningDelta && !sawReasoning) {
      sawReasoning = true;
      onProgress?.({
        type: 'progress',
        message: input.image
          ? '模型正在识别截图中的日期、路线和地点关系...'
          : '模型正在分析文本行程结构，判断日期、地点和游玩顺序...'
      });
    }

    const contentDelta = extractContentDelta(delta);
    if (!contentDelta) continue;
    text += contentDelta;

    const now = Date.now();
    if (!sawContent) {
      sawContent = true;
      onProgress?.({
        type: 'progress',
        message: '模型开始返回结构化行程，正在接收结果...',
        receivedChars: text.length
      });
      lastProgressAt = now;
    } else if (now - lastProgressAt > 1200) {
      onProgress?.({
        type: 'progress',
        message: `正在接收结构化结果，已收到 ${text.length} 个字符...`,
        receivedChars: text.length
      });
      lastProgressAt = now;
    }
  }

  if (!text.trim()) throw new Error('Streaming parser returned empty content.');
  return text;
}

function extractReasoningDelta(delta: Record<string, unknown>): string {
  const candidates = [
    delta.reasoning_content,
    delta.reasoning,
    delta.reasoningContent
  ];
  return (
    candidates.find(
      (value): value is string => typeof value === 'string' && value.length > 0
    ) || ''
  );
}

function extractContentDelta(delta: Record<string, unknown>): string {
  const content = delta.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof part.text === 'string'
      )
        return part.text;
      return '';
    })
    .join('');
}

async function parseWithResponses(
  client: OpenAI,
  model: string,
  input: ParseInput
): Promise<string> {
  try {
    const response = await client.responses.create({
      model,
      instructions: buildParserInstructions(),
      input: [
        {
          role: 'user',
          content: buildResponseInputContent(input)
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'itinerary_parse',
          schema: parseSchema,
          strict: true
        }
      }
    });

    return response.output_text;
  } catch (error) {
    throw error;
  }
}

async function parseWithChatCompletions(
  client: OpenAI,
  model: string,
  input: ParseInput,
  baseURL?: string
): Promise<string> {
  if (shouldPreferChatCompletions(baseURL)) {
    try {
      return await parseWithChatCompletionsUsingFormat(
        client,
        model,
        input,
        baseURL,
        { type: 'json_object' }
      );
    } catch (error) {
      if (
        (input.image && isUnsupportedImageError(error)) ||
        !shouldRetryWithoutJsonSchema(error)
      )
        throw error;
      return parseWithChatCompletionsUsingFormat(client, model, input, baseURL);
    }
  }

  try {
    return await parseWithChatCompletionsUsingFormat(
      client,
      model,
      input,
      baseURL,
      {
        type: 'json_schema',
        json_schema: {
          name: 'itinerary_parse',
          schema: parseSchema,
          strict: true
        }
      }
    );
  } catch (error) {
    if (
      (input.image && isUnsupportedImageError(error)) ||
      !shouldRetryWithoutJsonSchema(error)
    )
      throw error;
  }

  try {
    return await parseWithChatCompletionsUsingFormat(
      client,
      model,
      input,
      baseURL,
      { type: 'json_object' }
    );
  } catch (error) {
    if (
      (input.image && isUnsupportedImageError(error)) ||
      !shouldRetryWithoutJsonSchema(error)
    )
      throw error;
  }

  return parseWithChatCompletionsUsingFormat(client, model, input, baseURL);
}

async function parseWithChatCompletionsUsingFormat(
  client: OpenAI,
  model: string,
  input: ParseInput,
  baseURL?: string,
  responseFormat?: unknown
): Promise<string> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: `${buildParserInstructions()}\nReturn only one JSON object. Do not wrap it in Markdown.`
      },
      {
        role: 'user',
        content: buildChatInputContent(input) as any
      }
    ],
    temperature: 0,
    max_tokens: 32768,
    ...(responseFormat ? { response_format: responseFormat as any } : {})
  } as any);

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error('Chat Completions parser returned empty content.');
  return text;
}

function shouldPreferChatCompletions(baseURL?: string): boolean {
  if (!baseURL) return false;
  try {
    const host = new URL(baseURL).host;
    return !/(^|\.)openai\.com$/.test(host);
  } catch {
    return true;
  }
}

function shouldTryChatFallback(error: unknown): boolean {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: number }).status
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return (
    status === 404 ||
    /404|not found|unsupported|unknown endpoint/i.test(message)
  );
}

function shouldTryResponsesFallback(error: unknown): boolean {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: number }).status
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return (
    status === 404 ||
    status === 405 ||
    /not found|unknown endpoint/i.test(message)
  );
}

function isUnsupportedImageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /image|vision|multimodal|图片|图像/i.test(message) &&
    /not.support|unsupported|not.accept|text.only|unrecognized|unknown.type/i.test(
      message
    )
  );
}

function shouldRetryWithoutJsonSchema(error: unknown): boolean {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: number }).status
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return (
    status === 400 ||
    /response_format|json_schema|schema|unsupported|invalid/i.test(message)
  );
}

function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(withoutFence.slice(start, end + 1));
    }
    throw new Error('Model did not return valid JSON.');
  }
}

function buildParserInstructions(): string {
  return [
    '你是行程解析器。只输出一个 JSON object，不要 Markdown，不要解释。',
    '目标：把用户文本中的“正式每日游玩路线”解析为结构化行程。',
    '必须保留用户语言，不翻译地点名、标题或备注。',
    'title 必须是整趟旅行的短标题，例如“宁波 3 日亲子行程”“杭州三日懒人逛吃攻略”；不要复制第一天的长句、交通句或完整路线。',
    'day.title 必须是当天短主题或区域，例如“南部片区到老外滩”“西湖经典线”；不要把当天所有 stop、时间、交通方式都写进标题。',
    '必须判断 tripScope：按实际行政目的地判断是否跨城，不能凭自驾、环岛、环线或分三天就判为multi_city。岛内南线北线仍可能single_city，车站/机场离开或推荐返程城市不能反向污染所有景点。证据不足时unknown。',
    '服务目前只支持中国大陆目的地。必须输出 serviceRegion：所有实际目的地（含备选、吃住推荐和出入境交通端点）明确位于中国大陆时为 CN_MAINLAND；含港澳台或海外目的地为 UNSUPPORTED；无法确认则 UNKNOWN。遇到不支持的地点仍完整保留，不删除、改成国内同名地或伪造省市。餐厅品牌、菜系或酒店名称出现国家词不等于海外旅行。',
    '每个地点必须提取 countryCode（ISO 两位代码，中国大陆 CN，香港 HK，澳门 MO，台湾 TW，其他如 JP、US；未知留空）和省市。中国大陆地点尽量补全真实 province，即使推荐餐馆和住宿也不能省略。',
    'tripScope.primaryCity 只在 single_city 时填写主城市；multi_city 或 unknown 时填空字符串。tripScope.cities 填明确涉及的城市/州/县级目的地，按行程顺序去重。',
    '只提取真实路线 stop：景点、博物馆、公园、寺庙、街区、商场、夜市、车站、机场、明确作为路线点的酒店等。',
    '天气/预约/价格等是原文建议，放 note 并注明原文信息，不要补写或验证当前政策，不要作为地点。住宿区域推荐必须保留在 recommendations.lodging；只给片区时 placeKind=area，searchName 用明确区域锚点如龙翔桥，不得虚构酒店。',
    'recommendations.lodging/dining 的每一项与 days.stops 使用相同的完整结构，placeKind 和 searchName 必须嵌套在 activity 内，不能放在推荐项顶层。',
    '餐厅推荐按原文顺序放 recommendations.dining，其他餐厅可同时放 alternatives。明确的午饭/晚饭地点放当天 activityOptions 中，默认不加入 stops；只有满觉陇农家菜等区域时用满觉陇、placeKind=area，不得虚构餐馆。推荐清单只保留候选，绝不自动选第一家。所有 meal/stay 都是用户按需加入的 activityOptions，stops 默认只保留游览和正式交通节点。满觉陇赏桂兼午饭时 stops 保留满觉陇 visit，activityOptions 单独保留满觉陇 meal，不能因去掉吃饭就漏掉赏桂；夜市如以逛街游览为目的也保留 visit。',
    '每个地点必须尽可能提取 province（省/自治区）、city（市/州）、district（区/县）、locationHint（景区/乡镇等上下文），与 name 分开保存。省市区来自原文或可信地理上下文，不能确定就留空，不要虚构。岛县不能丢失，例如福建省、福州市、平潭县、北港村；推荐和可选活动也保留相同上下文。城市不能因全局multi_city就清空。',
    '跨城、自驾、环线、路书类行程不要把出发地或返程地当成所有 stop.city；如果不能确定某个地点所属城市，city 留空；能确定时给每个 stop 写自己的城市/州/县级上下文。',
    '如果出现“Day1：A→B→C”或“D1 A -> B -> C”，必须拆成 day.stops: A, B, C。',
    '如果出现编号行“1. 14:00-16:00 周尧昆虫博物馆（8号线直达）”，stop.name 只写“周尧昆虫博物馆”，time 写“14:00-16:00”，括号和预约/交通信息放 note。',
    'arrival 表示从上一个地点到当前地点的交通，原文有手摇船/摇橹船/水上巴士/轮渡必须 mode=ferry，label 保留船型/航线，quote 引用原文证据。如码头→乌龟潭→茅家埠，两个目的地的 arrival 都是 ferry；武林门码头→拱宸桥也是 ferry。不要靠距离把船程改成车程。其他明确步行/地铁/高铁分别 walking/transit/rail；包括跨天：第二天第一站的 arrival 起点必须是前一天最后一个主线 stops 地点，默认忽略未加入的餐宿。没有明确交通但能结合原文整体策略和地点关系合理推断的，尽量选择具体 mode，source=inferred，说明 reason 和 confidence；确实无法判断才 auto/unknown。驾车 driving、公交 bus、地铁 subway、铁路 rail、飞机 flight、船 ferry 必须区分；原文只说地铁+步行可推断以地铁为主，不能编造具体线路。',
    'arrival.fromName 写实际上一主线地点名，source=explicit/inferred/unknown；confidence 0到1，reason 判断理由，quote 仅摘录原文（推断不能伪装引用）。保留有依据的 durationMinutes、distanceKm、departureTime、arrivalTime，不知道的数值为0，不得虚构。steps 保存按先后排序的接驳、公交/地铁线路名、上/下站、铁路车次或船型；只填写原文已给的信息，推断步骤必须在 note 明示。跨天的起点同样必须衔接上一天，绝不能把第一站 arrival 全部留空。',
    'activity.kind=visit/meal/stay，source=explicit（原文明确）或 default（推荐选择），placeKind=venue/area，meal=breakfast/lunch/dinner/none，quote 是不超过60字的原文证据，searchName 是单个可检索地名。远观雷峰塔不属于登塔行程，不应添加到实际路线。二选一默认第一条方案为主路线，第二方案保留在当天 alternatives 并在 note 标注方案，不要串成同一天的必去行程。',
    '按原文 day 顺序输出。原文有 Day1/Day2/Day3 时，输出这些 travel days，不要把前言或推荐区变成额外 day。',
    '输出 schema: { title: string, language: string, dateRange: {start:string,end:string,label:string}, tripScope:{mode:string,primaryCity:string,cities:string[],confidence:number,reason:string}, recommendations:{lodging:[],dining:[]}, days: [{dayIndex:number,date:string,title:string,activityOptions:[],stops:[{order:number,name:string,note:string,province:string,city:string,district:string,locationHint:string,time:string,category:string,activity:{kind:string,source:string,placeKind:string,meal:string,quote:string,searchName:string},arrival:{mode:string,label:string,quote:string}}],alternatives:[]}], alternatives: [] }。',
    'JSON保持紧凑，note和reason每项尽量控制在40字内；交通未知字段省略，不必为每个推荐餐厅输出空arrival或重复大段说明。推荐列表保留name、countryCode、province、city、note和activity。顶层必须包含serviceRegion，所有地点保留countryCode。',
    '缺失字段用空字符串或空数组，不要用 null。'
  ].join('\n');
}

function buildResponseInputContent(input: ParseInput) {
  const content: Array<
    | { type: 'input_text'; text: string }
    | { type: 'input_image'; image_url: string; detail: 'auto' }
  > = [
    {
      type: 'input_text',
      text:
        `Parse this itinerary. It may be plain text, Markdown, a copied table, or notes.\n\n` +
        (input.text?.trim() ||
          '(No text was provided; parse the attached image.)')
    }
  ];

  if (input.image) {
    const base64 = input.image.buffer.toString('base64');
    content.push({
      type: 'input_image',
      image_url: `data:${input.image.mimeType};base64,${base64}`,
      detail: 'auto'
    });
  }

  return content;
}

function buildChatInputContent(input: ParseInput) {
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail: 'auto' } }
  > = [
    {
      type: 'text',
      text:
        `Parse this itinerary. It may be plain text, Markdown, a copied table, or notes.\n\n` +
        (input.text?.trim() ||
          '(No text was provided; parse the attached image.)')
    }
  ];

  if (input.image) {
    const base64 = input.image.buffer.toString('base64');
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${input.image.mimeType};base64,${base64}`,
        detail: 'auto'
      }
    });
  }

  return content;
}

export function localParse(rawText: string): ParsedItinerary {
  const text = rawText.trim();
  if (!text) {
    return {
      title: 'Untitled itinerary',
      language: 'auto',
      dateRange: { start: '', end: '', label: '' },
      tripScope: {
        mode: 'unknown',
        primaryCity: '',
        cities: [],
        confidence: 0,
        reason: ''
      },
      days: [],
      alternatives: []
    };
  }

  const lines = text
    .replace(/\\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .split(/\n+/)
    .map((line) => line.replace(/\|/g, '\t').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const title = findTitle(lines);
  const days: NonNullable<ParsedItinerary['days']> = [];
  let currentDay: ParsedDay | null = null;
  let inRouteSection = false;

  for (const line of lines) {
    if (isContextSectionHeading(line)) {
      inRouteSection = false;
      currentDay = null;
      continue;
    }

    const inlineDayRoute = parseInlineDayRoute(line);
    if (inlineDayRoute) {
      if (
        currentDay &&
        ((currentDay.stops?.length || 0) > 0 ||
          (currentDay.alternatives?.length || 0) > 0)
      ) {
        days.push(currentDay);
      }
      currentDay = createParsedDay(
        inlineDayRoute.dayIndex,
        inlineDayRoute.heading
      );
      currentDay.stops = inlineDayRoute.stops;
      inRouteSection = true;
      continue;
    }

    const dayNumber = parseDayHeading(line);
    if (dayNumber) {
      if (
        currentDay &&
        ((currentDay.stops?.length || 0) > 0 ||
          (currentDay.alternatives?.length || 0) > 0)
      ) {
        days.push(currentDay);
      }
      currentDay = createParsedDay(dayNumber, line);
      inRouteSection = true;
      continue;
    }

    if (!currentDay || !inRouteSection) continue;
    const stop = parseLineAsStop(line, (currentDay.stops?.length || 0) + 1);
    if (stop) currentDay.stops?.push(stop);
  }

  if (
    currentDay &&
    ((currentDay.stops?.length || 0) > 0 ||
      (currentDay.alternatives?.length || 0) > 0)
  ) {
    days.push(currentDay);
  }

  return {
    title,
    language: /[\u4e00-\u9fa5]/.test(text) ? 'zh-CN' : 'auto',
    dateRange: { start: '', end: '', label: '' },
    tripScope: {
      mode: 'unknown',
      primaryCity: '',
      cities: [],
      confidence: 0,
      reason: ''
    },
    days,
    alternatives: []
  };
}

function isContextSectionHeading(line: string): boolean {
  return (
    /(?:住宿|酒店|美食|餐厅|交通|地铁|天气|提示|注意|推荐|攻略|说明|费用|门票)/.test(
      line
    ) &&
    !/^(?:day|d)\s*\d+/i.test(line) &&
    !/[→>]/.test(line)
  );
}

function parseInlineDayRoute(line: string): {
  dayIndex: number;
  heading: string;
  stops: NonNullable<ParsedDay['stops']>;
} | null {
  const match = line.match(
    /^\s*(?:(?:day|d)\s*(\d{1,2})|第\s*(\d{1,2})\s*天)\s*[：:|｜-]?\s*(.+)$/i
  );
  const dayIndex = Number(match?.[1] || match?.[2]);
  const rest = match?.[3]?.trim();
  if (!dayIndex || !rest || !/[→>]/.test(rest)) return null;

  const stops = rest
    .split(/\s*(?:→|->|>)\s*/)
    .map((name, index) => parseLineAsStop(name, index + 1))
    .filter((stop): stop is NonNullable<ReturnType<typeof parseLineAsStop>> =>
      Boolean(stop)
    );

  if (stops.length === 0) return null;
  return {
    dayIndex,
    heading: `Day ${dayIndex}`,
    stops
  };
}

function findTitle(lines: string[]): string {
  if (lines[0] && parseDayHeading(lines[0])) {
    return lines[0].replace(/^#+\s*/, '').slice(0, 42);
  }
  const firstMeaningful = lines.find((line) => !parseDayHeading(line));
  return (
    (firstMeaningful || lines[0])?.replace(/^#+\s*/, '').slice(0, 42) ||
    'Untitled itinerary'
  );
}

function createParsedDay(dayIndex: number, heading?: string): ParsedDay {
  return {
    dayIndex,
    date: extractDate(heading || ''),
    title: heading?.replace(/^#+\s*/, '') || `Day ${dayIndex}`,
    stops: [],
    alternatives: []
  };
}

function parseDayHeading(line: string): number | null {
  const match = line.match(/(?:^|\s)(?:d|day|第)\s*(\d{1,2})\s*(?:天|日)?/i);
  if (match) return Number(match[1]);
  if (/第一天/.test(line)) return 1;
  if (/第二天/.test(line)) return 2;
  if (/第三天/.test(line)) return 3;
  return null;
}

function extractDate(line: string): string {
  return line.match(/\d{1,2}[月/-]\d{1,2}[日号]?/)?.[0] || '';
}

function parseLineAsStop(line: string, order: number) {
  const cleaned = line
    .replace(/^[-*+]\s*/, '')
    .replace(/^\d+[.)、]\s*/, '')
    .trim();

  if (!cleaned || parseDayHeading(cleaned)) return null;
  if (/^(title|date|day|日期|时间|地点|备注)\b/i.test(cleaned)) return null;

  const cells = cleaned
    .split(/\t+/)
    .map((cell) => cell.trim())
    .filter(Boolean);
  const firstCell = cells[0]?.replace(/^#+\s*/, '') || '';
  const [namePart, ...noteParts] = firstCell.split(/\s[-—:：]\s/);
  const name = namePart.trim();
  if (!name || name.length < 2) return null;

  return {
    order,
    name,
    note: [...noteParts, ...cells.slice(1)].join(' · ') || '',
    city: '',
    time: '',
    category: ''
  };
}
