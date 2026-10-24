import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, MIN_UPLOAD_MAX_FILE_SIZE, DEFAULT_UPLOAD_MAX_FILE_SIZE,
  MAX_UPLOAD_MAX_FILE_SIZE, normalizeSettings, patchSettings, projectPublicSettings, uploadMaxFileSizeFromEnv
} from '../src/settings.js';

test('默认设置完整且上传上限为 Workers 版边界', () => {
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS), ['branding', 'home', 'appearance', 'uploads']);
  assert.equal(DEFAULT_SETTINGS.uploads.maxFileSize, DEFAULT_UPLOAD_MAX_FILE_SIZE);
  assert.equal(MIN_UPLOAD_MAX_FILE_SIZE, 1024 * 1024);
  assert.equal(MAX_UPLOAD_MAX_FILE_SIZE, 64 * 1024 * 1024);
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.branding), true);
});

test('环境变量仅在合法整数 MiB 时生效', () => {
  assert.equal(uploadMaxFileSizeFromEnv({ MAX_FILE_SIZE: String(16 * 1024 * 1024) }), 16 * 1024 * 1024);
  assert.equal(uploadMaxFileSizeFromEnv({ MAX_FILE_SIZE: '65MiB' }), DEFAULT_UPLOAD_MAX_FILE_SIZE);
  assert.equal(uploadMaxFileSizeFromEnv({ MAX_FILE_SIZE: String(65 * 1024 * 1024) }), DEFAULT_UPLOAD_MAX_FILE_SIZE);
  assert.equal(uploadMaxFileSizeFromEnv({ MAX_FILE_SIZE: 'abc' }), DEFAULT_UPLOAD_MAX_FILE_SIZE);
  assert.equal(uploadMaxFileSizeFromEnv(undefined), DEFAULT_UPLOAD_MAX_FILE_SIZE);
});

test('PATCH 白名单深合并并校验 MiB 步长', () => {
  const updated = patchSettings({}, { uploads: { maxFileSize: 8 * 1024 * 1024 } });
  assert.equal(updated.uploads.maxFileSize, 8 * 1024 * 1024);
  assert.equal(patchSettings({}, { uploads: { maxFileSize: MIN_UPLOAD_MAX_FILE_SIZE } }).uploads.maxFileSize, MIN_UPLOAD_MAX_FILE_SIZE);
  assert.equal(patchSettings({}, { uploads: { maxFileSize: MAX_UPLOAD_MAX_FILE_SIZE } }).uploads.maxFileSize, MAX_UPLOAD_MAX_FILE_SIZE);
  for (const value of [MIN_UPLOAD_MAX_FILE_SIZE - 1, MAX_UPLOAD_MAX_FILE_SIZE + 1, MIN_UPLOAD_MAX_FILE_SIZE + 1, 1.5, '52428800']) {
    assert.throws(() => patchSettings({}, { uploads: { maxFileSize: value } }), { code: 'INVALID_SETTING', path: 'uploads.maxFileSize' });
  }
  assert.throws(() => patchSettings({}, { uploads: { unknown: 1 } }), { code: 'UNKNOWN_SETTING' });
});

test('公开投影剔除 uploads 且返回副本', () => {
  const projected = projectPublicSettings(DEFAULT_SETTINGS);
  assert.deepEqual(Object.keys(projected), ['branding', 'home', 'appearance']);
  assert.notEqual(projected, DEFAULT_SETTINGS);
  assert.equal(normalizeSettings({ home: { layout: 'grid' } }).home.layout, 'grid');
});
