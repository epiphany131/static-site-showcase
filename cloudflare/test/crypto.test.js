import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  sha256Hex, randomToken, bytesToBase64Url, base64UrlToBytes, timingSafeEqual, hmacSha256Base64Url
} from '../src/crypto.js';

test('sha256Hex 与 Node crypto 结果一致', async () => {
  const data = new TextEncoder().encode('static-site-showcase');
  const expected = createHash('sha256').update(data).digest('hex');
  assert.equal(await sha256Hex(data), expected);
  assert.equal(await sha256Hex(data.buffer), expected);
});

test('base64url 往返且无填充字符', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  const encoded = bytesToBase64Url(bytes);
  assert.doesNotMatch(encoded, /[+/=]/);
  assert.deepEqual(base64UrlToBytes(encoded), bytes);
});

test('randomToken 长度与唯一性', () => {
  const tokens = new Set(Array.from({ length: 50 }, () => randomToken(32)));
  assert.equal(tokens.size, 50);
  for (const token of tokens) assert.doesNotMatch(token, /[+/=]/);
});

test('timingSafeEqual 恒时比较语义', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

test('hmacSha256Base64Url 与 Node crypto HMAC 一致', async () => {
  const key = 'login-csrf-secret';
  const payload = '1700000000.abc123';
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  assert.equal(await hmacSha256Base64Url(key, payload), expected);
});
