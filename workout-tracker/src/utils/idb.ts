/**
 * IndexedDB low-level helpers
 *
 * Single database "workout_tracker" with one object store "kv".
 * All values are stored as serialised JSON under a plain string key,
 * mirroring the localStorage key/value shape so the two layers stay
 * in sync without any schema translation.
 */

const DB_NAME = 'workout_tracker'
const DB_VERSION = 1
const STORE = 'kv'

let _db: IDBDatabase | null = null

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db)

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE)
    }

    req.onsuccess = () => {
      _db = req.result
      // Reset cached handle if the connection closes unexpectedly
      _db.onclose = () => { _db = null }
      resolve(_db)
    }

    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IDB open blocked'))
  })
}

/** Write a value. Serialises to JSON, same as localStorage. */
export async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(JSON.stringify(value), key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (e) {
    // Never let IDB errors bubble up and break the app
    console.warn('[idb] set failed', key, e)
  }
}

/** Read a value. Returns null if not found or on error. */
export async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => {
        if (req.result == null) { resolve(null); return }
        try { resolve(JSON.parse(req.result as string) as T) }
        catch { resolve(null) }
      }
      req.onerror = () => reject(req.error)
    })
  } catch (e) {
    console.warn('[idb] get failed', key, e)
    return null
  }
}

/** Delete a key. */
export async function idbDelete(key: string): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (e) {
    console.warn('[idb] delete failed', key, e)
  }
}
