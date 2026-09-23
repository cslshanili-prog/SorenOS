// blobref 令牌合併——「同一張圖在庫裡存了好幾份」的收尾那一半。
//
// 重複是這麼長出來的：同一張圖有好幾條互不相識的遷移入口（壁紙加載器的惰性遷移、
// 「優化資源存儲」的批量轉換、外觀預設導入……），各 put 各的，於是令牌不同、內容
// 逐字節相同。SDK 負責「找出哪些令牌裝的是同一份內容」，本文件負責宿主特有的另一半：
// 把重複令牌在**全部引用面**上改寫成組內保留的那個（canonical）。
//
// 改完不刪 Blob。失去引用的那幾份自然變成孤兒，交給已有的孤兒 GC（utils/blobGc.ts）收——
// 刪除不可逆，走那條已經帶著安全閥（新鮮豁免、整輪放棄）的老路，比在這裡現刪穩當。
//
// ─── 引用面與 GC 同源 ───
// 面的清單直接複用 blobGc 的 REF_SOURCE_STORES + localStorage 全量，兩邊永遠一致：
// GC 能 mark 到的地方，這裡就能改寫到（blobDedupe.test.ts 有守衛釘這條）。
// 萬一漏了某個面，那個面會繼續指著舊令牌 —— 舊 Blob 因此仍被引用、GC 也不會刪它，
// 方向是安全的（少省一點空間，不會破圖）。
//
// ─── 有一批令牌不參與合併 ───
// 合併會讓兩個原本各存一份的字段共享同一個 Blob。多數面無所謂（它們要麼不刪、要麼刪
// 之前先查引用），但有幾個字段的刪除是裸刪（deleteBlobRef）：它們的圖來自用戶當場選的
// 文件，一份令牌只歸自己，所以換圖 / 移除時直接把舊 Blob 刪掉。一旦合併讓它和別處共享，
// 那一刪就把別人的圖也刪了。collectUnmergeableRefs 把這些令牌撈出來，整組跳過。
//
// ─── 為什麼不 JSON.stringify 整行再字符串替換 ───
// 那樣寫回時得 JSON.parse 回來，行裡的 Blob / Date / undefined 字段會被順手毀掉。
// 這裡改成深度遍歷、只碰 string 值：普通對象和數組往下走，其餘（Blob、Date、Map、
// TypedArray……）一律不進去翻。嵌套 JSON 字符串（如 assets 的 appearance_preset_*）
// 裡的令牌照樣命中——令牌在 JSON 文本里也是原樣的一段純文本。

import { DB } from './db';
import { BLOBREF_PREFIX, getBlobForRef } from './blobRef';
import { REF_SOURCE_STORES } from './blobGc';

// 與 blobGc 的分頁大小同值：批間事務各自獨立，內存峰值只有一批。
const PAGE_SIZE = 200;

// 令牌整體匹配：前綴 + 最長的 [A-Za-z0-9_] 段。字符集與 SDK 的 extractRefs / GC 同源，
// 貪婪到邊界為止，所以「A 是 B 的前綴」這種令牌（blobref:b_x 與 blobref:b_x_y）不會
// 被切錯——匹配出來的永遠是完整的那個，再拿去查 mapping，命不中就原樣留下。
const TOKEN_PATTERN = new RegExp(
    `${BLOBREF_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z0-9_]+`,
    'g',
);

/**
 * 一段文本里的令牌按 mapping 改寫；表裡沒有的原樣留下。
 * 傳了 hits 就把真正改掉的那些令牌記進去——調用方據此如實統計「實際合併了幾份」，
 * 而不是按計劃數虛報（計劃裡的令牌可能早就沒人引用了）。
 */
export function rewriteRefsInText(text: string, mapping: Map<string, string>, hits?: Set<string>): string {
    return text.replace(TOKEN_PATTERN, m => {
        const to = mapping.get(m);
        if (to === undefined) return m;
        hits?.add(m);
        return to;
    });
}

/** 只有「普通對象」才往下翻。Blob / File / Date / Map / Set / TypedArray 全被這道判斷擋在外面。 */
const isPlainContainer = (v: object): boolean => Object.prototype.toString.call(v) === '[object Object]';

/** 原地改寫容器裡某個位置的值，返回是否動過。 */
function rewriteSlot(
    container: any, key: string | number, mapping: Map<string, string>,
    seen: WeakSet<object>, hits?: Set<string>,
): boolean {
    const value = container[key];
    if (typeof value === 'string') {
        const next = rewriteRefsInText(value, mapping, hits);
        if (next === value) return false;
        container[key] = next;
        return true;
    }
    if (value && typeof value === 'object') return rewriteRefsDeep(value, mapping, seen, hits);
    return false;
}

/**
 * 深度遍歷對象樹，原地把令牌改寫成 canonical，返回是否動過。
 * seen 擋循環引用（角色行裡的對象圖不保證是樹）。
 */
export function rewriteRefsDeep(
    root: object, mapping: Map<string, string>,
    seen: WeakSet<object> = new WeakSet(), hits?: Set<string>,
): boolean {
    if (seen.has(root)) return false;
    seen.add(root);

    let changed = false;
    if (Array.isArray(root)) {
        for (let i = 0; i < root.length; i++) {
            if (rewriteSlot(root, i, mapping, seen, hits)) changed = true;
        }
        return changed;
    }
    if (!isPlainContainer(root)) return false;
    for (const key of Object.keys(root)) {
        if (rewriteSlot(root, key, mapping, seen, hits)) changed = true;
    }
    return changed;
}

export interface RewriteRefsResult {
    /** 被改寫並寫回的表行數 */
    rewrittenRows: number;
    /** 被改寫並寫回的 localStorage 鍵數 */
    rewrittenLocalKeys: number;
    /** 掃過的表行總數（進度/體感用） */
    scannedRows: number;
    /**
     * 真正改掉的那些重複令牌。映射裡的令牌不一定都還有人引用——上一輪合併留下的
     * 孤兒 Blob 還躺在庫裡，下一輪掃描照樣把它當重複報出來。按這個集合統計才不會虛報。
     */
    mergedRefs: Set<string>;
}

/**
 * 把 mapping 裡的重複令牌在全部引用面上改寫成 canonical。
 *
 * 調用方須先持有 maintenanceLock：改寫是「引用搬家」，撞上 GC 進行中的 mark 會讓
 * 同一個令牌在兩個面之間瞬間消失，被誤判成孤兒刪掉（SDK README 的宿主義務之一）。
 *
 * mapping 必須是「一跳到底」的：canonical 自己不能再是別人的 key，否則改寫完還剩一層
 * 指向，兩輪結果不一致。入參不合格直接拋，不猜意圖。
 */
export async function rewriteBlobRefs(
    mapping: Map<string, string>,
    opts: { onProgress?: (scannedRows: number) => void } = {},
): Promise<RewriteRefsResult> {
    const result: RewriteRefsResult = {
        rewrittenRows: 0, rewrittenLocalKeys: 0, scannedRows: 0, mergedRefs: new Set(),
    };
    if (mapping.size === 0) return result;

    // ── 入參體檢（都是「改錯了不可逆」的前提，寧可吵著拋）──
    const canonicals = new Set(mapping.values());
    for (const [from, to] of mapping) {
        if (from === to) throw new Error(`合併映射非法：${from} 指向自己。`);
        if (canonicals.has(from)) throw new Error(`合併映射非法：${from} 既是被合併方又是保留方，需先收斂成一跳。`);
    }
    // canonical 必須真有 Blob 在——把好引用改到一個空令牌上就是實打實的破圖。
    for (const canonical of canonicals) {
        if (!(await getBlobForRef(canonical))) {
            throw new Error(`合併映射非法：保留方 ${canonical} 讀不到 Blob，已中止（引用未改動）。`);
        }
    }

    // ── 表面：分頁讀 → 原地改 → 髒行寫回 ──
    for (const storeName of REF_SOURCE_STORES) {
        let afterKey: IDBValidKey | null = null;
        for (;;) {
            const { rows, lastKey } = await DB.getStoreRowsPage(storeName, afterKey, PAGE_SIZE);
            const dirty: unknown[] = [];
            for (const row of rows) {
                result.scannedRows++;
                if (!row || typeof row !== 'object') continue;
                if (rewriteRefsDeep(row as object, mapping, new WeakSet(), result.mergedRefs)) dirty.push(row);
            }
            if (dirty.length > 0) {
                await DB.putStoreRows(storeName, dirty);
                result.rewrittenRows += dirty.length;
            }
            opts.onProgress?.(result.scannedRows);
            if (lastKey === null || rows.length < PAGE_SIZE) break;
            afterKey = lastKey;
        }
    }

    // ── localStorage 面：先把鍵快照下來再逐條改，避免邊寫邊移位漏掃 ──
    if (typeof localStorage !== 'undefined') {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key !== null) keys.push(key);
        }
        for (const key of keys) {
            const value = localStorage.getItem(key);
            if (value === null) continue;
            const next = rewriteRefsInText(value, mapping, result.mergedRefs);
            if (next === value) continue;
            localStorage.setItem(key, next);
            result.rewrittenLocalKeys++;
        }
    }

    return result;
}


// ─── 不參與合併的令牌 ───────────────────────────────────────────

/**
 * 裸刪（deleteBlobRef，而不是 deleteBlobRefIfUnreferenced）的字段清單。
 * 這幾個字段換圖 / 移除時會直接刪掉舊 Blob，前提是「這份令牌只歸我」——
 * 合併一旦讓它和別處共享，那一刪就連別人的圖一起刪了。
 *
 * | 字段 | 裸刪發生在 |
 * |---|---|
 * | characters.companionAvatar.imageRef | apps/Appearance.tsx（換圖 / 移除桌面靜態形象） |
 * | characters.companionAvatar.imageWardrobe[].imageRef | 同上：衣櫃條目跟頂層 imageRef 共用同一個
 * |                                     | 令牌（令牌兼任條目 id，見 utils/companionWardrobe.ts），
 * |                                     | 換圖時衣櫃裡沒留著這套就跟著一起刪 |
 * | characters.videoCallBackground      | apps/CallApp.tsx（換 / 清視頻舞台背景） |
 * | characters.companionBackground      | components/os/CompanionHome.tsx（換 / 清桌面背景） |
 * | messages.metadata.cameraSnapshotRef | apps/CallApp.tsx（快照替換 / 過期淘汰 / 刪通話記錄） |
 * | localStorage 假攝像頭圖片            | apps/CallApp.tsx（換圖 / 移除假攝像頭） |
 *
 * ⚠️ 新增 deleteBlobRef 的裸刪調用點時，把那個字段一併加進來（blobRef.ts 的
 *    deleteBlobRef 註釋裡也指著這份清單）。漏登記的後果是那個字段的圖可能被別處刪掉。
 */
const UNMERGEABLE_LOCAL_KEYS = ['sully-call-fake-camera-image-v1'] as const;

/** 撈出所有「不能參與合併」的令牌。讀不出來就上拋——寧可整輪不合並，也不能漏登記。 */
export async function collectUnmergeableRefs(): Promise<Set<string>> {
    const refs = new Set<string>();
    const take = (v: unknown) => {
        if (typeof v === 'string' && v.startsWith(BLOBREF_PREFIX)) refs.add(v);
    };

    let afterKey: IDBValidKey | null = null;
    for (;;) {
        const { rows, lastKey } = await DB.getStoreRowsPage('characters', afterKey, PAGE_SIZE);
        for (const row of rows as any[]) {
            if (!row || typeof row !== 'object') continue;
            take(row.companionAvatar?.imageRef);
            // 衣櫃條目：令牌同時佔著 id 和 imageRef 兩個值位，兩個都收——只登記一半的話，
            // 另一半仍會被當成普通令牌合併進共享組。
            const wardrobe = row.companionAvatar?.imageWardrobe;
            if (Array.isArray(wardrobe)) {
                for (const outfit of wardrobe) {
                    take(outfit?.imageRef);
                    take(outfit?.id);
                }
            }
            take(row.videoCallBackground);
            take(row.companionBackground);
        }
        if (lastKey === null || rows.length < PAGE_SIZE) break;
        afterKey = lastKey;
    }

    afterKey = null;
    for (;;) {
        const { rows, lastKey } = await DB.getStoreRowsPage('messages', afterKey, PAGE_SIZE);
        for (const row of rows as any[]) {
            if (!row || typeof row !== 'object') continue;
            take(row.metadata?.cameraSnapshotRef);
        }
        if (lastKey === null || rows.length < PAGE_SIZE) break;
        afterKey = lastKey;
    }

    if (typeof localStorage !== 'undefined') {
        for (const key of UNMERGEABLE_LOCAL_KEYS) take(localStorage.getItem(key));
    }
    return refs;
}

/** SDK scanContent 吐出來的重複組（只取本文件用得著的字段）。 */
export interface DuplicateGroupLike {
    canonical: string;
    duplicates: string[];
    size: number;
    wastedBytes: number;
}

export interface MergePlan {
    /** 重複令牌 → 保留令牌。可直接餵給 rewriteBlobRefs */
    mapping: Map<string, string>;
    /** 每個重複令牌對應的字節數——按「實際改寫掉的那些」求和才是真能回收的空間 */
    bytesByToken: Map<string, number>;
    /** 因為觸到裸刪字段而整組跳過的組數 */
    skippedGroups: number;
    /** 合併後能讓 GC 回收的字節數（只算真的會合並的那些組） */
    reclaimableBytes: number;
}

/**
 * 把掃描結果收斂成一份「一跳到底」的合併映射。
 * 只要組裡有任何一個令牌被裸刪字段引用著，整組跳過——保留方也可能是那一個，
 * 只剔掉單個令牌並不能讓剩下的變安全。
 */
export function buildMergePlan(
    groups: readonly DuplicateGroupLike[],
    unmergeable: ReadonlySet<string>,
): MergePlan {
    const plan: MergePlan = { mapping: new Map(), bytesByToken: new Map(), skippedGroups: 0, reclaimableBytes: 0 };
    for (const group of groups) {
        if (group.duplicates.length === 0) continue;
        if (unmergeable.has(group.canonical) || group.duplicates.some(t => unmergeable.has(t))) {
            plan.skippedGroups++;
            continue;
        }
        for (const dup of group.duplicates) {
            plan.mapping.set(dup, group.canonical);
            plan.bytesByToken.set(dup, group.size);
        }
        plan.reclaimableBytes += group.wastedBytes;
    }
    return plan;
}
