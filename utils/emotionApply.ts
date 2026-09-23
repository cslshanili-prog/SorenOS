import { DB } from './db';
import type { CharacterProfile, CharacterBuff } from '../types';
import { landAmbientEventFromEval } from './roomAmbient';
import { CHAT_GEN_EVENTS } from './chatGenEvents';

// 情緒評估失敗的用戶可見信號（OSContext 監聽彈 toast）。本函數是本地 / instant(worker)
// 兩條路徑的共用落點，在這裡派發能覆蓋「worker 推回的 raw 解析全滅」這類雲端失敗。
const announceEmotionFailed = (charData: CharacterProfile, reason: string): void => {
    try {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(CHAT_GEN_EVENTS.emotionFailed, {
                detail: { charId: charData.id, charName: charData.name, reason },
            }));
        }
    } catch { /* SSR / 測試環境無 window */ }
};

// 角色「最後一次內心獨白(InnerState)」的輕量緩存（localStorage）。
// innerState 是瞬時產物，這裡在情緒評估落地的共用點順手緩存一份，供別處（如查手機首頁）讀取，
// 不額外動 CharacterProfile / DB schema。
export const lastInnerStateKey = (charId: string) => `sully_last_innerstate_${charId}`;
export function getLastInnerState(charId: string): string {
    try {
        return (typeof localStorage !== 'undefined' && localStorage.getItem(lastInnerStateKey(charId))) || '';
    } catch { return ''; }
}

// 情緒評估結果「解析 + 落 buff」的共用實現.
//
// 原本內聯在 hooks/useChatAI.ts 的 evaluateEmotionBackground 裡. 提取出來是為了讓兩條路徑共用:
//   1. 本地模式: 客戶端跑 eval LLM 拿到 raw, 調本函數落地.
//   2. instant 模式: worker 跑 eval LLM, 把 raw 作為 emotion_update push 推回, 客戶端 flush 時調本函數落地.
//
// 入參 rawText = LLM 返回的原始文本 (可能含 ```json 包裹). 返回 innerState (意識流) 字符串或 null,
// 調用方負責把它喂回下一輪 prompt (evolvedNarrative). buff 的應用 (寫 DB + 廣播 emotion-updated)
// 在本函數內完成.

const sanitizeBuffs = (buffs?: CharacterBuff[]): CharacterBuff[] => {
    if (!Array.isArray(buffs)) return [];
    return buffs
        .map((buff, index) => {
            let label = typeof buff?.label === 'string' ? buff.label.trim() : '';
            let name = typeof buff?.name === 'string' ? buff.name.trim() : '';
            // 模型偶爾漏 name (內部英文 id) 或漏 label (中文標籤) — 缺一半不該整條丟棄,
            // 用另一半兜底: name 缺就從 id/序號派生, label 缺就用 name 頂上.
            if (!label && !name) return null;
            if (!name) name = (typeof buff?.id === 'string' && buff.id.trim()) ? buff.id.trim() : `emotion_${index}`;
            if (!label) label = name;

            const rawIntensity = Number((buff as any)?.intensity);
            const intensity: 1 | 2 | 3 = !Number.isFinite(rawIntensity)
                ? 2
                : rawIntensity <= 1
                    ? 1
                    : rawIntensity >= 3
                        ? 3
                        : 2;

            const out: CharacterBuff = {
                id: typeof buff?.id === 'string' && buff.id.trim() ? buff.id.trim() : `buff_${Date.now()}_${index}`,
                name,
                label,
                intensity,
            };
            if (typeof buff?.emoji === 'string') out.emoji = buff.emoji;
            if (typeof buff?.color === 'string') out.color = buff.color;
            if (typeof buff?.description === 'string') out.description = buff.description;
            return out;
        })
        .filter((buff): buff is CharacterBuff => !!buff);
};

// ─── JSON 修復鏈 (全部 string-aware 逐字符掃描, 不用正則盲掃以免誤傷字符串內容) ───

// 修復 1: 把 JSON 字符串值裡的裸換行/製表符轉義, 兼容 LLM 偶爾吐未轉義控制字符的情況.
const repairControlChars = (s: string): string => {
    let inStr = false, esc = false, out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '"') { inStr = !inStr; out += ch; continue; }
        if (inStr && ch === '\n') { out += '\\n'; continue; }
        if (inStr && ch === '\r') { out += '\\r'; continue; }
        if (inStr && ch === '\t') { out += '\\t'; continue; }
        out += ch;
    }
    return out;
};

// 修復 2: 轉義字符串值內部的裸英文雙引號 (模型寫中文引語時常直接用 " 不轉義).
// 判定規則: 處於字符串內時遇到 ", 向後看第一個非空白字符 — 是 , : } ] 或到結尾才算真正的
// 閉合引號, 否則視為內容裡的裸引號, 轉成 \". 啟發式並不完美, 但只在直接 parse 失敗後才啟用.
const repairInnerQuotes = (s: string): string => {
    let inStr = false, esc = false, out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '"') {
            if (!inStr) { inStr = true; out += ch; continue; }
            let j = i + 1;
            while (j < s.length && /\s/.test(s[j])) j++;
            const next = j < s.length ? s[j] : '';
            if (next === '' || next === ',' || next === ':' || next === '}' || next === ']') {
                inStr = false; out += ch;
            } else {
                out += '\\"';
            }
            continue;
        }
        out += ch;
    }
    return out;
};

// 修復 3: 去掉 } / ] 前的尾逗號.
const stripTrailingCommas = (s: string): string => {
    let inStr = false, esc = false, out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc) { out += ch; esc = false; continue; }
        if (inStr) {
            if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            out += ch;
            continue;
        }
        if (ch === '"') { inStr = true; out += ch; continue; }
        if (ch === ',') {
            let j = i + 1;
            while (j < s.length && /\s/.test(s[j])) j++;
            if (s[j] === '}' || s[j] === ']') continue; // 丟棄尾逗號
        }
        out += ch;
    }
    return out;
};

// 修復 4: 補全被截斷的 JSON (max_tokens 截斷 / 響應中斷).
// 掃描記錄括號棧, 結尾時: 關掉未閉合字符串 → 去掉懸空的 , / 給懸空的 : 補 null → 逆序補閉合括號.
const closeTruncatedJson = (s: string): string => {
    let inStr = false, esc = false;
    const stack: string[] = [];
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc) { esc = false; continue; }
        if (inStr) {
            if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') {
            if (stack[stack.length - 1] === ch) stack.pop();
        }
    }
    let out = s;
    if (esc) out = out.slice(0, -1); // 截斷在反斜槓上, 丟掉半個轉義序列
    if (inStr) out += '"';
    out = out.replace(/[\s]+$/, '');
    if (out.endsWith(',')) out = out.slice(0, -1);
    if (out.endsWith(':')) out += ' null';
    while (stack.length) out += stack.pop();
    return out;
};

// 從原文裡定位第一個 { 並按括號平衡截取完整對象 (容忍前後夾雜閒聊文字, 後綴裡有 } 也不誤吞).
const extractBalancedObject = (raw: string): string | undefined => {
    const start = raw.indexOf('{');
    if (start < 0) return undefined;
    let inStr = false, esc = false, depth = 0;
    for (let i = start; i < raw.length; i++) {
        const ch = raw[i];
        if (esc) { esc = false; continue; }
        if (inStr) {
            if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return raw.slice(start, i + 1);
        }
    }
    return undefined;
};

export interface EmotionEvalResult {
    changed: boolean;
    buffs?: CharacterBuff[];
    injection?: string;
    innerState?: string;
    /** true = 整體 JSON.parse 全失敗, 靠字段級正則搶救出來的部分結果 */
    salvaged?: boolean;
}

const looksLikeEvalResult = (v: any): boolean =>
    !!v && typeof v === 'object' && !Array.isArray(v)
    && ('changed' in v || 'buffs' in v || 'injection' in v || 'innerState' in v);

const tryParseObject = (s: string): any | null => {
    try {
        const v = JSON.parse(s);
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
    } catch { return null; }
};

// 字段級搶救: 整體 parse 全滅時, 用帶轉義感知的正則把 innerState / injection / changed / buffs
// 單獨摳出來 — 寧可拿到部分結果, 也不要整輪情緒評估靜默蒸發.
const salvageFields = (repairedRaw: string): EmotionEvalResult | null => {
    const pickString = (key: string): string | undefined => {
        const m = repairedRaw.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`));
        if (!m || !m[1]) return undefined;
        let v: string;
        try { v = JSON.parse(`"${m[1]}"`); }
        catch {
            v = m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        v = v.trim();
        return v || undefined;
    };

    let buffs: CharacterBuff[] | undefined;
    const buffsIdx = repairedRaw.search(/"buffs"\s*:\s*\[/);
    if (buffsIdx >= 0) {
        const arrStart = repairedRaw.indexOf('[', buffsIdx);
        let inStr = false, esc = false, depth = 0;
        for (let i = arrStart; i < repairedRaw.length; i++) {
            const ch = repairedRaw[i];
            if (esc) { esc = false; continue; }
            if (inStr) {
                if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === '[') depth++;
            else if (ch === ']') {
                depth--;
                if (depth === 0) {
                    try {
                        const arr = JSON.parse(stripTrailingCommas(repairedRaw.slice(arrStart, i + 1)));
                        if (Array.isArray(arr)) buffs = arr;
                    } catch { /* 數組本身也爛, 放棄 buffs */ }
                    break;
                }
            }
        }
    }

    const injection = pickString('injection');
    const innerState = pickString('innerState');
    const changedMatch = repairedRaw.match(/"changed"\s*:\s*"?(true|false)"?/i);

    if (!injection && !innerState && !buffs) return null;
    const changed = changedMatch
        ? changedMatch[1].toLowerCase() === 'true'
        : !!(injection || buffs); // 搶救出了 injection/buffs 就當有變化, 只有 innerState 則不動 buff
    return { changed, buffs, injection, innerState, salvaged: true };
};

/**
 * 純解析層 (無副作用, 導出供測試): 從 LLM 原始輸出裡儘量摳出情緒評估結果.
 *
 * 候選片段 (依次嘗試): ```json 圍欄 → 裸 ``` 圍欄 → 未閉合圍欄 → 括號平衡對象 →
 * 貪婪首 { 尾 } → 首 { 到文末 (截斷). 每個候選跑修復鏈: 原樣 → 轉義裸控制字符 →
 * 轉義字符串內裸引號 → 去尾逗號 → 補全截斷. 全滅後走字段級正則搶救. 實在沒有 → null.
 */
export function parseEmotionEvalOutput(rawText: string): EmotionEvalResult | null {
    const raw = (rawText || '').trim();
    if (!raw) return null;

    const candidates: string[] = [];
    const pushCand = (s?: string) => {
        const t = (s || '').trim();
        if (t && t.includes('{') && !candidates.includes(t)) candidates.push(t);
    };
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fm: RegExpExecArray | null;
    while ((fm = fenceRe.exec(raw)) !== null) pushCand(fm[1]);
    const openFence = raw.match(/```(?:json)?\s*([\s\S]*)$/i);
    if (openFence) pushCand(openFence[1]); // 圍欄沒閉合 (輸出被截斷)
    pushCand(extractBalancedObject(raw));
    // 「首 { 到文末」要排在貪婪匹配之前: 截斷場景下貪婪會停在 buffs 裡最後一個 } 上,
    // 補全後只剩 changed+buffs, 把後面的 injection/innerState 全丟了; 而這個候選對
    // 完整 JSON + 尾巴閒聊的輸入必然 parse 失敗 (尾部有非 JSON 文本), 不會誤傷.
    const firstBrace = raw.indexOf('{');
    if (firstBrace >= 0) pushCand(raw.slice(firstBrace));
    const greedy = raw.match(/\{[\s\S]*\}/);
    if (greedy) pushCand(greedy[0]);

    let repairedForSalvage = '';
    for (const cand of candidates) {
        const c1 = repairControlChars(cand);
        const c2 = repairInnerQuotes(c1);
        const c3 = stripTrailingCommas(c2);
        const c4 = closeTruncatedJson(c3);
        if (!repairedForSalvage) repairedForSalvage = c3;
        for (const attempt of [cand, c1, c2, c3, c4]) {
            const v = tryParseObject(attempt);
            if (v && looksLikeEvalResult(v)) {
                // 模型偶爾把布爾寫成字符串 "true"/"false"
                const changed = v.changed === true || (typeof v.changed === 'string' && v.changed.toLowerCase() === 'true');
                return {
                    changed,
                    buffs: Array.isArray(v.buffs) ? v.buffs : undefined,
                    injection: typeof v.injection === 'string' ? v.injection : undefined,
                    innerState: typeof v.innerState === 'string' ? v.innerState : undefined,
                };
            }
        }
    }

    return salvageFields(repairedForSalvage || repairInnerQuotes(repairControlChars(raw)));
}

/**
 * 從 chat-completion 響應的 message 對象裡儘量摳出文本.
 * content 可能是字符串, 也可能是分塊數組 (部分 Claude 兼容代理); content 為空時回退
 * reasoning_content (個別代理開思考後把全部輸出塞進 reasoning, content 留空 —— 後續
 * parseEmotionEvalOutput 會從裡面正則定位 JSON, 喂進去無害).
 */
export function extractAssistantText(message: any): string {
    if (!message) return '';
    const c = message.content;
    if (typeof c === 'string' && c.trim()) return c;
    if (Array.isArray(c)) {
        const joined = c
            .map((p: any) => (typeof p === 'string' ? p : (p?.text || '')))
            .filter(Boolean)
            .join('\n');
        if (joined.trim()) return joined;
    }
    const r = message.reasoning_content;
    if (typeof r === 'string' && r.trim()) return r;
    return '';
}

/**
 * 解析情緒評估 raw 文本並落地 buff. 返回 innerState (意識流) 或 null.
 * - 解析失敗 → 返回 null, 不動 buff.
 * - changed=false → 不動 buff, 返回 innerState (若有).
 * - changed=true → sanitize buffs → DB.saveCharacter → 廣播 'emotion-updated' → 返回 innerState.
 * - changed=true 但 buffs / injection 雙缺失 (格式爛到只搶救出 innerState) → 不清空已有
 *   buff 狀態, 只返回 innerState —— 解析半殘不該把角色現有情緒底色抹掉.
 */
export async function applyEmotionEvalRaw(
    rawText: string,
    charData: CharacterProfile,
): Promise<string | null> {
    try {
        const result = parseEmotionEvalOutput(rawText || '');
        if (!result) {
            console.warn('🎭 [Emotion] Could not parse eval output (all repairs + salvage failed):', (rawText || '').slice(0, 300));
            announceEmotionFailed(charData, '評估模型的輸出不是可解析的 JSON（模型掉格式，可換個評估模型試試）');
            return null;
        }
        if (result.salvaged) {
            console.warn('🎭 [Emotion] Full JSON parse failed, salvaged fields:', {
                buffs: result.buffs?.length ?? 0,
                injection: !!result.injection,
                innerState: !!result.innerState,
            });
        }

        const innerStateOut = (typeof result.innerState === 'string' && result.innerState.trim())
            ? result.innerState.trim()
            : null;

        if (innerStateOut) {
            try { localStorage.setItem(lastInnerStateKey(charData.id), innerStateOut); } catch { /* ignore */ }
        }

        // 小屋生活動態（可選順風車產出，見 utils/roomAmbient.ts）：落 room_card 進私聊。
        // 本函數是在線 / instant(worker) 兩條路徑的共用落點，所以在這裡接。
        // 與情緒主鏈路完全解耦——失敗只丟這條動態，不影響 buff。
        await landAmbientEventFromEval(result, charData);

        if (!result.changed) {
            console.log('🎭 [Emotion] No change detected, skipping buff update');
            if (innerStateOut) console.log(`🌊 [InnerState] ${charData.name}: ${innerStateOut}`);
            return innerStateOut;
        }

        const hasBuffArray = Array.isArray(result.buffs);
        const hasInjection = typeof result.injection === 'string' && !!result.injection.trim();
        if (!hasBuffArray && !hasInjection) {
            // changed=true 但兩個載荷都沒拿到 — 保留現狀比清空安全
            console.warn('🎭 [Emotion] changed=true but no buffs/injection parsed, keeping existing state');
            if (innerStateOut) console.log(`🌊 [InnerState] ${charData.name}: ${innerStateOut}`);
            return innerStateOut;
        }

        // buffs 數組在場 → 完整更新 (數組為空 = 模型主動清空, 尊重).
        // buffs 缺失但 injection 在場 (搶救場景) → 保留舊 buffs, 只換 injection.
        const sanitizedBuffs = hasBuffArray ? sanitizeBuffs(result.buffs) : (charData.activeBuffs || []);
        const buffInjection = hasInjection ? result.injection! : (hasBuffArray ? '' : (charData.buffInjection || ''));
        const updated: CharacterProfile = {
            ...charData,
            activeBuffs: sanitizedBuffs,
            buffInjection,
        };
        await DB.saveCharacter(updated);

        // detail 直接帶上 buffs + buffInjection: 監聽方 (Chat) 可直接落 OSContext, 不必重讀 DB
        // —— 避開 saveCharacter 未等事務提交 / instant flush 下 DB 重讀偶發拿舊值的競態.
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('emotion-updated', {
                detail: { charId: charData.id, buffs: sanitizedBuffs, buffInjection },
            }));
        }
        console.log('🎭 [Emotion] Updated buffs:', sanitizedBuffs.map((b) => b.label).join(', ') || 'none');
        if (innerStateOut) console.log(`🌊 [InnerState] ${charData.name}: ${innerStateOut}`);
        return innerStateOut;
    } catch (e: any) {
        console.warn('🎭 [Emotion] applyEmotionEvalRaw failed:', e?.message);
        announceEmotionFailed(charData, `評估結果落庫失敗：${e?.message || '未知錯誤'}`);
        return null;
    }
}
