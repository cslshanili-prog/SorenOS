import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../../types';
import { safeFetchJson } from '../safeApi';
import { extractMemoriesFromBuffer } from './extraction';

vi.mock('../safeApi', () => ({
    safeFetchJson: vi.fn(),
}));

const mockedSafeFetchJson = vi.mocked(safeFetchJson);
const messages: Message[] = [{
    id: 1,
    charId: 'char-extraction-flags',
    role: 'user',
    type: 'text',
    content: '今天我和霧嵐去了上海。',
    timestamp: new Date('2026-08-17T12:00:00+08:00').getTime(),
}];
const llmConfig = {
    baseUrl: 'https://memory.example/v1',
    apiKey: 'test-key',
    model: 'memory-model',
};

function extractionReply() {
    return {
        choices: [{
            message: {
                content: JSON.stringify([{
                    content: '用戶今天和霧嵐去了上海。',
                    room: 'user_room',
                    importance: 5,
                    mood: 'neutral',
                    tags: ['霧嵐', '上海'],
                    entities: [
                        { name: '霧嵐', type: 'person' },
                        { name: '上海', type: 'place' },
                    ],
                    date: '2026-08-17',
                }]),
            },
        }],
    };
}

function capturedSystemPrompt(): string {
    const options = mockedSafeFetchJson.mock.calls.at(-1)?.[1] as RequestInit;
    const body = JSON.parse(String(options.body));
    return body.messages[0].content;
}

describe('memory extraction smart-context compatibility gate', () => {
    beforeEach(() => {
        localStorage.clear();
        mockedSafeFetchJson.mockReset();
        mockedSafeFetchJson.mockResolvedValue(extractionReply() as any);
    });

    it('keeps the master prompt and memory shape when smart context is off', async () => {
        const result = await extractMemoriesFromBuffer(
            messages, 'char-extraction-flags', '測試角色', llmConfig, undefined, '用戶',
        );
        const prompt = capturedSystemPrompt();

        expect(prompt).toContain('6. **標籤**（tags）：提取 2-5 個關鍵詞標籤\n7. **不要遺漏重要記憶');
        expect(prompt).toContain('"tags": ["標籤1", "標籤2"],\n    "date": "YYYY-MM-DD"');
        expect(prompt).not.toContain('明確實體');
        expect(prompt).not.toContain('"entities"');
        expect(Object.prototype.hasOwnProperty.call(result.memories[0], 'entities')).toBe(false);
    });

    it('adds and stores entities only after recallRouter is enabled', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { recallRouter: true },
        }));

        const result = await extractMemoriesFromBuffer(
            messages, 'char-extraction-flags', '測試角色', llmConfig, undefined, '用戶',
        );
        const prompt = capturedSystemPrompt();

        expect(prompt).toContain('明確實體');
        expect(prompt).toContain('"entities"');
        expect(result.memories[0].entities).toEqual([
            { name: '霧嵐', type: 'person' },
            { name: '上海', type: 'place' },
        ]);
    });
});
