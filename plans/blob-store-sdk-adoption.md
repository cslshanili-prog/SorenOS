# blob-store SDK 接入計劃（blobRef 薄殼化）

> 這是啥：把 `utils/blobRef.ts` 的通用部分換成 npm 包 `@rei-standard/blob-store`（從本文件所述的 blobRef 提煉、經六輪對抗複審的 SDK），SullyOS 側只留薄殼與本項目特有邏輯，並首次接入孤兒 GC（掛開發調試面板）。
>
> 啥時候用：SDK 發出 `0.1.0-next.0` 之後動工。規範與包行為以 ReiStandard 倉的 `standards/blob-storage.md` 與包 README 為準。
>
> 現狀：已隨 v3.6 (Clean Sweep) 全部落地。本文檔保留作實現對照；引用面清單的活版本在 `utils/blobGc.ts` 文件頭，新功能動到令牌存儲時更新那份即可。

## 前置條件

- npm 上存在 `@rei-standard/blob-store@0.1.0-next.0`（ReiStandard PR #68 合併 → Version Packages PR 合併 → 首發需手動 `npx changeset publish` 補發 + npmjs 配 trusted publisher，此後自動）。
- 版本寫法跟隨本倉慣例：**預發佈版寫死精確版本、不帶 `^`、不用 `@next` tag**（對照 `package.json` 裡 `@rei-standard/amsg-*` 的寫法）。
- **禁 `link:`**：本地聯調若臨時 link 過 ReiStandard，提交前必須 `pnpm install` 回到已發佈版本，並 `grep -n 'link:' pnpm-lock.yaml` 確認零命中（lockfile 裡的 `link:` 會讓 Netlify frozen install 直接失敗，`09087e3` 有前科）。

## 總體形狀

對外 **API 一個名字都不動**：`utils/blobRef.ts` 的全部導出（`BLOBREF_PREFIX` / `BlobRef` / `isBlobRef` / `putImageBlob` / `getBlobForRef` / `deleteBlobRef` / `deleteBlobRefIfUnreferenced` / `dataUrlToBlob` / `blobToDataUrl` / `migrateDataUrlToRef` / `migrateAppearancePresetBlobRefs` / `resolveRefToDataUrl` / `resolveBlobRefsDeep` / `useBlobRefUrl`）名稱與簽名原樣保留。全倉 23 個 import 點、`appIcon.test.ts` 的 `vi.mock('./blobRef', ...)`、`callAppRuntimeReferences.test.ts` 的源碼文本斷言，都不需要任何改動。

```
utils/blobStore.ts   （新增）SDK store 單例 + StorageAdapter（包在 DB 之上）
utils/blobRef.ts     （薄殼化）通用導出委託給 store；三樣 SullyOS 特有邏輯留守
utils/blobGc.ts      （新增）GC 入口 + 引用面清單（refSources 生成器）
utils/db.ts          （加一個方法）listBlobAssetIds
components/DevDebugPanel.tsx （加一個區塊）手動 GC 按鈕 + 結果展示
```

## 任務 1：裝依賴 + store 單例與適配器

`package.json` dependencies 加 `"@rei-standard/blob-store": "0.1.0-next.0"`（精確版本）。

新建 `utils/blobStore.ts`：

```ts
import { createBlobStore } from '@rei-standard/blob-store';
import { DB } from './db';

// blob_assets 是混用表：blobRef 圖片（img_ 老 / b_ 新）、VRM 模型（video-avatar-<uuid>）、
// Live2D 運行時緩存（<assetId>:live2d-runtime-store-v1…）、遺留陪伴語音（companion-*-voice:）
// 全在一張表裡。規範要求「一個適配器 keys() 的覆蓋範圍只對應一個令牌前綴」，
// 所以 keys 必須圈定 blobRef 自己的 id 命名空間——否則 GC 會把用戶的模型當孤兒刪掉。
// （其他三族 id 都含 - 或 :，恰好也被 SDK 的字符集安全閥攔下，但那是兜底，不能當設計依賴。）
export const blobStore = createBlobStore({
  adapter: {
    get: (id) => DB.getBlobAsset(id),
    put: (id, blob) => DB.putBlobAsset(id, blob),
    delete: (id) => DB.deleteBlobAsset(id),
    keys: () => DB.listBlobAssetIds(),
  },
});
```

適配器**必須複用 `openDB()` 那條單例連接**（走 DB.* 方法即天然複用）——絕不自己 `indexedDB.open`，`db.ts` 註釋裡記錄過多連接撐爆 backing store 的事故。

`utils/db.ts` 加 `listBlobAssetIds`，照 `getAllAssets`（`db.ts:1168`）的寫法，帶 `objectStoreNames.contains` 兜底（老庫沒這張表返回 `[]`），用 `store.getAllKeys()`，**返回前按前綴過濾**：

```ts
// 只列 blobRef 命名空間的 id（img_ 存量 / b_ SDK 新生成）。blob_assets 是混用表，
// GC 的世界觀必須限制在自己的前綴內；今後往這張表加新 id 族時不得使用這兩個前綴。
listBlobAssetIds: async (): Promise<string[]> => { /* getAllKeys + filter img_ | b_ */ }
```

行為差異提醒（都由 SDK 契約保證、不需要殼層適配，列出來免得排查時意外）：新令牌 id 前綴是 `b_` 不再是 `img_`（存量 `img_` 照讀，GC 按「老」處理）；`put` 傳非 Blob 拋 TypeError（原版靜默產死令牌）；`resolveDeep` 整塊跳過 TypedArray/DataView、遇 frozen 節點拋錯（備份路徑傳的是 `structuredClone` 副本，不受影響）；`dataUrlToBlob` 會先 percent-decode 再解 base64。

## 任務 2：blobRef.ts 薄殼化

逐個導出的去向：

| 導出 | 去向 |
|---|---|
| `BLOBREF_PREFIX` | 保留常量（與 SDK 默認前綴一致） |
| `BlobRef` 品牌類型 / `isBlobRef` | 殼層保留品牌類型，`isBlobRef = (v): v is BlobRef => blobStore.isRef(v)` |
| `putImageBlob` / `getBlobForRef` / `deleteBlobRef` | 委託 `blobStore.put / get / delete`（deleteBlobRef 保留「接受 undefined/null 直接返回」的寬簽名） |
| `dataUrlToBlob` / `blobToDataUrl` | re-export SDK 模塊級函數 |
| `migrateDataUrlToRef` | 委託 `blobStore.migrateDataUrl` |
| `resolveRefToDataUrl` / `resolveBlobRefsDeep` | 委託 `blobStore.resolveToDataUrl / resolveDeep` |
| `deleteBlobRefIfUnreferenced` | **留守不動**（SullyOS 特有的引用掃描；長遠由 GC 取代，本次不碰） |
| `migrateAppearancePresetBlobRefs` | **留守不動**（外觀預設三字段遷移 + cache 去重） |
| `useBlobRefUrl` | 薄殼：見任務 3 |

驗收：`pnpm vitest run utils/blobRef.test.ts` 原樣全綠（這份測試就是殼層兼容性的守衛，一行不改）。

## 任務 3：useBlobRefUrl 薄殼 + 契約測試

殼層保留三分支裡的 SullyOS 特有分支（`builtin-room-asset://` 與舊樣板房絕對 URL → `resolveBuiltinRoomAssetUrl`），令牌與其餘非令牌交給 SDK 的 `useBlobUrl(blobStore, value)`。

SDK hook 與現役實現語義有兩處已知分叉，**必須補契約測試釘住**（SDK 側行為測試當時明確說好隨首個消費者落）：

1. **令牌 → 令牌切換期間返回 `undefined`**，不吐上一個（已 revoke 的）objectURL；
2. **非令牌在渲染期直接透傳**（data: / http(s) / 漸變串 / undefined），不等 effect、無一幀滯後。

測試落點的坑：`vitest.config.ts` 是 `environment: 'node'` 且 include 只有 `utils/**/*.test.ts`（`.tsx` 不匹配、`components/**` 不跑）。所以契約測試寫成 `utils/blobRefHook.contract.test.ts`——文件頭加 `// @vitest-environment jsdom`，用 `React.createElement` 不寫 JSX。jsdom（devDeps 已有 30.x）+ react-dom 18 的 `createRoot` + `act`，零新增依賴，約 20 行/條。

## 任務 4：GC 接入（`utils/blobGc.ts`）

```ts
export async function runBlobGc(opts?: { minAgeMs?: number }) {
  return blobStore.gc({ refSources: iterateRefSources(), ...opts }); // minAgeMs 默認 72h
}
```

`iterateRefSources()` 是 async generator，逐條 yield 明文字符串。**引用面清單（本計劃的生死線，新功能動到令牌存儲時必須同步更新此清單與生成器）**：

| 面 | 內容 | 吐法 |
|---|---|---|
| `characters` 表 | avatar / sprites / dateSkinSets / roomConfig / vrState.chibi / companionAvatar（含 imageWardrobe，令牌兼任條目 id 與 imageRef 兩個值位）/ videoCallBackground / companionBackground / studio.like520 | 游標逐行 `JSON.stringify(row)` |
| `messages` 表 | `metadata.cameraSnapshotRef` | 游標逐行（表大，不 getAll 全量佔內存） |
| `cc_custom_parts` 表 | src / shadowSrc | 游標逐行 |
| `songs` 表 | coverImage | 游標逐行 |
| `assets` 表 | wallpaper / lock_wallpaper / wallpaper_user_backup / icon_* / appearance_preset_*（JSON）/ room_custom_assets_list（JSON）/ **ls_mirror_v1（localStorage 鏡像，最容易漏）** / spark_* 等 | 游標逐行 |
| `themes`、`pixel_home_assets` 表 | 目前未見令牌寫入，納入白名單防未來回歸 | 游標逐行 |
| `localStorage` 全量**值** | tama_board_img_<charId> 與舊單鍵 / acnh_wallpaper_backup / sully-call-fake-camera-image-v1 / os_theme（JSON，令牌不剝）等 | 逐 key 吐 value |

規範的四條宿主義務對照：

1. **面要全且明文**——上表即清單；各面都是 JSON/裸串，令牌逐字可見，無壓縮加密面。
2. **一表一前綴**——由任務 1 的 `listBlobAssetIds` 前綴過濾保證（混用表的世界觀切割）。
3. **GC 期間引用不跨面搬家**——首版只掛調試面板手動觸發，操作者自己避開備份導入等批量寫入時段即可；多 tab 獨跑（`navigator.locks`）留給產品化階段。
4. **令牌邊界完整**——偵察確認全倉沒有 `${token}_xxx` 複合鍵、沒有對象**鍵位**令牌（衣櫥條目的 `{ id: imageRef }` 是值位，安全；這也滿足 SDK「令牌須獨佔字段值」的備份形態約束）。

`keptBoundary` 語義（調試面板要展示）：邊界歧義豁免的單獨計數，**接近庫存量 = 某個引用面混進了雜散的令牌前綴文本**（比如把 `blobref:b_` 當例子寫進會被掃到的文案），此時 GC 整輪空轉且 `deleted:0` 與「沒垃圾」同形——它是唯一報警信號。

### 順手修：songs 缺席備份導出名單

現狀：`OSContext.tsx:4219` 的逐 store `resolveBlobRefsDeep` 循環只有 characters / cc_custom_parts / messages，`songs.coverImage` 的令牌會原樣進備份（跨設備恢復即死鍵）。本次把 `songs` 補進名單，並在 `backupRoundtrip.test.ts` 加一條守衛（歌曲封面令牌導出後必須是 data URL）。

## 任務 5：調試面板掛 GC

照 `DevDebugPanel.tsx:447-470` 的日誌動作行模式：`LogActionButton` 一枚（「清理孤兒圖片」），點擊跑 `runBlobGc()`，按鈕下方一行 `text-[11px] text-white/55` 展示 `deleted / kept / keptBoundary / aborted` 四個數（keptBoundary 必須露出，見上）。區塊間照例插 `<div className="h-px bg-white/10" />`。是動作按鈕不是行為開關，不需要動 `DevDebugFlags` 三件套。

## 測試清單（新增）

| 測試 | 釘住什麼 |
|---|---|
| `utils/blobRef.test.ts`（不改） | 薄殼對外行為與原版一致 |
| hook 契約 ×2（任務 3） | 令牌切換返回 undefined；非令牌渲染期透傳 |
| **混用表守衛**（最重要） | 表裡塞 `video-avatar-<uuid>`、`x:live2d-runtime-store-v1`、`companion-startup-voice:y` 假行 + 一個無引用老 `img_` 孤兒 → GC 後僅孤兒被刪，三個外族 id 一根毛都不少 |
| GC 基礎三件 | 老孤兒刪 / 被引用留 / 新鮮留 |
| `listBlobAssetIds` 過濾 | 只返回 `img_` / `b_` 前綴 |
| songs 備份守衛 | 歌曲封面令牌導出後為 data URL |

全部走既有 `fake-indexeddb` + `MemStorage`（test-setup.ts），跑法 `pnpm vitest run`。

## 驗收與提交前自查

- [ ] `pnpm vitest run` 全綠（含既有 blobRef / appIcon / callAppRuntimeReferences 等連帶測試零改動通過）
- [ ] `grep -n 'link:' pnpm-lock.yaml` 零命中
- [ ] 真機冒煙：上傳頭像/壁紙（新令牌為 `b_` 前綴）、備份導出導入往返、調試面板 GC 跑一輪數字合理
- [ ] PR 描述附上文引用面清單
- [ ] 大功能落地，記得改 `utils/buildInfo.ts` 的 `APP_VERSION`

## 留給後續（本次不做）

- GC 產品化入口（設置頁存儲統計區「清理未使用文件」）+ `navigator.locks` 獨跑保護
- `deleteBlobRefIfUnreferenced` 退役（由 GC 統一收口）
- `img_` 存量 id 的遷移（無收益，SDK 對存量按「老」正常處理）
