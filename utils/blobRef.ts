// 圖片 Blob 引用層（base64 → Blob 遷移的核心）。
//
// 背景：本項目圖片歷來以 base64 data URL 直接存進 IndexedDB / CharacterProfile。base64 比
// 原始二進制大 ~33%，且作為 JS 字符串常駐內存（React state / <img src> 裡都拖著整段），
// 壁紙、小屋（RoomApp）這類大圖尤其吃配額和內存。
//
// 方案：圖片二進制存進 blob_assets store（IndexedDB 原生支持 Blob），字段裡只存一個短
// 令牌 `blobref:<id>`。這樣：
//   · 字段仍是 string —— CharacterProfile / 各 store 記錄仍可 JSON 安全序列化、結構化克隆；
//   · 渲染時把令牌解析成 objectURL（URL.createObjectURL）餵給 <img>/CSS 背景，並管好回收；
//   · 整包備份（v3）令牌原樣進 JSON，二進制走 zip 的 blobs/<id> 旁路、導入按原 id 寫回
//     （見 utils/backupBlobs.ts）；單文件分享（外觀預設 / 小屋模板）仍解析回 data URL 內嵌，
//     換取單個 JSON 文件的可移植性。
//
// 通用部分已提煉為 @rei-standard/blob-store（store 單例見 ./blobStore.ts），本文件是
// 薄殼（導出名與簽名不變，逐個委託 SDK，React hook 委託 react 子路徑的 useBlobUrl）
// + SullyOS 特有邏輯（引用掃描刪除、外觀預設遷移、hook 裡的內置樣板房分支）。
// 新令牌的 id 是 SDK 生成的 `b_` 前綴；存量 `img_` 令牌照常讀取，無需遷移。
//
// 兼容：舊值（`data:...` / `http(s)://...` / CSS 漸變字符串）一律原樣透傳；內置樣板房
// 的可移植令牌會按當前部署 BASE_URL 解開，避免備份跨域/跨殼恢復後傢俱路徑失效。
// 惰性遷移由各消費方（壁紙加載、進入小屋）在讀到 data: 時順手 put 成 Blob 完成。

import { useBlobUrl } from '@rei-standard/blob-store/react';
import { dataUrlToBlob, blobToDataUrl, hashBlob } from '@rei-standard/blob-store';
import { DB } from './db';
import { blobStore } from './blobStore';
import { REF_SOURCE_STORES } from './blobGc';
import type { AppearancePreset, ChatTheme } from '../types';
import { resolveBuiltinRoomAssetUrl } from './roomTemplateAssets';

// 與 SDK 默認前綴一致（DEFAULT_PREFIX），保留字面量避免消費方多繞一層。
export const BLOBREF_PREFIX = 'blobref:';

// 用帶品牌的 string 子類型做類型守衛：正分支收窄成 BlobRef，負分支仍保留 string
// （若直接用 `v is string`，對本就是 string 的入參，否定分支會被收窄成 never）。
export type BlobRef = string & { readonly __blobRef: unique symbol };

/** 是否是 blobref 令牌。 */
export const isBlobRef = (v: unknown): v is BlobRef => blobStore.isRef(v);

/**
 * 這個字段值是「一張圖」，還是「一段拿來直接顯示的文字」（emoji、名字首字）？
 *
 * 頭像、店員、貼紙這類字段是兩用的：用戶可以傳圖，也可以只填一個 emoji。界面上到處
 * 都有「是圖就 <img>，不是圖就當文字畫出來」的分叉，而這個判斷歷來各寫各的，形如
 * `v.startsWith('http') || v.startsWith('data')`。
 *
 * 圖片改存 Blob 之後，字段裡可能是個 `blobref:` 令牌——上面那種寫法兩個條件都不滿足，
 * 於是令牌被當成文字，界面上直接顯示出一串 `blobref:b_xxx`。不報錯、不破圖，就是明晃晃
 * 地印在那兒。所以判斷收口到這裡一處，新形態只需要在這個函數里認一次。
 *
 * 認四種：blobref 令牌、內嵌 data URL、http(s) 外鏈、站內絕對路徑（`/assets/…`）。
 */
export function isImageValue(value: unknown): value is string {
    if (typeof value !== 'string' || value === '') return false;
    return isBlobRef(value)
        || value.startsWith('data:')
        || /^https?:\/\//i.test(value)
        || value.startsWith('/');
}

/** 把 Blob 存進 blob_assets，返回 `blobref:<id>` 令牌（新 id 由 SDK 生成，`b_` 前綴）。 */
export async function putImageBlob(blob: Blob): Promise<string> {
    return blobStore.put(blob);
}

/** 讀取令牌對應的 Blob（非令牌或不存在返回 null）。 */
export async function getBlobForRef(ref: string): Promise<Blob | null> {
    return blobStore.get(ref);
}

/**
 * 備份導入用：把 Blob 按既有令牌的原 id 寫回（SDK restore）。令牌身份保住，
 * JSON 裡的引用零改寫。非法令牌 / 非 Blob 由 SDK 吵著拋，調用方應中止導入。
 */
export async function restoreBlobRef(token: string, blob: Blob): Promise<void> {
    await blobStore.restore(token, blob);
}

/**
 * 刪除令牌對應的 Blob（best-effort，非令牌直接返回）。
 * 注意：同一令牌可能被多處引用（小屋自定義素材的 image 會被複制進擺放的 item.image），
 * 所以調用方需自行確認無人再引用後才刪，否則會刪出「碎圖」。多數消費方從簡：不主動刪，
 * 殘留孤兒 Blob 由後續 GC 處理，寧可佔一點空間也不冒破圖風險。
 *
 * 少數字段（桌面靜態形象 / 視頻舞台背景 / 桌面背景 / 通話快照 / 假攝像頭圖）確實會在
 * 換圖時直接刪掉舊 Blob——它們的圖來自用戶當場選的文件，一份令牌只歸自己。這批字段
 * 登記在 utils/blobDedupe.ts 的 collectUnmergeableRefs 裡，令牌合併會整組繞開它們。
 * 新增這類裸刪調用點時，記得把字段一併登記過去。
 */
export async function deleteBlobRef(ref: string | undefined | null): Promise<void> {
    if (!ref) return;
    await blobStore.delete(ref);
}

// 引用面掃描的分頁大小。與 blobGc / blobDedupe 同值：批間事務各自獨立，內存峰值只有一批。
const REF_SCAN_PAGE_SIZE = 200;

/**
 * 這個令牌還被任何一個持久化面引用著嗎？
 *
 * 面的清單直接用 blobGc 的 REF_SOURCE_STORES（+ localStorage 全量），跟孤兒 GC 同源。
 * 「優化資源存儲」的內容去重會把同一張圖在這十幾個面上收斂成同一個令牌，所以一張圖
 * 完全可能既當著壁紙又躺在聊天記錄裡——只查壁紙那兩處就會把它判成「沒人要了」刪掉，
 * 聊天和相冊裡那張跟著一起裂。
 *
 * 判斷是整行 JSON 裡找子串，不按字段挑：字段加了刪了都自動覆蓋。子串比精確匹配寬
 * （令牌 A 是令牌 B 的前綴時會算成「還有人引用」），偏的是「寧可留孤兒也不刪活圖」，
 * 多留下的孤兒歸手動 GC 收。
 *
 * 會走到這裡的都是換壁紙、刪衣櫃這類低頻操作，掃一遍全庫的代價可以接受。
 */
async function isRefStillReferenced(ref: string): Promise<boolean> {
    for (const storeName of REF_SOURCE_STORES) {
        let afterKey: IDBValidKey | null = null;
        for (;;) {
            const { rows, lastKey } = await DB.getStoreRowsPage(storeName, afterKey, REF_SCAN_PAGE_SIZE);
            for (const row of rows) {
                const text = JSON.stringify(row);
                if (typeof text === 'string' && text.includes(ref)) return true;
            }
            if (lastKey === null || rows.length < REF_SCAN_PAGE_SIZE) break;
            afterKey = lastKey;
        }
    }

    if (typeof localStorage !== 'undefined') {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            if (localStorage.getItem(key)?.includes(ref)) return true;
        }
    }

    return false;
}

/**
 * 僅在令牌已不再被任何持久化面引用時刪除 Blob。
 *
 * 壁紙、鎖屏、外觀預設、聊天記錄、相冊……都可能共享同一令牌；直接在換圖時 delete
 * 會讓別處變成死圖。調用方須先把自己那一處的指針落盤，再調這裡——掃描看到的是
 * 庫裡的現狀，指針還沒寫回去的話這張圖會被當成「還有人用」而留下。
 *
 * 掃描中途出錯（哪怕只有一張表讀不出來）一律當作「還有人引用」保留：刪除不可逆，
 * 留下的孤兒則有手動 GC 兜著。
 */
export async function deleteBlobRefIfUnreferenced(ref: string | undefined | null): Promise<boolean> {
    if (!ref || !isBlobRef(ref)) return false;

    try {
        if (await isRefStillReferenced(ref)) return false;
    } catch {
        return false;
    }

    await deleteBlobRef(ref);
    return true;
}

// ─── data URL ⇄ Blob 互轉 ───────────────────────────────────────
// 語義隨 SDK：dataUrlToBlob 非法輸入拋錯、非 base64 退化 UTF-8 編碼；
// blobToDataUrl 優先 FileReader，無 FileReader 環境（Worker / Node 測試）退化 arrayBuffer 手編。
export { dataUrlToBlob, blobToDataUrl };

// ─── 內容記憶：同一份圖別存第二遍 ───────────────────────────────
//
// 惰性遷移分散在各消費點（壁紙加載、進小屋、圖標、捏人器部件），彼此不知道對方轉過什麼。
// 導入過「同一張圖內聯在好幾處」的舊備份後，這些入口會在幾分鐘裡把同一份 base64 各轉一遍，
// 庫裡於是躺著好幾份一模一樣的 Blob。這層記憶按內容哈希把它們收斂到同一個令牌上。
//
// key 用哈希而不是 data URL：後者動輒幾 MB，緩存它等於把 base64 又請回內存，
// 那正是 blobRef 要解決的問題。
//
// 只在進程內有效（刷新即空）。跨會話的重複交給「優化資源存儲」——它掃全庫按內容合併，
// 並在開頭拿掃描結果給這份記憶預熱，於是轉換時能直接複用庫裡已經有的那份。
const contentMemo = new Map<string, string>();

/**
 * 用掃庫結果預熱內容記憶。tokens 按創建時間升序，取第一個（也是合併時的保留方）。
 *
 * 調用方要先濾掉「被裸刪字段引用」的令牌（見 utils/blobDedupe.ts 的 collectUnmergeableRefs）：
 * 複用到那種令牌，等於讓新字段和一個「換圖就直接刪」的字段共享 Blob，對方一刪這邊就破圖。
 */
export function primeContentMemo(byHash: Map<string, string[]>): void {
    for (const [hash, tokens] of byHash) {
        if (tokens.length > 0) contentMemo.set(hash, tokens[0]);
    }
}

/** 僅測試用：清空內容記憶，避免用例之間串味。 */
export function clearContentMemo(): void {
    contentMemo.clear();
}

/**
 * 存 Blob，但先看看同樣內容的是不是已經有了——有就複用它的令牌，不再存第二份。
 * 算不出哈希（非安全上下文沒有 crypto.subtle）時退化成普通 put，功能照舊、只是不去重。
 *
 * 只給遷移路徑用。用戶當場上傳的圖仍走 putImageBlob 各存各的：那幾個字段換圖時是
 * 裸刪舊 Blob 的，共享會讓一次刪除波及別人（見 deleteBlobRef 的註釋）。
 */
export async function putImageBlobDeduped(blob: Blob): Promise<{ token: string; reused: boolean }> {
    let hash: string | null = null;
    try { hash = await hashBlob(blob); } catch { hash = null; }

    if (hash) {
        const remembered = contentMemo.get(hash);
        // 記住的令牌可能已經不在了：它寫進某個字段後那個字段又被改掉，Blob 成孤兒被 GC 收走。
        // 直接還回去就是個死令牌，所以確認 Blob 還在才複用。
        if (remembered) {
            if (await getBlobForRef(remembered)) return { token: remembered, reused: true };
            contentMemo.delete(hash);
        }
    }

    const token = await putImageBlob(blob);
    if (hash) contentMemo.set(hash, token);
    return { token, reused: false };
}

/**
 * 把一個 data: 圖片存成 Blob 並返回令牌（惰性遷移用）。同內容的圖已經存過就複用它，
 * 不再存第二份。轉換失敗時回退返回原字符串，保證調用方永遠拿到一個可渲染的值，
 * 不會因遷移失敗而丟圖。
 */
export async function migrateDataUrlToRef(dataUrl: string): Promise<string> {
    try {
        return (await putImageBlobDeduped(dataUrlToBlob(dataUrl))).token;
    } catch {
        return dataUrl;
    }
}

/**
 * 氣泡主題裡參與令牌遷移的圖片字段名。user / ai 兩側字段完全一樣，共用這一份清單——
 * 分開寫兩份的結果一定是其中一側漏掉某個字段，而漏掉的那側不報錯也不破圖，只是沒省下來。
 */
export const CHAT_THEME_IMAGE_KEYS = ['backgroundImage', 'decoration', 'avatarDecoration'] as const;

/**
 * 一套氣泡主題裡的六張圖（user / ai 兩側各三張）轉成令牌。
 *
 * 兩個調用方共用它：themes 表的存量轉換，和外觀預設裡內嵌的那份 chatThemes。
 * 後者尤其要緊——應用一個老預設時若把預設裡的 base64 原樣寫回 themes 表，
 * 等於把剛優化掉的圖又倒回去，用戶會看到「優化完過幾天又漲回來了」。
 */
export async function migrateChatThemeBlobRefs(theme: ChatTheme): Promise<ChatTheme> {
    const migrated: ChatTheme = { ...theme };
    for (const side of ['user', 'ai'] as const) {
        const style = theme[side];
        if (!style) continue;
        const next = { ...style };
        for (const key of CHAT_THEME_IMAGE_KEYS) {
            const value = next[key];
            if (typeof value === 'string' && value.startsWith('data:')) {
                next[key] = await migrateDataUrlToRef(value);
            }
        }
        migrated[side] = next;
    }
    return migrated;
}

/**
 * 外觀預設導入專用遷移：只轉換已經接入 BlobRef 渲染鏈路的字段，其他 data URL 保持原狀。
 *
 * 同一張原圖在壁紙、鎖屏或多個圖標裡出現時只會存一份 Blob——這由 migrateDataUrlToRef
 * 的內容記憶保證（按哈希認人）。這裡不再自備一層 data URL → 令牌的緩存：鍵是幾 MB 的
 * base64 原文，一批預設過下來等於把它們全留在內存裡，而收益只是省掉一次哈希計算。
 */
export async function migrateAppearancePresetBlobRefs(
    preset: AppearancePreset,
): Promise<AppearancePreset> {
    const migrate = async (value: string | undefined): Promise<string | undefined> => {
        if (!value?.startsWith('data:')) return value;
        return await migrateDataUrlToRef(value);
    };

    const theme = { ...preset.theme };
    theme.wallpaper = (await migrate(theme.wallpaper)) || theme.wallpaper;
    if ('lockWallpaper' in theme) theme.lockWallpaper = await migrate(theme.lockWallpaper);

    // 桌面小組件圖。槽位鍵遍歷全部，不寫死 tl/tr/wide/dsq——老美化包的預設裡還壓著
    // polaroid_* 這類歷史鍵，一併轉掉，免得它們以 base64 形態一直躺在預設 JSON 裡。
    if (theme.launcherWidgets) {
        const widgets: Record<string, string> = {};
        for (const [slot, value] of Object.entries(theme.launcherWidgets)) {
            widgets[slot] = (await migrate(value)) || value;
        }
        theme.launcherWidgets = widgets;
    }

    // launcherWidgetImage 是死字段：types.ts 標了 DEPRECATED，OSContext 加載 / 應用預設時
    // 一律剝掉，永遠不會渲染。老美化包的預設裡還壓著一張幾百 KB 的 base64，轉成令牌只是
    // 把死重量換個地方存，直接扔掉。
    if ('launcherWidgetImage' in theme) (theme as any).launcherWidgetImage = undefined;

    let customIcons = preset.customIcons;
    if (customIcons) {
        customIcons = {};
        for (const [appId, icon] of Object.entries(preset.customIcons || {})) {
            customIcons[appId] = (await migrate(icon)) || icon;
        }
    }

    // 預設裡內嵌的氣泡主題：保存預設時是從 themes 表原樣抄過來的，themes 表轉了、這裡沒轉，
    // 下次應用預設就把 base64 又灌回 themes 表。兩邊必須一起轉。
    let chatThemes = preset.chatThemes;
    if (chatThemes) {
        const next: ChatTheme[] = [];
        for (const ct of chatThemes) next.push(await migrateChatThemeBlobRefs(ct));
        chatThemes = next;
    }

    return { ...preset, theme, customIcons, chatThemes };
}

/**
 * 把單個值從令牌解析成可直接用的 data URL（讀 Blob → base64）；非令牌原樣返回。
 * 用在必須拿 base64 字符串的消費點（如跨 iframe postMessage 的捏人器部件）。
 * Blob 已丟時返回空串（避免把死令牌當 img src 用）。
 */
export async function resolveRefToDataUrl(value: string): Promise<string> {
    return blobStore.resolveToDataUrl(value);
}

/**
 * 深度遍歷對象樹，把所有 `blobref:<id>` 字符串原地替換成對應的 data URL（讀 Blob 轉 base64）。
 * 單文件分享（外觀預設 / 小屋模板）導出前調用，令牌隨之變回 data:image 內嵌進 JSON——
 * 整包備份不走這條（v3 令牌原樣進包，見 utils/backupBlobs.ts）。解析不到的令牌置空串
 * （圖已丟，避免導出一個恢復端認不得的死令牌）。原地修改傳入對象，調用方須傳獨立副本。
 */
export async function resolveBlobRefsDeep(root: unknown): Promise<void> {
    if (root === null || typeof root !== 'object') return;
    await blobStore.resolveDeep(root);
}

// ─── React 渲染 hook ────────────────────────────────────────────

/**
 * 把一個圖片字段值解析成可直接用於 <img src>/CSS url() 的字符串。
 *   · blobref 令牌 → 交給 SDK 讀 Blob 建 objectURL，組件卸載 / value 變化時 revoke，絕不洩漏；
 *     解析完成前返回 undefined —— 首幀無圖、令牌間切換時先空一幀再出新圖，
 *     絕不把上一個（已 revoke 的）objectURL 吐給渲染層；
 *   · builtin-room-asset 令牌 / 舊樣板房絕對 URL → 當前部署下的內置資源 URL；
 *   · 其它（data: / http(s) / 漸變 / undefined）→ 渲染期直接透傳，不等 effect、無一幀滯後。
 * 語義契約釘在 ./blobRefHook.contract.test.ts。
 */
export function useBlobRefUrl(value: string | undefined | null): string | undefined {
    // builtin 分支在 SDK 之前解析；blobref 令牌繞過它直接交給 SDK。
    const resolved = isBlobRef(value) ? value : resolveBuiltinRoomAssetUrl(value);
    return useBlobUrl(blobStore, resolved);
}
