// 孤兒 Blob GC 入口。刪除令牌（blobref:）是保守的——同一令牌可能被多處引用，消費方
// 從不主動刪，殘留的孤兒 Blob 統一由這裡的 GC 收口（首版只掛調試面板手動觸發）。
// GC 邏輯在 @rei-standard/blob-store（mark & sweep + 多道安全閥，寧可留孤兒絕不刪活圖），
// 本文件只負責宿主義務裡最要命的那條：把「全部可能含令牌的持久化面」枚舉給它。
//
// ─── 引用面清單（本文件的生死線）───
// 漏掉一個面，那個面獨佔引用的圖就會被當孤兒刪掉（不可逆）。
// 新功能把 blobref 令牌寫進新的 store / localStorage key 時，必須同步更新這份清單
// 和下面的 iterateRefSources 生成器。
//
// 這份清單有兩個消費者：本文件的 GC（只讀，掃出誰沒人引用）和 utils/blobDedupe.ts 的
// 令牌合併（讀+寫，把重複令牌改寫成保留的那個）。REF_SOURCE_STORES 兩邊共用，
// localStorage 面兩邊各自枚舉一次——加新面時兩處都要過一眼。
//
// | 面 | 內容字段 | 吐法 |
// |---|---|---|
// | characters 表 | avatar / sprites / dateSkinSets / roomConfig（wallImage/floorImage/items[].image）
// |               | / chatBackground / dateBackground / vrState.chibi / phoneState.contacts[].avatar
// |               | / specialMomentRecords.*（.image 與 customData 裡的頭像、手辦圖）
// |               | / companionAvatar（含 imageWardrobe，令牌兼任條目 id 與
// |               |   imageRef 兩個值位）/ videoCallBackground / companionBackground / studio.like520 | 分頁逐行 JSON.stringify(row) |
// | messages 表 | content（type 為 image / emoji 的聊天圖與表情消息；卡片行的 content 是 JSON，
// |             |   裡面還有 charAvatar / photoDataUrl）/ metadata.cameraSnapshotRef /
// |             |   metadata.scoreCard 的同名兩字段 / metadata.characterAvatar /
// |             |   metadata.post（authorAvatar 與 comments[].authorAvatar） | 分頁逐行（表大，不 getAll 全量佔內存） |
// | emojis 表 | url（表情庫；http 外鏈不是令牌，一併逐字吐過去也無妨） | 分頁逐行 |
// | cc_custom_parts 表 | src / shadowSrc | 分頁逐行 |
// | songs 表 | coverImage | 分頁逐行 |
// | gallery 表 | url | 分頁逐行 |
// | assets 表 | wallpaper / lock_wallpaper / wallpaper_user_backup / icon_* /
// |           | appearance_preset_*（JSON）/ room_custom_assets_list（JSON）/
// |           | ls_mirror_v1（localStorage 鏡像，最容易漏）/ spark_* 等 | 分頁逐行 |
// | themes 表 | 聊天氣泡主題：user / ai 兩側各自的 backgroundImage / decoration / avatarDecoration | 分頁逐行 |
// | user_profile 表 | avatar（我方頭像）/ perCharAvatars（分角色頭像） | 分頁逐行 |
// | social_posts 表 | authorAvatar（帖子作者）/ comments[].authorAvatar（評論作者） | 分頁逐行 |
// | moment_posts 表 | images[]（單一貼文池的貼文配圖） | 分頁逐行 |
// | groups 表 | avatar（群頭像） | 分頁逐行 |
// | character_groups 表 | avatar（角色分組圖標） | 分頁逐行 |
// | story_theater_masks 表 | avatar（劇場原創人物面具） | 分頁逐行 |
// | bank_data 表 | 店員 avatar / 留言板 avatar | 分頁逐行 |
// | guidebook、life_sim 表 | 卡片裡留存的 charAvatar / actorAvatar 副本 | 分頁逐行 |
// | pixel_home_assets 表 | 目前未見令牌寫入，納入白名單防未來回歸 | 分頁逐行 |
//
// 上面從 user_profile 到 life_sim 這幾張，裝的都是**從角色/用戶頭像複製過去的副本**。
// 頭像本身在 characters 表，但它會被抄進帖子、卡片、面具、群資料里長期留著。GC 掃不到
// 這些面，就會把還被老帖子引用著的圖判成孤兒刪掉——所以它們必須在清單裡，哪怕平時為空。
// | localStorage 全量值 | tama_board_img_<charId> 與舊單鍵 / acnh_wallpaper_backup /
// |                     | sully-call-fake-camera-image-v1 / os_theme（JSON，令牌不剝）等 | 先同步快照再逐條吐 value |
//
// 上面各行的字段列表只是「這張表裡都有哪些圖」的說明，**不是枚舉依據**——真正的枚舉是
// 整行 JSON.stringify，字段加了刪了都自動覆蓋。誰要是照著表格改成按字段挑，漏掉的那個
// 字段引用的 Blob 就會被判成孤兒刪掉，而且刪除不可逆。
//
// 各面都是 JSON / 裸字符串，令牌逐字可見，不需要解壓解密。若未來某個面壓縮 / 加密後才
// 落盤，必須先還原成明文再吐——那種情況枚舉不報錯、安全閥也不觸發，等於這個面沒掃。

import { DB } from './db';
import { blobStore } from './blobStore';
import { tryAcquireMaintenanceLock, releaseMaintenanceLock, currentMaintenanceHolder } from './maintenanceLock';

// 引用面裡的 17 張表。名字與 db.ts 的 STORE_* 常量值一一對應
// （STORE_CHARACTERS / STORE_MESSAGES / STORE_CC_PARTS / STORE_SONGS / STORE_GALLERY /
//   STORE_ASSETS / STORE_THEMES / STORE_EMOJIS / STORE_USER / STORE_SOCIAL_POSTS /
//   STORE_GROUPS / STORE_CHAR_GROUPS / STORE_STORY_THEATER_MASKS / STORE_BANK_DATA /
//   STORE_GUIDEBOOK / STORE_LIFE_SIM / pixel_home_assets）。
// 全部是 inline keyPath（都用 'id'），所以 blobDedupe 的 putStoreRows 能原樣寫回。
// 導出僅供測試核對拼寫：名字寫錯時 getStoreRowsPage 的 contains 兜底會靜默返回空頁，
// 等於那個面沒掃、無任何報錯——blobGc.test.ts 有一條守衛斷言每個名字真實存在。
export const REF_SOURCE_STORES = [
    'characters',
    'messages',
    'cc_custom_parts',
    'songs',
    'gallery',
    'assets',
    'themes',
    'emojis',
    'user_profile',
    'social_posts',
    'moment_posts',
    'groups',
    'character_groups',
    'story_theater_masks',
    'bank_data',
    'guidebook',
    'life_sim',
    'pixel_home_assets',
] as const;

// 每批讀多少行。批間事務各自獨立（見 DB.getStoreRowsPage 註釋），內存峰值只有一批。
const PAGE_SIZE = 200;

/**
 * 逐條 yield 明文字符串的引用面枚舉器（餵給 SDK 的 store.gc）。
 * 枚舉中任何一步出錯都直接上拋——SDK 的安全閥會整輪放棄（aborted: true，一個不刪），
 * 絕不能在這裡吞錯靜默跳過，那等於把出錯的面當「沒有引用」。
 */
async function* iterateRefSources(): AsyncGenerator<string> {
    // 表面：按主鍵分頁逐行吐 JSON。
    for (const storeName of REF_SOURCE_STORES) {
        let afterKey: IDBValidKey | null = null;
        for (;;) {
            const { rows, lastKey } = await DB.getStoreRowsPage(storeName, afterKey, PAGE_SIZE);
            for (const row of rows) {
                const text = JSON.stringify(row);
                // JSON.stringify(undefined) 是 undefined（不是字符串），跳過這類空洞行
                if (typeof text === 'string') yield text;
            }
            if (lastKey === null || rows.length < PAGE_SIZE) break;
            afterKey = lastKey;
        }
    }

    // localStorage 面：先同步快照成數組再逐條 yield —— async generator 每次 yield 都會
    // 掛起，掛起期間併發的 removeItem 會讓下標移位、漏掃一個 key。
    const localValues: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key === null) continue;
        localValues.push(localStorage.getItem(key) ?? '');
    }
    yield* localValues;
}

/**
 * 跑一輪孤兒 Blob GC，返回 SDK 的 { deleted, kept, keptBoundary, aborted }。
 * minAgeMs 默認 72h（SDK 側新鮮豁免，擋「已 put、引用未落盤」的競態），0 只應出現在測試。
 * keptBoundary 接近庫存量 = 某個引用面混進了雜散的令牌前綴文本，GC 整輪空轉——
 * 展示側（調試面板）必須把它露出來，deleted:0 和「真沒垃圾」同形，它是唯一報警信號。
 *
 * 與「優化資源存儲」共用 maintenanceLock：遷移是引用搬家（data: → 令牌），
 * mark 不是一致性快照，撞上會誤刪活圖。鎖被佔時直接拋（拿不到鎖 ≠ 沒垃圾）。
 */
export async function runBlobGc(opts?: { minAgeMs?: number }) {
    if (!tryAcquireMaintenanceLock('孤兒圖片清理')) {
        throw new Error(`另一項存儲維護（${currentMaintenanceHolder()}）正在進行，請稍後再試。`);
    }
    try {
        return await blobStore.gc({ refSources: iterateRefSources(), ...opts });
    } finally {
        releaseMaintenanceLock();
    }
}
