import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimePanel } from '../agent/pi-runtime-panel.mjs';
import { MIN_PI_VERSION } from '../agent/pi-command.mjs';

const base = {
  path: '/home/me/.local/bin/pi',
  version: '1.1.0',
  latest: '1.4.0',
  latestError: null,
  owner: { kind: 'managed' },
  updateAvailable: true,
  canUpdate: true
};
const cardItems = runtime => buildRuntimePanel(runtime).items[0].items;
const button = runtime => cardItems(runtime).find(item => item.type === 'button');

test('the runtime panel shows the verified baseline and labels unverified latest', () => {
  const panel = buildRuntimePanel(base).items[0];
  assert.equal(panel.subtitle, '可更新到 1.4.0');
  assert.equal(panel.items.find(item => item.label === '当前版本').value, '1.1.0');
  assert.equal(panel.items.find(item => item.label === '最新版本').value, '1.4.0');
  assert.match(panel.items.find(item => item.type === 'markdown').text,
    new RegExp(`基线是 Pi ${MIN_PI_VERSION.replaceAll('.', '\\.')}.*1\\.4\\.0 尚未人工确认`));
  assert.equal(button(base).disabled, undefined);
});

test('the runtime panel shows install, current and prerelease states separately', () => {
  const missing = {
    ...base, path: null, version: null, owner: { kind: 'none' }, updateAvailable: false
  };
  assert.equal(buildRuntimePanel(missing).items[0].subtitle, '尚未安装 Pi');
  assert.equal(button(missing).label, '安装最新版');
  assert.equal(button(missing).disabled, undefined);

  const current = { ...base, version: '1.4.0', updateAvailable: false };
  assert.equal(buildRuntimePanel(current).items[0].subtitle, '已是最新版');
  assert.equal(button(current).disabled, true);

  const beta = { ...base, version: '1.4.0-beta.1' };
  assert.equal(button(beta).disabled, undefined);
  assert.match(cardItems(beta).find(item => item.type === 'error').text, /正式稳定版/);
});

test('the runtime panel never offers an update that would overwrite a custom install', () => {
  const external = {
    ...base, path: '/custom/pi', version: '1.1.0', owner: { kind: 'external' }, canUpdate: false
  };
  assert.equal(buildRuntimePanel(external).items[0].subtitle, '需用原安装工具升级到 1.4.0');
  assert.equal(button(external), undefined);
  assert.match(cardItems(external).find(item => item.type === 'error').text, /自定义安装/);
});

test('latest lookup failures remain visible without hiding a usable installation', () => {
  const failed = {
    ...base, version: '1.4.0', latest: null, latestError: 'Error: registry unavailable', updateAvailable: false
  };
  assert.equal(buildRuntimePanel(failed).items[0].subtitle, '已安装');
  assert.equal(button(failed).label, '更新 Pi');
  assert.match(cardItems(failed).find(item => item.type === 'error').text, /registry unavailable/);
});
