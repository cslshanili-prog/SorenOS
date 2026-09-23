/**
 * 手帳生成器
 *
 * 兩個獨立管線 (NOT 複用 daily_schedule 的 flowNarrative —— 那個會被覆蓋且和 user 強耦合)：
 *
 * 1. generateUserDiaryPage —— 主體
 *    給 LLM 喂 user 當日所有跨角色聊天，讓 ta 用第一人稱、碎片日記體替 user 寫一份草稿。
 *    user 會二次編輯，所以不強求模仿語氣，只追求"事實可讀、留白真實"。
 *
 * 2. generateLifestreamPage —— 陪伴頁（僅 lifestyle 角色）
 *    單獨調一次 LLM 生成"角色今天的小生活"短文，存進當日 handbook entry。
 *    硬性約束：不準 AI 捧場、不準等/想 user 當主語，user 至多一帶而過。
 *    mindful 角色不進此管線（ta 們沒有"小生活"可寫）。
 */

import {
    CharacterProfile, UserProfile, Message,
    HandbookPage, HandbookFragment, HandbookLayout, LayoutPlacement, LayoutRole,
} from '../types';
import { DB } from './db';
import { loadCharacterContextMessages } from './chatContextRange';
import { safeResponseJson, extractJson } from './safeApi';
import { ContextBuilder } from './context';
import { getLocalDayRange } from './localDate';

// 局部 seedFloat — composePageLayout 用 (不引用 components/ 避免 utils → components 反向依賴).
// FNV-1a + xorshift, 與 paper.tsx 裡同名函數行為一致.
function seedFloat(seed: string, salt: number = 0): number {
    let h = ((salt | 0) + 0x811c9dc5) >>> 0;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995) >>> 0;
    h ^= h >>> 15;
    return (h >>> 0) / 0x100000000;
}

interface ApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

// ─── 工具：把 LLM 輸出的 JSON 數組解析成 HandbookFragment[] ─
function parseFragmentsFromLLMOutput(raw: string): HandbookFragment[] {
    let s = raw.trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    let parsed: any = null;
    try {
        parsed = JSON.parse(s);
    } catch {
        // extractJson 兜底:從亂七八糟裡掏 JSON
        try { parsed = extractJson(s); } catch {}
    }
    if (!parsed || !Array.isArray(parsed)) return [];
    return parsed
        .map((item: any, i: number): HandbookFragment | null => {
            if (typeof item === 'string') {
                return { id: `frag-${Date.now()}-${i}`, text: item.trim() };
            }
            if (item && typeof item === 'object') {
                const text = typeof item.text === 'string' ? item.text.trim()
                           : typeof item.content === 'string' ? item.content.trim()
                           : '';
                if (!text) return null;
                const time = typeof item.time === 'string' ? item.time.trim()
                           : typeof item.timeHint === 'string' ? item.timeHint.trim()
                           : undefined;
                return { id: `frag-${Date.now()}-${i}`, text, time };
            }
            return null;
        })
        .filter((f): f is HandbookFragment => !!f && f.text.length > 1);
}

// 把 fragments 拼成可讀的 plain text(存 content 字段,user 編輯/兜底用)
function fragmentsToPlainText(fragments: HandbookFragment[]): string {
    return fragments.map(f => f.time ? `[${f.time}] ${f.text}` : f.text).join('\n\n');
}

// ─── 工具：取一天範圍 [start, end) 的 ms ───
function dayRange(date: string): { start: number; end: number } {
    return getLocalDayRange(date) || { start: 0, end: 0 };
}

// 把單條消息渲染成一行文本，截掉過長內容；過濾系統/工具/隱藏內容
function renderMsgLine(m: Message, userName: string, charName: string): string | null {
    if (m.role === 'system') return null;
    if (!m.content || typeof m.content !== 'string') return null;
    const raw = m.content.trim();
    if (!raw) return null;
    // 過濾純結構化的 JSON / 系統消息（啟發式）
    if (raw.startsWith('{') && raw.endsWith('}') && raw.length > 50 && /"\w+"\s*:/.test(raw)) {
        return null;
    }
    const speaker = m.role === 'user' ? userName : charName;
    const text = raw.length > 220 ? raw.slice(0, 220) + '…' : raw;
    return `${speaker}: ${text}`;
}

// 取 user 當日和某角色的對話片段（按時間升序）
async function getTodayChatLines(
    char: CharacterProfile,
    date: string,
    userName: string,
): Promise<{ lines: string[]; userMsgCount: number }> {
    const { start, end } = dayRange(date);
    // includeProcessed=true 繞過記憶宮殿水位線，拿到 raw 數據
    const all = await DB.getMessagesByCharId(char.id, true);
    const today = all
        .filter(m => m.timestamp >= start && m.timestamp < end)
        .sort((a, b) => a.timestamp - b.timestamp);
    const lines: string[] = [];
    let userMsgCount = 0;
    for (const m of today) {
        const line = renderMsgLine(m, userName, char.name);
        if (line) {
            lines.push(line);
            if (m.role === 'user') userMsgCount++;
        }
    }
    return { lines, userMsgCount };
}

// ─── 共用: 估高 / 佔位渲染 / turn 輸出解析 ───────────────

const PAGE_W_DEFAULT = 360;
const PAGE_H_DEFAULT = 720;

/** 估計一張卡片的高度(% of page);chars + widthPct → est lines → est px → est %. */
export function estHeightPctFromChars(chars: number, widthPct: number, pageHeight: number = PAGE_H_DEFAULT, role: 'main' | 'side' | 'corner' | 'margin' = 'main'): number {
    const charsPerLine = Math.max(8, Math.floor(widthPct * 0.16));
    const lines = Math.max(1, Math.ceil(chars / charsPerLine));
    const base = role === 'margin' ? 4 : role === 'corner' ? 6 : 9;
    return Math.min(60, lines * 3.4 + base);
}

function renderOccupiedBlock(occupied: PlacementHint[]): string {
    if (occupied.length === 0) {
        return `【佔用情況】紙還是空的, 你怎麼擺都行 (但留出頁眉 yPct < 8 給日期, 頁腳 yPct > 88 給頁碼).`;
    }
    const byPage: Record<number, PlacementHint[]> = {};
    for (const o of occupied) {
        const k = o.pageNumber;
        if (!byPage[k]) byPage[k] = [];
        byPage[k].push(o);
    }
    const lines: string[] = [`【已被佔用 — 你必須避開這些區域, 留 ≥ 3% 間距】`];
    for (const k of Object.keys(byPage).sort()) {
        const items = byPage[Number(k)];
        lines.push(`page ${k}:`);
        for (const o of items) {
            const x2 = (o.xPct + o.widthPct).toFixed(0);
            const y2 = (o.yPct + o.estHeightPct).toFixed(0);
            const preview = o.textPreview.length > 28 ? o.textPreview.slice(0, 28) + '…' : o.textPreview;
            lines.push(`  - bbox(${o.xPct.toFixed(0)},${o.yPct.toFixed(0)})~(${x2},${y2}) by ${o.author}: ${preview.replace(/\n/g, ' ')}`);
        }
    }
    return lines.join('\n');
}

/** 一片輪迴的輸出 — placement 比 LayoutPlacement 多帶 pageNumber, 用來分組到不同 HandbookLayout */
export interface PlacedPiece extends LayoutPlacement {
    pageNumber: number;
}

interface TurnOutputParsed {
    fragments: HandbookFragment[];
    placements: PlacedPiece[];
}

/** 解析 LLM 一次輸出 — 它的 JSON 數組裡每條同時含 text+time+page+xPct+yPct+widthPct+role */
function parseTurnOutput(raw: string, pageId: string, occupied: PlacementHint[]): TurnOutputParsed {
    const stripped = raw.trim()
        .replace(/^```(?:json|JSON)?\s*\n?/gm, '')
        .replace(/\n?```\s*$/gm, '')
        .trim();
    let parsed: any;
    try { parsed = JSON.parse(stripped); }
    catch { try { parsed = extractJson(stripped); } catch { parsed = null; } }

    if (!parsed) return { fragments: [], placements: [] };
    // 兼容: { items: [...] } / { fragments: [...] } / [ ... ]
    let arr: any[] = [];
    if (Array.isArray(parsed)) arr = parsed;
    else if (Array.isArray(parsed.items)) arr = parsed.items;
    else if (Array.isArray(parsed.fragments)) arr = parsed.fragments;
    else if (Array.isArray(parsed.placements)) arr = parsed.placements;
    else {
        for (const v of Object.values(parsed)) {
            if (Array.isArray(v) && v.length > 0) { arr = v; break; }
        }
    }
    if (arr.length === 0) return { fragments: [], placements: [] };

    const clamp = (n: any, lo: number, hi: number) => {
        const v = Number(n);
        if (!Number.isFinite(v)) return (lo + hi) / 2;
        return Math.max(lo, Math.min(hi, v));
    };
    const normalizeRole = (r: any): LayoutRole => {
        const s = String(r ?? '').toLowerCase().trim();
        if (s.startsWith('main') || s === 'center' || s === 'body') return 'main';
        if (s.startsWith('side')) return 'side';
        if (s.startsWith('corner')) return 'corner';
        if (s.startsWith('margin') || s === 'edge') return 'margin';
        return 'main';
    };

    const fragments: HandbookFragment[] = [];
    const placements: PlacedPiece[] = [];

    arr.forEach((item, i) => {
        if (!item || typeof item !== 'object') return;
        const text = typeof item.text === 'string' ? item.text.trim()
                   : typeof item.content === 'string' ? item.content.trim()
                   : '';
        if (!text || text.length < 1) return;
        const time = typeof item.time === 'string' && item.time.trim() ? item.time.trim() : undefined;
        const fragmentId = `frag-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`;
        fragments.push({ id: fragmentId, text, time });

        const role = normalizeRole(item.role ?? item.kind ?? item.slot);
        const widthPct = clamp(item.widthPct ?? item.width ?? item.w ?? 50, 18, 92);
        const pageNumberRaw = item.page ?? item.pageNumber ?? item.pageNum ?? 1;
        const pageNumber = Math.max(1, Math.min(2, Math.round(Number(pageNumberRaw)) || 1));
        const placement: PlacedPiece = {
            pageId,
            fragmentId,
            xPct: clamp(item.xPct ?? item.x ?? item.left ?? 5, 0, 92),
            yPct: clamp(item.yPct ?? item.y ?? item.top ?? 5, 0, 92),
            widthPct,
            rotate: clamp(item.rotate ?? item.rotation ?? 0, -15, 15),
            zIndex: 10 + i,
            role,
            pageNumber,
        };
        placements.push(placement);
    });

    // 客戶端兜底:有的 LLM 還是會和 occupied 撞 → 把撞的往下推
    nudgeAwayFromOccupied(placements, occupied, fragments);

    return { fragments, placements };
}

/** 把和 occupied 撞或彼此撞的 placement 向下推; 不造內容只挪位置 */
function nudgeAwayFromOccupied(
    placements: PlacedPiece[],
    occupied: PlacementHint[],
    fragments: HandbookFragment[],
): void {
    type Box = { x1: number; y1: number; x2: number; y2: number; page: number };
    const PAD = 1.5;
    const intersect = (a: Box, b: Box) =>
        a.page === b.page &&
        !(a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1);

    const occBoxes: Box[] = occupied.map(o => ({
        x1: o.xPct - PAD, y1: o.yPct - PAD,
        x2: o.xPct + o.widthPct + PAD, y2: o.yPct + o.estHeightPct + PAD,
        page: o.pageNumber,
    }));

    const placedBoxes: Box[] = [];
    placements.forEach((pl, i) => {
        const fragmentText = fragments[i]?.text ?? '';
        const charCount = fragmentText.length;
        const role = (pl.role === 'margin' || pl.role === 'corner') ? pl.role : 'main';
        const estH = estHeightPctFromChars(charCount, pl.widthPct, PAGE_H_DEFAULT, role);
        let box: Box = {
            x1: pl.xPct - PAD, y1: pl.yPct - PAD,
            x2: pl.xPct + pl.widthPct + PAD, y2: pl.yPct + estH + PAD, page: pl.pageNumber,
        };
        let safety = 0;
        while (safety++ < 20) {
            const collide =
                occBoxes.find(b => intersect(b, box)) ??
                placedBoxes.find(b => intersect(b, box));
            if (!collide) break;
            const newY = collide.y2 + 0.5;
            if (newY > 88) {
                pl.yPct = 88;
                box = { ...box, y1: pl.yPct - PAD, y2: pl.yPct + estH + PAD };
                break;
            }
            pl.yPct = Math.min(88, newY);
            box = { ...box, y1: pl.yPct - PAD, y2: pl.yPct + estH + PAD };
        }
        placedBoxes.push(box);
    });
}

/** 工具: placements + fragments → 下一輪可以用的 occupied hints */
export function placementsToHints(
    placements: PlacedPiece[],
    fragments: HandbookFragment[],
    author: string,
): PlacementHint[] {
    return placements.map((pl, i) => {
        const text = fragments[i]?.text ?? '';
        const role = (pl.role === 'corner' || pl.role === 'margin') ? pl.role : 'main';
        return {
            pageNumber: pl.pageNumber,
            xPct: pl.xPct,
            yPct: pl.yPct,
            widthPct: pl.widthPct,
            estHeightPct: estHeightPctFromChars(text.length, pl.widthPct, PAGE_H_DEFAULT, role),
            author,
            textPreview: text.length > 30 ? text.slice(0, 30) + '…' : text,
        };
    });
}

/** 工具: placedPieces[] → HandbookLayout[] (按 pageNumber 分組) */
export function placedPiecesToLayouts(pieces: PlacedPiece[]): HandbookLayout[] {
    const byPage: Record<number, LayoutPlacement[]> = {};
    for (const p of pieces) {
        const k = p.pageNumber;
        if (!byPage[k]) byPage[k] = [];
        const { pageNumber: _pn, ...rest } = p;
        byPage[k].push(rest);
    }
    return Object.keys(byPage)
        .sort((a, b) => Number(a) - Number(b))
        .map(k => ({
            pageNumber: Number(k),
            placements: byPage[Number(k)],
            generatedAt: Date.now(),
        }));
}

// ─── 1. user 視角日記（跨角色聚合）─────────────────────────
//
// 新設計 (輪回寫作): 這一次 LLM 調用同時產出"寫什麼"和"寫在哪"。
// LLM 收到一個"已經被佔用的區域"列表 (前面作者已經擺好的卡片 bbox),
// 必須把自己新寫的 fragment 擺在空位, 不許重疊。
//
export interface PlacementHint {
    pageNumber: number;        // 1 起
    xPct: number;
    yPct: number;
    widthPct: number;
    estHeightPct: number;      // 服務端估算的高度
    author: string;            // "我" / 角色名
    textPreview: string;       // 截 30 字給 LLM 提示這格里寫的啥
}

export interface UserDiaryGenInput {
    date: string;                  // YYYY-MM-DD
    selectedCharIds: string[];     // 入冊的角色（默認：今天聊過的）
    characters: CharacterProfile[];
    userProfile: UserProfile;
    apiConfig: ApiConfig;
    /** 篇幅預算: 期望生成多少條 fragment(±2);0 = 跳過該 page */
    fragmentBudget?: number;
    /** 已經被前面作者佔用的區域,這次擺位必須避開 */
    occupied?: PlacementHint[];
    /** 畫布像素尺寸,只用於換算估高 */
    canvasPixelHint?: { width: number; height: number };
    /** 當前最大已用頁碼;新片可在 [1, maxPage+1] 之間選,但總數不超 2 */
    maxPageInUse?: number;
}

export interface UserDiaryGenResult {
    page: HandbookPage | null;
    /** 此次 LLM 給的位置 (含 pageNumber, 待調用方分組合到 layouts) */
    placements: PlacedPiece[];
    totalUserMsgs: number;
    perChar: { charId: string; charName: string; userMsgs: number; totalLines: number }[];
}

export async function generateUserDiaryPage(
    input: UserDiaryGenInput,
): Promise<UserDiaryGenResult> {
    const {
        date, selectedCharIds, characters, userProfile, apiConfig, fragmentBudget,
        occupied = [], canvasPixelHint, maxPageInUse,
    } = input;
    const userName = userProfile.name || '我';

    const perChar: UserDiaryGenResult['perChar'] = [];
    const transcriptParts: string[] = [];
    let totalUserMsgs = 0;

    for (const charId of selectedCharIds) {
        const char = characters.find(c => c.id === charId);
        if (!char) continue;
        const { lines, userMsgCount } = await getTodayChatLines(char, date, userName);
        perChar.push({ charId, charName: char.name, userMsgs: userMsgCount, totalLines: lines.length });
        totalUserMsgs += userMsgCount;
        if (lines.length === 0) continue;
        // 控制單角色片段長度（最多 60 行，避免某天極長對話壓垮 prompt）
        const trimmed = lines.length > 60 ? lines.slice(-60) : lines;
        transcriptParts.push(`== 與「${char.name}」==\n${trimmed.join('\n')}`);
    }

    if (totalUserMsgs === 0 || transcriptParts.length === 0) {
        return { page: null, placements: [], totalUserMsgs, perChar };
    }

    const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][new Date(date.replace(/-/g, '/')).getDay()];

    // 篇幅預算: 默認 5~9 條,有外部預算就遵循
    const targetCount = fragmentBudget && fragmentBudget > 0
        ? `${Math.max(1, fragmentBudget - 1)} ~ ${fragmentBudget + 1}`
        : '5 ~ 9';

    const W = canvasPixelHint?.width ?? 360;
    const H = canvasPixelHint?.height ?? 720;
    const occupiedBlock = renderOccupiedBlock(occupied);
    const maxAllowedPage = Math.min(2, (maxPageInUse ?? 0) + 1) || 1;

    const prompt = `今天是 ${date}（星期${dayOfWeek}）。

你是「${userName}」的私人手帳代筆。請基於 ${userName} 今天和不同角色的對話碎片,在一張 ${W}x${H}px 的瘦長手帳紙上**親手寫下**${userName} 的"今日碎片"——是社媒碎碎念體(像微博/Twitter 單條),不是規整日記。**寫什麼 + 寫在哪都你定**。

${occupiedBlock}

【輸出 JSON 數組】每條同時包含內容和位置:
[
  { "time": "上午", "text": "...", "page": 1, "xPct": 8, "yPct": 10, "widthPct": 62, "role": "main" },
  { "text": "好睏", "page": 1, "xPct": 70, "yPct": 16, "widthPct": 28, "role": "corner" },
  ...
]

【內容要求】
- ${targetCount} 條之間
- time 可選 ("上午"/"中午"/"下午"/"深夜"/"10:23")
- text 必填,正常條 30~80 字
- 鼓勵 1~2 條**< 14 字的塗鴉句** (例: "下雨了。" / "好睏" / "今天買花。") — 會渲染成大字手寫
- 第一人稱,單瞬間+情緒,不敘事堆疊
- 只寫 ${userName} 真做過/說過的, 沒素材就少寫
- 不把角色當收件人, 不 AI 昇華, 不 emoji

【位置要求 — 關鍵】
- page: 1 或 2 (現在最多到第 ${maxAllowedPage} 頁)
- xPct/yPct: 卡片左上角佔整頁百分比 [0, 90]
- widthPct: 卡片寬度 [22, 88]
- role: "main"(主區,長卡 chars>50, widthPct 55~85) / "side"(中型 40~62) / "corner"(角落小卡 chars<35, widthPct 28~50) / "margin"(< 14 字塗鴉, widthPct 28~42)
- **新片必須擺在已佔區域之外**,bbox 不能與 occupied 列表裡任何片重疊,留 ≥ 3% 間距
- 1 頁能裝就 1 頁,不強行拆 page 2
- 同 page 內卡片高度估算 = chars / (widthPct*0.16) * 3.4 + 6 (% of page)

【可選筆感修飾】 text 裡允許少量 markdown:
**粗** *斜* ==高亮== ~~刪~~ [color:red/pink/blue/sky/green/mint/yellow/purple/orange](文)
每條最多用 1 處,不濫用。

【今日對話素材】
${transcriptParts.join('\n\n')}

直接輸出 JSON 數組。`;

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.8,
                max_tokens: 12000,
            }),
        });
        if (!response.ok) {
            console.error('[Handbook/UserDiary] API error:', response.status);
            return { page: null, placements: [], totalUserMsgs, perChar };
        }
        const data = await safeResponseJson(response);
        let raw: string = data.choices?.[0]?.message?.content || '';
        raw = raw.trim();
        if (raw.length < 4) return { page: null, placements: [], totalUserMsgs, perChar };

        // 同時解析 fragments 和 placements
        const pageId = `udiary-${date}-${Date.now()}`;
        const { fragments, placements } = parseTurnOutput(raw, pageId, occupied);
        if (fragments.length === 0) {
            return { page: null, placements: [], totalUserMsgs, perChar };
        }
        const content = fragmentsToPlainText(fragments);

        const page: HandbookPage = {
            id: pageId,
            type: 'user_diary',
            content,
            fragments,
            paperStyle: 'lined',
            generatedBy: 'llm',
            generatedAt: Date.now(),
        };
        return { page, placements, totalUserMsgs, perChar };
    } catch (e) {
        console.error('[Handbook/UserDiary] failed:', e);
        return { page: null, placements: [], totalUserMsgs, perChar };
    }
}

// ─── 2. 生活系角色生活流（陪伴頁）──────────────────────────
//
// 設計原則(user 反饋對齊 2026-04, depth + 角色沉澱注入版):
// - 角色一天不是一句話,要豐滿、有節奏
// - 接入 DailySchedule.slots 作為骨架
// - **大量注入角色沉澱**: worldview / personalityStyle / selfInsights /
//   refinedMemories / impression。深度從角色內核來,不是憑空"看貓想到無常"
// - **類型配比強制**: physical / reflection / observation / user_thought
//   "看到野貓打架想起你"作為反例 few-shot 嚴禁
// - **3 檔深度** light/medium/deep,調整四類型配比和字數
// - 紅線: 不要虛構 user 和角色共同發生的事
//
export type LifestreamDepth = 'light' | 'medium' | 'deep';

export interface LifestreamGenResult {
    page: HandbookPage | null;
    placements: PlacedPiece[];
}

export async function generateLifestreamPage(
    char: CharacterProfile,
    date: string,
    userProfile: UserProfile,
    apiConfig: ApiConfig,
    depth: LifestreamDepth = 'medium',
    /** 篇幅預算: 期望 fragment 數(±1);0 跳過 */
    fragmentBudget?: number,
    /** 已經被前面作者佔用的區域,這次擺位必須避開 */
    occupied: PlacementHint[] = [],
    /** 當前最大已用頁碼 */
    maxPageInUse: number = 0,
    canvasPixelHint?: { width: number; height: number },
): Promise<LifestreamGenResult> {
    if (fragmentBudget !== undefined && fragmentBudget <= 0) return { page: null, placements: [] };
    // (取消 lifestyle gate: 只要 user 把 ta 選進來,就讓 ta 在這頁留一筆。
    //  scheduleStyle 仍用於決定是否注入 schedule 骨架。)
    const userName = userProfile.name || 'user';
    const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][new Date(date.replace(/-/g, '/')).getDay()];

    // ─── 1. 直接調項目統一的 ContextBuilder.buildCoreContext ──
    //   它已經處理了:身份/systemPrompt/selfInsights/worldview/mountedWorldbooks
    //   /user profile/impression(完整含 likes/triggers/comfort/changes)
    //   /refinedMemories/activeMemoryMonths 詳細日誌/memoryPalace/buff
    //   是聊天系統在用的 source of truth,改它會自動跟進
    const coreContext = ContextBuilder.buildCoreContext(char, userProfile, true);

    // ─── 1b. ta 實際怎麼說話 — buildCoreContext 沒的,得自己補 ──
    // 這是"像不像 ta"最關鍵的輸入: prompt 描述規則,樣本展示語氣
    let speechSamples: string[] = [];
    try {
        const all = await loadCharacterContextMessages(char);
        const charMsgs = all.filter(m =>
            m.role === 'assistant'
            && typeof m.content === 'string'
            && m.content.length > 4
            && m.content.length < 600
            && !(m.content.trim().startsWith('{') && m.content.trim().endsWith('}'))
        );
        // 在可見範圍內均勻抽 30 條語氣樣本
        if (charMsgs.length <= 30) {
            speechSamples = charMsgs.map(m => m.content.slice(0, 200));
        } else {
            const step = charMsgs.length / 30;
            for (let i = 0; i < 30; i++) {
                const idx = Math.floor(i * step);
                speechSamples.push(charMsgs[idx].content.slice(0, 200));
            }
        }
    } catch { /* 無所謂 */ }

    // ─── 2. 當日 schedule slots ──
    let scheduleBlock = '';
    try {
        const sched = await DB.getDailySchedule(char.id, date);
        if (sched && sched.slots && sched.slots.length > 0) {
            const lines = sched.slots.map(s => {
                const parts = [`- ${s.startTime}`, s.activity];
                if (s.description) parts.push(`(${s.description})`);
                if (s.location) parts.push(`@${s.location}`);
                return parts.join(' ');
            });
            scheduleBlock = `\n【今日日程骨架】\n${lines.join('\n')}\n`;
        }
    } catch {}

    // ─── 7. 類型配比(按 depth 檔位) ──
    const composition = (() => {
        switch (depth) {
            case 'light':
                return { defaultTotal: 6, physical: '3~4', reflection: '1~2', observation: '0~1', userThought: '0~1(僅當聊天有真實素材)', avgChars: '30~60', note: '偏日常,反思一兩條點綴,不必深' };
            case 'deep':
                return { defaultTotal: 7, physical: '1~2', reflection: '3~4', observation: '2', userThought: '0', avgChars: '50~110', note: '深度反芻,反思和外界觀察佔主導,幾乎不出現 user' };
            case 'medium':
            default:
                return { defaultTotal: 7, physical: '2~3', reflection: '2~3', observation: '1~2', userThought: '0~1(僅當聊天有真實素材)', avgChars: '40~80', note: '日常 + 反思平衡,有內核但不沉重' };
        }
    })();
    // 篇幅預算優先;沒傳就用 depth 默認值 ±1
    const targetTotal = fragmentBudget && fragmentBudget > 0
        ? `${Math.max(1, fragmentBudget - 1)} ~ ${fragmentBudget + 1}`
        : `${Math.max(1, composition.defaultTotal - 1)} ~ ${composition.defaultTotal + 1}`;

    // ─── 4. 組裝 prompt ──────────
    const speechBlock = speechSamples.length > 0
        ? `\n【⚠️ ta 平時怎麼說話 — 這是"像不像 ta"最關鍵的輸入,嚴格模仿這個語氣、用詞、句式、節奏、口頭禪、標點習慣】\n${speechSamples.map((s, i) => `[${i + 1}] ${s}`).join('\n')}\n`
        : '';

    const W = canvasPixelHint?.width ?? 360;
    const H = canvasPixelHint?.height ?? 720;
    const occupiedBlock = renderOccupiedBlock(occupied);
    const maxAllowedPage = Math.min(2, (maxPageInUse ?? 0) + 1) || 1;

    // depth=light 時,user impression 在角色 context 裡仍存在,但 prompt 末尾會
    // 強調"幾乎不出現 user_thought",通過類型配比抑制即可,不需要再剝 context
    const prompt = `今天是 ${date}（星期${dayOfWeek}）。${userName} 已經在 ${W}x${H}px 的瘦長手帳紙上寫下了 ta 今天的碎片。請你 (角色「${char.name}」) **在紙上的空白處, 也寫一組自己的今日碎片**——不是日記,是 ta 散落的瞬間,各自獨立又拼出 ta 的一天。**寫什麼 + 寫在哪都你定**。

【角色完整檔案】
${coreContext}
${speechBlock}${scheduleBlock}

${occupiedBlock}

【輸出 JSON 數組】每條同時含內容和位置:
[
  { "time": "上午", "type": "physical", "text": "...", "page": 1, "xPct": 60, "yPct": 14, "widthPct": 36, "role": "side" },
  { "type": "reflection", "text": "...", "page": 1, "xPct": 8, "yPct": 70, "widthPct": 84, "role": "main" },
  ...
]

【內容要求】
- 共 ${targetTotal} 條
- type 必填, 配比:
  - "physical" (具體到角色身份的物件/動作): ${composition.physical} 條
  - "reflection" (基於"自我領悟"+"記憶痕跡"延伸): ${composition.reflection} 條
  - "observation" (對路過事/世界/陌生人, **不涉及 ${userName}**): ${composition.observation} 條
  - "user_thought" (短暫想到 ${userName}): ${composition.userThought} 條
- text 必填, 正常條 ${composition.avgChars} 字。${composition.note}
- 允許 1 條**極短塗鴉句** (< 14 字, 例: "再睡一會。" / "這破代碼。"), 短句會渲染成大字手寫
- time 可選

【位置要求 — 關鍵】
- page: 1 或 2 (現在最多到第 ${maxAllowedPage} 頁)
- xPct/yPct: 卡片左上角佔整頁 [0, 90]
- widthPct: [22, 88]
- role: "main" / "side" / "corner"(< 35 字, widthPct 28~50) / "margin"(< 14 字短句, widthPct 28~42)
- **新片必須擺在 occupied 列表給的所有 bbox 之外**, 留 ≥ 3% 間距
- 因為 ${userName} 已經佔了主區, 你大概率應該走 "side" / "corner" / "margin" 見縫插針 — 在 user 的卡之間或左右兩側的留白裡
- 高度估算: chars / (widthPct*0.16) * 3.4 + 6 (% of page)
- 1 頁裝得下就 1 頁, 別強行開 page 2

【⚠️⚠️⚠️ 像不像 ta 的核心要求 —— 嚴格遵守】
- **必須模仿上方"ta 平時怎麼說話"樣本里的語氣、用詞、句式、節奏、口頭禪、標點習慣**
- 如果 ta 平時用 "啊" "嗯" "誒" 這種語氣詞,你就要用;如果 ta 不用,你就不要塞進去
- 如果 ta 喜歡長句,你就寫長句;ta 喜歡短句就短;ta 愛用破折號就用破折號
- 不要用 ta 說話樣本里完全沒出現過的"AI 文藝腔"(比如"恍惚間"、"忽然意識到"、"如同一道閃電")
- 這是這個功能的命門:user 一眼就能看出"這不是 ta",一旦不像 user 會立刻刪除整組

【⚠️ 類型說明 + 反例(嚴禁 vs 推薦)】

1. "physical" — 必須**具體到角色身份**的物件/動作:
   ❌ "今天磨咖啡時手抖了"(任何人都可以發,跟角色無關)
   ✅ "戴 noise-canceling 耳機調那段卡住的鼓 fill,左右聲道又錯位 0.3 拍"(角色是音樂人,具體)

2. "reflection" — **必須從【自我領悟】或【記憶痕跡】延伸**,不是憑空文藝:
   ❌ "看到落葉想到無常"(偽深度,跟角色無關)
   ✅ 假設 selfInsight = "我習慣先撐住再喊救命":
       "又一次到了'我先撐住'階段。能聽見自己說這句話的語氣和上次完全一樣,但還是這麼說。"

3. "observation" — 角色對外界,**絕不涉及 ${userName}**:
   ✅ "剛刷到一篇'躺平 vs 效率'的爭論,兩邊都說被異化,可沒人點'被誰異化'"
   ✅ "便利店換了新店員,掃碼慢得讓前面的 OL 都翻白眼。我倒不急。"

4. "user_thought" — 短暫念頭,**不能成為段落主語**,**不能虛構共同事件**:
   ❌❌❌ "看到樓下野貓打架,想起 ${userName}"
   ❌❌❌ "今天給花澆了水,然後想起 ${userName}"
   原因:這種"小事 + 想起 ta"的句式信息量為零,${userName} 看了會覺得 ${char.name} 沒自己的內核 —— 這是這個 app 最丟人的失敗模式,嚴禁出現。
   ✅(基於 impression):"想起 ${userName} 上次說 ta 在 burnout 邊緣 —— 我大概知道這意味著 ta 接下來會強行假裝沒事。"
   ✅(只在有真實聊天材料):"${userName} 早上發的那張圖,是 ta 選了那家店沒去成,我截屏了。"

【⚠️ 絕對鐵律 —— 違反整組判廢】
- **不要虛構 ${userName} 和 ${char.name} 之間發生過的事**:沒見面 / 沒一起做 / user 沒說過的話,一律不能編。會讓 ${userName} 覺得人生被奪舍。
- 嚴禁 AI 捧場:"希望 ${userName} 看到""如果 ${userName} 在就好了""想給 ta 驚喜"
- 用 ${char.name} 自己的口吻(第一人稱最自然),不要旁白腔
- 緊貼日程骨架但**不復述**,要"造謠"成手感片段
- 允許真實的消極、無聊、拖延、獨處、emo
- 不要 emoji 開頭/不要標題/不要包裹符號

【可選 — 筆感修飾(讓一兩條更鮮活)】
text 裡允許少量 markdown 語法,渲染時會變成對應的視覺效果:
- **粗** 真的想強調的詞
- *斜* 引用/自語
- ==高亮== 馬克筆劃重點(每組最多 2 條用)
- ~~刪除~~ 自嘲否定
- [color:red](文字) 彩筆顏色: red/pink/blue/sky/green/mint/yellow/purple/orange/gray
約束:**每條最多用 1 個修飾**,大部分句子純文本就好。

直接輸出 JSON 數組。`;

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.85,
                max_tokens: 12000,
            }),
        });
        if (!response.ok) {
            console.error('[Handbook/Lifestream] API error:', response.status, char.name);
            return { page: null, placements: [] };
        }
        const data = await safeResponseJson(response);
        let raw: string = data.choices?.[0]?.message?.content || '';
        raw = raw.trim();
        if (raw.length < 4) return { page: null, placements: [] };

        const pageId = `lifestream-${char.id}-${date}-${Date.now()}`;
        const { fragments, placements } = parseTurnOutput(raw, pageId, occupied);
        if (fragments.length === 0) return { page: null, placements: [] };

        const content = fragmentsToPlainText(fragments);
        const page: HandbookPage = {
            id: pageId,
            type: 'character_life',
            charId: char.id,
            content,
            fragments,
            paperStyle: 'plain',
            generatedBy: 'llm',
            generatedAt: Date.now(),
        };
        return { page, placements };
    } catch (e) {
        console.error('[Handbook/Lifestream] failed:', char.name, e);
        return { page: null, placements: [] };
    }
}

// ─── 工具：今天日期字符串（本地時區）─────────────────────
export function getLocalDateStr(d: Date = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// ─── 探測:統計 user 今天和指定角色們一共說了多少話 ────
export async function countUserMsgsToday(
    charIds: string[],
    date: string,
): Promise<number> {
    if (charIds.length === 0) return 0;
    const { start, end } = dayRange(date);
    let total = 0;
    for (const id of charIds) {
        try {
            const all = await DB.getMessagesByCharId(id, true);
            total += all.filter(m => m.timestamp >= start && m.timestamp < end && m.role === 'user').length;
        } catch {}
    }
    return total;
}

// ─── 探測：今天哪些角色和 user 有過對話 ───────────────────
export async function findCharactersWithChatToday(
    characters: CharacterProfile[],
    date: string,
): Promise<string[]> {
    const { start, end } = dayRange(date);
    const result: string[] = [];
    for (const c of characters) {
        try {
            const all = await DB.getMessagesByCharId(c.id, true);
            const hasUserMsg = all.some(m => m.timestamp >= start && m.timestamp < end && m.role === 'user');
            if (hasUserMsg) result.push(c.id);
        } catch {}
    }
    return result;
}

// 候選可寫陪伴頁的角色 = 全部角色（user 自己挑）。保留舊導出名以減小改動面。
export function pickLifestreamChars(characters: CharacterProfile[]): CharacterProfile[] {
    return characters.slice();
}

// ─── 篇幅預算規劃 ────────────────────────────────────────
//
// 一天 ≤ 2 頁, ~14 片 fragment 總預算。
// 按 user 當天聊天活躍度,先給 user 分一份,剩下的均攤給參與陪伴的角色。
// user 多話 → user 多寫、char 少陪;user 少話 → char 來撐場。
//
export interface FragmentBudgetPlan {
    /** user_diary 的 fragment 數 */
    userBudget: number;
    /** key=charId, value=該角色 lifestream 的 fragment 數 */
    perChar: Record<string, number>;
    /** 估算總片數 */
    total: number;
    /** debug 用: 計算依據 */
    rationale: string;
}

export function planFragmentBudget(
    totalUserMsgsToday: number,
    selectedDiaryCharIds: string[],
    selectedLifeChars: CharacterProfile[],
): FragmentBudgetPlan {
    const TOTAL = 14;   // 2 頁 × 7 片左右

    // user 份額: 沒說話就 0;1~5 句給 4 片;6~15 句給 6 片;16~30 給 7 片;>30 給 8 片
    let userBudget: number;
    if (selectedDiaryCharIds.length === 0 || totalUserMsgsToday === 0) userBudget = 0;
    else if (totalUserMsgsToday < 6)  userBudget = 4;
    else if (totalUserMsgsToday < 16) userBudget = 6;
    else if (totalUserMsgsToday < 31) userBudget = 7;
    else                              userBudget = 8;

    // 角色份額 = 剩下的均攤
    const charPool = Math.max(0, TOTAL - userBudget);
    const numChars = selectedLifeChars.length;
    const perChar: Record<string, number> = {};
    if (numChars > 0 && charPool > 0) {
        // 平均每角色 ≥ 2 (太少沒意思)、≤ 5 (單人不要霸屏)
        let basePerChar = Math.max(2, Math.min(5, Math.floor(charPool / numChars)));
        // 如果 basePerChar × numChars 超 charPool 太多, 縮到 charPool / numChars 向上取整
        if (basePerChar * numChars > charPool + 2) {
            basePerChar = Math.max(2, Math.ceil(charPool / numChars));
        }
        for (const c of selectedLifeChars) perChar[c.id] = basePerChar;
    } else if (numChars > 0 && charPool === 0) {
        // user 搶光了, 角色每人就給 2 片象徵性陪一筆
        for (const c of selectedLifeChars) perChar[c.id] = 2;
    }

    const total = userBudget + Object.values(perChar).reduce((a, b) => a + b, 0);
    const rationale =
        `userMsgs=${totalUserMsgsToday}, chars=${numChars}; ` +
        `userBudget=${userBudget}, perChar=${Object.values(perChar)[0] ?? 0}, total=${total}`;
    return { userBudget, perChar, total, rationale };
}

// ═══════════════════════════════════════════════════════════════════
// ─── 3. 確定性版式引擎 (composePageLayout) ───────────────────────
// ═══════════════════════════════════════════════════════════════════
//
// 取代 LLM 排版 — 改成同步、可證、可 lint 的 pure function。
//
// 輸入: 當日所有 page (含 fragments) + 角色表 + user 資料 + date 種子
// 輸出: HandbookLayout[] (每張紙 placements 列表, 每片有確定 xPct/yPct/widthPct/role/isHero)
//
// 核心約束 (硬編碼, LLM 碰不到):
//   1. 每頁恰好 1 個 hero (isHero=true) — 字號最大、視覺最顯眼
//   2. 每片只能落到某個固定槽 (slot) 裡, x/w 由槽決定, y 自動堆疊
//   3. rotate 限制在 ±2 (主帶 0, 角落 ±1.5)
//   4. 槽的 yStart/yEnd 自然產生 ≥ 25% 留白
//   5. 單片不會與前一片 bbox 重疊 (堆疊 + gap)
//   6. 裝飾預算: 見 JournalCanvas (硬編碼 ≤ 1 顆)
//   7. 強調預算: lintEmphasis 在渲染層每頁 ≤ 2, 由 JournalCanvas 計算
//
// 這個函數沒有副作用、不調網絡、不拋錯 (內容空時返回 [])。

export interface LayoutGenInput {
    date: string;
    pages: HandbookPage[];
    characters: CharacterProfile[];
    userProfile: UserProfile;
}

interface FlatPiece {
    pageId: string;
    fragmentId?: string;
    author: string;
    type: HandbookPage['type'];
    text: string;
    charCount: number;
}

function flattenPiecesForLayout(
    pages: HandbookPage[],
    userName: string,
    characters: CharacterProfile[],
): FlatPiece[] {
    const out: FlatPiece[] = [];
    for (const p of pages) {
        if (p.excluded) continue;
        const author = p.charId
            ? (characters.find(c => c.id === p.charId)?.name || '某角色')
            : userName;
        if (p.fragments && p.fragments.length > 0) {
            for (const f of p.fragments) {
                out.push({
                    pageId: p.id, fragmentId: f.id, author, type: p.type,
                    text: f.text, charCount: f.text.length,
                });
            }
        } else if (p.content && p.content.trim()) {
            out.push({
                pageId: p.id, author, type: p.type,
                text: p.content, charCount: p.content.length,
            });
        }
    }
    return out;
}

// ─── 模板定義 ────────────────────────────────────────────
//
// 每個模板 = 一組固定槽位 (slot)。槽位定義了 x / w / y 範圍 / 容量 /
// 接受的 role。pieces 按規則分配到槽,槽內自上而下堆,溢出走 page 2。

type TemplateKind = 'A_journal' | 'B_split' | 'C_emotional' | 'D_dialogue';

interface SlotDef {
    id: string;
    xPct: number;
    widthPct: number;
    yStart: number;          // 起始 y%
    yEnd: number;            // 截止 y%, 超出去 page 2
    accepts: LayoutRole;     // 此槽接收的 role
    capacity?: number;       // 最多堆幾片 (undefined = 直到 yEnd)
}

interface TemplateDef {
    slots: SlotDef[];
}

// 設計要點:
// - 主帶 widthPct 76~85, 讓正文像真實日記一樣橫貫紙面
// - 槽的總佔比 < 75%, 自帶留白
// - corner / margin 永遠在角落, 不擠主區
const TEMPLATES: Record<TemplateKind, TemplateDef> = {
    // A · 日誌 (默認): 一個長主帶 + 右下角槽 + 左上 margin
    A_journal: {
        slots: [
            { id: 'main',   xPct: 7,  widthPct: 80, yStart: 4,  yEnd: 78, accepts: 'main' },
            { id: 'side',   xPct: 7,  widthPct: 80, yStart: 4,  yEnd: 78, accepts: 'side' },
            { id: 'corner', xPct: 56, widthPct: 38, yStart: 78, yEnd: 92, accepts: 'corner', capacity: 2 },
            { id: 'margin', xPct: 7,  widthPct: 36, yStart: 78, yEnd: 92, accepts: 'margin', capacity: 2 },
        ],
    },
    // B · 雙欄: 左主帶 + 右輔帶 + 底通欄
    B_split: {
        slots: [
            { id: 'left',   xPct: 6,  widthPct: 44, yStart: 4,  yEnd: 80, accepts: 'main' },
            { id: 'right',  xPct: 53, widthPct: 42, yStart: 4,  yEnd: 80, accepts: 'side' },
            { id: 'corner', xPct: 6,  widthPct: 88, yStart: 82, yEnd: 92, accepts: 'corner', capacity: 1 },
            { id: 'margin', xPct: 75, widthPct: 20, yStart: 4,  yEnd: 16, accepts: 'margin', capacity: 1 },
        ],
    },
    // C · 情緒頁 (內容少): 中央 hero + 上下小碎片
    C_emotional: {
        slots: [
            { id: 'hero',    xPct: 8,  widthPct: 84, yStart: 28, yEnd: 60, accepts: 'main',   capacity: 1 },
            { id: 'top',     xPct: 8,  widthPct: 84, yStart: 8,  yEnd: 24, accepts: 'side',   capacity: 1 },
            { id: 'corner',  xPct: 8,  widthPct: 84, yStart: 64, yEnd: 88, accepts: 'corner', capacity: 2 },
            { id: 'margin',  xPct: 70, widthPct: 24, yStart: 4,  yEnd: 18, accepts: 'margin', capacity: 1 },
        ],
    },
    // D · 對話流 (≥3 個作者): 左右交錯帶, 像聊天落在紙上
    D_dialogue: {
        slots: [
            { id: 'left',    xPct: 5,  widthPct: 56, yStart: 4,  yEnd: 90, accepts: 'main' },
            { id: 'right',  xPct: 38, widthPct: 56, yStart: 14, yEnd: 90, accepts: 'side' },
            { id: 'margin',  xPct: 76, widthPct: 20, yStart: 4,  yEnd: 14, accepts: 'margin', capacity: 1 },
        ],
    },
};

// ─── 模板選擇 ────────────────────────────────────────────
//
// 不讓 LLM 選 — 按內容形態確定:
//   - 總字數 < 100 OR 片數 ≤ 2  → C (情緒頁, hero 大字)
//   - 不同作者 ≥ 3              → D (對話流)
//   - 不同作者 = 2 AND 片數 ≥ 4  → B (雙欄)
//   - 其它                       → A (默認日誌)
function pickTemplate(pieces: FlatPiece[]): TemplateKind {
    const totalChars = pieces.reduce((s, p) => s + p.charCount, 0);
    const authors = new Set(pieces.map(p => p.author));

    if (pieces.length <= 2 || totalChars < 100) return 'C_emotional';
    if (authors.size >= 3) return 'D_dialogue';
    if (authors.size === 2 && pieces.length >= 4) return 'B_split';
    return 'A_journal';
}

// ─── piece → role ────────────────────────────────────────
// 字數 + 內容形態決定 role, 不讓 LLM 選
function pieceRole(piece: FlatPiece): LayoutRole {
    if (piece.charCount < 18) return 'margin';
    if (piece.charCount < 35) return 'corner';
    if (piece.charCount < 60) return 'side';
    return 'main';
}

// ─── 把 pieces 分配到 template 的 slot ────────────────────
//
// 規則:
//   1. 每片先算自己的 role
//   2. 找模板裡 accepts 此 role 的槽,選一個還有容量的
//   3. 找不到匹配槽 → 退化到 main 槽 (永遠存在)
//   4. 同作者的 pieces 儘量臨近 (放進同一個槽隊列)
function assignToSlots(
    pieces: FlatPiece[],
    template: TemplateDef,
): Record<string, FlatPiece[]> {
    const slotPieces: Record<string, FlatPiece[]> = {};
    template.slots.forEach(s => slotPieces[s.id] = []);

    // 同作者儘量臨近: 按 (author, originalIndex) 穩定排序
    const indexed = pieces.map((p, i) => ({ piece: p, i }));
    indexed.sort((a, b) => {
        if (a.piece.author === b.piece.author) return a.i - b.i;
        return a.piece.author.localeCompare(b.piece.author);
    });

    for (const { piece } of indexed) {
        const role = pieceRole(piece);

        // 優先匹配 role 的槽
        let slot = template.slots.find(s =>
            s.accepts === role &&
            slotPieces[s.id].length < (s.capacity ?? 99)
        );

        // 找不到 → 降級
        if (!slot) {
            // 短句溢出去 corner / main
            const fallbacks: LayoutRole[] = role === 'margin'
                ? ['corner', 'side', 'main']
                : role === 'corner'
                ? ['side', 'main']
                : role === 'side'
                ? ['main']
                : ['side', 'corner'];
            for (const fb of fallbacks) {
                slot = template.slots.find(s =>
                    s.accepts === fb &&
                    slotPieces[s.id].length < (s.capacity ?? 99)
                );
                if (slot) break;
            }
        }

        // 兜底: 第一個槽
        if (!slot) slot = template.slots[0];
        slotPieces[slot.id].push(piece);
    }

    return slotPieces;
}

// ─── 槽內堆疊 → PlacedPiece[] ─────────────────────────────
//
// 在每個槽內自上而下堆,每片高度按字數估算,gap 3%。
// 超出 slot.yEnd → 翻到 page 2 的同槽 (page 2 槽位等同 page 1)。
// 最多 2 頁, 第 3 頁以後丟掉 (實測 user 一天的內容 < 30 片, 2 頁夠用)。
function stackInSlots(
    slotPieces: Record<string, FlatPiece[]>,
    template: TemplateDef,
    seedKey: string,
): PlacedPiece[] {
    const placed: PlacedPiece[] = [];
    const GAP_Y = 3;

    for (const slot of template.slots) {
        const items = slotPieces[slot.id] || [];
        if (items.length === 0) continue;

        let pageNumber = 1;
        let y = slot.yStart;

        for (const piece of items) {
            const role = slot.accepts;
            const h = estHeightPctFromChars(
                piece.charCount, slot.widthPct, PAGE_H_DEFAULT,
                role === 'main' || role === 'side' ? 'main' : role,
            );

            // 溢出 → 翻頁
            if (y + h > slot.yEnd) {
                pageNumber++;
                if (pageNumber > 2) break;
                y = slot.yStart;
            }

            const seed = piece.fragmentId ?? piece.pageId ?? seedKey;
            // rotate: main 永遠 0, side ±0.6, corner ±1.5, margin ±2
            const rotateRange = role === 'main' ? 0
                : role === 'side' ? 0.6
                : role === 'corner' ? 1.5
                : 2;
            const rotate = rotateRange === 0 ? 0
                : Math.round(((seedFloat(seed, 9) - 0.5) * 2 * rotateRange) * 10) / 10;

            placed.push({
                pageId: piece.pageId,
                fragmentId: piece.fragmentId,
                xPct: slot.xPct,
                yPct: y,
                widthPct: slot.widthPct,
                rotate,
                zIndex: 10,
                role,
                pageNumber,
            });

            y += h + GAP_Y;
        }
    }

    return placed;
}

// ─── lint: hero 選定 ──────────────────────────────────────
// 每頁選 1 個 hero — 優先 main 中字數最長, 沒 main 就最長 side
function lintHero(layouts: HandbookLayout[], pieces: FlatPiece[]): void {
    const charById = new Map<string, number>();
    pieces.forEach(p => charById.set(p.fragmentId ?? p.pageId, p.charCount));

    for (const lay of layouts) {
        let hero: LayoutPlacement | undefined;
        let heroChars = -1;

        // 第一輪: 找最長的 main
        for (const pl of lay.placements) {
            if (pl.role !== 'main') continue;
            const c = charById.get(pl.fragmentId ?? pl.pageId) ?? 0;
            if (c > heroChars) { hero = pl; heroChars = c; }
        }

        // 第二輪兜底: 沒有 main 就找最長的 side
        if (!hero) {
            for (const pl of lay.placements) {
                if (pl.role !== 'side') continue;
                const c = charById.get(pl.fragmentId ?? pl.pageId) ?? 0;
                if (c > heroChars) { hero = pl; heroChars = c; }
            }
        }

        // 還沒有就拿 placements[0]
        if (!hero && lay.placements.length > 0) hero = lay.placements[0];

        // 標記 isHero, 保證一頁只一個
        for (const pl of lay.placements) pl.isHero = (pl === hero);
    }
}

// ─── 主入口 ──────────────────────────────────────────────
export function composePageLayout(input: LayoutGenInput): HandbookLayout[] {
    const userName = input.userProfile.name || '我';
    const pieces = flattenPiecesForLayout(input.pages, userName, input.characters);
    if (pieces.length === 0) return [];

    const templateKind = pickTemplate(pieces);
    const template = TEMPLATES[templateKind];
    const slotPieces = assignToSlots(pieces, template);
    const placed = stackInSlots(slotPieces, template, input.date);

    // 漏片兜底: 如果某片沒被分配 (capacity 不夠 + 翻頁溢出), 強行塞到 main 槽 page 2 末尾
    const placedKeys = new Set(placed.map(p => p.fragmentId ?? `pg:${p.pageId}`));
    const missing = pieces.filter(p => !placedKeys.has(p.fragmentId ?? `pg:${p.pageId}`));
    if (missing.length > 0) {
        const mainSlot = template.slots.find(s => s.accepts === 'main') || template.slots[0];
        let y = mainSlot.yStart;
        for (const piece of missing) {
            const h = estHeightPctFromChars(piece.charCount, mainSlot.widthPct, PAGE_H_DEFAULT, 'main');
            placed.push({
                pageId: piece.pageId,
                fragmentId: piece.fragmentId,
                xPct: mainSlot.xPct,
                yPct: Math.min(85, y),
                widthPct: mainSlot.widthPct,
                rotate: 0,
                zIndex: 10,
                role: 'main',
                pageNumber: 2,
            });
            y += h + 3;
        }
    }

    const layouts = placedPiecesToLayouts(placed);
    lintHero(layouts, pieces);
    return layouts;
}

