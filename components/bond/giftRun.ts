/**
 * 禮物圖鑑跑在 App 裡的那一半（plans/bond-batch5.md 1.1、2.3、2.4）：
 * - 開機把送禮單放進登記表；
 * - 舊訂單沒記線：照聊天裡那張購物卡（`metadata.orderId`）在哪條線補上 `lineKey`，找不到算主線；
 * - 買了你打算送的、TA 送出了它在準備的：照品名連回訂單（揭曉「準備了幾天」）；
 * - TA 的打算 60 天沒送就作廢。
 * 純判斷在 utils/bond/gift.ts。
 */
import { isBondOpen } from '../../utils/bond/openState';
import type { APIConfig, BondGiftFollowupPending, BondSource, CharacterProfile, MallOrder, MemoryFragment, Message } from '../../types';
import { DB } from '../../utils/db';
import { lineFor, lineKey } from '../../utils/chatLine';
import { setGiftOrderRegistry, giftOrdersOfChar } from '../../utils/bond/giftOrderRegistry';
import { allRegisteredBondEntries, bondEntriesOf } from '../../utils/bond/entryRegistry';
import { deleteBondEntries, saveBondEntries } from '../../utils/bond/entries';
import {
    addFollowup, buildGiftSummaryPrompt, buildGiftViews, dropGiftPending, expiredSecretIds, giftOrdersFor, giftsForSummary, matchOrderToPlan, orderGiftDir,
    overlayForOrder, parseGiftSummary, withGiftSummaryChecked,
} from '../../utils/bond/gift';
import { personaBondId } from '../../utils/bond/model';
import { bondById } from '../../utils/bond/registry';
import { updateBond } from '../../utils/bond/store';
import { globalMeterApi } from '../../utils/apiCenter';
import { extractContent, safeFetchJson } from '../../utils/safeApi';
import { trackEvent } from '../../utils/analytics';

export async function refreshGiftOrderRegistry(): Promise<void> {
    const orders = await DB.getAllMallOrders().catch(() => [] as MallOrder[]);
    setGiftOrderRegistry(orders);
}

/** 這個角色認識的每條線（主線＋其他身份卡） */
function lineKeysOf(char: Pick<CharacterProfile, 'id' | 'primaryPersonaKey' | 'knownPersonaKeys'>): Array<{ key: string; arg: string | { charId: string; personaKey: string } }> {
    const out = [{ key: char.id, arg: char.id as string | { charId: string; personaKey: string } }];
    for (const pk of char.knownPersonaKeys || []) {
        if (!pk || pk === char.primaryPersonaKey) continue;
        out.push({ key: `${char.id}::${pk}`, arg: { charId: char.id, personaKey: pk } });
    }
    return out;
}

/**
 * 舊送禮單補 lineKey，順便回傳每張單在聊天裡那張卡的訊息 id（跳回原文、抓 TA 收到時的反應用）。
 * 只看這個角色的單。
 */
export async function attributeGiftOrders(char: CharacterProfile): Promise<Map<string, { lineKey: string; messageId: number; message: Message }>> {
    const found = new Map<string, { lineKey: string; messageId: number; message: Message }>();
    const mine = giftOrdersOfChar(char.id);
    if (!mine.length) return found;
    for (const l of lineKeysOf(char)) {
        const msgs = await DB.getMessagesByCharId(l.arg as any, true).catch(() => [] as Message[]);
        for (const m of msgs) {
            const oid = m.type === 'mall_order' ? m.metadata?.orderId : undefined;
            if (oid && !found.has(oid)) found.set(oid, { lineKey: l.key, messageId: m.id, message: m });
        }
    }
    for (const o of mine) {
        if (o.lineKey) continue;
        const hit = found.get(o.id);
        await DB.saveMallOrder({ ...o, lineKey: hit?.lineKey || char.id }).catch(() => undefined);
    }
    return found;
}

/** 這段關係（身份卡 × 角色）的送禮單 */
export function lineGiftOrders(char: Pick<CharacterProfile, 'id' | 'primaryPersonaKey'>, personaKey: string | undefined): MallOrder[] {
    return giftOrdersFor(giftOrdersOfChar(char.id), char.id, lineKey(lineFor(char, personaKey)));
}

/**
 * 買了打算送的、TA 送出了它在準備的：連回訂單；60 天沒送的 TA 的打算作廢。
 * pact 的 tick、打開珍藏時都跑一次。回傳揭曉了幾件 TA 的打算。
 */
export async function syncGiftPlans(spaces: Array<{ bondId: string; char: Pick<CharacterProfile, 'id' | 'primaryPersonaKey'>; personaKey?: string }>, now = Date.now()): Promise<number> {
    let revealed = 0;
    const toSave = [];
    for (const sp of spaces) {
        let entries = bondEntriesOf(sp.bondId);
        const orders = lineGiftOrders(sp.char, sp.personaKey)
            .filter(o => !entries.some(e => e.gift?.orderId === o.id))
            .sort((a, b) => (a.paidAt || a.createdAt) - (b.paidAt || b.createdAt));
        for (const o of orders) {
            const hit = matchOrderToPlan(o, entries, now);
            if (!hit) continue;
            toSave.push(hit);
            entries = entries.map(e => (e.id === hit.id ? hit : e));
            if (orderGiftDir(o) === 'in') { revealed++; trackEvent('羁绊礼物', { 动作: '买了', 方向: 'TA送', 来源: 'TA准备' }); }
            else trackEvent('羁绊礼物', { 动作: '买了', 方向: '我送', 来源: '购物' });
        }
    }
    if (toSave.length) await saveBondEntries(toSave);
    const expired = expiredSecretIds(allRegisteredBondEntries(), now);
    if (expired.length) await deleteBondEntries(expired);
    return revealed;
}

/**
 * 一張送禮單在聊天裡的那張卡：跳回原文用的來源、TA 收到（或送出）時接著說的第一句。
 * 找不到卡（刪了）回 null。
 */
export async function giftCardContext(char: CharacterProfile, orderId: string): Promise<{ source: BondSource; reply?: string } | null> {
    const map = await attributeGiftOrders(char);
    const hit = map.get(orderId);
    if (!hit) return null;
    const arg = hit.lineKey.includes('::') ? { charId: char.id, personaKey: hit.lineKey.split('::')[1] } : char.id;
    const msgs = await DB.getMessagesByCharId(arg as any, true).catch(() => [] as Message[]);
    const sorted = [...msgs].sort((a, b) => a.id - b.id);
    const at = sorted.findIndex(m => m.id === hit.messageId);
    const after = at >= 0 ? sorted.slice(at + 1, at + 8) : [];
    const firstReply = after.find(m => m.role === 'assistant' && m.type === 'text' && String(m.content || '').trim());
    const reply = firstReply ? String(firstReply.content).split('%%BILINGUAL%%')[0].replace(/\[\[[^\]]*\]\]/g, '').trim().slice(0, 160) : undefined;
    return {
        source: { type: 'message', lineId: hit.lineKey, messageIds: [hit.messageId], snippet: reply || '[購物中心卡片]', at: hit.message.timestamp },
        ...(reply ? { reply } : {}),
    };
}

// ─── 每日總結對禮物後續（plans/bond-batch5.md 第 6 節）────────────

const summaryApiOf = (apiConfig: APIConfig) => globalMeterApi(apiConfig) || (apiConfig.baseUrl && apiConfig.apiKey ? { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model } : null);

/**
 * 那天的總結寫好時：副 API 對一下這條線圖鑑裡已經送出的禮物，提到哪件後來怎麼了就放進 `giftFollowupPending`，
 * 珍藏分頁上方問你要不要記進後續（先問你，不自動寫）。同一筆總結只對一次；沒有羈絆空間、圖鑑是空的就不問。
 */
export async function checkGiftFollowupFromSummary(char: CharacterProfile, memory: MemoryFragment, userName: string, apiConfig: APIConfig): Promise<number> {
    const pk = memory.personaKey || char.primaryPersonaKey;
    const bondId = personaBondId(char.id, pk);
    const bond = bondById(bondId);
    if (!bond || !isBondOpen(bond) || bond.giftSummaryChecked?.[memory.id] || !(memory.summary || '').trim()) return 0;
    const views = giftsForSummary(buildGiftViews({ orders: lineGiftOrders(char, pk), entries: bondEntriesOf(bondId), forViewer: 'user' }));
    if (!views.length) return 0;
    const api = summaryApiOf(apiConfig);
    if (!api) return 0;
    const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [{ role: 'user', content: buildGiftSummaryPrompt({ summary: memory.summary, date: String(memory.date || '').slice(0, 10), gifts: views, leftName: userName, rightName: char.name }) }],
            temperature: 0.2, max_tokens: 600,
        }),
    }, 1, 90_000, { appName: '羈絆', charId: char.id, charName: char.name, purpose: '禮物後續' });
    const found = parseGiftSummary(extractContent(data), views).map(f => ({ giftKey: f.gift.key, giftTitle: f.gift.title, text: f.text }));
    const date = /^\d{4}-\d{2}-\d{2}/.test(String(memory.date || '')) ? String(memory.date).slice(0, 10) : undefined;
    await updateBond(bondId, b => withGiftSummaryChecked(b, memory.id, found, date));
    return found.length;
}

/** 你按「記進去」：疊在那件上（購物中心的單第一次補東西先開一張疊上去的卡），來源記那筆總結 */
export async function acceptGiftPending(space: { id: string; char: CharacterProfile; personaKey?: string }, p: BondGiftFollowupPending, text?: string): Promise<boolean> {
    const views = buildGiftViews({ orders: lineGiftOrders(space.char, space.personaKey), entries: bondEntriesOf(space.id), forViewer: 'user' });
    const v = views.find(x => x.key === p.giftKey || (x.entry && `e:${x.entry.id}` === p.giftKey));
    const now = Date.now();
    if (v) {
        const base = v.entry || (v.order ? overlayForOrder(space.id, v.order, now) : undefined);
        if (base) {
            const source: BondSource | undefined = p.memoryId ? { type: 'memory', charId: space.char.id, memoryId: p.memoryId } : undefined;
            await saveBondEntries([addFollowup(base, { by: 'user', text: (text ?? p.text).trim() || p.text, ...(source ? { source } : {}) }, now)]);
            trackEvent('羁绊礼物', { 动作: '后续', 方向: v.dir === 'out' ? '我送' : 'TA送', 来源: '每日总结' });
        }
    }
    await updateBond(space.id, b => dropGiftPending(b, p.id, now));
    return !!v;
}

export async function dismissGiftPending(bondId: string, id: string): Promise<void> {
    await updateBond(bondId, b => dropGiftPending(b, id));
}
