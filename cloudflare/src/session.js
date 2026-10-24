// 会话 Cookie 工具：移植自 lib/session.js，randomBytes/createHash 改用 Web Crypto。
import { base64UrlToBytes, bytesToBase64Url, randomToken, sha256Hex } from './crypto.js';

/** @param {number} length */
export function generateSessionToken(length = 32) {
  return randomToken(length);
}

/** @param {string} token */
export function hashSessionToken(token) {
  return sha256Hex(new TextEncoder().encode(token));
}

/**
 * 解析 Cookie 头。
 * @param {string | undefined | null} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  const jar = Object.create(null);
  if (typeof header !== 'string' || !header) return jar;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!name) continue;
    try { jar[name] = decodeURIComponent(value); } catch { jar[name] = value; }
  }
  return jar;
}

/**
 * @param {string} name @param {string} value @param {{
 *   httpOnly?: boolean, secure?: boolean, sameSite?: 'Lax'|'Strict'|'None',
 *   path?: string, maxAge?: number, expires?: Date }} options
 */
export function serializeCookie(name, value, options = {}) {
  const attributes = [`${name}=${encodeURIComponent(value)}`];
  attributes.push(`Path=${options.path ?? '/'}`);
  if (Number.isFinite(options.maxAge)) attributes.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) attributes.push(`Expires=${options.expires.toUTCString()}`);
  attributes.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.httpOnly !== false) attributes.push('HttpOnly');
  if (options.secure) attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * @param {string} token @param {{ name: string, httpOnly: boolean, secure: boolean,
 *   sameSite: 'Lax', path: string, maxAge: number }} options
 */
export function createSessionCookie(token, options) {
  return serializeCookie(options.name, token, options);
}

/** @param {{ name: string, secure: boolean, path?: string }} options */
export function clearSessionCookie(options) {
  return serializeCookie(options.name, '', {
    path: options.path ?? '/', httpOnly: true, secure: options.secure,
    sameSite: 'Lax', maxAge: 0, expires: new Date(0)
  });
}

/**
 * @param {string | undefined | null} header @param {string} name
 */
export function getSessionToken(header, name) {
  return parseCookies(header)[name] || null;
}

export { base64UrlToBytes, bytesToBase64Url };
