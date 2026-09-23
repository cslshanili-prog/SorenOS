// blobRef 令牌層的 SDK store 單例。通用邏輯（令牌生成/解析、data URL 互轉、深度還原、GC）
// 在 @rei-standard/blob-store 裡，這裡只負責把它接到本項目自己的 IndexedDB 上——
// 適配器必須走 DB.*，絕不自己 indexedDB.open（db.ts 記錄過多連接撐爆 backing store 的事故）。
//
// blob_assets 是混用表：blobRef 圖片（img_ 老 / b_ 新）、VRM 模型（video-avatar-<uuid>）、
// Live2D 運行時緩存（<assetId>:live2d-runtime-store-v1…）、遺留陪伴語音（companion-*-voice:）
// 全在一張表裡。規範要求「一個適配器 keys() 的覆蓋範圍只對應一個令牌前綴」，
// 所以 keys 必須圈定 blobRef 自己的 id 命名空間——否則 GC 會把用戶的模型當孤兒刪掉。
// （其他三族 id 都含 - 或 :，恰好也被 SDK 的字符集安全閥攔下，但那是兜底，不能當設計依賴。）

import { createBlobStore } from '@rei-standard/blob-store';
import { DB } from './db';

export const blobStore = createBlobStore({
    adapter: {
        get: (id) => DB.getBlobAsset(id),
        put: (id, blob) => DB.putBlobAsset(id, blob),
        delete: (id) => DB.deleteBlobAsset(id),
        keys: () => DB.listBlobAssetIds(),
    },
});
