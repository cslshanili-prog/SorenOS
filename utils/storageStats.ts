/**
 * 本機存儲用量統計
 *
 * 回答用戶兩個問題：
 *   1.「我的數據一共多大」—— navigator.storage.estimate()，一次調用就有，進設置頁就能顯示。
 *   2.「都是些什麼佔的」—— 翻 IndexedDB 逐表測量，秒級，所以界面上摺疊起來、點開才算。
 *
 * 第 2 問的兩個現實約束：
 *   · messages 這種表動輒幾萬條，逐條測量能把主線程卡死幾秒 —— 超過採樣上限的表改成
 *     「均勻跳著採樣再按條數放大」，界面上標個「約」。
 *   · 圖片和 VRM / Live2D 模型都塞在同一張 blob_assets 表裡，key 是隨機 id 分不出類型，
 *     只能看 Blob 的 MIME：image/* 算圖片、audio/* 算語音，剩下的（zip / octet-stream）
 *     當模型。猜錯的代價只是某一行數字偏了，不影響總量。
 */

import { openDB } from './db';

// ─── 概覽：瀏覽器給了多少、給不給「別清我」的許可 ──────────────────

export interface StorageOverview {
    /** 瀏覽器提供不提供用量信息。false 時下面兩個字節數都是 null，別拿 0 頂上去。 */
    supported: boolean;
    usageBytes: number | null;
    quotaBytes: number | null;
    /**
     * 瀏覽器實報的 IndexedDB 那一份（Chrome 的 usageDetails 才有，其它家是 null）。
     * 細分校準要用它：我們量的是原始字節，落盤時壓過一道，兩者天然對不上。
     */
    indexedDbBytes: number | null;
    /** 持久化許可。null = 這個瀏覽器不支持查詢（不等於沒有）。 */
    persisted: boolean | null;
}

const getStorageManager = (): StorageManager | null => {
    if (typeof navigator === 'undefined') return null;
    return (navigator as Navigator).storage ?? null;
};

/** 讀總量 + 持久化狀態。任何一環失敗都降級成「讀不到」，不拋。 */
export async function readStorageOverview(): Promise<StorageOverview> {
    const sm = getStorageManager();
    const fallback: StorageOverview = {
        supported: false, usageBytes: null, quotaBytes: null, indexedDbBytes: null, persisted: null,
    };
    if (!sm) return fallback;

    let usageBytes: number | null = null;
    let quotaBytes: number | null = null;
    let indexedDbBytes: number | null = null;
    let supported = false;
    if (typeof sm.estimate === 'function') {
        try {
            const est = await sm.estimate() as StorageEstimate & { usageDetails?: Record<string, number> };
            supported = true;
            usageBytes = typeof est.usage === 'number' ? est.usage : null;
            quotaBytes = typeof est.quota === 'number' ? est.quota : null;
            const detail = est.usageDetails?.indexedDB;
            indexedDbBytes = typeof detail === 'number' ? detail : null;
        } catch {
            // 隱私模式 / 權限受限會直接 reject，當成「這瀏覽器不給看」處理
        }
    }

    let persisted: boolean | null = null;
    if (typeof sm.persisted === 'function') {
        try {
            persisted = await sm.persisted();
        } catch {
            persisted = null;
        }
    }

    return { supported, usageBytes, quotaBytes, indexedDbBytes, persisted };
}

/**
 * 申請持久化許可。
 *
 * 各家給法不一樣：Chrome 從不彈框，按站點參與度（裝沒裝到主屏、給沒給通知權限）自己判；
 * Firefox 會彈權限框；Safari 看有沒有被加到主屏。所以「申請失敗」很正常，界面上要給用戶
 * 說清楚怎麼提高成功率，而不是讓他對著一個紅字乾瞪眼。
 */
export async function requestPersistentStorage(): Promise<boolean> {
    const sm = getStorageManager();
    if (!sm || typeof sm.persist !== 'function') return false;
    try {
        return await sm.persist();
    } catch {
        return false;
    }
}

// ─── 分類 ──────────────────────────────────────────────────────

export type StorageCategoryKey = 'media' | 'chat' | 'characters' | 'memory' | 'activeMsg' | 'other';

export const STORAGE_CATEGORY_LABELS: Record<StorageCategoryKey, string> = {
    media: '圖片與媒體',
    chat: '聊天記錄',
    characters: '角色與模型',
    memory: '記憶宮殿',
    activeMsg: '主動消息',
    other: '其他 App 數據',
};

/** 顯示順序：大頭在前，「其他」永遠墊底。 */
export const STORAGE_CATEGORY_ORDER: StorageCategoryKey[] = ['media', 'chat', 'characters', 'memory', 'activeMsg', 'other'];

/**
 * 表名 → 類別。沒列進來的表一律落到 other，所以以後新加表不會從統計裡消失，
 * 只是暫時歸在「其他 App 數據」裡 —— 總量永遠是對的。
 */
const STORE_CATEGORY: Record<string, StorageCategoryKey> = {
    // 聊天
    messages: 'chat',
    groups: 'chat',
    scheduled_messages: 'chat',
    // 角色
    characters: 'characters',
    character_groups: 'characters',
    worldbooks: 'characters',
    cc_custom_parts: 'characters',
    // 圖片 / 外觀
    assets: 'media',
    emojis: 'media',
    emoji_categories: 'media',
    gallery: 'media',
    themes: 'media',
    journal_stickers: 'media',
    // 記憶宮殿
    memory_nodes: 'memory',
    memory_vectors: 'memory',
    memory_links: 'memory',
    memory_batches: 'memory',
    topic_boxes: 'memory',
    anticipations: 'memory',
    event_boxes: 'memory',
    room_plates: 'memory',
    digest_reports: 'memory',
};

/** 圖片和模型混住的那張表，二進制部分要按 MIME 二次分流。 */
const MIXED_BLOB_STORE = 'blob_assets';

export function categoryOfStore(storeName: string): StorageCategoryKey {
    return STORE_CATEGORY[storeName] ?? 'other';
}

// ─── 單條記錄的字節測量 ─────────────────────────────────────────

/** 二進制在 JSON 裡的佔位符，長度固定，不影響量級判斷。 */
const BINARY_PLACEHOLDER = '"~bin~"';

export type BinaryKind = 'image' | 'audio' | 'video' | 'binary';

/** MIME 歸一化：只關心「這是圖、是聲音、還是一坨二進制」。 */
export function binaryKindOfMime(mime: string | undefined | null): BinaryKind {
    const m = (mime || '').toLowerCase();
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('audio/')) return 'audio';
    if (m.startsWith('video/')) return 'video';
    return 'binary';
}

export interface ValueMeasurement {
    bytes: number;
    /** 其中二進制部分按種類拆開，供 blob_assets 二次分流用。 */
    binaryBytes: Partial<Record<BinaryKind, number>>;
}

/**
 * 測一條記錄多大。
 *
 * 走 JSON.stringify 的 replacer 一次遍歷搞定：文本部分交給原生序列化（比手寫遞歸快得多），
 * 二進制（Blob / ArrayBuffer / TypedArray）在 replacer 裡換成佔位符並單獨累加 —— 否則
 * Float32Array 會被 stringify 成 {"0":..,"1":..} 那種巨型字符串，又慢又把數字撐到天上去。
 */
export function measureValue(value: unknown): ValueMeasurement {
    const binaryBytes: Partial<Record<BinaryKind, number>> = {};
    const addBinary = (kind: BinaryKind, size: number) => {
        binaryBytes[kind] = (binaryBytes[kind] ?? 0) + size;
    };

    let json = '';
    try {
        json = JSON.stringify(value, (_key, val) => {
            if (typeof Blob !== 'undefined' && val instanceof Blob) {
                addBinary(binaryKindOfMime(val.type), val.size);
                return BINARY_PLACEHOLDER;
            }
            if (val instanceof ArrayBuffer) {
                addBinary('binary', val.byteLength);
                return BINARY_PLACEHOLDER;
            }
            if (ArrayBuffer.isView(val)) {
                addBinary('binary', (val as ArrayBufferView).byteLength);
                return BINARY_PLACEHOLDER;
            }
            return val;
        }) ?? '';
    } catch {
        // 循環引用 / 帶 getter 拋錯的對象：文本部分算不出來就算了，
        // 二進制那部分 replacer 已經數過的仍然作數。
        json = '';
    }

    let textBytes = 0;
    if (json) {
        try {
            textBytes = new TextEncoder().encode(json).length;
        } catch {
            textBytes = json.length;
        }
    }

    const binaryTotal = Object.values(binaryBytes).reduce((a, b) => a + (b ?? 0), 0);
    return { bytes: textBytes + binaryTotal, binaryBytes };
}

// ─── 單張表的測量 ───────────────────────────────────────────────

/** 普通表最多實測多少條，超了就跳著採樣。 */
export const SAMPLE_LIMIT = 300;
/** 二進制表（只讀 blob.size，很便宜）的全量上限，超了同樣退回採樣。 */
export const BLOB_FULL_SCAN_LIMIT = 20000;

export interface StoreUsage {
    store: string;
    bytes: number;
    /** 記錄條數（精確，來自 count()）。 */
    count: number;
    /** true = 數字是採樣放大出來的，界面上要標「約」。 */
    estimated: boolean;
    binaryBytes: Partial<Record<BinaryKind, number>>;
}

const countStore = (db: IDBDatabase, storeName: string): Promise<number> =>
    new Promise((resolve, reject) => {
        const req = db.transaction(storeName, 'readonly').objectStore(storeName).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

/**
 * 測一張表。
 *
 * 採樣是「均勻跳著取」而不是「取前 N 條」—— 後者在 messages 上會全採到最早那批短消息，
 * 把帶圖的長消息整個漏掉，估出來的數能差一個量級。
 */
export async function measureStoreUsage(db: IDBDatabase, storeName: string): Promise<StoreUsage> {
    const empty: StoreUsage = { store: storeName, bytes: 0, count: 0, estimated: false, binaryBytes: {} };
    const count = await countStore(db, storeName);
    if (count === 0) return empty;

    const fullScanLimit = storeName === MIXED_BLOB_STORE ? BLOB_FULL_SCAN_LIMIT : SAMPLE_LIMIT;
    // 步長用 ceil 而不是 floor：floor 會讓 step * limit < count，採滿上限時游標才走到
    // 表的中段，尾巴整段沒被採到 —— 而聊天記錄恰恰是越靠後的越大，一漏就低估三成。
    const step = count <= fullScanLimit ? 1 : Math.max(1, Math.ceil(count / fullScanLimit));

    return new Promise<StoreUsage>((resolve, reject) => {
        const binaryBytes: Partial<Record<BinaryKind, number>> = {};
        let sampledBytes = 0;
        let sampled = 0;

        const req = db.transaction(storeName, 'readonly').objectStore(storeName).openCursor();
        const finish = () => {
            if (sampled === 0) { resolve({ ...empty, count }); return; }
            const scale = step === 1 ? 1 : count / sampled;
            const scaled = (n: number) => Math.round(n * scale);
            const scaledBinary: Partial<Record<BinaryKind, number>> = {};
            for (const [kind, bytes] of Object.entries(binaryBytes)) {
                scaledBinary[kind as BinaryKind] = scaled(bytes ?? 0);
            }
            resolve({
                store: storeName,
                bytes: scaled(sampledBytes),
                count,
                estimated: step !== 1,
                binaryBytes: scaledBinary,
            });
        };

        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) { finish(); return; }
            const m = measureValue(cursor.value);
            sampledBytes += m.bytes;
            for (const [kind, bytes] of Object.entries(m.binaryBytes)) {
                binaryBytes[kind as BinaryKind] = (binaryBytes[kind as BinaryKind] ?? 0) + (bytes ?? 0);
            }
            sampled++;
            if (sampled >= fullScanLimit) { finish(); return; }
            try {
                cursor.advance(step);
            } catch {
                finish();
            }
        };
        req.onerror = () => reject(req.error);
    });
}

// ─── 整庫遍歷 ──────────────────────────────────────────────────

const yieldToMain = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export interface DatabaseUsage {
    stores: StoreUsage[];
    /** 讀不出來的表只記名字，不阻斷整體統計。 */
    failed: string[];
}

/** 挨張表測過去，表與表之間讓出主線程，避免統計過程把界面凍住。 */
export async function collectDatabaseUsage(
    db: IDBDatabase,
    onProgress?: (done: number, total: number) => void,
): Promise<DatabaseUsage> {
    const names = Array.from(db.objectStoreNames);
    const stores: StoreUsage[] = [];
    const failed: string[] = [];
    for (let i = 0; i < names.length; i++) {
        try {
            stores.push(await measureStoreUsage(db, names[i]));
        } catch {
            failed.push(names[i]);
        }
        onProgress?.(i + 1, names.length);
        await yieldToMain();
    }
    return { stores, failed };
}

// ─── 彙總成用戶看的那幾行 ───────────────────────────────────────

export interface StorageCategoryUsage {
    key: StorageCategoryKey;
    label: string;
    bytes: number;
    estimated: boolean;
    /**
     * 這一類裡屬於二進制（Blob）的字節數。校準時它原樣不動——Blob 在 IndexedDB 裡
     * 獨立落盤，不跟著 LevelDB 壓縮走，量到多少就是多少。
     */
    binaryBytes: number;
}

export interface StorageBreakdown {
    categories: StorageCategoryUsage[];
    totalBytes: number;
    failedStores: string[];
    /** 數字有沒有按瀏覽器實報的用量折算過（見 calibrateBreakdown）。 */
    calibrated: boolean;
}

/** 一個庫的逐表結果 + 這個庫整體該歸哪類（null = 按表名逐個判）。 */
export interface DatabaseUsageInput {
    usage: DatabaseUsage;
    forceCategory?: StorageCategoryKey;
}

/**
 * 把逐表字節數併成用戶看的那幾行。
 *
 * blob_assets 在這裡拆開：圖片 / 語音 / 視頻算「圖片與媒體」，剩下的二進制當模型算
 * 「角色與模型」，那張表自己的文本開銷（id 之類）跟著圖片走。
 */
export function summarizeUsage(inputs: DatabaseUsageInput[]): StorageBreakdown {
    const bytes: Record<StorageCategoryKey, number> = { media: 0, chat: 0, characters: 0, memory: 0, activeMsg: 0, other: 0 };
    const binary: Record<StorageCategoryKey, number> = { media: 0, chat: 0, characters: 0, memory: 0, activeMsg: 0, other: 0 };
    const estimated: Record<StorageCategoryKey, boolean> = { media: false, chat: false, characters: false, memory: false, activeMsg: false, other: false };
    const failedStores: string[] = [];
    const sumBinary = (b: Partial<Record<BinaryKind, number>>) =>
        Object.values(b).reduce((a: number, v) => a + (v ?? 0), 0);

    for (const { usage, forceCategory } of inputs) {
        failedStores.push(...usage.failed);
        for (const store of usage.stores) {
            if (store.bytes <= 0) continue;
            if (!forceCategory && store.store === MIXED_BLOB_STORE) {
                const bin = store.binaryBytes;
                const modelBytes = bin.binary ?? 0;
                const mediaBytes = store.bytes - modelBytes;
                if (modelBytes > 0) {
                    bytes.characters += modelBytes;
                    binary.characters += modelBytes;
                    estimated.characters ||= store.estimated;
                }
                if (mediaBytes > 0) {
                    bytes.media += mediaBytes;
                    // mediaBytes 裡除了圖片/語音的二進制，還含這張表自己的文本開銷（id 之類）
                    binary.media += Math.min(mediaBytes, sumBinary(bin) - modelBytes);
                    estimated.media ||= store.estimated;
                }
                continue;
            }
            const key = forceCategory ?? categoryOfStore(store.store);
            bytes[key] += store.bytes;
            binary[key] += Math.min(store.bytes, sumBinary(store.binaryBytes));
            estimated[key] ||= store.estimated;
        }
    }

    const categories = STORAGE_CATEGORY_ORDER
        .map(key => ({
            key, label: STORAGE_CATEGORY_LABELS[key],
            bytes: bytes[key], binaryBytes: binary[key], estimated: estimated[key],
        }))
        .filter(c => c.bytes > 0)
        .sort((a, b) => {
            if (a.key === 'other') return 1;
            if (b.key === 'other') return -1;
            return b.bytes - a.bytes;
        });

    return {
        categories,
        totalBytes: categories.reduce((sum, c) => sum + c.bytes, 0),
        failedStores,
        calibrated: false,
    };
}

/**
 * 按瀏覽器實報的 IndexedDB 用量折算文本部分。
 *
 * 我們量的是數據的原始字節，而 Chrome 的 IndexedDB（LevelDB 後端）落盤時會壓一道，
 * 於是細分合計經常比 estimate() 報的總量還大——界面上出現「一共 180 MB、細分加起來
 * 227 MB」純粹是在誤導人。Blob 不參與那道壓縮（獨立落盤），所以只折算文本那半。
 *
 * 只在我們量得偏大時折算。量出來比實報還小，說明有沒掃到的庫或別的來源，那該由
 * 界面上的「其他佔用」交代，把數字硬放大只是編圓了它。
 */
export function calibrateBreakdown(breakdown: StorageBreakdown, actualBytes: number | null): StorageBreakdown {
    if (actualBytes == null || !Number.isFinite(actualBytes) || actualBytes <= 0) return breakdown;

    const binaryTotal = breakdown.categories.reduce((n, c) => n + c.binaryBytes, 0);
    const textTotal = breakdown.totalBytes - binaryTotal;
    if (textTotal <= 0) return breakdown;

    // 二進制先佔掉實報的一部分，剩下的才是文本能分的
    const textActual = actualBytes - binaryTotal;
    if (textActual <= 0) return breakdown;      // 二進制就撐滿了：多半是實報口徑不同，別硬折
    const ratio = textActual / textTotal;
    if (ratio >= 1) return breakdown;           // 我們沒有高估，交給「其他佔用」去說

    const categories = breakdown.categories.map(c => {
        const text = Math.max(0, c.bytes - c.binaryBytes);
        return { ...c, bytes: Math.round(c.binaryBytes + text * ratio) };
    });
    return {
        ...breakdown,
        categories,
        totalBytes: categories.reduce((sum, c) => sum + c.bytes, 0),
        calibrated: true,
    };
}

// ─── 字節數格式化 ──────────────────────────────────────────────

/** 給界面用的人話大小。null / 負數一律回「—」，不要顯示 0 B 騙人。 */
export function formatBytes(bytes: number | null | undefined): string {
    if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
}

// ─── 編排：把本站所有 IndexedDB 庫跑一遍 ────────────────────────

/** 整庫歸類的庫名。沒列的庫按表名逐表判，最終多半落到「其他 App 數據」。 */
const DATABASE_CATEGORY: Record<string, StorageCategoryKey> = {
    ActiveMsg: 'activeMsg',
};

/** 瀏覽器不給枚舉庫列表時的兜底名單（主庫單獨走 openDB，不在這裡）。 */
const FALLBACK_DATABASE_NAMES = ['ActiveMsg'];

const MAIN_DATABASE_NAME = 'AetherOS_Data';

async function listDatabaseNames(): Promise<string[]> {
    if (typeof indexedDB === 'undefined') return [];
    const anyIdb = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
    if (typeof anyIdb.databases !== 'function') return [...FALLBACK_DATABASE_NAMES];
    try {
        const list = await anyIdb.databases();
        return list.map(d => d.name).filter((n): n is string => !!n);
    } catch {
        return [...FALLBACK_DATABASE_NAMES];
    }
}

/**
 * 只連已經存在的庫。
 *
 * 不帶版本號 open 一個不存在的庫會把它憑空建出來 —— 統計功能絕不能有這種副作用，
 * 所以一旦觸發 upgradeneeded（說明是新建的）就立刻關掉刪掉當沒發生過。
 */
function openExistingDatabase(name: string): Promise<IDBDatabase | null> {
    return new Promise(resolve => {
        let created = false;
        let req: IDBOpenDBRequest;
        try {
            req = indexedDB.open(name);
        } catch {
            resolve(null);
            return;
        }
        req.onupgradeneeded = () => { created = true; };
        req.onsuccess = () => {
            const db = req.result;
            if (created) {
                db.close();
                let del: IDBOpenDBRequest | null = null;
                try {
                    del = indexedDB.deleteDatabase(name);
                } catch {
                    resolve(null); // 刪不掉就算了，空庫無害
                    return;
                }
                // 等刪乾淨再往下走，別讓「剛建出來的空庫」在調用方眼皮底下一閃而過
                const done = () => resolve(null);
                del.onsuccess = done;
                del.onerror = done;
                del.onblocked = done;
                return;
            }
            resolve(db);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
    });
}

export interface BreakdownProgress {
    /** 已測完的表數 / 總表數，夠界面顯示個「計算中 12/68」了。 */
    done: number;
    total: number;
}

/**
 * 跑一遍本站所有 IndexedDB，算出各類別佔多少。
 *
 * 注意返回的 totalBytes 只是 IndexedDB 的量，一般會小於 estimate() 報的總用量 ——
 * 差的那部分是 Cache Storage（PWA 離線緩存的 JS / 圖片）之類，不歸我們管也刪不動。
 * 界面上把差額單獨交代一句，別讓用戶以為數字對不上。
 */
export async function computeStorageBreakdown(
    onProgress?: (p: BreakdownProgress) => void,
): Promise<StorageBreakdown> {
    const opened: { db: IDBDatabase; category?: StorageCategoryKey; shouldClose: boolean }[] = [];

    try {
        opened.push({ db: await openDB(), shouldClose: false });
    } catch {
        // 主庫都連不上就沒什麼可統計的了，繼續往下走讓輔助庫有機會被算到
    }

    for (const name of await listDatabaseNames()) {
        if (name === MAIN_DATABASE_NAME) continue; // 主庫已經從 openDB() 拿到了，別重複開
        const db = await openExistingDatabase(name);
        if (db) opened.push({ db, category: DATABASE_CATEGORY[name], shouldClose: true });
    }

    const total = opened.reduce((n, e) => n + e.db.objectStoreNames.length, 0);
    onProgress?.({ done: 0, total });

    const inputs: DatabaseUsageInput[] = [];
    let done = 0;
    try {
        for (const entry of opened) {
            const usage = await collectDatabaseUsage(entry.db, d => onProgress?.({ done: done + d, total }));
            done += entry.db.objectStoreNames.length;
            inputs.push({ usage, forceCategory: entry.category });
        }
    } finally {
        for (const entry of opened) {
            if (entry.shouldClose) { try { entry.db.close(); } catch { /* 已經關了 */ } }
        }
    }

    // 折算要用瀏覽器實報的 IndexedDB 用量；讀不到（非 Chrome）就照原始字節顯示
    const overview = await readStorageOverview();
    return calibrateBreakdown(summarizeUsage(inputs), overview.indexedDbBytes);
}
