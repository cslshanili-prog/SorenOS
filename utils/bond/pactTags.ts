/**
 * 角色在私聊裡提議約定、默契（plans/bond-batch4.md 1.7）：
 * `[[ACTION:BOND_PROMISE|內容|頻率]]`、`[[ACTION:BOND_HABIT|內容]]`（不寫 `ACTION:` 也認）。
 *
 * - 標籤一律剝掉；這條線有羈絆空間、不是小號、沒在拉黑中才收，一輪各一個。
 * - 收下就建一張「提議中」的卡（角色那邊已經說好），聊天裡落一張小卡（type `bond_invite`＋`metadata.bondProposal`），
 *   你按「好」才成立、按「先不要」就把那張卡刪掉；在羈絆裡答應也算（小卡讀卡片現在的狀態）。
 * - 雲端兩條路由 worker 原樣直通（SOREN_PASSTHROUGH_TAG_RE），客戶端照這裡解析。
 * 純邏輯，有測試。
 */
import { isBondOpen } from './openState';
import type { BondEntry, BondPromiseRepeat, BondRecord, BondTaskCheck, CharacterProfile } from '../../types';
import { newHabit, newPromise, newWish, PROMISE_TEMPLATES, publishWish, repeatLabel } from './pact';

const TAG_RE = /\[\[\s*(?:ACTION\s*[:：]\s*)?(BOND_PROMISE|羈絆約定|羁绊约定|BOND_HABIT|羈絆默契|羁绊默契)\s*(?:[|｜]([^\]\n]*))?\]\]/g;
const isHabitTag = (name: string): boolean => /HABIT|默契/.test(name);

export interface PactProposalTag {
    kind: 'promise' | 'habit';
    text: string;
    /** 約定才有：角色寫的頻率原文（可能空） */
    freq?: string;
}

/** 剝掉標籤；約定、默契各收第一個（沒寫內容的不算） */
export function extractPactTags(text: string): { cleanedText: string; promise: PactProposalTag | null; habit: PactProposalTag | null } {
    let promise: PactProposalTag | null = null;
    let habit: PactProposalTag | null = null;
    let hit = false;
    const cleanedText = text.replace(TAG_RE, (_m, name: string, body: string | undefined) => {
        hit = true;
        const parts = String(body || '').split(/[|｜]/).map(s => s.trim());
        const content = (parts[0] || '').slice(0, 80);
        if (!content) return '';
        if (isHabitTag(name)) { if (!habit) habit = { kind: 'habit', text: content }; }
        else if (!promise) promise = { kind: 'promise', text: content, freq: parts[1] || '' };
        return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { cleanedText: hit ? cleanedText : text, promise, habit };
}

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const toNum = (s: string): number => (/^\d+$/.test(s) ? Number(s) : s === '十' ? 10 : s.startsWith('十') ? 10 + (CN_NUM[s[1]] || 0) : s.endsWith('十') ? (CN_NUM[s[0]] || 0) * 10 : CN_NUM[s] || 0);
const WEEKDAY_OF: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/** 頻率原文 → 重複方式；看不懂、沒寫就當一次 */
export function parseRepeat(freq: string | undefined, today = new Date()): BondPromiseRepeat {
    const s = String(freq || '').replace(/\s+/g, '');
    if (!s) return { kind: 'once' };
    if (/^(每天|每日|天天|每晚|每天晚上|每早|每天早上|daily)/i.test(s)) return { kind: 'daily' };
    const nDays = s.match(/每(?:隔)?([\d一二兩两三四五六七八九十]+)天/);
    if (nDays) {
        const n = toNum(nDays[1]);
        if (n === 1) return { kind: 'daily' };
        if (n >= 2 && n <= 60) return { kind: 'everyNDays', n };
    }
    if (/^(每週|每周|每星期|每個星期|每礼拜|每禮拜|weekly)/i.test(s)) {
        const tail = s.replace(/^(每週|每周|每星期|每個星期|每礼拜|每禮拜)/, '');
        const days = [...new Set([...tail.matchAll(/[日天一二三四五六]/g)].map(m => WEEKDAY_OF[m[0]]))].sort((a, b) => a - b);
        return days.length && days.length < 7 ? { kind: 'weekly', days } : { kind: 'weekly' };
    }
    if (/^(每個月|每月|monthly)/i.test(s)) return { kind: 'monthly' };
    if (/^(每年|每一年|yearly)/i.test(s)) {
        const md = s.match(/(\d{1,2})[月\/-](\d{1,2})/);
        const mm = md ? Number(md[1]) : today.getMonth() + 1;
        const dd = md ? Number(md[2]) : today.getDate();
        if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return { kind: 'yearly', date: `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}` };
    }
    return { kind: 'once' };
}

/** 內容像哪個模板就照紀錄判（含模板分數）；都不像就請 AI 讀聊天判斷 */
const TEMPLATE_HINTS: Array<{ id: string; re: RegExp }> = [
    { id: 'goodnight', re: /晚安|睡前/ },
    { id: 'call', re: /電話|电话|通話|通话|視訊|视讯|語音|语音/ },
    { id: 'date', re: /見面|见面|約會|约会/ },
    { id: 'photo', re: /照片|拍照|自拍/ },
    { id: 'music', re: /聽歌|听歌|一起聽|一起听/ },
    { id: 'gift', re: /禮物|礼物/ },
    { id: 'letter', re: /寫信|写信|一封信|寄信/ },
];

export function guessCheck(text: string, repeat: BondPromiseRepeat): { check: BondTaskCheck; points?: number; templateId?: string } {
    if (repeat.kind !== 'once') {
        const hit = TEMPLATE_HINTS.find(h => h.re.test(text));
        const tpl = hit && PROMISE_TEMPLATES.find(t => t.id === hit.id);
        if (tpl) return { check: tpl.check, points: tpl.points, templateId: tpl.id };
    }
    return { check: { kind: 'ai', hint: text } };
}

/** 能不能教／收這兩個標籤：這條線有空間紀錄、不是小號、沒在拉黑中 */
export function canProposePact(char: Pick<CharacterProfile, 'altOf' | 'chatBlock'>, bond: Pick<BondRecord, 'openState'> | undefined): boolean {
    // 空間開著才教、才收（plans/bond-open-spaces.md）；沒開、收起的不提議
    return !char.altOf && !char.chatBlock && isBondOpen(bond);
}

/** 照標籤建「提議中」的卡：角色那邊已經說好，等你 */
export function proposalEntry(tag: PactProposalTag, input: { bondId: string; charId: string; messageNote?: string; now?: number; today?: Date }): BondEntry {
    const now = input.now ?? Date.now();
    if (tag.kind === 'habit') return newHabit({ bondId: input.bondId, author: input.charId, text: tag.text, origin: 'agreed', now });
    const repeat = parseRepeat(tag.freq, input.today);
    const g = guessCheck(tag.text, repeat);
    return newPromise({
        bondId: input.bondId, author: input.charId, text: tag.text, repeat, check: g.check, points: g.points,
        participants: ['user', input.charId], templateId: g.templateId, now,
    });
}

export interface BondProposalMeta {
    kind: 'promise' | 'habit';
    entryId: string;
    bondId: string;
    text: string;
    /** 約定：頻率標籤（給小卡、歷史） */
    repeatText?: string;
    status: 'pending' | 'accepted' | 'declined';
    resolvedAt?: number;
}

export const proposalMeta = (e: BondEntry): BondProposalMeta => ({
    kind: e.kind === 'habit' ? 'habit' : 'promise',
    entryId: e.id, bondId: e.bondId, text: e.text,
    ...(e.promise ? { repeatText: repeatLabel(e.promise.repeat) } : {}),
    status: 'pending',
});

/** 小卡現在的狀態：卡片還在就照卡片（在羈絆裡答應或改過也算），刪了就照訊息上記的 */
export function proposalStatus(meta: BondProposalMeta, entry: BondEntry | undefined): BondProposalMeta['status'] {
    if (!entry) return meta.status === 'accepted' ? 'accepted' : meta.status === 'declined' ? 'declined' : 'declined';
    if (entry.kind === 'promise') {
        if (entry.promise?.agreedBy.user) return 'accepted';
        if (entry.promise?.state === 'dropped') return 'declined';
        return 'pending';
    }
    if (entry.habit?.confirmedBy.user) return 'accepted';
    return entry.habit?.state === 'retired' ? 'declined' : 'pending';
}

/** 私聊教角色的那段（互動類）；沒空間、小號、拉黑中不教 */
export function buildPactProposalPrompt(char: Pick<CharacterProfile, 'altOf' | 'chatBlock'>, bond: Pick<BondRecord, 'openState'> | undefined, userName: string): string {
    if (!canProposePact(char, bond)) return '';
    return [
        '',
        `### 想跟${userName}約定一件事、或確認一個你們的默契時`,
        `聊到想跟${userName}說好以後一起做的事（例如每天互道晚安、每週通一次電話、下次一起去看海），可以在回覆最後另起一行寫 [[ACTION:BOND_PROMISE|約定的內容|頻率]]，頻率寫「一次」「每天」「每週」「每週三」「每月」「每 3 天」「每年」其中一種。`,
        `發現你們之間已經有個不用說也會做的習慣（例如誰先說晚安、吵架後誰先低頭），想跟${userName}確認時，寫 [[ACTION:BOND_HABIT|默契的內容]]。`,
        `這只是提議，會變成一張小卡等${userName}按好，${userName}可以不答應。真的想約、真的覺得是默契時才用，一次最多一個，不要每次都提，也不要拿來重複已經有的約定。`,
        '',
    ].join('\n');
}

/** 小卡在聊天記錄、記憶裡的樣子（角色看得到你回了沒） */
export function formatBondProposalRecord(meta: Partial<BondProposalMeta> | undefined, status?: BondProposalMeta['status']): string {
    const st = status || meta?.status;
    const what = meta?.kind === 'habit' ? `你想跟對方確認一個你們的默契：「${meta?.text || ''}」` : `你提議跟對方約定：「${meta?.text || ''}」${meta?.repeatText ? `（${meta.repeatText}）` : ''}`;
    const state = st === 'accepted' ? (meta?.kind === 'habit' ? '（對方認了）' : '（對方答應了）')
        : st === 'declined' ? '（對方說先不要）'
        : '（對方還沒回）';
    return `[${what}]${state}`;
}

/**
 * 從聊天收存成願望、約定、默契（plans/bond-batch4.md 4e）：寫下的人是你；
 * 願望照「誰的」記、聊天裡說出口了所以直接發布；約定、默契一律是提議中（你這邊說好，等對方確認）。
 */
export function collectedPactEntry(input: {
    kind: 'wish' | 'promise' | 'habit'; bondId: string; charId: string; text: string;
    owner?: 'user' | 'char' | 'both'; repeat?: BondPromiseRepeat; source?: BondEntry['sources'][number]; now?: number;
}): BondEntry {
    const now = input.now ?? Date.now();
    const sources = input.source ? [input.source] : [];
    if (input.kind === 'wish') {
        const owner = input.owner === 'char' ? input.charId : input.owner === 'both' ? 'both' : 'user';
        const w = publishWish(newWish({ bondId: input.bondId, author: 'user', owner, text: input.text, now }), now);
        return { ...w, sources };
    }
    if (input.kind === 'habit') return { ...newHabit({ bondId: input.bondId, author: 'user', text: input.text, origin: 'formed', now }), sources };
    const repeat = input.repeat || { kind: 'once' };
    const g = guessCheck(input.text, repeat);
    return {
        ...newPromise({ bondId: input.bondId, author: 'user', text: input.text, repeat, check: g.check, points: g.points, participants: ['user', input.charId], templateId: g.templateId, now }),
        sources,
    };
}
