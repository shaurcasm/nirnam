import type { InternalMessage } from './types';

const DB_NAME = 'nirnam-agent-history-v1';
const STORE_NAME = 'histories';

let db: IDBDatabase | null = null;

function openHistoryDb(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };
    /* istanbul ignore next */
    req.onerror = () => reject(req.error);
  });
}

/** Reset the cached DB handle — used in tests to get a fresh database each run. */
export function resetHistoryDb(): void {
  db = null;
}

export async function saveAgentHistory(agentId: string, history: InternalMessage[]): Promise<void> {
  const database = await openHistoryDb();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put([...history], agentId);
    req.onsuccess = () => resolve();
    /* istanbul ignore next */
    req.onerror = () => reject(req.error);
  });
}

export async function loadAgentHistory(agentId: string): Promise<InternalMessage[] | null> {
  const database = await openHistoryDb();
  return new Promise<InternalMessage[] | null>((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(agentId);
    req.onsuccess = () => resolve((req.result as InternalMessage[] | undefined) ?? null);
    /* istanbul ignore next */
    req.onerror = () => reject(req.error);
  });
}

export async function deleteAgentHistory(agentId: string): Promise<void> {
  const database = await openHistoryDb();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(agentId);
    req.onsuccess = () => resolve();
    /* istanbul ignore next */
    req.onerror = () => reject(req.error);
  });
}
