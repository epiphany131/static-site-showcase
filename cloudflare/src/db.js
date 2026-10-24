// D1 数据访问层：表结构与查询语义从 Node 版 database.js 平移。
// 差异：node:sqlite 同步 API → D1 异步 API；无 legacy JSON 迁移与 custom_domain 迁移
//（Workers 版是全新数据库，schema 由 schema.sql 初始化）。
import { normalizeSettings, uploadMaxFileSizeFromEnv } from './settings.js';
import { hashPassword, getDefaultAdminCredentials } from './password.js';

function now() { return new Date().toISOString(); }
function toBool(value) { return value === true || value === 1; }

function userRow(row) {
  if (!row) return null;
  return { ...row, active: toBool(row.active), default_password: toBool(row.default_password) };
}
function siteRow(row) {
  if (!row) return null;
  return { ...row, published: toBool(row.published), source_visible: toBool(row.source_visible) };
}
function pageRow(row) {
  if (!row) return null;
  return { ...row, published: toBool(row.published) };
}

export class Database {
  /** @param {D1Database} db @param {Record<string, string>} env */
  constructor(db, env) {
    this.db = db;
    this.env = env;
    this.bootstrapped = false;
  }

  async ensureBootstrap() {
    if (this.bootstrapped) return;
    await this.ensureDefaultAdmin();
    await this.ensureSettings();
    this.bootstrapped = true;
  }

  async ensureDefaultAdmin() {
    const existing = await this.db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").first();
    if (existing) return userRow(existing);
    const credentials = getDefaultAdminCredentials(this.env);
    return this.createUser({ username: credentials.username, password: credentials.password, role: 'admin' });
  }

  async ensureSettings() {
    const current = await this.db.prepare('SELECT value FROM settings WHERE id=1').first();
    const uploadMaxFileSize = uploadMaxFileSizeFromEnv(this.env);
    if (!current) {
      const settings = normalizeSettings({}, { uploadMaxFileSize });
      await this.db.prepare('INSERT INTO settings(id,value,updated_at) VALUES(1,?,?)')
        .bind(JSON.stringify(settings), now()).run();
    } else {
      const parsed = JSON.parse(current.value);
      const options = parsed?.uploads?.maxFileSize === undefined ? { uploadMaxFileSize } : {};
      const normalized = normalizeSettings(parsed, options);
      await this.db.prepare('UPDATE settings SET value=?,updated_at=? WHERE id=1')
        .bind(JSON.stringify(normalized), now()).run();
    }
  }

  // ---------- 用户 ----------
  validateUsername(username) {
    return /^[A-Za-z0-9_.-]{3,32}$/.test(String(username || '').trim());
  }

  async createUser(input) {
    const username = String(input.username || '').trim();
    if (!this.validateUsername(username)) throw new TypeError('用户名必须为 3-32 位字母、数字、点、下划线或连字符');
    if (!['admin', 'editor'].includes(input.role)) throw new TypeError('无效角色');
    const passwordHash = input.passwordHash || await hashPassword(input.password, this.env.PBKDF2_ITERATIONS);
    const id = input.id || crypto.randomUUID();
    const timestamp = now();
    await this.db.prepare(`INSERT INTO users
      (id,username,password_hash,role,active,default_password,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`)
      .bind(id, username, passwordHash, input.role,
        input.active === false ? 0 : 1, input.defaultPassword ? 1 : 0, timestamp, timestamp).run();
    return this.getUserById(id);
  }

  async getUserById(id) {
    return userRow(await this.db.prepare('SELECT * FROM users WHERE id=?').bind(id).first());
  }

  async getUserByUsername(username) {
    return userRow(await this.db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE')
      .bind(username).first());
  }

  async getAllUsers() {
    const { results } = await this.db.prepare('SELECT * FROM users ORDER BY created_at').all();
    return results.map(userRow);
  }

  async countActiveAdmins() {
    const row = await this.db.prepare("SELECT COUNT(*) count FROM users WHERE role='admin' AND active=1").first();
    return Number(row.count);
  }

  async updateUser(id, updates) {
    const fields = [], values = [];
    if (Object.hasOwn(updates, 'role')) {
      if (!['admin', 'editor'].includes(updates.role)) throw new TypeError('无效角色');
      fields.push('role=?'); values.push(updates.role);
    }
    if (Object.hasOwn(updates, 'active')) {
      if (typeof updates.active !== 'boolean') throw new TypeError('active 必须是布尔值');
      fields.push('active=?'); values.push(updates.active ? 1 : 0);
    }
    if (Object.hasOwn(updates, 'username')) {
      const username = String(updates.username).trim();
      if (!this.validateUsername(username)) throw new TypeError('用户名格式无效');
      fields.push('username=?'); values.push(username);
    }
    if (updates.password || updates.passwordHash) {
      fields.push('password_hash=?', 'default_password=0', 'session_version=session_version+1');
      values.push(updates.passwordHash || await hashPassword(updates.password, this.env.PBKDF2_ITERATIONS));
    }
    if (!fields.length) return this.getUserById(id);
    fields.push('updated_at=?'); values.push(now(), id);
    const result = await this.db.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).bind(...values).run();
    if (updates.password || Object.hasOwn(updates, 'active') || Object.hasOwn(updates, 'role') || Object.hasOwn(updates, 'username')) {
      await this.deleteSessionsForUser(id);
    }
    return result.meta.changes ? this.getUserById(id) : null;
  }

  async deleteUser(id) {
    return this.db.prepare('DELETE FROM users WHERE id=?').bind(id).run();
  }

  async setLastLogin(id) {
    return this.db.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(now(), id).run();
  }

  // ---------- 会话 ----------
  async createSession(session) {
    return this.db.prepare(`INSERT INTO sessions
      (token_hash,user_id,csrf_hash,session_version,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
      VALUES(?,?,?,?,?,?,?,?)`)
      .bind(session.tokenHash, session.userId, session.csrfHash,
        session.sessionVersion, now(), now(), session.idleExpiresAt, session.absoluteExpiresAt).run();
  }

  async getSessionByHash(hash) {
    const row = await this.db.prepare(`SELECT s.*,u.username,u.role,u.active,u.default_password,u.session_version user_session_version
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.idle_expires_at>? AND s.absolute_expires_at>? AND u.active=1 AND s.session_version=u.session_version`)
      .bind(hash, now(), now()).first();
    return row || null;
  }

  async touchSession(hash, idleExpiresAt) {
    return this.db.prepare('UPDATE sessions SET last_seen_at=?,idle_expires_at=? WHERE token_hash=?')
      .bind(now(), idleExpiresAt, hash).run();
  }

  async updateSessionCsrf(hash, csrfHash) {
    return this.db.prepare('UPDATE sessions SET csrf_hash=? WHERE token_hash=?').bind(csrfHash, hash).run();
  }

  async deleteSessionByHash(hash) {
    return this.db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(hash).run();
  }

  async deleteSessionsForUser(id) {
    return this.db.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
  }

  // ---------- 站点 ----------
  async createSite(site, ownerId) {
    const owner = ownerId || (await this.db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").first())?.id;
    if (!owner) throw new Error('站点必须有所有者');
    const id = site.id || crypto.randomUUID();
    const timestamp = now();
    await this.db.prepare(`INSERT INTO sites
      (id,owner_user_id,name,description,path,published,source_visible,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .bind(id, owner, String(site.name), String(site.description || ''), String(site.path),
        site.published ? 1 : 0, site.source_visible === false ? 0 : 1, timestamp, timestamp).run();
    return this.getSiteById(id);
  }

  async getAllSites(ownerId) {
    const sql = `SELECT s.*,u.username owner_username FROM sites s JOIN users u ON u.id=s.owner_user_id ${ownerId ? 'WHERE s.owner_user_id=?' : ''} ORDER BY s.created_at DESC`;
    const { results } = await this.db.prepare(sql).bind(...(ownerId ? [ownerId] : [])).all();
    return results.map(siteRow);
  }

  async getPublishedSites() {
    const { results } = await this.db
      .prepare('SELECT s.*,u.username owner_username FROM sites s JOIN users u ON u.id=s.owner_user_id WHERE s.published=1 ORDER BY s.created_at DESC')
      .all();
    return results.map(siteRow);
  }

  async getSiteById(id, ownerId) {
    const sql = `SELECT s.*,u.username owner_username FROM sites s JOIN users u ON u.id=s.owner_user_id WHERE s.id=?${ownerId ? ' AND s.owner_user_id=?' : ''}`;
    return siteRow(await this.db.prepare(sql).bind(...(ownerId ? [id, ownerId] : [id])).first());
  }

  async updateSite(id, updates, ownerId) {
    const allowed = ['name', 'description', 'published', 'source_visible'];
    const fields = [], values = [];
    for (const field of allowed) if (Object.hasOwn(updates, field)) {
      fields.push(`${field}=?`);
      values.push(['published', 'source_visible'].includes(field) ? (updates[field] ? 1 : 0) : updates[field]);
    }
    if (!fields.length) return this.getSiteById(id, ownerId);
    fields.push('updated_at=?'); values.push(now(), id);
    let sql = `UPDATE sites SET ${fields.join(',')} WHERE id=?`;
    if (ownerId) { sql += ' AND owner_user_id=?'; values.push(ownerId); }
    const result = await this.db.prepare(sql).bind(...values).run();
    return result.meta.changes ? this.getSiteById(id, ownerId) : null;
  }

  async deleteSite(id, ownerId) {
    return ownerId
      ? this.db.prepare('DELETE FROM sites WHERE id=? AND owner_user_id=?').bind(id, ownerId).run()
      : this.db.prepare('DELETE FROM sites WHERE id=?').bind(id).run();
  }

  async countSitesByOwner(id) {
    const row = await this.db.prepare('SELECT COUNT(*) count FROM sites WHERE owner_user_id=?').bind(id).first();
    return Number(row.count);
  }

  async getUsersWithSiteCounts() {
    const { results } = await this.db.prepare(`SELECT u.*,COUNT(s.id) site_count FROM users u
      LEFT JOIN sites s ON s.owner_user_id=u.id GROUP BY u.id ORDER BY u.created_at`).all();
    return results.map(userRow);
  }

  // ---------- 内容页面 ----------
  validatePage(input, partial = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('页面数据格式无效');
    const page = {};
    if (!partial || Object.hasOwn(input, 'slug')) {
      const slug = typeof input.slug === 'string' ? input.slug.trim().toLowerCase() : '';
      if (!/^[a-z0-9](?:[a-z0-9-]{0,79}[a-z0-9])?$/.test(slug)) throw new TypeError('slug 必须由小写字母、数字和连字符组成，最长 81 位且不能以连字符结尾');
      page.slug = slug;
    }
    if (!partial || Object.hasOwn(input, 'title')) {
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title || title.length > 160) throw new TypeError('页面标题必须为 1-160 字符');
      page.title = title;
    }
    if (Object.hasOwn(input, 'category')) {
      const category = typeof input.category === 'string' ? input.category.trim() : '';
      if (category.length > 80) throw new TypeError('页面分类不得超过 80 字符');
      page.category = category;
    }
    if (Object.hasOwn(input, 'excerpt')) {
      const excerpt = typeof input.excerpt === 'string' ? input.excerpt.trim() : '';
      if (excerpt.length > 500) throw new TypeError('页面摘要不得超过 500 字符');
      page.excerpt = excerpt;
    }
    if (Object.hasOwn(input, 'content')) {
      if (typeof input.content !== 'string') throw new TypeError('页面内容必须是字符串');
      if (new TextEncoder().encode(input.content).length > 300 * 1024) throw new TypeError('页面内容不得超过 300KB');
      page.content = input.content;
    }
    if (Object.hasOwn(input, 'type')) {
      if (!['article', 'doc', 'code'].includes(input.type)) throw new TypeError('页面类型无效');
      page.type = input.type;
    }
    if (Object.hasOwn(input, 'published')) {
      if (typeof input.published !== 'boolean') throw new TypeError('published 必须是布尔值');
      page.published = input.published ? 1 : 0;
    }
    if (Object.hasOwn(input, 'sort_order')) {
      if (!Number.isSafeInteger(input.sort_order) || input.sort_order < 0 || input.sort_order > 999999) throw new TypeError('排序值无效');
      page.sort_order = input.sort_order;
    }
    return page;
  }

  async createPage(input) {
    const page = this.validatePage({ type: 'article', published: false, ...input });
    const id = crypto.randomUUID();
    const timestamp = now();
    await this.db.prepare(`INSERT INTO pages (id,slug,title,category,excerpt,content,type,published,sort_order,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, page.slug, page.title, page.category || '', page.excerpt || '', page.content || '',
        page.type, page.published, page.sort_order || 0, timestamp, timestamp).run();
    return this.getPageById(id);
  }

  async getPageById(id) {
    return pageRow(await this.db.prepare('SELECT * FROM pages WHERE id=?').bind(id).first());
  }

  async getPageBySlug(slug, publishedOnly = false) {
    return pageRow(await this.db.prepare(`SELECT * FROM pages WHERE slug=?${publishedOnly ? ' AND published=1' : ''}`)
      .bind(slug).first());
  }

  async getAllPages() {
    const { results } = await this.db.prepare('SELECT * FROM pages ORDER BY sort_order,created_at DESC,id').all();
    return results.map(pageRow);
  }

  async getPublishedPages(category) {
    const sql = category
      ? 'SELECT * FROM pages WHERE published=1 AND category=? ORDER BY sort_order,created_at,id'
      : 'SELECT * FROM pages WHERE published=1 ORDER BY sort_order,created_at,id';
    const { results } = await this.db.prepare(sql).bind(...(category ? [category] : [])).all();
    return results.map(pageRow);
  }

  async updatePage(id, input) {
    const page = this.validatePage(input, true);
    const fields = [], values = [];
    for (const [key, value] of Object.entries(page)) { fields.push(`${key}=?`); values.push(value); }
    if (!fields.length) return this.getPageById(id);
    fields.push('updated_at=?'); values.push(now(), id);
    const result = await this.db.prepare(`UPDATE pages SET ${fields.join(',')} WHERE id=?`).bind(...values).run();
    return result.meta.changes ? this.getPageById(id) : null;
  }

  async deletePage(id) {
    return this.db.prepare('DELETE FROM pages WHERE id=?').bind(id).run();
  }

  async getAdjacentPages(page) {
    const pages = await this.getPublishedPages(page.category);
    const index = pages.findIndex((item) => item.id === page.id);
    return {
      prev: index > 0 ? pages[index - 1] : null,
      next: index >= 0 && index < pages.length - 1 ? pages[index + 1] : null
    };
  }

  // ---------- 设置 ----------
  async getSettings() {
    await this.ensureBootstrap();
    const row = await this.db.prepare('SELECT value FROM settings WHERE id=1').first();
    return normalizeSettings(JSON.parse(row.value));
  }

  async updateSettings(value) {
    const normalized = normalizeSettings(value);
    await this.db.prepare('UPDATE settings SET value=?,updated_at=? WHERE id=1')
      .bind(JSON.stringify(normalized), now()).run();
    return normalized;
  }
}
