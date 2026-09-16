/**
 * 购物中心「外卖代付请求」的 AI 收发标签解析——跟 utils/transferFormat.ts 同一个路数
 * （记录形态 + 输出语法两层词汇表，模型从「见过的」到「该写的」只换一个词），但范围窄得多：
 * 只有 accept / decline 两个动作，没有「send」——代付请求本身永远是用户从购物中心 mini-app
 * 手动发起的（见 apps/Chat.tsx 的 handleSendMallOrder），角色不会主动发起一笔代付请求。
 *
 * 历史:  [[记录:MALL|kind=food|mode=daifu|items=简餐套餐x1|amount=32|status=待处理/已支付/已拒绝]]
 * 输出:  [[ACTION:DAIFU_ACCEPT]] / [[ACTION:DAIFU_DECLINE|reason=简短原因]]
 */

export type MallOrderAiEvent =
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
const ACTION_ACCEPT_RE = /\[\[\s*ACTION\s*[:：]\s*DAIFU_ACCEPT\s*\]\]/gi;
const ACTION_DECLINE_RE = /\[\[\s*ACTION\s*[:：]\s*DAIFU_DECLINE\s*((?:\|[^\]]*)?)\s*\]\]/gi;

function parseDeclineArgs(argStr: string): string | undefined {
    for (const part of argStr.split(/[|｜]/)) {
        const seg = part.trim();
        const eq = seg.search(/[=＝]/);
        if (eq < 0) continue;
        const k = seg.slice(0, eq).trim().toLowerCase();
        const v = seg.slice(eq + 1).trim();
        if ((k === 'reason' || k === '原因') && v) return v;
    }
    return undefined;
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
