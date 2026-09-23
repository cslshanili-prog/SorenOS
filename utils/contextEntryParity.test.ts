import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, UserProfile } from '../types';
import { DB } from './db';
import { loadCharacterContextMessages, loadCharacterContextRange } from './chatContextRange';
import { buildChatRequestPayload } from './chatRequestPayload';
import { DatePrompts } from './datePrompts';
import * as palace from './memoryPalace/pipeline';

const userProfile = { name: '用戶' } as UserProfile;
const markerNumbers = (messages: unknown): number[] => [...JSON.stringify(messages).matchAll(/原文[标標][记記](\d+)[结結]束/g)].map(match => Number(match[1]));

describe('以 ChatApp 實際發送鏈路為基準核對上下文', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => vi.restoreAllMocks());

    it.each([
        { name: '自適應忽略殘留的手動 10 條，允許超過 200 條', mode: 'adaptive', hwm: 20, limit: 10, from: 21 },
        { name: '手動 200 條跨過水位線，不只剩未總結的 26 條', mode: 'manual', hwm: 215, limit: 200, from: 42 },
        { name: '手動 10 條確實只發最近 10 條', mode: 'manual', hwm: 20, limit: 10, from: 232 },
        { name: '自適應範圍內的用戶斷點繼續收窄', mode: 'adaptive', hwm: 20, limit: 10, breakpoint: 232, from: 232 },
        { name: '手動範圍內的用戶斷點繼續收窄', mode: 'manual', hwm: 215, limit: 200, breakpoint: 232, from: 232 },
        { name: '自適應範圍外的舊斷點失效', mode: 'adaptive', hwm: 20, limit: 10, breakpoint: 19, from: 21 },
        { name: '手動範圍外的舊斷點失效', mode: 'manual', hwm: 215, limit: 200, breakpoint: 20, from: 42 },
        { name: '關閉全自動後的一鍵入宮水位跟隨', mode: 'adaptive', hwm: 240, limit: 200, oneShot: true, from: 241 },
        { name: '沒有水位跟隨來源的殘留 adaptive 字段按手動處理', mode: 'adaptive', hwm: 20, limit: 10, orphan: true, from: 232 },
    ] as const)('$name', async scenario => {
        const charId = `parity-${scenario.name}`;
        const ids: number[] = [];
        for (let n = 1; n <= 241; n++) {
            ids.push(await DB.saveMessage({
                charId, role: n % 2 ? 'user' : 'assistant', type: 'text',
                content: `原文標記${n}結束`, timestamp: 1700000000000 + n,
                metadata: { source: n <= 20 ? 'chat' : n <= 200 ? 'date' : 'call' },
            }));
            if (n === 220) await DB.saveMessage({ charId, groupId: 'other-group', role: 'user', type: 'text', content: '群聊獨立記錄' });
        }
        const char: CharacterProfile = {
            id: charId, name: '角色', avatar: '', description: '', systemPrompt: '', memories: [],
            contextRangePolicyVersion: 1, contextRangeMode: scenario.mode, contextLimit: scenario.limit,
            autoArchiveEnabled: !('oneShot' in scenario || 'orphan' in scenario),
            contextFollowsMemoryPalaceHwm: 'oneShot' in scenario,
            contextUserStartMessageId: scenario.breakpoint !== undefined ? ids[scenario.breakpoint - 1] : undefined,
        };
        await DB.saveCharacter(char);
        localStorage.setItem(`mp_lastMsgId_${charId}`, String(ids[scenario.hwm - 1]));

        // 復現 useChatAI 的數據庫讀取和實際 payload 構建；舊 UI 緩存仍包含範圍外消息。
        const chatRange = await loadCharacterContextRange(char);
        const allRows = await DB.getMessagesByCharId(charId, true);
        const expected = Array.from({ length: 242 - scenario.from }, (_, index) => index + scenario.from);
        const recall = vi.spyOn(palace, 'injectMemoryPalace');
        const chat = await buildChatRequestPayload({
            char, userProfile, groups: [], emojis: [], categories: [],
            historyMsgs: chatRange.messages, recentMsgsHint: allRows,
            contextLimit: Math.max(1, chatRange.messages.length),
            realtimeConfig: { weatherEnabled: false, newsEnabled: false } as any,
        });
        expect(markerNumbers(chat.cleanedApiMessages)).toEqual(expected);
        expect(markerNumbers(recall.mock.calls[0][1])).toEqual(expected);

        const dateRows = await loadCharacterContextMessages(charId);
        expect(dateRows.map(message => message.id)).toEqual(chatRange.messages.map(message => message.id));
        for (const variant of ['send', 'reroll'] as const) {
            const date = await DatePrompts.buildSessionPayload({
                char, userProfile, allMsgs: dateRows, emojis: [],
                userText: dateRows.at(-1)!.content, variant,
            });
            expect(markerNumbers(date.messages)).toEqual(expected);
        }
        expect(markerNumbers(DatePrompts.buildPeekPayload({ char, userProfile, allMsgs: dateRows, emojis: [] }).messages)).toEqual(expected);
    });

    it('一鍵入宮後暫無新原文時，舊 UI 緩存不進入召回和世界書掃描', async () => {
        const char = {
            id: 'parity-empty', name: '角色', contextRangePolicyVersion: 1,
            contextRangeMode: 'adaptive', contextFollowsMemoryPalaceHwm: true,
            mountedWorldbooks: [{ id: 'hidden-keyword', title: '關鍵詞條目', category: '測試', constant: false, key: ['原文標記1結束'], content: '被隱藏消息觸發的世界書正文' }],
        } as CharacterProfile;
        const id = await DB.saveMessage({ charId: char.id, role: 'user', type: 'text', content: '原文標記1結束' });
        localStorage.setItem(`mp_lastMsgId_${char.id}`, String(id));
        const rows = await loadCharacterContextMessages(char);
        const recall = vi.spyOn(palace, 'injectMemoryPalace');
        const chat = await buildChatRequestPayload({
            char, userProfile, groups: [], emojis: [], categories: [], historyMsgs: rows,
            recentMsgsHint: await DB.getMessagesByCharId(char.id, true), contextLimit: 1,
            realtimeConfig: { weatherEnabled: false, newsEnabled: false } as any,
        });
        expect(chat.cleanedApiMessages).toEqual([]);
        expect(recall.mock.calls[0][1]).toEqual([]);
        expect(JSON.stringify(chat.fullMessages)).not.toContain('被隱藏消息觸發的世界書正文');
        expect(markerNumbers(DatePrompts.buildPeekPayload({ char, userProfile, allMsgs: rows, emojis: [] }).messages)).toEqual([]);
        const manual = await buildChatRequestPayload({
            char: { ...char, contextRangeMode: 'manual', contextLimit: 10 },
            userProfile, groups: [], emojis: [], categories: [],
            historyMsgs: await DB.getMessagesByCharId(char.id, true), contextLimit: 10,
            realtimeConfig: { weatherEnabled: false, newsEnabled: false } as any,
        });
        expect(JSON.stringify(manual.fullMessages)).toContain('被隱藏消息觸發的世界書正文');
    });
});
