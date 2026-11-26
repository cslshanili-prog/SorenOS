/**
 * 主動產出的設定（plans/bond-batch3.md 1.4）：預設值與解析。排程判斷在第 3c 批加在這裡。
 * 預設照紀要 4.3 的起步建議；整體上限與錯開是常數，設定頁可調。
 */
import type { BondOutputKind, BondOutputSetting, BondRecord } from '../../types';

export const OUTPUT_KINDS: BondOutputKind[] = ['diary', 'question', 'note', 'essay'];

export const OUTPUT_KIND_LABEL: Record<BondOutputKind, string> = { diary: '日記', question: '拾光問答', note: '心靈角落', essay: '隨筆' };

export const DEFAULT_OUTPUT: Record<BondOutputKind, BondOutputSetting> = {
    diary: { enabled: true, everyDays: [1, 3], length: 'medium', syncToChat: true, window: { from: '20:00', to: '23:30' } },
    question: { enabled: true, everyDays: [3, 7], length: 'short', syncToChat: true },
    note: { enabled: true, everyDays: [3, 7], length: 'short', syncToChat: false },
    essay: { enabled: true, everyDays: [5, 10], length: 'medium', syncToChat: false },
};

/** 每段關係一天最多幾份、任兩份至少隔多久；全部關係一天最多幾份 */
export const OUTPUT_LIMITS = { perBondPerDay: 2, minGapMs: 3 * 3600_000, allPerDay: 6 };

/** 篇幅對應的字數（日記用；其他類型照提示詞的口語說法） */
export const DIARY_LENGTH_CHARS: Record<BondOutputSetting['length'], [number, number]> = {
    short: [80, 200], medium: [200, 500], long: [500, 900],
};

export function resolveOutputSetting(bond: Pick<BondRecord, 'output'> | undefined, kind: BondOutputKind): BondOutputSetting {
    const base = DEFAULT_OUTPUT[kind];
    const own = bond?.output?.[kind];
    return own ? { ...base, ...own, everyDays: own.everyDays || base.everyDays } : base;
}
