import { RequireAuth, AuthControls } from './Auth';
import { useEffect, useState } from 'react';
import { Check, Loader2, Save, Settings2 } from 'lucide-react';
import type { ServiceSettings, SettingField } from './shared/settings';
import './settings.css';

const groups = [
  {
    id: 'users',
    title: '用户注册',
    body: '新注册的普通用户默认可创建 3 个行程；个人额度可在用户管理里调整。'
  },
  {
    id: 'text',
    title: '行程解析（文字 / 截图）',
    body: '文字和截图共用同一个模型、API 地址和密钥，统一整理为每日地点和路线。支持 OpenAI 兼容的图文接口。'
  },
  {
    id: 'map',
    title: '地图与地点',
    body: '高德地图用于地点匹配、路线规划及卫星影像。地图配置在刷新页面后应用。'
  },
  {
    id: 'video',
    title: '视频与音乐',
    body: '优先在浏览器生成 MP4；设备不支持或导出失败时使用本机后台。'
  }
];
async function request(
  method = 'GET',
  values?: Record<string, string>
): Promise<ServiceSettings> {
  const response = await fetch('/api/settings', {
    method,
    ...(values
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values)
        }
      : {})
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '无法读取服务设置。');
  return body;
}

export function SettingsPanel() {
  const [data, setData] = useState<ServiceSettings | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [clear, setClear] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    request()
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const dirty =
    Object.keys(draft).length > 0 || Object.values(clear).some(Boolean);
  function change(field: SettingField, value: string) {
    setDraft((old) => ({ ...old, [field.key]: value }));
    setSaved(false);
  }
  async function save() {
    if (!data) return;
    setBusy(true);
    setError('');
    setSaved(false);
    const values: Record<string, string> = {};
    for (const field of data.fields) {
      if (field.secret) {
        if (clear[field.key]) values[field.key] = '';
        else if (draft[field.key]?.trim()) values[field.key] = draft[field.key];
      } else if (field.key in draft) values[field.key] = draft[field.key];
    }
    try {
      setData(await request('PUT', values));
      setDraft({});
      setClear({});
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-panel">
      <div className="settings-intro">
        <Settings2 size={22} />
        <div>
          <strong>让旅程按你的方式运行</strong>
          <p>
            管理服务器上的解析、地图与视频服务。密钥仅保存在服务端，输入框留空会保留已有密钥。
          </p>
        </div>
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && (
        <p role="status">
          <Loader2 className="spin" size={16} /> 正在读取配置…
        </p>
      )}
      {data && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy} className="settings-fields">
            {groups.map((group) => {
              const ready =
                group.id === 'users'
                  ? true
                  : group.id === 'text'
                    ? data.status.textReady
                    : group.id === 'map'
                      ? data.status.mapReady
                      : data.status.videoReady;
              return (
                <section className="settings-card" key={group.id}>
                  <div className="settings-card-title">
                    <h3>{group.title}</h3>
                    <span className={ready ? 'ready' : ''}>
                      {ready ? '已配置' : '待配置'}
                    </span>
                  </div>
                  <p>{group.body}</p>
                  <div className="settings-grid">
                    {data.fields
                      .filter((f) => f.group === group.id)
                      .map((field) => (
                        <div className="settings-field" key={field.key}>
                          <label htmlFor={`setting-${field.key}`}>
                            {field.label}
                            {field.secret && (
                              <small>
                                {field.configured ? '已保存' : '未配置'}
                              </small>
                            )}
                          </label>
                          {field.choices ? (
                            <select
                              id={`setting-${field.key}`}
                              value={draft[field.key] ?? field.value}
                              onChange={(e) => change(field, e.target.value)}
                            >
                              <option value="">使用默认</option>
                              {field.choices.map((value) => (
                                <option value={value} key={value}>
                                  {value === 'true'
                                    ? '开启'
                                    : value === 'false'
                                      ? '关闭'
                                      : value === 'enabled'
                                        ? '开启'
                                        : value === 'disabled'
                                          ? '关闭'
                                          : value}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              id={`setting-${field.key}`}
                              type={field.secret ? 'password' : 'text'}
                              autoComplete="off"
                              spellCheck={false}
                              value={draft[field.key] ?? field.value}
                              disabled={Boolean(clear[field.key])}
                              placeholder={
                                field.secret
                                  ? field.configured
                                    ? '已配置，留空保持不变'
                                    : '输入密钥'
                                  : field.placeholder
                              }
                              onChange={(e) => change(field, e.target.value)}
                            />
                          )}
                          {field.secret && field.configured && (
                            <label className="settings-clear">
                              <input
                                type="checkbox"
                                checked={Boolean(clear[field.key])}
                                onChange={(e) => {
                                  setClear((old) => ({
                                    ...old,
                                    [field.key]: e.target.checked
                                  }));
                                  setSaved(false);
                                }}
                              />
                              清除此密钥
                            </label>
                          )}
                        </div>
                      ))}
                  </div>
                  {group.id === 'video' && (
                    <div className="settings-service">
                      <span>
                        内置音乐 <b>{data.status.musicCount} 首</b>
                      </span>
                      <span>
                        输出 <b>1080P · MP4 · 9:16</b>
                      </span>
                      {data.status.videoReason && (
                        <p>{data.status.videoReason}</p>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </fieldset>
          <div className="settings-save">
            <div>
              <p>{data.storage}</p>
              <small>
                保存后用于新的解析和制作任务。已有任务保持原样；“已配置”仅表示配置齐全。
              </small>
            </div>
            <button type="submit" disabled={busy || !dirty}>
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <Save size={16} />
              )}
              {busy ? '保存中' : '保存设置'}
            </button>
          </div>
          {saved && (
            <p className="settings-success" role="status">
              <Check size={16} />
              已保存。新任务将使用新的配置；地图变更请刷新页面。
            </p>
          )}
        </form>
      )}
    </div>
  );
}

export function SettingsPage() {
  return (
    <RequireAuth admin>
      <main className="settings-page">
        <header>
          <a href="/">← 返回行程</a>
          <h1>服务设置</h1>
          <AuthControls />
        </header>
        <SettingsPanel />
      </main>
    </RequireAuth>
  );
}
