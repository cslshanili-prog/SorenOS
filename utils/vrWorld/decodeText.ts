/**
 * 小說 txt 解碼 —— 不能寫死 UTF-8，也不能 UTF-8 失敗就一律當中文 GB18030。
 * 日文小說常見 Shift_JIS / EUC-JP，被 GB18030 解碼器"將就"解出來就是一堆亂碼。
 *
 * 策略：
 *   1. 先看 BOM（UTF-8 / UTF-16 LE / UTF-16 BE）—— 無歧義，直接定
 *   2. 用 fatal 模式試 UTF-8；能過就是 UTF-8
 *   3. 否則在候選編碼（GB18030 / Shift_JIS / EUC-JP / Big5）裡按"文本質量"打分挑最優
 *   4. 兜底 UTF-8 寬鬆模式
 *
 * 也支持手動指定編碼（forced）：自動識別判錯時，UI 可以讓用戶強制換一個。
 */

export interface DecodeResult {
    text: string;
    encoding: string;
}

/** 自動識別時參與評分的候選編碼。GB18030 放最前 —— 同分時優先（中文是主場景）。 */
const CANDIDATES = ['gb18030', 'shift_jis', 'euc-jp', 'big5'] as const;

/** 識別只取前若干字節做樣本，避免大文件（數 MB）反覆全量解碼拖慢上傳。 */
const SAMPLE_BYTES = 256 * 1024;

function tryDecode(buf: ArrayBuffer, enc: string): string | null {
    try {
        return new TextDecoder(enc).decode(buf);
    } catch {
        // 引擎不認識這個編碼 label
        return null;
    }
}

/**
 * 給一段解碼結果打分：越像"正常人類文本"分越高。
 * 核心：用錯編碼會大量產生替換符 U+FFFD、私用區字符、半角片假名亂碼；
 * 用對編碼則是連片的漢字 / 假名 / ASCII。
 */
function scoreText(s: string): number {
    let score = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 0xFFFD) { score -= 100; continue; }              // 解碼失敗的替換符：強懲罰
        if (c >= 0x3040 && c <= 0x30FF) { score += 4; continue; }  // 平/片假名：強日文信號
        if (c >= 0x4E00 && c <= 0x9FFF) { score += 1; continue; }  // CJK 漢字
        if (c >= 0x3000 && c <= 0x303F) { score += 1; continue; }  // CJK 標點（含全角空格）
        if (c >= 0xFF01 && c <= 0xFF5E) { score += 1; continue; }  // 全角 ASCII
        if (c >= 0xFF61 && c <= 0xFF9F) { score -= 1; continue; }  // 半角片假名：亂碼高發區，壓一壓
        if (c === 0x09 || c === 0x0A || c === 0x0D) { score += 1; continue; } // 製表/換行
        if (c >= 0x20 && c <= 0x7E) { score += 1; continue; }      // ASCII 可見字符
        if (c >= 0xE000 && c <= 0xF8FF) { score -= 20; continue; } // 私用區：幾乎一定是亂碼
        if (c < 0x20) { score -= 5; continue; }                    // 其它控制符
        score -= 0.3;                                               // 其餘生僻符號：輕微減分
    }
    return score;
}

/** 在候選編碼裡按文本質量挑一個。GB18030 同分優先（數組順序 + 嚴格大於）。 */
function detectEncoding(buf: ArrayBuffer): string {
    const sample = buf.byteLength > SAMPLE_BYTES ? buf.slice(0, SAMPLE_BYTES) : buf;
    let best = 'gb18030';
    let bestScore = -Infinity;
    for (const enc of CANDIDATES) {
        const t = tryDecode(sample, enc);
        if (t == null) continue;
        const sc = scoreText(t);
        if (sc > bestScore) {
            bestScore = sc;
            best = enc;
        }
    }
    return best;
}

/**
 * 解碼字節流為文本。
 * @param buf    原始字節
 * @param forced 手動指定編碼（如 'utf-8' / 'shift_jis'）。傳了就直接用，識別失敗再回退自動。
 */
export function decodeBytes(buf: ArrayBuffer, forced?: string): DecodeResult {
    const bytes = new Uint8Array(buf);

    // 手動指定：優先按用戶選的來
    if (forced) {
        const t = tryDecode(buf, forced);
        if (t != null) return { text: t, encoding: forced };
        // 本引擎不認識這個 label → 落到下面的自動識別
    }

    // BOM（無歧義）
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        return { text: new TextDecoder('utf-8').decode(buf), encoding: 'utf-8' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
        return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'utf-16le' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
        return { text: new TextDecoder('utf-16be').decode(buf), encoding: 'utf-16be' };
    }

    // 嚴格 UTF-8：非法字節序列會拋錯 → 說明不是 UTF-8
    try {
        const t = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        return { text: t, encoding: 'utf-8' };
    } catch {
        /* not utf-8 */
    }

    // 非 UTF-8：在候選編碼裡挑文本質量最高的（區分中文 GB18030 / 日文 Shift_JIS·EUC-JP / 繁體 Big5）
    const enc = detectEncoding(buf);
    const t = tryDecode(buf, enc);
    if (t != null) return { text: t, encoding: enc };

    // 兜底：寬鬆 UTF-8
    return { text: new TextDecoder('utf-8').decode(buf), encoding: 'utf-8?' };
}

/** 直接解碼一個 File（讀 ArrayBuffer + 識別編碼）。 */
export async function decodeTextFile(file: File, forced?: string): Promise<DecodeResult> {
    const buf = await file.arrayBuffer();
    return decodeBytes(buf, forced);
}
