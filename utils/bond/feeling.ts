/**
 * 親近與信任（plans/bond-batch4.md 1.8）：角色對你的兩條量表。純函式，零依賴（提示詞那頭也讀）。
 *
 * - 等級只會往上；會掉的是這兩條。背叛主要打信任，親近不一定掉那麼多。
 * - 照事件動，不照聊天量動：閒聊、問候、重複讚美 Δ＝0。
 * - 幅度：微小 ±2、小 ±5、中 ±10、大 ±20；單次最多 ±15，背叛 ±25。
 * - 先歸因：惡意 ×1.5、無心 ×1、不可抗力 ×0.3、已補救 ×0.5、重複犯錯 ×1.5。
 * - 防刷：同一種正向事件一天內第 2 次 ×0.5、第 3 次 ×0.2、之後 0；禮物、讚美、討好一天合計最多 +3；
 *   道歉沒有行動：第 1 次 +2、第 2 次 0、第 3 次 −2；道歉＋補救最多回補那筆傷扣掉的 70%。
 * - 層有緩衝：升層要超過下一層下限 +3、而且沒有未修復的傷；降層要低於本層下限 −3，或發生重大負面事件。
 */
import type { BondFeeling, BondFeelingEvent, BondFeelingHurt, BondRoute } from '../../types';

export const TIER_MINS = [0, 11, 31, 51, 71, 91] as const;
const TIER_BUFFER = 3;
export const SIZE_DELTA = { tiny: 2, small: 5, mid: 10, large: 20 } as const;
export type FeelingSize = keyof typeof SIZE_DELTA;
const SINGLE_CAP = 15;
const BETRAYAL = { closeness: -10, trust: -25 };
const CAUSE_FACTOR: Record<BondFeelingEvent['cause'], number> = { malice: 1.5, careless: 1, unavoidable: 0.3, repaired: 0.5, repeated: 1.5, positive: 1 };
const REPEAT_FACTOR = [1, 0.5, 0.2, 0];
/** 一天合計有上限的正向類別 */
const CAPPED = ['gift', 'praise', 'please'];
const CAPPED_DAILY = 3;
/** 不算數的（Δ＝0，連帳都不記） */
const NEUTRAL = ['chitchat', 'greeting'];
const RECOVER_RATIO = 0.7;
const DAY = 86_400_000;

export const POSITIVE_CATEGORIES: Record<string, string> = {
    sincere: '真誠', understood: '被理解', supported: '被支持', shared: '共同經歷', vulnerable: '脆弱分享', reliable: '可靠的行動',
    gift: '禮物', praise: '讚美', please: '討好', apology: '道歉', repair: '道歉並補救',
};
export const NEGATIVE_CATEGORIES: Record<string, string> = {
    hurt: '傷害', misunderstand: '誤解', broken: '失約', neglect: '冷落', belittle: '貶低', deceive: '欺騙', betrayal: '背叛', cheating: '劈腿',
};
export const CAUSE_LABEL: Record<BondFeelingEvent['cause'], string> = {
    malice: '惡意', careless: '無心', unavoidable: '不可抗力', repaired: '已補救', repeated: '重複犯錯', positive: '好的事',
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function rawTier(v: number): number {
    let t = 1;
    for (let i = 1; i < TIER_MINS.length; i++) if (v >= TIER_MINS[i]) t = i + 1;
    return t;
}

/** 照緩衝挪層：升要過下一層下限 +3 且可以升，降要低於本層下限 −3；重大負面事件直接照數值降 */
export function nextTier(prev: number, v: number, canRise: boolean, forceDrop: boolean): number {
    let t = Math.max(1, Math.min(6, prev || rawTier(v)));
    while (canRise && t < 6 && v >= TIER_MINS[t] + TIER_BUFFER) t++;
    while (t > 1 && v < TIER_MINS[t - 1] - TIER_BUFFER) t--;
    if (forceDrop) t = Math.min(t, rawTier(v));
    return t;
}

export function newFeeling(start: { closeness: number; trust: number }, how: 'estimate' | 'manual', now = Date.now()): BondFeeling {
    const c = clamp(start.closeness); const t = clamp(start.trust);
    return { closeness: c, trust: t, tier: { closeness: rawTier(c), trust: rawTier(t) }, start: { closeness: c, trust: t, at: now, how }, openHurts: [], updatedAt: now };
}

const openHurtsOf = (f: BondFeeling) => f.openHurts.filter(h => !h.repairedAt);

export interface FeelingEventInput {
    what: string;
    category: string;
    valence: 1 | -1;
    size: FeelingSize;
    target: 'closeness' | 'trust' | 'both';
    cause: BondFeelingEvent['cause'];
    /** 有具體的補救行動（不只是嘴上道歉） */
    repair?: boolean;
    messageIds?: number[];
    memoryId?: string;
    source: BondFeelingEvent['source'];
}

/**
 * 記一件事：算出這次動多少（歸因、防刷、上限、回補），更新兩條和層，回傳新的狀態與那一筆帳。
 * 什麼都沒動（閒聊、防刷歸零）回 null，帳也不記。recent 是這段關係最近的帳（防刷用）。
 */
export function applyFeelingEvent(
    feeling: BondFeeling, input: FeelingEventInput, recent: BondFeelingEvent[],
    ctx: { bondId: string; route?: BondRoute; now: number; newId: () => string },
): { feeling: BondFeeling; event: BondFeelingEvent } | null {
    const { now } = ctx;
    if (NEUTRAL.includes(input.category)) return null;
    const live = recent.filter(e => !e.deletedAt);
    const sameDay = live.filter(e => now - e.at < DAY);
    const betrayal = input.category === 'betrayal' || (input.category === 'cheating' && ctx.route === 'romance');
    let dc = 0; let dt = 0;
    let repairs: string | undefined;
    let hurts = feeling.openHurts.map(h => ({ ...h }));

    if (input.category === 'apology' || input.category === 'repair' || (input.valence > 0 && input.repair)) {
        const target = [...openHurtsOf(feeling)].sort((a, b) => b.at - a.at)[0];
        if ((input.repair || input.category === 'repair') && target) {
            // 道歉＋補救：最多回補那筆傷扣掉的 70%
            const room = (k: 'closeness' | 'trust') => Math.max(0, Math.round(-target.lost[k] * RECOVER_RATIO) - (target.recovered?.[k] || 0));
            dc = room('closeness'); dt = room('trust');
            repairs = target.id;
            hurts = hurts.map(h => (h.id === target.id ? { ...h, repairedAt: now, recovered: { closeness: (h.recovered?.closeness || 0) + dc, trust: (h.recovered?.trust || 0) + dt } } : h));
        } else {
            // 只有道歉：第 1 次 +2、第 2 次 0、第 3 次起 −2（一週內）
            const n = live.filter(e => e.category === 'apology' && now - e.at < 7 * DAY).length;
            const d = n === 0 ? 2 : n === 1 ? 0 : -2;
            dc = d; dt = d;
        }
    } else if (input.valence > 0) {
        const n = sameDay.filter(e => e.category === input.category && e.delta.closeness + e.delta.trust > 0).length;
        let base = Math.min(SINGLE_CAP, SIZE_DELTA[input.size]) * REPEAT_FACTOR[Math.min(n, REPEAT_FACTOR.length - 1)];
        if (CAPPED.includes(input.category)) {
            const used = sameDay.filter(e => CAPPED.includes(e.category)).reduce((s, e) => s + Math.max(e.delta.closeness, e.delta.trust, 0), 0);
            base = Math.min(base, Math.max(0, CAPPED_DAILY - used));
        }
        const d = Math.round(base);
        if (input.target !== 'trust') dc = d;
        if (input.target !== 'closeness') dt = d;
    } else if (betrayal) {
        dc = BETRAYAL.closeness; dt = BETRAYAL.trust;
    } else {
        const d = -Math.min(SINGLE_CAP, Math.round(SIZE_DELTA[input.size] * CAUSE_FACTOR[input.cause]));
        if (input.target !== 'trust') dc = d;
        if (input.target !== 'closeness') dt = d;
    }

    const before = { closeness: feeling.closeness, trust: feeling.trust };
    const closeness = clamp(before.closeness + dc);
    const trust = clamp(before.trust + dt);
    const delta = { closeness: closeness - before.closeness, trust: trust - before.trust };

    // 重大負面記一筆傷：背叛、大的、中等而且是惡意或重複犯錯
    const severe = input.valence < 0 && (betrayal || input.size === 'large' || (input.size === 'mid' && (input.cause === 'malice' || input.cause === 'repeated')));
    let hurt: BondFeelingEvent['hurt'];
    if (severe && (delta.closeness || delta.trust)) {
        hurt = { id: ctx.newId(), severity: betrayal || input.size === 'large' ? 'major' : 'mid' };
        hurts = [...hurts, { id: hurt.id, at: now, what: input.what.slice(0, 80), severity: hurt.severity, lost: delta }];
    }
    // 只有道歉、這次 0 分的也要記：第幾次道歉照帳本數
    if (!delta.closeness && !delta.trust && !hurt && !repairs && input.category !== 'apology') return null;

    const canRise = !hurts.some(h => !h.repairedAt);
    const forceDrop = betrayal || hurt?.severity === 'major';
    const next: BondFeeling = {
        ...feeling, closeness, trust, openHurts: hurts, updatedAt: now,
        tier: { closeness: nextTier(feeling.tier.closeness, closeness, canRise, forceDrop), trust: nextTier(feeling.tier.trust, trust, canRise, forceDrop) },
    };
    const event: BondFeelingEvent = {
        id: ctx.newId(), bondId: ctx.bondId, at: now, what: input.what.slice(0, 200), category: input.category,
        cause: input.valence > 0 ? 'positive' : input.cause, delta, before, source: input.source,
        ...(hurt ? { hurt } : {}), ...(repairs ? { repairs } : {}),
        ...(input.messageIds?.length || input.memoryId ? { evidence: { ...(input.messageIds?.length ? { messageIds: input.messageIds } : {}), ...(input.memoryId ? { memoryId: input.memoryId } : {}) } } : {}),
    };
    return { feeling: next, event };
}

/**
 * 事件帳改了或刪了：從起點照帳本（存的 Δ）重算一遍，傷和層也跟著重建。
 */
export function replayFeeling(start: BondFeeling['start'], events: BondFeelingEvent[], now = Date.now()): { feeling: BondFeeling; events: BondFeelingEvent[] } {
    let f: BondFeeling = { closeness: start.closeness, trust: start.trust, tier: { closeness: rawTier(start.closeness), trust: rawTier(start.trust) }, start, openHurts: [], updatedAt: now };
    const out: BondFeelingEvent[] = [];
    for (const e of [...events].sort((a, b) => a.at - b.at)) {
        if (e.deletedAt) { out.push(e); continue; }
        const before = { closeness: f.closeness, trust: f.trust };
        const closeness = clamp(before.closeness + e.delta.closeness);
        const trust = clamp(before.trust + e.delta.trust);
        let hurts: BondFeelingHurt[] = f.openHurts;
        if (e.hurt) hurts = [...hurts, { id: e.hurt.id, at: e.at, what: e.what.slice(0, 80), severity: e.hurt.severity, lost: e.delta }];
        if (e.repairs) hurts = hurts.map(h => (h.id === e.repairs ? { ...h, repairedAt: e.at, recovered: { closeness: (h.recovered?.closeness || 0) + Math.max(0, e.delta.closeness), trust: (h.recovered?.trust || 0) + Math.max(0, e.delta.trust) } } : h));
        const canRise = !hurts.some(h => !h.repairedAt);
        const forceDrop = e.hurt?.severity === 'major';
        f = { ...f, closeness, trust, openHurts: hurts, tier: { closeness: nextTier(f.tier.closeness, closeness, canRise, forceDrop), trust: nextTier(f.tier.trust, trust, canRise, forceDrop) } };
        out.push({ ...e, before });
    }
    return { feeling: { ...f, updatedAt: now }, events: out };
}

// ─── 顯示與提示詞 ──────────────────────────────────

const TIER_NAMES = ['初識', '熟悉', '友好', '信賴', '親密', '深度綁定'];
export function tierName(n: number, route?: BondRoute): string {
    if (n === 5) return route === 'romance' ? '熱戀' : route === 'friendship' ? '摯友' : route === 'family' ? '親密無間' : '親密';
    return TIER_NAMES[Math.max(1, Math.min(6, n)) - 1];
}

/** 顯示用較低那條的層名 */
export const feelingTierLabel = (f: BondFeeling, route?: BondRoute) => tierName(Math.min(f.tier.closeness, f.tier.trust), route);

const CLOSENESS_NORMS = [
    '保持禮貌的距離，不主動談私事。',
    '會閒聊、分享一點日常，還不會交心。',
    '願意幫忙、開玩笑，會在意對方的情緒。',
    '想見面、想分享，遇到事會先想到對方。',
    '很想靠近，願意把脆弱的一面給對方看。',
    '對方已經是生活的一部分；親近但仍有各自的界線。',
];
const TRUST_NORMS = [
    '還在觀察，對方說的話會先打個問號。',
    '相信日常的小事，重要的事還會保留。',
    '大部分時候相信對方，願意照對方的話做。',
    '會把心裡話和重要的事交給對方。',
    '幾乎不懷疑對方，對方說的就是真的。',
    '全然託付；就算有誤會也願意先聽對方解釋。',
];
const ROUTE_LINE: Partial<Record<BondRoute, string>> = {
    friendship: '這是友情：可以在乎、會吃醋也只是怕失去朋友；不獨佔、不曖昧。',
    romance: '這是戀愛：可以要求專一，但不能控制、查手機、威脅。',
    family: '這是親情：講責任也講界線，不情緒勒索。',
};

/** 進提示詞的那幾句：只給層和規範，不給數字（免得角色把分數講出來） */
export function feelingPromptLines(f: BondFeeling | undefined | null, otherName: string, route?: BondRoute): string[] {
    if (!f) return [];
    const lines = [
        `你現在對${otherName}的感受：親近在「${tierName(f.tier.closeness, route)}」這一層——${CLOSENESS_NORMS[f.tier.closeness - 1]}信任在「${tierName(f.tier.trust, route)}」這一層——${TRUST_NORMS[f.tier.trust - 1]}這是你心裡的狀態，照自己的方式表現，不要把它講成數字或層級。`,
    ];
    if (route && ROUTE_LINE[route]) lines.push(ROUTE_LINE[route]!);
    const open = f.openHurts.filter(h => !h.repairedAt);
    if (open.length) {
        lines.push(`還沒修復的事：${open.map(h => h.what).join('；')}。這件事還卡在你心裡：你可以冷淡、要求對方道歉、要求一點空間；不可以若無其事，也不會因為親近就自動原諒。對方真心道歉而且有具體的補救，你才會慢慢鬆動。`);
    }
    return lines;
}

/**
 * 情緒評估順風車的那段（跟小屋動態同一招）：要模型在同一份 JSON 裡加可選的 bondFeeling。
 * 只有這段關係開始記親近與信任了才會加。
 */
export function buildFeelingEvalSection(f: BondFeeling, otherName: string, route?: BondRoute): string {
    const open = f.openHurts.filter(h => !h.repairedAt);
    return `

## [可選] 你對${otherName}的親近與信任 (bondFeeling)
你心裡對${otherName}的親近現在在「${tierName(f.tier.closeness, route)}」、信任在「${tierName(f.tier.trust, route)}」。${open.length ? `還沒修復的事：${open.map(h => h.what).join('；')}。` : ''}
只看**這一輪**${otherName}做了什麼、說了什麼，如果真的有會讓你更靠近／更相信、或讓你受傷／失望的事，可以在上述 JSON 裡額外加：
"bondFeeling": { "events": [ { "what": "一句話說發生什麼", "category": "類別", "valence": 1 或 -1, "size": "tiny|small|mid|large", "target": "closeness|trust|both", "cause": "malice|careless|unavoidable|repaired|repeated|positive", "repair": true/false } ] }
- 類別（好的）：sincere 真誠、understood 被理解、supported 被支持、shared 共同經歷、vulnerable 脆弱分享、reliable 可靠的行動、gift 禮物、praise 讚美、please 討好、apology 道歉、repair 道歉並有具體補救。
- 類別（壞的）：hurt 傷害、misunderstand 誤解、broken 失約、neglect 冷落、belittle 貶低、deceive 欺騙、betrayal 背叛、cheating 劈腿。
- 日常閒聊、問候、重複的讚美不算事件；**絕大多數輪都不需要**——沒有就省略整個 bondFeeling 字段。
- 壞的事先想清楚是惡意、無心、不可抗力、已經補救、還是重複犯錯（cause）。只是嘴上道歉沒有行動，repair 填 false。
- size：微小的感動或小摩擦 tiny、明顯 small、重要 mid、很重大 large。`;
}

const SIZES: FeelingSize[] = ['tiny', 'small', 'mid', 'large'];
const CAUSES = Object.keys(CAUSE_FACTOR) as Array<BondFeelingEvent['cause']>;
const TARGETS = ['closeness', 'trust', 'both'] as const;

/** 從評估原文（或任何物件）裡讀 bondFeeling.events；不合法的丟掉 */
export function parseFeelingEvents(obj: unknown, source: BondFeelingEvent['source'] = 'eval'): FeelingEventInput[] {
    const events = (obj as any)?.bondFeeling?.events ?? (obj as any)?.events;
    if (!Array.isArray(events)) return [];
    const out: FeelingEventInput[] = [];
    for (const e of events.slice(0, 5)) {
        if (!e || typeof e !== 'object') continue;
        const what = typeof e.what === 'string' ? e.what.trim() : '';
        const category = typeof e.category === 'string' ? e.category.trim() : '';
        if (!what || !(category in POSITIVE_CATEGORIES || category in NEGATIVE_CATEGORIES || NEUTRAL.includes(category))) continue;
        const valence: 1 | -1 = category in NEGATIVE_CATEGORIES ? -1 : category in POSITIVE_CATEGORIES ? 1 : (Number(e.valence) < 0 ? -1 : 1);
        const size = SIZES.includes(e.size) ? e.size : 'small';
        const target = TARGETS.includes(e.target) ? e.target : 'both';
        const cause = valence > 0 ? 'positive' : CAUSES.includes(e.cause) && e.cause !== 'positive' ? e.cause : 'careless';
        out.push({ what, category, valence, size, target, cause, repair: e.repair === true, source });
    }
    return out;
}

/** 長期冷落：一段時間你都沒說話，每週扣一點親近（不扣信任） */
export const NEGLECT_DAYS = 7;
export function neglectInput(days: number): FeelingEventInput {
    return { what: `${days} 天沒有聯絡`, category: 'neglect', valence: -1, size: 'tiny', target: 'closeness', cause: 'careless', source: 'neglect' };
}

/** 起點估算的提示詞：讀每日總結和聊天設定的關係，給兩個數字 */
export function buildFeelingStartPrompt(input: { charName: string; otherName: string; relation?: string; summaries: string[] }): string {
    return `你是${input.charName}。下面是你和${input.otherName}這段時間的每日總結（舊到新）${input.relation ? `，你認為你們的關係是「${input.relation}」` : ''}：
${input.summaries.length ? input.summaries.map(s => `- ${s}`).join('\n') : '（還沒有總結）'}

照你自己的個性和這些經歷，估一下你現在對${input.otherName}的：
- 親近（0～100）：想靠近對方的程度。0 陌生、30 熟悉、50 友好、70 很親近、90 以上深度綁定。
- 信任（0～100）：相信對方的程度。分數要照真的發生過的事給，背叛過就低、可靠過就高。
只輸出 JSON：{"closeness":數字,"trust":數字,"why":"一句話"}`;
}

export function parseFeelingStart(raw: unknown): { closeness: number; trust: number; why: string } | null {
    const o = raw as any;
    const c = Number(o?.closeness); const t = Number(o?.trust);
    if (!Number.isFinite(c) || !Number.isFinite(t)) return null;
    return { closeness: clamp(c), trust: clamp(t), why: typeof o?.why === 'string' ? o.why.trim().slice(0, 200) : '' };
}
