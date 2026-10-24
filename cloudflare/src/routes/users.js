// 账号管理路由（仅管理员）：移植自 app.js 对应段落。
import { publicUser } from './auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {import('hono').Hono} app
 * @param {{ db: import('../db.js').Database, auth: ReturnType<import('../auth.js').createAuth> }} ctx
 */
export function registerUserRoutes(app, { db, auth }) {
  app.get('/api/users', auth.admin, async (c) => {
    const users = await db.getUsersWithSiteCounts();
    return c.json({ success: true, users: users.map(publicUser) });
  });

  app.get('/api/users/:id/sites', auth.admin, async (c) => {
    if (!UUID_RE.test(c.req.param('id'))) return c.json({ error: '账号不存在' }, 404);
    if (!(await db.getUserById(c.req.param('id')))) return c.json({ error: '账号不存在' }, 404);
    const sites = await db.getAllSites(c.req.param('id'));
    return c.json({ success: true, sites: sites.map((site) => adminSite(site)) });
  });

  app.post('/api/users', auth.admin, auth.csrf, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const password = String(body.password || '');
      if (password.length < 6 || password.length > 128) return c.json({ error: '密码长度必须为 6-128 位' }, 400);
      const user = await db.createUser({ username: body.username, password, role: body.role || 'editor' });
      return c.json({ success: true, user: publicUser(user) }, 201);
    } catch (error) {
      const conflict = String(error.message || '').toUpperCase().includes('UNIQUE');
      return c.json({ error: error.message }, conflict ? 409 : 400);
    }
  });

  app.patch('/api/users/:id', auth.admin, auth.csrf, async (c) => {
    const target = await db.getUserById(c.req.param('id'));
    if (!target) return c.json({ error: '账号不存在' }, 404);
    if (target.id === c.get('auth').user.id) return c.json({ error: '请通过个人资料修改当前账号' }, 400);
    const body = await c.req.json().catch(() => ({}));
    if (target.role === 'admin' && target.active && (await db.countActiveAdmins()) === 1
      && (body.active === false || body.role === 'editor')) {
      return c.json({ error: '不能禁用或降级最后一个有效管理员' }, 400);
    }
    const updates = {};
    for (const key of ['username', 'role', 'active']) if (Object.hasOwn(body, key)) updates[key] = body[key];
    if (!Object.keys(updates).length) return c.json({ error: '没有可更新的字段' }, 400);
    try {
      return c.json({ success: true, user: publicUser(await db.updateUser(target.id, updates)) });
    } catch (error) {
      const conflict = String(error.message || '').toUpperCase().includes('UNIQUE');
      return c.json({ error: conflict ? '用户名已被使用' : error.message }, conflict ? 409 : 400);
    }
  });

  app.post('/api/users/:id/reset-password', auth.admin, auth.csrf, async (c) => {
    const target = await db.getUserById(c.req.param('id'));
    if (!target) return c.json({ error: '账号不存在' }, 404);
    if (target.id === c.get('auth').user.id) return c.json({ error: '请使用修改密码功能修改当前账号密码' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const password = String(body.password || '');
    if (password.length < 6 || password.length > 128) return c.json({ error: '密码长度必须为 6-128 位' }, 400);
    await db.updateUser(target.id, { password });
    return c.json({ success: true });
  });

  app.post('/api/users/:id/revoke-sessions', auth.admin, auth.csrf, async (c) => {
    const target = await db.getUserById(c.req.param('id'));
    if (!target) return c.json({ error: '账号不存在' }, 404);
    if (target.id === c.get('auth').user.id) return c.json({ error: '不能通过管理接口撤销当前会话' }, 400);
    await db.deleteSessionsForUser(target.id);
    return c.json({ success: true });
  });

  app.delete('/api/users/:id', auth.admin, auth.csrf, async (c) => {
    const target = await db.getUserById(c.req.param('id'));
    if (!target) return c.json({ error: '账号不存在' }, 404);
    if (target.id === c.get('auth').user.id
      || (target.role === 'admin' && target.active && (await db.countActiveAdmins()) === 1)) {
      return c.json({ error: '不能删除当前或最后一个管理员账号' }, 400);
    }
    if (await db.countSitesByOwner(target.id)) return c.json({ error: '该账号仍拥有站点，请先处理这些站点' }, 409);
    await db.deleteUser(target.id);
    return c.json({ success: true });
  });
}

export function adminSite(site) {
  return {
    id: site.id, name: site.name, description: site.description,
    url: `/sites/${site.id}/`, detailUrl: `/works/${site.id}`,
    published: site.published, sourceVisible: site.source_visible,
    ownerId: site.owner_user_id, ownerUsername: site.owner_username,
    createdAt: site.created_at, updatedAt: site.updated_at
  };
}

export function publicSite(site) {
  return {
    id: site.id, name: site.name, description: site.description,
    previewUrl: `/sites/${site.id}/`, detailUrl: `/works/${site.id}`,
    sourceVisible: site.source_visible, ownerUsername: site.owner_username,
    createdAt: site.created_at, updatedAt: site.updated_at
  };
}
