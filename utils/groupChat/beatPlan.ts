/**
 * 群聊「各自發言」的出場表（2026-11-16）：一輪先排好誰說、按什麼順序說，再照表一個一個叫。
 *
 * 以前是兩波同時生成，每人各寫一大段，看不到彼此，結果像輪流上台報告。現在：
 * 1. 先用一次便宜的呼叫（副 API，沒設用全域）排出場表：`[{"speaker","intent"}]`，
 *    每一拍是一個人說一下（1～2 個氣泡）。同一個人一輪最多兩拍、不連著兩拍，不是每個人都要出場。
 * 2. 照表依序叫各成員自己的 API，每個人看得到前面剛說的話，只寫這一拍的 1～2 個氣泡。
 *
 * 排班失敗（沒回、格式壞、名字對不上）就退回「每人一拍、隨機順序」，不擋生成。
 * 這裡只排班、組提示詞、解析，不碰網絡。
 */
import { ROUND_BUBBLES_MAX, roundBubbleCap } from './prompts';
import type { APIConfig } from '../../types';

export interface BeatMember {
    id: string;
    name: string;
    /** 一句話的人設摘要，給排班的人知道誰是誰；可以空 */
    brief?: string;
    /** 配角／NPC：可以帶話題，但不搶戲 */
    supporting?: boolean;
}

export interface Beat {
    speakerId: string;
    /** 這一拍大概要做什麼（幕後安排）；退回的出場表是空字串 */
    intent: string;
}

/** 同一個人一輪最多幾拍 */
export const MAX_BEATS_PER_MEMBER = 2;

/**
 * 一輪最多幾拍：每拍 1～2 個氣泡，大約是氣泡上限 ÷ 1.5；至少 2 拍、最多 8 拍，也不超過每人兩拍。
 */
export function maxBeatsFor(roundBubbles: number | undefined, memberCount: number): number {
    const byBubbles = Math.round(roundBubbleCap(roundBubbles) / 1.5);
    const capped = Math.min(Math.round(ROUND_BUBBLES_MAX / 2), Math.max(2, byBubbles));
    return Math.max(1, Math.min(capped, memberCount * MAX_BEATS_PER_MEMBER));
}

const clip = (s: string | undefined, n: number): string => {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 人設摘要：角色的簡短說明優先，沒有就截人設開頭 */
export const memberBrief = (m: { description?: string; systemPrompt?: string }): string =>
    clip(m.description?.trim() ? m.description : m.systemPrompt, 80);

export function buildBeatPlanPrompt(input: {
    members: BeatMember[];
    historyText: string;
    maxBeats: number;
    /** 用戶這輪在旁觀（成員不知道有人在看） */
    userLurking?: boolean;
    /** 在場的真人群友（卡名）；空＝一位 */
    presentUsers?: string[];
    plotDirection?: string;
    /** 各自私下認識的人（knownPeople.ts），有就附上，排班時別把兩個「他」混在一起 */
    knownPeopleNote?: string;
}): string {
    const roster = input.members.map(m => {
        const tag = m.supporting ? '（配角）' : '';
        return `- ${m.name}${tag}${m.brief ? `：${m.brief}` : ''}`;
    }).join('\n');
    const users = input.presentUsers?.length ? input.presentUsers.map(n => `「${n}」`).join('') : '用戶';
    const scene = input.userLurking
        ? '- 用戶這一輪在旁觀，成員們不知道有人在看：別排人對著用戶說話，讓他們自己聊。'
        : `- 真人群友是${users}。用戶剛說了話的話，第一拍排最該接話的那個人。`;
    const plot = input.plotDirection?.trim()
        ? `- 幕後劇情方向（這一輪往這裡推，由最合適的人帶出來）：${input.plotDirection.trim()}`
        : '';
    return `### 【幕後排班：這一輪群聊誰說、按什麼順序說】
你是群聊的場記。你不寫台詞，只排這一輪的出場順序，之後每位成員會照順序、看著前面的話自己開口。

群成員：
${roster}
${input.knownPeopleNote?.trim() ? `\n${input.knownPeopleNote.trim()}\n` : ''}
最近聊天記錄：
${input.historyText || '（還沒有人說話）'}

排班規則：
- 排 2～${input.maxBeats} 拍。每一拍是一個人說一下（1～2 個氣泡），不是一整段。
- 每個人這一輪 0～${MAX_BEATS_PER_MEMBER} 拍；同一個人不要連著兩拍。跟這個話題扯不上的人可以不排，冷場時排 2 拍就夠。
- 像真人群聊：有人問、有人答、有人插嘴吐槽、有人只回個表情；後面的人接前面那句。**不要**排成每個人依序各說一段。
- 配角可以帶話題、接話，但不搶主角的戲。
${scene}
${plot ? `${plot}\n` : ''}- intent 用一句話寫這一拍大概做什麼（例如「回答小夏的問題」「吐槽前面那句」「只回個表情」「把話題帶回剛才的事」），不要寫台詞。

只輸出 JSON 陣列，不要別的字：
[{"speaker":"成員名字","intent":"這一拍做什麼"}]`;
}

const normName = (s: string) => s.replace(/\s+/g, '').replace(/^[「『"'【\[]+|[」』"'】\]]+$/g, '').toLowerCase();

/** 照名字找成員：完全相同 > 去空白／引號後相同 > 互相包含（唯一才算） */
function matchMember(name: string, members: BeatMember[]): BeatMember | undefined {
    const raw = name.trim();
    if (!raw) return undefined;
    const exact = members.find(m => m.name === raw);
    if (exact) return exact;
    const n = normName(raw);
    const norm = members.find(m => normName(m.name) === n);
    if (norm) return norm;
    const fuzzy = members.filter(m => {
        const mn = normName(m.name);
        return mn && n && (mn.includes(n) || n.includes(mn));
    });
    return fuzzy.length === 1 ? fuzzy[0] : undefined;
}

/** 套規則：每人最多兩拍、不連著同一人、總拍數不超過上限 */
export function enforceBeatRules(beats: Beat[], maxBeats: number): Beat[] {
    const out: Beat[] = [];
    const count = new Map<string, number>();
    for (const b of beats) {
        if (out.length >= maxBeats) break;
        if (out.length && out[out.length - 1].speakerId === b.speakerId) continue;
        const c = count.get(b.speakerId) || 0;
        if (c >= MAX_BEATS_PER_MEMBER) continue;
        count.set(b.speakerId, c + 1);
        out.push(b);
    }
    return out;
}

/** 解析排班結果；拿不出任何一拍就回 null（呼叫的人退回 fallbackBeatPlan） */
export function parseBeatPlan(raw: string, members: BeatMember[], maxBeats: number): Beat[] | null {
    const text = String(raw || '').replace(/```(?:json)?/gi, '');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) return null;
    let arr: unknown;
    try { arr = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
    if (!Array.isArray(arr)) return null;
    const beats: Beat[] = [];
    for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const name = String(o.speaker ?? o.name ?? o.charName ?? '');
        const m = matchMember(name, members);
        if (!m) continue;
        beats.push({ speakerId: m.id, intent: clip(String(o.intent ?? o.note ?? ''), 60) });
    }
    const ruled = enforceBeatRules(beats, maxBeats);
    return ruled.length ? ruled : null;
}

/** 退回的出場表：每人一拍、順序隨機（跟以前一樣每個人都有機會開口或跳過） */
export function fallbackBeatPlan(members: BeatMember[], maxBeats: number, random: () => number = Math.random): Beat[] {
    const order = [...members];
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    return order.slice(0, Math.max(1, maxBeats)).map(m => ({ speakerId: m.id, intent: '' }));
}

const usable = (c: Partial<APIConfig> | undefined): c is APIConfig => !!(c?.baseUrl?.trim() && c.model?.trim());

/** 排班用哪組 API：副 API（記憶宮殿那組 lightLLM）有設就用，不然用全域 */
export function resolveBeatPlanApi(apiConfig: APIConfig, lightLLM?: Partial<APIConfig>): APIConfig | null {
    if (usable(lightLLM)) return { ...apiConfig, baseUrl: lightLLM.baseUrl, apiKey: lightLLM.apiKey || '', model: lightLLM.model };
    if (usable(apiConfig)) return apiConfig;
    return null;
}
