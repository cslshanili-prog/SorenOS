/**
 * 主動產出的本機那條路（plans/bond-batch3.md 1.5、1.6）：頁面開著每 5 分鐘看一次，
 * 該寫的（事件提早、區間保底，錯開、有上限）一次寫一份：日記、問答、紙條、隨筆。
 * 判斷是純函式（utils/bond/output.ts 的 decideBondOutputs）；這裡只負責組名單、叫模型、存檔、同步私聊。
 *
 * - 誰能寫：角色在戲上、不是小號、這條線沒拉黑；沒自己設過開關的類型，最近 14 天私聊有說過話才算預設開。
 * - 交給雲端的（第 3d 批）一天內不重寫；寫完把這一種的起點換成現在。
 */
import type { APIConfig, BondOutputKind, CharacterProfile, DiaryEntry, UserProfile } from '../../types';
import { resolveSpace, type ResolvedSpace } from './space';
import { askChar, heartContext, recentSlipLines, relationLineOf } from './heartRun';
import { runEssay } from './essayRun';
import { DB } from '../../utils/db';
import { withLineFields, lineFor, lineKey, lineMsgFields } from '../../utils/chatLine';
import { isOnStage } from '../../utils/castRole';
import { isChatBlocked } from '../../utils/chatBlock';
import { allRegisteredBonds } from '../../utils/bond/registry';
import { bondOrBlank, updateBond } from '../../utils/bond/store';
import { bondEntriesOf } from '../../utils/bond/entryRegistry';
import { diariesOfBondSync } from '../../utils/bond/diaryRegistry';
import { listPersonaSpaces } from '../../utils/bond/spaces';
import { decideBondOutputs, DIARY_LENGTH_CHARS, markOutputDone, OUTPUT_KIND_LABEL, resolveOutputSetting, type OutputCandidate } from '../../utils/bond/output';
import {
    buildCharAskPrompt, buildDiaryPrompt, buildSlipPrompt, buildSlipReplyPrompt, parseCharAsk, parseDiary, parseNotice, parseSlip, parseSlipReplyState,
} from '../../utils/bond/outputPromptCore';
import { answerQuestion, newQuestion } from '../../utils/bond/question';
import { deliverSlip, newSlip, setSlipState, slipReplies, slipTagOptions } from '../../utils/bond/slip';
import { blankDiary, pageEmpty, pagePublished, putCharPage } from '../../utils/bond/diary';
import { essayDraft } from '../../utils/bond/essay';
import { saveBondEntries, saveBondEntry } from '../../utils/bond/entries';
import { buildTimeline, memoriesForLine } from '../../utils/bond/timeline';
import { trackEvent } from '../../utils/analytics';

const ACTIVE_MS = 14 * 86400_000;
const HEADER = '💌 [BondOutput]';
let running = false;

export interface BondOutputDone {
    bondId: string;
    kind: BondOutputKind;
    charId: string;
    charName: string;
    /** 同步私聊那句（有傳的話）＋那則訊息落在哪條線 */
    notice?: { text: string; lineKey: string };
}

async function lastMessageAt(char: CharacterProfile, personaKey: string): Promise<number> {
    const line = lineFor(char, personaKey);
    const arg = line.personaKey ? { charId: char.id, personaKey: line.personaKey } : char.id;
    const [m] = await DB.getRecentMessagesByCharId(arg as any, 1).catch(() => []);
    return m?.timestamp || 0;
}

/** 這次看哪些關係（身份卡 × 角色） */
async function candidates(characters: CharacterProfile[], profileBase: UserProfile, now: number): Promise<OutputCandidate[]> {
    const chars = characters.filter(c => !c.altOf).map(c => withLineFields(profileBase, c));
    const spaces = listPersonaSpaces(chars, allRegisteredBonds());
    const out: OutputCandidate[] = [];
    for (const sp of spaces) {
        const c = chars.find(x => x.id === sp.charId);
        if (!c) continue;
        const bond = bondOrBlank(sp.id);
        const eligible = isOnStage(c) && !isChatBlocked(c);
        const recentlyActive = eligible ? now - (await lastMessageAt(c, sp.personaKey)) < ACTIVE_MS : false;
        out.push({ bondId: sp.id, bond, eligible, recentlyActive });
    }
    return out;
}

const localMinutes = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
const localDayStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** 一次 tick：記起點、寫最多一份。回傳寫好的那份（給 OSContext 打未讀、跳提示） */
export async function runBondOutputTick(scope: { characters: CharacterProfile[]; userProfileBase: UserProfile; apiConfig: APIConfig }): Promise<BondOutputDone | null> {
    if (running) return null;
    running = true;
    try {
        const now = Date.now();
        const cands = await candidates(scope.characters, scope.userProfileBase, now);
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
        if (done) trackEvent('主动产出完成', { 类型: ({ diary: '日记', question: '问答', note: '纸条', essay: '随笔' } as const)[next.kind], 来源: '本机', 触发: next.reason === 'event' ? '事件' : '保底' });
        return done;
    } finally {
        running = false;
    }
}

/** 寫一份（也給「立刻寫一份」那顆鈕用） */
export async function writeOne(space: ResolvedSpace, kind: BondOutputKind, apiConfig: APIConfig): Promise<BondOutputDone | null> {
    const view = space.view!;
    const setting = resolveOutputSetting(space.bond, kind);
    const withNotice = setting.syncToChat && !isChatBlocked(view);
    const entries = bondEntriesOf(space.id);
    const ctx = await heartContext(space);
    let raw = '';

    if (kind === 'diary') {
        const diaries = diariesOfBondSync(space.id);
        const today = diaries.find(d => d.date === space.todayKey);
        if (today && !pageEmpty(today.charPage)) return null; // 今天已經寫過了
        const recent = [...diaries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 2)
            .map(d => `- ${d.date}：${[pagePublished(d.userPage) ? `${space.leftName}：${d.userPage.text.slice(0, 160)}` : '', pagePublished(d.charPage) ? `你：${d.charPage!.text.slice(0, 160)}` : ''].filter(Boolean).join('；')}`)
            .filter(l => !l.endsWith('：')).join('\n');
        raw = await askChar(space, apiConfig, buildDiaryPrompt({
            ...ctx, date: space.todayKey,
            userPage: today && pagePublished(today.userPage) ? today.userPage.text : undefined,
            recentDiaries: recent, chars: DIARY_LENGTH_CHARS[setting.length], style: setting.style, withNotice,
        }), '日記');
        const parsed = parseDiary(raw);
        if (!parsed) throw new Error('日記沒寫出來');
        const base: DiaryEntry = today || blankDiary({ charId: space.char.id, bondId: space.id, date: space.todayKey });
        await DB.saveDiary(putCharPage(base, { text: parsed.text, paperStyle: 'plain', stickers: [] }, 'ai_scheduled'));
        trackEvent('写羁绊日记', { 谁: '角色', 方式: '主动' });
    } else if (kind === 'question') {
        raw = await askChar(space, apiConfig, buildCharAskPrompt({
            ...ctx, relationLine: relationLineOf(space), length: setting.length, withNotice,
            askedBefore: entries.filter(e => e.kind === 'question' && e.status === 'published').map(e => e.question!.prompt),
        }), '拾光問答');
        const out = parseCharAsk(raw);
        if (!out) throw new Error('沒出成題');
        await saveBondEntry(answerQuestion(newQuestion({ bondId: space.id, openedBy: space.char.id, prompt: out.question, origin: 'char', topic: out.topic }), 'char', { text: out.answer, state: 'sealed' }));
        trackEvent('拾光问答', { 动作: '出题', 来源: '角色出' });
    } else if (kind === 'note') {
        // 你丟來、TA 還沒回的那張先回；沒有就自己丟一張
        const pending = entries
            .filter(e => e.kind === 'note' && e.status === 'published' && e.author === 'user' && !e.slip?.replyTo)
            .filter(e => !slipReplies(entries, e.id).some(r => r.author !== 'user'))
            .sort((a, b) => (b.slip?.deliveredAt || 0) - (a.slip?.deliveredAt || 0))[0];
        if (pending) {
            raw = await askChar(space, apiConfig, buildSlipReplyPrompt({
                ...ctx, length: setting.length, withNotice, canMarkState: true,
                slip: { fromName: space.leftName, text: pending.text, tags: pending.slip?.tags || [] },
                thread: slipReplies(entries, pending.id).map(e => ({ fromName: e.author === 'user' ? space.leftName : view.name, text: e.text })),
            }), '心靈角落');
            const out = parseSlip(raw, []);
            if (!out) throw new Error('沒回成紙條');
            const state = parseSlipReplyState(raw);
            await saveBondEntries([
                deliverSlip(newSlip({ bondId: space.id, author: space.char.id, text: out.text, tags: [], replyTo: pending.id })),
                ...(state ? [setSlipState(pending, state)] : []),
            ]);
        } else {
            const tags = slipTagOptions(space.bond.noteTags);
            raw = await askChar(space, apiConfig, buildSlipPrompt({
                ...ctx, tags, relationLine: relationLineOf(space), recentSlips: recentSlipLines(space, entries), length: setting.length, withNotice,
            }), '心靈角落');
            const out = parseSlip(raw, tags);
            if (!out) throw new Error('沒寫成紙條');
            await saveBondEntry(deliverSlip(newSlip({ bondId: space.id, author: space.char.id, text: out.text, tags: out.tags })));
        }
        trackEvent('投递心灵纸条', { 谁: '角色', 方式: '主动' });
    } else {
        // 隨筆：讓 TA 自己挑一件還沒寫過的，寫成草稿（你收下才算，跟第 2 批同一條路）
        const items = buildTimeline({
            bond: space.bond, entries,
            memories: { charId: space.char.id, list: memoriesForLine(space.char.memories, space.personaKey, space.char.primaryPersonaKey) },
        });
        const out = await runEssay({ space, characters: [space.char], items, entries, apiConfig, writerId: space.char.id, mode: 'choose' });
        await saveBondEntry(essayDraft({ bondId: space.id, writerId: space.char.id, item: out.item, parsed: out.parsed }));
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
