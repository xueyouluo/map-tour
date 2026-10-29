import { requireAdmin } from './authRoutes';
import { isDirectLocalRequest, sameOriginMutation } from './httpSecurity';
export { isDirectLocalRequest as isLocalSettingsRequest } from './httpSecurity';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { SettingField, ServiceSettings } from '../src/shared/settings';

const definitions: Omit<SettingField, 'value' | 'configured'>[] = [
  { key: 'OPENAI_API_KEY', label: 'API Key', secret: true, group: 'text' },
  {
    key: 'OPENAI_BASE_URL',
    label: 'API 地址',
    secret: false,
    group: 'text',
    placeholder: 'https://api.openai.com/v1'
  },
  {
    key: 'OPENAI_MODEL',
    label: '模型名称',
    secret: false,
    group: 'text',
    placeholder: 'deepseek-flash'
  },
  {
    key: 'AMAP_JSAPI_KEY',
    label: '高德 JSAPI Key',
    secret: true,
    group: 'map'
  },
  {
    key: 'AMAP_SECURITY_JS_CODE',
    label: '高德安全密钥',
    secret: true,
    group: 'map'
  },
  {
    key: 'AMAP_MAP_STYLE_ID',
    label: '自定义地图样式 ID',
    secret: false,
    group: 'map',
    placeholder: '32 位样式 ID，留空使用默认浅色地图'
  },
  {
    key: 'VIDEO_EXPORT_ENABLED',
    label: '视频生成',
    secret: false,
    group: 'video',
    choices: ['true', 'false']
  },
  {
    key: 'USER_REGISTRATION_ENABLED',
    label: '允许新用户注册',
    secret: false,
    group: 'users',
    choices: ['true', 'false']
  }
];

// Read old overrides without making them selectable or active for parsing.
const legacyImageKeys = new Set([
  'ARK_API_KEY',
  'ARK_BASE_URL',
  'ARK_IMAGE_MODEL',
  'ARK_MODEL',
  'ARK_THINKING_TYPE',
  'ARK_REASONING_EFFORT'
]);

export class SettingsStore {
  constructor(
    readonly file = path.resolve(
      process.env.SETTINGS_FILE || 'data/local-settings.json'
    ),
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  load() {
    if (!fs.existsSync(this.file)) return;
    const values = this.validate(
      JSON.parse(fs.readFileSync(this.file, 'utf8')),
      true
    );
    Object.assign(this.env, values);
  }

  fields(): SettingField[] {
    return definitions.map((field) => ({
      ...field,
      value: field.secret
        ? ''
        : this.env[field.key] ||
          (field.key === 'USER_REGISTRATION_ENABLED' ? 'true' : ''),
      configured: Boolean(this.env[field.key])
    }));
  }

  validate(input: unknown, allowLegacy = false): Record<string, string> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('配置格式不正确。');
    const result: Record<string, string> = {};
    for (const [key, raw] of Object.entries(input)) {
      if (
        allowLegacy &&
        legacyImageKeys.has(key) &&
        typeof raw === 'string' &&
        raw.length <= 2048 &&
        !/[\r\n\0]/.test(raw)
      ) {
        result[key] = raw;
        continue;
      }
      const field = definitions.find((item) => item.key === key);
      if (
        !field ||
        typeof raw !== 'string' ||
        raw.length > 2048 ||
        /[\r\n\0]/.test(raw)
      )
        throw new Error('包含不支持的配置项或内容。');
      const value = raw.trim();
      if (value && field.choices && !field.choices.includes(value))
        throw new Error(`${field.label}的值不正确。`);
      if (value && key.endsWith('_BASE_URL')) {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new Error('API 地址需要完整的 http 或 https 地址。');
        }
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error('API 地址不能包含密码、查询参数或片段。');
      }
      if (
        value &&
        key === 'AMAP_MAP_STYLE_ID' &&
        !/^(amap:\/\/styles\/)?[a-f\d]{32}$/i.test(value)
      )
        throw new Error('地图样式 ID 应为 32 位。');
      result[key] = value;
    }
    return result;
  }

  save(input: unknown) {
    const updates = this.validate(input);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    let handle: number;
    try {
      handle = fs.openSync(lock, 'wx', 0o600);
    } catch {
      throw new Error('配置正在由其他任务修改，请稍后重试。');
    }
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const current = fs.existsSync(this.file)
        ? this.validate(JSON.parse(fs.readFileSync(this.file, 'utf8')), true)
        : {};
      fs.writeFileSync(
        temp,
        JSON.stringify({ ...current, ...updates }, null, 2),
        { mode: 0o600, flag: 'wx' }
      );
      fs.renameSync(temp, this.file);
      Object.assign(this.env, updates);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
      fs.closeSync(handle);
      fs.unlinkSync(lock);
    }
  }
}

export function settingsRouter(
  store: SettingsStore,
  status: () => ServiceSettings['status'],
  authorize: express.RequestHandler = requireAdmin
) {
  const router = express.Router();
  router.use(authorize, sameOriginMutation);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  const snapshot = () => ({
    fields: store.fields(),
    status: status(),
    storage: '保存在服务器配置文件，优先于 .env；密钥不回传浏览器。'
  });
  router.get('/', (_req, res) => res.json(snapshot()));
  router.put('/', (req, res) => {
    if (!req.headers.origin || !req.is('application/json')) {
      res.status(403).json({ error: '请通过管理后台保存配置。' });
      return;
    }
    try {
      store.save(req.body);
    } catch (error) {
      res.status(400).json({
        error:
          error instanceof Error && !('code' in error)
            ? error.message
            : '配置保存失败，请检查服务器配置文件。'
      });
      return;
    }
    res.json(snapshot());
  });
  return router;
}
