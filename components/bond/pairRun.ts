/**
 * 角色之間各區的小按鈕跑在 App 裡的那一半（plans/bond-batch6.md 3.2～3.4、第 4 節）：
 * 讓某某寫一篇日記、讓他們回答一題（各自作答、一起揭曉）、讓某某說一個願望、讓某某寫信／回信，
 * 以及私下聊滿一大段時兩人各留一篇日記。提示詞本體在 utils/bond/pairPrompt.ts。
 *
 * 都用寫的那個角色自己的主 API、帶自己的人設；推薦題目用副 API。寫好直接存（你是讀者，能改字、能刪）。
 */
import type { APIConfig, BondEntry, BondQuestionTopic, CharacterProfile } from '../../types';
import type { ResolvedSpace } from './space';
import { askAs } from './storyWriteback';
import { recentPairChat, relationLineOf } from './storyRun';
import { globalMeterApi } from '../../utils/apiCenter';
import { extractContent, safeFetchJson } from '../../utils/safeApi';
import { contactOf } from '../../utils/pairChatRun';
import { storyChapters } from '../../utils/bond/story';
import { newPairDiary, type StorySide } from '../../utils/bond/storyExtract';
import { answerQuestion, newQuestion, parseQuestionSuggestions } from '../../utils/bond/question';
import { newWish, publishWish } from '../../utils/bond/pact';
import { newLetter, sendLetter } from '../../utils/bond/letter';
import { saveBondEntries, saveBondEntry } from '../../utils/bond/entries';
import { bondEntriesOf } from '../../utils/bond/entryRegistry';
import { bondOrBlank } from '../../utils/bond/store';
import { isBondOpen } from '../../utils/bond/openState';
import { pairBondId } from '../../utils/bond/model';
import { trackEvent } from '../../utils/analytics';
import {
    buildPairAnswerPrompt, buildPairDiaryPrompt, buildPairLetterPrompt, buildPairQuestionSuggestPrompt, buildPairWishPrompt,
    cleanLong, cleanOneLine, pairSlot, type PairRecent,
} from '../../utils/bond/pairPrompt';

const sideChar = (space: ResolvedSpace, side: StorySide): CharacterProfile => (side === 'a' ? space.char : space.other!);
const otherOf = (side: StorySide): StorySide => (side === 'a' ? 'b' : 'a');

/** 最近發生的：最近一章、最近的片刻、自己這邊最近的私下聊天整理、最近的私聊 */
export async function pairRecentFor(input: {
    self: CharacterProfile; other: CharacterProfile; entries: BondEntry[]; space?: ResolvedSpace; characters?: CharacterProfile[]; withChat?: boolean;
}): Promise<PairRecent> {
    const last = storyChapters(input.entries).at(-1);
    const moments = input.entries.filter(e => e.kind === 'moment' && e.status === 'published' && !e.hidden)
        .sort((x, y) => y.writtenAt - x.writtenAt).slice(0, 3).map(e => (e.title ? `${e.title}：${e.text}` : e.text).replace(/\s+/g, ' ').slice(0, 120));
    const topics = (contactOf(input.self, input.other)?.topicBox || []).slice(-2).map(t => t.text.replace(/\s+/g, ' ').slice(0, 200));
    const chat = input.withChat !== false && input.space && input.characters ? await recentPairChat(input.space, input.characters, 20).catch(() => []) : [];
    return {
        ...(last?.story ? { chapter: { title: last.title || '', summary: last.story.summary } } : {}),
        ...(moments.length ? { moments } : {}),
        ...(topics.length ? { topics } : {}),
        ...(chat.length ? { chat } : {}),
    };
}

/** 寫一篇日記（不存；呼叫的地方決定怎麼存） */
async function draftDiary(input: { bondId: string; self: CharacterProfile; other: CharacterProfile; date: string; recent: PairRecent; entries: BondEntry[]; apiConfig: APIConfig }): Promise<string> {
    const lastDiary = input.entries.filter(e => e.kind === 'diary' && e.author === input.self.id).sort((x, y) => y.writtenAt - x.writtenAt)[0];
    const raw = await askAs(input.self, input.apiConfig, buildPairDiaryPrompt({
        selfName: input.self.name, otherName: input.other.name, date: input.date, recent: input.recent, lastDiary: lastDiary?.text.slice(0, 600),
    }), 1600, '角色之間・日記');
    const text = cleanLong(raw, 3000);
    if (!text) throw new Error('這次沒寫出來，再試一次');
    return text;
}

/** 小按鈕「讓某某寫一篇」 */
export async function writePairDiary(space: ResolvedSpace, side: StorySide, characters: CharacterProfile[], entries: BondEntry[], apiConfig: APIConfig): Promise<BondEntry> {
    const self = sideChar(space, side), other = sideChar(space, otherOf(side));
    const recent = await pairRecentFor({ self, other, entries, space, characters });
    const text = await draftDiary({ bondId: space.id, self, other, date: space.todayKey, recent, entries, apiConfig });
    const saved = await saveBondEntry(newPairDiary({ bondId: space.id, author: self.id, text, date: space.todayKey, origin: 'button' }));
    trackEvent('角色之间小按钮', { 动作: '日记' });
    return saved;
}

/**
 * 私下聊滿一大段（archivePairIfNeeded 每 100 則整理一次）：這段關係沒關掉自動日記、兩人都在戲上時，各寫一篇。
 * 空間還沒寫進表的，第一次寫日記時由 saveBondEntries 照舊存卡（bonds 那筆照 bondOrBlank 讀）。失敗只記日誌。
 */
export async function autoPairDiaries(input: {
    a: CharacterProfile; b: CharacterProfile; aTopicIds: string[]; bTopicIds: string[]; date: string; apiConfig: APIConfig;
}): Promise<void> {
    const bondId = pairBondId(input.a.id, input.b.id);
    const bond = bondOrBlank(bondId);
    if (bond.pairAutoDiary === false || !isBondOpen(bond)) return;
    const entries = bondEntriesOf(bondId);
    const one = async (self: CharacterProfile, other: CharacterProfile, topicIds: string[]) => {
        if (!topicIds.length) return null;
        try {
            const recent = await pairRecentFor({ self, other, entries, withChat: false });
            const text = await draftDiary({ bondId, self, other, date: input.date, recent, entries, apiConfig: input.apiConfig });
            return newPairDiary({ bondId, author: self.id, text, date: input.date, origin: 'auto', fromTopics: topicIds });
        } catch (e) {
            console.warn(`[角色之間] ${self.name} 的自動日記沒寫成`, e);
            return null;
        }
    };
    const out = (await Promise.all([one(input.a, input.b, input.aTopicIds), one(input.b, input.a, input.bTopicIds)])).filter((e): e is BondEntry => !!e);
    if (out.length) await saveBondEntries(out);
}

// ─── 問答 ─────────────────────────────────────────

type Api = { baseUrl: string; apiKey: string; model: string };
const meterApiOf = (apiConfig: APIConfig): Api | null => globalMeterApi(apiConfig) || (apiConfig.baseUrl && apiConfig.apiKey ? { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model } : null);

/** AI 照他們的關係推薦三題 */
export async function suggestPairQuestions(space: ResolvedSpace, characters: CharacterProfile[], entries: BondEntry[], apiConfig: APIConfig): Promise<Array<{ prompt: string; topic: BondQuestionTopic }>> {
    const api = meterApiOf(apiConfig);
    if (!api) throw new Error('還沒設定 API');
    const recent = await pairRecentFor({ self: space.char, other: space.other!, entries, space, characters });
    const asked = entries.filter(e => e.kind === 'question').map(e => e.text).slice(-20);
    const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({ model: api.model, temperature: 0.9, max_tokens: 600, messages: [{ role: 'user', content: buildPairQuestionSuggestPrompt({
            aName: space.char.name, bName: space.other!.name, relationLine: relationLineOf(space), recent, asked,
        }) }] }),
    }, 1, 60_000, { appName: '羈絆', charId: space.char.id, charName: space.char.name, purpose: '角色之間・推薦題目' });
    const list = parseQuestionSuggestions(extractContent(data)).slice(0, 3);
    if (!list.length) throw new Error('這次沒推薦出來，再試一次');
    return list;
}

/** 讓他們回答一題：兩人各自作答（看不到對方的），答完一起揭曉。回傳存好的題目 */
export async function askPairQuestion(space: ResolvedSpace, characters: CharacterProfile[], entries: BondEntry[], apiConfig: APIConfig, q: {
    prompt: string; origin: 'user' | 'ai_suggest'; topic?: BondQuestionTopic; existing?: BondEntry;
}): Promise<BondEntry> {
    let entry = q.existing || newQuestion({ bondId: space.id, openedBy: 'user', prompt: q.prompt, origin: q.origin, ...(q.topic ? { topic: q.topic } : {}) });
    const answerOf = async (side: StorySide) => {
        const self = sideChar(space, side), other = sideChar(space, otherOf(side));
        const recent = await pairRecentFor({ self, other, entries, withChat: false });
        const raw = await askAs(self, apiConfig, buildPairAnswerPrompt({ selfName: self.name, otherName: other.name, question: entry.text, recent }), 500, '角色之間・問答');
        return cleanLong(raw, 600);
    };
    // 各自作答：兩個請求彼此看不到對方的答案
    const [aText, bText] = await Promise.all([answerOf('a'), answerOf('b')]);
    entry = answerQuestion(entry, pairSlot('a'), { text: aText, state: aText ? 'sealed' : 'skipped' });
    entry = answerQuestion(entry, pairSlot('b'), { text: bText, state: bText ? 'sealed' : 'skipped' });
    // 揭曉是給你看的演出：你還沒點開看之前 seenAt 是空的
    const saved = await saveBondEntry({ ...entry, status: 'published', seenAt: undefined });
    trackEvent('角色之间小按钮', { 动作: '问答' });
    return saved;
}

// ─── 願望、信 ───────────────────────────────────────

/** 讓某某說一個願望（只存成願望，不推劇情） */
export async function pairWish(space: ResolvedSpace, side: StorySide, characters: CharacterProfile[], entries: BondEntry[], apiConfig: APIConfig): Promise<BondEntry> {
    const self = sideChar(space, side), other = sideChar(space, otherOf(side));
    const recent = await pairRecentFor({ self, other, entries, space, characters });
    const existing = entries.filter(e => e.kind === 'wish' && e.status === 'published').map(e => e.text).slice(-12);
    const raw = await askAs(self, apiConfig, buildPairWishPrompt({ selfName: self.name, otherName: other.name, recent, existing }), 200, '角色之間・願望');
    const text = cleanOneLine(raw, 80);
    if (!text) throw new Error('這次沒說出來，再試一次');
    const saved = await saveBondEntry(publishWish(newWish({ bondId: space.id, author: self.id, owner: self.id, text })));
    trackEvent('角色之间小按钮', { 动作: '愿望' });
    return saved;
}

/** 讓某某寫一封信給對方（replyTo＝回哪一封）；寄出就到 */
export async function pairLetter(space: ResolvedSpace, from: StorySide, characters: CharacterProfile[], entries: BondEntry[], apiConfig: APIConfig, opts: {
    direction?: string; replyTo?: BondEntry;
}): Promise<BondEntry> {
    const self = sideChar(space, from), other = sideChar(space, otherOf(from));
    const recent = await pairRecentFor({ self, other, entries, space, characters });
    const raw = await askAs(self, apiConfig, buildPairLetterPrompt({
        fromName: self.name, toName: other.name, recent, direction: opts.direction, replyTo: opts.replyTo?.text.slice(0, 2000),
    }), 1600, opts.replyTo ? '角色之間・回信' : '角色之間・寫信');
    const text = cleanLong(raw, 4000);
    if (!text) throw new Error('這次沒寫出來，再試一次');
    const saved = await saveBondEntry(sendLetter(newLetter({
        bondId: space.id, author: self.id, to: other.id, text, ...(opts.replyTo ? { replyTo: opts.replyTo.id } : {}),
    }), 0));
    trackEvent('角色之间小按钮', { 动作: opts.replyTo ? '回信' : '写信' });
    return saved;
}
