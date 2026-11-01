import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  construct: vi.fn(),
  chat: vi.fn(),
  responses: vi.fn()
}));
vi.mock('openai', () => ({
  default: class {
    constructor(options: unknown) {
      sdk.construct(options);
    }
    chat = { completions: { create: sdk.chat } };
    responses = { create: sdk.responses };
  }
}));
import { hasConfiguredAiRuntime, parseItinerary } from './openaiParser';

const parsed = {
  title: '武汉一日游',
  serviceRegion: 'CN_MAINLAND',
  language: 'zh-CN',
  dateRange: { start: '', end: '', label: '' },
  tripScope: {
    mode: 'single_city',
    primaryCity: '武汉',
    cities: ['武汉'],
    confidence: 1,
    reason: ''
  },
  days: [
    {
      dayIndex: 1,
      date: '',
      title: '武汉一日游',
      stops: [
        { order: 1, name: '湖北省博物馆', province: '湖北省', city: '武汉', countryCode: 'CN' },
        { order: 2, name: '东湖绿道', province: '湖北省', city: '武汉', countryCode: 'CN' }
      ],
      alternatives: []
    }
  ],
  alternatives: []
};
const image = {
  buffer: Buffer.from('image fixture bytes'),
  mimeType: 'image/png'
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('OPENAI_API_KEY', 'shared-parser-key');
  vi.stubEnv('OPENAI_MODEL', 'deepseek-flash');
  vi.stubEnv('OPENAI_BASE_URL', 'https://api.deepseek.com');
  vi.stubEnv('ARK_API_KEY', 'retired-vision-key');
  vi.stubEnv('ARK_IMAGE_MODEL', 'retired-vision-model');
  vi.stubEnv('ARK_BASE_URL', 'https://retired.invalid');
  sdk.chat.mockImplementation(async (request) =>
    request.stream
      ? (async function* () {
          yield { choices: [{ delta: { content: JSON.stringify(parsed) } }] };
        })()
      : { choices: [{ message: { content: JSON.stringify(parsed) } }] }
  );
});
afterEach(() => vi.unstubAllEnvs());

it('uses the same endpoint, credentials and model for text and screenshots in regular and streaming requests', async () => {
  for (const stream of [false, true]) {
    for (const withImage of [false, true]) {
      const result = await parseItinerary(
        {
          text: withImage ? '' : '武汉一日游',
          ...(withImage ? { image } : {})
        },
        { stream }
      );
      expect(result.source).toBe('openai');
      expect(result.itinerary.days[0].stops.map((stop) => stop.name)).toEqual([
        '湖北省博物馆',
        '东湖绿道'
      ]);
      const runtime = sdk.construct.mock.calls.at(-1)![0];
      expect(runtime).toMatchObject({
        apiKey: 'shared-parser-key',
        baseURL: 'https://api.deepseek.com'
      });
      expect(JSON.stringify(runtime)).not.toContain('retired');
      const request = sdk.chat.mock.calls.at(-1)![0];
      expect(request.model).toBe('deepseek-flash');
      const content = request.messages[1].content;
      expect(
        content.filter((part: { type: string }) => part.type === 'image_url')
      ).toEqual(
        withImage
          ? [
              {
                type: 'image_url',
                image_url: {
                  url:
                    'data:image/png;base64,' + image.buffer.toString('base64'),
                  detail: 'auto'
                }
              }
            ]
          : []
      );
    }
  }
  expect(sdk.responses).not.toHaveBeenCalled();
});

it('does not use old image credentials when the shared runtime is missing', async () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  expect(hasConfiguredAiRuntime()).toBe(false);
  await expect(parseItinerary({ image })).rejects.toThrow('配置行程解析模型');
  await expect(parseItinerary({ text: 'Day 1 东京\n浅草寺 → 东京塔' }))
    .rejects.toThrow('仅支持中国大陆');
  expect(sdk.construct).not.toHaveBeenCalled();
});

it('rejects unsupported and uncertain model results for text and screenshots, including streams', async () => {
  for (const stream of [false, true]) for (const withImage of [false, true]) {
    const result = { ...parsed, serviceRegion: 'UNSUPPORTED' };
    sdk.chat.mockImplementation(async (request) => request.stream
      ? (async function* () { yield { choices: [{ delta: { content: JSON.stringify(result) } }] }; })()
      : { choices: [{ message: { content: JSON.stringify(result) } }] });
    await expect(parseItinerary({ text: '北京和东京旅行', ...(withImage ? { image } : {}) }, { stream }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining('仅支持中国大陆') });
  }
  for (const serviceRegion of ['UNKNOWN', undefined]) {
    sdk.chat.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...parsed, serviceRegion }) } }] });
    await expect(parseItinerary({ text: '行程' })).rejects.toMatchObject({ status: 422 });
  }
});

it('checks countries on raw stops even if the model marks the overall trip as mainland', async () => {
  const foreign = structuredClone(parsed);
  foreign.days[0].stops.push({ order: 3, name: '浅草寺', countryCode: 'JP', province: '东京都', city: '东京' });
  sdk.chat.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(foreign) } }] });
  await expect(parseItinerary({ text: '武汉和东京' })).rejects.toMatchObject({ status: 422 });
});

it('reports unsupported image input without retrying other models or dropping the screenshot', async () => {
  sdk.chat.mockRejectedValue(
    Object.assign(new Error('This model does not support image input'), {
      status: 400
    })
  );
  await expect(parseItinerary({ image }, { stream: true })).rejects.toThrow(
    '当前行程解析模型不支持图片输入'
  );
  expect(sdk.chat).toHaveBeenCalledTimes(1);
  expect(sdk.responses).not.toHaveBeenCalled();
});

it('keeps the shared model and image payload when retrying an unsupported JSON format', async () => {
  sdk.chat.mockRejectedValueOnce(
    Object.assign(new Error('response_format is unsupported'), { status: 400 })
  );
  await parseItinerary({ image });
  expect(sdk.chat).toHaveBeenCalledTimes(2);
  for (const [request] of sdk.chat.mock.calls) {
    expect(request.model).toBe('deepseek-flash');
    expect(request.messages[1].content[1].image_url.url).toContain(
      image.buffer.toString('base64')
    );
  }
});
