import { md5, selectImage } from './model.js';

const STORE = 'tupianhuancun';

function requestResult(request, signal, { onTimeout, onLateResult } = {}) {
    return new Promise((resolve, reject) => {
        let done = false;
        const settle = (value, error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            if (error) reject(error);
            else resolve(value);
        };
        const cancel = () => {
            onTimeout?.();
            settle(null, signal.reason);
        };
        const timer = setTimeout(() => { onTimeout?.(); settle(null); }, 5000);
        request.onsuccess = () => done ? onLateResult?.(request.result) : settle(request.result);
        request.onerror = () => settle(null);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
    });
}

async function openExisting(database, signal) {
    if (!globalThis.indexedDB) return null;
    const request = indexedDB.open(database);
    // Missing databases must not be created, even on browsers without databases().
    request.onupgradeneeded = () => request.transaction.abort();
    const db = await requestResult(request, signal, { onLateResult: result => result.close() });
    if (!db) return null;
    if (!db.objectStoreNames.contains(STORE)) { db.close(); return null; }
    db.onversionchange = () => db.close();
    return db;
}

async function readRecord(db, key, signal) {
    signal?.throwIfAborted();
    if (!db || typeof key !== 'string') return null;
    try {
        const tx = db.transaction(STORE, 'readonly');
        return await requestResult(tx.objectStore(STORE).get(key), signal, {
            onTimeout: () => { try { tx.abort(); } catch { /* already closed */ } },
        });
    } catch (error) {
        if (signal?.aborted) throw error;
        return null;
    }
}

export async function openChatu8(settings = {}, signal) {
    signal?.throwIfAborted();
    let db = null;
    let dbIndex = {};
    try {
        db = await openExisting('chatu8_gallery', signal) || await openExisting('tupian', signal);
        const record = await readRecord(db, 'tupianshuju', signal);
        if (record?.shuju) dbIndex = JSON.parse(record.shuju) || {};
    } catch (error) {
        db?.close();
        db = null;
        if (signal?.aborted) throw error;
    }
    const serverIndex = settings.jiuguanStorage || {};
    const preferServer = String(settings.jiuguanchucun) === 'true';
    return {
        lookup(tag) {
            if (!tag) return null;
            const key = md5(tag);
            return selectImage(serverIndex[key], dbIndex[key], preferServer);
        },
        async read(entry) {
            if (!entry) return null;
            if (entry.source === 'server') return typeof entry.path === 'string' ? entry.path : null;
            const record = await readRecord(db, entry.uuid, signal);
            const data = record?.data;
            if (data instanceof Blob) return data;
            if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new Blob([data]);
            return typeof data === 'string' && data.startsWith('data:') ? data : null;
        },
        close() { db?.close(); },
    };
}
