/**
 * 主動產出的本機那條路（plans/bond-batch3.md 1.5、1.6）：頁面開著每 5 分鐘看一次，
 * 該寫的（事件提早、區間保底，錯開、有上限）一次寫一份：日記、問答、紙條、隨筆、願望（第 4 批）。
 * 判斷是純函式（utils/bond/output.ts 的 decideBondOutputs）；這裡只負責組名單、叫模型、存檔、同步私聊。
 *
 * 一份產出拆成兩步，本機和雲端（第 3d 批，components/bond/outputCloud.ts）共用：
 * - prepareOutput：組提示詞（系統＝角色核心上下文、路線鎖、這一種的提示詞）——雲端的 standing job 就是存這份；
 * - applyOutput：拿模型原文解析、存檔、同步私聊——雲端結果回來也走這裡。
 *
 * - 誰能寫：角色在戲上、不是小號、這條線沒拉黑；沒自己設過開關的類型，最近 14 天私聊有說過話才算預設開。
 * - 寫完把這一種的起點換成現在（雲端的 standing job 跟著重傳，到期時間往後推）。
 */
import type { APIConfig, BondOutputKind, CharacterProfile, DiaryEntry, UserProfile } from '../../types';
import { resolveSpace, type ResolvedSpace } from './space';
import { askChar, charSystemOf, heartContext, recentSlipLines, relationLineOf } from './heartRun';
import { DB } from '../../utils/db';
import { withLineFields, lineFor, lineKey, lineMsgFields } from '../../utils/chatLine';
import { isOnStage } from '../../utils/castRole';
import { isChatBlocked } from '../../utils/chatBlock';
import { allRegisteredBonds } from '../../utils/bond/registry';
import { bondOrBlank, updateBond } from '../../utils/bond/store';
import { bondEntriesOf } from '../../utils/bond/entryRegistry';
import { diariesOfBondSync } from '../../utils/bond/diaryRegistry';
import { listPersonaSpaces } from '../../utils/bond/spaces';
import { decideBondOutputs, markOutputDone, OUTPUT_KIND_LABEL, resolveOutputChars, resolveOutputSetting, type OutputCandidate } from '../../utils/bond/output';
import {
    buildCharAskPrompt, buildSlipPrompt, buildSlipReplyPrompt, parseCharAsk, parseDiary, parseNotice, parseSlip, parseSlipReplyState,
    buildDiaryPrompt, outputMaxTokens, buildCharWishPrompt, parseCharWish,
} from '../../utils/bond/outputPromptCore';
import { newWish, publishWish } from '../../utils/bond/pact';
import type { BondOutputJobDiary } from '../../utils/bond/outputCloudJob';
import { answerQuestion, newQuestion } from '../../utils/bond/question';
import { deliverSlip, newSlip, setSlipState, slipReplies, slipTagOptions } from '../../utils/bond/slip';
import { blankDiary, pageEmpty, pagePublished, putCharPage } from '../../utils/bond/diary';
import { buildEssayChoosePrompt, essayCandidates, essayDraft, essayTargetOf, parseEssay } from '../../utils/bond/essay';
import { saveBondEntries, saveBondEntry } from '../../utils/bond/entries';
import { buildTimeline, memoriesForLine, type TimelineItem } from '../../utils/bond/timeline';
import { makeChatClock } from '../../utils/dateStoryTime';
import { resolveCharTimeZone } from '../../utils/timezone';
import { trackEvent } from '../../utils/analytics';

const ACTIVE_MS = 14 * 86400_000;
const HEADER = '💌 [BondOutput]';
let running = false;

export const KIND_ANALYTICS = { diary: '日记', question: '问答', note: '纸条', essay: '随笔', wish: '愿望', letter: '信' } as const;

export interface BondOutputDone {
    bondId: string;
    kind: BondOutputKind;
    charId: string;
    charName: string;
    /** 同步私聊那句（有傳的話）＋那則訊息落在哪條線 */
    notice?: { text: string; lineKey: string };
}

/** 寫好一份（本機或雲端）：OSContext 聽這個跳提示、打未讀 */
export const BOND_OUTPUT_DONE_EVENT = 'soren-bond-output-done';
export function announceOutputDone(done: BondOutputDone): void {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<BondOutputDone>(BOND_OUTPUT_DONE_EVENT, { detail: done }));
}

export async function lastMessageAt(char: CharacterProfile, personaKey: string | undefined): Promise<number> {
    const line = lineFor(char, personaKey);
    const arg = line.personaKey ? { charId: char.id, personaKey: line.personaKey } : char.id;
    const [m] = await DB.getRecentMessagesByCharId(arg as any, 1).catch(() => []);
    return m?.timestamp || 0;
}

/** 這次看哪些關係（身份卡 × 角色）；雲端排任務也用同一份名單 */
export async function outputCandidates(characters: CharacterProfile[], profileBase: UserProfile, now: number): Promise<Array<OutputCandidate & { char: CharacterProfile; personaKey: string; lastMessageAt: number }>> {
    const chars = characters.filter(c => !c.altOf).map(c => withLineFields(profileBase, c));
    const spaces = listPersonaSpaces(chars, allRegisteredBonds());
    const out: Array<OutputCandidate & { char: CharacterProfile; personaKey: string; lastMessageAt: number }> = [];
    for (const sp of spaces) {
        const c = chars.find(x => x.id === sp.charId);
        if (!c) continue;
        const bond = bondOrBlank(sp.id);
        const eligible = isOnStage(c) && !isChatBlocked(c);
        const last = eligible ? await lastMessageAt(c, sp.personaKey) : 0;
        out.push({ bondId: sp.id, bond, eligible, recentlyActive: eligible && now - last < ACTIVE_MS, char: c, personaKey: sp.personaKey, lastMessageAt: last });
    }
    return out;
}

const localMinutes = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
const localDayStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** 一次 tick：記起點、寫最多一份。回傳寫好的那份（也會發 BOND_OUTPUT_DONE_EVENT） */
export async function runBondOutputTick(scope: { characters: CharacterProfile[]; userProfileBase: UserProfile; apiConfig: APIConfig }): Promise<BondOutputDone | null> {
    if (running) return null;
    running = true;
    try {
        const now = Date.now();
        const cands = await outputCandidates(scope.characters, scope.userProfileBase, now);
        const decision = decideBondOutputs(cands, now, localMinutes(), localDayStart());
        for (const seed of decision.seeds) {
            await updateBond(seed.bondId, b => (b.outputLast?.[seed.kind] ? b : { ...b, outputLast: { ...(b.outputLast || {}), [seed.kind]: seed.at } }));
        }
        const next = decision.due[0];
        if (!next) return null;
        const chars = scope.characters.filter(c => !c.altOf).map(c => withLineFields(scope.userProfileBase, c));
        const space = resolveSpace(next.bondId, chars, scope.userProfileBase, () => true);
        if (!space || space.kind !== 'persona' || !space.view || !space.user) return null;
        // 先記上這一份（失敗也算這一輪，免得一直重試同一份；下一輪照區間再來）
        await updateBond(next.bondId, b => markOutputDone(b, next.kind, now));
        const done = await writeOne(space, next.kind, scope.apiConfig).catch(e => { console.warn(HEADER, '沒寫成', next, e); return null; });
        if (done) {
            trackEvent('主动产出完成', { 类型: KIND_ANALYTICS[next.kind], 来源: '本机', 触发: next.reason === 'event' ? '事件' : '保底' });
            announceOutputDone(done);
        }
        return done;
    } finally {
        running = false;
    }
}

// ─── 準備：組提示詞 ───────────────────────────────

export interface PreparedOutput {
    kind: BondOutputKind;
    withNotice: boolean;
    system: string;
    lock: string;
    /** 問答、紙條、隨筆：整段提示詞 */
    prompt?: string;
    /** 日記：提示詞除了日期和你那頁的部分（本機當場補上，雲端到點補上） */
    diary?: BondOutputJobDiary;
    replyTo?: string;
    tags?: string[];
    candidateKeys?: string[];
    maxTokens: number;
    purpose: string;
}

/** 這段關係的時間線（隨筆挑一件用） */
function timelineOf(space: ResolvedSpace): TimelineItem[] {
    return buildTimeline({
        bond: space.bond, entries: bondEntriesOf(space.id),
        memories: { charId: space.char.id, list: memoriesForLine(space.char.memories, space.personaKey, space.char.primaryPersonaKey) },
    });
}

/** 組好一份（還沒叫模型）；這一種現在沒得寫（隨筆沒有可挑的事）回 null */
export async function prepareOutput(space: ResolvedSpace, kind: BondOutputKind): Promise<PreparedOutput | null> {
    const view = space.view!;
    const setting = resolveOutputSetting(space.bond, kind);
    const withNotice = setting.syncToChat && !isChatBlocked(view);
    const entries = bondEntriesOf(space.id);
    const { system, lock } = charSystemOf(space);
    const chars = resolveOutputChars(space.bond, kind);
    const style = setting.style?.trim() || undefined;
    const base = { kind, withNotice, system, lock, maxTokens: outputMaxTokens(chars, kind === 'essay' ? 2000 : 1500) };

    if (kind === 'essay') {
        // 隨筆：讓 TA 自己挑一件還沒寫過的，寫成草稿（你收下才算，跟第 2 批同一條路）
        const cands = essayCandidates(timelineOf(space), space.char.id);
        if (!cands.length) return null;
        const prompt = buildEssayChoosePrompt({
            selfName: view.name, otherName: space.leftName,
            candidates: cands.map(c => { const t = essayTargetOf(c, { includeUserNote: true, topicOwnerName: c.ref.type === 'topic' && c.ref.ownerId === space.char.id ? view.name : undefined }); return { dateText: t.dateText, label: c.kind === 'moment' ? '片刻' : '記憶', text: t.title ? `${t.title}：${t.text}` : t.text }; }),
            chars, style,
        });
        return { ...base, prompt, candidateKeys: cands.map(c => c.key), purpose: '角色隨筆' };
    }

    const ctx = await heartContext(space);
    if (kind === 'diary') {
        const diaries = diariesOfBondSync(space.id);
        const today = diaries.find(d => d.date === space.todayKey);
        const recent = [...diaries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 2)
            .map(d => `- ${d.date}：${[pagePublished(d.userPage) ? `${space.leftName}：${d.userPage.text.slice(0, 160)}` : '', pagePublished(d.charPage) ? `你：${d.charPage!.text.slice(0, 160)}` : ''].filter(Boolean).join('；')}`)
            .filter(l => !l.endsWith('：')).join('\n');
        const clock = makeChatClock(view);
        return {
            ...base, purpose: '日記',
            diary: {
                base: { ...ctx, recentDiaries: recent, chars, style, withNotice },
                dateTz: resolveCharTimeZone(view) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
                dateOffsetMs: clock ? clock.now - Date.now() : 0,
                today: space.todayKey,
                userPageToday: today && pagePublished(today.userPage) ? today.userPage.text : undefined,
                writtenToday: !!today && !pageEmpty(today.charPage),
            },
        };
    }
    if (kind === 'question') {
        return {
            ...base, purpose: '拾光問答',
            prompt: buildCharAskPrompt({
                ...ctx, relationLine: relationLineOf(space), chars, style, withNotice,
                askedBefore: entries.filter(e => e.kind === 'question' && e.status === 'published').map(e => e.question!.prompt),
            }),
        };
    }
    if (kind === 'wish') {
        // 第 4 批：角色寫一個自己的願望（或想跟你一起做的事）；寫了只是讓你看見，不等於約好
        return {
            ...base, purpose: '角色願望',
            prompt: buildCharWishPrompt({
                ...ctx, relationLine: relationLineOf(space), chars, style, withNotice,
                wishesBefore: entries.filter(e => e.kind === 'wish' && e.status === 'published').map(e => e.text),
            }),
        };
    }
    // 紙條：你丟來、TA 還沒回的那張先回；沒有就自己丟一張
    const pending = entries
        .filter(e => e.kind === 'note' && e.status === 'published' && e.author === 'user' && !e.slip?.replyTo)
        .filter(e => !slipReplies(entries, e.id).some(r => r.author !== 'user'))
        .sort((a, b) => (b.slip?.deliveredAt || 0) - (a.slip?.deliveredAt || 0))[0];
    if (pending) {
        return {
            ...base, purpose: '心靈角落', replyTo: pending.id,
            prompt: buildSlipReplyPrompt({
                ...ctx, chars, style, withNotice, canMarkState: true,
                slip: { fromName: space.leftName, text: pending.text, tags: pending.slip?.tags || [] },
                thread: slipReplies(entries, pending.id).map(e => ({ fromName: e.author === 'user' ? space.leftName : view.name, text: e.text })),
            }),
        };
    }
    const tags = slipTagOptions(space.bond.noteTags);
    return {
        ...base, purpose: '心靈角落', tags,
        prompt: buildSlipPrompt({ ...ctx, tags, relationLine: relationLineOf(space), recentSlips: recentSlipLines(space, entries), chars, style, withNotice }),
    };
}

// ─── 收下：解析、存檔、同步私聊 ─────────────────────

export interface ApplyMeta {
    /** 日記那天（雲端到點算的；本機就是這段關係的今天） */
    dateKey?: string;
    replyTo?: string;
    tags?: string[];
    candidateKeys?: string[];
}

/**
 * 模型原文 → 存進去。寫不成拋錯；這一份已經沒必要了（那天的日記寫過了、那張紙條回過了）回 null。
 */
export async function applyOutput(space: ResolvedSpace, kind: BondOutputKind, raw: string, meta: ApplyMeta): Promise<BondOutputDone | null> {
    const view = space.view!;
    const setting = resolveOutputSetting(space.bond, kind);
    const withNotice = setting.syncToChat && !isChatBlocked(view);
    const entries = bondEntriesOf(space.id);

    if (kind === 'diary') {
        const date = meta.dateKey || space.todayKey;
        const existing = diariesOfBondSync(space.id).find(d => d.date === date);
        if (existing && !pageEmpty(existing.charPage)) return null;
        const parsed = parseDiary(raw);
        if (!parsed) throw new Error('日記沒寫出來');
        const base: DiaryEntry = existing || blankDiary({ charId: space.char.id, bondId: space.id, date });
        await DB.saveDiary(putCharPage(base, { text: parsed.text, paperStyle: 'plain', stickers: [] }, 'ai_scheduled'));
        trackEvent('写羁绊日记', { 谁: '角色', 方式: '主动' });
    } else if (kind === 'question') {
        const out = parseCharAsk(raw);
        if (!out) throw new Error('沒出成題');
        await saveBondEntry(answerQuestion(newQuestion({ bondId: space.id, openedBy: space.char.id, prompt: out.question, origin: 'char', topic: out.topic }), 'char', { text: out.answer, state: 'sealed' }));
        trackEvent('拾光问答', { 动作: '出题', 来源: '角色出' });
    } else if (kind === 'note') {
        if (meta.replyTo) {
            const pending = entries.find(e => e.id === meta.replyTo);
            if (!pending || slipReplies(entries, pending.id).some(r => r.author !== 'user')) return null;
            const out = parseSlip(raw, []);
            if (!out) throw new Error('沒回成紙條');
            const state = parseSlipReplyState(raw);
            await saveBondEntries([
                deliverSlip(newSlip({ bondId: space.id, author: space.char.id, text: out.text, tags: [], replyTo: pending.id })),
                ...(state ? [setSlipState(pending, state)] : []),
            ]);
        } else {
            const out = parseSlip(raw, meta.tags || slipTagOptions(space.bond.noteTags));
            if (!out) throw new Error('沒寫成紙條');
            await saveBondEntry(deliverSlip(newSlip({ bondId: space.id, author: space.char.id, text: out.text, tags: out.tags })));
        }
        trackEvent('投递心灵纸条', { 谁: '角色', 方式: '主动' });
    } else if (kind === 'wish') {
        const out = parseCharWish(raw);
        if (!out) throw new Error('沒寫成願望');
        await saveBondEntry(publishWish(newWish({ bondId: space.id, author: space.char.id, owner: out.together ? 'both' : space.char.id, text: out.wish })));
        trackEvent('写羁绊愿望', { 谁: '角色', 类型: out.together ? '我们的' : 'TA的', 方式: '主动' });
    } else {
        const parsed = parseEssay(raw, 'choose');
        const key = parsed?.pick ? meta.candidateKeys?.[parsed.pick - 1] : undefined;
        const item = key ? timelineOf(space).find(it => it.key === key) : undefined;
        if (!parsed || !item) throw new Error('這次沒挑出來');
        await saveBondEntry(essayDraft({ bondId: space.id, writerId: space.char.id, item, parsed }));
    }

    const notice = withNotice ? parseNotice(raw) : '';
    let noticeOut: BondOutputDone['notice'];
    if (notice) {
        const fields = lineMsgFields(view);
        await DB.saveMessage({ ...fields, role: 'assistant', type: 'text', content: notice, metadata: { source: 'bond-output', bondOutputKind: kind } } as any);
        noticeOut = { text: notice, lineKey: lineKey(lineFor(space.char, space.personaKey)) };
    }
    console.info(HEADER, `${view.name} 寫了${OUTPUT_KIND_LABEL[kind]}`);
    return { bondId: space.id, kind, charId: space.char.id, charName: view.name, notice: noticeOut };
}

/** 寫一份（本機：組、叫模型、收下；也給「現在寫一份」那顆鈕用） */
export async function writeOne(space: ResolvedSpace, kind: BondOutputKind, apiConfig: APIConfig): Promise<BondOutputDone | null> {
    const prep = await prepareOutput(space, kind);
    if (!prep) {
        if (kind === 'essay') throw new Error('沒有還沒寫過的事可以挑了');
        return null;
    }
    let prompt = prep.prompt || '';
    if (prep.diary) {
        if (prep.diary.writtenToday) return null; // 今天已經寫過了
        prompt = buildDiaryPrompt({ ...prep.diary.base, date: prep.diary.today, userPage: prep.diary.userPageToday });
    }
    const raw = await askChar(space, apiConfig, prompt, prep.purpose, undefined, { maxTokens: prep.maxTokens, system: { system: prep.system, lock: prep.lock } });
    return applyOutput(space, kind, raw, { dateKey: prep.diary?.today, replyTo: prep.replyTo, tags: prep.tags, candidateKeys: prep.candidateKeys });
}
