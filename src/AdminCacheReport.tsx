import { useEffect, useState } from 'react';
import type { MapCacheCleanup, MapCacheReport } from './shared/mapCache';
import { accountRequest } from './Auth';

const bytes = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`;
const dateTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
function outcome(item: MapCacheCleanup) {
  if (item.status === 'failed') return '清理失败，请查服务器日志';
  if (item.status === 'skipped') return ({ active_task: '任务进行中，延后清理', active_reader: '素材读取中，延后清理', entry_lock: '存在写入锁，延后清理' } as Record<string, string>)[item.reason || ''] || '本次延后清理';
  if (item.status === 'deferred' || item.protectedEntries) return '部分文件受保护，稍后重试';
  return item.deletedEntries ? '清理完成' : '检查完成，无需清理';
}
export function AdminCacheReport({ revision }: { revision: number }) {
  const [report, setReport] = useState<MapCacheReport | null>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setReport(null);
    accountRequest<MapCacheReport>('/api/admin/reports/cache').then(data => { if (active) setReport(data); })
      .catch(() => { if (active) setError('缓存报表读取失败，请稍后刷新。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision, retry]);
  const latest = report?.history[0];
  const lastCompleted = report?.history.find(item => ['completed', 'deferred'].includes(item.status));
  return <section className="analytics-panel analytics-cache" aria-label="服务器地图缓存" aria-busy={loading}>
    <div className="analytics-heading"><h3>服务器地图缓存</h3><button className="analytics-refresh" disabled={loading} onClick={() => setRetry(n => n + 1)}>刷新缓存状态</button></div>
    <p>全站实时快照，不受下方用户和时间筛选影响。刷新只读取状态。</p>
    {loading && <p role="status">正在读取缓存状态…</p>}
    {error && <p role="alert" className="analytics-bad">{error}</p>}
    {report && <>
      <div className="analytics-cards">
        <article><span>缓存占用</span><strong>{bytes(report.usedBytes)}</strong><small>图片及完成记录 {bytes(report.managedBytes)} · 其他文件 {bytes(report.otherBytes)} · 协调记录 {bytes(report.coordinationBytes)}</small></article>
        <article><span>清理容量上限</span><strong>{bytes(report.maxBytes)}</strong><small>适用于可识别的公共地图缓存</small></article>
        <article><span>自动过期</span><strong>{report.ttlMs / 86400000} 天</strong><small>按最近使用时间 · 每小时检查</small></article>
        <article><span>最近一次检查</span><strong className="analytics-cache-result">{latest ? outcome(latest) : '暂无检查记录'}</strong><small>{latest ? dateTime(latest.at) : '启用记录前的清理不补算'}</small></article>
      </div>
      <p>受容量管理的缓存 {bytes(report.managedBytes)} / {bytes(report.maxBytes)}（{(report.managedBytes / report.maxBytes * 100).toFixed(1)}%）</p>
      <meter aria-label="受容量管理的地图缓存占用" min={0} max={report.maxBytes} value={Math.min(report.managedBytes, report.maxBytes)} />
      {report.managedBytes > report.maxBytes && <p className="analytics-bad">缓存暂超上限，将在任务或文件保护解除后清理。</p>}
      <p>{report.namespaces.map(item => `${item.name === 'dem' ? '地形瓦片' : '卫星影像'} ${bytes(item.bytes)}（${item.entries} 条）`).join(' · ') || '暂无地图瓦片'} · 活跃读取 {report.activeReaders} · 写入锁 {report.writeLocks}</p>
      <p>任务或素材读取期间可能延后清理。其他文件保留原样；任务素材、用户成片、音乐和账号、行程数据库不计入此面板。</p>
      {lastCompleted && <p>最近实际完成检查：{dateTime(lastCompleted.at)} · 删除 {lastCompleted.deletedEntries} 条 · 释放 {bytes(lastCompleted.freedBytes)}</p>}
      <details><summary>最近清理记录（最多 50 次）</summary>
        {report.history.length ? <div className="analytics-scroll"><table><thead><tr><th>北京时间</th><th>结果</th><th>删除条目</th><th>释放空间</th><th>检查后缓存</th></tr></thead><tbody>
          {report.history.map((item, index) => <tr key={`${item.at}-${index}`}><td>{dateTime(item.at)}</td><td className={item.status === 'failed' ? 'analytics-bad' : ''}>{outcome(item)}</td><td>{item.status === 'failed' ? '—' : item.deletedEntries}</td><td>{item.status === 'failed' ? '—' : bytes(item.freedBytes)}</td><td>{item.remainingBytes == null ? '—' : bytes(item.remainingBytes)}</td></tr>)}
        </tbody></table></div> : <p>尚无清理记录。</p>}
      </details>
      <p>状态采样：{dateTime(report.checkedAt)} · 文件字节数，文件系统实际分配空间可能略有差异。</p>
    </>}
  </section>;
}
