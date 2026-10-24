// PBKDF2-SHA256 密码哈希（Web Crypto 原生实现）。
// 存储格式：pbkdf2$<iterations>$<salt base64url>$<hash base64url>
// 注意：与 Node 版 scrypt 哈希互不兼容；Workers 版使用全新 D1，不做迁移。
import { base64UrlToBytes, bytesToBase64Url, timingSafeEqual } from './crypto.js';

const PREFIX = 'pbkdf2';
const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const HASH_PATTERN = /^pbkdf2\$([1-9][0-9]*)\$([A-Za-z0-9_-]{20,44})\$([A-Za-z0-9_-]{80,90})$/;

/** @param {string | undefined} raw */
export function resolveIterations(raw) {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= 10_000 && parsed <= 2_000_000 ? parsed : 100_000;
}

async function deriveBits(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_LENGTH * 8
  );
}

/** @param {string} password @param {string | undefined} iterationsRaw */
export async function hashPassword(password, iterationsRaw) {
  const iterations = resolveIterations(iterationsRaw);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const derived = new Uint8Array(await deriveBits(password, salt, iterations));
  return `${PREFIX}$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(derived)}`;
}

/**
 * 校验密码；同时兼容对旧格式直接返回 false 而不抛错。
 * @param {string} password @param {string | undefined | null} stored
 */
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const match = HASH_PATTERN.exec(stored);
  if (!match) return false;
  const iterations = Number.parseInt(match[1], 10);
  const salt = base64UrlToBytes(match[2]);
  const expected = base64UrlToBytes(match[3]);
  const derived = new Uint8Array(await deriveBits(password, salt, iterations));
  return timingSafeEqual(
    bytesToBase64Url(derived), bytesToBase64Url(expected)
  );
}

/**
 * 首次初始化凭据：与 Node 版语义一致，但无默认密码——空库且未配置 ADMIN_PASSWORD 时拒绝启动。
 * @param {{ ADMIN_USERNAME?: string, ADMIN_PASSWORD?: string }} env
 */
export function getDefaultAdminCredentials(env) {
  if (!env.ADMIN_PASSWORD) {
    throw new TypeError('ADMIN_PASSWORD is required to bootstrap the first admin');
  }
  return { username: env.ADMIN_USERNAME || 'admin', password: env.ADMIN_PASSWORD };
}
