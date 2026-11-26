/**
 * 親近與信任的讀寫（plans/bond-batch4.md 1.8）。狀態存在 bonds 的 `feeling`（提示詞同步讀登記表），
 * 事件帳存 `bond_feeling_log`。只有開始記了的關係才會動（沒開始的提示詞一字不差、評估也不加那段）。
 *
 * 結算的地方：
 * - 每輪的情緒評估（本機、雲端共用 applyEmotionEvalRaw）順風車帶 bondFeeling → landFeelingFromEval；
 * - 沒開情緒評估的角色：每日總結寫好時讀那天的總結判一次（components/bond/feelingRun.ts）；
 * - 長期冷落：pact 的 tick 順便看（一週沒說話扣一點親近）。
 */
import type { BondFeeling, BondFeelingEvent, BondRoute, CharacterProfile } from '../../types';
import { DB } from '../db';
import { bondForChar } from './registry';
import { bondIdForChar, parseBondId, personaBondId } from './model';
import { bondOrBlank, updateBond } from './store';
import {
    applyFeelingEvent, buildFeelingEvalSection, newFeeling, parseFeelingEvents, replayFeeling, rawTier,
    type FeelingEventInput,
} from './feeling';
import { parseJsonObject } from './outputPromptCore';
import { trackEvent } from '../analytics';

const newId = () => `bf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** 情緒評估要不要加那段（只有這條線開始記了才加） */
export function feelingEvalSectionFor(char: CharacterProfile, otherName: string): string {
    const bond = bondForChar(char);
    return bond?.feeling ? buildFeelingEvalSection(bond.feeling, otherName, bond.route) : '';
}

export async function startFeeling(bondId: string, start: { closeness: number; trust: number }, how: 'estimate' | 'manual'): Promise<void> {
    const existing = bondOrBlank(bondId).feeling;
    if (!existing) {
        await updateBond(bondId, b => ({ ...b, feeling: newFeeling(start, how) }));
        return;
    }
    // 起點改了：照新起點把帳本重算一次
    const c = newFeeling(start, how).start;
    await rebuildFeeling(bondId, c);
}

export async function stopFeeling(bondId: string): Promise<void> {
    await updateBond(bondId, b => { const { feeling: _f, ...rest } = b; return rest as typeof b; });
}

function sizeWord(d: number): '微小' | '小' | '中' | '大' {
    const a = Math.abs(d);
    return a <= 3 ? '微小' : a <= 7 ? '小' : a <= 15 ? '中' : '大';
}

/** 記一串事件（依序套用）。回傳記下的那幾筆 */
export async function recordFeelingEvents(bondId: string, inputs: FeelingEventInput[], route?: BondRoute): Promise<BondFeelingEvent[]> {
    const bond = bondOrBlank(bondId);
    if (!bond.feeling || !inputs.length) return [];
    const recent = (await DB.getBondFeelingLog(bondId).catch(() => [] as BondFeelingEvent[])).filter(e => Date.now() - e.at < 8 * 86_400_000);
    let f: BondFeeling = bond.feeling;
    const saved: BondFeelingEvent[] = [];
    for (const input of inputs) {
        const r = applyFeelingEvent(f, input, [...recent, ...saved], { bondId, route: route ?? bond.route, now: Date.now(), newId });
        if (!r) continue;
        f = r.feeling;
        saved.push(r.event);
    }
    if (!saved.length) return [];
    await DB.saveBondFeelingEvents(saved);
    const before = bond.feeling;
    await updateBond(bondId, b => ({ ...b, feeling: f }));
    for (const e of saved) {
        const d = e.delta.closeness + e.delta.trust;
        if (!d) continue;
        const dropped = Math.min(f.tier.closeness, f.tier.trust) < Math.min(before.tier.closeness, before.tier.trust);
        trackEvent('亲近信任变化', { 方向: d > 0 ? '升' : '降', 幅度: sizeWord(Math.min(e.delta.closeness, e.delta.trust, 0) || Math.max(e.delta.closeness, e.delta.trust)), 降层: dropped ? '是' : '否' });
    }
    return saved;
}

/** 照帳本從起點重算（改了、刪了一筆、或起點換了） */
export async function rebuildFeeling(bondId: string, start?: BondFeeling['start']): Promise<void> {
    const bond = bondOrBlank(bondId);
    if (!bond.feeling) return;
    const log = await DB.getBondFeelingLog(bondId).catch(() => [] as BondFeelingEvent[]);
    const out = replayFeeling(start || bond.feeling.start, log);
    await DB.saveBondFeelingEvents(out.events);
    await updateBond(bondId, b => ({ ...b, feeling: out.feeling }));
}

/** 判錯了：改這筆的說明或分數（之後的照新的重算） */
export async function editFeelingEvent(bondId: string, id: string, patch: Partial<Pick<BondFeelingEvent, 'what' | 'delta' | 'cause'>>): Promise<void> {
    const log = await DB.getBondFeelingLog(bondId).catch(() => [] as BondFeelingEvent[]);
    const e = log.find(x => x.id === id);
    if (!e) return;
    await DB.saveBondFeelingEvents([{ ...e, ...patch, editedAt: Date.now() }]);
    await rebuildFeeling(bondId);
    trackEvent('修正亲近信任', { 动作: '改' });
}

export async function deleteFeelingEvent(bondId: string, id: string): Promise<void> {
    const log = await DB.getBondFeelingLog(bondId).catch(() => [] as BondFeelingEvent[]);
    const e = log.find(x => x.id === id);
    if (!e) return;
    await DB.saveBondFeelingEvents([{ ...e, deletedAt: Date.now() }]);
    await rebuildFeeling(bondId);
    trackEvent('修正亲近信任', { 动作: '删' });
}

/** 你手動補一筆（判漏了） */
export async function addFeelingManually(bondId: string, input: Omit<FeelingEventInput, 'source'>): Promise<BondFeelingEvent[]> {
    return recordFeelingEvents(bondId, [{ ...input, source: 'manual' }]);
}

/** 這條線開始記了嗎（給畫面） */
export const feelingTierOf = (f: BondFeeling | undefined) => (f ? Math.min(f.tier.closeness, f.tier.trust) : 0);
export { rawTier };

/**
 * 情緒評估的原文裡有 bondFeeling 就落下來（本機、雲端共用的落點 applyEmotionEvalRaw 呼叫）。
 * bondId 沒給就照角色卡（線的視圖）算；雲端傳回來的照雲端 id 拆出的線算。失敗靜默，不影響情緒主鏈路。
 */
export async function landFeelingFromEval(rawText: string, char: CharacterProfile, bondId?: string): Promise<number> {
    try {
        const id = bondId || bondIdForChar(char);
        if (!bondOrBlank(id).feeling) return 0;
        const obj = parseJsonObject(rawText || '');
        const inputs = parseFeelingEvents(obj, 'eval');
        if (!inputs.length) return 0;
        return (await recordFeelingEvents(id, inputs)).length;
    } catch (e: any) {
        console.warn('💗 [BondFeeling] land failed (non-fatal):', e?.message);
        return 0;
    }
}

/** 雲端回來的情緒原文：雲端 id 是 `c1~line~pB` 之類，拆出線再算 bondId */
export const cloudFeelingBondId = (localId: string, personaKey: string | undefined, primaryPersonaKey: string | undefined): string =>
    personaBondId(localId, personaKey || primaryPersonaKey);

/** 刪角色、刪身份卡時：那幾段關係的事件帳 */
export async function deleteFeelingLogWhere(match: (bondId: string) => boolean): Promise<void> {
    const log = await DB.getBondFeelingLog().catch(() => [] as BondFeelingEvent[]);
    await DB.deleteBondFeelingEvents(log.filter(e => match(e.bondId)).map(e => e.id));
}
export const deleteFeelingLogOfChar = (charId: string) => deleteFeelingLogWhere(id => {
    const p = parseBondId(id);
    return !!p && (p.charId === charId || (p.kind === 'pair' && p.otherCharId === charId));
});
export const deleteFeelingLogOfPersona = (personaKey: string) => deleteFeelingLogWhere(id => {
    const p = parseBondId(id);
    return !!p && p.kind === 'persona' && p.personaKey === personaKey;
});
