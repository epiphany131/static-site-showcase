// 认证：会话 Cookie、会话 CSRF、登录双提交 CSRF。
// 语义从 lib/auth.js 平移；差异：Cookie 恒 Secure 并使用 __Host- 前缀
//（Workers 部署始终经 Cloudflare HTTPS），登录 CSRF 密钥来自 env.LOGIN_CSRF_SECRET。
import { hmacSha256Base64Url, randomToken, sha256Hex, timingSafeEqual } from './crypto.js';
import { hashSessionToken, parseCookies, serializeCookie } from './session.js';

export const IDLE_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const LOGIN_CSRF_MS = 5 * 60 * 1000;
const LOGIN_CSRF_COOKIE = 'zcode_login_csrf';
const SESSION_COOKIE = '__Host-zcode_session';
const CSRF_COOKIE = 'zcode_csrf';

/** @param {import('./db.js').Database} db */
export function createAuth(db) {
  function requireSecret() {
    if (!db.env.LOGIN_CSRF_SECRET) {
      throw new TypeError('LOGIN_CSRF_SECRET secret is required');
    }
    return db.env.LOGIN_CSRF_SECRET;
  }

  function sessionCookieOptions() {
    return { name: SESSION_COOKIE, httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: Math.floor(ABSOLUTE_MS / 1000) };
  }

  async function currentSession(request) {
    const raw = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
    if (!raw) return null;
    const hash = await hashSessionToken(raw);
    const session = await db.getSessionByHash(hash);
    if (!session) return null;
    await db.touchSession(hash, new Date(Date.now() + IDLE_MS).toISOString());
    return { session, tokenHash: hash };
  }

  async function issue(user) {
    const token = randomToken(32);
    const csrfToken = randomToken(32);
    const tokenHash = await hashSessionToken(token);
    const csrfHash = await sha256Hex(new TextEncoder().encode(csrfToken));
    await db.createSession({
      tokenHash,
      userId: user.id,
      csrfHash,
      sessionVersion: user.session_version,
      idleExpiresAt: new Date(Date.now() + IDLE_MS).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + ABSOLUTE_MS).toISOString()
    });
    return {
      token,
      csrfToken,
      cookie: serializeCookie(SESSION_COOKIE, token, sessionCookieOptions()),
      csrfCookie: serializeCookie(CSRF_COOKIE, csrfToken, {
        httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAge: Math.floor(ABSOLUTE_MS / 1000)
      })
    };
  }

  function clearCookie() {
    return [
      serializeCookie(SESSION_COOKIE, '', {
        path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 0, expires: new Date(0)
      }),
      serializeCookie(CSRF_COOKIE, '', {
        httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAge: 0, expires: new Date(0)
      })
    ];
  }

  async function issueLoginCsrf() {
    const secret = requireSecret();
    const issuedAt = Date.now().toString();
    const nonce = randomToken(16);
    const payload = `${issuedAt}.${nonce}`;
    const signature = await hmacSha256Base64Url(secret, payload);
    const token = `${payload}.${signature}`;
    return {
      token,
      cookie: serializeCookie(LOGIN_CSRF_COOKIE, token, {
        httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAge: Math.floor(LOGIN_CSRF_MS / 1000)
      })
    };
  }

  function clearLoginCsrfCookie() {
    return serializeCookie(LOGIN_CSRF_COOKIE, '', {
      httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAge: 0, expires: new Date(0)
    });
  }

  /** 双提交登录 CSRF：Cookie 与 Header 必须一致且 HMAC 签名在 5 分钟内有效。 */
  async function loginCsrf(request) {
    const secret = requireSecret();
    const cookieToken = parseCookies(request.headers.get('cookie'))[LOGIN_CSRF_COOKIE];
    const headerToken = request.headers.get('x-login-csrf-token');
    const parts = typeof cookieToken === 'string' ? cookieToken.split('.') : [];
    const issuedAt = parts.length === 3 ? Number(parts[0]) : NaN;
    const payload = parts.length === 3 ? `${parts[0]}.${parts[1]}` : '';
    const expected = payload ? await hmacSha256Base64Url(secret, payload) : '';
    const age = Date.now() - issuedAt;
    const valid = timingSafeEqual(cookieToken || '', headerToken || '')
      && timingSafeEqual(parts[2] || '', expected)
      && Number.isSafeInteger(issuedAt) && age >= 0 && age <= LOGIN_CSRF_MS;
    return valid;
  }

  function buildAuthResult(found) {
    const { session } = found;
    return {
      user: {
        id: session.user_id, username: session.username, role: session.role,
        active: toBool(session.active), default_password: toBool(session.default_password)
      },
      sessionHash: found.tokenHash,
      csrfHash: session.csrf_hash
    };
  }

  function toBool(value) { return value === true || value === 1; }

  /**
   * Hono 中间件工厂。
   * @param {'optional'|'required'|'admin'|'csrf'} mode
   */
  function middleware(mode) {
    return async (c, next) => {
      const found = await currentSession(c.req.raw);
      if (found) {
        c.set('auth', buildAuthResult(found));
      } else if (mode !== 'optional') {
        return c.json({ error: '请先登录' }, 401);
      }
      if (mode === 'csrf') {
        const token = c.req.header('x-csrf-token');
        const expected = await sha256Hex(new TextEncoder().encode(token || ''));
        if (!token || !timingSafeEqual(expected, c.get('auth').csrfHash)) {
          return c.json({ error: 'CSRF 校验失败，请刷新页面后重试' }, 403);
        }
      }
      if (mode === 'admin' && c.get('auth')?.user.role !== 'admin') {
        return c.json({ error: '需要管理员权限' }, 403);
      }
      await next();
    };
  }

  return {
    optional: middleware('optional'),
    required: middleware('required'),
    admin: middleware('admin'),
    csrf: middleware('csrf'),
    loginCsrf,
    issue,
    issueLoginCsrf,
    clearCookie,
    clearLoginCsrfCookie,
    currentSession,
    cookieName: SESSION_COOKIE
  };
}
