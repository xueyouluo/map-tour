import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type FormEvent
} from 'react';
import {
  LogIn,
  LogOut,
  ShieldCheck,
  UserRound,
  Loader2,
  MapPinned
} from 'lucide-react';
import { AppDialog } from './AppDialog';
import type { AuthSession, UserAccount } from './shared/auth';
import './auth.css';

export async function accountRequest<T>(
  url: string,
  method = 'GET',
  body?: unknown
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers:
      body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '账号服务暂时不可用。');
  return data as T;
}
const AuthContext = createContext<{
  session: AuthSession;
  loading: boolean;
  refresh: () => Promise<void>;
  openAuth: () => void;
  logout: () => Promise<void>;
  signedIn: (user: UserAccount) => void;
} | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Auth provider required');
  return value;
}
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession>({
    user: null,
    registrationEnabled: true,
    setupAvailable: false
  });
  const [loading, setLoading] = useState(true),
    [open, setOpen] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setSession(await accountRequest<AuthSession>('/api/auth/session'));
    } catch {
      setSession({
        user: null,
        registrationEnabled: false,
        setupAvailable: false
      });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const expired = () => {
      void refresh();
      setOpen(true);
    };
    const focus = () => void refresh();
    window.addEventListener('map-tour:auth-required', expired);
    window.addEventListener('focus', focus);
    return () => {
      window.removeEventListener('map-tour:auth-required', expired);
      window.removeEventListener('focus', focus);
    };
  }, [refresh]);
  const signedIn = (user: UserAccount) => {
    setSession((old) => ({ ...old, user }));
    setOpen(false);
    void refresh();
  };
  const logout = async () => {
    await accountRequest('/api/auth/logout', 'POST', {});
    setSession((old) => ({ ...old, user: null }));
    window.location.assign('/');
  };
  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        refresh,
        openAuth: () => setOpen(true),
        signedIn,
        logout
      }}
    >
      {children}
      {open && (
        <AppDialog title="登录 Map Tour" onClose={() => setOpen(false)}>
          <p className="auth-intro">
            登录后即可创建行程。当前页面的内容会保留。
          </p>
          <AuthForm />
        </AppDialog>
      )}
    </AuthContext.Provider>
  );
}
export function AuthControls() {
  const { session, loading, openAuth, logout } = useAuth();
  const user = session.user;
  if (loading) return <span className="account-loading">账号加载中…</span>;
  if (!user)
    return (
      <button className="account-login" type="button" onClick={openAuth}>
        <LogIn size={15} />
        <span>登录 / 注册</span>
      </button>
    );
  return (
    <details className="account-menu">
      <summary>
        <UserRound size={14} />
        <span>{user.displayName}</span>
        <small>
          {user.role === 'admin'
            ? '管理员'
            : `${user.itineraryCount}/${user.itineraryLimit}`}
        </small>
      </summary>
      <div className="account-popover">
        <b>{user.username}</b>
        <p>
          {user.role === 'admin'
            ? '管理员 · 行程不限量'
            : `已创建 ${user.itineraryCount} / ${user.itineraryLimit} 个行程`}
        </p>
        <a href="/account">
          <UserRound size={14} />
          我的账号
        </a>
        {user.role === 'admin' && (
          <a href="/admin">
            <ShieldCheck size={14} />
            管理后台
          </a>
        )}
        <button type="button" onClick={() => void logout()}>
          <LogOut size={14} />
          退出登录
        </button>
      </div>
    </details>
  );
}
export function AuthForm({
  setup = false,
  onSuccess
}: {
  setup?: boolean;
  onSuccess?: () => void;
}) {
  const { session, signedIn } = useAuth();
  const [register, setRegister] = useState(false),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [confirm, setConfirm] = useState(''),
    [setupToken, setSetupToken] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if ((register || setup) && password !== confirm) {
      setError('两次输入的密码不一致。');
      return;
    }
    setBusy(true);
    try {
      const value = await accountRequest<{ user: UserAccount }>(
        '/api/auth/' + (setup ? 'setup' : register ? 'register' : 'login'),
        'POST',
        { username, password, ...(setup ? { setupToken } : {}) }
      );
      setPassword('');
      setConfirm('');
      signedIn(value.user);
      onSuccess?.();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="auth-form" onSubmit={submit}>
      {!setup && (
        <div className="auth-tabs" role="group" aria-label="登录或注册">
          <button
            type="button"
            aria-pressed={!register}
            onClick={() => {
              setRegister(false);
              setError('');
            }}
          >
            登录
          </button>
          {session.registrationEnabled && (
            <button
              type="button"
              aria-pressed={register}
              onClick={() => {
                setRegister(true);
                setError('');
              }}
            >
              注册账号
            </button>
          )}
        </div>
      )}
      {register && (
        <p className="auth-intro">
          每个新账号可创建 3 个行程，可随时编辑和导出已有行程。
        </p>
      )}
      {setup && (
        <p className="auth-intro">
          创建第一个管理员账号，用于用户管理和服务配置。
        </p>
      )}
      <fieldset disabled={busy}>
        <label>
          用户名
          <input
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            maxLength={32}
            pattern="[a-zA-Z0-9_][a-zA-Z0-9_.\-]{2,31}"
            placeholder="3–32 位字母、数字或 _ . -"
          />
        </label>
        <label>
          密码
          <input
            type="password"
            autoComplete={
              register || setup ? 'new-password' : 'current-password'
            }
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={register || setup ? 8 : undefined}
            maxLength={128}
            placeholder="至少 8 个字符"
          />
        </label>
        {(register || setup) && (
          <label>
            确认密码
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              maxLength={128}
            />
          </label>
        )}
        {setup && !session.setupAvailable && (
          <label>
            初始化令牌
            <input
              type="password"
              autoComplete="off"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              required
            />
            <small>服务器首次初始化时，输入 ADMIN_SETUP_TOKEN。</small>
          </label>
        )}
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        <button className="auth-primary" type="submit">
          {busy && <Loader2 size={16} className="spin" />}
          {setup ? '创建管理员' : register ? '注册并登录' : '登录'}
        </button>
      </fieldset>
      {!setup && session.setupAvailable && (
        <a className="auth-setup-link" href="/admin/setup">
          首次使用？初始化管理员
        </a>
      )}
    </form>
  );
}
export function AuthPage({ setup = false }: { setup?: boolean }) {
  return (
    <main className="account-page">
      <header>
        <a href="/">
          <MapPinned size={20} />
          MAP TOUR
        </a>
        <a href="/">返回首页</a>
      </header>
      <section className="account-auth-card">
        <span className="auth-eyebrow">YOUR TRAVEL STORIES</span>
        <h1>{setup ? '初始化管理员' : '让旅行故事，有个归属'}</h1>
        <AuthForm
          setup={setup}
          onSuccess={() => {
            const next =
              new URLSearchParams(window.location.search).get('next') ||
              (window.location.pathname !== '/login'
                ? window.location.pathname
                : '/');
            window.location.assign(
              setup
                ? '/admin'
                : next?.startsWith('/') && !next.startsWith('//')
                  ? next
                  : '/'
            );
          }}
        />
      </section>
    </main>
  );
}
export function RequireAuth({
  children,
  admin = false
}: {
  children: ReactNode;
  admin?: boolean;
}) {
  const { session, loading } = useAuth();
  if (loading)
    return (
      <main className="account-auth-card">
        <p role="status">正在读取账号…</p>
      </main>
    );
  if (!session.user) return <AuthPage />;
  if (admin && session.user.role !== 'admin')
    return (
      <main className="account-auth-card">
        <h1>仅管理员可访问</h1>
        <p>当前账号可以创建和管理自己的行程。</p>
        <a href="/">返回首页</a>
      </main>
    );
  return <>{children}</>;
}
export function AccountPage() {
  const { session, refresh } = useAuth();
  const user = session.user!;
  const [current, setCurrent] = useState(''),
    [password, setPassword] = useState(''),
    [confirm, setConfirm] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function change(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setMessage('两次输入的密码不一致。');
      return;
    }
    setBusy(true);
    try {
      await accountRequest('/api/auth/password', 'POST', {
        currentPassword: current,
        password
      });
      setCurrent('');
      setPassword('');
      setConfirm('');
      setMessage('密码已更新，其他登录会话已退出。');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="account-page">
      <header>
        <a href="/">← 返回行程</a>
        <AuthControls />
      </header>
      <section className="account-auth-card">
        <h1>我的账号</h1>
        <p>
          {user.displayName} ·{' '}
          {user.role === 'admin'
            ? '管理员'
            : `已创建 ${user.itineraryCount} / ${user.itineraryLimit} 个行程`}
        </p>
        <p className="auth-intro">
          行程额度按账号累计，编辑、分享和导出已有行程不重复扣除。
        </p>
        <form className="auth-form" onSubmit={change}>
          <fieldset disabled={busy}>
            <label>
              当前密码
              <input
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </label>
            <label>
              新密码
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                maxLength={128}
                required
              />
            </label>
            <label>
              确认新密码
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                minLength={8}
                maxLength={128}
                required
              />
            </label>
            {message && <p role="status">{message}</p>}
            <button className="auth-primary" type="submit">
              修改密码
            </button>
          </fieldset>
        </form>
      </section>
    </main>
  );
}
