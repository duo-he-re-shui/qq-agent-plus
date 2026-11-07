// 定时提醒的绝对时间（2026-11-07 线上事故回归）：
// 旧口径只认 HH:MM → 最多表达 24 小时内的未来时刻，"下周一 10 点"被迫落成"明天 10 点"，
// 模型只能反复 cancel/add 硬凑日期，4 轮把单次运行的 Token 预算烧光，最后只发出兜底文案。
// 这里钉住新口径：带日期的 at / date + at / 与 minutes 互斥 / repeat 首次触发点对齐。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-reminder-abs-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄 */ } });

const {
  parseReminderDate, parseReminderTime, formatReminderAt, checkRepeatMatch, ReminderStore
} = await import('../src/core/reminders.js');
const { buildToolDefs } = await import('../src/tools/tools-core.js');

const ZONE = 8 * 3600 * 1000;
const shanghai = (ms) => new Date(Number(ms) + ZONE);
const dayKey = (ms) => {
  const d = shanghai(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};
// 基准：北京时间 2026-11-07 14:00（周六）
const NOW = Date.UTC(2026, 10, 7, 6, 0, 0);
const at = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 8, mi);

const defs = buildToolDefs();
const remind = defs.find((d) => d.name === 'remind');
const parse = (r) => { try { return JSON.parse(r.content); } catch { return r.content; } };

test('parseReminderDate：多种写法，非法日期拒绝', () => {
  assert.deepEqual(parseReminderDate('2026-11-09'), { year: 2026, month: 11, day: 9 });
  assert.deepEqual(parseReminderDate('2026/11/09'), { year: 2026, month: 11, day: 9 });
  assert.deepEqual(parseReminderDate('2026年11月9日'), { year: 2026, month: 11, day: 9 });
  assert.deepEqual(parseReminderDate('11-09'), { month: 11, day: 9 });
  assert.deepEqual(parseReminderDate('11月9日'), { month: 11, day: 9 });
  assert.deepEqual(parseReminderDate('11月9号'), { month: 11, day: 9 });
  assert.equal(parseReminderDate('2026-13-01'), null);
  assert.equal(parseReminderDate('2026-11-32'), null);
  assert.equal(parseReminderDate('10:00'), null);
  assert.equal(parseReminderDate(''), null);
  assert.equal(parseReminderDate('明天'), null);
});

test('parseReminderTime：跨天日期落到指定时刻（北京时区）', () => {
  const cases = [
    '2026-11-09 10:00',
    '2026-11-09T10:00',
    '2026/11/09 10:00',
    '2026年11月9日 10:00',
    '2026-11-09 10:00:00'
  ];
  for (const input of cases) {
    const r = parseReminderTime(input, { now: NOW });
    assert.ok(r, `应能解析：${input}`);
    assert.equal(r.explicitDate, true);
    assert.equal(r.at, at(2026, 11, 9, 10, 0), input);
    assert.deepEqual([r.hour, r.minute], [10, 0]);
  }
  // 不带年：按当前年解释（跨年要写全年，不然会被静默推到明年）
  assert.equal(parseReminderTime('11-09 10:00', { now: NOW }).at, at(2026, 11, 9, 10, 0));
  assert.equal(parseReminderTime('11月9日 10:00', { now: NOW }).at, at(2026, 11, 9, 10, 0));
  // date + at 拼装
  const joined = parseReminderTime('10:00', { now: NOW, date: '2026-11-09' });
  assert.equal(joined.at, at(2026, 11, 9, 10, 0));
  assert.equal(joined.explicitDate, true);
});

test('parseReminderTime：只给钟点沿用旧语义（24 小时内）；非法/过去不在这里吞掉', () => {
  // 14:00 之后说 10:00 → 明天 10:00
  const next = parseReminderTime('10:00', { now: NOW });
  assert.equal(next.at, at(2026, 11, 8, 10, 0));
  assert.equal(next.explicitDate, false);
  assert.equal(parseReminderTime('15:30', { now: NOW }).at, at(2026, 11, 7, 15, 30));
  // 非法
  for (const bad of ['25:00', '10:60', '2026-02-30 10:00', '2026-13-01 10:00', '10:00 2026-11-09', 'abc', '']) {
    assert.equal(parseReminderTime(bad, { now: NOW }), null, `应拒绝：${bad}`);
  }
  // 已过去的显式时刻原样返回：由工具给"已经过去了"的可读错误（不能静默变成明年/明天）
  const past = parseReminderTime('2026-11-07 10:00', { now: NOW });
  assert.equal(past.explicitDate, true);
  assert.ok(past.at < NOW);
});

test('formatReminderAt：完整年月日 + 星期（不再把 11/08 看成 11/09）', () => {
  assert.equal(formatReminderAt(at(2026, 11, 9, 10, 0)), '2026-11-09 10:00（周一）');
  assert.equal(formatReminderAt(at(2026, 11, 8, 10, 0)), '2026-11-08 10:00（周日）');
});

test('checkRepeatMatch：weekly 星期几与 cron 槽位不自洽要报错', () => {
  assert.equal(checkRepeatMatch({ kind: 'weekly', weekday: 1 }, at(2026, 11, 9, 10, 0)), null);
  assert.match(
    checkRepeatMatch({ kind: 'weekly', weekday: 1 }, at(2026, 11, 8, 10, 0)),
    /date 是周日，但 repeat 是每周一/
  );
  assert.equal(checkRepeatMatch({ kind: 'cron', cron: '0 10 * * 1' }, at(2026, 11, 9, 10, 0)), null);
  assert.match(checkRepeatMatch({ kind: 'cron', cron: '0 10 * * 1' }, at(2026, 11, 9, 11, 0)), /对不上/);
  assert.equal(checkRepeatMatch({ kind: 'daily' }, at(2026, 11, 9, 10, 0)), null);
});

test('remind 工具：date + at 能落到一个月内的任意时刻（这是本次修复的主诉求）', async () => {
  const store = new ReminderStore(path.join(dataDir, 'r-abs.json'));
  const ctx = { chatKey: 'private:1', kind: 'private', chatId: '1', reminders: store };
  const target = Date.now() + 3 * 24 * 3600 * 1000;
  const date = dayKey(target);
  const expected = parseReminderTime('09:30', { date }).at;

  const r = parse(await remind.execute(ctx, { action: 'add', date, at: '09:30', text: '先开仙舟，再点吐纳和纳灵石' }));
  assert.equal(r.created, true, JSON.stringify(r));
  assert.ok(r.at.includes(date), `回执要带完整日期：${r.at}`);
  assert.match(r.at, /周[日一二三四五六]/);
  const item = store.list('private:1')[0];
  assert.equal(item.at, expected);
});

test('remind 工具：at 直接写 "YYYY-MM-DD HH:MM" 等价', async () => {
  const store = new ReminderStore(path.join(dataDir, 'r-abs2.json'));
  const ctx = { chatKey: 'private:2', kind: 'private', chatId: '2', reminders: store };
  const date = dayKey(Date.now() + 2 * 24 * 3600 * 1000);
  const r = parse(await remind.execute(ctx, { action: 'add', at: `${date} 23:59`, text: '交作业' }));
  assert.equal(r.created, true, JSON.stringify(r));
  assert.equal(store.list('private:2')[0].at, parseReminderTime(`${date} 23:59`).at);
});

test('remind 工具：minutes 与 at/date 互斥（旧实现静默丢 minutes，模型以为钉住了日期）', async () => {
  const store = new ReminderStore(path.join(dataDir, 'r-abs3.json'));
  const ctx = { chatKey: 'private:3', kind: 'private', chatId: '3', reminders: store };
  const both = await remind.execute(ctx, { action: 'add', at: '10:00', minutes: 2880, text: 'x' });
  assert.equal(both.isError, true);
  assert.match(both.content, /二选一/);
  const dateAndMinutes = await remind.execute(ctx, { action: 'add', date: dayKey(Date.now() + 86400000), minutes: 60, text: 'x' });
  assert.equal(dateAndMinutes.isError, true);
  assert.equal(store.list('private:3').length, 0, '被拒的调用不能落库');
});

test('remind 工具：过去的时间 / 超过一个月 / 什么时间都没给，都要可读报错', async () => {
  const store = new ReminderStore(path.join(dataDir, 'r-abs4.json'));
  const ctx = { chatKey: 'private:4', kind: 'private', chatId: '4', reminders: store };
  const past = await remind.execute(ctx, { action: 'add', at: '2020-01-01 10:00', text: 'x' });
  assert.equal(past.isError, true);
  assert.match(past.content, /已经过去/);

  const far = dayKey(Date.now() + 40 * 24 * 3600 * 1000);
  const tooFar = await remind.execute(ctx, { action: 'add', date: far, at: '10:00', text: 'x' });
  assert.equal(tooFar.isError, true);
  assert.match(tooFar.content, /一个月/);

  const none = await remind.execute(ctx, { action: 'add', text: 'x' });
  assert.equal(none.isError, true);
  assert.match(none.content, /要给时间/);
});

test('remind 工具：repeat 的首次触发点按周期对齐（weekly:mon 不再先在周五响一次）', async () => {
  const store = new ReminderStore(path.join(dataDir, 'r-abs5.json'));
  const ctx = { chatKey: 'private:5', kind: 'private', chatId: '5', reminders: store };
  const r = parse(await remind.execute(ctx, { action: 'add', at: '23:59', repeat: 'weekly:mon', text: '周会' }));
  assert.equal(r.created, true, JSON.stringify(r));
  const item = store.list('private:5')[0];
  assert.equal(shanghai(item.at).getUTCDay(), 1, '首次触发必须是周一：' + formatReminderAt(item.at));
  assert.equal(shanghai(item.at).getUTCHours(), 23);
  assert.equal(shanghai(item.at).getUTCMinutes(), 59);
  // 只给 cron 也能算首次触发点
  const cron = parse(await remind.execute(ctx, { action: 'add', repeat: '0 10 * * 1', text: '周一站会' }));
  assert.equal(cron.created, true, JSON.stringify(cron));
  const cronItem = store.list('private:5').find((x) => x.text === '周一站会');
  assert.equal(shanghai(cronItem.at).getUTCDay(), 1);
  assert.equal(shanghai(cronItem.at).getUTCHours(), 10);
});

test('remind 工具：显式日期与 repeat 不自洽时报错，不自作主张', async () => {
  const store = new ReminderStore(path.join(dataDir, 'r-abs6.json'));
  const ctx = { chatKey: 'private:6', kind: 'private', chatId: '6', reminders: store };
  // 找一个"下周一"和一个"下周二"，用它们验 mismatc
  const now = Date.now();
  const monday = (() => {
    const d = shanghai(now);
    let delta = (1 - d.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    return now + delta * 86400000;
  })();
  const mondayKey = dayKey(monday);
  const tuesdayKey = dayKey(monday + 86400000);
  const ok = parse(await remind.execute(ctx, { action: 'add', date: mondayKey, at: '10:00', repeat: 'weekly:mon', text: 'a' }));
  assert.equal(ok.created, true, JSON.stringify(ok));
  const bad = await remind.execute(ctx, { action: 'add', date: tuesdayKey, at: '10:00', repeat: 'weekly:mon', text: 'b' });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /每周一/);
});
