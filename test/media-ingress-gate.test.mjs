import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaIngressGate } from '../src/core/media-ingress-gate.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

test('video link wake waits for all frame-download jobs in the same chat', async () => {
  const gate = new MediaIngressGate();
  const first = deferred();
  const second = deferred();
  const woken = [];
  gate.hold('group:1', first.promise);
  const firstWake = gate.wake('group:1', () => woken.push('first'));
  gate.hold('group:1', second.promise);
  const secondWake = gate.wake('group:1', () => woken.push('second'));

  first.resolve();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(woken, [], 'first completion must not release the later video job');
  second.resolve();
  await Promise.all([firstWake, secondWake]);
  assert.deepEqual(woken.sort(), ['first', 'second']);
});

test('download failure releases the model wake and reports the error', async () => {
  const errors = [];
  const gate = new MediaIngressGate({ onError: (chatKey, error) => errors.push([chatKey, error.message]) });
  const failed = deferred();
  let woke = false;
  gate.hold('private:1', failed.promise);
  const wake = gate.wake('private:1', () => { woke = true; });
  failed.reject(new Error('video unavailable'));
  await wake;
  assert.equal(woke, true);
  assert.deepEqual(errors, [['private:1', 'video unavailable']]);
});

test('messages without a held video wake immediately', () => {
  const gate = new MediaIngressGate();
  let woke = false;
  gate.wake('group:2', () => { woke = true; });
  assert.equal(woke, true);
});
