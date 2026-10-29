import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Search,
  Settings2,
  Users,
  ShieldCheck,
  KeyRound,
  Pencil,
  Loader2
} from 'lucide-react';
import { AuthControls, accountRequest, useAuth } from './Auth';
import { AppDialog } from './AppDialog';
import { SettingsPanel } from './SettingsPanel';
import type { UserAccount } from './shared/auth';

export function AdminPage() {
  const { session, refresh } = useAuth();
  const [tab, setTab] = useState<'users' | 'settings'>('users'),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(1);
  const [data, setData] = useState<{ users: UserAccount[]; total: number }>({
      users: [],
      total: 0
    }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [editing, setEditing] = useState<UserAccount | null>(null),
    [passwordUser, setPasswordUser] = useState<UserAccount | null>(null);
  const [role, setRole] = useState('user'),
    [status, setStatus] = useState('active'),
    [limit, setLimit] = useState(3),
    [password, setPassword] = useState(''),
    [confirm, setConfirm] = useState(''),
    [busy, setBusy] = useState(false),
    [dialogError, setDialogError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await accountRequest(
          `/api/admin/users?search=${encodeURIComponent(query)}&page=${page}`
        )
      );
      setError('');
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    } finally {
      setLoading(false);
    }
  }, [query, page]);
  useEffect(() => {
    void load();
  }, [load]);
  function edit(user: UserAccount) {
    setRole(user.role);
    setStatus(user.status);
    setLimit(user.itineraryLimit);
    setDialogError('');
    setEditing(user);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setDialogError('');
    try {
      if (editing) {
        await accountRequest('/api/admin/users/' + editing.id, 'PATCH', {
          role,
          status,
          itineraryLimit: limit
        });
        setEditing(null);
      } else if (passwordUser) {
        if (password !== confirm) throw new Error('两次输入的密码不一致。');
        await accountRequest(
          '/api/admin/users/' + passwordUser.id + '/password',
          'POST',
          { password }
        );
        setPasswordUser(null);
        setPassword('');
        setConfirm('');
      }
      await load();
      await refresh();
    } catch (issue) {
      setDialogError(issue instanceof Error ? issue.message : String(issue));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="admin-page">
      <header className="admin-header">
        <a href="/">← 返回行程</a>
        <AuthControls />
      </header>
      <div className="admin-title">
        <span className="auth-eyebrow">MAP TOUR ADMIN</span>
        <h1>管理后台</h1>
        <p>管理用户、行程额度，以及这台服务器上的服务配置。</p>
      </div>
      <nav className="admin-tabs" aria-label="管理后台栏目">
        <button
          type="button"
          aria-pressed={tab === 'users'}
          onClick={() => setTab('users')}
        >
          <Users size={16} />
          用户管理
        </button>
        <button
          type="button"
          aria-pressed={tab === 'settings'}
          onClick={() => setTab('settings')}
        >
          <Settings2 size={16} />
          服务设置
        </button>
      </nav>
      {tab === 'settings' ? (
        <section className="admin-settings">
          <SettingsPanel />
        </section>
      ) : (
        <section className="admin-users">
          <div className="admin-users-heading">
            <div>
              <h2>
                用户 <span>{data.total}</span>
              </h2>
              <p>新用户默认 3 个行程；管理员不限量。</p>
            </div>
            <form
              className="admin-search"
              onSubmit={(e) => {
                e.preventDefault();
                setQuery(search);
                setPage(1);
              }}
            >
              <input
                aria-label="搜索用户"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="用户名或昵称"
              />
              <button type="submit" aria-label="搜索">
                <Search size={16} />
              </button>
            </form>
          </div>
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          {loading ? (
            <p role="status">
              <Loader2 size={16} className="spin" />
              正在读取用户…
            </p>
          ) : (
            <>
              <div className="admin-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>用户</th>
                      <th>角色</th>
                      <th>状态</th>
                      <th>已创建 / 额度</th>
                      <th>注册时间</th>
                      <th>管理</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.users.map((user) => (
                      <tr key={user.id}>
                        <td>
                          <b>{user.displayName}</b>
                          <small>
                            @{user.username}
                            {user.id === session.user?.id ? ' · 当前账号' : ''}
                          </small>
                        </td>
                        <td>
                          <span className={`account-badge role-${user.role}`}>
                            {user.role === 'admin' ? (
                              <ShieldCheck size={12} />
                            ) : null}
                            {user.role === 'admin' ? '管理员' : '普通用户'}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`account-badge state-${user.status}`}
                          >
                            {user.status === 'active' ? '启用' : '已停用'}
                          </span>
                        </td>
                        <td>
                          {user.itineraryCount} /{' '}
                          {user.role === 'admin' ? '不限' : user.itineraryLimit}
                        </td>
                        <td>
                          {new Date(user.createdAt).toLocaleDateString('zh-CN')}
                        </td>
                        <td>
                          <div className="admin-row-actions">
                            <button
                              type="button"
                              onClick={() => edit(user)}
                              aria-label={`管理 ${user.username}`}
                            >
                              <Pencil size={13} />
                              管理
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDialogError('');
                                setPassword('');
                                setConfirm('');
                                setPasswordUser(user);
                              }}
                              aria-label={`重置 ${user.username} 密码`}
                            >
                              <KeyRound size={13} />
                              重置密码
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!data.users.length && (
                <p className="admin-empty">没有找到符合条件的用户。</p>
              )}
              <div className="admin-pagination">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </button>
                <span>第 {page} 页</span>
                <button
                  type="button"
                  disabled={page * 30 >= data.total}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </button>
              </div>
            </>
          )}
        </section>
      )}
      {(editing || passwordUser) && (
        <AppDialog
          title={
            editing
              ? '管理 ' + editing.username
              : '重置 ' + passwordUser!.username + ' 的密码'
          }
          busy={busy}
          onClose={() => {
            setEditing(null);
            setPasswordUser(null);
            setPassword('');
            setConfirm('');
          }}
        >
          <form className="auth-form" onSubmit={save}>
            <fieldset disabled={busy}>
              {editing ? (
                <>
                  <label>
                    角色
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                    >
                      <option value="user">普通用户</option>
                      <option value="admin">管理员</option>
                    </select>
                  </label>
                  <label>
                    账号状态
                    <select
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                    >
                      <option value="active">启用</option>
                      <option value="disabled">停用</option>
                    </select>
                  </label>
                  <label>
                    累计行程额度
                    <input
                      type="number"
                      min={0}
                      max={10000}
                      value={limit}
                      onChange={(e) => setLimit(Number(e.target.value))}
                      required
                    />
                    <small>
                      已创建 {editing.itineraryCount}{' '}
                      个。额度可调整；不会影响已有行程。
                    </small>
                  </label>
                </>
              ) : (
                <>
                  <p className="auth-intro">
                    重置后，该用户所有已登录会话将退出。
                  </p>
                  <label>
                    新密码
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={128}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    确认新密码
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={128}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      required
                    />
                  </label>
                </>
              )}
              {dialogError && (
                <p className="auth-error" role="alert">
                  {dialogError}
                </p>
              )}
              <button className="auth-primary" type="submit">
                保存修改
              </button>
            </fieldset>
          </form>
        </AppDialog>
      )}
    </main>
  );
}
