/**
 * 見面 · 觀測協議 OBSERVE（docs/date-observe.md）。
 *
 * 開著時讓模型在每則回覆最前面吐一段定界的觀測塊（時間／地點／狀態／細節＋自訂維度），
 * 前端從正文剝出來顯示成觀測卡片；落庫的正文保留原塊，回看時重新解析。
 *
 * 只在「內建規則」下生效：用自訂預設時由預設自己決定要不要狀態欄（isObserveActive）。
 * 不論開不開，顯示時都先剝掉舊訊息裡殘留的觀測塊，免得原文露出來。
 *
 * 2026-11 #113 拿掉過一次，後來改回成開關；解析與 HUD 原樣搬回，提示詞改接散文格式。
 */

import type { CharacterProfile, DateObservation, DateObserveConfig, DateObserveCustomField } from '../types';

// ─────────────────────────────────────────────────────────────
// 觀測協議 OBSERVE（全方位觀察 char：時間 / 地點 / 狀態 / 細節）
//
// 開啟後，讓模型在「正文最前面」吐一段定界的結構化觀測塊，前端 extractObservation
// 把它從正文裡剝出來渲染成觀測卡片（點開是全息 HUD），剩下的正文照常顯示。
// 定界符用不常見的 ⟦⟧，避免和台詞引號、英文語氣標籤 [softly] 撞車。
// 字段標籤固定中文 + 全角豎線，解析時對中英 key、半角豎線、冒號都容錯。
// ─────────────────────────────────────────────────────────────

export const OBSERVE_OPEN = '⟦OBSERVE⟧';
export const OBSERVE_CLOSE = '⟦/OBSERVE⟧';

// ── 容錯正則：模型掉格式時儘量還原，分兩層（嚴格定界 + 寬鬆回退）─────────
// 各種括號風格：⟦⟧ 【】〔〕「」『』 [] () <> ，都收。關鍵字接受 OBSERVE / 觀測 / 觀測協議。
const BRA = '[\\[\\(<⟦【〔「『]';
const KET = '[\\]\\)>⟧】〕」』]';
const OBSERVE_KW = '(?:OBSERVE|觀測協議|觀測)';

/** 嚴格：成對定界塊（含 ⟦OBSERVE⟧ … ⟦/OBSERVE⟧，容忍括號風格/空格/大小寫）。有定界符即視為明確意圖。 */
const OBSERVE_BLOCK_RE = new RegExp(`${BRA}\\s*${OBSERVE_KW}\\s*${KET}([\\s\\S]*?)${BRA}\\s*/\\s*${OBSERVE_KW}\\s*${KET}`, 'i');

/** 整行只是一個定界標記（開/閉都算）——回退掃描時用來跳過孤立的標記行 */
const OBSERVE_MARKER_LINE_RE = new RegExp(`^\\s*${BRA}?\\s*/?\\s*${OBSERVE_KW}\\s*/?\\s*${KET}?\\s*$`, 'i');
const isObserveMarkerLine = (line: string): boolean => OBSERVE_MARKER_LINE_RE.test(line.trim());

/** 單條字段行：容忍 markdown 列表符 / 加粗 / 中英 key / 全半角豎線 / 中英冒號 */
const OBSERVE_FIELD_RE = /^\s*(?:[-*>•·]\s*)?\*{0,2}\s*([时時][间間]|地[点點]|地[区區]|[场場]所|位置|[状狀][态態]|心境|情[绪緒]|[细細][节節]|[动動]作|[举舉][动動]|time|place|location|site|position|status|state|mood|detail|trace|action)\s*\*{0,2}\s*[｜|:：]\s*(.+?)\s*$/i;

/** 默認四維的 key（不含 extra） */
type ObserveDefaultKey = 'time' | 'place' | 'state' | 'detail';

/** 把 key 歸一到四個維度之一 */
const mapObserveKey = (key: string): ObserveDefaultKey | null => {
    const k = key.toLowerCase();
    if (/[时時][间間]|time/.test(k)) return 'time';
    if (/地[点點]|地[区區]|[场場]所|位置|place|location|site|position/.test(k)) return 'place';
    if (/[状狀][态態]|心境|情[绪緒]|status|state|mood/.test(k)) return 'state';
    if (/[细細][节節]|[动動]作|[举舉][动動]|detail|trace|action/.test(k)) return 'detail';
    return null;
};

/** 清洗字段值：去掉殘留的定界標記、外層括號、加粗星號 */
const cleanObserveValue = (raw: string): string => {
    let v = raw.trim();
    v = v.replace(new RegExp(`${BRA}\\s*/?\\s*${OBSERVE_KW}\\s*/?\\s*${KET}`, 'gi'), ''); // 內聯殘留標記
    v = v.replace(/^\*{1,2}|\*{1,2}$/g, '').trim();   // 外層加粗
    v = v.replace(/^（\s*|\s*）$/g, '').trim();        // 全角括號包裹
    v = v.replace(/^\(\s*|\s*\)$/g, '').trim();        // 半角括號包裹
    return v.trim();
};

/** 用戶開了觀測（設定頁的開關） */
export const isObserveOn = (char: Pick<CharacterProfile, 'dateObserve'>): boolean => char.dateObserve?.enabled === true;

/** 這一輪真的要觀測：開了，而且角色用的是內建規則（選了自訂預設就由預設自己決定） */
export const isObserveActive = (char: Pick<CharacterProfile, 'dateObserve'>, usingCustomPreset: boolean): boolean =>
    !usingCustomPreset && isObserveOn(char);

/**
 * 觀測協議四個默認維度。`label` 是注入提示詞時的**固定線格式字段名**（解析靠它，
 * 不隨用戶自定義改動），`en`/`glyph` 給 HUD 用，`hint` 是默認生成提示（可被
 * char.dateObserve.fields[key].hint 覆蓋；`{name}` 會替換成角色名）。
 */
export interface ObserveDimension {
    key: keyof DateObservation;
    label: string;   // 線格式字段名（時間/地點/狀態/細節），解析依賴，勿改
    en: string;      // HUD 上的英文小標
    glyph: string;   // HUD 上的字形符號
    hint: string;    // 默認生成提示
}

export const OBSERVE_DIMENSIONS: ObserveDimension[] = [
    { key: 'time',   label: '時間', en: 'TIME',  glyph: '◷', hint: '結合場景的當下時刻，可比系統時間更具體，如"傍晚六點過，天剛擦黑"' },
    { key: 'place',  label: '地點', en: 'SITE',  glyph: '⌖', hint: '{name}此刻所在的具體地點與環境' },
    { key: 'state',  label: '狀態', en: 'STATE', glyph: '❖', hint: '{name}的身心狀態：情緒、體感、正在經歷的內在波動' },
    { key: 'detail', label: '細節', en: 'TRACE', glyph: '✶', hint: '此刻最值得被注意的一個動作 / 微小細節' },
];

/** 自定義維度在 HUD 上輪換用的字形 */
const CUSTOM_GLYPHS = ['✦', '◆', '❂', '✺', '⬡', '◈'];

/** HUD / 設置面板 / 提示詞共用：合併默認四維 + 用戶自定義維度，過濾禁用 / 空標籤的。 */
export interface ResolvedObserveField {
    key: string;       // 默認維度的 key（time/place/...）或自定義維度的 id
    label: string;     // 線格式字段名（默認維度用固定中文 key；自定義用其 label）
    display: string;   // HUD 展示標籤（默認維度可自定義；自定義維度即 label）
    en: string;
    glyph: string;
    hint: string;
    isCustom: boolean;
}
export const resolveObserveFields = (config?: DateObserveConfig, charName = ''): ResolvedObserveField[] => {
    const cfg = config?.fields || {};
    const base: ResolvedObserveField[] = OBSERVE_DIMENSIONS
        .filter(d => cfg[d.key]?.enabled !== false)
        .map(d => ({
            key: d.key,
            label: d.label,
            display: (cfg[d.key]?.label || '').trim() || d.label,
            en: d.en,
            glyph: d.glyph,
            hint: ((cfg[d.key]?.hint || '').trim() || d.hint).replace(/\{name\}/g, charName),
            isCustom: false,
        }));
    const custom: ResolvedObserveField[] = (config?.custom || [])
        .filter(c => c.enabled !== false && (c.label || '').trim())
        .map((c, i) => ({
            key: c.id,
            label: c.label.trim(),
            display: c.label.trim(),
            en: 'NOTE',
            glyph: CUSTOM_GLYPHS[i % CUSTOM_GLYPHS.length],
            hint: ((c.hint || '').trim() || `觀察並描寫「${c.label.trim()}」`).replace(/\{name\}/g, charName),
            isCustom: true,
        }));
    return [...base, ...custom];
};

/**
 * 觀測塊提示詞。僅在開關打開時注入；放在散文塊末尾（場景上下文之後）。
 * 線格式字段名固定用默認 label（保證解析穩定），但每項「生成什麼」用角色自定義 hint。
 * 全部維度被用戶關掉時返回空串（等於不注入觀測塊）。
 */
export const buildObserveBlock = (char: CharacterProfile): string => {
    const fields = resolveObserveFields(char.dateObserve, char.name);
    if (fields.length === 0) return '';
    const lines = fields.map(f => `${f.label}｜（${f.hint}）`).join('\n');
    return `
### 👁 觀測協議（OBSERVE，必須嚴格執行）
在你**整段回覆的最前面**，先輸出一段「觀測塊」，用來讓用戶全方位觀察${char.name}此刻的狀態。
觀測塊**不受**上面「格式」那幾條約束——它是獨立的元信息，不算正文；緊接著才是正常的散文正文。

格式**必須**逐字如下（每個字段都要給，每項一句話、簡潔有畫面，別寫成大段）：
${OBSERVE_OPEN}
${lines}
${OBSERVE_CLOSE}

硬性要求：
- 開頭那行 \`${OBSERVE_OPEN}\` 和結尾那行 \`${OBSERVE_CLOSE}\` **兩行定界符都必須原樣保留**，各自單獨佔一行，哪怕你不確定也別省略。
- 每個字段各佔一行，用全角豎線 \`｜\` 分隔標籤和內容；標籤必須原樣用 ${fields.map(f => `「${f.label}」`).join('、')}，不要加序號、不要用 markdown 加粗。
- 觀測塊只在整段回覆的最開頭出現一次，輸出完**另起一行**再照上面的格式寫正文。`;
};

/**
 * 從模型輸出裡剝出觀測塊。返回結構化數據 + 去掉觀測塊後的正文。
 *
 * 魯棒性分兩層（針對模型掉格式）：
 *  1) 嚴格層：成對定界塊（含各種括號風格 / OBSERVE|觀測 關鍵字）。有定界符 = 明確意圖，
 *     哪怕只有一個字段也認。這一層永遠開，不會誤傷普通正文。
 *  2) 回退層（lenient）：模型丟了閉合標記、換了標記、甚至完全沒標記，只在開頭堆了
 *     "時間｜… 地點｜…" 這種字段行——就從開頭連續掃字段行，**至少命中 2 個不同維度**
 *     才認（避免把正文裡偶發的"狀態：…"誤當觀測）。僅在開關打開時傳 lenient=true。
 */
export const extractObservation = (
    text: string,
    opts: { lenient?: boolean; custom?: DateObserveCustomField[] } = {},
): { observation: DateObservation | null; rest: string } => {
    if (!text) return { observation: null, rest: text };

    const customFields = (opts.custom || []).filter(c => c.enabled !== false && (c.label || '').trim());

    // ── 嚴格層：成對定界塊 ──
    const m = text.match(OBSERVE_BLOCK_RE);
    if (m && m.index !== undefined) {
        const observation = parseObserveBody(m[1], customFields);
        if (hasObservation(observation)) {
            const rest = stripStrayMarkers(text.slice(0, m.index) + text.slice(m.index + m[0].length));
            return { observation, rest };
        }
    }

    // ── 回退層：僅在開關開時啟用，掃開頭的連續字段行 ──
    if (opts.lenient) {
        const fallback = scanLeadingFields(text, customFields);
        if (fallback) return fallback;
    }

    return { observation: null, rest: text };
};

/** 通用字段行（任意短 key｜value），用於匹配自定義維度的 label */
const OBSERVE_ANYLINE_RE = /^\s*(?:[-*>•·]\s*)?\*{0,2}\s*([^｜|:：*\n]{1,16}?)\s*\*{0,2}\s*[｜|:：]\s*(.+?)\s*$/;

/** 試著把一行匹配成某個自定義維度（按 label 精確匹配，大小寫/空格不敏感） */
const matchCustomField = (line: string, customFields: DateObserveCustomField[]): { id: string; value: string } | null => {
    if (!customFields.length) return null;
    const mm = line.match(OBSERVE_ANYLINE_RE);
    if (!mm) return null;
    const k = mm[1].trim().toLowerCase();
    const cf = customFields.find(c => c.label.trim().toLowerCase() === k);
    if (!cf) return null;
    return { id: cf.id, value: cleanObserveValue(mm[2]) };
};

const setCustomValue = (obs: DateObservation, id: string, val: string): void => {
    if (!val) return;
    obs.extra = obs.extra || {};
    if (!obs.extra[id]) obs.extra[id] = val;
};

/** 統計觀測命中了幾個不同維度（默認四維 + 自定義），回退層用於 ≥2 門檻 */
const countObserveDims = (obs: DateObservation): number =>
    (obs.time ? 1 : 0) + (obs.place ? 1 : 0) + (obs.state ? 1 : 0) + (obs.detail ? 1 : 0) + Object.keys(obs.extra || {}).length;

/** 塊體逐行解析（嚴格層用，塊內字段無歧義，不設 2 個門檻） */
const parseObserveBody = (body: string, customFields: DateObserveCustomField[] = []): DateObservation => {
    const obs: DateObservation = {};
    for (const raw of body.split('\n')) {
        const mm = raw.match(OBSERVE_FIELD_RE);
        if (mm) {
            const key = mapObserveKey(mm[1]);
            const val = cleanObserveValue(mm[2]);
            if (key && val && !obs[key]) obs[key] = val;
            continue;
        }
        const cf = matchCustomField(raw, customFields);
        if (cf) setCustomValue(obs, cf.id, cf.value);
    }
    return obs;
};

/**
 * 回退掃描：跳過開頭的空行/孤立標記行，連續吃字段行，遇到第一行"非字段非標記非空"的
 * 內容（正文/台詞/[emotion] 行）即停。命中 ≥2 個不同維度才算數。
 */
const scanLeadingFields = (text: string, customFields: DateObserveCustomField[] = []): { observation: DateObservation; rest: string } | null => {
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;          // 跳開頭空行
    if (i < lines.length && isObserveMarkerLine(lines[i])) i++; // 跳一行孤立開標記
    const obs: DateObservation = {};
    let lastConsumed = i - 1;
    const maxScan = i + 12; // 只看開頭一小段，絕不深入正文
    for (let j = i; j < lines.length && j < maxScan; j++) {
        const t = lines[j].trim();
        if (!t) { continue; }                       // 字段間空行：跳過但不推進 lastConsumed
        if (isObserveMarkerLine(lines[j])) { lastConsumed = j; continue; } // 閉合/重複標記
        const mm = t.match(OBSERVE_FIELD_RE);
        if (mm) {
            const key = mapObserveKey(mm[1]);
            const val = cleanObserveValue(mm[2]);
            if (key && val && !obs[key]) obs[key] = val;
            lastConsumed = j;
            continue;
        }
        const cf = matchCustomField(t, customFields);
        if (!cf) break;                             // 正文開始
        setCustomValue(obs, cf.id, cf.value);
        lastConsumed = j;
    }
    if (countObserveDims(obs) < 2) return null;
    const rest = lines.slice(lastConsumed + 1).join('\n').trim();
    return { observation: obs, rest };
};

/** 去掉正文裡殘留的孤立定界標記行（嚴格層剝塊後可能留下空標記/代碼圍欄） */
const stripStrayMarkers = (text: string): string =>
    text
        .split('\n')
        .filter(line => !isObserveMarkerLine(line) && !/^\s*```/.test(line))
        .join('\n')
        .trim();

/** 只去觀測塊、不要結構化數據時用（novel 模式渲染歷史正文） */
export const stripObservation = (text: string, opts?: { lenient?: boolean }): string =>
    extractObservation(text, opts).rest || (text || '');

/** HUD / 持久化判定：任一默認維度或自定義維度非空才算有效觀測 */
export const hasObservation = (obs: DateObservation | null | undefined): obs is DateObservation =>
    !!obs && !!(obs.time || obs.place || obs.state || obs.detail || (obs.extra && Object.keys(obs.extra).length > 0));
