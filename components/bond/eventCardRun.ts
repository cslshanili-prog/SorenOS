/**
 * 事件卡與同步承認要碰資料庫、叫模型的部分（plans/bond-batch4.md 2.2～2.4）。純規則在 utils/bond/eventCards.ts。
 *
 * - 開演：私聊＝下一輪的系統提示詞帶一段情境（`bonds.eventScene`，組完那一輪就清）；
 *   見面＝把情境放進這條線「下一場故事的大綱」（`dateScenario`），開新的一場時搬進去。
 * - 演完：副 API 讀從開演到現在的那段，整理一句結果和依據；你選成了／還沒／換個方向。
 *   成了才記里程碑、改階段（寫進路線歷程）、可選紀念日；傳統類記一條默契；「好好談一次」標傷已修好。
 * - 同步承認：角色改了「認為的關係」或每日總結寫好時，副 API 看那段有沒有已經發生的轉折，
 *   有而且跟現在不同就排一張卡等你按「對」。
 */
import { isBondOpen } from '../../utils/bond/openState';
import type { APIConfig, BondEntry, BondSyncProposal, CharacterProfile, Message, MemoryFragment } from '../../types';
import type { ResolvedSpace } from './space';
import { DB } from '../../utils/db';
import { lineFor, lineKey } from '../../utils/chatLine';
import { globalMeterApi } from '../../utils/apiCenter';
import { extractContent, safeFetchJson } from '../../utils/safeApi';
import { numberedTranscript } from '../../utils/bond/collect';
import { bondEntriesOf } from '../../utils/bond/entryRegistry';
import { newBondEntryId, saveBondEntries } from '../../utils/bond/entries';
import { bondOrBlank, updateBond } from '../../utils/bond/store';
import { bondForChar } from '../../utils/bond/registry';
import { applyRouteChange, bondIdForChar, personaBondId } from '../../utils/bond/model';
import { stageLabel } from '../../utils/bond/routes';
import { knownMilestones } from '../../utils/bond/visibility';
import { milestoneLabel, newHabit, confirmHabit, newMilestone } from '../../utils/bond/pact';
import { dayEventDate } from '../../utils/bond/eventDate';
import {
    buildEventResultPrompt, buildEventScene, buildSyncPrompt, cardDef, cardsToUnlock, finishCard, newEventCardEntry, parseEventResult, parseSync,
    startCard, SYNC_KINDS, syncProposalFor,
} from '../../utils/bond/eventCards';
import { addFeelingManually } from '../../utils/bond/feelingStore';
import { charParticipant, newEvent, personaParticipant } from '../../utils/calendarEvents';
import { trackEvent } from '../../utils/analytics';

const ROUTE_ANALYTICS = { romance: '恋爱', friendship: '友情', family: '亲情' } as const;
const routeTag = (route?: string) => (route && route in ROUTE_ANALYTICS ? ROUTE_ANALYTICS[route as keyof typeof ROUTE_ANALYTICS] : '未指定');
const apiOf = (apiConfig: APIConfig) => globalMeterApi(apiConfig) || (apiConfig.baseUrl && apiConfig.apiKey ? { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model } : null);

async function ask(apiConfig: APIConfig, char: Pick<CharacterProfile, 'id' | 'name'>, prompt: string, purpose: string, maxTokens = 900): Promise<string> {
    const api = apiOf(apiConfig);
    if (!api) throw new Error('還沒設定 API');
    const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: maxTokens }),
    }, 1, 90_000, { appName: '羈絆', charId: char.id, charName: char.name, purpose });
    return extractContent(data);
}

const lineArgOf = (char: CharacterProfile, personaKey: string | undefined) => {
    const line = lineFor(char, personaKey);
    return (line.personaKey ? { charId: char.id, personaKey: line.personaKey } : char.id) as Parameters<typeof DB.getLineMessagesSince>[0];
};

// ─── 解鎖 ─────────────────────────────────────────

/** 等級到了的卡開出來（pact 的 tick 呼叫）；回傳新開的 */
export async function unlockEventCards(bondId: string, level: number): Promise<BondEntry[]> {
    const bond = bondOrBlank(bondId);
    const hurt = !!bond.feeling?.openHurts.some(h => !h.repairedAt);
    const defs = cardsToUnlock(bondEntriesOf(bondId), bond.route, level, hurt);
    if (!defs.length) return [];
    const now = Date.now();
    const cards = defs.map(def => newEventCardEntry({ bondId, def, id: newBondEntryId(), now }));
    await saveBondEntries(cards);
    for (const _ of cards) trackEvent('事件卡', { 动作: '解锁', 路线: routeTag(bond.route), 结果: '无' });
    return cards;
}

// ─── 開演 ─────────────────────────────────────────

export interface ScenePicks {
    wishIds: string[]; itemTexts: Array<{ key: string; text: string }>;
    /** 珍藏（第 5 批）：帶進去的禮物，text 已寫好誰送誰 */
    giftTexts?: Array<{ key: string; text: string }>;
}

export function sceneTextFor(space: ResolvedSpace, card: BondEntry, picks: ScenePicks): string {
    const entries = bondEntriesOf(space.id);
    const wishes = entries.filter(e => picks.wishIds.includes(e.id)).map(e => e.text.replace(/\s+/g, ' ').slice(0, 60));
    const milestones = knownMilestones(entries).map(m => milestoneLabel(m.milestone!.what, m.title));
    return buildEventScene({
        title: card.title || '', theme: card.text, otherName: space.leftName, venue: card.eventCard!.venue || 'chat',
        wishes, moments: picks.itemTexts.map(i => i.text.replace(/\s+/g, ' ').slice(0, 60)), milestones,
        gifts: (picks.giftTexts || []).map(g => g.text),
    });
}

/** 在私聊開演：下一輪帶情境 */
export async function startInChat(space: ResolvedSpace, card: BondEntry, picks: ScenePicks): Promise<void> {
    const text = sceneTextFor(space, card, picks);
    await saveBondEntries([startCard(card, 'chat', { wishIds: picks.wishIds, itemKeys: picks.itemTexts.map(i => i.key), ...(picks.giftTexts?.length ? { giftKeys: picks.giftTexts.map(g => g.key) } : {}) })]);
    await updateBond(space.id, b => ({ ...b, eventScene: { entryId: card.id, cardId: card.eventCard!.cardId, text, at: Date.now() } }));
    trackEvent('事件卡', { 动作: '开演', 路线: routeTag(space.bond.route), 结果: '无' });
}

/** 在見面開演：情境放進下一場故事的大綱（呼叫端負責寫線上的 dateScenario、開見面） */
export async function startInDate(space: ResolvedSpace, card: BondEntry, picks: ScenePicks): Promise<string> {
    const text = sceneTextFor(space, card, picks);
    await saveBondEntries([startCard(card, 'date', { wishIds: picks.wishIds, itemKeys: picks.itemTexts.map(i => i.key), ...(picks.giftTexts?.length ? { giftKeys: picks.giftTexts.map(g => g.key) } : {}) })]);
    trackEvent('事件卡', { 动作: '开演', 路线: routeTag(space.bond.route), 结果: '无' });
    return `${space.char.name}和${space.leftName}的這一場：${text.replace(/^【這一刻】/, '')}`;
}

/** 私聊那一輪組完提示詞就清（只帶一輪；送失敗了可以從卡片再開演一次） */
export async function consumeEventScene(char: Pick<CharacterProfile, 'id' | 'primaryPersonaKey'>): Promise<void> {
    const bond = bondForChar(char);
    if (!bond?.eventScene) return;
    await updateBond(bondIdForChar(char), b => { const { eventScene: _s, ...rest } = b; return rest as typeof b; });
}

/** 先放著／拿出來 */
export async function setAsideCard(space: ResolvedSpace, card: BondEntry, aside: boolean): Promise<void> {
    await saveBondEntries([{ ...card, eventCard: { ...card.eventCard!, state: aside ? 'setAside' : 'unlocked' }, updatedAt: Date.now() }]);
    if (aside) trackEvent('事件卡', { 动作: '放着', 路线: routeTag(space.bond.route), 结果: '无' });
}

// ─── 演完 ─────────────────────────────────────────

export interface CardJudge { result: 'yes' | 'notYet' | 'other'; summary: string; messageIds: number[] }

export async function judgeCard(space: ResolvedSpace, card: BondEntry, apiConfig: APIConfig): Promise<CardJudge> {
    const since = card.eventCard?.startedAt || Date.now() - 86_400_000;
    let msgs = await DB.getLineMessagesSince(lineArgOf(space.char, space.personaKey), since);
    msgs = msgs.filter(m => m.role !== 'system' && m.type !== 'system' && (card.eventCard?.venue === 'date' ? m.metadata?.source === 'date' : m.metadata?.source !== 'date')).slice(-120);
    if (!msgs.length) return { result: 'notYet', summary: '開演之後還沒有新的對話。', messageIds: [] };
    const nameOf = (m: Pick<Message, 'role'>) => (m.role === 'user' ? space.leftName : space.rightName);
    const raw = await ask(apiConfig, space.char, buildEventResultPrompt({ title: card.title || '', theme: card.text, leftName: space.leftName, rightName: space.rightName, transcript: numberedTranscript(msgs, nameOf) }), '事件卡結果');
    const out = parseEventResult(raw, msgs.length);
    if (!out) throw new Error('這次沒整理出來，再試一次，或直接選結果');
    return { result: out.result, summary: out.summary, messageIds: out.picks.map(n => msgs[n - 1].id) };
}

/**
 * 你選了結果。成了：記里程碑（來源是那幾則）、改階段（勾了才改；寫進路線歷程，標是哪張事件卡）、
 * 可選紀念日、傳統類記一條默契、修復類標傷已修好。
 */
export async function applyCardResult(space: ResolvedSpace, card: BondEntry, input: {
    result: 'yes' | 'notYet' | 'other'; note?: string; messageIds?: number[]; changeStage: boolean; anniversary: boolean;
}): Promise<void> {
    const def = cardDef(card.eventCard!.cardId);
    const now = Date.now();
    const out: BondEntry[] = [finishCard(card, input.result, input.note, now)];
    if (input.result === 'yes') {
        const what = def?.result.milestone || 'custom';
        const title = def?.result.milestoneTitle || (def ? undefined : card.title);
        const lineId = lineKey(lineFor(space.char, space.personaKey));
        let ms = newMilestone({
            bondId: space.id, author: 'user', what, title, text: input.note || '', eventDate: dayEventDate(space.todayKey), via: 'eventCard',
            stageTo: input.changeStage ? def?.result.stageTo : undefined,
            sources: input.messageIds?.length ? [{ type: 'message', lineId, messageIds: input.messageIds, snippet: (input.note || '').slice(0, 60), at: now }] : [],
        });
        if (input.anniversary) {
            const ev = newEvent({
                owner: personaParticipant(space.personaKey), kind: 'anniversary', title: `${milestoneLabel(what, title)}紀念日`, start: space.todayKey, allDay: true,
                participants: [charParticipant(space.char.id)], repeat: 'yearly', charRemembers: true, source: 'user',
            });
            await DB.saveCalendarEvent(ev);
            ms = { ...ms, milestone: { ...ms.milestone!, anniversaryId: ev.id } };
        }
        out.push(ms);
        if (def?.result.habit) {
            const h = newHabit({ bondId: space.id, author: 'user', text: input.note?.trim() || `${card.title}：我們的傳統`, origin: 'agreed' });
            out.push(confirmHabit(confirmHabit(h, 'user'), 'char'));
        }
        const stageTo = def?.result.stageTo;
        if (input.changeStage && stageTo) {
            await updateBond(space.id, b => applyRouteChange(b, { route: b.route, stage: stageTo, stageLabel: b.route === 'family' ? b.stageLabel : undefined }, { kind: 'turn', storyDay: space.todayKey, note: `事件卡「${card.title}」` }));
        }
        if (def?.result.repair && bondOrBlank(space.id).feeling?.openHurts.some(h => !h.repairedAt)) {
            await addFeelingManually(space.id, { what: `「${card.title}」：好好談過了`, category: 'repair', valence: 1, size: 'mid', target: 'both', cause: 'positive', repair: true });
        }
    }
    await saveBondEntries(out);
    // 情境還沒用掉就清掉（演完了）
    if (bondOrBlank(space.id).eventScene?.entryId === card.id) await updateBond(space.id, b => { const { eventScene: _s, ...rest } = b; return rest as typeof b; });
    trackEvent('事件卡', { 动作: '演完', 路线: routeTag(space.bond.route), 结果: input.result === 'yes' ? '成了' : input.result === 'notYet' ? '还没' : '换方向' });
}

/** 自訂事件卡：只能記里程碑，不改階段 */
export async function createCustomCard(bondId: string, custom: { title: string; theme: string; venue: 'chat' | 'date' }): Promise<BondEntry> {
    const [saved] = await saveBondEntries([newEventCardEntry({ bondId, custom, id: newBondEntryId() })]);
    return saved;
}

// ─── 同步承認（2.4）──────────────────────────────

/** 加一張承認卡（同一個來源鍵、同一種轉折只留最新的一張）；角色之間的故事回寫也用它 */
export async function addProposal(bondId: string, p: Omit<BondSyncProposal, 'id' | 'at'>): Promise<void> {
    await updateBond(bondId, b => ({
        ...b,
        syncPending: [...(b.syncPending || []).filter(x => x.key !== p.key && x.what !== p.what), { ...p, id: `sync_${Date.now().toString(36)}`, at: Date.now() }],
        syncAsked: { ...(b.syncAsked || {}), [p.key]: Date.now() },
    }));
}

/** 角色改了「認為的關係」：讀這條線最近那段聊天 */
export async function checkSyncFromChat(char: CharacterProfile, personaKey: string | undefined, userName: string, apiConfig: APIConfig): Promise<void> {
    const bondId = personaBondId(char.id, personaKey || char.primaryPersonaKey);
    const bond = bondOrBlank(bondId);
    // 空間開了才有（plans/bond-open-spaces.md）：沒開、收起的不問
    if (!isBondOpen(bond)) return;
    const msgs = (await DB.getRecentMessagesByCharId(lineArgOf(char, personaKey) as any, 40, true).catch(() => [] as Message[]))
        .filter(m => m.role !== 'system' && m.type !== 'system');
    if (!msgs.length) return;
    const key = `rel:${msgs[msgs.length - 1].id}`;
    if (bond.syncAsked?.[key]) return;
    const nameOf = (m: Pick<Message, 'role'>) => (m.role === 'user' ? userName : char.name);
    const raw = await ask(apiConfig, char, buildSyncPrompt({ leftName: userName, rightName: char.name, stageText: stageLabel(bond), material: numberedTranscript(msgs, nameOf), kind: 'chat' }), '同步承認');
    const out = parseSync(raw, msgs.length);
    if (!out) { await updateBond(bondId, b => ({ ...b, syncAsked: { ...(b.syncAsked || {}), [key]: Date.now() } })); return; }
    const plan = syncProposalFor(out.what, bond.route, bond.stage);
    if (!plan) return;
    await addProposal(bondId, { what: out.what, ...plan, date: out.date, text: out.text, source: 'relationship', key, evidence: { lineId: lineKey(lineFor(char, personaKey)), messageIds: out.picks.map(n => msgs[n - 1].id) } });
}

/** 每日總結寫好時：讀那天的總結 */
export async function checkSyncFromSummary(char: CharacterProfile, memory: MemoryFragment, userName: string, apiConfig: APIConfig): Promise<void> {
    const bondId = personaBondId(char.id, memory.personaKey || char.primaryPersonaKey);
    const bond = bondOrBlank(bondId);
    if (!isBondOpen(bond)) return;
    const key = `mem:${memory.id}`;
    if (bond.syncAsked?.[key] || !(memory.summary || '').trim()) return;
    const raw = await ask(apiConfig, char, buildSyncPrompt({ leftName: userName, rightName: char.name, stageText: stageLabel(bond), material: `［${memory.date}］${memory.summary.trim()}`, kind: 'summary' }), '同步承認');
    const out = parseSync(raw, 0);
    const plan = out ? syncProposalFor(out.what, bond.route, bond.stage) : null;
    if (!out || !plan) { await updateBond(bondId, b => ({ ...b, syncAsked: { ...(b.syncAsked || {}), [key]: Date.now() } })); return; }
    await addProposal(bondId, { what: out.what, ...plan, date: out.date || memory.date.slice(0, 10), text: out.text, source: 'summary', key, evidence: { memoryId: memory.id } });
}

/** 你按「對」：改階段（和路線）、記里程碑、可選紀念日 */
export async function acceptSync(space: ResolvedSpace, p: BondSyncProposal, anniversary: boolean): Promise<void> {
    const day = p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : space.todayKey;
    const label = SYNC_KINDS[p.what]?.label || p.what;
    const fromStory = p.source === 'story';
    if (p.stageTo || p.routeTo) {
        await updateBond(space.id, b => applyRouteChange(b, { route: p.routeTo || b.route, stage: p.stageTo || b.stage }, { kind: 'turn', storyDay: day, note: `${fromStory ? '故事裡' : '聊天裡已經'}${label}` }));
    }
    let ms = newMilestone({
        bondId: space.id, author: fromStory ? space.char.id : 'user', what: p.what, text: p.text, eventDate: dayEventDate(day),
        via: fromStory ? 'story' : p.source === 'summary' ? 'memory' : 'chat',
        stageTo: p.stageTo,
        sources: fromStory && p.evidence.storyId ? [{ type: 'story', entryId: p.evidence.storyId }]
            : p.evidence.memoryId ? [{ type: 'memory', charId: space.char.id, memoryId: p.evidence.memoryId }]
            : p.evidence.messageIds?.length && p.evidence.lineId ? [{ type: 'message', lineId: p.evidence.lineId, messageIds: p.evidence.messageIds, snippet: p.text.slice(0, 60), at: Date.now() }] : [],
    });
    if (anniversary) {
        // 角色之間：紀念日記在 A 的行事曆、B 是參與者（兩人都會記得）；身份卡 × 角色照舊是你的、TA 參與
        const ev = space.kind === 'pair' && space.other ? newEvent({
            owner: charParticipant(space.char.id), kind: 'anniversary', title: `和${space.other.name}${label}紀念日`, start: day, allDay: true,
            participants: [charParticipant(space.other.id)], repeat: 'yearly', charRemembers: true, source: 'user',
        }) : newEvent({
            owner: personaParticipant(space.personaKey), kind: 'anniversary', title: `${label}紀念日`, start: day, allDay: true,
            participants: [charParticipant(space.char.id)], repeat: 'yearly', charRemembers: true, source: 'user',
        });
        await DB.saveCalendarEvent(ev);
        ms = { ...ms, milestone: { ...ms.milestone!, anniversaryId: ev.id } };
    }
    await saveBondEntries([ms]);
    await updateBond(space.id, b => ({ ...b, syncPending: (b.syncPending || []).filter(x => x.id !== p.id) }));
    trackEvent('同步承认关系', { 结果: '对', 来源: syncSourceLabel(p) });
}

const syncSourceLabel = (p: BondSyncProposal) => (p.source === 'summary' ? '每日总结' : p.source === 'story' ? '故事' : '改关系');

export async function rejectSync(space: ResolvedSpace, p: BondSyncProposal): Promise<void> {
    await updateBond(space.id, b => ({ ...b, syncPending: (b.syncPending || []).filter(x => x.id !== p.id) }));
    trackEvent('同步承认关系', { 结果: '不是', 来源: syncSourceLabel(p) });
}
