import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, getDefaultAdminCredentials, resolveIterations } from '../src/password.js';

test('PBKDF2 哈希可验证且格式正确', async () => {
  const hash = await hashPassword('正确的密码-123456', '10000');
  assert.match(hash, /^pbkdf2\$10000\$[A-Za-z0-9_-]{20,44}\$[A-Za-z0-9_-]{80,90}$/);
  assert.equal(await verifyPassword('正确的密码-123456', hash), true);
  assert.equal(await verifyPassword('错误的密码', hash), false);
});

test('每次哈希使用独立盐', async () => {
  const [a, b] = await Promise.all([hashPassword('same-password', '10000'), hashPassword('same-password', '10000')]);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-password', a), true);
  assert.equal(await verifyPassword('same-password', b), true);
});

test('非法或未知格式的存储值一律校验失败', async () => {
  for (const stored of [null, undefined, '', 'scrypt$abc', 'pbkdf2$0$aaa$bbb', 'plain-text']) {
    assert.equal(await verifyPassword('anything', stored), false);
  }
});

test('迭代次数解析有边界保护', () => {
  assert.equal(resolveIterations('100000'), 100000);
  assert.equal(resolveIterations(undefined), 100000);
  assert.equal(resolveIterations('not-a-number'), 100000);
  assert.equal(resolveIterations('100'), 100000);
  assert.equal(resolveIterations('99999999'), 100000);
  assert.equal(resolveIterations('25000'), 25000);
});

test('首次初始化凭据必须显式提供密码', () => {
  assert.throws(() => getDefaultAdminCredentials({}), /ADMIN_PASSWORD is required/);
  assert.deepEqual(
    getDefaultAdminCredentials({ ADMIN_USERNAME: 'alice', ADMIN_PASSWORD: 'secret-123' }),
    { username: 'alice', password: 'secret-123' }
  );
  assert.deepEqual(
    getDefaultAdminCredentials({ ADMIN_PASSWORD: 'secret-123' }),
    { username: 'admin', password: 'secret-123' }
  );
});
