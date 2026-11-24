import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMediaForwarding } from '../src/features/media-forward-bridge.js';
import { protocolMediaPath } from '../src/features/media-forward-common.js';
import { OneBotClient } from '../src/onebot/onebot.js';

test('shared host media maps to the protocol mount and rejects escaping paths', () => {
  const root = path.join(os.tmpdir(), 'shared-media');
  const cfg = { mediaDir: root, protocolMediaDir: '/app/data/data/video-forward/bilibili' };
  assert.equal(protocolMediaPath(path.join(root, 'job-a', 'v.mp4'), cfg), '/app/data/data/video-forward/bilibili/job-a/v.mp4');
  assert.throws(() => protocolMediaPath(path.join(root, '..', 'config.json'), cfg), /目录内/);
  assert.equal(protocolMediaPath('/existing/file.mp4', {}), '/existing/file.mp4');
});

test('paused or disallowed chats and self messages never enter either downloader', () => {
  let allowed = false;
  const bridge = createMediaForwarding({ getConfig: () => ({}), canRun: () => allowed });
  const calls = [];
  bridge.bilibili.handleMessage = () => calls.push('bili');
  bridge.douyin.handleMessage = () => calls.push('douyin');
  bridge.handleMessage({ chatKey: 'group:12345' });
  allowed = true;
  bridge.handleMessage({ chatKey: 'group:12345', isSelf: true });
  assert.deepEqual(calls, []);
  bridge.handleMessage({ chatKey: 'group:12345' });
  assert.deepEqual(calls, ['bili', 'douyin']);
});

test('downloaded frames attach to the original link without modifying its text', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-bridge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'video.mp4');
  await fs.writeFile(file, 'video');
  const updates = [];
  const bridge = createMediaForwarding({
    getConfig: () => ({ messageTypes: { images: true, videoFrames: true } }), canRun: () => true,
    store: { findByMid: () => ({ text: 'original link' }), updateByMid: (...args) => updates.push(args) },
    extractFrames: async () => Buffer.from('frames')
  });
  await bridge.bilibili.onVideoReady({ chatKey: 'group:12345', messageId: '42', file });
  assert.equal(updates.length, 1);
  assert.equal(updates[0][1], '42');
  assert.equal(updates[0][2].text, undefined);
  assert.equal(updates[0][2].appendMedia[0].url, 'base64://ZnJhbWVz');
});

test('disabled video viewing does not extract or store frames', async () => {
  const bridge = createMediaForwarding({ getConfig: () => ({ messageTypes: { videoFrames: false } }),
    canRun: () => true, extractFrames: () => assert.fail('frame extraction disabled') });
  await bridge.douyin.onVideoReady({ chatKey: 'private:12345', messageId: '42', file: 'missing-file' });
});

test('video and normal images use the existing protocol route and media timeout', async () => {
  const calls = [];
  const fake = { sendSegments: async (...args) => { calls.push(args); return { message_id: 7 }; } };
  await OneBotClient.prototype.sendVideo.call(fake, 'private', '12345', '/app/data/video.mp4', { replyToMessageId: '-42' });
  await OneBotClient.prototype.sendImage.call(fake, 'group', '12345', 'base64://a', { text: 'video caption' });
  assert.equal(calls[0][2][1].type, 'video');
  assert.equal(calls[0][4].timeoutMs, 60000);
  assert.deepEqual(calls[1][2].map(s => s.type), ['text', 'image']);
  assert.equal(calls[1][2][1].data.sub_type, undefined);
});
