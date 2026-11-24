import fs from 'node:fs/promises';
import { BilibiliAutoForward } from './bilibili-auto-forward.js';
import { DouyinAutoForward } from './douyin-auto-forward.js';
import { convertVideoToFrameStrip } from '../tools/image-downsample.js';

// Keep the established host/plugin architecture. Only forward live, allowed messages.
export function createMediaForwarding({ dataDir, getConfig, sender, store, selfId,
  canRun, onReady = () => {}, log = console, extractFrames = convertVideoToFrameStrip } = {}) {
  const onVideoReady = async ({ chatKey, messageId, file }) => {
    const cfg = getConfig();
    if (!canRun(chatKey) || cfg.messageTypes?.videoFrames === false || cfg.messageTypes?.images === false) return;
    if (messageId == null || !store.findByMid(chatKey, messageId)) return;
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 96 * 1024 * 1024) throw new Error('视频画面提取文件超过限制');
    const strip = await extractFrames(await fs.readFile(file));
    if (!strip?.length || !canRun(chatKey)) return;
    store.updateByMid(chatKey, messageId, { appendMedia: [{
      kind: 'image', url: `base64://${strip.toString('base64')}`, summary: '分享视频的四帧画面'
    }] });
    onReady(chatKey);
  };
  const options = { dataDir, getConfig, sender, log, onVideoReady };
  const bilibili = new BilibiliAutoForward(options);
  const douyin = new DouyinAutoForward({ ...options, selfId });
  return {
    bilibili, douyin,
    handleMessage(message) {
      if (message.isSelf || !canRun(message.chatKey)) return;
      bilibili.handleMessage(message);
      douyin.handleMessage(message);
    }
  };
}
