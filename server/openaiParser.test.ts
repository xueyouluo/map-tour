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
        { order: 1, name: '湖北省博物馆', city: '武汉' },
        { order: 2, name: '东湖绿道', city: '武汉' }
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
  expect(
    (await parseItinerary({ text: '武汉一日游\n湖北省博物馆 → 东湖绿道' }))
      .source
  ).toBe('local-fallback');
  expect(sdk.construct).not.toHaveBeenCalled();
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
