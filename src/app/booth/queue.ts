/**
 * Offline capture queue (IndexedDB).
 *
 * Generation needs the cloud, so a booth genuinely cannot produce a photo while
 * the venue's connection is down. What it can do is refuse to lose the capture:
 * the frame is stored locally and sent as soon as the network returns, so the
 * organiser still ends up with every visitor's photo.
 */

const DB_NAME = 'ello-booth';
const STORE = 'pending';

export type Pending = {
  id?: number;
  sceneId: string;
  sceneName: string;
  imageBase64: string;
  mimeType: string;
  at: number;
};

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

export const enqueue = (item: Pending) => tx('readwrite', (s) => s.add(item));
export const all = () => tx<Pending[]>('readonly', (s) => s.getAll());
export const drop = (id: number) => tx('readwrite', (s) => s.delete(id));

export async function count(): Promise<number> {
  try {
    return (await all()).length;
  } catch {
    return 0;
  }
}

/**
 * Sends everything queued, oldest first, and stops at the first failure so a
 * still-flaky connection does not burn through the backlog.
 */
export async function flush(token: string): Promise<{ sent: number; left: number }> {
  let sent = 0;
  const items = (await all()).sort((a, b) => a.at - b.at);

  for (const item of items) {
    try {
      const res = await fetch('/api/booth/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sceneId: item.sceneId,
          imageBase64: item.imageBase64,
          mimeType: item.mimeType,
        }),
      });

      // A 4xx means this capture will never succeed - drop it rather than
      // retrying forever. Only network errors and 5xx are worth another go.
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        if (item.id != null) await drop(item.id);
        if (res.ok) sent++;
        continue;
      }
      break;
    } catch {
      break; // still offline
    }
  }

  return { sent, left: await count() };
}
