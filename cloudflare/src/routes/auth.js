// 认证与账号路由：移植自 app.js 对应段落。
import { verifyPassword } from '../password.js';

const loginAttempts = new Map();
const LOGIN_ATTEMPT_TTL = 10 * 60 * 1000;

function appendCookie(c, value) {
  c.header('Set-Cookie', value, { append: true });
}

function publicUser(user) {
  return {
    id: user.id, username: user.username, role: user.role, active: user.active,
    defaultPassword: user.default_password, siteCount: Number(user.site_count || 0),
    createdAt: user.created_at, lastLoginAt: user.last_login_at
  };
}

function pruneLoginAttempts(timestamp) {
  for (const [key, record] of loginAttempts) {
    if (record.expiresAt <= timestamp) loginAttempts.delete(key);
  }
  while (loginAttempts.size >= 10000) loginAttempts.delete(loginAttempts.keys().next().value);
}

/**
 * @param {import('hono').Hono} app
 * @param {{ db: import('../db.js').Database, auth: ReturnType<import('../auth.js').createAuth> }} ctx
 */
export function registerAuthRoutes(app, { db, auth }) {
  app.get('/login', async (c) => {
    const challenge = await auth.issueLoginCsrf();
    const found = await auth.currentSession(c.req.raw);
    if (found) return c.redirect('/admin/');
    const assetsResponse = await c.env.ASSETS.fetch(new Request(new URL('/admin/login.html', 'https://assets.internal')));
    // 返回裸 Response 时 c.header() 不生效，必须直接在响应上追加 Cookie
    const response = new Response(assetsResponse.body, assetsResponse);
    response.headers.append('Set-Cookie', challenge.cookie);
    return response;
  });

  app.get('/api/auth/login-challenge', async (c) => {
    const challenge = await auth.issueLoginCsrf();
    c.header('Set-Cookie', challenge.cookie);
    c.header('Cache-Control', 'no-store');
    return c.json({ success: true });
  });

  app.get('/login.js', (c) => c.env.ASSETS.fetch(new Request(new URL('/admin/login.js', 'https://assets.internal'))));
  app.get('/login.css', (c) => c.env.ASSETS.fetch(new Request(new URL('/admin/login.css', 'https://assets.internal'))));

  app.post('/api/auth/login', async (c) => {
    if (!(await auth.loginCsrf(c.req.raw))) {
      return c.json({ error: '登录 CSRF 校验失败，请刷新页面后重试' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const username = String(body.username || '').trim();
    const timestamp = Date.now();
    pruneLoginAttempts(timestamp);
    const key = `${c.req.header('cf-connecting-ip') || 'unknown'}:${username.toLowerCase()}`;
    const record = loginAttempts.get(key) || { count: 0, until: 0, expiresAt: timestamp + LOGIN_ATTEMPT_TTL };
    await db.ensureBootstrap();
    const user = await db.getUserByUsername(username);
    const valid = user?.active && await verifyPassword(String(body.password || ''), user.password_hash, db.env.PBKDF2_ITERATIONS);
    if (valid) {
      loginAttempts.delete(key);
      await db.setLastLogin(user.id);
      await db.deleteSessionsForUser(user.id);
      const issued = await auth.issue(user);
      appendCookie(c, auth.clearLoginCsrfCookie());
      appendCookie(c, issued.cookie);
      appendCookie(c, issued.csrfCookie);
      return c.json({ success: true, user: publicUser(user) });
    }
    if (record.until > timestamp) return c.json({ error: '登录尝试过多，请稍后重试' }, 429);
    record.count += 1;
    record.until = record.count >= 5 ? timestamp + Math.min(record.count * 30000, 300000) : 0;
    loginAttempts.set(key, record);
    return c.json({ error: '用户名或密码错误' }, 401);
  });

  app.get('/api/auth/me', auth.required, (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ success: true, user: c.get('auth').user });
  });

  app.post('/api/auth/logout', auth.csrf, async (c) => {
    await db.deleteSessionByHash(c.get('auth').sessionHash);
    for (const cookie of auth.clearCookie()) appendCookie(c, cookie);
    return c.json({ success: true });
  });

  app.post('/api/auth/change-password', auth.csrf, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const user = await db.getUserById(c.get('auth').user.id);
    if (!(await verifyPassword(String(body.currentPassword || ''), user.password_hash, db.env.PBKDF2_ITERATIONS))) {
      return c.json({ error: '当前密码不正确' }, 400);
    }
    const password = String(body.newPassword || '');
    if (password.length < 6 || password.length > 128) return c.json({ error: '新密码长度必须为 6-128 位' }, 400);
    await db.updateUser(user.id, { password });
    for (const cookie of auth.clearCookie()) appendCookie(c, cookie);
    return c.json({ success: true, relogin: true });
  });

  app.patch('/api/auth/profile', auth.csrf, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const user = await db.getUserById(c.get('auth').user.id);
    if (!(await verifyPassword(String(body.currentPassword || ''), user.password_hash, db.env.PBKDF2_ITERATIONS))) {
      return c.json({ error: '当前密码不正确' }, 400);
    }
    const username = String(body.username || '').trim();
    if (!db.validateUsername(username)) {
      return c.json({ error: '用户名必须为 3-32 位字母、数字、点、下划线或连字符' }, 400);
    }
    try {
      await db.updateUser(user.id, { username });
      await db.deleteSessionsForUser(user.id);
      for (const cookie of auth.clearCookie()) appendCookie(c, cookie);
      return c.json({ success: true, relogin: true });
    } catch (error) {
      const conflict = String(error.message || '').toUpperCase().includes('UNIQUE');
      return c.json({ error: conflict ? '用户名已被使用' : error.message }, conflict ? 409 : 400);
    }
  });
}

export { publicUser };
