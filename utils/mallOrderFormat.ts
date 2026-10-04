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
 * 歷史:  [[記錄:MALL|kind=food|mode=daifu|items=簡餐套餐x1|amount=32|status=待處理/已支付/已拒絕|eta=10/4 14:40]]
 * 輸出:  [[ACTION:GIFT|item=品名|kind=food或shop|qty=1|price=單價|note=留言]]
 *        （2026-10 起 kind／qty 選填；item 對得上購物中心目錄時價格、emoji、店鋪照目錄，
 *        price 可省略；對不上目錄就一定要有 price。同一則回覆裡的多個 GIFT 會合成一張單。）
 *        [[ACTION:DAIFU_ACCEPT]] / [[ACTION:DAIFU_DECLINE|reason=簡短原因]]
 */

export type MallOrderAiEvent =
    | { kind: 'send'; item: string; price?: string; qty?: number; mallKind?: 'food' | 'shop'; note?: string }
    | { kind: 'accept' }
    | { kind: 'decline'; reason?: string };

export interface MallRecordInput {
    kind: 'shop' | 'food';
    /** gift＝買給對方；self＝用戶買給自己、自己付；daifu＝用戶買給自己、請角色付；manual＝手動模擬的「角色買給用戶」 */
    mode: 'gift' | 'self' | 'daifu' | 'manual';
    items: { name: string; qty: number }[];
    amount: number;
    status: 'sent' | 'pending' | 'accepted' | 'declined';
    /** 預計送達時間（已按角色時區寫好，例如「10/4 14:40」）；還沒付款／取消就不帶 */
    eta?: string;
}

const STATUS_LABEL: Record<MallRecordInput['status'], string> = {
    sent: '已送出', pending: '待處理', accepted: '已支付', declined: '已拒絕',
};

/** 消息 -> 歷史記錄行，跟 formatTransferRecord 一樣是冪等哨兵：模型復讀這行會被消費丟棄，不產生新事件。 */
export function formatMallOrderRecord(input: MallRecordInput): string {
    const itemsPart = input.items.map(i => `${i.name}x${i.qty}`).join('、') || '（空）';
    const etaPart = input.eta ? `|eta=${input.eta}` : '';
    return `[[記錄:MALL|kind=${input.kind}|mode=${input.mode}|items=${itemsPart}|amount=${input.amount}|status=${STATUS_LABEL[input.status]}${etaPart}]]`;
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

const FOOD_KIND = /^(food|外賣|外卖|餐|吃的)$/i;
const SHOP_KIND = /^(shop|購物|购物|禮物|礼物)$/i;

/** `[[ACTION:GIFT|...]]` → send 事件。item 必填；price 寫了就得是數字（`$6.50`、`6.5 美元` 也收），
 * 沒寫留給結算時對目錄（對不上目錄又沒價格的，結算那邊丟掉）。kind／qty 選填。
 *（比 transferFormat.ts 的金額校驗簡單——這裡不接受口語兜底/防偽造，GIFT 本來就
 * 只由角色一方發起，沒有"文本里的方向信息"需要校驗）。 */
function kvToGiftEvent(argStr: string): MallOrderAiEvent | null {
    const kv = parseKvArgs(argStr);
    const item = (kv.item || kv['商品'] || kv['禮物'] || kv['品名'] || '').trim();
    if (!item) return null;
    const rawPrice = (kv.price || kv['價格'] || kv['金額'] || '').replace(/[,，]/g, '').trim();
    let price: string | undefined;
    if (rawPrice) {
        const m = rawPrice.match(/\d+(?:\.\d+)?/);
        if (!m) return null;
        price = m[0];
    }
    const rawKind = (kv.kind || kv['類型'] || kv['類別'] || '').trim();
    const mallKind = FOOD_KIND.test(rawKind) ? 'food' as const : SHOP_KIND.test(rawKind) ? 'shop' as const : undefined;
    const qtyNum = parseInt(kv.qty || kv['數量'] || '', 10);
    const qty = Number.isFinite(qtyNum) && qtyNum > 0 ? Math.min(qtyNum, 20) : undefined;
    const note = kv.note || kv['備註'] || kv['留言'];
    return { kind: 'send', item, price, qty, mallKind, note };
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
