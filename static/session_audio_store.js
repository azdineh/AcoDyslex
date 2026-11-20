/* Session WAV storage. Binary data stays in IndexedDB, never localStorage. */
(() => {
  const DB_NAME = 'acodyslex-session-audio';
  const DB_VERSION = 1;
  const STORE = 'recordings';

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, {keyPath: 'key'});
          store.createIndex('by_session', ['child_id', 'session_id'], {unique: false});
          store.createIndex('by_updated', 'updated_at', {unique: false});
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB indisponible'));
    });
  }

  async function transaction(mode, operation) {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        try { result = operation(store); } catch (error) { reject(error); return; }
        tx.oncomplete = () => resolve(result?.result ?? result);
        tx.onerror = () => reject(tx.error || new Error('Échec IndexedDB'));
        tx.onabort = () => reject(tx.error || new Error('Transaction IndexedDB annulée'));
      });
    } finally { db.close(); }
  }

  const keyFor = (childId, sessionId, wordId) => `${childId}::${sessionId}::${wordId}`;

  async function put(record) {
    if (!(record.blob instanceof Blob)) throw new TypeError('Un Blob WAV est requis');
    const value = {...record, key: keyFor(record.child_id, record.session_id, record.word_id), updated_at: new Date().toISOString()};
    await transaction('readwrite', store => store.put(value));
    return value;
  }

  async function get(childId, sessionId, wordId) {
    return transaction('readonly', store => store.get(keyFor(childId, sessionId, wordId)));
  }

  async function getSession(childId, sessionId) {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const index = tx.objectStore(STORE).index('by_session');
        const request = index.getAll(IDBKeyRange.only([childId, sessionId]));
        request.onsuccess = () => resolve(request.result.sort((a, b) => a.word_order - b.word_order));
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }

  async function deleteWord(childId, sessionId, wordId) {
    await transaction('readwrite', store => store.delete(keyFor(childId, sessionId, wordId)));
  }

  async function deleteSession(childId, sessionId) {
    const records = await getSession(childId, sessionId);
    await transaction('readwrite', store => records.forEach(record => store.delete(record.key)));
  }

  async function cleanupOlderThan(days = 7) {
    const cutoff = Date.now() - days * 86400000;
    await transaction('readwrite', store => {
      const request = store.index('by_updated').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (Date.parse(cursor.value.updated_at) < cutoff) cursor.delete();
        cursor.continue();
      };
    });
  }

  async function clearAll() {
    await transaction('readwrite', store => store.clear());
  }

  window.acodyslexAudioStore = {put, get, getSession, deleteWord, deleteSession, cleanupOlderThan, clearAll, keyFor};
})();
