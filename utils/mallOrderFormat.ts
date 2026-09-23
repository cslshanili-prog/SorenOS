/**
 * 購物中心的 AI 收發標籤解析——跟 utils/transferFormat.ts 同一個路數（記錄形態 + 輸出語法
 * 兩層詞彙表，模型從「見過的」到「該寫的」只換一個詞）：
 *
 * - GIFT：角色主動送用戶一份禮物/外賣，跟 TRANSFER 的「send」對稱——發送即結清，從角色自己
 *   的 Real Balance 扣款（單向支出，不是轉帳，用戶這邊沒有對應入帳，錢花在了「物」上）。
 * - DAIFU_ACCEPT / DAIFU_DECLINE：角色對用戶發起的「外賣代付請求」支付或拒絕，沒有對應的
 *   「send」變體——代付請求永遠是用戶從購物中心 mini-app 手動發起的（見 apps/Chat.tsx 的
 *   handleSendMallOrder），角色不會主動發起一筆代付請求（那反而該用 GIFT）。
 *
 * 歷史:  [[記錄:MALL|kind=food|mode=daifu|items=簡餐套餐x1|amount=32|status=待處理/已支付/已拒絕]]
 * 輸出:  [[ACTION:GIFT|item=禮物名|price=數字|note=可選備註]]
 *        [[ACTION:DAIFU_ACCEPT]] / [[ACTION:DAIFU_DECLINE|reason=簡短原因]]
 */

export type MallOrderAiEvent =
    | { kind: 'send'; item: string; price: string; note?: string }
    | { kind: 'accept' }
    | { kind: 'decline'; reason?: string };

export interface MallRecordInput {
    kind: 'shop' | 'food';
    mode: 'gift' | 'daifu' | 'manual';
    items: { name: string; qty: number }[];
    amount: number;
    status: 'sent' | 'pending' | 'accepted' | 'declined';
}

const STATUS_LABEL: Record<MallRecordInput['status'], string> = {
    sent: '已送出', pending: '待處理', accepted: '已支付', declined: '已拒絕',
};

/** 消息 -> 歷史記錄行，跟 formatTransferRecord 一樣是冪等哨兵：模型復讀這行會被消費丟棄，不產生新事件。 */
export function formatMallOrderRecord(input: MallRecordInput): string {
    const itemsPart = input.items.map(i => `${i.name}x${i.qty}`).join('、') || '（空）';
    return `[[記錄:MALL|kind=${input.kind}|mode=${input.mode}|items=${itemsPart}|amount=${input.amount}|status=${STATUS_LABEL[input.status]}]]`;
}

interface Hit { start: number; end: number; event: MallOrderAiEvent | null; }

const RECORD_MALL_RE = /\[\[\s*[记記記][录錄錄]\s*[:：]\s*MALL[^\]]*\]\]/gi;
const ACTION_GIFT_RE = /\[\[\s*ACTION\s*[:：]\s*GIFT\s*((?:\|[^\]]*)?)\s*\]\]/gi;
const ACTION_ACCEPT_RE = /\[\[\s*ACTION\s*[:：]\s*DAIFU_ACCEPT\s*\]\]/gi;
const ACTION_DECLINE_RE = /\[\[\s*ACTION\s*[:：]\s*DAIFU_DECLINE\s*((?:\|[^\]]*)?)\s*\]\]/gi;

/** kv 解析：`item=禮物名|price=19.9|note=...` → {item, price, note}，鍵名不分大小寫、支持中文鍵。 */
function parseKvArgs(argStr: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of argStr.split(/[|｜]/)) {
        const seg = part.trim();
        if (!seg) continue;
        const eq = seg.search(/[=＝]/);
        if (eq < 0) continue;
        const k = seg.slice(0, eq).trim().toLowerCase();
        const v = seg.slice(eq + 1).trim();
        if (k) out[k] = v;
    }
    return out;
}

function parseDeclineArgs(argStr: string): string | undefined {
    const kv = parseKvArgs(argStr);
    return kv.reason || kv['原因'] || undefined;
}

/** `[[ACTION:GIFT|...]]` → send 事件；item/price 缺一個都當無效標籤剝掉不產生事件
 *（比 transferFormat.ts 的金額校驗簡單——這裡不接受口語兜底/防偽造，GIFT 本來就
 * 只由角色一方發起，沒有"文本里的方向信息"需要校驗）。 */
function kvToGiftEvent(argStr: string): MallOrderAiEvent | null {
    const kv = parseKvArgs(argStr);
    const item = (kv.item || kv['商品'] || kv['禮物'] || '').trim();
    const price = (kv.price || kv['價格'] || kv['金額'] || '').trim();
    if (!item || !price || !/^\d+(?:\.\d+)?$/.test(price)) return null;
    const note = kv.note || kv['備註'];
    return { kind: 'send', item, price, note };
}

function collect(text: string, re: RegExp, toEvent: (m: RegExpExecArray) => MallOrderAiEvent | null | undefined, hits: Hit[]): void {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (hits.some(h => start < h.end && end > h.start)) continue;
        const event = toEvent(m);
        if (event === undefined) continue;
        hits.push({ start, end, event });
    }
}

export function extractMallOrderCommands(content: string): { text: string; events: MallOrderAiEvent[]; consumed: number } {
    const src = String(content ?? '');
    if (!src) return { text: '', events: [], consumed: 0 };

    const hits: Hit[] = [];
    collect(src, RECORD_MALL_RE, () => null, hits);
    collect(src, ACTION_GIFT_RE, m => kvToGiftEvent(m[1] ?? ''), hits);
    collect(src, ACTION_ACCEPT_RE, () => ({ kind: 'accept' }), hits);
    collect(src, ACTION_DECLINE_RE, m => ({ kind: 'decline', reason: parseDeclineArgs(m[1] ?? '') }), hits);

    hits.sort((a, b) => a.start - b.start);

    let text = '';
    let cursor = 0;
    for (const h of hits) {
        text += src.slice(cursor, h.start);
        cursor = h.end;
    }
    text += src.slice(cursor);

    return {
        text: text.trim(),
        events: hits.map(h => h.event).filter((e): e is MallOrderAiEvent => e !== null),
        consumed: hits.length,
    };
}
