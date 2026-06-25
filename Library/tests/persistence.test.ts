/**
 * Tests for the IndexedDB persistence layer (Feature 6).
 *
 * Each test gets a fresh IDBFactory so state never leaks between cases.
 * fake-indexeddb/auto sets globalThis.IDBKeyRange and friends; we swap out
 * globalThis.indexedDB per-test to get an isolated in-memory database.
 */

// Hoisted before any import — same pattern as bus.test.ts.
jest.mock('../src/worker-source', () => ({ default: '/* mock worker script */' }));

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { persistMessage, replayMessages, resetPersistenceDb } from '../src/persistence';
import { createBus } from '../src/bus';
import { resetWorkerState, resetBroadcastChannels } from './setup';

/**
 * Drain N setImmediate phases from the event loop.
 * fake-indexeddb schedules each IDB callback (onsuccess, oncomplete, etc.)
 * via setImmediate, so microtask-based flushes are not sufficient for publish()
 * calls that fire-and-forget persistMessage().
 * Each persist call takes ~4 setImmediate phases; use 12 to cover two concurrent writes.
 */
const drainIdb = async (cycles = 12) => {
  for (let i = 0; i < cycles; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
};

beforeEach(() => {
  (global as unknown as Record<string, unknown>).indexedDB = new IDBFactory();
  resetPersistenceDb();
  resetWorkerState();
  resetBroadcastChannels();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// persistMessage / replayMessages — unit tests
// ---------------------------------------------------------------------------

describe('persistMessage', () => {
  it('returns a non-empty messageId string', async () => {
    const id = await persistMessage('t', 42, 60_000);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('each call returns a unique messageId', async () => {
    const ids = await Promise.all([
      persistMessage('t', 1, 60_000),
      persistMessage('t', 2, 60_000),
      persistMessage('t', 3, 60_000),
    ]);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('replayMessages', () => {
  it('returns a persisted message for the matching topic', async () => {
    await persistMessage('counter', 42, 60_000);
    const msgs = await replayMessages('counter', 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload).toBe(42);
    expect(msgs[0].topic).toBe('counter');
  });

  it('returns an empty array when there are no messages', async () => {
    const msgs = await replayMessages('nothing', 10);
    expect(msgs).toHaveLength(0);
  });

  it('does not return expired messages', async () => {
    // ttl = -1000 → expiresAt is 1 second in the past
    await persistMessage('t', 'stale', -1_000);
    const msgs = await replayMessages('t', 10);
    expect(msgs).toHaveLength(0);
  });

  it('returns only non-expired messages when mixed', async () => {
    await persistMessage('t', 'stale', -1_000);
    await persistMessage('t', 'fresh', 60_000);
    const msgs = await replayMessages('t', 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload).toBe('fresh');
  });

  it('returns messages in chronological order (oldest first)', async () => {
    await persistMessage('t', 'a', 60_000);
    await persistMessage('t', 'b', 60_000);
    await persistMessage('t', 'c', 60_000);
    const msgs = await replayMessages('t', 10);
    expect(msgs.map(m => m.payload)).toEqual(['a', 'b', 'c']);
  });

  it('respects the limit — returns only the last N messages', async () => {
    await persistMessage('t', 1, 60_000);
    await persistMessage('t', 2, 60_000);
    await persistMessage('t', 3, 60_000);
    await persistMessage('t', 4, 60_000);
    const msgs = await replayMessages('t', 2);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].payload).toBe(3);
    expect(msgs[1].payload).toBe(4);
  });

  it('isolates messages by topic', async () => {
    await persistMessage('topic-a', 'alpha', 60_000);
    await persistMessage('topic-b', 'beta', 60_000);
    const msgs = await replayMessages('topic-a', 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload).toBe('alpha');
  });

  it('persists arbitrary payload types (object, array, null)', async () => {
    await persistMessage('t', { x: 1, y: [2, 3] }, 60_000);
    await persistMessage('t', null, 60_000);
    const msgs = await replayMessages('t', 10);
    expect(msgs[0].payload).toEqual({ x: 1, y: [2, 3] });
    expect(msgs[1].payload).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TTL-based pruning
// ---------------------------------------------------------------------------

describe('pruneExpired (triggered on every write)', () => {
  it('removes expired records so they do not accumulate', async () => {
    await persistMessage('t', 'will-expire', -1_000);
    // A second write triggers pruneExpired for the first record
    await persistMessage('t', 'valid', 60_000);
    const msgs = await replayMessages('t', 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload).toBe('valid');
  });

  it('leaves valid records untouched during pruning', async () => {
    await persistMessage('t', 'a', 60_000);
    await persistMessage('t', 'b', 60_000);
    // Third write triggers pruning; nothing should be removed (both still valid)
    await persistMessage('t', 'c', 60_000);
    const msgs = await replayMessages('t', 10);
    expect(msgs).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Deduplication — put() is idempotent on same primary key
// ---------------------------------------------------------------------------

describe('deduplication', () => {
  it('a second put() with the same messageId does not create a duplicate', async () => {
    const id = await persistMessage('t', 'original', 60_000);

    // Manually write the same messageId again (cross-tab scenario simulation)
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = (global as unknown as { indexedDB: IDBFactory }).indexedDB.open(
        'nirnam-persistence-v1',
        1,
      );
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      tx.objectStore('messages').put({
        messageId: id,
        topic: 't',
        payload: 'duplicate',
        timestamp: Date.now(),
        expiresAt: Date.now() + 60_000,
        seq: 999,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const msgs = await replayMessages('t', 10);
    // Still only one record — put() upserted, not inserted a second row
    expect(msgs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Bus integration — publish({ persist }) + subscribe({ replay })
// ---------------------------------------------------------------------------

describe('NirnamBus persistence integration', () => {
  it('publish with { persist: true } stores the message', async () => {
    const bus = createBus();
    bus.publish('history', { value: 99 }, { persist: true, ttl: 60_000 });
    await drainIdb();

    const msgs = await replayMessages('history', 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload).toEqual({ value: 99 });
    bus.close();
  });

  it('publish without { persist } does not store anything', async () => {
    const bus = createBus();
    bus.publish('ephemeral', 'nope');
    await drainIdb();

    const msgs = await replayMessages('ephemeral', 10);
    expect(msgs).toHaveLength(0);
    bus.close();
  });

  it('subscribe with { replay } delivers past messages to the handler', async () => {
    const bus = createBus();
    bus.publish('events', 'first', { persist: true });
    bus.publish('events', 'second', { persist: true });
    await drainIdb();

    const received: unknown[] = [];
    bus.subscribe('events', v => received.push(v), { replay: 10 });
    await drainIdb();

    expect(received).toEqual(['first', 'second']);
    bus.close();
  });

  it('subscribe with { replay: N } respects the limit', async () => {
    const bus = createBus();
    bus.publish('log', 'a', { persist: true });
    bus.publish('log', 'b', { persist: true });
    bus.publish('log', 'c', { persist: true });
    await drainIdb();

    const received: unknown[] = [];
    bus.subscribe('log', v => received.push(v), { replay: 2 });
    await drainIdb();

    expect(received).toEqual(['b', 'c']);
    bus.close();
  });

  it('subscribe without { replay } does not deliver past messages', async () => {
    const bus = createBus();
    bus.publish('quiet', 'stored', { persist: true });
    await drainIdb();

    const received: unknown[] = [];
    bus.subscribe('quiet', v => received.push(v));
    await drainIdb();

    expect(received).toHaveLength(0);
    bus.close();
  });

  it('uses bus-level defaultTtl when per-publish ttl is omitted', async () => {
    const bus = createBus({ persistence: { defaultTtl: 60_000 } });
    bus.publish('t', 'x', { persist: true });
    await drainIdb();

    const msgs = await replayMessages('t', 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].expiresAt).toBeGreaterThan(Date.now());
    bus.close();
  });

  it('per-publish ttl overrides the bus-level defaultTtl', async () => {
    const bus = createBus({ persistence: { defaultTtl: 60_000 } });
    bus.publish('t', 'x', { persist: true, ttl: -1_000 });
    await drainIdb();

    const msgs = await replayMessages('t', 10);
    expect(msgs).toHaveLength(0);
    bus.close();
  });
});
