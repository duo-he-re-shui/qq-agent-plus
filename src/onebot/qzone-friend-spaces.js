// A bounded read-only alternative when the account's home timeline is unavailable.
// SnowLuma 2.0.3 supports target_uin on get_qzone_msg_list independently of feeds.
export async function fetchQzoneFriendSpaces(onebot, options = {}) {
  const { signal, cursor = '', sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = options;
  signal?.throwIfAborted();
  const raw = await onebot.call('get_friend_list', {}, 10000, signal);
  if (!Array.isArray(raw)) throw new Error('个人空间兜底：好友列表返回格式无效');
  const friends = [...new Map(raw.filter((friend) => (
    /^[1-9]\d*$/.test(String(friend?.user_id || ''))
    && Number.isSafeInteger(Number(friend.user_id))
    && String(friend.user_id) !== String(onebot.selfId)
  )).map((friend) => [String(friend.user_id), friend])).values()]
    .sort((a, b) => String(a.user_id).localeCompare(String(b.user_id), 'en'));
  let start = friends.findIndex((friend) => String(friend.user_id).localeCompare(String(cursor), 'en') > 0);
  if (start < 0) start = 0;
  const feeds = [];
  const successfulUins = [];
  const stats = { totalFriends: friends.length, attempted: 0, succeeded: 0, failed: 0 };
  let nextCursor = cursor;
  let lastError;
  const count = Math.min(20, Math.max(1, Number(options.count) || 20));
  for (let i = 0; i < Math.min(5, friends.length); i++) {
    signal?.throwIfAborted();
    if (i) await sleep(1000);
    signal?.throwIfAborted();
    const friend = friends[(start + i) % friends.length];
    const uin = String(friend.user_id);
    stats.attempted += 1;
    try {
      const result = await onebot.call('get_qzone_msg_list', { target_uin: Number(uin), pos: 0, num: count }, 30000, signal);
      if (!Array.isArray(result?.msglist)) throw new Error('个人空间说说列表返回格式无效');
      for (const item of result.msglist.slice(0, count)) {
        if (!item || !item.tid || item.is_private === true) continue;
        feeds.push({
          uin, nickname: String(friend.nickname || friend.remark || ''),
          key: String(item.tid), tid: String(item.tid), appid: 311,
          time: item.time, content: item.content, images: item.images,
          html: ''
        });
      }
      stats.succeeded += 1;
      successfulUins.push(uin);
    } catch (error) {
      signal?.throwIfAborted();
      stats.failed += 1;
      lastError = error;
    }
    nextCursor = uin;
  }
  return { feeds, cursor: nextCursor, successfulUins, stats, lastError };
}
