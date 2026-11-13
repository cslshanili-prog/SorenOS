/**
 * 鎖臉強度（plans/face-lock-strength.md）：帶參考圖時要多像參考圖。
 *
 * - 兩檔：平衡（預設，只對長相、畫法照畫風）、還原（盡量像參考圖，畫風可能被帶走）。
 * - 提示詞：`[參考圖約束]` 那段照檔位換。
 * - GPT-Image 的還原多送 `input_fidelity: high`；中轉站報錯就拿掉重送，並記在這台裝置（照網址＋模型），之後不再送。
 *   收了卻沒傳下去的我們看不出來，所以畫面上只說「有送參數」，不說「已調強度」。
 */
import type { FaceLockLevel } from '../types';

export type { FaceLockLevel };

export const DEFAULT_FACE_LOCK: FaceLockLevel = 'balanced';

export const FACE_LOCK_LEVELS: Array<{ key: FaceLockLevel; label: string; hint: string }> = [
    { key: 'balanced', label: '平衡', hint: '只對長相（臉型、五官、髮型髮色），畫法、質感、光線照畫風' },
    { key: 'exact', label: '還原', hint: '盡量像參考圖裡的人，畫風可能被參考圖帶走' },
];

export const faceLockLabel = (level: FaceLockLevel) => FACE_LOCK_LEVELS.find(l => l.key === level)?.label || '平衡';

/** 角色／身份卡的檔位（沒設＝平衡） */
export const faceLockOf = (cfg?: { faceLock?: FaceLockLevel } | null): FaceLockLevel => (cfg?.faceLock === 'exact' ? 'exact' : DEFAULT_FACE_LOCK);

/** 合照：參數只能送一個值，照最強的那個人 */
export const strongestFaceLock = (levels: Array<FaceLockLevel | undefined>): FaceLockLevel =>
    (levels.includes('exact') ? 'exact' : DEFAULT_FACE_LOCK);

/** 換掉提示詞最後那段 `[參考圖約束]`；count＞1 是合照（依序對應參考圖） */
export const faceLockReferencePrompt = (level: FaceLockLevel, count = 1): string => {
    const multi = count > 1;
    if (level === 'exact') {
        return multi
            ? '[參考圖約束] 畫面裡的人依序對應所附的參考圖（第 1 張、第 2 張……），每個人的臉型、五官比例、膚色、髮型都要與自己那張參考圖保持高度一致，不要互換、不要更改容貌特徵；只按提示詞調整場景、姿勢、服裝、表情等其餘部分。'
            : '[參考圖約束] 人物的臉型、五官比例、膚色、髮型需與所附參考圖保持高度一致，不要更改容貌特徵；只按提示詞調整場景、姿勢、服裝、表情等其餘部分。';
    }
    return multi
        ? '[參考圖約束] 畫面裡的人依序對應所附的參考圖（第 1 張、第 2 張……），不要互換。參考圖只用來對長相：每個人的臉型、五官比例、髮型髮色要認得出是自己那張參考圖裡的人；畫法、質感、膚質、光線、色調照提示詞寫的風格，不要照抄參考圖的畫風或照片質感。場景、姿勢、服裝、表情照提示詞。'
        : '[參考圖約束] 參考圖只用來對長相：人物的臉型、五官比例、髮型髮色要認得出是參考圖裡的人；畫法、質感、膚質、光線、色調照提示詞寫的風格，不要照抄參考圖的畫風或照片質感。場景、姿勢、服裝、表情照提示詞。';
};

// ─── input_fidelity（只有 GPT-Image 系列有） ───

export const modelTakesInputFidelity = (model?: string) => /gpt-image/i.test(model || '');

const UNSUPPORTED_KEY = 'soren-input-fidelity-unsupported-v1';
const apiKeyOf = (baseUrl: string, model: string) => `${(baseUrl || '').replace(/\/+$/, '').toLowerCase()}|${(model || '').toLowerCase()}`;

const readUnsupported = (): string[] => {
    try {
        const raw = localStorage.getItem(UNSUPPORTED_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
};
const writeUnsupported = (list: string[]) => {
    try { localStorage.setItem(UNSUPPORTED_KEY, JSON.stringify(list.slice(-50))); } catch { /* 存不了就每次都試，頂多多打一次 */ }
};

/** 這組（網址＋模型）之前送了報錯、拿掉就成功：記成不收 */
export const isInputFidelityUnsupported = (baseUrl: string, model: string) => readUnsupported().includes(apiKeyOf(baseUrl, model));
export const markInputFidelityUnsupported = (baseUrl: string, model: string) => {
    const key = apiKeyOf(baseUrl, model);
    const list = readUnsupported();
    if (!list.includes(key)) writeUnsupported([...list, key]);
};
export const clearInputFidelityUnsupported = (baseUrl: string, model: string) => {
    const key = apiKeyOf(baseUrl, model);
    writeUnsupported(readUnsupported().filter(k => k !== key));
};

/** 這次要不要送 input_fidelity：還原、GPT-Image、沒被手動關掉、沒被記成不收 */
export const inputFidelityFor = (level: FaceLockLevel, api: { baseUrl?: string; model?: string; inputFidelity?: 'off' }): 'high' | undefined => {
    if (level !== 'exact' || api.inputFidelity === 'off' || !modelTakesInputFidelity(api.model)) return undefined;
    if (isInputFidelityUnsupported(api.baseUrl || '', api.model || '')) return undefined;
    return 'high';
};

/** 給人看的一行：鎖臉用哪檔、有沒有送參數 */
export const describeFaceLock = (level: FaceLockLevel, fidelitySent?: boolean) =>
    `鎖臉：${faceLockLabel(level)}${level === 'exact' ? (fidelitySent ? '（有送強度參數）' : '（只用提示詞）') : ''}`;
