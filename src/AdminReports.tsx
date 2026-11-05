import { useEffect, useState } from 'react';
import { RefreshCw, Activity, Download, CheckCircle2, Users } from 'lucide-react';
import { accountRequest } from './Auth';
import { diagnosticOperations, type AnalyticsReport } from './shared/diagnostics';
import './adminReports.css';
import { AdminCacheReport } from './AdminCacheReport';

const labels: Record<string, string> = {
  'itinerary.parse': '行程解析', 'video.scene': '场景入口创建', 'video.preview': '预览加载',
  'video.export': '本机导出', 'video.background': '后台制作', 'video.fallback': '转后台请求',
  'video.download': '下载点击', 'video.storage': '本机视频存储', 'video.request': '视频请求异常',
  'runtime.error': '页面运行异常', 'runtime.rejection': '异步运行异常', 'server.error': '服务端异常',
  'auth.register': '注册', 'auth.login': '登录', 'share.publish': '生成分享链接',
  'share.open': '分享页打开', 'share.copy': '复制分享链接', 'itinerary.save': '行程保存', 'quota.blocked': '额度拦截'
};
const statuses: Record<string, string> = { succeeded: '成功', failed: '失败', cancelled: '已取消',
  interrupted: '已中断', in_progress: '进行中', unconfirmed: '结果未确认', clicked: '已点击', blocked: '已拦截' };
const lifecycle = ['itinerary.parse','video.scene','video.preview','video.export','video.background','video.fallback',
  'itinerary.save','share.publish','share.open','share.copy','auth.register','auth.login'];
const rate = (n: number | null | undefined) => n == null ? '—' : `${(n * 100).toFixed(1)}%`;
const duration = (n: number | null | undefined) => n == null ? '—' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} 秒`;
const dateTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export function AdminReports() {
  const [days, setDays] = useState('7'), [operation, setOperation] = useState(''), [browser, setBrowser] = useState('');
  const [userInput, setUserInput] = useState(''), [userId, setUserId] = useState(''), [status, setStatus] = useState('');
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const [report, setReport] = useState<AnalyticsReport | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setReport(null);
    const query = new URLSearchParams({ days, operation, browser, userId, status, page: String(page) });
    accountRequest<AnalyticsReport>('/api/admin/reports?' + query).then(data => {
      if (active) setReport(data);
    }).catch(issue => { if (active) setError(issue instanceof Error ? issue.message : '报表读取失败，请重试。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days, operation, browser, userId, status, page, revision]);
  const local = report?.operations.find(item => item.operation === 'video.export');
  const metric = (operation: string) => report?.operations.find(item => item.operation === operation);
  const maxExports = Math.max(1, ...report?.daily.map(day => day.exports) || []);
  return <section className="analytics" aria-label="使用报表" aria-busy={loading}>
    <div className="analytics-heading">
      <div><h2>使用报表</h2><p>从行程解析到成片，查看每一步的实际结果。</p></div>
      <button className="analytics-refresh" disabled={loading} onClick={() => setRevision(n => n + 1)}><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新</button>
    </div>
    <AdminCacheReport revision={revision} />
    <form className="analytics-filters" onSubmit={event => { event.preventDefault(); setUserId(userInput.trim()); setPage(1); }}>
      <label>时间<select aria-label="时间" value={days} onChange={event => { setDays(event.target.value); setPage(1); }}>
        <option value="1">今天</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option>
      </select></label>
      <label>操作<select aria-label="操作" value={operation} onChange={event => { setOperation(event.target.value); setPage(1); }}>
        <option value="">全部操作</option>{diagnosticOperations.map(op => <option key={op} value={op}>{labels[op] || op}</option>)}
      </select></label>
      <label>浏览器<select aria-label="浏览器" value={browser} onChange={event => { setBrowser(event.target.value); setPage(1); }}>
        <option value="">全部浏览器</option>{['Chrome','Safari','Edge','Firefox','微信','其他','未知','服务端'].map(name => <option key={name}>{name}</option>)}
      </select></label>
      <label>结果<select aria-label="结果" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
        <option value="">全部结果</option>{Object.entries(statuses).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select></label>
      <label className="analytics-user-filter">用户 ID<input aria-label="用户 ID" value={userInput} maxLength={80} placeholder="输入完整用户 ID" onChange={event => setUserInput(event.target.value)} /></label>
      <button type="submit" className="analytics-refresh">筛选</button>
    </form>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {loading && <p role="status" className="analytics-empty">正在读取报表…</p>}
    {report && <>
      <p className="analytics-coverage">采集启用：{dateTime(report.trackingSince)} · 更新于 {dateTime(report.until)} · 北京时间 · 保留 90 天。启用前的数据不补算。</p>
      <div className="analytics-cards">
        <article><Users size={19} /><span>有记录的用户</span><strong>{report.activeUsers}</strong><small>{report.totalAttempts} 次操作 · {report.totalEvents} 条事件</small></article>
        <article><CheckCircle2 size={19} /><span>本机导出成功</span><strong>{local?.succeeded || 0}<em> / {local?.attempts || 0} 次尝试</em></strong><small>成功率 {rate(local?.successRate)}</small></article>
        <article><Activity size={19} /><span>本机成功导出耗时</span><strong>{duration(local?.medianMs)}</strong><small>中位数 · P95 {duration(local?.p95Ms)}</small></article>
        <article><Download size={19} /><span>下载按钮点击</span><strong>{report.downloads}</strong><small>浏览器无法确认文件已保存到磁盘</small></article>
      </div>
      <div className="analytics-cards analytics-business-cards">
        <article><span>分享页成功打开</span><strong>{metric('share.open')?.succeeded || 0}</strong><small>页面数据加载次数，包含匿名访问与作者自访</small></article>
        <article><span>链接生成 / 复制成功</span><strong>{metric('share.publish')?.succeeded || 0} / {metric('share.copy')?.succeeded || 0}</strong><small>复制成功表示已写入剪贴板</small></article>
        <article><span>注册 / 登录成功</span><strong>{metric('auth.register')?.succeeded || 0} / {metric('auth.login')?.succeeded || 0}</strong><small>注册失败 {metric('auth.register')?.failed || 0} · 登录失败 {metric('auth.login')?.failed || 0}</small></article>
        <article><span>额度拦截</span><strong>{metric('quota.blocked')?.blocked || 0}</strong><small>包含前端提示与服务端检查；业务拦截单独统计</small></article>
      </div>
      <div className="analytics-panel">
        <h3>流程结果</h3>
        <p>成功率 = 成功 ÷（成功 + 失败）。取消、中断、拦截、进行中和结果未确认单独列出。各步骤可重复操作，次数不等同于漏斗转化。分享打开不等于地图已加载，也不代表独立访客数。</p>
        <div className="analytics-scroll"><table><thead><tr><th>操作</th><th>尝试</th><th>成功</th><th>失败</th><th>取消 / 中断 / 拦截</th><th>进行中 / 未确认</th><th>成功率</th><th>中位 / P95</th></tr></thead><tbody>
          {lifecycle.map(op => { const m = report.operations.find(item => item.operation === op); return <tr key={op}><th>{labels[op]}</th><td>{m?.attempts || 0}</td><td className="analytics-good">{m?.succeeded || 0}</td><td className={m?.failed ? 'analytics-bad' : ''}>{m?.failed || 0}</td><td>{m?.cancelled || 0} / {m?.interrupted || 0} / {m?.blocked || 0}</td><td>{m?.inProgress || 0} / {m?.unconfirmed || 0}</td><td>{rate(m?.successRate)}</td><td>{duration(m?.medianMs)} / {duration(m?.p95Ms)}</td></tr>; })}
        </tbody></table></div>
        <p>场景入口创建成功表示拿到预览入口；预览加载成功表示地图可播放；本机导出和后台制作成功表示成片验证通过。后台耗时包含排队。</p>
        <p>按首次收到该次操作事件的日期归档；离线补报可能延迟。2 分钟没有新进度且没有结果的操作显示“结果未确认”，稍后收到结果会更新。缺少开始事件：{report.operations.filter(m => lifecycle.includes(m.operation)).reduce((sum, m) => sum + m.missingStarts, 0)} 次。</p>
      </div>
      <div className="analytics-columns">
        <div className="analytics-panel"><h3>每日本机导出</h3><p><span className="analytics-dot good" />成功 <span className="analytics-dot bad" />失败 <span className="analytics-dot other" />其他结果</p>
          {report.totalAttempts === 0 ? <p className="analytics-empty">所选范围还没有操作记录。</p> : <div className="analytics-chart" role="img" aria-label="每日本机导出尝试与成功失败次数">
            {report.daily.map(day => <div className="analytics-day" key={day.date} title={`${day.date}：尝试 ${day.exports}，成功 ${day.succeeded}，失败 ${day.failed}`}>
              <span>{day.exports || ''}</span><div className="analytics-bar-track"><div className="analytics-bar" style={{ height: `${day.exports / maxExports * 100}%` }}>
                <i className="good" style={{ flex: day.succeeded }} /><i className="bad" style={{ flex: day.failed }} /><i className="other" style={{ flex: day.exports - day.succeeded - day.failed }} />
              </div></div><small>{day.date.slice(5).replace('-', '/')}</small></div>)}
          </div>}
        </div>
        <div className="analytics-panel"><h3>浏览器与本机导出</h3><div className="analytics-scroll"><table><thead><tr><th>浏览器</th><th>尝试</th><th>成功 / 失败</th><th>成功率</th></tr></thead><tbody>
          {report.browsers.map(item => <tr key={item.browser}><th>{item.browser}</th><td>{item.exports}</td><td>{item.succeeded} / {item.failed}</td><td>{rate(item.successRate)}</td></tr>)}
        </tbody></table></div>{!report.browsers.length && <p className="analytics-empty">暂无本机导出记录</p>}</div>
      </div>
      <div className="analytics-panel"><h3>常见失败原因</h3><ol className="analytics-failures">{report.failures.map((item, i) => <li key={i}><div><b>{labels[item.operation] || item.operation} · {item.stage || '未记录阶段'}</b><p>{item.message}</p></div><strong>{item.count} 次</strong></li>)}</ol>{!report.failures.length && <p className="analytics-empty">所选范围没有收到失败记录。</p>}</div>
      <div className="analytics-panel"><div className="analytics-heading"><h3>操作明细</h3><span>{report.totalAttempts} 条</span></div>
        <div className="analytics-scroll"><table><thead><tr><th>时间 / 操作</th><th>结果</th><th>用户 / 浏览器</th><th>耗时</th><th>详情</th></tr></thead><tbody>
          {report.recent.map(item => <tr key={item.eventId}><td><b>{labels[item.operation] || item.operation}</b><small>{dateTime(item.at)}</small></td><td><span className={`analytics-status ${item.status}`}>{statuses[item.status]}</span></td><td><code>{item.userId || '匿名 / 未认证'}</code><small>{item.browser}</small></td><td>{duration(item.elapsedMs)}</td><td><details><summary>查看</summary><div className="analytics-detail"><p>{item.stage}</p><dl><dt>操作 ID</dt><dd>{item.attemptId || item.eventId}</dd><dt>场景 / 行程</dt><dd>{item.sceneId || '—'} / {item.itineraryId || '—'}</dd><dt>版本 / 来源</dt><dd>{item.buildId} / {item.source}</dd></dl>{item.details && <pre>{JSON.stringify(item.details, null, 2)}</pre>}{item.context && <pre>{JSON.stringify(item.context, null, 2)}</pre>}{item.error && <pre>{JSON.stringify(item.error, null, 2)}</pre>}</div></details></td></tr>)}
        </tbody></table></div>
        {!report.recent.length && <p className="analytics-empty">暂无匹配记录</p>}
        <div className="analytics-pagination"><button disabled={page <= 1 || loading} onClick={() => setPage(n => n - 1)}>上一页</button><span>{page} / {Math.max(1, Math.ceil(report.totalAttempts / 30))}</span><button disabled={page * 30 >= report.totalAttempts || loading} onClick={() => setPage(n => n + 1)}>下一页</button></div>
      </div>
    </>}
  </section>;
}
