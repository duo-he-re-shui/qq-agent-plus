import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-scopes-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { impressionVisible, memoryVisibilityOf } = await import('../src/core/memory-visibility.js');
const { MemoryStore } = await import('../src/memory/memory.js');
const { IdentityStore } = await import('../src/identity/identity-store.js');
const { ChatStore } = await import('../src/core/store.js');
const { buildToolDefs } = await import('../src/tools/tools.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

function configure(visibility = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memory.visibility = { default: 'global', mode: 'global', hidePrivateInGroup: false, ...visibility };
  setRuntimeConfig(cfg);
  return new MemoryStore();
}

test('四级范围矩阵：相关人物、私聊、来源会话都不能被无上下文查询绕过', () => {
  const vis = { mode: 'global', hidePrivateInGroup: false };
  const cases = [
    ['group:1', ['42'], [true, true, false, true]],
    ['group:2', ['42'], [true, true, false, false]],
    ['group:2', ['99'], [true, false, false, false]],
    ['private:42', [], [true, true, true, false]],
    ['private:99', ['42'], [true, false, true, false]],
    ['group:1', [], [true, false, false, true]]
  ];
  for (const [chatKey, participantUserIds, expected] of cases) {
    const actual = ['global', 'person', 'private', 'local'].map((visibility) => impressionVisible({
      content: visibility, sourceChatKeys: ['group:1'], visibility
    }, chatKey, vis, { subjectUserId: '42', participantUserIds }));
    assert.deepEqual(actual, expected, chatKey + JSON.stringify(participantUserIds));
  }
  assert.equal(impressionVisible({ visibility: 'local' }, 'group:1', vis), false);
  assert.equal(impressionVisible({ visibility: 'person' }, 'private:42', vis), false);
});

test('旧数据按 global 使用；旧的 perChat / 隐藏私聊来源仍是额外限制', () => {
  const legacy = { content: '旧印象', sourceChatKeys: ['private:42'] };
  assert.equal(impressionVisible(legacy, 'group:2', { mode: 'global' }), true);
  assert.equal(impressionVisible({ ...legacy, visibility: 'global' }, 'group:2', { mode: 'perChat' }), false);
  assert.equal(impressionVisible({ ...legacy, visibility: 'global' }, 'group:2', { hidePrivateInGroup: true }), false);
  assert.equal(memoryVisibilityOf({ memory: { visibility: { default: 'bad' } } }).default, 'global');
});

test('新建使用可编辑默认值；复述、重新加载和整理保留人工范围', () => {
  const memory = configure({ default: 'private' });
  const append = (text, extra = {}) => memory.append('group:10', 'memberImpression', text, { userId: '101', ...extra });
  assert.equal(append('新印象').visibility, 'private');
  configure({ default: 'global' });
  assert.equal(append('新印象').visibility, 'private', '重复观察不能把 private 重设成默认 global');
  memory.replaceMember('group:10', '101', '甲', ['整理后的私聊印象']);
  assert.equal(memory.getMember('', '101').impressions[0].visibility, 'private', '改写不能扩大旧范围');
  memory.editMemberImpression('group:10', { userId: '101', impressions: [{ content: '整理后的私聊印象', visibility: 'person' }] });
  assert.equal(new MemoryStore().getMember('', '101').impressions[0].visibility, 'person');
  assert.throws(() => memory.editMemberImpression('group:10', {
    userId: '101', impressions: [{ content: '坏范围', visibility: 'other' }]
  }), /visibility/);
  assert.equal(memory.getMember('', '101').impressions[0].content, '整理后的私聊印象');
});

test('逐条修改只改范围；并发新增、来源、观察时间与备注保留，并保存范围修改前快照', () => {
  const memory = configure();
  memory.append('group:20', 'memberImpression', '旧条目', { userId: '202' });
  const before = memory.getMember('', '202').impressions[0];
  memory.append('private:202', 'memberImpression', '刚新增的条目', { userId: '202', visibility: 'private' });
  const changed = memory.setImpressionVisibility('202', '旧条目', 'local');
  assert.deepEqual(changed, { ...before, visibility: 'local' });
  assert.equal(memory.getMember('', '202').impressions.length, 2);
  assert.throws(() => memory.setImpressionVisibility('202', '旧条目', 'oops'), /visibility/);
  assert.throws(() => memory.setImpressionVisibility('202', '已删除的条目', 'global'), /已不存在/);
  const files = fs.readdirSync(path.join(root, 'memory', 'backups', 'consolidation', '202'));
  assert.ok(files.map((file) => JSON.parse(fs.readFileSync(path.join(root, 'memory', 'backups', 'consolidation', '202', file), 'utf8')))
    .some((backup) => backup.reason === 'manual-visibility' && backup.person.impressions[0].visibility === 'global'));
});

test('迁移旧数据不套用新默认范围；收养遗留印象保留多来源和 local 范围', () => {
  configure({ default: 'private' });
  const dir = path.join(root, 'memory', 'people');
  fs.writeFileSync(path.join(dir, '303.json'), JSON.stringify({
    userId: '303', sourceChatKeys: ['group:30'], impressions: [{ content: '旧数据', createdAt: 100, sourceChatKeys: ['group:30'] }]
  }));
  const memory = new MemoryStore();
  assert.equal(memory.query('group:999').memberImpression.some((entry) => entry.content === '旧数据'), true);
  memory.replaceMember('group:30', '303', '丙', ['旧数据']);
  assert.equal(memory.query('group:999').memberImpression.some((entry) => entry.content === '旧数据'), true);
  memory.adoptImpressions('group:31', '304', '丁', [{
    content: '来源限定', visibility: 'local', createdAt: 100, lastObservedAt: 200, sourceChatKeys: ['group:31', 'group:32']
  }]);
  const adopted = memory.getMember('', '304').impressions[0];
  assert.equal(adopted.visibility, 'local');
  assert.deepEqual(new Set(adopted.sourceChatKeys), new Set(['group:31', 'group:32']));
  assert.equal(adopted.lastObservedAt, 200);
});

test('混合范围不能被整理摘要扩大成 global；原样保留与手动编辑仍可用', () => {
  const memory = configure();
  memory.editMemberImpression('private:404', { userId: '404', impressions: [
    { content: '公开偏好', visibility: 'global' }, { content: '私人事实', visibility: 'private' }
  ] });
  assert.throws(() => memory.replaceMember('private:404', '404', '', ['混合摘要']), /不同可见范围/);
  memory.replaceMember('private:404', '404', '', ['公开偏好', '私人事实']);
  assert.deepEqual(memory.getMember('', '404').impressions.map((entry) => entry.visibility), ['global', 'private']);
});

test('提示词、memory_query 与 person_memory_lookup 使用同一范围；管理页能看全部', async (t) => {
  const memory = configure();
  memory.editMemberImpression('group:50', { userId: '505', name: '测试者', impressions: [
    { content: '全局共享', visibility: 'global' },
    { content: '人物相关', visibility: 'person' },
    { content: '仅在私聊', visibility: 'private' },
    { content: '来源限定', visibility: 'local' }
  ] });
  const store = new ChatStore(0, { dataDir: root });
  const identity = new IdentityStore({ dataDir: root });
  t.after(() => { identity.close(); store.close(); });
  for (const [i, chatKey] of ['group:50', 'group:51', 'private:505'].entries()) {
    store.appendIncoming(chatKey, { mid: i + 1, text: '参与聊天', senderId: '505', senderName: '测试者' });
  }
  identity.rebuild({ activityRows: store.identityActivityRows(), legacyMemories: [], friends: [] });
  const queryTool = buildToolDefs().find((tool) => tool.name === 'memory_query');
  const lookupTool = buildToolDefs().find((tool) => tool.name === 'person_memory_lookup');
  for (const [chatKey, expected] of [
    ['group:50', ['全局共享', '人物相关', '来源限定']],
    ['group:51', ['全局共享', '人物相关']],
    ['private:505', ['全局共享', '人物相关', '仅在私聊']]
  ]) {
    const context = { chatKey, memory, store, identityPilot: {
      active: true, lookupPerson: (id, options) => identity.getPerson(id, options)
    } };
    const query = JSON.parse((await queryTool.execute(context, { userId: '505' })).content);
    const person = JSON.parse((await lookupTool.execute(context, { userId: '505' })).content);
    assert.deepEqual(new Set(query.memberImpression.map((entry) => entry.content)), new Set(expected));
    assert.deepEqual(new Set(person.globalMemories.map((entry) => entry.content)), new Set(expected));
    const prompt = memory.formatForPrompt(chatKey, { userIds: ['505'] });
    for (const text of ['全局共享', '人物相关', '仅在私聊', '来源限定']) {
      assert.equal(prompt.includes(text), expected.includes(text), chatKey + text);
    }
    assert.ok(!JSON.stringify(query).includes('sourceChatKeys'));
    assert.ok(!JSON.stringify(person).includes('sourceChatKeys'));
  }
  assert.equal(identity.listPeople(50).find((person) => person.userId === '505').globalMemories.length, 4);
  const unrelated = memory.query('group:52', '', { participantUserIds: ['999'] }).memberImpression
    .filter((entry) => entry.userId === '505');
  assert.deepEqual(unrelated.map((entry) => entry.content), ['全局共享']);
});
