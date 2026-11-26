/**
 * 心意的生成（plans/bond-batch3.md 第 1、2 節）：角色答題、出題、丟紙條、回紙條；AI 推薦題目。
 * 提示詞本體在零依賴的 utils/bond/outputPromptCore.ts（第 3d 批雲端也用同一份），這裡只負責組上下文、叫模型。
 *
 * - 系統是角色的核心上下文（含羈絆段：路線、片刻、隨筆……），最後補路線鎖，跟隨筆同一條路。
 * - 盲答：角色答題時，提示詞根本不帶你這一輪封存的答案（buildCharAnswerPrompt 不收那個欄位）。
 */
import type { APIConfig, BondEntry, BondQuestionTopic } from '../../types';
import type { ResolvedSpace } from './space';
import { ContextBuilder } from '../../utils/context';
import { resolveCharacterChatApi } from '../../utils/characterApi';
import { globalMeterApi } from '../../utils/apiCenter';
import { extractContent, safeFetchJson } from '../../utils/safeApi';
import { bondFinalLock } from '../../utils/bond/prompt';
import { recentDailyLines } from '../../utils/bond/ourNow';
import { routeLabel, stageLabel } from '../../utils/bond/routes';
import { loadCharacterContextMessages } from '../../utils/chatContextRange';
import { normalizeMessageContent } from '../../utils/messageFormat';
import {
    buildCharAnswerPrompt, buildCharAskPrompt, buildQuestionSuggestPrompt, buildSlipPrompt, buildSlipReplyPrompt,
    parseCharAnswer, parseCharAsk, parseSlip, outputMaxTokens, type OutputContext,
    buildHabitReplyPrompt, buildPromiseReplyPrompt, buildWishReplyPrompt, parseHabitReply, parsePromiseReply, parseWishReply,
} from '../../utils/bond/outputPromptCore';
import { parseQuestionSuggestions, revealedRounds, visibleAnswer } from '../../utils/bond/question';
import { slipReplies } from '../../utils/bond/slip';
import { repeatLabel } from '../../utils/bond/pact';
import { resolveOutputChars, resolveOutputSetting } from '../../utils/bond/output';

/** 這段關係一句話：「友情線，現在是好朋友」 */
export function relationLineOf(space: ResolvedSpace): string {
    const b = space.bond;
    return `${routeLabel(b.route)}，現在是${stageLabel(b)}`;
}

/** 最近的總結＋最近一段私聊（這條線的） */
export async function heartContext(space: ResolvedSpace): Promise<OutputContext> {
    const view = space.view || space.char;
    const msgs = (await loadCharacterContextMessages(view).catch(() => [])).slice(-30);
    const recentChat = msgs.map(m => `${m.role === 'user' ? space.leftName : m.role === 'assistant' ? view.name : '旁白'}：${normalizeMessageContent(m, view.name, space.leftName).replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
    return {
        selfName: view.name,
        otherName: space.leftName,
        recentSummaries: recentDailyLines(view, space.personaKey, 8),
        recentChat,
    };
}

/** 這段關係叫角色寫東西時的系統提示詞與路線鎖（本機和雲端的 standing job 同一份） */
export function charSystemOf(space: ResolvedSpace): { system: string; lock: string } {
    const writer = space.view || space.char;
    return { system: ContextBuilder.buildCoreContext(writer, space.user!, true), lock: bondFinalLock(space.bond, space.leftName) || '' };
}

export async function askChar(space: ResolvedSpace, apiConfig: APIConfig, prompt: string, purpose: string, signal?: AbortSignal, opts: { maxTokens?: number; system?: { system: string; lock: string } } = {}): Promise<string> {
    const writer = space.view || space.char;
    const api = resolveCharacterChatApi(writer, apiConfig);
    if (!api.baseUrl || !api.apiKey) throw new Error('還沒設定 API');
    const { system, lock } = opts.system || charSystemOf(space);
    const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: lock ? `${prompt}\n\n${lock}` : prompt },
            ],
            temperature: 0.85,
            max_tokens: opts.maxTokens || 1500,
        }),
        ...(signal ? { signal } : {}),
    }, 1, 120_000, { appName: '羈絆', charId: writer.id, charName: writer.name, purpose });
    return extractContent(data);
}

/** 這一種在主動產出設定裡的篇幅、文風（手動按「請 TA …」也照它） */
const lengthOf = (space: ResolvedSpace, kind: 'question' | 'note'): { chars: [number, number]; style?: string } =>
    ({ chars: resolveOutputChars(space.bond, kind), style: resolveOutputSetting(space.bond, kind).style });
const tokensOf = (space: ResolvedSpace, kind: 'question' | 'note') => ({ maxTokens: outputMaxTokens(resolveOutputChars(space.bond, kind)) });

/** 角色回答這一題（只看題目和揭曉過的舊輪） */
export async function charAnswer(space: ResolvedSpace, apiConfig: APIConfig, entry: BondEntry, signal?: AbortSignal): Promise<{ answer: string } | { skip: true }> {
    const q = entry.question!;
    const ctx = await heartContext(space);
    const earlierRounds = revealedRounds(q).map(r => ({
        mine: visibleAnswer(r, 'char', 'char')?.text || undefined,
        theirs: visibleAnswer(r, 'user', 'char')?.text || undefined,
    }));
    const raw = await askChar(space, apiConfig, buildCharAnswerPrompt({
        ...ctx, question: q.prompt, askedByOther: q.rounds[q.rounds.length - 1].openedBy === 'user' || entry.author === 'user',
        earlierRounds, ...lengthOf(space, 'question'),
    }), '拾光問答', signal, tokensOf(space, 'question'));
    const out = parseCharAnswer(raw);
    if (!out) throw new Error('這次沒答出來，再試一次');
    return out;
}

/** 角色出一題（同時交出自己的答案） */
export async function charAsk(space: ResolvedSpace, apiConfig: APIConfig, entries: BondEntry[], signal?: AbortSignal): Promise<{ question: string; topic: BondQuestionTopic; answer: string }> {
    const ctx = await heartContext(space);
    const raw = await askChar(space, apiConfig, buildCharAskPrompt({
        ...ctx,
        relationLine: relationLineOf(space),
        askedBefore: entries.filter(e => e.kind === 'question' && e.status === 'published').map(e => e.question!.prompt),
        ...lengthOf(space, 'question'),
    }), '拾光問答', signal, tokensOf(space, 'question'));
    const out = parseCharAsk(raw);
    if (!out) throw new Error('這次沒出成題，再試一次');
    return out;
}

/** AI 推薦題目（副 API；只是候選，選中才變成你出的題） */
export async function suggestQuestions(space: ResolvedSpace, apiConfig: APIConfig, entries: BondEntry[], signal?: AbortSignal): Promise<Array<{ prompt: string; topic: BondQuestionTopic }>> {
    const api = globalMeterApi(apiConfig) || (apiConfig.baseUrl && apiConfig.apiKey ? { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model } : null);
    if (!api) throw new Error('還沒設定 API');
    const view = space.view || space.char;
    const prompt = buildQuestionSuggestPrompt({
        userName: space.leftName, charName: view.name, relationLine: relationLineOf(space),
        recentSummaries: recentDailyLines(view, space.personaKey, 6),
        askedBefore: entries.filter(e => e.kind === 'question').map(e => e.question!.prompt),
    });
    const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 800 }),
        ...(signal ? { signal } : {}),
    }, 1, 90_000, { appName: '羈絆', charId: view.id, charName: view.name, purpose: '推薦問答題目' });
    const out = parseQuestionSuggestions(extractContent(data));
    if (!out.length) throw new Error('這次沒想出題目，再試一次');
    return out;
}

/** 最近投遞的紙條，一則一行（給模型避免重複） */
export function recentSlipLines(space: ResolvedSpace, entries: BondEntry[]): string {
    const view = space.view || space.char;
    return entries
        .filter(e => e.kind === 'note' && e.status === 'published')
        .sort((a, b) => (b.slip?.deliveredAt || 0) - (a.slip?.deliveredAt || 0))
        .slice(0, 6)
        .map(e => `${e.author === 'user' ? space.leftName : view.name}：${e.text.replace(/\s+/g, ' ').slice(0, 100)}`)
        .join('\n');
}

/** 角色丟一張紙條（第 3c 批排程也用這個） */
export async function charSlip(space: ResolvedSpace, apiConfig: APIConfig, entries: BondEntry[], tags: string[], signal?: AbortSignal): Promise<{ text: string; tags: string[] }> {
    const ctx = await heartContext(space);
    const raw = await askChar(space, apiConfig, buildSlipPrompt({
        ...ctx, tags, relationLine: relationLineOf(space), recentSlips: recentSlipLines(space, entries), ...lengthOf(space, 'note'),
    }), '心靈角落', signal, tokensOf(space, 'note'));
    const out = parseSlip(raw, tags);
    if (!out) throw new Error('這次沒寫出來，再試一次');
    return out;
}

/** 角色回一張紙條（root 是這一串最上面那張） */
export async function charSlipReply(space: ResolvedSpace, apiConfig: APIConfig, entries: BondEntry[], root: BondEntry, signal?: AbortSignal): Promise<string> {
    const view = space.view || space.char;
    const nameOf = (e: BondEntry) => (e.author === 'user' ? space.leftName : view.name);
    const ctx = await heartContext(space);
    const raw = await askChar(space, apiConfig, buildSlipReplyPrompt({
        ...ctx,
        slip: { fromName: nameOf(root), text: root.text, tags: root.slip?.tags || [] },
        thread: slipReplies(entries, root.id).map(e => ({ fromName: nameOf(e), text: e.text })),
        ...lengthOf(space, 'note'),
    }), '心靈角落', signal, tokensOf(space, 'note'));
    const out = parseSlip(raw, []);
    if (!out) throw new Error('這次沒寫出來，再試一次');
    return out.text;
}

// ─── 約定（plans/bond-batch4.md 1.1、1.2、1.4）：問問 TA ───

/** 你寫的願望，TA 怎麼想（支持不等於答應） */
export async function charWishReply(space: ResolvedSpace, apiConfig: APIConfig, wish: BondEntry, signal?: AbortSignal): Promise<{ stance: 'support' | 'together' | 'neutral'; words: string }> {
    const ctx = await heartContext(space);
    const raw = await askChar(space, apiConfig, buildWishReplyPrompt({
        ...ctx, wish: wish.text, owner: wish.wish?.owner === 'both' ? 'both' : 'user', relationLine: relationLineOf(space),
    }), '羈絆願望', signal);
    const out = parseWishReply(raw);
    if (!out) throw new Error('這次沒回出來，再試一次');
    return out;
}

/** 你提的約定，TA 答不答應 */
export async function charPromiseReply(space: ResolvedSpace, apiConfig: APIConfig, promise: BondEntry, fromWish?: string, signal?: AbortSignal): Promise<{ answer: 'yes' | 'tweak' | 'no'; words: string }> {
    const ctx = await heartContext(space);
    const raw = await askChar(space, apiConfig, buildPromiseReplyPrompt({
        ...ctx, promise: promise.text, repeatText: repeatLabel(promise.promise!.repeat), relationLine: relationLineOf(space), fromWish,
    }), '羈絆約定', signal);
    const out = parsePromiseReply(raw);
    if (!out) throw new Error('這次沒回出來，再試一次');
    return out;
}

/** 你覺得的默契，TA 認不認 */
export async function charHabitReply(space: ResolvedSpace, apiConfig: APIConfig, habit: BondEntry, signal?: AbortSignal): Promise<{ answer: 'yes' | 'no'; words: string }> {
    const ctx = await heartContext(space);
    const raw = await askChar(space, apiConfig, buildHabitReplyPrompt({ ...ctx, habit: habit.text, relationLine: relationLineOf(space) }), '羈絆默契', signal);
    const out = parseHabitReply(raw);
    if (!out) throw new Error('這次沒回出來，再試一次');
    return out;
}
