// 備份導出鏈路的純函數小工具。這裡刻意不碰 DOM / Capacitor / JSZip，
// 把兩塊容易出錯的邏輯——「原地抽取素材」和「手機端 3 字節對齊分片」——
// 拆出來，好在 node 測試環境裡單測釘住。

/**
 * 遍歷對象樹，把所有 `data:image/...` 字符串原地替換成 `resolveImage` 的返回值
 * （通常是 `assets/*` 路徑；無法抽取時原樣返回）。直接改傳進來的 `root`，所以
 * 調用方必須傳獨立副本：IDB getRawStoreData 拿到的是結構化克隆副本（安全），
 * 而 theme / customIcons / appearancePresets 這類引用了運行態 React state 的，
 * 必須先深拷貝再傳進來。
 *
 * 共享子圖（同一對象被多處引用）只處理一次；遇到真正的循環引用直接拋錯，
 * 讓問題在這裡就帶著清楚的提示暴露，而不是拖到後面 JSON.stringify 時報一句
 * 看不懂的 "circular structure"。
 */
export type BackupObjectPath = Array<string | number>;

/** 文字備份逐字段剝圖；嵌套的通訊錄、完整聊天原文、話題盒都必須保留。 */
export function stripBackupImages(obj: any): any {
    if (typeof obj === 'string') {
        if (obj.startsWith('data:image') || obj.startsWith('blobref:')) return '';
        return obj;
    }
    if (Array.isArray(obj)) return obj.map(stripBackupImages);
    if (obj !== null && typeof obj === 'object') {
        return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, stripBackupImages(value)]));
    }
    return obj;
}

export function extractImagesInPlace(
    root: unknown,
    resolveImage: (dataUrl: string, path: BackupObjectPath) => string,
): void {
    if (root === null || typeof root !== 'object') return;

    // onPath：當前正在遍歷的這條路徑上的祖先節點（用來判循環）。
    // done：已經處理完的節點（共享子圖第二次碰到就跳過）。
    const onPath = new WeakSet<object>();
    const done = new WeakSet<object>();
    const stack: Array<{ node: object; path: BackupObjectPath }> = [{ node: root as object, path: [] }];

    // 處理一個屬性/元素：data:image 字符串原地換成路徑，對象/數組入棧續遍歷，
    // 碰到還在當前路徑上的節點（回邊）即循環引用，拋錯。定義一次，不在循環裡反覆重建。
    const visit = (container: any, key: string | number, v: unknown, parentPath: BackupObjectPath) => {
        const path = [...parentPath, key];
        if (typeof v === 'string') {
            if (v.startsWith('data:image/')) container[key] = resolveImage(v, path);
        } else if (v !== null && typeof v === 'object') {
            if (onPath.has(v as object)) throw new Error('備份數據存在循環引用，無法導出');
            if (!done.has(v as object)) stack.push({ node: v as object, path });
        }
    };

    while (stack.length) {
        // peek 而不是 pop：第一次見到這個節點時入棧它的孩子並留著自己當「出棧標記」，
        // 等孩子都處理完再次輪到它時，把它移出 onPath、記為 done。
        const frame = stack[stack.length - 1];
        const { node, path } = frame;
        if (done.has(node)) { stack.pop(); continue; }
        if (onPath.has(node)) {
            stack.pop();
            onPath.delete(node);
            done.add(node);
            continue;
        }
        onPath.add(node);

        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) visit(node, i, node[i], path);
        } else {
            const obj = node as Record<string, unknown>;
            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) visit(obj, key, obj[key], path);
            }
        }
    }
}

export type BackupMalformedImageReason = 'empty-content' | 'invalid-characters-or-padding' | 'invalid-length';

export type BackupImageDataUrlParseResult =
    | { ok: true; extension: string; base64: string }
    | { ok: false; reason: 'unsupported-header' | BackupMalformedImageReason };

export type MalformedBackupImageDiagnostic = {
    location: string;
    reason: BackupMalformedImageReason;
    originalLength: number;
};

/**
 * 生成隨備份攜帶的輕量壞圖診斷。只記錄定位信息，不復制壞 Base64 正文，避免把
 * 無法恢復的髒數據繼續帶到新設備，同時也不會讓診斷文件本身顯著增大備份體積。
 */
export function buildMalformedImageDiagnostics(options: {
    createdAt: string;
    mode: 'text_only' | 'media_only' | 'full';
    total: number;
    items: MalformedBackupImageDiagnostic[];
}) {
    const items = options.items.map(item => ({ ...item }));
    return {
        format: 'sully-backup-malformed-images',
        version: 1 as const,
        createdAt: options.createdAt,
        mode: options.mode,
        total: options.total,
        included: items.length,
        truncated: options.total > items.length,
        note: '這些字段僅在導出副本中置空，原設備上的本地數據未被修改。',
        items,
    };
}

/**
 * 把舊數據裡的 data:image URL 拆成能安全交給 JSZip `{ base64: true }` 的正文。
 *
 * JSZip 的 base64 解碼是惰性的：`zip.file()` 不會報錯，直到最終 `generateAsync()`
 * 才拋 `Invalid base64 input, bad content length.`。因此不能靠包在 `file()` 外面的
 * try/catch 兜底，必須在素材進入 ZIP 隊列前完成與 JSZip 契約一致的校驗。
 */
export function parseImageDataUrlForBackup(value: string): BackupImageDataUrlParseResult {
    const match = value.match(/^data:image\/([a-zA-Z0-9]+);base64,([\s\S]*)$/i);
    if (!match) return { ok: false, reason: 'unsupported-header' };

    // FileReader 產出的 data URL 沒有空白；兼容少量經過換行排版的老數據，交給
    // JSZip 前統一去掉空白，避免校驗口徑和它內部的清洗口徑不一致。
    const base64 = match[2].replace(/\s/g, '');
    if (!base64) return { ok: false, reason: 'empty-content' };
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        return { ok: false, reason: 'invalid-characters-or-padding' };
    }
    if (base64.length % 4 !== 0) return { ok: false, reason: 'invalid-length' };

    return {
        ok: true,
        extension: match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase(),
        base64,
    };
}

/**
 * 給會被原地改的導出數據做一份獨立深拷貝。專門用在那些直接引用了運行態
 * React state 的值（theme / customIcons / appearancePresets）上，避免原地抽取
 * 素材時把正在用的系統主題等改壞。
 */
export function deepCloneForExport<T>(value: T): T {
    try {
        if (typeof structuredClone === 'function') return structuredClone(value);
    } catch {
        // 個別老 WebView 沒有 structuredClone 或克隆失敗，落到 JSON 兜底。
    }
    return JSON.parse(JSON.stringify(value));
}

/**
 * 手機端分片導出用的原始分片大小：3MiB，且能被 3 整除。
 *
 * 為什麼必須是 3 的倍數：base64 每 3 字節編碼成 4 個字符，正好填滿不帶 `=` 補位。
 * 只要每個非末尾分片的字節數是 3 的倍數，各分片各自 base64 後直接首尾相接，
 * 解碼回來就是原始字節；否則中間會插進 `=` 補位，拼起來再解碼就對不上了。
 */
export const EXPORT_CHUNK_SIZE = 3 * 1024 * 1024;

/** 把總字節長度切成一串連續的 [start, end) 區間，每段長 `chunkSize`（末段可短）。 */
export function sliceRanges(total: number, chunkSize: number): Array<[number, number]> {
    if (chunkSize <= 0) throw new Error('chunkSize must be positive');
    const ranges: Array<[number, number]> = [];
    for (let start = 0; start < total; start += chunkSize) {
        ranges.push([start, Math.min(start + chunkSize, total)]);
    }
    return ranges;
}
