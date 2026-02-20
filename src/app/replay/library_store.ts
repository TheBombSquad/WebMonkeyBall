import type { ReplayData } from '../../replay.js';
import type { ReplaySummary } from './summary.js';

const DB_NAME = 'smb_replay_library';
const DB_VERSION = 1;
const STORE_NAME = 'replays';

export type ReplayLibraryRecord = {
  id: string;
  name: string;
  savedAt: number;
  replay: ReplayData;
  summary: ReplaySummary;
};

function generateReplayId() {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${now}_${rand}`;
}

export class ReplayLibraryStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private getDb() {
    if (this.dbPromise) {
      return this.dbPromise;
    }
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('Failed to open replay library'));
      };
    });
    return this.dbPromise;
  }

  private async runTransaction<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore, resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void) => void,
  ): Promise<T> {
    const db = await this.getDb();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      run(store, resolve, reject);
    });
  }

  async list() {
    const records = await this.runTransaction<ReplayLibraryRecord[]>('readonly', (store, resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const items = Array.isArray(request.result) ? request.result as ReplayLibraryRecord[] : [];
        items.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
        resolve(items);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('Failed to read replay list'));
      };
    });
    return records;
  }

  async get(id: string) {
    return this.runTransaction<ReplayLibraryRecord | null>('readonly', (store, resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => {
        resolve((request.result as ReplayLibraryRecord | undefined) ?? null);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('Failed to read replay'));
      };
    });
  }

  async save(record: ReplayLibraryRecord) {
    await this.runTransaction<void>('readwrite', (store, resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error ?? new Error('Failed to save replay'));
      };
    });
  }

  async add(replay: ReplayData, summary: ReplaySummary, name?: string) {
    const record: ReplayLibraryRecord = {
      id: generateReplayId(),
      name: (name ?? '').trim() || '',
      savedAt: Date.now(),
      replay,
      summary,
    };
    await this.save(record);
    return record;
  }

  async rename(id: string, nextName: string) {
    const existing = await this.get(id);
    if (!existing) {
      return null;
    }
    const trimmed = nextName.trim();
    existing.name = trimmed.length > 0 ? trimmed : existing.name;
    await this.save(existing);
    return existing;
  }

  async remove(id: string) {
    await this.runTransaction<void>('readwrite', (store, resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error ?? new Error('Failed to delete replay'));
      };
    });
  }
}
