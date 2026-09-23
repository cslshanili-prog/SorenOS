import { describe, it, expect } from 'vitest';
import {
    makePacketMeta,
    drawLuckyAmount,
    claimPacket,
    effectivePacketStatus,
    parseSendPacketPayload,
    extractPacketCommands,
    packetHistoryLine,
    GroupPacketMeta,
    PACKET_EXPIRY_MS,
} from './redpacket';
import { Message } from '../../types';

const NOW = 1_700_000_000_000;

const lucky = (over?: Partial<GroupPacketMeta>): GroupPacketMeta => ({
    ...makePacketMeta({ packetType: 'lucky', totalAmount: 88, shares: 3, now: NOW }),
    ...over,
});

const direct = (over?: Partial<GroupPacketMeta>): GroupPacketMeta => ({
    ...makePacketMeta({ packetType: 'direct', totalAmount: 52, targetId: 'c1', note: '請你喝奶茶', now: NOW }),
    ...over,
});

describe('drawLuckyAmount 二倍均值', () => {
    it('注入 rand 後總和守恆且每份 ≥ 0.01', () => {
        const seq = [0.99, 0.01, 0.5];
        let i = 0;
        const rand = () => seq[i++ % seq.length];
        let remaining = 88, shares = 3;
        const amounts: number[] = [];
        while (shares > 0) {
            const a = drawLuckyAmount(remaining, shares, rand);
            amounts.push(a);
            remaining = Math.round((remaining - a) * 100) / 100;
            shares--;
        }
        expect(amounts.every(a => a >= 0.01)).toBe(true);
        expect(amounts.reduce((s, a) => Math.round((s + a) * 100) / 100, 0)).toBe(88);
    });

    it('單份時直接拿全部餘額', () => {
        expect(drawLuckyAmount(13.37, 1)).toBe(13.37);
    });

    it('極端邊界：份數 = 金額 × 100（每份只能 0.01）', () => {
        let remaining = 0.03, shares = 3;
        const amounts: number[] = [];
        while (shares > 0) {
            const a = drawLuckyAmount(remaining, shares, () => 0.999);
            amounts.push(a);
            remaining = Math.round((remaining - a) * 100) / 100;
            shares--;
        }
        expect(amounts).toEqual([0.01, 0.01, 0.01]);
    });
});

describe('claimPacket 狀態機', () => {
    it('lucky：正常搶，最後一份領完轉 done 且總和守恆', () => {
        let meta = lucky();
        const got: number[] = [];
        for (const who of ['c1', 'c2', 'user']) {
            const r = claimPacket(meta, who, NOW + 1000);
            expect(r.ok).toBe(true);
            if (r.ok) { meta = r.meta; got.push(r.amount); }
        }
        expect(meta.status).toBe('done');
        expect(got.reduce((s, a) => Math.round((s + a) * 100) / 100, 0)).toBe(88);
    });

    it('lucky：重複搶被拒', () => {
        let meta = lucky();
        const r1 = claimPacket(meta, 'c1', NOW + 1);
        meta = (r1 as any).meta;
        const r2 = claimPacket(meta, 'c1', NOW + 2);
        expect(r2).toEqual({ ok: false, reason: 'already_claimed' });
    });

    it('lucky：領完後再搶被拒 sold_out', () => {
        let meta = lucky({ shares: 1 });
        meta = (claimPacket(meta, 'c1', NOW + 1) as any).meta;
        expect(claimPacket(meta, 'c2', NOW + 2)).toEqual({ ok: false, reason: 'sold_out' });
    });

    it('lucky：發包人自己也能搶（微信同款）', () => {
        // 發包人不在 claims 裡有特殊限制——claimantId 任意
        const r = claimPacket(lucky(), 'sender-id', NOW + 1);
        expect(r.ok).toBe(true);
    });

    it('lucky：不能退回', () => {
        expect(claimPacket(lucky(), 'c1', NOW + 1, 'return')).toEqual({ ok: false, reason: 'not_target' });
    });

    it('過期後拒絕領取', () => {
        const r = claimPacket(lucky(), 'c1', NOW + PACKET_EXPIRY_MS + 1);
        expect(r).toEqual({ ok: false, reason: 'expired' });
        expect(effectivePacketStatus(lucky(), NOW + PACKET_EXPIRY_MS + 1)).toBe('expired');
    });

    it('direct：僅目標能收，非目標被拒', () => {
        expect(claimPacket(direct(), 'c2', NOW + 1)).toEqual({ ok: false, reason: 'not_target' });
        const r = claimPacket(direct(), 'c1', NOW + 1);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.amount).toBe(52);
            expect(r.meta.status).toBe('done');
            expect(r.meta.claims).toHaveLength(1);
        }
    });

    it('direct：目標可退回', () => {
        const r = claimPacket(direct(), 'c1', NOW + 1, 'return');
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.action).toBe('returned');
            expect(r.meta.status).toBe('returned');
        }
    });

    it('已 resolved 的包再操作被拒', () => {
        const done = (claimPacket(direct(), 'c1', NOW + 1) as any).meta;
        expect(claimPacket(done, 'c1', NOW + 2).ok).toBe(false);
    });
});

describe('parseSendPacketPayload', () => {
    it('lucky 半角冒號', () => {
        expect(parseSendPacketPayload('lucky:88:5:恭喜發財')).toEqual({ packetType: 'lucky', totalAmount: 88, shares: 5, note: '恭喜發財' });
    });

    it('direct 全角冒號 + 祝福語含冒號', () => {
        expect(parseSendPacketPayload('direct：小蝶：52：注意：請你喝奶茶')).toEqual({ packetType: 'direct', totalAmount: 52, shares: 1, targetName: '小蝶', note: '注意:請你喝奶茶' });
    });

    it('無祝福語', () => {
        expect(parseSendPacketPayload('lucky:10:2')).toEqual({ packetType: 'lucky', totalAmount: 10, shares: 2, note: undefined });
    });

    it('壞金額/壞份數/未知類型 → null', () => {
        expect(parseSendPacketPayload('lucky:abc:5')).toBeNull();
        expect(parseSendPacketPayload('lucky:88:0')).toBeNull();
        expect(parseSendPacketPayload('direct::52')).toBeNull();
        expect(parseSendPacketPayload('foo:88:5')).toBeNull();
        expect(parseSendPacketPayload('lucky:88')).toBeNull();
    });
});

describe('extractPacketCommands', () => {
    it('剝淨命令保正文', () => {
        const { text, commands } = extractPacketCommands('哈哈我來了\n[[GRAB_PACKET]]\n手氣怎麼樣');
        expect(text).toBe('哈哈我來了\n\n手氣怎麼樣');
        expect(commands).toEqual([{ kind: 'grab' }]);
    });

    it('SEND_PACKET 載荷壞值也剝標記（不產生命令、正文保留）', () => {
        const { text, commands } = extractPacketCommands('給大家發個紅包 [[SEND_PACKET: lucky:abc:xyz]]');
        expect(text).toBe('給大家發個紅包');
        expect(commands).toEqual([]);
    });

    it('多命令混合', () => {
        const { commands } = extractPacketCommands('[[RETURN_PACKET]] 不好意思心領了 [[SEND_PACKET: lucky:20:3:回禮]]');
        expect(commands).toHaveLength(2);
        expect(commands[0]).toEqual({ kind: 'return' });
        expect(commands[1].kind).toBe('send');
    });
});

describe('packetHistoryLine', () => {
    const nameOf = (id: string) => (id === 'user' ? '用戶' : id === 'c1' ? '小夏' : '成員');
    const msg = (metadata: any): Message => ({ id: 9, charId: 'c1', role: 'assistant', type: 'transfer', content: '[紅包]', timestamp: NOW, metadata } as Message);

    it('舊數據沿用 [發紅包: X]', () => {
        expect(packetHistoryLine(msg({ amount: '88' }), nameOf, NOW)).toBe('[發紅包: 88]');
    });

    it('lucky 未領完 / 領完 / 過期', () => {
        let meta = lucky();
        expect(packetHistoryLine(msg(meta), nameOf, NOW)).toContain('還剩3份可搶');
        meta = (claimPacket(meta, 'c1', NOW + 1, 'claim', () => 0.5) as any).meta;
        const line = packetHistoryLine(msg(meta), nameOf, NOW + 2);
        expect(line).toContain('已領1份');
        expect(line).toContain('小夏 搶到');
        expect(packetHistoryLine(msg(lucky()), nameOf, NOW + PACKET_EXPIRY_MS + 1)).toContain('已過期');
    });

    it('direct 待收/已收/已退', () => {
        expect(packetHistoryLine(msg(direct()), nameOf, NOW)).toContain('待小夏收下或退回');
        const done = (claimPacket(direct(), 'c1', NOW + 1) as any).meta;
        expect(packetHistoryLine(msg(done), nameOf, NOW + 2)).toContain('小夏已收下');
        const ret = (claimPacket(direct(), 'c1', NOW + 1, 'return') as any).meta;
        expect(packetHistoryLine(msg(ret), nameOf, NOW + 2)).toContain('小夏已退回');
    });

    it('回執行', () => {
        expect(packetHistoryLine(msg({ packetReceipt: 'claimed', ref: 1, amount: 30.1, claimantName: '小夏', senderName: '用戶' }), nameOf, NOW))
            .toBe('[系統: 小夏 領取了 用戶 的紅包 30.10]');
        expect(packetHistoryLine(msg({ packetReceipt: 'returned', ref: 1, claimantName: '小夏', senderName: '用戶' }), nameOf, NOW))
            .toBe('[系統: 小夏 退回了 用戶 的專屬紅包]');
    });
});
