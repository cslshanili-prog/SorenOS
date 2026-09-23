/**
 * 彼方·劇院 —— LLM 編排管線（腳本生成/潤色、演員意見收集、導演整合）。
 *
 * 把所有 LLM 調用集中在這裡，UI 只管交互。API 通道與彼方其它功能一致：
 * 角色無關的調用走 彼方獨立 API（getVRApi）→ 回落聊天默認 apiConfig；演員意見
 * 這種"角色自己說話"的調用，走 buildChatRequestPayload（ContextBuilder + 記憶宮殿）
 * 拿到該角色完整人設上下文，跟 runSession 自由活動一致。
 */

import type {
    CharacterProfile, UserProfile, GroupProfile, APIConfig, Emoji, EmojiCategory,
    VRScript, VRCastAssign, VRActorNote, VRStageMode,
} from '../../types';
import { DB } from '../db';
import { getVRApi } from './vrApi';
import { buildChatRequestPayload } from '../chatRequestPayload';
import { safeFetchJson } from '../safeApi';
import { STAGE_BUBBLE_MAX } from './constants';
import {
    buildLLMScriptTurn, buildPolishTurn, parseScriptOutput, type ParsedScript,
    buildActorReviewTurn, parseActorReview,
    buildActorsBatchTurn, parseActorsBatch,
    buildDirectorTurn, parseDirectorOutput, type ParsedDirector,
} from './prompts';

export interface TheaterApi { baseUrl: string; apiKey: string; model: string; }

/** 解析劇院要用的 API（彼方獨立 API → 聊天默認）。 */
export async function resolveTheaterApi(apiConfig: APIConfig): Promise<TheaterApi | null> {
    const vr = await getVRApi();
    const api = vr?.baseUrl ? vr : apiConfig;
    if (!api?.baseUrl) return null;
    return { baseUrl: api.baseUrl.replace(/\/+$/, ''), apiKey: api.apiKey || 'sk-none', model: api.model };
}

async function chat(api: TheaterApi, messages: Array<{ role: string; content: any }>, temperature = 0.9): Promise<string> {
    const data: any = await safeFetchJson(`${api.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({ model: api.model, messages, temperature, stream: false }),
    }, 2, 0, { appName: '彼方·劇院' });
    const c: string = data.choices?.[0]?.message?.content || '';
    return c.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** 角色無關上下文（UI 注入一次）。 */
export interface TheaterCtx {
    characters: CharacterProfile[];
    userProfile: UserProfile;
    groups: GroupProfile[];
    emojis: Emoji[];
    categories: EmojiCategory[];
}

/** 導演用的精簡人設：姓名 + 核心指令 + 世界觀/補充設定（OOC 已在演員重寫台詞那步處理）。 */
const directorPersona = (ch: CharacterProfile): string => [
    `姓名：${ch.name}`,
    `核心指令：${(ch.systemPrompt || '').trim() || '（無）'}`,
    (ch.worldview || '').trim() ? `世界觀 / 補充設定：${ch.worldview!.trim()}` : '',
].filter(Boolean).join('\n');

/** 較完整人設（核心性格 + 世界觀，不切片）—— 給"固定兩次"批量模式用，平衡長度。 */
const personaBrief = (ch: CharacterProfile): string =>
    [ch.systemPrompt, ch.worldview && `世界觀：${ch.worldview}`].filter(Boolean).join('\n').trim() || '（無設定）';

/** 用戶給個 brief（可帶寫作風格預設），讓 LLM 代寫一齣劇本。 */
export async function generateScript(brief: string, api: TheaterApi, presetPrompt?: string): Promise<ParsedScript> {
    return parseScriptOutput(await chat(api, [{ role: 'user', content: buildLLMScriptTurn(brief, presetPrompt) }]));
}

/** 按寫作風格預設 + 額外要求潤色重寫一份劇本正文。 */
export async function polishScript(body: string, presetPrompt: string, extra: string, api: TheaterApi): Promise<ParsedScript> {
    return parseScriptOutput(await chat(api, [{ role: 'user', content: buildPolishTurn(body, presetPrompt, extra) }]));
}

const castLineOf = (cast: VRCastAssign[]) => cast.map(c => `${c.actorName} 飾 ${c.roleName}`).join('；');

/** 逐角色模式：每個 char 演員各調一次 LLM（帶各自 ContextBuilder + 記憶），併發。 */
async function perRoleNotes(script: VRScript, cast: VRCastAssign[], charAssigns: VRCastAssign[], ctx: TheaterCtx, api: TheaterApi): Promise<VRActorNote[]> {
    const line = castLineOf(cast);
    return Promise.all(charAssigns.map(async (a): Promise<VRActorNote> => {
        const char = ctx.characters.find(c => c.id === a.actorId);
        if (!char) return { actorId: a.actorId, actorName: a.actorName, roleName: a.roleName, note: '（演員缺席）', cooperative: true };
        try {
            const contextLimit = char.contextLimit || 200;
            const historyMsgs = await DB.getRecentMessagesByCharId(char.id, contextLimit);
            const mates = cast.map(c => c.actorName).filter(n => n !== char.name);
            // 名字權重加重：重複同台演員名 + 顯式問關係/印象，便於召回角色之間的過往
            const recallQueryHint = mates.length > 0
                ? `彼方劇院和這些人同台演戲：${mates.join('、')}。\n${mates.join(' ')} ${mates.join(' ')}\n我對${mates.join('、')}的印象、我和 ta 們的關係與過往。`
                : `彼方劇院排戲《${script.title}》。`;
            const payload = await buildChatRequestPayload({
                char, userProfile: ctx.userProfile, groups: ctx.groups, emojis: ctx.emojis, categories: ctx.categories,
                historyMsgs, contextLimit, recallQueryHint,
            });
            const userTurn = buildActorReviewTurn(script.title, script.logline, script.body, a.roleName, line, char.name);
            const out = await chat(api, [{ role: 'system', content: payload.systemPrompt }, ...payload.cleanedApiMessages, { role: 'user', content: userTurn }]);
            const p = parseActorReview(out);
            return { actorId: char.id, actorName: char.name, roleName: a.roleName, note: p.note, lines: p.lines, taboo: p.taboo, direction: p.direction, attitude: p.attitude, cooperative: p.cooperative };
        } catch {
            return { actorId: char.id, actorName: char.name, roleName: a.roleName, note: '（沒能讀完劇本，先就位了）', attitude: '配合', cooperative: true };
        }
    }));
}

/** 兩次調用模式：一次讓 LLM 同時扮演所有 char 演員給意見（省，可能 OOC）。 */
async function batchNotes(script: VRScript, charAssigns: VRCastAssign[], ctx: TheaterCtx, api: TheaterApi): Promise<VRActorNote[]> {
    const castForBatch = charAssigns.map(a => {
        const ch = ctx.characters.find(c => c.id === a.actorId);
        return { roleName: a.roleName, actorName: a.actorName, persona: ch ? personaBrief(ch) : '' };
    });
    const sys = '你是一個多角色扮演引擎。下面會給你若干演員各自的人設，請分別站在他們各自的立場和性格回應，保持每人獨立、別串味，態度也別整齊劃一。';
    let parsed: Record<string, ReturnType<typeof parseActorReview>> = {};
    try {
        const out = await chat(api, [
            { role: 'system', content: sys },
            { role: 'user', content: buildActorsBatchTurn(script.title, script.logline, script.body, castForBatch) },
        ]);
        parsed = parseActorsBatch(out);
    } catch { /* 失敗則全體默認就位 */ }
    return charAssigns.map(a => {
        const p = parsed[a.actorName] || { note: '（沒給具體意見，聽導演的）', cooperative: true, lines: undefined, taboo: undefined, direction: undefined, attitude: '配合' };
        return { actorId: a.actorId, actorName: a.actorName, roleName: a.roleName, note: p.note, lines: p.lines, taboo: p.taboo, direction: p.direction, attitude: p.attitude, cooperative: p.cooperative };
    });
}

/**
 * 收集所有演員對劇本的意見。NPC 不調 LLM（直接就位），只有 char 演員吃調用。
 * per-role：char 數次併發調用（精準）；two-call：1 次批量（省）。
 */
export async function collectActorNotes(script: VRScript, cast: VRCastAssign[], mode: VRStageMode, ctx: TheaterCtx, api: TheaterApi): Promise<VRActorNote[]> {
    const charAssigns = cast.filter(c => !c.isNpc);
    const npcNotes: VRActorNote[] = cast.filter(c => c.isNpc).map(c => ({
        actorId: c.actorId, actorName: c.actorName, roleName: c.roleName, note: '（NPC 演員就位，聽導演調度）', attitude: '配合', cooperative: true,
    }));
    const charNotes = charAssigns.length === 0 ? []
        : mode === 'two-call' ? await batchNotes(script, charAssigns, ctx, api)
        : await perRoleNotes(script, cast, charAssigns, ctx, api);
    // 按 cast 順序歸位
    const byRole = new Map([...charNotes, ...npcNotes].map(n => [n.roleName + ' ' + n.actorId, n]));
    return cast.map(c => byRole.get(c.roleName + ' ' + c.actorId)!).filter(Boolean);
}

/** char 演員人數（= 這次編排會吃的 LLM 調用基數，導演再 +1）。 */
export function charActorCount(cast: VRCastAssign[]): number {
    return cast.filter(c => !c.isNpc).length;
}

/** 導演整合：原劇本 + 角色本色 + 演員自重寫台詞 + 用戶硬性要求 → 最終演出腳本 + 銳評 + 評級。 */
export async function runDirector(script: VRScript, cast: VRCastAssign[], notes: VRActorNote[], ctx: TheaterCtx, api: TheaterApi, userRequirement?: string): Promise<ParsedDirector> {
    // 給導演注入每位演員的本色，避免導演反手把角色寫 OOC
    const personas = cast.map(c => {
        if (c.isNpc) return { actorName: c.actorName, roleName: c.roleName, persona: '即興客串的 NPC，無固定人設，可自由塑造' };
        const ch = ctx.characters.find(x => x.id === c.actorId);
        return { actorName: c.actorName, roleName: c.roleName, persona: ch ? directorPersona(ch) : '（未知）' };
    });
    const out = await chat(api, [{
        role: 'user',
        content: buildDirectorTurn(
            script.title, script.logline, script.body,
            cast.map(c => ({ roleName: c.roleName, actorName: c.actorName })),
            personas, notes, STAGE_BUBBLE_MAX, userRequirement,
        ),
    }], 0.85);
    return parseDirectorOutput(out);
}
