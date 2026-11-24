import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-scopes-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

test('控制台范围接口鉴权、校验、逐条保存；默认范围配置回读并用于新记忆', async (t) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, token: 'memory-scope-test-token', host: '127.0.0.1' };
  cfg.runtime.mode = 'observe';
  cfg.allow.groups = ['100'];
  setRuntimeConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  // 只启动 HTTP 路由；不连接真实 OneBot 或启动后台任务。
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const request = async (route, method = 'GET', body) => fetch(base + route, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  app.memory.append('group:100', 'memberImpression', '第一条', { userId: '12345', visibility: 'person' });
  const route = '/api/memory-files/global/members/12345/visibility';
  assert.equal((await request(route, 'PUT', { content: '第一条', visibility: 'private' })).status, 401);
  const login = await request('/api/login', 'POST', { token: cfg.server.token });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(route, 'PUT', { content: '第一条', visibility: 'bad' })).status, 400);
  assert.equal((await request(route, 'PUT', { content: '不存在的条目', visibility: 'global' })).status, 400);
  app.memory.append('private:12345', 'memberImpression', '第二条', { userId: '12345', visibility: 'private' });
  const changed = await request(route, 'PUT', { content: '第一条', visibility: 'local' });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).entry.visibility, 'local');
  const detail = await (await request('/api/memory-files/group_100')).json();
  const entries = detail.members.find((member) => member.userId === '12345').impressions;
  assert.deepEqual(entries.map((entry) => [entry.content, entry.visibility]), [['第一条', 'local'], ['第二条', 'private']]);
  assert.equal((await request('/api/memory-files/group_100/members/12345', 'PUT', {
    impressions: [{ content: '不应写入', visibility: 'bad' }]
  })).status, 400);
  assert.equal(app.memory.getMember('', '12345').impressions.length, 2);
  const saved = await request('/api/config', 'POST', { memory: { visibility: { default: 'private' } } });
  assert.equal(saved.status, 200);
  const config = await (await request('/api/config')).json();
  assert.equal(config.memory.visibility.default, 'private');
  assert.equal(app.memory.append('group:100', 'memberImpression', '新默认范围', { userId: '12345' }).visibility, 'private');
});
