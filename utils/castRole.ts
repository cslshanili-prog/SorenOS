/**
 * 主角／配角與下戲（關係線第 6 批，plans/persona-line-batch6.md 第 1 節）。純邏輯。
 *
 * - 配角跟主角同一張表、同一套能力；神經鏈接有自己的分頁，主動消息預設關。
 * - 下戲：停掉所有會自己跑的東西（主動消息、日程與情緒、自動發朋友圈、節日活動……），
 *   記憶和紀錄都留著；你主動找它照常能聊。背景系統一律過 isOnStage，不要各寫一套。
 */
import type { CharacterProfile } from '../types';

type CastRef = Pick<CharacterProfile, 'castRole' | 'benchedAt'> | null | undefined;

export const isSupporting = (char: CastRef): boolean => char?.castRole === 'supporting';

export const isLead = (char: CastRef): boolean => !!char && char.castRole !== 'supporting';

/** 下戲中 */
export const isBenched = (char: CastRef): boolean => !!char?.benchedAt;

/** 還在戲裡（背景系統要不要替它跑東西就看這個） */
export const isOnStage = (char: CastRef): boolean => !!char && !char.benchedAt;

/** 選角色的地方的排序：主角在前、配角在後、下戲的最後；同一層照原順序。 */
export function castOrder(char: CastRef): number {
    if (isBenched(char)) return 2;
    return isSupporting(char) ? 1 : 0;
}

export function sortByCast<T extends Pick<CharacterProfile, 'castRole' | 'benchedAt'>>(chars: T[]): T[] {
    return chars.map((c, i) => ({ c, i })).sort((x, y) => castOrder(x.c) - castOrder(y.c) || x.i - y.i).map(x => x.c);
}
