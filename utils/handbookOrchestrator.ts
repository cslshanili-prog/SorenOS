/**
 * 手帳 v2 編排器 — 版式優先 / 槽位填空
 *
 * 哲學: "大家共寫的一本手帳", 不是 user 主寫 + 角色伴奏。
 *
 * 流程:
 *  1. roll layout: pickTemplate(date 條件) → 一組 SlotDef
 *  2. user 步: *僅當 user 今天有聊天素材* 才跑, 一次 LLM 填 1~2 個最該填的 user 槽 (不全填)
 *  3. 角色步: 取參與角色 (默認 cap 2 個), 每人一次 LLM 調用, 看到 "已填的所有內容 +
 *     剩餘可填槽 + 自己人格", 選 1 個槽填或 pass
 *  4. 收尾: 把 filled slots 轉成 HandbookPage[] + HandbookLayout
 *
 * 關鍵約束:
 *  - 不讓 LLM 排版 (位置已定)
 *  - 字數硬約束 (charBudget) — 寫溢出客戶端截斷
 *  - sticky-reaction 必須有 refersTo 指向已填槽, 缺失整槽作廢
 *  - **today-only 硬約束**: 只寫今天發生過的事, 不要把以前的事編進來
 *  - **共寫而非中心化**: 角色 prompt 不把自己定位成 "user 的伴奏", 而是 "另一個參與者"
 *  - **user 沒素材 → 完全跳過**, 不留假佔位
 */

import {
    CharacterProfile, UserProfile,
    HandbookPage, HandbookFragment, HandbookLayout, LayoutPlacement,
    LayoutTemplate, SlotDef, SlotRole, SlotPayload,
} from '../types';
import { DB } from './db';
import { loadCharacterContextMessages } from './chatContextRange';
import { safeResponseJson, extractJson } from './safeApi';
import { ContextBuilder } from './context';
import { LAYOUT_TEMPLATES, pickTemplate } from './handbookLayouts';
import { getLocalDayRange } from './localDate';
import { normalizeMessageContent } from './messageFormat';

interface ApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

// ─── 工具: 當日時間窗 ────────────────────────────────────
function dayRange(date: string): { start: number; end: number } {
    return getLocalDayRange(date) || { start: 0, end: 0 };
}

function dayOfWeekZh(date: string): string {
    return ['日', '一', '二', '三', '四', '五', '六'][
        new Date(date.replace(/-/g, '/')).getDay()
    ];
}

// ─── 工具: user 當日跟某角色對話片段 ─────────────────────
// （export 僅為了迴歸測試能直接驗這段文本，見 handbookOrchestratorContent.test.ts）
export async function todayChatLines(
    char: CharacterProfile,
    date: string,
    userName: string,
): Promise<{ lines: string[]; userMsgCount: number }> {
    const { start, end } = dayRange(date);
    let all: any[] = [];
    try { all = await DB.getMessagesByCharId(char.id, true); } catch { return { lines: [], userMsgCount: 0 }; }
    const today = all
        .filter(m => m.timestamp >= start && m.timestamp < end)
        .sort((a, b) => a.timestamp - b.timestamp);
    const lines: string[] = [];
    let userMsgCount = 0;
    for (const m of today) {
        if (m.role === 'system') continue;
        if (typeof m.content !== 'string' || !m.content.trim()) continue;
        const speaker = m.role === 'user' ? userName : char.name;
        // 不能直接截 m.content：卡片類消息（score_card / html_card / 小紅書…）的 content
        // 是一整段 JSON，頭像這種圖片字段就排在開頭幾十字裡；圖片消息的 content
        // 本身就是一張圖。圖片現在存的是 `blobref:<id>` 短令牌（~28 字），長度截斷攔不住，
        // 到網絡出口（utils/apiBlobRefs.ts）會被還原成整張 base64。這裡統一走
        // normalizeMessageContent：卡片壓成一行摘要，圖片/表情一律換成佔位符。
        const normalized = normalizeMessageContent(m as any, char.name, userName);
        if (!normalized.trim()) continue;
        const text = normalized.length > 200 ? normalized.slice(0, 200) + '…' : normalized;
        lines.push(`${speaker}: ${text}`);
        if (m.role === 'user') userMsgCount++;
    }
    return { lines, userMsgCount };
}

// ─── 槽 → prompt 描述 ─────────────────────────────────────
function describeSlotForPrompt(s: SlotDef): string {
    const auth = s.eligibleAuthors.join('|');
    return `[${s.id}] role=${s.slotRole} 字數=${s.charBudget[0]}~${s.charBudget[1]} 誰能寫=${auth}\n  目的: ${s.hint}`;
}

// ─── 槽 → 輸出 schema 描述 (告訴 LLM 要返回的 JSON shape) ──
function slotOutputSchema(role: SlotRole): string {
    switch (role) {
        case 'todo':
            return `{ "slotId": "X", "payload": { "kind": "todo", "items": [{"text":"...", "done": true|false}, ...] } }`;
        case 'gratitude':
            return `{ "slotId": "X", "payload": { "kind": "gratitude", "items": ["...", "...", "..."] } }`;
        case 'timeline-plan':
            return `{ "slotId": "X", "payload": { "kind": "timeline", "items": [{"time":"07:30", "text":"起床", "emoji":"☀️"}, ...] } }`;
        case 'mood-card':
            return `{ "slotId": "X", "text": "今天的心情一句話", "payload": { "kind": "mood", "rating": 1~5, "tag": "可選小標籤" } }`;
        case 'photo-caption':
            return `{ "slotId": "X", "payload": { "kind": "photo", "caption": "短描述 (≤25字)" } }`;
        case 'sticky-reaction':
            return `{ "slotId": "X", "text": "便籤內容", "refersTo": "被引用的slotId(必填)" }`;
        case 'hero-diary':
        case 'corner-note':
        default:
            return `{ "slotId": "X", "text": "純文本內容" }`;
    }
}

// ─── 共享: today-only 紅線 ────────────────────────────────
const TODAY_ONLY_RULE = `
【⚠️⚠️⚠️ TODAY-ONLY 硬約束 — 違反整組判廢】
- 只寫 *今天 (該日期)* 真正發生過的事 / 真正想到的念頭
- **嚴禁**把以前的回憶、過往的對話、過去的經歷當作"今天的事"扯出來
- **嚴禁**虛構今天和 user 一起做了什麼 (沒見面就沒有)
- 如果你這個角色今天根本沒素材, 直接 pass —— 不要硬擠
- 反應型槽 (sticky-reaction) 必須明確引用 "已填的某個槽 (slotId)" 的具體內容, 不許憑空發揮
`;

// ─── LLM call ────────────────────────────────────────────
async function callLLM(
    apiConfig: ApiConfig, prompt: string, temperature: number, maxTokens: number = 4000,
): Promise<string | null> {
    try {
        const t0 = Date.now();
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: 'user', content: prompt }],
                temperature,
                max_tokens: maxTokens,
            }),
        });
        if (!response.ok) {
            console.error(`[Handbook v2] HTTP ${response.status} ${response.statusText}`);
            return null;
        }
        const data = await safeResponseJson(response);
        const raw: string = data.choices?.[0]?.message?.content || '';
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[Handbook v2] LLM 返回 ${raw.length} chars (${elapsed}s)`);
        return raw.trim();
    } catch (e) {
        console.error('[Handbook v2] LLM call failed:', e);
        return null;
    }
}

function parseLLMJson(raw: string): any | null {
    let s = raw.trim()
        .replace(/^```(?:json|JSON)?\s*\n?/gm, '')
        .replace(/\n?```\s*$/gm, '').trim();
    try { return JSON.parse(s); }
    catch { try { return extractJson(s); } catch { return null; } }
}

// ─── filled slot 內部表示 ────────────────────────────────
interface FilledSlot {
    slotId: string;
    slotRole: SlotRole;
    /** 文本內容 (有些 role 沒有, 走 payload) */
    text: string;
    payload?: SlotPayload;
    /** 'user' 或 charId */
    authorKind: 'user' | 'char';
    authorName: string;
    charId?: string;
    refersTo?: string;
}

// ─── 渲染 "已填上下文" 給下一輪 LLM 看 ────────────────────
function renderFilledContext(filled: FilledSlot[]): string {
    if (filled.length === 0) return '【已填的槽】(暫無)';
    const lines: string[] = ['【已填的槽 — 你可以引用這些內容】'];
    for (const f of filled) {
        const preview = f.text || (f.payload ? JSON.stringify(f.payload).slice(0, 80) : '');
        lines.push(`  [${f.slotId}] (${f.slotRole}, by ${f.authorName}): ${preview}`);
    }
    return lines.join('\n');
}

function renderRemainingSlots(remaining: SlotDef[], authorKind: 'user' | 'char'): string {
    const eligible = remaining.filter(s => s.eligibleAuthors.includes(authorKind));
    if (eligible.length === 0) return '【你能填的槽】(無 — 該 pass)';
    return ['【剩餘可填的槽】'].concat(eligible.map(describeSlotForPrompt)).join('\n');
}

// ─── 1. user 槽 — 僅當 user 今天有聊天才跑, 只填 1~2 個最該填的 ────
//
// 行為:
//  - user 今天沒聊過任何東西 → 返回 [], 整個 user 步跳過 (不留假佔位)
//  - 有聊過 → 讓 LLM 在 user-eligible 槽裡挑 2~4 個最適合的, 填掉
async function fillUserSlots(
    template: LayoutTemplate,
    date: string,
    selectedCharIds: string[],
    characters: CharacterProfile[],
    userProfile: UserProfile,
    apiConfig: ApiConfig,
): Promise<FilledSlot[]> {
    const userName = userProfile.name || '我';
    const slots = template.pages.flat().filter(s => s.eligibleAuthors.includes('user'));
    if (slots.length === 0) return [];

    // 收集 user 今日素材
    const transcriptParts: string[] = [];
    let totalUserMsgs = 0;
    for (const charId of selectedCharIds) {
        const c = characters.find(ch => ch.id === charId);
        if (!c) continue;
        const { lines, userMsgCount } = await todayChatLines(c, date, userName);
        totalUserMsgs += userMsgCount;
        if (lines.length === 0) continue;
        const trimmed = lines.length > 50 ? lines.slice(-50) : lines;
        transcriptParts.push(`== 與「${c.name}」==\n${trimmed.join('\n')}`);
    }

    // user 今天什麼都沒說 → 直接跳過, 不留假貨
    if (totalUserMsgs === 0) {
        console.log(`[Handbook v2] ╳ user 步跳過 — ${userName} 今天沒素材`);
        return [];
    }
    console.log(`[Handbook v2] ▶ user "${userName}" 步開始 — userMsgs=${totalUserMsgs}, 候選槽=${slots.length} 個 (${slots.map(s => `${s.id}/${s.slotRole}`).join(', ')})`);

    const dow = dayOfWeekZh(date);
    const slotBlock = slots.map(describeSlotForPrompt).join('\n');
    const schemaExamples = slots.slice(0, 4).map(s => slotOutputSchema(s.slotRole)).join(',\n  ');

    const prompt = `今天是 ${date} (星期${dow})。你是「${userName}」的私人手帳代筆。
這是 ${userName} 跟一群角色共寫的一本手帳, 不是只有 ${userName} 在寫。
請你基於 ${userName} 今天的真實對話, **挑 2~4 個最有素材可填的 user 槽**, 用 ${userName} 的第一人稱填好。每個槽都要落到 charBudget 區間。沒素材的槽不要硬擠, 留給角色或留白。

${slotBlock}

${TODAY_ONLY_RULE}

【輸出 JSON 數組】1~2 個元素, 形如:
[
  ${schemaExamples}
]

字段說明:
- slotId 必須是上面列出來的 id
- text: 純文本 (適用 hero-diary / corner-note / mood-card 等)
- payload: 結構化數據 (適用 todo / gratitude / timeline-plan / mood-card / photo-caption)
- 字數硬卡: text 長度落在 charBudget 區間內
- 優先選 user 今天聊天裡有具體素材的槽, 沒素材的不要填
- 不要 emoji 開頭, 不要標題

【今日對話素材】
${transcriptParts.join('\n\n')}

直接輸出 JSON 數組。`;

    const raw = await callLLM(apiConfig, prompt, 0.75);
    if (!raw) {
        console.error(`[Handbook v2] ✗ user "${userName}" — LLM 返回空`);
        return [];
    }
    console.log(`[Handbook v2] user 原始 LLM 響應:\n${raw.length > 800 ? raw.slice(0, 800) + '\n…(截斷)' : raw}`);
    const parsed = parseLLMJson(raw);
    if (!Array.isArray(parsed)) {
        console.error(`[Handbook v2] ✗ user — JSON 解析失敗 / 不是數組, 類型=${typeof parsed}`);
        return [];
    }

    const filled: FilledSlot[] = [];
    const dropped: string[] = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') { dropped.push('非對象'); continue; }
        const slotId = String(item.slotId || '').toUpperCase();
        const slot = slots.find(s => s.id === slotId);
        if (!slot) { dropped.push(`未知 slotId=${slotId}`); continue; }
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        const payload = sanitizePayload(item.payload, slot.slotRole);
        if (!text && !payload) { dropped.push(`${slotId} 內容空`); continue; }
        filled.push({
            slotId: slot.id,
            slotRole: slot.slotRole,
            text: clampText(text, slot.charBudget),
            payload,
            authorKind: 'user',
            authorName: userName,
        });
        if (filled.length >= 5) break;       // 模型偶爾超額, 客戶端硬卡 (允許填多, 但留一些給角色)
    }
    console.log(`[Handbook v2] ◀ user "${userName}" 完成 — 填了 ${filled.length} 個槽 [${filled.map(f => `${f.slotId}/${f.slotRole}`).join(', ')}]${dropped.length ? `, 丟棄 ${dropped.length} 條 (${dropped.join('; ')})` : ''}`);
    for (const f of filled) {
        const preview = f.text || (f.payload ? `[payload:${f.payload.kind}]` : '');
        console.log(`[Handbook v2]   • [${f.slotId}] ${f.slotRole}: ${preview.length > 60 ? preview.slice(0, 60) + '…' : preview}`);
    }
    return filled;
}

function clampText(text: string, [_min, max]: [number, number]): string {
    if (text.length <= max) return text;
    // 優先在標點處截斷
    const slice = text.slice(0, max);
    const lastPunct = Math.max(
        slice.lastIndexOf('。'), slice.lastIndexOf('!'), slice.lastIndexOf('?'),
        slice.lastIndexOf('.'), slice.lastIndexOf(','), slice.lastIndexOf(','),
    );
    return lastPunct > max - 30 ? slice.slice(0, lastPunct + 1) : slice + '…';
}

function sanitizePayload(p: any, role: SlotRole): SlotPayload | undefined {
    if (!p || typeof p !== 'object') return undefined;
    const kind = p.kind;
    if (role === 'todo' && kind === 'todo' && Array.isArray(p.items)) {
        const items = p.items
            .map((it: any) => {
                if (typeof it === 'string') return { text: it.trim(), done: false };
                if (it && typeof it === 'object' && typeof it.text === 'string') {
                    return { text: it.text.trim(), done: !!it.done };
                }
                return null;
            })
            .filter((x: any) => x && x.text);
        return items.length > 0 ? { kind: 'todo', items } : undefined;
    }
    if (role === 'gratitude' && kind === 'gratitude' && Array.isArray(p.items)) {
        const items = p.items.map((s: any) => String(s || '').trim()).filter(Boolean);
        return items.length > 0 ? { kind: 'gratitude', items } : undefined;
    }
    if (role === 'timeline-plan' && kind === 'timeline' && Array.isArray(p.items)) {
        const items = p.items
            .map((it: any) => {
                if (!it || typeof it !== 'object') return null;
                const time = String(it.time || '').trim();
                const text = String(it.text || '').trim();
                if (!time || !text) return null;
                const emoji = typeof it.emoji === 'string' ? it.emoji.trim() : undefined;
                return { time, text, emoji };
            })
            .filter(Boolean);
        return items.length > 0 ? { kind: 'timeline', items } : undefined;
    }
    if (role === 'mood-card' && kind === 'mood') {
        const rating = Math.max(1, Math.min(5, Math.round(Number(p.rating) || 3)));
        const tag = typeof p.tag === 'string' ? p.tag.trim() : undefined;
        return { kind: 'mood', rating, tag };
    }
    if (role === 'photo-caption' && kind === 'photo') {
        const caption = String(p.caption || '').trim();
        const src = typeof p.src === 'string' ? p.src : undefined;
        return caption ? { kind: 'photo', caption, src } : undefined;
    }
    return undefined;
}

// ─── 2. char 步 — 單次 LLM 調用填多個槽 ────────────────────
//
// 設計:
//  - 一次 LLM 調用返回一組 (3~5 條) ta 今天的內容 — 像生活系角色"今日小生活"
//  - 自由發揮: hero-diary / mood-card / 多個 corner-note / 可選 sticky-reaction
//  - 生活系角色被鼓勵 "造謠" 自己今天的日常 (跟 user 無關), 不能假裝今天和 user 一起做了什麼
//  - sticky-reaction 必須有 refersTo, filled 全空時自動剔除該 role 候選
//  - 必須寫, 不能 pass; LLM 爛數據 → 重試一次 → 仍爛才靜默丟
async function fillCharTurn(
    char: CharacterProfile,
    template: LayoutTemplate,
    filled: FilledSlot[],
    date: string,
    userProfile: UserProfile,
    apiConfig: ApiConfig,
): Promise<FilledSlot[]> {
    let remaining = template.pages.flat().filter(s =>
        !filled.find(f => f.slotId === s.id) && s.eligibleAuthors.includes('char')
    );
    // sticky-reaction 沒東西可引 → 踢出候選 (沒法滿足 refersTo)
    if (filled.length === 0) {
        remaining = remaining.filter(s => s.slotRole !== 'sticky-reaction');
    }
    console.log(`[Handbook v2] ▶ char "${char.name}" 步開始 — 剩餘可填槽 ${remaining.length} 個 [${remaining.map(s => `${s.id}/${s.slotRole}`).join(', ')}]`);
    if (remaining.length === 0) {
        console.log(`[Handbook v2] ╳ char "${char.name}" — 沒槽可填, 跳過`);
        return [];
    }

    const userName = userProfile.name || 'user';
    const dow = dayOfWeekZh(date);
    const coreContext = ContextBuilder.buildCoreContext(char, userProfile, true);

    // 抽 ta 平時怎麼說話的樣本
    let speechSamples: string[] = [];
    try {
        const all = await loadCharacterContextMessages(char);
        const charMsgs = all.filter((m: any) =>
            m.role === 'assistant'
            && typeof m.content === 'string'
            && m.content.length > 4
            && m.content.length < 400
            && !(m.content.trim().startsWith('{') && m.content.trim().endsWith('}'))
        );
        if (charMsgs.length <= 25) {
            speechSamples = charMsgs.map((m: any) => m.content.slice(0, 180));
        } else {
            const step = charMsgs.length / 25;
            for (let i = 0; i < 25; i++) {
                speechSamples.push(charMsgs[Math.floor(i * step)].content.slice(0, 180));
            }
        }
    } catch {}

    // 該 char 今天有沒有跟 user 聊過 (有素材才允許寫 sticky-reaction 引 user 的槽)
    const { lines: todayLines } = await todayChatLines(char, date, userName);

    const speechBlock = speechSamples.length > 0
        ? `\n【⚠️ ${char.name} 平時怎麼說話 — 嚴格模仿語氣/用詞/句式/口頭禪, 不像 ta 整組判廢】\n${speechSamples.map((s, i) => `[${i + 1}] ${s}`).join('\n')}\n`
        : '';

    const todayChatBlock = todayLines.length > 0
        ? `\n【今天 ${char.name} 跟 ${userName} 的對話片段 — 僅供參考, 是 *今天* 真實發生的】\n${todayLines.slice(-25).join('\n')}\n`
        : `\n【⚠️ ${char.name} 今天沒和 ${userName} 說過話】沒關係 — 寫你自己今天的生活就好 (生活流可以"造謠": 早起喝什麼、誰路過、刷到什麼、忽然想起什麼…只要符合人設)。\n`;

    const filledBlock = renderFilledContext(filled);
    const remainingBlock = renderRemainingSlots(remaining, 'char');

    // 列 char-eligible 槽的 schema 例子 (按 role 去重顯示)
    const seenRoles = new Set<string>();
    const exampleSchemas = remaining
        .filter(s => {
            if (seenRoles.has(s.slotRole)) return false;
            seenRoles.add(s.slotRole); return true;
        })
        .slice(0, 5)
        .map(s => `  - ${s.slotRole}: ${slotOutputSchema(s.slotRole)}`)
        .join('\n');

    // 一次目標填多少: 看剩餘槽位多少, 角色越靠後填得越少 (前面已經填掉一些)
    const targetMin = Math.min(2, remaining.length);
    const targetMax = Math.min(5, remaining.length);

    const prompt = `今天是 ${date} (星期${dow})。這是一本 *大家共寫* 的手帳, 你 (角色「${char.name}」) 在這一頁留下你今天的筆跡。

【你的人格檔案】
${coreContext}
${speechBlock}${todayChatBlock}

${filledBlock}

${remainingBlock}

${TODAY_ONLY_RULE}

【這一輪你要做什麼】
你今天會在這本手帳上**留 ${targetMin}~${targetMax} 條筆跡** (一次性, 不分輪)。每條都是一個槽位的填充。
內容主體應該是**寫你自己今天**:
  - 1 條 hero-diary 或 mood-card: 你今天的主線 (生活片段 / 心情)
  - 多條 corner-note: 散落的小獨白、看到的、想到的、口頭禪式碎句
  - 0~2 條 sticky-reaction: 看到 "已填" 列表裡某條有反應, 寫便籤 (refersTo 必填)

【⚠️ 內容硬約束】
- **可以"造謠"自己今天的生活流** — 早起做了什麼、看到什麼、買了什麼、刷到什麼、誰路過、突然想到什麼…只要符合人設, 大膽寫
- 但**不要虛構和 ${userName} 的共同事件** (沒見面就不能編"我們一起去了…")
- 不要把過去的回憶當今天的事講
- 不要把 ${userName} 當主語 ("想念 ${userName}" / "等 ${userName}" 通通禁絕)
- 嚴格模仿你的說話樣本 — 語氣/用詞/句式/標點/口頭禪
- 不要 emoji 開頭, 不要標題, 不要 ** 加粗 (除偶爾筆感修飾)

【輸出 JSON 數組】${targetMin}~${targetMax} 個對象。每個對象一個槽, 形如:
[
${exampleSchemas}
]

字段說明:
- slotId 必須是上面 "剩餘可填的槽" 裡列出的 id
- 每個 slotId 在你這一組裡只能出現一次
- text 必填 (除 photo-caption 走 payload), 長度落在該槽 charBudget 區間
- sticky-reaction 必須 refersTo 引用 "已填" 列表裡的某 slotId
- 不要 pass / 空內容 / 佔位文本

直接輸出 JSON 數組。`;

    // 一次主調 + 最多一次重試
    let attempt = 0;
    while (attempt < 2) {
        const isRetry = attempt > 0;
        const finalPrompt = isRetry
            ? prompt + `\n\n【⚠️ 重試】上一次響應沒產出有效內容 (slotId 錯 / 數組空 / sticky 沒 refersTo)。再試一次, 必須返回 ${targetMin}~${targetMax} 個有效對象的數組。`
            : prompt;
        if (isRetry) console.warn(`[Handbook v2] ⟳ char "${char.name}" — 重試 (第 ${attempt + 1} 次)`);
        const raw = await callLLM(apiConfig, finalPrompt, 0.85, 6000);
        attempt++;
        if (!raw) {
            console.error(`[Handbook v2] ✗ char "${char.name}" — LLM 返回空`);
            continue;
        }
        console.log(`[Handbook v2] char "${char.name}" 原始 LLM 響應:\n${raw.length > 1000 ? raw.slice(0, 1000) + '\n…(截斷)' : raw}`);
        const parsed = parseLLMJson(raw);
        let arr: any[];
        if (Array.isArray(parsed)) arr = parsed;
        else if (parsed && typeof parsed === 'object' && 'slotId' in parsed) arr = [parsed];   // 單對象兜底
        else {
            console.error(`[Handbook v2] ✗ char "${char.name}" — JSON 解析失敗 / 不是數組, 類型=${typeof parsed}`);
            continue;
        }

        const out: FilledSlot[] = [];
        const usedSlotIds = new Set<string>();
        const dropped: string[] = [];

        for (const item of arr) {
            if (!item || typeof item !== 'object') { dropped.push('非對象'); continue; }
            const slotId = String(item.slotId || '').toUpperCase();
            if (usedSlotIds.has(slotId)) { dropped.push(`${slotId} 重複`); continue; }       // 同 slot 不能重複
            const slot = remaining.find(s => s.id === slotId);
            if (!slot) { dropped.push(`未知 slotId=${slotId}`); continue; }
            const text = typeof item.text === 'string' ? item.text.trim() : '';
            const payload = sanitizePayload(item.payload, slot.slotRole);
            if (!text && !payload) { dropped.push(`${slotId} 內容空`); continue; }

            let refersTo: string | undefined;
            if (slot.slotRole === 'sticky-reaction') {
                refersTo = String(item.refersTo || '').toUpperCase();
                // 引用必須在 "filled" (此次新填的不算, 不允許自引環)
                const exists = filled.find(f => f.slotId === refersTo);
                if (!exists) {
                    dropped.push(`${slotId} sticky refersTo=${refersTo || '空'} 無效`);
                    continue;
                }
            }

            usedSlotIds.add(slotId);
            out.push({
                slotId: slot.id,
                slotRole: slot.slotRole,
                text: clampText(text, slot.charBudget),
                payload,
                authorKind: 'char',
                authorName: char.name,
                charId: char.id,
                refersTo,
            });
        }

        if (out.length > 0) {
            console.log(`[Handbook v2] ◀ char "${char.name}" 完成 — 填了 ${out.length} 個槽 [${out.map(f => `${f.slotId}/${f.slotRole}`).join(', ')}]${dropped.length ? `, 丟棄 ${dropped.length} 條 (${dropped.join('; ')})` : ''}`);
            for (const f of out) {
                const preview = f.text || (f.payload ? `[payload:${f.payload.kind}]` : '');
                console.log(`[Handbook v2]   • [${f.slotId}] ${f.slotRole}${f.refersTo ? ` →${f.refersTo}` : ''}: ${preview.length > 80 ? preview.slice(0, 80) + '…' : preview}`);
            }
            return out;
        }
        console.error(`[Handbook v2] ✗ char "${char.name}" 第 ${attempt} 次沒出有效內容${dropped.length ? `, 丟棄: ${dropped.join('; ')}` : ''}`);
    }
    console.error(`[Handbook v2] ╳ char "${char.name}" 兩次都不行 — 這一格留白`);
    return [];
}

// ─── 3. 主入口: composePageV2 ────────────────────────────
export interface ComposeV2Input {
    date: string;
    selectedCharIds: string[];
    characters: CharacterProfile[];
    userProfile: UserProfile;
    apiConfig: ApiConfig;
    /** 強制使用某模板 id, 不傳則按條件自動選 */
    forcedTemplateId?: string;
    /** 一天最多讓幾個角色參與 (默認 6 — 尊重 user 選擇, 選了幾個就跑幾個) */
    maxChars?: number;
    /** 進度回調 — 給 UI 用 */
    onProgress?: (info: { stage: 'user' | 'char'; name: string; i: number; n: number }) => void;
}

export interface ComposeV2Result {
    pages: HandbookPage[];
    layouts: HandbookLayout[];
    templateId: string;
    /** debug: 哪些槽留白了 */
    skippedSlotIds: string[];
    /** 實際參與的 char ids (被 cap 截掉的不在內) */
    participatingCharIds: string[];
}

const DEFAULT_MAX_CHARS = 6;

export async function composePageV2(input: ComposeV2Input): Promise<ComposeV2Result> {
    const { date, characters, userProfile, apiConfig, forcedTemplateId, onProgress } = input;
    const maxChars = Math.max(0, input.maxChars ?? DEFAULT_MAX_CHARS);
    const userName = userProfile.name || '我';

    console.log('═══════════════════════════════════════════════════════');
    console.log(`[Handbook v2] 🟣 composePageV2 啟動 — date=${date}`);
    console.log(`[Handbook v2] 候選角色 (${input.selectedCharIds.length} 個): [${input.selectedCharIds.map(id => characters.find(c => c.id === id)?.name || id).join(', ')}]`);
    console.log(`[Handbook v2] maxChars=${maxChars} (${input.maxChars !== undefined ? '調用方傳入' : '默認 ' + DEFAULT_MAX_CHARS})`);

    // ─── 1. 決定哪些 char 參與 (按今日聊天活躍度排序, cap N) ──
    const charsWithActivity: { id: string; userMsgs: number; charMsgs: number }[] = [];
    for (const cid of input.selectedCharIds) {
        const c = characters.find(x => x.id === cid);
        if (!c) continue;
        const { lines, userMsgCount } = await todayChatLines(c, date, userName);
        charsWithActivity.push({
            id: cid,
            userMsgs: userMsgCount,
            charMsgs: lines.length - userMsgCount,
        });
    }
    // 排序: 今日總活躍度降序 → 優先讓 "今天真有素材" 的角色參與
    charsWithActivity.sort((a, b) =>
        (b.userMsgs + b.charMsgs) - (a.userMsgs + a.charMsgs)
    );
    const participating = charsWithActivity.slice(0, maxChars);
    const totalUserMsgs = charsWithActivity.reduce((s, x) => s + x.userMsgs, 0);

    console.log(`[Handbook v2] 活躍度排序後:`);
    for (const x of charsWithActivity) {
        const c = characters.find(ch => ch.id === x.id);
        console.log(`[Handbook v2]   - ${c?.name || x.id}: userMsgs=${x.userMsgs}, charMsgs=${x.charMsgs}`);
    }
    if (charsWithActivity.length > maxChars) {
        const cut = charsWithActivity.slice(maxChars);
        console.warn(`[Handbook v2] ⚠ 候選超過 maxChars(${maxChars}), 砍掉 ${cut.length} 個: [${cut.map(x => characters.find(c => c.id === x.id)?.name).join(', ')}]`);
    }
    console.log(`[Handbook v2] 實際參與 (${participating.length}): [${participating.map(p => characters.find(c => c.id === p.id)?.name).join(', ')}]`);
    console.log(`[Handbook v2] 總 user 消息數 (跨所有 char): ${totalUserMsgs}`);

    // ─── 2. roll layout ──
    let template = forcedTemplateId ? LAYOUT_TEMPLATES[forcedTemplateId] : null;
    if (!template) {
        template = pickTemplate({
            userMsgCount: totalUserMsgs,
            charCount: participating.length,
        });
    }
    console.log(`[Handbook v2] 選用版式: ${template.id} (${template.name}), 共 ${template.pages.flat().length} 槽位`);

    // ─── 3. 進度
    const userWillRun = totalUserMsgs > 0;
    const totalTurns = (userWillRun ? 1 : 0) + participating.length;
    let turnIdx = 0;
    const tick = (stage: 'user' | 'char', name: string) => {
        turnIdx++;
        onProgress?.({ stage, name, i: turnIdx, n: totalTurns });
    };

    const filled: FilledSlot[] = [];

    // ─── 4. user 步 (僅當有今日聊天) ──
    if (userWillRun) {
        tick('user', userName);
        const userFilled = await fillUserSlots(
            template, date, input.selectedCharIds, characters, userProfile, apiConfig,
        );
        filled.push(...userFilled);
    }

    // ─── 5. chars 順序輪 (每個 char 一次 LLM 調用, 出 2~5 條 fragment) ──
    for (const { id } of participating) {
        const c = characters.find(x => x.id === id);
        if (!c) continue;
        tick('char', c.name);
        const charFills = await fillCharTurn(c, template, filled, date, userProfile, apiConfig);
        filled.push(...charFills);
    }

    // ─── 6. 收尾 ──
    const allSlots = template.pages.flat();
    const skippedSlotIds = allSlots
        .filter(s => !filled.find(f => f.slotId === s.id))
        .map(s => s.id);

    console.log(`[Handbook v2] 🟢 完成 — 共填 ${filled.length}/${allSlots.length} 個槽`);
    const byAuthor: Record<string, number> = {};
    for (const f of filled) byAuthor[f.authorName] = (byAuthor[f.authorName] || 0) + 1;
    console.log(`[Handbook v2] 按作者: ${Object.entries(byAuthor).map(([a, n]) => `${a}=${n}`).join(', ')}`);
    if (skippedSlotIds.length > 0) {
        console.log(`[Handbook v2] 留白槽 (${skippedSlotIds.length}): [${skippedSlotIds.join(', ')}]`);
    }
    console.log('═══════════════════════════════════════════════════════');

    const result = buildPagesAndLayout(template, filled, date);
    return {
        ...result,
        templateId: template.id,
        skippedSlotIds,
        participatingCharIds: participating.map(p => p.id),
    };
}

// ─── filled → HandbookPage[] + HandbookLayout ────────────
//
// 舊渲染管道吃 HandbookPage[] (有 fragments) + HandbookLayout (placements 指 fragment).
// 我們讓每個作者一份 HandbookPage, fragments 是 ta 填的所有槽; placements 按
// SlotDef 的位置生成, 同時把 SlotRole / payload 傳進 fragment.
function buildPagesAndLayout(
    template: LayoutTemplate,
    filled: FilledSlot[],
    date: string,
): { pages: HandbookPage[]; layouts: HandbookLayout[] } {
    const allSlots = template.pages.flat();
    // 按作者分組 → 一個 HandbookPage / 作者
    const byAuthor: Map<string, FilledSlot[]> = new Map();
    for (const f of filled) {
        const key = f.authorKind === 'user' ? '__user__' : (f.charId || `__char__${f.authorName}`);
        if (!byAuthor.has(key)) byAuthor.set(key, []);
        byAuthor.get(key)!.push(f);
    }

    const pages: HandbookPage[] = [];
    const placements: LayoutPlacement[] = [];

    for (const [key, fs] of byAuthor.entries()) {
        const isUser = key === '__user__';
        const charId = isUser ? undefined : fs[0].charId;
        const pageId = isUser
            ? `udiary-${date}-${Date.now()}`
            : `lifestream-${charId || fs[0].authorName}-${date}-${Date.now()}`;

        const fragments: HandbookFragment[] = fs.map((f, i) => ({
            id: `frag-${pageId}-${i}-${f.slotId}`,
            text: f.text,
            slotId: f.slotId,
            slotRole: f.slotRole,
            authorKind: f.authorKind,
            refersTo: f.refersTo,
            payload: f.payload,
        }));

        const content = fs.map(f => f.text || (f.payload ? JSON.stringify(f.payload) : '')).filter(Boolean).join('\n\n');

        const page: HandbookPage = {
            id: pageId,
            type: isUser ? 'user_diary' : 'character_life',
            charId,
            content,
            fragments,
            paperStyle: template.paperStyle || 'plain',
            generatedBy: 'llm',
            generatedAt: Date.now(),
        };
        pages.push(page);

        // placements
        for (const f of fs) {
            const slot = allSlots.find(s => s.id === f.slotId);
            if (!slot) continue;
            const fragId = fragments.find(fr => fr.slotId === f.slotId)?.id;
            placements.push({
                pageId, fragmentId: fragId,
                xPct: slot.xPct, yPct: slot.yPct, widthPct: slot.widthPct,
                rotate: slot.rotate ?? 0, zIndex: slot.zIndex ?? 10,
                role: slotRoleToLegacyRole(slot.slotRole),
                isHero: !!slot.isHero,
                slotId: slot.id, slotRole: slot.slotRole,
                maxHeightPct: slot.maxHeightPct, skinVariant: slot.skinVariant,
            });
        }
    }

    const layout: HandbookLayout = {
        pageNumber: 1,
        placements,
        generatedAt: Date.now(),
        templateId: template.id,
    };

    return { pages, layouts: [layout] };
}

// 新 SlotRole → 舊 LayoutRole 兜底 (老渲染器還在用)
function slotRoleToLegacyRole(role: SlotRole): 'main' | 'side' | 'corner' | 'margin' {
    switch (role) {
        case 'hero-diary': return 'main';
        case 'timeline-plan': return 'main';
        case 'todo': return 'main';
        case 'gratitude': return 'side';
        case 'mood-card': return 'side';
        case 'photo-caption': return 'side';
        case 'sticky-reaction': return 'corner';
        case 'corner-note': return 'margin';
    }
}

// ─── 4. 單角色重生 (v2) ───────────────────────────────────
//
// 用法: handleRegenerateLifestream 調它, 拿到只更新該角色 slot 的結果。
// 流程: 找回原 templateId → 把其它角色 + user 的 fills 當作 "已填" → 再調一次 fillCharTurn。
export interface RegenCharInput {
    date: string;
    charId: string;
    pages: HandbookPage[];           // 當前所有 page
    layouts: HandbookLayout[];       // 當前所有 layout
    characters: CharacterProfile[];
    userProfile: UserProfile;
    apiConfig: ApiConfig;
}

export interface RegenCharResult {
    /** 新的 page (替換原 charId 的那條 LLM page) */
    newPage: HandbookPage | null;
    /** 新的整體 layouts (替換 entry.layouts) */
    newLayouts: HandbookLayout[];
}

export async function regenerateCharSlots(input: RegenCharInput): Promise<RegenCharResult> {
    const { date, charId, pages, layouts, characters, userProfile, apiConfig } = input;
    const char = characters.find(c => c.id === charId);
    if (!char) return { newPage: null, newLayouts: layouts };

    // 找 templateId — v2 layout 必須有
    const v2Layout = layouts.find(l => l.templateId);
    if (!v2Layout?.templateId) return { newPage: null, newLayouts: layouts };
    const template = LAYOUT_TEMPLATES[v2Layout.templateId];
    if (!template) return { newPage: null, newLayouts: layouts };

    // 重建 "已填的所有 slot" — 包含 user + 其它 chars (排除被重生的 char)
    const filled: FilledSlot[] = [];
    const allSlots = template.pages.flat();
    for (const page of pages) {
        if (page.charId === charId) continue;       // 跳過被重生的
        if (!page.fragments) continue;
        for (const frag of page.fragments) {
            if (!frag.slotId) continue;
            const slot = allSlots.find(s => s.id === frag.slotId);
            if (!slot) continue;
            const author = page.charId
                ? (characters.find(c => c.id === page.charId)?.name || '某角色')
                : (userProfile.name || '我');
            filled.push({
                slotId: frag.slotId,
                slotRole: frag.slotRole || slot.slotRole,
                text: frag.text,
                payload: frag.payload,
                authorKind: page.charId ? 'char' : 'user',
                authorName: author,
                charId: page.charId,
                refersTo: frag.refersTo,
            });
        }
    }

    // 調 char turn (返回數組, 一次出多條 fragment)
    const newFills = await fillCharTurn(char, template, filled, date, userProfile, apiConfig);
    if (newFills.length === 0) return { newPage: null, newLayouts: layouts };

    // 拼新 char page (一組 fragments)
    const newPageId = `lifestream-${charId}-${date}-${Date.now()}`;
    const fragments: HandbookFragment[] = newFills.map((f, i) => ({
        id: `frag-${newPageId}-${i}-${f.slotId}`,
        text: f.text,
        slotId: f.slotId,
        slotRole: f.slotRole,
        authorKind: 'char',
        refersTo: f.refersTo,
        payload: f.payload,
    }));
    const newPage: HandbookPage = {
        id: newPageId,
        type: 'character_life',
        charId,
        content: newFills.map(f => f.text || (f.payload ? JSON.stringify(f.payload) : '')).filter(Boolean).join('\n\n'),
        fragments,
        paperStyle: template.paperStyle || 'plain',
        generatedBy: 'llm',
        generatedAt: Date.now(),
    };

    // 重建 v2 layout: 剔除該 char 舊的 placements, 加新的多條
    const otherPlacements = v2Layout.placements.filter(pl => {
        const ownerPage = pages.find(p => p.id === pl.pageId);
        return ownerPage?.charId !== charId;
    });
    const newPlacements: LayoutPlacement[] = [];
    for (const f of newFills) {
        const slot = allSlots.find(s => s.id === f.slotId);
        if (!slot) continue;
        const fragId = fragments.find(fr => fr.slotId === f.slotId)?.id;
        newPlacements.push({
            pageId: newPageId, fragmentId: fragId,
            xPct: slot.xPct, yPct: slot.yPct, widthPct: slot.widthPct,
            rotate: slot.rotate ?? 0, zIndex: slot.zIndex ?? 10,
            role: slotRoleToLegacyRole(slot.slotRole),
            isHero: !!slot.isHero,
            slotId: slot.id, slotRole: slot.slotRole,
            maxHeightPct: slot.maxHeightPct, skinVariant: slot.skinVariant,
        });
    }
    const newV2Layout: HandbookLayout = {
        ...v2Layout,
        placements: [...otherPlacements, ...newPlacements],
        generatedAt: Date.now(),
    };
    const newLayouts = layouts.map(l => l === v2Layout ? newV2Layout : l);
    return { newPage, newLayouts };
}

// ─── 5. 刪 / 編輯後重算 layout ────────────────────────────
//
// 舊的 composePageLayout 會重洗版式 — v2 不要。這個 helper:
//  1. 保留所有 v2 layouts 的 placement, 但剔除指向已刪除 page 的
//  2. user_note (用戶手寫) 走舊 composePageLayout 單獨排, 拼到 v2 之後
//
// 調用方: HandbookApp 裡 updatePage / handleDeletePage / handleAddNote 等
//
// 注: 這裡不依賴舊 composePageLayout (避免循環 import), HandbookApp 自己處理 user_note。
//     這個函數只負責 v2 部分的重算。
export function recomposeV2Layouts(
    layouts: HandbookLayout[],
    pages: HandbookPage[],
): HandbookLayout[] {
    return layouts
        .filter(l => l.templateId)
        .map(l => ({
            ...l,
            placements: l.placements.filter(pl => pages.some(p => p.id === pl.pageId)),
        }))
        .filter(l => l.placements.length > 0);
}
