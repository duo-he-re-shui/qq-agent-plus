/** Defer a chat wake while a linked video is being downloaded and attached to its message. */
export class MediaIngressGate {
  constructor({ onError = () => {} } = {}) {
    this.pending = new Map();
    this.onError = onError;
  }

  hold(chatKey, task) {
    const key = String(chatKey || '');
    if (!key || !task || typeof task.then !== 'function') return false;
    const jobs = this.pending.get(key) || new Set();
    const barrier = Promise.resolve(task).catch((error) => {
      try { this.onError(key, error); } catch { /* reporting must never strand a chat wake */ }
    });
    jobs.add(barrier);
    this.pending.set(key, jobs);
    barrier.then(() => {
      jobs.delete(barrier);
      if (!jobs.size && this.pending.get(key) === jobs) this.pending.delete(key);
    });
    return true;
  }

  async wake(chatKey, callback) {
    const key = String(chatKey || '');
    while (this.pending.has(key)) {
      const jobs = this.pending.get(key);
      if (jobs?.size) await Promise.all([...jobs]);
    }
    try { return await callback(); }
    catch (error) {
      try { this.onError(key, error); } catch { /* preserve wake safety */ }
      return undefined;
    }
  }
}
