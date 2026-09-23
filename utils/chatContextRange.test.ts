import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message } from '../types';
import {
    computeContextRangeSnapshot,
    migrateCharacterContextRange,
} from './chatContextRange';

const makeMessages = (from: number, to: number): Message[] =>
    Array.from({ length: to - from + 1 }, (_, index) => {
        const id = from + index;
        return {
            id,
            charId: 'char-context',
            role: id % 2 ? 'user' : 'assistant',
            type: 'text',
            content: `message-${id}`,
            timestamp: id,
        } as Message;
    });

const makeChar = (partial: Partial<CharacterProfile>): CharacterProfile => ({
    id: 'char-context',
    name: 'Context',
    avatar: '',
    description: '',
    systemPrompt: '',
    memories: [],
    contextRangePolicyVersion: 1,
    ...partial,
});

describe('AI 原文範圍邊界', () => {
    it('自適應最大範圍從水位線之後開始', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1000),
            makeChar({ autoArchiveEnabled: true, contextRangeMode: 'adaptive', contextLimit: 5000 }),
            800,
        );

        expect(snapshot.maxRangeStartMessageId).toBe(801);
        expect(snapshot.effectiveStartMessageId).toBe(801);
        expect(snapshot.messages[0].id).toBe(801);
        expect(snapshot.messages.at(-1)?.id).toBe(1000);
    });

    it('一鍵入宮後即使沒開全自動，也會從水位線之後讀取且當前可為 0 條', () => {
        const messages = makeMessages(1, 1000);
        const snapshot = computeContextRangeSnapshot(
            messages,
            makeChar({
                memoryPalaceEnabled: true,
                autoArchiveEnabled: false,
                contextRangeMode: 'adaptive',
                contextFollowsMemoryPalaceHwm: true,
            }),
            1000,
        );

        expect(snapshot.mode).toBe('adaptive');
        expect(snapshot.maxRangeStartMessageId).toBeUndefined();
        expect(snapshot.messages).toHaveLength(0);
    });

    it('選擇保留最近 10 條時，水位線後的原文與橙色範圍精確為 10 條', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1000),
            makeChar({
                memoryPalaceEnabled: true,
                autoArchiveEnabled: false,
                contextRangeMode: 'adaptive',
                contextFollowsMemoryPalaceHwm: true,
            }),
            990,
        );

        expect(snapshot.maxRangeStartMessageId).toBe(991);
        expect(snapshot.messages).toHaveLength(10);
        expect(snapshot.messages[9].id).toBe(1000);
    });

    it('範圍內用戶斷點只能把起點向更新消息推進', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1000),
            makeChar({
                autoArchiveEnabled: true,
                contextRangeMode: 'adaptive',
                contextUserStartMessageId: 900,
            }),
            800,
        );

        expect(snapshot.maxRangeStartMessageId).toBe(801);
        expect(snapshot.userStartMessageId).toBe(900);
        expect(snapshot.effectiveStartMessageId).toBe(900);
        expect(snapshot.messages[0].id).toBe(900);
    });

    it('用戶斷點恰好位於最大範圍起點時有效且沒有越界', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1000),
            makeChar({
                autoArchiveEnabled: true,
                contextRangeMode: 'manual',
                contextLimit: 500,
                contextUserStartMessageId: 501,
            }),
            800,
        );

        expect(snapshot.userBreakpointExpired).toBe(false);
        expect(snapshot.effectiveStartMessageId).toBe(501);
        expect(snapshot.messages).toHaveLength(500);
    });

    it('水位線之前的用戶斷點不能突破自適應最大範圍', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1000),
            makeChar({
                autoArchiveEnabled: true,
                contextRangeMode: 'adaptive',
                contextUserStartMessageId: 700,
            }),
            800,
        );

        expect(snapshot.userBreakpointExpired).toBe(true);
        expect(snapshot.userStartMessageId).toBeUndefined();
        expect(snapshot.effectiveStartMessageId).toBe(801);
        expect(snapshot.messages[0].id).toBe(801);
    });

    it('手動拉桿忽略水位線並把最近 N 條作為最大範圍', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1000),
            makeChar({
                autoArchiveEnabled: true,
                contextRangeMode: 'manual',
                contextLimit: 500,
            }),
            800,
        );

        expect(snapshot.maxRangeStartMessageId).toBe(501);
        expect(snapshot.effectiveStartMessageId).toBe(501);
        expect(snapshot.messages).toHaveLength(500);
    });

    it('拉桿範圍外的舊斷點失效，絕不會擴大範圍', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1000),
            makeChar({
                autoArchiveEnabled: true,
                contextRangeMode: 'manual',
                contextLimit: 500,
                contextUserStartMessageId: 300,
            }),
            800,
        );

        expect(snapshot.userBreakpointExpired).toBe(true);
        expect(snapshot.effectiveStartMessageId).toBe(501);
        expect(snapshot.messages[0].id).toBe(501);
    });

    it('新消息把拉桿起點推過固定斷點後，固定斷點失效並跟隨拉桿', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1200),
            makeChar({
                autoArchiveEnabled: true,
                contextRangeMode: 'manual',
                contextLimit: 500,
                contextUserStartMessageId: 700,
            }),
            800,
        );

        expect(snapshot.maxRangeStartMessageId).toBe(701);
        expect(snapshot.userBreakpointExpired).toBe(true);
        expect(snapshot.effectiveStartMessageId).toBe(701);
    });

    it('作為斷點的消息被刪除後斷點失效，不能停在不存在的 ID 上', () => {
        const messages = makeMessages(1, 1000).filter(message => message.id !== 800);
        const snapshot = computeContextRangeSnapshot(
            messages,
            makeChar({
                autoArchiveEnabled: true,
                contextRangeMode: 'manual',
                contextLimit: 500,
                contextUserStartMessageId: 800,
            }),
            700,
        );

        expect(snapshot.userBreakpointExpired).toBe(true);
        expect(snapshot.userStartMessageId).toBeUndefined();
        expect(snapshot.messages[0].id).toBe(500);
    });
});

describe('舊角色上下文遷移', () => {
    it('全自動用戶即使原來拉滿 5000 條也回到自適應默認', () => {
        const result = migrateCharacterContextRange(makeChar({
            contextRangePolicyVersion: undefined,
            autoArchiveEnabled: true,
            contextLimit: 5000,
            hideBeforeMessageId: 600,
        }));

        expect(result.migrated).toBe(true);
        expect(result.resetAutoContext).toBe(true);
        expect(result.character.contextRangeMode).toBe('adaptive');
        expect(result.character.contextLimit).toBe(500);
        expect(result.character.contextUserStartMessageId).toBeUndefined();
    });

    it('未開全自動的舊用戶保留拉桿，並把舊用戶斷點遷入新字段', () => {
        const result = migrateCharacterContextRange(makeChar({
            contextRangePolicyVersion: undefined,
            autoArchiveEnabled: false,
            contextLimit: 300,
            hideBeforeMessageId: 250,
        }));

        expect(result.character.contextRangeMode).toBe('manual');
        expect(result.character.contextLimit).toBe(300);
        expect(result.character.contextUserStartMessageId).toBe(250);
    });

    it('新字段會隨角色設置 JSON 備份往返保留', () => {
        const original = makeChar({
            autoArchiveEnabled: true,
            contextRangeMode: 'manual',
            contextLimit: 1200,
            contextUserStartMessageId: 321,
            contextFollowsMemoryPalaceHwm: true,
        });
        const restored = JSON.parse(JSON.stringify(original)) as CharacterProfile;

        expect(restored.contextRangePolicyVersion).toBe(1);
        expect(restored.contextRangeMode).toBe('manual');
        expect(restored.contextLimit).toBe(1200);
        expect(restored.contextUserStartMessageId).toBe(321);
        expect(restored.contextFollowsMemoryPalaceHwm).toBe(true);
    });
});
