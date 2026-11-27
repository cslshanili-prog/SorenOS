/**
 * 事件卡與同步承認（plans/bond-batch4.md 2.2～2.5）。純函式，零依賴。
 *
 * - 等級只解鎖「事件的機會」，不換身份；友情、親情線升到幾級都不會往戀愛走。
 * - 演成了才改階段，而且一律是你按「成了」才改（AI 不改路線、不改階段）。
 * - 有未修復的傷時，告白、求婚、婚禮、承認摯友這類卡先不開放演；「好好談一次」什麼時候都能演。
 * - 情境只說「這是一個可能發生 X 的時刻」，不寫台詞、不保證答應。
 * - 聊天裡已經自然發生的（告白成功、在一起、求婚…）照樣承認，不因等級不夠擋住。
 */
import type { BondEntry, BondRoute } from '../../types';
import { parseJsonObject } from './outputPromptCore';

export interface EventCardDef {
    id: string;
    route: BondRoute | 'none';
    title: string;
    unlock: number;
    /** 從哪些階段可以演（沒寫＝任何階段） */
    from?: string[];
    venue: 'chat' | 'date';
    /** 這是什麼樣的時刻（給情境用，也給人看） */
    theme: string;
    result: {
        /** 演成了記哪種里程碑；custom 的用 title */
        milestone: string;
        milestoneTitle?: string;
        /** 演成了改成哪個階段；optional 的讓你勾 */
        stageTo?: string;
        stageOptional?: boolean;
        anniversary?: boolean;
        /** 記一條默契（傳統類） */
        habit?: boolean;
        /** 修復：演成了標未修復的傷已修好 */
        repair?: boolean;
    };
    /** 有未修復的傷時不開放 */
    blockedByHurt?: boolean;
    /** 有未修復的傷時不管等級都能演 */
    alwaysIfHurt?: boolean;
}

const talk = (route: BondRoute | 'none', title = '好好談一次'): EventCardDef => ({
    id: `${route}-talk`, route, title, unlock: route === 'family' ? 3 : 1, venue: 'date', alwaysIfHurt: true,
    theme: '把卡在你們之間的那件事好好攤開來談：誰受了傷、為什麼、之後想怎樣', result: { milestone: 'reconciled', repair: true },
});

export const EVENT_CARDS: EventCardDef[] = [
    { id: 'romance-invite', route: 'romance', title: '專屬邀約', unlock: 2, from: ['friend'], venue: 'chat', theme: '第一次單獨約對方出去，不是一群人、是只有你們兩個', result: { milestone: 'firstDate', stageTo: 'ambiguous', stageOptional: true } },
    { id: 'romance-outing', route: 'romance', title: '單獨出遊', unlock: 3, from: ['friend', 'ambiguous'], venue: 'date', theme: '兩個人一起出遠一點的門、待上一整天', result: { milestone: 'custom', milestoneTitle: '第一次單獨出遊' } },
    { id: 'romance-confession', route: 'romance', title: '告白', unlock: 5, from: ['ambiguous'], venue: 'date', blockedByHurt: true, theme: '心意已經藏不住，可能會有人把喜歡說出口', result: { milestone: 'together', stageTo: 'lovers', anniversary: true } },
    { id: 'romance-anniversary', route: 'romance', title: '關係紀念', unlock: 6, from: ['lovers'], venue: 'chat', theme: '在一起一段時間了，想好好紀念你們走到這裡', result: { milestone: 'custom', milestoneTitle: '關係紀念', stageTo: 'steady', stageOptional: true } },
    { id: 'romance-living', route: 'romance', title: '共同生活', unlock: 7, from: ['lovers', 'steady'], venue: 'chat', theme: '開始談要不要一起生活、住在一起', result: { milestone: 'livingTogether' } },
    { id: 'romance-proposal', route: 'romance', title: '求婚', unlock: 9, from: ['steady'], venue: 'date', blockedByHurt: true, theme: '想跟對方走一輩子，可能會有人問出那句話', result: { milestone: 'proposal', stageTo: 'engaged', anniversary: true } },
    { id: 'romance-wedding', route: 'romance', title: '婚禮', unlock: 10, from: ['engaged'], venue: 'date', blockedByHurt: true, theme: '婚禮的那一天', result: { milestone: 'married', stageTo: 'married', anniversary: true } },
    talk('romance'),
    { id: 'friendship-latenight', route: 'friendship', title: '深夜長談', unlock: 2, venue: 'chat', theme: '夜很深了，聊到平常不會說的事', result: { milestone: 'deepTalk' } },
    { id: 'friendship-entrust', route: 'friendship', title: '重要託付', unlock: 3, venue: 'chat', theme: '有一件重要的事，只放心交給對方', result: { milestone: 'entrusted' } },
    { id: 'friendship-adventure', route: 'friendship', title: '共同冒險', unlock: 4, venue: 'date', theme: '一起做一件有點瘋、有點冒險的事', result: { milestone: 'custom', milestoneTitle: '一起冒險' } },
    { id: 'friendship-bestie', route: 'friendship', title: '承認摯友', unlock: 5, from: ['friend'], venue: 'date', blockedByHurt: true, theme: '你們早就是最好的朋友，可能會有人把這件事說出口', result: { milestone: 'bestFriends', stageTo: 'close' } },
    { id: 'friendship-tradition', route: 'friendship', title: '專屬傳統', unlock: 6, venue: 'chat', theme: '有件事只有你們會一起做，想把它變成你們的傳統', result: { milestone: 'tradition', habit: true } },
    { id: 'friendship-day', route: 'friendship', title: '友情紀念日', unlock: 7, venue: 'chat', theme: '想給你們的友情一個紀念日', result: { milestone: 'custom', milestoneTitle: '友情紀念日', anniversary: true } },
    talk('friendship'),
    { id: 'family-memory', route: 'family', title: '家庭回憶', unlock: 2, venue: 'chat', theme: '翻出一段家裡的舊回憶，一起聊', result: { milestone: 'custom', milestoneTitle: '家庭回憶' } },
    talk('family', '好好談一次（和解）'),
    { id: 'family-living', route: 'family', title: '共同生活', unlock: 4, venue: 'chat', theme: '住在一起、或要重新住在一起', result: { milestone: 'livingTogether' } },
    { id: 'family-tradition', route: 'family', title: '家庭傳統', unlock: 5, venue: 'chat', theme: '家裡有件事每年都要一起做，想把它固定下來', result: { milestone: 'tradition', habit: true } },
    { id: 'family-moment', route: 'family', title: '重要人生時刻', unlock: 7, venue: 'date', theme: '人生裡很重要的一天，對方在場', result: { milestone: 'custom', milestoneTitle: '重要人生時刻', anniversary: true } },
    { id: 'none-deeptalk', route: 'none', title: '深談', unlock: 2, venue: 'chat', theme: '聊到平常不會說的事', result: { milestone: 'deepTalk' } },
    { id: 'none-wish', route: 'none', title: '一起完成一個願望', unlock: 3, venue: 'chat', theme: '一起去完成你們想做的一件事', result: { milestone: 'custom', milestoneTitle: '一起完成了一個願望' } },
    talk('none'),
];

export const cardsForRoute = (route: BondRoute | undefined): EventCardDef[] => EVENT_CARDS.filter(c => c.route === (route || 'none'));
export const cardDef = (cardId: string): EventCardDef | undefined => EVENT_CARDS.find(c => c.id === cardId);

export type CardAvailability = 'ok' | 'locked' | 'stage' | 'hurt';

/** 現在能不能演：等級、階段、未修復的傷 */
export function cardAvailability(def: EventCardDef, ctx: { level: number; stage: string; hasOpenHurt: boolean }): CardAvailability {
    if (def.alwaysIfHurt && ctx.hasOpenHurt) return 'ok';
    if (ctx.level < def.unlock) return 'locked';
    if (def.blockedByHurt && ctx.hasOpenHurt) return 'hurt';
    if (def.from && !def.from.includes(ctx.stage)) return 'stage';
    return 'ok';
}

/**
 * 首頁主視覺的「下一個里程碑」：這條路線上還沒有卡、等級還不到的事件卡裡，解鎖等級最低的那張；
 * 同一級有好幾張時，現在的階段演得了的先。全都解鎖了回 null。
 */
export function nextCardToUnlock(entries: BondEntry[], route: BondRoute | undefined, level: number, stage: string): EventCardDef | null {
    const have = new Set(entries.filter(e => e.kind === 'eventCard').map(e => e.eventCard?.cardId));
    const rest = cardsForRoute(route).filter(d => !have.has(d.id) && d.unlock > level);
    if (!rest.length) return null;
    const low = Math.min(...rest.map(d => d.unlock));
    const tier = rest.filter(d => d.unlock === low);
    return tier.find(d => !d.from || d.from.includes(stage)) || tier[0];
}

/** 等級到了、還沒有卡片的：新開一張（解鎖） */
export function cardsToUnlock(entries: BondEntry[], route: BondRoute | undefined, level: number, hasOpenHurt: boolean): EventCardDef[] {
    const have = new Set(entries.filter(e => e.kind === 'eventCard').map(e => e.eventCard?.cardId));
    return cardsForRoute(route).filter(d => !have.has(d.id) && (level >= d.unlock || (d.alwaysIfHurt && hasOpenHurt)));
}

export function newEventCardEntry(input: { bondId: string; def?: EventCardDef; custom?: { title: string; theme: string; venue: 'chat' | 'date' }; now?: number; id: string }): BondEntry {
    const now = input.now ?? Date.now();
    const title = input.def?.title || input.custom!.title.trim();
    const theme = input.def?.theme || input.custom!.theme.trim();
    return {
        id: input.id, bondId: input.bondId, kind: 'eventCard', author: 'user', title, text: theme,
        eventDate: { precision: 'unknown' }, writtenAt: now, sources: [], links: [], status: 'published', createdBy: input.def ? 'ai' : 'user',
        eventCard: { cardId: input.def?.id || 'custom', state: 'unlocked', unlockedAt: now, venue: input.def?.venue || input.custom!.venue },
        updatedAt: now,
    } as BondEntry;
}

export function setCardState(e: BondEntry, state: NonNullable<BondEntry['eventCard']>['state'], now = Date.now()): BondEntry {
    return { ...e, eventCard: { ...e.eventCard!, state }, updatedAt: now };
}

export function startCard(e: BondEntry, venue: 'chat' | 'date', context: { wishIds: string[]; itemKeys: string[]; giftKeys?: string[] }, now = Date.now()): BondEntry {
    return { ...e, eventCard: { ...e.eventCard!, state: 'playing', venue, startedAt: now, context }, updatedAt: now };
}

/** 演完：成了＝完成；還沒＝回到解鎖、可以再演；換個方向＝結束、不改任何東西 */
export function finishCard(e: BondEntry, result: 'yes' | 'notYet' | 'other', note: string | undefined, now = Date.now()): BondEntry {
    const card = e.eventCard!;
    const outcome = { result, at: now, ...(note?.trim() ? { note: note.trim() } : {}) };
    return {
        ...e,
        eventCard: {
            ...card, state: result === 'notYet' ? 'unlocked' : 'done', outcome,
            history: [...(card.history || []), { ...outcome, venue: card.venue }],
        },
        updatedAt: now,
    };
}

// ─── 情境（開演那一輪） ────────────────────────────

export function buildEventScene(input: {
    title: string; theme: string; otherName: string; venue: 'chat' | 'date';
    wishes: string[]; moments: string[]; milestones: string[];
    /** 珍藏（第 5 批）：跟這一刻相關的禮物（已寫好誰送誰） */
    gifts?: string[];
}): string {
    const bits: string[] = [];
    if (input.milestones.length) bits.push(`你們之前的轉折：${input.milestones.join('；')}`);
    if (input.wishes.length) bits.push(`你們想做的事：${input.wishes.join('；')}`);
    if (input.moments.length) bits.push(`你們一起經歷過：${input.moments.join('；')}`);
    if (input.gifts?.length) bits.push(`你們之間的禮物：${input.gifts.join('；')}`);
    return `【這一刻】這可能是一個「${input.title}」的時刻——${input.theme}。${bits.length ? `\n${bits.join('\n')}` : ''}
這只是一個機會，不是劇本：要不要開口、怎麼說、答不答應，都照你自己的個性、你對${input.otherName}現在的感受和你們現在的關係來；你可以猶豫、可以拒絕、可以要時間，不一定今天就要發生。不要提到「事件」「卡片」這類東西，也不要替${input.otherName}說話或決定。`;
}

export function buildEventResultPrompt(input: { title: string; theme: string; leftName: string; rightName: string; transcript: string }): string {
    return `${input.leftName}和${input.rightName}剛剛經歷了一個可能是「${input.title}」的時刻（${input.theme}）。下面是那段的紀錄（#編號 說話的人：內容）：
${input.transcript || '（沒有紀錄）'}

只照紀錄裡真的發生的事判斷，不要推測、不要替他們補完：
- yes：這件事真的發生了，而且兩個人都接受了（例如告白了、而且答應了）
- notYet：還沒發生、或有人還在猶豫、要時間
- other：往別的方向走了（例如被拒絕、說開後決定維持原樣）
只輸出 JSON：{"result":"yes|notYet|other","summary":"一兩句說發生了什麼、依據是什麼","ids":[依據的編號]}`;
}

export function parseEventResult(raw: string, count: number): { result: 'yes' | 'notYet' | 'other'; summary: string; picks: number[] } | null {
    const o = parseJsonObject(raw);
    if (!o) return null;
    const result = o.result === 'yes' || o.result === 'notYet' || o.result === 'other' ? o.result : null;
    if (!result) return null;
    const picks = Array.isArray(o.ids) ? o.ids.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= count) : [];
    return { result, summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 300) : '', picks: [...new Set(picks)] };
}

// ─── 同步承認（2.4）──────────────────────────────

export const SYNC_KINDS: Record<string, { label: string; route: BondRoute | 'any'; stageTo?: string }> = {
    together: { label: '在一起了', route: 'romance', stageTo: 'lovers' },
    proposal: { label: '求婚成功', route: 'romance', stageTo: 'engaged' },
    married: { label: '結婚了', route: 'romance', stageTo: 'married' },
    bestFriends: { label: '成為摯友', route: 'friendship', stageTo: 'close' },
    reconciled: { label: '和好了', route: 'any' },
};

/**
 * 看到的變化要不要問、問的時候要改成什麼。路線擋：友情、親情線看到戀愛的一律不問；
 * 未指定路線看到戀愛／摯友的，一併問要不要設路線；跟現在的階段一樣的不問。
 */
export function syncProposalFor(what: string, route: BondRoute | undefined, stage: string): { stageTo?: string; routeTo?: BondRoute } | null {
    const k = SYNC_KINDS[what];
    if (!k) return null;
    if (k.route === 'any') return {};
    if (route && route !== k.route) return null;
    if (route === k.route && stage === k.stageTo) return null;
    return { stageTo: k.stageTo, ...(route ? {} : { routeTo: k.route }) };
}

export function buildSyncPrompt(input: { leftName: string; rightName: string; stageText: string; material: string; kind: 'chat' | 'summary' }): string {
    return `${input.leftName}和${input.rightName}現在的關係是「${input.stageText}」。下面是${input.kind === 'chat' ? '他們最近的一段聊天（#編號 說話的人：內容）' : '他們某一天的總結'}：
${input.material}

這段裡有沒有**已經真的發生、而且雙方都接受了**的關係轉折？只認這幾種：
${Object.entries(SYNC_KINDS).map(([k, v]) => `- ${k}：${v.label}`).join('\n')}
- none：都沒有（只是曖昧、開玩笑、假設、還在猶豫、被拒絕，都算 none）
只輸出 JSON：{"what":"上面其中一個","date":"YYYY-MM-DD 或空","text":"一句話說發生了什麼","ids":[依據的編號]}`;
}

export function parseSync(raw: string, count: number): { what: string; date?: string; text: string; picks: number[] } | null {
    const o = parseJsonObject(raw);
    if (!o || typeof o.what !== 'string' || !(o.what in SYNC_KINDS)) return null;
    const text = typeof o.text === 'string' ? o.text.trim().slice(0, 200) : '';
    if (!text) return null;
    const date = typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : undefined;
    const picks = Array.isArray(o.ids) ? o.ids.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= count) : [];
    return { what: o.what, ...(date ? { date } : {}), text, picks: [...new Set(picks)] };
}
