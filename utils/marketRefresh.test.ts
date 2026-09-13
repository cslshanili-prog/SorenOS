import { beforeEach, describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import { rollMarketVisitor } from './vrWorld/marketRefresh';
import { createFishingMarketState, createRequest, refreshMarketNPCs } from './vrWorld/fishingMarket';

const roster = [
    { id: 'off', vrState: { enabled: false } },
    { id: 'manual', vrState: { enabled: true, activityMode: 'manual' } },
    { id: 'roaming', vrState: { enabled: true, activityMode: 'scheduled' } },
] as CharacterProfile[];
beforeEach(() => localStorage.clear());
describe('布告板手动刷新', () => {
    it('随机来访沿用彼方自由活动设置，无合适角色就抽 NPC', () => {
        expect(rollMarketVisitor(roster, () => .99)?.id).toBe('roaming');
        expect(rollMarketVisitor(roster.slice(0, 2), () => .99)).toBeNull();
        expect(rollMarketVisitor(roster, () => .1)).toBeNull();
        expect(rollMarketVisitor([], () => .99)).toBeNull();
    });
    it('一批来访两三位不同 NPC，保留原便笺、留言和钱包，不受旧半小时限制', () => {
        const at = Date.now(), original = { ...createFishingMarketState(42), accounts: { user: 20, 'wanderer:0': 0 }, lastPulseAt: at };
        const input = createRequest(original, { id: 'user', name: '我', kind: 'user' }, undefined, '随便聊聊', 0, '原便笺', at, 'favor');
        const frozen = structuredClone(input);
        const { state, visitors } = refreshMarketNPCs(input, at + 1, () => .1);
        expect(visitors).toHaveLength(2); expect(new Set(visitors.map(v => v.id)).size).toBe(2);
        expect(visitors.every(v => v.kind === 'wanderer')).toBe(true);
        expect(state.accounts.user).toBe(20); expect(state.accounts['wanderer:0']).toBe(0);
        expect(state.requests[0].id).toBe(input.requests[0].id);
        expect(state.requests[0].body).toBe('原便笺');
        expect(state.requests[0].comments).toHaveLength(2);
        expect(input).toEqual(frozen);
        const again = refreshMarketNPCs(state, at + 2, () => .9);
        expect(again.visitors).toHaveLength(3);
        expect(again.state.requests[0].comments.slice(0, 2)).toEqual(state.requests[0].comments);
    });
});
