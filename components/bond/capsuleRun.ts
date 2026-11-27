/**
 * 留給以後要碰資料庫、叫模型的那一半（plans/bond-batch5.md 第 4 節）：封存、請 TA 也封一封、到期（pact tick）、拆開。
 * 純判斷在 utils/bond/capsule.ts。
 *
 * - 到期只標 dueAt，首頁出卡、聊天落一張「今天可以打開了」（type 'bond_invite'＋metadata.bondCapsule）；不自動拆。
 * - 一起打開的兩封同時拆；拆了之後內容雙方都知道。
 */
import type { APIConfig, BondEntry, CharacterProfile, UserProfile } from '../../types';
import type { ResolvedSpace } from './space';
import { resolveSpace } from './space';
import { askChar, heartContext, relationLineOf } from './heartRun';
import { refreshAchievements } from './pactRun';
import { DB } from '../../utils/db';
import { lineFor, withLineFields } from '../../utils/chatLine';
import { bondEntriesOf } from '../../utils/bond/entryRegistry';
import { saveBondEntries, saveBondEntry } from '../../utils/bond/entries';
import { bondLedgerOf } from '../../utils/bond/ledgerRegistry';
import { totalPoints } from '../../utils/bond/ledger';
import { levelInfo } from '../../utils/bond/level';
import { allRegisteredBonds } from '../../utils/bond/registry';
import { listPersonaSpaces } from '../../utils/bond/spaces';
import { isOnStage } from '../../utils/castRole';
import {
    CHAR_SEALED_MAX, capsulePair, capsulesNowDue, charSealedCount, yearLater, conditionText, markDue, newCapsule, openCapsules, pairCapsules, type CapsuleCtx, type CapsuleOpenWhen,
} from '../../utils/bond/capsule';
import { buildCharCapsulePrompt, outputMaxTokens, parseCapsule } from '../../utils/bond/outputPromptCore';
import { trackEvent } from '../../utils/analytics';
import { updateBond } from '../../utils/bond/store';
import { milestoneLabel } from '../../utils/bond/pact';

const CONDITION_TAG = { date: '日期', anniversary: '纪念日', level: '等级', stage: '阶段' } as const;
export const capsuleConditionTag = (w: CapsuleOpenWhen) => CONDITION_TAG[w.kind];

export function capsuleCtxOf(space: ResolvedSpace): CapsuleCtx {
    return { today: space.todayKey, level: levelInfo(totalPoints(bondLedgerOf(space.id))).level, stage: space.bond.stage, route: space.bond.route };
}

/** 你封一封（給 TA 或一起打開） */
export async function sealUserCapsule(space: ResolvedSpace, capsule: BondEntry): Promise<BondEntry> {
    const saved = await saveBondEntry(capsule);
    trackEvent('留给以后', { 动作: '封存', 谁: capsule.capsule!.to === 'both' ? '一起' : '我', 条件: capsuleConditionTag(capsule.capsule!.openWhen) });
    return saved;
}

/**
 * 請 TA 寫一封封起來：together＝你剛封的那封（一起打開，兩封互指、條件跟你的一樣）；
 * 沒有 together 就是 TA 自己在大日子封給你（openWhen 由呼叫端給，預設一年後的今天）。
 */
export async function askCharCapsule(space: ResolvedSpace, apiConfig: APIConfig, opts: { openWhen: CapsuleOpenWhen; together?: BondEntry; occasion?: string; origin?: 'milestone' | 'eventCard' | 'anniversary' }): Promise<BondEntry> {
    const ctx = await heartContext(space);
    const prompt = buildCharCapsulePrompt({ ...ctx, when: conditionText(opts.openWhen), occasion: opts.occasion, together: !!opts.together, relationLine: relationLineOf(space) });
    const raw = await askChar(space, apiConfig, prompt, '留給以後', undefined, { maxTokens: outputMaxTokens([200, 600], 1800) });
    const out = parseCapsule(raw);
    if (!out) throw new Error(`${space.rightName}這次沒寫出來，再試一次`);
    const mine = newCapsule({
        bondId: space.id, author: space.char.id, to: opts.together ? 'both' : 'user', text: out.text, cover: out.cover, signature: out.signature,
        openWhen: opts.openWhen, paperStyle: opts.together?.capsule?.paperStyle, origin: opts.together ? 'together' : opts.origin || 'milestone',
    });
    if (opts.together) {
        const [u, c] = pairCapsules(opts.together, mine);
        await saveBondEntries([u, c]);
        trackEvent('留给以后', { 动作: '封存', 谁: '一起', 条件: capsuleConditionTag(opts.openWhen) });
        return c;
    }
    const saved = await saveBondEntry(mine);
    trackEvent('留给以后', { 动作: '封存', 谁: '角色', 条件: capsuleConditionTag(opts.openWhen) });
    return saved;
}

/** 拆開（一起打開的那封一起拆） */
export async function openCapsuleNow(space: ResolvedSpace, e: BondEntry): Promise<BondEntry[]> {
    const pair = capsulePair(bondEntriesOf(space.id), e);
    const opened = await saveBondEntries(openCapsules(pair ? [e, pair] : [e]));
    const c = e.capsule!;
    trackEvent('留给以后', { 动作: c.dueAt ? '拆开' : '提前拆', 谁: c.to === 'both' ? '一起' : e.author === 'user' ? '我' : '角色', 条件: capsuleConditionTag(c.openWhen) });
    void refreshAchievements(space).catch(() => undefined);
    return opened;
}

/** 條件到了的標上 dueAt、聊天落一張小卡（pact 的 tick 呼叫）。回傳這次到期的封數 */
export async function checkDueCapsules(scope: { characters: CharacterProfile[]; userProfileBase: UserProfile }, now = Date.now()): Promise<number> {
    const chars = scope.characters.filter(c => !c.altOf && isOnStage(c)).map(c => withLineFields(scope.userProfileBase, c));
    let n = 0;
    for (const sp of listPersonaSpaces(chars, allRegisteredBonds())) {
        const entries = bondEntriesOf(sp.id);
        if (!entries.some(e => e.kind === 'capsule')) continue;
        const space = resolveSpace(sp.id, chars, scope.userProfileBase, () => true);
        if (!space || space.kind !== 'persona') continue;
        const due = capsulesNowDue(entries, capsuleCtxOf(space));
        if (!due.length) continue;
        await saveBondEntries(due.map(e => markDue(e, now)));
        const carded = new Set<string>();
        for (const e of due) {
            if (carded.has(e.id) || (e.capsule!.pairWith && carded.has(e.capsule!.pairWith))) continue;
            carded.add(e.id);
            const line = lineFor(space.char, space.personaKey);
            await DB.saveMessage({
                ...(line.personaKey ? { charId: space.char.id, personaKey: line.personaKey } : { charId: space.char.id }),
                role: 'assistant', type: 'bond_invite', content: '[留給以後：今天可以打開了]',
                metadata: { bondCapsule: { bondId: space.id, entryId: e.author !== 'user' && e.capsule!.pairWith ? e.capsule!.pairWith : e.id, event: 'due', ...(e.capsule!.cover ? { cover: e.capsule!.cover } : {}), when: conditionText(e.capsule!.openWhen) } },
            } as Parameters<typeof DB.saveMessage>[0]).catch(() => undefined);
            n++;
        }
    }
    return n;
}

const DAY = 86400_000;

/**
 * TA 在大日子封一封給你（plans/bond-batch5.md 4.2，pact 的 tick 呼叫）：里程碑記下（含事件卡演成）、每年的相識紀念日。
 * 條件預設「一年後的今天」；每段關係同時封著的 TA 的最多 5 封；一次 tick 最多寫一封。第一次看到只記起點。
 */
export async function charSealOnBigDays(scope: { characters: CharacterProfile[]; userProfileBase: UserProfile; apiConfig: APIConfig }, now = Date.now()): Promise<BondEntry | null> {
    const chars = scope.characters.filter(c => !c.altOf && isOnStage(c)).map(c => withLineFields(scope.userProfileBase, c));
    const stored = new Set(allRegisteredBonds().map(b => b.id));
    for (const sp of listPersonaSpaces(chars, allRegisteredBonds())) {
        if (!stored.has(sp.id)) continue; // 還沒存進表的空間不替它開一筆
        const space = resolveSpace(sp.id, chars, scope.userProfileBase, () => true);
        if (!space || space.kind !== 'persona' || !space.view || !space.user) continue;
        const checked = space.bond.charCapsuleCheckedAt;
        if (!checked) { await updateBond(sp.id, b => ({ ...b, charCapsuleCheckedAt: now })); continue; }
        const entries = bondEntriesOf(sp.id);
        if (charSealedCount(entries) >= CHAR_SEALED_MAX) continue;
        // 今天已經封過一封就不再封
        if (entries.some(e => e.kind === 'capsule' && e.author !== 'user' && now - e.capsule!.sealedAt < DAY)) continue;
        let occasion: string | undefined;
        let origin: 'milestone' | 'eventCard' | 'anniversary' = 'milestone';
        const ms = (space.bond.outputEvents || []).filter(e => e.kind === 'milestone' && e.at > checked).sort((a, b) => b.at - a.at)[0];
        if (ms) {
            const m = entries.find(e => e.id === ms.ref);
            if (m?.milestone) {
                origin = m.milestone.via === 'eventCard' ? 'eventCard' : 'milestone';
                occasion = `你們剛記下一個里程碑：${milestoneLabel(m.milestone.what, m.title)}${m.text ? `（${m.text.slice(0, 60)}）` : ''}。`;
            }
        }
        const met = (space.view.acquaintanceStartDate || '').slice(0, 10);
        if (!occasion && /^\d{4}-\d{2}-\d{2}$/.test(met) && met.slice(5) === space.todayKey.slice(5) && met < space.todayKey
            && !entries.some(e => e.kind === 'capsule' && e.capsule?.origin === 'anniversary' && now - e.capsule.sealedAt < 300 * DAY)) {
            origin = 'anniversary';
            occasion = `今天是你們認識滿 ${Number(space.todayKey.slice(0, 4)) - Number(met.slice(0, 4))} 年的日子。`;
        }
        await updateBond(sp.id, b => ({ ...b, charCapsuleCheckedAt: now }));
        if (!occasion) continue;
        try {
            return await askCharCapsule(space, scope.apiConfig, { openWhen: { kind: 'date', date: yearLater(space.todayKey) }, occasion, origin });
        } catch (e) {
            console.warn('💌 [Capsule] TA 封一封沒寫成', e);
            return null;
        }
    }
    return null;
}
