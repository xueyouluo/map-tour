import OpenAI from 'openai';
import { normalizeParsedItinerary, type ParsedDay, type ParsedItinerary } from '../src/shared/itinerary';
import { cleanParsedItinerary } from './itineraryCleanup';

export interface ParseInput {
  text?: string;
  image?: {
    buffer: Buffer;
    mimeType: string;
  };
}

export interface ParseResult {
  itinerary: ReturnType<typeof normalizeParsedItinerary>;
  source: 'openai' | 'ark' | 'local-fallback';
  warning?: string;
}

export interface ParseProgressEvent {
  type: 'status' | 'progress';
  message: string;
  receivedChars?: number;
}

type AiProvider = 'openai' | 'ark';

interface AiRuntime {
  provider: AiProvider;
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
  required: ['title', 'language', 'dateRange', 'days', 'alternatives'],
  properties: {
    title: { type: 'string' },
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
    days: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['dayIndex', 'date', 'title', 'stops', 'alternatives'],
        properties: {
          dayIndex: { type: 'number' },
          date: { type: 'string' },
          title: { type: 'string' },
          stops: {
            type: 'array',
            items: parsedStopSchema()
          },
          alternatives: {
            type: 'array',
            items: parsedStopSchema()
          }
        }
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
    required: ['order', 'name', 'note', 'city', 'time', 'category'],
    properties: {
      order: { type: 'number' },
      name: { type: 'string' },
      note: { type: 'string' },
      city: { type: 'string' },
      time: { type: 'string' },
      category: { type: 'string' }
    }
  } as const;
}

export async function parseItinerary(input: ParseInput, options: ParseOptions = {}): Promise<ParseResult> {
  const runtime = resolveAiRuntime(input);
  const { apiKey, model, baseURL } = runtime;

  if (!apiKey || !model) {
    if (input.image) {
      throw new Error('Image parsing requires ARK_API_KEY and an Ark vision model.');
    }

    return {
      itinerary: normalizeParsedItinerary(cleanParsedItinerary(localParse(input.text || ''), input.text || '')),
      source: 'local-fallback',
      warning: 'AI API key or model is missing; used local fallback parsing.'
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
      message: runtime.provider === 'ark' ? '视觉理解模型已连接，正在分析图片...' : '文本模型已连接，正在解析行程...'
    });
    const jsonText = await parseWithOpenAI(client, model, input, baseURL, options);
    options.onProgress?.({
      type: 'progress',
      message: '模型返回完成，正在校验结构化结果...'
    });
    const parsed = parseModelJson(jsonText) as ParsedItinerary;
    const cleaned = cleanParsedItinerary(parsed, input.text || '');
    assertUsableAiParse(cleaned, input.text || '');
    return {
      itinerary: normalizeParsedItinerary(cleaned),
      source: runtime.provider
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${runtime.provider === 'ark' ? 'Ark vision' : 'OpenAI'} parsing failed: ${message}`);
  }
}

function resolveAiRuntime(input: ParseInput): AiRuntime {
  if (input.image) {
    return {
      provider: 'ark',
      apiKey: process.env.ARK_API_KEY,
      model: process.env.ARK_IMAGE_MODEL || process.env.ARK_MODEL || 'doubao-seed-2-1-pro-260628',
      baseURL: process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
    };
  }

  return {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
    baseURL: process.env.OPENAI_BASE_URL || undefined
  };
}

function hasOpenAiRuntime(): boolean {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
}

export function hasConfiguredAiRuntime(): boolean {
  return hasOpenAiRuntime() || Boolean(process.env.ARK_API_KEY);
}

function countExplicitDays(rawText: string): number {
  const matches = rawText.match(/(?:^|\n)\s*(?:第\s*\d+\s*天|Day\s*\d+|D\s*\d+)(?=\s|[：:|｜.)、-]|$)/gi);
  return matches ? new Set(matches.map((match) => match.replace(/\D/g, ''))).size : 0;
}

function assertUsableAiParse(parsed: ParsedItinerary, rawText: string): void {
  const parsedDayCount = (parsed.days || []).filter((day) => (day.stops?.length || 0) > 0).length;
  const explicitDayCount = countExplicitDays(rawText);
  if (parsedDayCount === 0) {
    throw new Error('AI parser returned no usable travel days.');
  }
  if (explicitDayCount > 0 && parsedDayCount < explicitDayCount) {
    throw new Error(`AI parser returned ${parsedDayCount} travel days, expected at least ${explicitDayCount}.`);
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
    return parseWithChatCompletionsStream(client, model, input, baseURL, options.onProgress);
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
    return await parseWithChatCompletionsStreamUsingFormat(client, model, input, baseURL, onProgress, { type: 'json_object' });
  } catch (error) {
    if (!shouldRetryWithoutJsonSchema(error)) throw error;
  }

  return parseWithChatCompletionsStreamUsingFormat(client, model, input, baseURL, onProgress);
}

async function parseWithChatCompletionsStreamUsingFormat(
  client: OpenAI,
  model: string,
  input: ParseInput,
  baseURL: string | undefined,
  onProgress?: (event: ParseProgressEvent) => void,
  responseFormat?: unknown
): Promise<string> {
  const providerOptions = getChatProviderOptions(baseURL);
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
    max_tokens: 8192,
    stream: true,
    ...(responseFormat ? { response_format: responseFormat as any } : {}),
    ...providerOptions
  } as any);

  let text = '';
  let sawReasoning = false;
  let sawContent = false;
  let lastProgressAt = 0;

  for await (const chunk of stream as any) {
    const delta = chunk?.choices?.[0]?.delta || {};
    const reasoningDelta = extractReasoningDelta(delta);
    if (reasoningDelta && !sawReasoning) {
      sawReasoning = true;
      onProgress?.({
        type: 'progress',
        message: input.image
          ? '模型正在进行低强度推理，识别图片中的日期、路线和地点关系...'
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
  return candidates.find((value): value is string => typeof value === 'string' && value.length > 0) || '';
}

function extractContentDelta(delta: Record<string, unknown>): string {
  const content = delta.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

async function parseWithResponses(client: OpenAI, model: string, input: ParseInput): Promise<string> {
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

async function parseWithChatCompletions(client: OpenAI, model: string, input: ParseInput, baseURL?: string): Promise<string> {
  if (shouldPreferChatCompletions(baseURL)) {
    try {
      return await parseWithChatCompletionsUsingFormat(client, model, input, baseURL, { type: 'json_object' });
    } catch (error) {
      if (!shouldRetryWithoutJsonSchema(error)) throw error;
      return parseWithChatCompletionsUsingFormat(client, model, input, baseURL);
    }
  }

  try {
    return await parseWithChatCompletionsUsingFormat(client, model, input, baseURL, {
      type: 'json_schema',
      json_schema: {
        name: 'itinerary_parse',
        schema: parseSchema,
        strict: true
      }
    });
  } catch (error) {
    if (!shouldRetryWithoutJsonSchema(error)) throw error;
  }

  try {
    return await parseWithChatCompletionsUsingFormat(client, model, input, baseURL, { type: 'json_object' });
  } catch (error) {
    if (!shouldRetryWithoutJsonSchema(error)) throw error;
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
  const providerOptions = getChatProviderOptions(baseURL);
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
    max_tokens: 8192,
    ...(responseFormat ? { response_format: responseFormat as any } : {}),
    ...providerOptions
  } as any);

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error('Chat Completions parser returned empty content.');
  return text;
}

function getChatProviderOptions(baseURL?: string): Record<string, unknown> {
  if (isVolcesBaseURL(baseURL)) {
    return {
      thinking: { type: process.env.ARK_THINKING_TYPE || 'enabled' },
      reasoning_effort: process.env.ARK_REASONING_EFFORT || 'low'
    };
  }
  return {};
}

function isVolcesBaseURL(baseURL?: string): boolean {
  if (!baseURL) return false;
  try {
    const host = new URL(baseURL).host;
    return /(\.|^)volces\.com$/i.test(host);
  } catch {
    return false;
  }
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
  const status = typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: number }).status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return status === 404 || /404|not found|unsupported|unknown endpoint/i.test(message);
}

function shouldTryResponsesFallback(error: unknown): boolean {
  const status = typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: number }).status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return status === 404 || status === 405 || /not found|unknown endpoint/i.test(message);
}

function shouldRetryWithoutJsonSchema(error: unknown): boolean {
  const status = typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: number }).status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return status === 400 || /response_format|json_schema|schema|unsupported|invalid/i.test(message);
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
    '只提取真实路线 stop：景点、博物馆、公园、寺庙、街区、商场、夜市、车站、机场、明确作为路线点的酒店等。',
    '不要把这些内容解析为每天路线 stop：天气提示、攻略说明、住宿区域推荐、市内交通说明、核心地铁站点、限制说明、备注、优势、泛泛的回酒店休息。',
    '如果文本包含美食推荐、餐厅推荐、咖啡店、店铺、商场内具体店名等，它们不是每天路线 stop；请放入顶层 alternatives，作为地图推荐点。category 可用 restaurant/shop/cafe。',
    '如果出现“Day1：A→B→C”或“D1 A -> B -> C”，必须拆成 day.stops: A, B, C。',
    '如果出现编号行“1. 14:00-16:00 周尧昆虫博物馆（8号线直达）”，stop.name 只写“周尧昆虫博物馆”，time 写“14:00-16:00”，括号和预约/交通信息放 note。',
    '交通句只在有明确目的地时提取目的地，例如“地铁去老外滩”提取“老外滩”；“地铁回酒店休息”不要提取。',
    '按原文 day 顺序输出。原文有 Day1/Day2/Day3 时，输出这些 travel days，不要把前言或推荐区变成额外 day。',
    '输出 schema: { title: string, language: string, dateRange: {start:string,end:string,label:string}, days: [{dayIndex:number,date:string,title:string,stops:[{order:number,name:string,note:string,city:string,time:string,category:string}],alternatives:[]}], alternatives: [] }。',
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
        (input.text?.trim() || '(No text was provided; parse the attached image.)')
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
        (input.text?.trim() || '(No text was provided; parse the attached image.)')
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
      if (currentDay && ((currentDay.stops?.length || 0) > 0 || (currentDay.alternatives?.length || 0) > 0)) {
        days.push(currentDay);
      }
      currentDay = createParsedDay(inlineDayRoute.dayIndex, inlineDayRoute.heading);
      currentDay.stops = inlineDayRoute.stops;
      inRouteSection = true;
      continue;
    }

    const dayNumber = parseDayHeading(line);
    if (dayNumber) {
      if (currentDay && ((currentDay.stops?.length || 0) > 0 || (currentDay.alternatives?.length || 0) > 0)) {
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

  if (currentDay && ((currentDay.stops?.length || 0) > 0 || (currentDay.alternatives?.length || 0) > 0)) {
    days.push(currentDay);
  }

  return {
    title,
    language: /[\u4e00-\u9fa5]/.test(text) ? 'zh-CN' : 'auto',
    dateRange: { start: '', end: '', label: '' },
    days,
    alternatives: []
  };
}

function isContextSectionHeading(line: string): boolean {
  return /(?:住宿|酒店|美食|餐厅|交通|地铁|天气|提示|注意|推荐|攻略|说明|费用|门票)/.test(line) &&
    !/^(?:day|d)\s*\d+/i.test(line) &&
    !/[→>]/.test(line);
}

function parseInlineDayRoute(line: string): { dayIndex: number; heading: string; stops: NonNullable<ParsedDay['stops']> } | null {
  const match = line.match(/^\s*(?:(?:day|d)\s*(\d{1,2})|第\s*(\d{1,2})\s*天)\s*[：:|｜-]?\s*(.+)$/i);
  const dayIndex = Number(match?.[1] || match?.[2]);
  const rest = match?.[3]?.trim();
  if (!dayIndex || !rest || !/[→>]/.test(rest)) return null;

  const stops = rest
    .split(/\s*(?:→|->|>)\s*/)
    .map((name, index) => parseLineAsStop(name, index + 1))
    .filter((stop): stop is NonNullable<ReturnType<typeof parseLineAsStop>> => Boolean(stop));

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
  return (firstMeaningful || lines[0])?.replace(/^#+\s*/, '').slice(0, 42) || 'Untitled itinerary';
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

  const cells = cleaned.split(/\t+/).map((cell) => cell.trim()).filter(Boolean);
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
