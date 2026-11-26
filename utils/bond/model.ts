/**
 * 羈絆空間的 id、新建、改路線（plans/bond-batch1.md 1.1、1.3）。純邏輯，不碰資料庫。
 *
 * id：
 * - 身份卡 × 角色：`charId::personaKey`。主線也帶身份卡鍵（不用 lineKey 的「主線＝charId」），
 *   主身份換了（switchPrimaryPersona）空間還是跟著那張卡；舊角色還沒有身份卡鍵時退回 charId。
 * - 角色 × 角色：`pair~A~B`，跟角色私聊線同一個 id（utils/pairLine.ts）。
 */
import type { BondDays, BondRecord, BondRoute, BondRouteChange, CharacterProfile } from '../../types';
import { lineViewPersonaKey } from '../userPersona';
import { defaultStage, stageForRoute } from './routes';

export const BOND_PERSONA_SEPARATOR = '::';

// 角色私聊線 id 的寫法照 utils/pairLine.ts（那邊會連帶載入資料庫，提示詞這頭不想帶），測試鎖兩邊一致
const PAIR_PREFIX = 'pair~';
const pairLineId = (a: string, b: string): string => { const [x, y] = [a, b].sort(); return `${PAIR_PREFIX}${x}~${y}`; };
const isPairLineId = (id: string): boolean => id.startsWith(PAIR_PREFIX);
const parsePairLineId = (id: string): [string, string] | null => {
    const rest = id.slice(PAIR_PREFIX.length);
    const at = rest.indexOf('~');
    if (at <= 0 || at === rest.length - 1) return null;
    return [rest.slice(0, at), rest.slice(at + 1)];
};

export function personaBondId(charId: string, personaKey: string | undefined): string {
    return personaKey ? `${charId}${BOND_PERSONA_SEPARATOR}${personaKey}` : charId;
}

/** 這張角色卡（可能是某條線的視圖）跟「這條線上的你」那段的 id */
export function bondIdForChar(char: Pick<CharacterProfile, 'id' | 'primaryPersonaKey'>): string {
    return personaBondId(char.id, lineViewPersonaKey(char) || char.primaryPersonaKey);
}

export function pairBondId(aId: string, bId: string): string {
    return pairLineId(aId, bId);
}

export function isPairBondId(id: string): boolean {
    return isPairLineId(id);
}

/** 拆 id：身份卡 × 角色回 { charId, personaKey }，角色 × 角色回兩個 id */
export function parseBondId(id: string): { kind: 'persona'; charId: string; personaKey?: string } | { kind: 'pair'; charId: string; otherCharId: string } | null {
    if (isPairLineId(id)) {
        const pair = parsePairLineId(id);
        return pair ? { kind: 'pair', charId: pair[0], otherCharId: pair[1] } : null;
    }
    const at = id.indexOf(BOND_PERSONA_SEPARATOR);
    if (at < 0) return id ? { kind: 'persona', charId: id } : null;
    return { kind: 'persona', charId: id.slice(0, at), personaKey: id.slice(at + BOND_PERSONA_SEPARATOR.length) || undefined };
}

export const DEFAULT_BOND_DAYS: BondDays = { primary: 'met', extra: [] };

/** 還沒存過的空間（自動開啟的）：路線未指定、朋友 */
export function blankBond(id: string, now = Date.now()): BondRecord {
    const parsed = parseBondId(id);
    const base = {
        id, stage: 'friend', openedAt: now, openedBy: 'auto' as const, routeLog: [], days: { ...DEFAULT_BOND_DAYS, extra: [] }, updatedAt: now,
    };
    if (parsed?.kind === 'pair') return { ...base, kind: 'pair', charId: parsed.charId, otherCharId: parsed.otherCharId, pairAutoDiary: true };
    return { ...base, kind: 'persona', charId: parsed?.charId || id, personaKey: parsed?.kind === 'persona' ? parsed.personaKey : undefined };
}

export interface BondRouteTarget {
    route?: BondRoute;
    stage: string;
    stageLabel?: string;
    stageLabelOther?: string;
}

/**
 * 改路線／階段：fix＝建立時選錯（直接改現在的值）；turn＝關係真的變了（從這天起生效）。
 * 兩種都進歷程；什麼都沒變就原物件回傳。
 */
export function applyRouteChange(
    bond: BondRecord,
    target: BondRouteTarget,
    opts: { kind: 'fix' | 'turn'; storyDay: string; note?: string; now?: number },
): BondRecord {
    const stage = stageForRoute(target.route, target.stage || defaultStage(target.route));
    const label = target.stageLabel?.trim() || undefined;
    const labelOther = target.stageLabelOther?.trim() || undefined;
    if (bond.route === target.route && bond.stage === stage && (bond.stageLabel || undefined) === label && (bond.stageLabelOther || undefined) === labelOther) return bond;
    const now = opts.now ?? Date.now();
    const change: BondRouteChange = {
        at: now,
        storyDay: opts.storyDay,
        kind: opts.kind,
        from: { route: bond.route, stage: bond.stage, label: bond.stageLabel },
        to: { route: target.route, stage, label },
        ...(opts.note?.trim() ? { note: opts.note.trim() } : {}),
    };
    return {
        ...bond,
        route: target.route,
        stage,
        stageLabel: label,
        stageLabelOther: labelOther,
        routeLog: [...bond.routeLog, change],
        updatedAt: now,
    };
}

/** 最近一次「關係真的變了」（提示詞只帶這一次） */
export function lastTurn(bond: Pick<BondRecord, 'routeLog'>): BondRouteChange | undefined {
    for (let i = bond.routeLog.length - 1; i >= 0; i--) if (bond.routeLog[i].kind === 'turn') return bond.routeLog[i];
    return undefined;
}
