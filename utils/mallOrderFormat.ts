/**
 * 购物中心的 AI 收发标签解析——跟 utils/transferFormat.ts 同一个路数（记录形态 + 输出语法
 * 两层词汇表，模型从「见过的」到「该写的」只换一个词）：
 *
 * - GIFT：角色主动送用户一份礼物/外卖，跟 TRANSFER 的「send」对称——发送即结清，从角色自己
 *   的 Real Balance 扣款（单向支出，不是转账，用户这边没有对应入账，钱花在了「物」上）。
 * - DAIFU_ACCEPT / DAIFU_DECLINE：角色对用户发起的「外卖代付请求」支付或拒绝，没有对应的
 *   「send」变体——代付请求永远是用户从购物中心 mini-app 手动发起的（见 apps/Chat.tsx 的
 *   handleSendMallOrder），角色不会主动发起一笔代付请求（那反而该用 GIFT）。
 *
 * 历史:  [[记录:MALL|kind=food|mode=daifu|items=简餐套餐x1|amount=32|status=待处理/已支付/已拒绝]]
 * 输出:  [[ACTION:GIFT|item=礼物名|price=数字|note=可选备注]]
 *        [[ACTION:DAIFU_ACCEPT]] / [[ACTION:DAIFU_DECLINE|reason=简短原因]]
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
    sent: '已送出', pending: '待处理', accepted: '已支付', declined: '已拒绝',
};

/** 消息 -> 历史记录行，跟 formatTransferRecord 一样是幂等哨兵：模型复读这行会被消费丢弃，不产生新事件。 */
export function formatMallOrderRecord(input: MallRecordInput): string {
    const itemsPart = input.items.map(i => `${i.name}x${i.qty}`).join('、') || '（空）';
    return `[[记录:MALL|kind=${input.kind}|mode=${input.mode}|items=${itemsPart}|amount=${input.amount}|status=${STATUS_LABEL[input.status]}]]`;
}

interface Hit { start: number; end: number; event: MallOrderAiEvent | null; }

const RECORD_MALL_RE = /\[\[\s*[记記][录錄]\s*[:：]\s*MALL[^\]]*\]\]/gi;
const ACTION_GIFT_RE = /\[\[\s*ACTION\s*[:：]\s*GIFT\s*((?:\|[^\]]*)?)\s*\]\]/gi;
const ACTION_ACCEPT_RE = /\[\[\s*ACTION\s*[:：]\s*DAIFU_ACCEPT\s*\]\]/gi;
const ACTION_DECLINE_RE = /\[\[\s*ACTION\s*[:：]\s*DAIFU_DECLINE\s*((?:\|[^\]]*)?)\s*\]\]/gi;

/** kv 解析：`item=礼物名|price=19.9|note=...` → {item, price, note}，键名不分大小写、支持中文键。 */
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

/** `[[ACTION:GIFT|...]]` → send 事件；item/price 缺一个都当无效标签剥掉不产生事件
 *（比 transferFormat.ts 的金额校验简单——这里不接受口语兜底/防伪造，GIFT 本来就
 * 只由角色一方发起，没有"文本里的方向信息"需要校验）。 */
function kvToGiftEvent(argStr: string): MallOrderAiEvent | null {
    const kv = parseKvArgs(argStr);
    const item = (kv.item || kv['商品'] || kv['礼物'] || '').trim();
    const price = (kv.price || kv['价格'] || kv['金额'] || '').trim();
    if (!item || !price || !/^\d+(?:\.\d+)?$/.test(price)) return null;
    const note = kv.note || kv['备注'];
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
