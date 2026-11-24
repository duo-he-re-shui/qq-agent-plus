import { safeFetchBinary } from '../llm/safe-fetch.js';
import { imageType } from '../core/image-type.js';
import { toVisionDataUrl } from '../tools/tools-core.js';
import { assertTimeAllowed } from '../core/time-gate.js';

export const QZONE_IMAGE_TOKENS = 4096;
export const QZONE_MAX_IMAGES = 6;
const MAX_IMAGE_CHARS = 3 * 1024 * 1024;
const MAX_TOTAL_CHARS = 8 * 1024 * 1024;

export async function downloadQzoneImage(url, signal) {
  // Qzone images are untrusted external URLs. Never forward login cookies or inherit private-host exceptions.
  const { buffer } = await safeFetchBinary(url, 8 * 1024 * 1024, signal, {
    allowPrivate: false,
    headers: { referer: 'https://user.qzone.qq.com/' }
  });
  const mime = imageType(buffer);
  if (!mime) throw new Error('图片格式无效');
  const dataUrl = await toVisionDataUrl(buffer, mime, signal);
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl) || dataUrl.length > MAX_IMAGE_CHARS) {
    throw new Error('图片格式不支持或转换后过大');
  }
  return dataUrl;
}

function imageSources(batch) {
  const sources = [];
  const add = (id, source, target, original) => {
    if (target && original?.images?.length) sources.push({ id, source, target, urls: original.images.slice(0, 9) });
  };
  // Give the actual incoming comment priority over its post and conversation context.
  for (const item of batch.replies) add(item.id, 'comment', item.data, item.state.comment);
  for (const item of batch.replies) add(item.id, 'post', item.data.post, item.state.post);
  for (const item of batch.feeds) add(item.id, 'post', item.data, item.state.post);
  for (const item of batch.replies) {
    const context = (item.state.context || []).slice(-10);
    for (let i = 0; i < context.length; i++) add(item.id, `thread[${i}]`, item.data.thread[i], context[i]);
  }
  for (const item of batch.feeds) {
    const comments = (item.state.post.comments || []).slice(-8);
    for (let i = 0; i < comments.length; i++) add(item.id, `recentComments[${i}]`, item.data.recentComments[i], comments[i]);
  }
  return sources;
}

/** Source URLs stay in private state; public metadata contains statuses and image bytes stay in memory. */
export async function prepareQzoneImages(batch, {
  enabled, signal, download = downloadQzoneImage,
  tokenBudget = QZONE_MAX_IMAGES * QZONE_IMAGE_TOKENS, timeoutMs = 30000, imageTimeoutMs = 10000
} = {}) {
  const parts = [];
  const summary = { loaded: 0, failed: 0, omitted: 0 };
  const groups = new Map();
  for (const source of imageSources(batch)) {
    source.target.imageReadStatus = [];
    source.urls.forEach((url, index) => {
      const status = { index: index + 1, status: 'unread' };
      source.target.imageReadStatus.push(status);
      if (!groups.has(url)) groups.set(url, []);
      groups.get(url).push({ status, label: `${source.id}.${source.source} 第${index + 1}张` });
    });
  }
  const maxImages = Math.min(QZONE_MAX_IMAGES, Math.floor(Math.max(0, tokenBudget) / QZONE_IMAGE_TOKENS));
  const deadline = Date.now() + timeoutMs;
  let attempted = 0;
  let totalChars = 0;
  for (const [url, bindings] of groups) {
    signal?.throwIfAborted();
    let status;
    if (!enabled) status = 'vision_disabled';
    else if (attempted >= maxImages || Date.now() >= deadline) status = 'limit';
    else {
      assertTimeAllowed('');
      attempted += 1;
      try {
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(imageTimeoutMs, deadline - Date.now())));
        const imageSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const dataUrl = await download(url, imageSignal);
        imageSignal.throwIfAborted();
        signal?.throwIfAborted();
        if (!/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)
          || dataUrl.length > MAX_IMAGE_CHARS || totalChars + dataUrl.length > MAX_TOTAL_CHARS) {
          throw new Error('图片内容无效或超过本轮大小限制');
        }
        totalChars += dataUrl.length;
        parts.push({ type: 'text', text: `【图片归属：${bindings.map((b) => b.label).join('；')}】` });
        parts.push({ type: 'image_url', image_url: { url: dataUrl } });
        status = 'loaded';
        summary.loaded += 1;
      } catch {
        signal?.throwIfAborted();
        status = 'unavailable';
        summary.failed += 1;
      }
    }
    if (status === 'limit' || status === 'vision_disabled') summary.omitted += 1;
    for (const binding of bindings) binding.status.status = status;
  }
  return { parts, summary };
}

export function qzoneImageAuditMessages(messages) {
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content) ? message.content.map((part) => part.type === 'image_url'
      ? { ...part, image_url: { ...part.image_url, url: '[inline image omitted from audit snapshot]' } }
      : structuredClone(part)) : message.content
  }));
}
