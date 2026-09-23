# Spec: `@rei-standard/amsg-sw` IndexedDB 連接韌性修復

> ✅ **已實現併發版**：`@rei-standard/amsg-sw@2.3.0`（Gap 1 = onclose + 事務級 InvalidStateError 重開兜底，dedupe / queue / multipart 庫全覆蓋；Gap 2 = DELIVER ack 新增可選 `businessError` 字段，並把失敗持久化到 dedupe 記錄上，重複包也帶 businessError）。SullyOS 側已 bump 到 2.3.0、重打 bundle、`SW_VERSION` → 1.15.0，並在 `utils/instantPushClient.ts` 接入 `businessError` 讓超時診斷更精確。下文保留為設計記錄。

> 交接給 amsg-sw 包維護方。本文描述兩個**包內**的 IndexedDB 韌性缺口，給出修復方案與驗收標準。
> SullyOS 側的根因（主庫連接風暴）已在 SullyOS 倉庫自行修復（見文末「分工」），這裡只列需要包升級才能解決的部分。
>
> 當前 SullyOS 鎖的版本：`@rei-standard/amsg-sw@2.2.0`、`amsg-shared@0.2.0`。
> 下面引用的行號均指 `amsg-sw@2.2.0` 的 `dist/index.mjs`（發佈產物），供你對照包源碼定位。

---

## 背景：現象與觸發鏈

SullyOS 是 local-first 應用，整個 origin 跑著多個 IndexedDB 庫（應用主庫 `AetherOS_Data`、`ActiveMsg` inbox、以及本包的 `rei-sw` dedupe/queue 庫）。在高併發下，Chromium 底層 backing store 一旦報錯（`Internal error opening backing store for indexedDB.open`），**可能強制關閉**該 origin 已打開的連接（這是結合「多個庫同時報錯」的現場得出的推斷，不是單條日誌能坐實的鐵證；也不排除磁盤/配額/profile 損壞等其它誘因）。被強關的連接通常不會觸發 `versionchange` 事件，而是觸發 `close` 事件，之後對它發起事務會拋：

```
InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing
```

本包當前對「連接被強關」這種失效**沒有自愈**，於是出現兩個問題。

> 注意失敗點的順序：`handlePushPayload`（dist `:96`）**第一步**就是 `await maybeCleanupMultipart(...)`（dist `:97`，走 queue 庫 `cachedDB`），multipart push 還會先過 `acceptMultipartChunk`（dist `:100`，同樣 queue 庫），**之後才輪到** `claimDedupe`（dist `:104`，dedupe 庫）。所以一旦連接被強關，**queue/multipart 庫往往比 dedupe 庫更早把整條投遞鏈路掐斷**。下面 Gap 1 的修法對 dedupe 庫和 queue 庫要同等對待，不是「dedupe 為主、queue 同理」。

---

## Gap 1（必修）：dedupe / queue 連接被強關後，緩存裡的死連接被無限複用

### 現狀

- `openDedupeDatabase(dedupe)`（dist `dist/index.mjs:1010`）把連接緩存在 `dedupeDbCache`（Map，key=`${dbName}:${storeName}`），`openQueueDatabase()`（`:1035`）緩存在模塊級 `cachedDB`。
- 兩者**只在 `onversionchange` 時**清緩存：

  ```js
  // openDedupeDatabase, :1026
  db.onversionchange = () => { db.close(); dedupeDbCache.delete(cacheKey); };
  // openQueueDatabase, :1055
  cachedDB.onversionchange = () => { cachedDB.close(); cachedDB = null; };
  ```

- **沒有掛 `db.onclose`**。當連接被瀏覽器強制關閉（backing store 出錯 / 存儲壓力 / 用戶清數據），`versionchange` 不會觸發，緩存裡這條**已死連接**一直留著。
- `withDedupeStore`（`:984`）/ `withDatabaseStore`（`:975`）每次都複用緩存連接發事務：

  ```js
  async function withDedupeStore(dedupe, mode, handler) {
    const db = await openDedupeDatabase(dedupe);          // 拿到死連接
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(dedupe.storeName, mode); // ← 拋 InvalidStateError
      ...
    });
  }
  ```

  `db.transaction()` 在死連接上**同步拋** `InvalidStateError`，Promise executor 捕獲後 reject。

### 後果

1. **去重徹底失靈 + push 落庫被阻斷**：`handlePushPayload`（`:104`）第一步就是 `await claimDedupe(...)`，它走 `withDedupeStore`。死連接讓 `claimDedupe` 拋錯 → `handlePushPayload` 在 `dispatchBusinessPayload` 之前就拋 → 業務回調（消費方寫 inbox 等）**根本不執行** → `handleDeliverMessage`（`:120`）catch 後回 `ok:false` ack。**不重啟 SW 永遠好不了**，因為緩存裡的死連接不會被任何路徑清掉。
2. **`dedupe cleanup failed` 刷屏**：`maybeCleanupDedupe`（`:450`）週期性跑 `cleanupDedupeStore`，同樣複用死連接，每次都拋 `InvalidStateError`，被 `:459` 的 `console.error("dedupe cleanup failed:", error)` 打出來，刷屏幾十上百條。
3. 同理 `cachedDB`（queue / multipart 庫）一旦被強關也是死的，multipart 重組、queue 操作全掛。

### 修復方案

**(a) 掛 `onclose` 清緩存**——和現有 `onversionchange` 對稱：

```js
// openDedupeDatabase
request.onsuccess = () => {
  const db = request.result;
  dedupeDbCache.set(cacheKey, db);
  const drop = () => { dedupeDbCache.delete(cacheKey); };
  db.onversionchange = () => { db.close(); drop(); };
  db.onclose = () => { drop(); };   // ← 新增：被強關時清緩存
  resolve(db);
};
```

```js
// openQueueDatabase
request.onsuccess = () => {
  cachedDB = request.result;
  cachedDB.onversionchange = () => { cachedDB?.close(); cachedDB = null; };
  cachedDB.onclose = () => { cachedDB = null; };   // ← 新增
  resolve(cachedDB);
};
```

**(b) 事務級一次重開兜底**——`onclose` 是異步事件，可能晚於下一次事務調用；而且 `db.transaction()` 是**同步拋**。所以 `withDedupeStore` / `withDatabaseStore` 要捕獲「連接 closing/closed」錯誤，清緩存、重開一次、重試一次：

```js
function isConnectionClosingError(e) {
  return e && (e.name === 'InvalidStateError' ||
    /connection is closing|database connection is closing/i.test(String(e && e.message)));
}

async function withDedupeStore(dedupe, mode, handler) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let db;
    try { db = await openDedupeDatabase(dedupe); }
    catch (e) {
      if (attempt === 0) { invalidateDedupeCache(dedupe); continue; }
      throw e;
    }
    try {
      return await new Promise((resolve, reject) => {
        let transaction;
        try { transaction = db.transaction(dedupe.storeName, mode); }  // 同步拋 InvalidStateError
        catch (e) { reject(e); return; }
        const store = transaction.objectStore(dedupe.storeName);
        transaction.onerror = () => reject(transaction.error || new Error("Dedupe transaction failed"));
        Promise.resolve(handler(store, resolve, reject)).catch(reject);
      });
    } catch (e) {
      if (attempt === 0 && isConnectionClosingError(e)) { invalidateDedupeCache(dedupe); continue; }
      throw e;
    }
  }
}
```

`withDatabaseStore`（queue 庫）同理，`invalidate` 改成 `cachedDB?.close(); cachedDB = null;`。重試上限 1 次，避免無限循環；第二次仍失敗就如實拋出。

---

## Gap 2（建議修，SullyOS 不阻塞）：DELIVER ack 的 `ok:true` 不反映業務落庫結果

### 現狀

`dispatchBusinessPayload`（`:143`）把消費方 `onBusinessPayload` 的 rejection **吞掉**了：

```js
// :169
if (typeof defaults.onBusinessPayload === "function") {
  try {
    const result = defaults.onBusinessPayload(payload);
    if (result && typeof result.then === "function") {
      businessWork = Promise.resolve(result).catch((error) => {     // ← rejection 被吞
        console.error("[rei-standard-amsg-sw] onBusinessPayload promise rejected:", error);
      });
    }
  } catch (error) { console.error(...); }
}
await Promise.all(notificationWork);
...
if (businessWork) await businessWork;   // :186 已經 catch 過, 永不 reject
```

於是 `handlePushPayload` 不會因為業務失敗而拋，`handleDeliverMessage`（`:128`）照樣回 `ok:true`。**即「業務落庫失敗，ack 仍報成功」。**

### 影響評估

- **對 SullyOS 不構成 bug**：SullyOS 客戶端不信這個 ack——它把成功信號綁在業務側自己 `postMessage` 的 `active-msg-received` 事件上（落庫成功後才 fire），ack 的 `ok` 只用來區分超時文案。所以「ack 撒謊」在 SullyOS 這條鏈路上不會變成「假成功」。
- **對「信 ack = 業務已處理」的其它消費方是真坑**：這類消費方會把沒落庫的消息當成功。

### 建議（二選一，保持向後兼容）

- **方案 A（推薦，非破壞）**：ack 增加一個可選字段透傳業務錯誤，`ok` 維持現含義（= 已收下並分發）：

  ```js
  respondToSender(event, { ok: true, duplicate, key, requestId,
    businessError: result.businessError /* 業務回調 reject 時填 message, 否則 undefined */ });
  ```

  需要 `dispatchBusinessPayload` 把 `onBusinessPayload` 的 rejection 捕獲後**回傳**（而不是只 console.error），並 `await` 它再 ack。

- **方案 B（opt-in 改語義）**：`installReiSW` 增加 `ackReflectsBusiness?: boolean`，開啟後業務失敗讓 `handleDeliverMessage` 回 `ok:false`。默認 false 保持現狀。

無論哪種，文檔裡要寫清 DELIVER ack 的 `ok` 到底代表「收下」還是「已落庫」。

---

## 驗收標準

1. **dedupe 自愈**：下一次 `claimDedupe` 能透明重開併成功，**不再持續拋 `InvalidStateError`**，無需重啟 SW。注意兩條失效路徑要分開測，別混為一談：
   - **事務級重開兜底（(b)）**：讓緩存裡的連接處於 closing/closed 態後再發事務——可 mock `db.transaction` 拋 `InvalidStateError`，或對拿到的連接調 `db.close()` 後複用它（`close()` 是正常關閉、**不會**觸發 `close` 事件，所以這條測的是「死連接 → 事務拋錯 → 清緩存重開」，不是在驗證 `onclose`）。
   - **`onclose` 清緩存（(a)）**：要單獨驗證「連接被強關 → `close` 事件 → 緩存被清」，得 mock/手動派發那條失效路徑（如直接調用掛在連接上的 `onclose` 回調），不能用 `db.close()` 代替。
2. **業務不被阻斷**：上述場景下，dedupe 短暫失敗並恢復後，`onBusinessPayload` 仍被調用、push 仍能落庫。
3. **cleanup 不刷屏**：連接被強關後，`maybeCleanupDedupe` 重開成功，不再每輪 `dedupe cleanup failed`。
4. queue / multipart 庫（`cachedDB`）同樣適用 1–3。
5.（若採納 Gap 2）DELIVER ack 能區分「業務落庫失敗」與「傳輸成功」。

---

## 分工與發版

| 側 | 改什麼 | 狀態 |
|----|--------|------|
| **amsg-sw 包** | 本 spec 的 Gap 1（必修）、Gap 2（建議） | 待這邊 agent 實現 + 發版 |
| **SullyOS** | 主庫 `utils/db.ts`、`utils/activeMsgStore.ts`、SW `worker/sw-keep-alive.ts` 的 IDB 連接全部改單例複用 + `onversionchange`/`onclose` 失效自愈 + `onblocked` 統一清緩存重試；另把 `apps/pixelHome/pixelHomeDb.ts`（之前自帶一個裸開同一個 `AetherOS_Data` 的 `openDB`）併到共享單例。這是連接風暴的**根因**，消除後 backing store 不再被撐爆，Gap 1 的強關誘因基本消失，Gap 1 退化為「極少數其它原因強關」的兜底 | ✅ 已修 |

**發版後 SullyOS 側動作**：bump `package.json` 裡 `@rei-standard/amsg-sw` 版本 → `pnpm install` → `pnpm run build:workers`（bundle 自動帶上修好的包）→ bump `worker/sw-keep-alive.ts` 的 `SW_VERSION`（觸發字節比較讓瀏覽器重裝 SW）。
