/**
 * vitest 全局 setup — 為 Node 環境補齊瀏覽器 API.
 *  - fake-indexeddb/auto: 把 indexedDB / IDBKeyRange 等掛到 globalThis,
 *    讓 activeMsgStore.ts 在 Node 裡能直接跑.
 *  - localStorage stub: 不少模塊在模塊加載時不讀 localStorage, 但運行時會讀
 *    (pushVapid / activeMsgClient 等), 給最簡易 in-memory 實現.
 *  - 構建注入常量: vite.config.ts 的 define 在 Node 裡沒人替換, 而 utils/buildInfo.ts
 *    模塊頂層就要讀它們, 不補的話 import 到它的測試直接 ReferenceError.
 */

import 'fake-indexeddb/auto';

class MemStorage {
  private store = new Map<string, string>();
  getItem(k: string) { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string) { this.store.set(k, String(v)); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
  key(i: number) { return Array.from(this.store.keys())[i] ?? null; }
  get length() { return this.store.size; }
}

if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = new MemStorage();
}

const BUILD_DEFINES: Record<string, string | boolean> = {
  __BUILD_BRANCH__: 'test',
  __BUILD_COMMIT__: '0000000',
  __BUILD_TIME__: '1970-01-01 00:00',
  __BUILD_BADGE_VISIBLE__: false,
};
for (const [name, value] of Object.entries(BUILD_DEFINES)) {
  if (typeof (globalThis as any)[name] === 'undefined') {
    (globalThis as any)[name] = value;
  }
}
