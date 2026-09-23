// 群聊紅包 2.0 —— schema / 領取狀態機 / 拼手氣分配 / 指令解析 / prompt 序列化。
// 純函數、無副作用（時間與隨機數由調用方注入），便於 vitest 直測。
// 金額是純裝飾（與私聊轉帳一致），不接銀行餘額。
import { Message } from '../../types';

export type PacketStatus = 'pending' | 'done' | 'returned' | 'expired';

export interface PacketClaim {
    /** 'user' 或成員 charId */
    claimantId: string;
    amount: number;
    at: number;
}

/** 掛在 type:'transfer' 消息 metadata 上；`packet: true` 判別新版紅包 vs 舊數據 */
export interface GroupPacketMeta {
    packet: true;
    packetType: 'direct' | 'lucky';
    /** 純裝飾金額，兩位小數 */
    totalAmount: number;
    /** direct 恆為 1 */
    shares: number;
    /** 僅 direct：charId 或 'user' */
    targetId?: string;
    note?: string;
    claims: PacketClaim[];
    status: PacketStatus;
    /** 發出 + 24h，懶判定（渲染/領取時判，無定時器） */
    expiresAt: number;
    resolvedAt?: number;
}

/** 領取/退回回執（獨立 transfer 消息，對齊私聊 receipt 模式） */
export interface PacketReceiptMeta {
    packetReceipt: 'claimed' | 'returned';
    /** 原紅包消息 id */
    ref: number;
    amount?: number;
    claimantName: string;
    senderName: string;
}

export const PACKET_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PACKET_NOTE = '恭喜發財';

const round2 = (n: number) => Math.round(n * 100) / 100;

export function makePacketMeta(opts: {
    packetType: 'direct' | 'lucky';
    totalAmount: number;
    shares?: number;
    targetId?: string;
    note?: string;
    now: number;
}): GroupPacketMeta {
    return {
        packet: true,
        packetType: opts.packetType,
        totalAmount: round2(opts.totalAmount),
        shares: opts.packetType === 'direct' ? 1 : Math.max(1, Math.floor(opts.shares ?? 1)),
        targetId: opts.packetType === 'direct' ? opts.targetId : undefined,
        note: opts.note?.trim() || DEFAULT_PACKET_NOTE,
        claims: [],
        status: 'pending',
        expiresAt: opts.now + PACKET_EXPIRY_MS,
    };
}

/**
 * 拼手氣隨機金額——二倍均值法：每份期望 = 剩餘均值，上限 2 倍均值。
 * 保證每份 ≥ 0.01 且給後面每份留足 0.01；最後一份 = 全部餘額（總和守恆）。
 */
export function drawLuckyAmount(remaining: number, remainingShares: number, rand: () => number = Math.random): number {
    if (remainingShares <= 1) return round2(remaining);
    const max = remaining - 0.01 * (remainingShares - 1);
    const raw = round2(rand() * (remaining / remainingShares) * 2);
    return Math.min(Math.max(raw, 0.01), round2(max));
}

export type ClaimResult =
    | { ok: true; meta: GroupPacketMeta; amount: number; action: 'claimed' | 'returned' }
    | { ok: false; reason: 'expired' | 'already_claimed' | 'not_target' | 'sold_out' | 'not_pending' };

/**
 * 領取狀態機（不修改入參，返回新 meta）：
 * - lucky：群內任何人可搶（含發包人，微信同款），重複搶拒絕，領滿轉 done
 * - direct：僅 targetId 可收（action 'claim'）或退（action 'return'）
 * - pending 且過期 → 拒絕（返回 expired，由調用方決定是否落 expired 態）
 */
export function claimPacket(
    meta: GroupPacketMeta,
    claimantId: string,
    now: number,
    action: 'claim' | 'return' = 'claim',
    rand: () => number = Math.random,
): ClaimResult {
    if (meta.status !== 'pending') {
        return { ok: false, reason: meta.status === 'done' ? 'sold_out' : 'not_pending' };
    }
    if (now > meta.expiresAt) return { ok: false, reason: 'expired' };

    if (meta.packetType === 'direct') {
        if (meta.targetId !== claimantId) return { ok: false, reason: 'not_target' };
        if (action === 'return') {
            return { ok: true, action: 'returned', amount: meta.totalAmount, meta: { ...meta, status: 'returned', resolvedAt: now } };
        }
        const claim: PacketClaim = { claimantId, amount: meta.totalAmount, at: now };
        return { ok: true, action: 'claimed', amount: meta.totalAmount, meta: { ...meta, claims: [claim], status: 'done', resolvedAt: now } };
    }

    // lucky
    if (action === 'return') return { ok: false, reason: 'not_target' }; // 拼手氣不能退
    if (meta.claims.some(c => c.claimantId === claimantId)) return { ok: false, reason: 'already_claimed' };
    if (meta.claims.length >= meta.shares) return { ok: false, reason: 'sold_out' };

    const claimedSum = round2(meta.claims.reduce((s, c) => s + c.amount, 0));
    const remaining = round2(meta.totalAmount - claimedSum);
    const remainingShares = meta.shares - meta.claims.length;
    const amount = drawLuckyAmount(remaining, remainingShares, rand);
    const claims = [...meta.claims, { claimantId, amount, at: now }];
    const done = claims.length >= meta.shares;
    return {
        ok: true,
        action: 'claimed',
        amount,
        meta: { ...meta, claims, status: done ? 'done' : 'pending', ...(done ? { resolvedAt: now } : {}) },
    };
}

/** 渲染/領取時的懶過期判定 */
export function effectivePacketStatus(meta: GroupPacketMeta, now: number): PacketStatus {
    if (meta.status === 'pending' && now > meta.expiresAt) return 'expired';
    return meta.status;
}

// ─── 指令解析（兩層容錯：壞值靜默丟棄，絕不影響正文） ───

export interface PacketCommand {
    kind: 'grab' | 'return' | 'send';
    /** 僅 send */
    send?: { packetType: 'direct' | 'lucky'; totalAmount: number; shares: number; targetName?: string; note?: string };
}

/**
 * 解析 [[SEND_PACKET: ...]] 的載荷：
 *   lucky:總額:份數(:祝福語)  /  direct:目標名:金額(:祝福語)
 * 按全/半角冒號切前 3 段，其餘合併為祝福語（祝福語裡的冒號不炸）。
 * 金額非法 / 份數 < 1 / 目標名為空 → null。
 */
export function parseSendPacketPayload(payload: string): PacketCommand['send'] | null {
    const parts = String(payload ?? '').split(/[:：]/);
    if (parts.length < 3) return null;
    const kind = parts[0].trim().toLowerCase();
    if (kind === 'lucky') {
        const totalAmount = parseFloat(parts[1]);
        const shares = parseInt(parts[2], 10);
        if (!Number.isFinite(totalAmount) || totalAmount <= 0) return null;
        if (!Number.isFinite(shares) || shares < 1) return null;
        const note = parts.slice(3).join(':').trim() || undefined;
        return { packetType: 'lucky', totalAmount: round2(totalAmount), shares: Math.floor(shares), note };
    }
    if (kind === 'direct') {
        const targetName = parts[1].trim();
        const totalAmount = parseFloat(parts[2]);
        if (!targetName) return null;
        if (!Number.isFinite(totalAmount) || totalAmount <= 0) return null;
        const note = parts.slice(3).join(':').trim() || undefined;
        return { packetType: 'direct', totalAmount: round2(totalAmount), shares: 1, targetName, note };
    }
    return null;
}

/**
 * 從角色輸出裡摳紅包命令，返回剝淨後的正文 + 命令列表。
 * 無法解析的 SEND_PACKET 也會被剝掉（保正文），只是不產生命令。
 */
export function extractPacketCommands(content: string): { text: string; commands: PacketCommand[] } {
    const commands: PacketCommand[] = [];
    let text = String(content ?? '');

    text = text.replace(/\[\[\s*GRAB_PACKET\s*\]\]/gi, () => { commands.push({ kind: 'grab' }); return ''; });
    text = text.replace(/\[\[\s*RETURN_PACKET\s*\]\]/gi, () => { commands.push({ kind: 'return' }); return ''; });
    text = text.replace(/\[\[\s*SEND_PACKET\s*[:：]\s*([\s\S]*?)\]\]/gi, (_m, payload) => {
        const send = parseSendPacketPayload(payload);
        if (send) commands.push({ kind: 'send', send });
        return '';
    });

    return { text: text.trim(), commands };
}

// ─── prompt 序列化 ───

const fmtAmount = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * 群歷史裡一條 transfer 消息的文本行（不含 `名字: ` 前綴，調用方拼）。
 * 舊數據（無 packet 判別）沿用 `[發紅包: X]`。
 */
export function packetHistoryLine(msg: Message, nameOf: (claimantId: string) => string, now: number): string {
    const meta = msg.metadata as Partial<GroupPacketMeta & PacketReceiptMeta> | undefined;
    if (meta?.packetReceipt) {
        return meta.packetReceipt === 'claimed'
            ? `[系統: ${meta.claimantName} 領取了 ${meta.senderName} 的紅包${meta.amount != null ? ` ${fmtAmount(meta.amount)}` : ''}]`
            : `[系統: ${meta.claimantName} 退回了 ${meta.senderName} 的專屬紅包]`;
    }
    if (!meta?.packet) return `[發紅包: ${meta?.amount ?? ''}]`;

    const m = meta as GroupPacketMeta;
    const status = effectivePacketStatus(m, now);
    if (m.packetType === 'direct') {
        const target = nameOf(m.targetId || '');
        const tail = status === 'done' ? `${target}已收下`
            : status === 'returned' ? `${target}已退回`
            : status === 'expired' ? '已過期'
            : `待${target}收下或退回`;
        return `[發了專屬紅包給 ${target}：金額${fmtAmount(m.totalAmount)}，「${m.note}」（${tail}）]`;
    }
    const claimed = m.claims.map(c => `${nameOf(c.claimantId)} 搶到${fmtAmount(c.amount)}`).join('、');
    const tail = status === 'done' ? '已被領完'
        : status === 'expired' ? '已過期'
        : `還剩${m.shares - m.claims.length}份可搶`;
    return `[發了拼手氣紅包：總額${fmtAmount(m.totalAmount)}，共${m.shares}份，「${m.note}」${m.claims.length > 0 ? `，已領${m.claims.length}份（${claimed}）` : ''}，${tail}]`;
}
