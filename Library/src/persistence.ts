const DB_NAME = 'nirnam-persistence-v1';
const STORE_NAME = 'messages';
const DB_VERSION = 1;

export const DEFAULT_PERSISTENCE_TTL = 60_000;

export interface PersistedMessage {
  messageId: string;
  topic: string;
  payload: unknown;
  timestamp: number;
  expiresAt: number;
  /** Monotonically increasing write counter — tie-breaks same-millisecond writes. */
  seq: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let _writeOrder = 0;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'messageId' });
      store.createIndex('by_topic', 'topic', { unique: false });
      store.createIndex('by_expires', 'expiresAt', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

/** Reset the cached DB connection and write counter — used in tests to get a fresh database. */
export function resetPersistenceDb(): void {
  dbPromise = null;
  _writeOrder = 0;
}

/**
 * Write a message to IndexedDB with a TTL.
 * Uses `messageId` (UUID) as the primary key — duplicate writes are idempotent
 * since IDBObjectStore.put() upserts by primary key.
 * Expired entries are pruned asynchronously after each write.
 */
export async function persistMessage(
  topic: string,
  payload: unknown,
  ttl: number,
): Promise<string> {
  const db = await getDb();
  const messageId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? (crypto as unknown as { randomUUID(): string }).randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const now = Date.now();
  const record: PersistedMessage = {
    messageId,
    topic,
    payload,
    timestamp: now,
    expiresAt: now + ttl,
    seq: _writeOrder++,
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  pruneExpired(db).catch(() => {});
  return messageId;
}

/**
 * Query the last `limit` non-expired messages for a topic, in chronological order.
 */
export async function replayMessages(
  topic: string,
  limit: number,
): Promise<PersistedMessage[]> {
  const db = await getDb();
  const now = Date.now();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).index('by_topic').getAll(topic);
    req.onsuccess = () => {
      const valid = (req.result as PersistedMessage[])
        .filter(m => m.expiresAt > now)
        .sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);
      resolve(valid.slice(-limit));
    };
    req.onerror = () => reject(req.error);
  });
}

function pruneExpired(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx
      .objectStore(STORE_NAME)
      .index('by_expires')
      .openCursor(IDBKeyRange.upperBound(Date.now()));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
