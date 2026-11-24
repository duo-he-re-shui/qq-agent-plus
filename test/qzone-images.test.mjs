import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-qzone-images-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { prepareQzoneImages, qzoneImageAuditMessages, downloadQzoneImage } = await import('../src/features/qzone-images.js');
const { parseQzoneFeed, parseQzoneRawComments, qzoneImagesFromRaw, QzoneWebClient } = await import('../src/onebot/qzone-feed.js');
const { QzoneInteractionManager } = await import('../src/features/qzone-interactions.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.api.model = 'mock';
cfg.api.vision = true;
setRuntimeConfig(cfg);

function batch(urls = ['https://example.com/comment.png']) {
  const comment = { images: urls };
  const post = { images: ['https://example.com/post.png'] };
  return { feeds: [], replies: [{ id: 'reply-1', state: { comment, post, context: [comment] }, data: { post: {}, thread: [{}] } }] };
}

test('raw Qzone pictures preserve native picture variants, nested replies, and image-only comments', () => {
  const comments = parseQzoneRawComments([{ tid: 1, uin: 111, content: '',
    pic: [{ url3: '//photo.store.qq.com/large?a=1&amp;b=2', smallurl: 'https://example.com/small' }],
    list_3: [{ tid: 2, uin: 222, content: '[img]https://example.com/reply.png[/img]' }]
  }]);
  assert.deepEqual(comments[0].images, ['https://photo.store.qq.com/large?a=1&b=2']);
  assert.equal(comments[0].content, '');
  assert.deepEqual(comments[1].images, ['https://example.com/reply.png']);
  assert.deepEqual(qzoneImagesFromRaw({ pic: [{ b_url: 'https://example.com/big.jpg', hd_url: 'https://example.com/hd.jpg', s_url: 'https://example.com/small.jpg' }] }), ['https://example.com/hd.jpg']);
  assert.equal(comments[1].content, '[图片]');
  assert.equal(comments[1].parentTid, '1');
  assert.deepEqual(qzoneImagesFromRaw({ content: 'https://example.com/link', avatar: 'https://example.com/avatar' }), []);
  assert.deepEqual(qzoneImagesFromRaw({ pic: ['javascript:alert(1)', 'https://name:pass@example.com/a', 'https://qzonestyle.gtimg.cn/e.png'] }), []);
});

test('feed HTML separates post, parent and child pictures and excludes avatars and native emoticons', () => {
  const post = parseQzoneFeed({ html: `<div class="img-box"><img data-src="//example.com/post.png" src="about:blank"></div>
    <li class="comments-item" data-tid="1" data-uin="111"><img class="avatar" src="https://example.com/avatar.png">
      <div class="comments-content">parent<img data-original="https://example.com/parent.png"><img src="https://qzonestyle.gtimg.cn/emoji.gif"></div>
      <div class="mod-comments-sub"><li class="comments-item" data-tid="2" data-uin="222"><div class="comments-content"><div class="img-box"><img src="https://example.com/child.png"></div></div></li></div>
    </li>` });
  assert.deepEqual(post.images, ['https://example.com/post.png']);
  assert.deepEqual(post.comments[0].images, ['https://example.com/parent.png']);
  assert.deepEqual(post.comments[1].images, ['https://example.com/child.png']);
});

test('detail endpoint preserves post and comment pictures from real Qzone pic fields', async () => {
  const client = new QzoneWebClient({ selfId: '888', call: async () => ({ cookies: 'skey=S' }) }, {
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, pic: [{ url2: 'https://example.com/post.png' }],
      commentlist: [{ tid: 1, uin: 123, pic: [{ url: 'https://example.com/comment.png' }] }] }))
  });
  const detail = await client.getPostDetail('888', 'post');
  assert.deepEqual(detail.images, ['https://example.com/post.png']);
  assert.deepEqual(detail.comments[0].images, ['https://example.com/comment.png']);
});

test('image preparation prioritizes incoming comments, deduplicates context, labels ownership and respects token limits', async () => {
  const b = batch();
  const downloaded = [];
  const result = await prepareQzoneImages(b, { enabled: true, tokenBudget: 4096,
    download: async (url) => { downloaded.push(url); return IMAGE; } });
  assert.deepEqual(downloaded, ['https://example.com/comment.png']);
  assert.deepEqual(result.summary, { loaded: 1, failed: 0, omitted: 1 });
  assert.match(result.parts[0].text, /reply-1.comment 第1张/);
  assert.match(result.parts[0].text, /reply-1.thread\[0\] 第1张/);
  assert.equal(b.replies[0].data.imageReadStatus[0].status, 'loaded');
  assert.equal(b.replies[0].data.post.imageReadStatus[0].status, 'limit');
  assert.equal(b.replies[0].data.thread[0].imageReadStatus[0].status, 'loaded');
  assert.doesNotMatch(JSON.stringify(b.replies[0].data), /https:|base64/);
});

test('disabled vision never downloads; download failures stay explicit and do not hide other pictures', async () => {
  const disabled = batch();
  await prepareQzoneImages(disabled, { enabled: false, download: async () => assert.fail('should not download') });
  assert.equal(disabled.replies[0].data.imageReadStatus[0].status, 'vision_disabled');
  const b = batch();
  const result = await prepareQzoneImages(b, { enabled: true, download: async (url) => {
    if (url.includes('comment')) throw Error('HTTP 403 https://secret.example/token');
    return IMAGE;
  } });
  assert.deepEqual(result.summary, { loaded: 1, failed: 1, omitted: 0 });
  assert.equal(b.replies[0].data.imageReadStatus[0].status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(b.replies[0].data), /secret|403/);
});

test('image timeout degrades to unavailable while user cancellation interrupts preparation', async () => {
  const timed = batch();
  const waitForAbort = (_url, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(IMAGE), 100);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  await prepareQzoneImages(timed, { enabled: true, download: waitForAbort, imageTimeoutMs: 5 });
  assert.equal(timed.replies[0].data.imageReadStatus[0].status, 'unavailable');
  const controller = new AbortController();
  await assert.rejects(prepareQzoneImages(batch(), { enabled: true, signal: controller.signal,
    download: async () => { controller.abort(Error('stop image preparation')); throw controller.signal.reason; }
  }), /stop image preparation/);
});

test('oversized images and private hosts are rejected; audit snapshots omit bytes without changing actual input', async () => {
  const b = batch();
  const result = await prepareQzoneImages(b, { enabled: true, download: async () => 'data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024) });
  assert.equal(result.parts.length, 0);
  assert.equal(result.summary.failed, 2);
  await assert.rejects(downloadQzoneImage('http://127.0.0.1/test.png'), /内网|本机/);
  const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: IMAGE } }] }];
  const audit = qzoneImageAuditMessages(messages);
  assert.doesNotMatch(JSON.stringify(audit), /base64|iVBOR/);
  assert.equal(messages[0].content[0].image_url.url, IMAGE);
});

test('manager sends incoming comment and post pixels to the model but never stores image bytes or replays replies', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.mode = 'active';
  config.api.model = 'mock';
  config.api.vision = true;
  config.qzoneInteractions = { ...config.qzoneInteractions, enabled: true, startupCatchup: true, actionDelayMinMs: 0, actionDelayMaxMs: 0 };
  setRuntimeConfig(config);
  const now = Date.now(), time = Math.floor(now / 1000);
  const post = { uin: '888', tid: 'post', nickname: 'Bot', content: '配图动态', time,
    images: ['https://example.com/post.png'], commentCount: 1,
    comments: [{ commentId: '1', tid: '1', parentTid: '', uin: '123', nickname: 'Friend', content: '', time,
      images: ['https://example.com/comment.png'] }] };
  let writes = 0, modelCalls = 0;
  const snapshots = [], current = new Map();
  const sessions = { current, create: () => { const s = { id: 'test', messages: [] }; current.set(s.id, s); return s; },
    update: (id) => snapshots.push(structuredClone(current.get(id))), finish: (id) => current.delete(id) };
  const stateFile = path.join(root, 'manager-state.json');
  const manager = new QzoneInteractionManager({ sessions, stateFile, now: () => now,
    onebot: { selfId: '888', call: async () => ({ msglist: [{ tid: 'post', content: post.content, time, comment_num: 1 }] }) },
    qzoneWeb: { getPostDetail: async () => post, replyComment: async () => { writes++; return { commentId: 'sent' }; } },
    downloadImage: async () => IMAGE,
    complete: async ({ messages }) => {
      modelCalls++;
      const parts = messages.flatMap((m) => Array.isArray(m.content) ? m.content : []);
      assert.equal(parts.filter((p) => p.type === 'image_url').length, 2);
      assert.match(parts[0].text, /reply-1.comment/);
      assert.match(messages[1].content, /"imageCount":1/);
      assert.doesNotMatch(messages[1].content, /https:\/\/example|base64/);
      return { model: 'mock', message: { tool_calls: [{ id: 'submit', type: 'function', function: {
        name: 'submit_qzone_interactions', arguments: JSON.stringify({ feedActions: [], replyActions: [{ id: 'reply-1', action: 'reply', content: '这张有意思', reason: '承接配图' }] })
      } }] }, usage: {} };
    }
  });
  const result = await manager.runNow('reply');
  assert.equal(result.run.status, 'done');
  assert.equal(result.run.images.loaded, 2);
  assert.equal(writes, 1);
  assert.doesNotMatch(JSON.stringify(snapshots), /base64|iVBOR/);
  assert.doesNotMatch(fs.readFileSync(stateFile, 'utf8'), /base64|iVBOR/);
  assert.deepEqual(manager.state.watchedPosts[0].images, post.images);
  await manager.runNow('reply');
  assert.equal(writes, 1);
  assert.equal(modelCalls, 1);
});
