import { describe, expect, it } from 'vitest';
import type { StoryTheaterEntry, StoryTheaterMask, StoryTheaterPreset } from '../types';
import { DB } from './db';

describe('劇情劇場數據與糯米機原生預設備份', () => {
    it('完整備份 round-trip 後條目與自定義預設仍存在', async () => {
        const entry: StoryTheaterEntry = {
            id: 'story-backup-entry',
            title: '雨夜車站',
            premise: '三個人錯過末班車。',
            openingMode: 'assistant',
            mask: { type: 'custom', id: 'story-mask' },
            characterIds: ['char-a', 'char-b'],
            writesToCharacterMemory: false,
            characterMemoryDates: {},
            carryCharacterMemory: true,
            characterContextLimits: { 'char-a': 100, 'char-b': 80 },
            archiveAfter: 30,
            archiveKeepRecent: 5,
            archiveStrategy: 'summary',
            archives: [{
                id: 'archive-1',
                strategy: 'summary',
                fromMessageId: 1,
                toMessageId: 2,
                messageCount: 2,
                summary: 'Archived scene summary',
                createdAt: 15,
            }],
            selectedWorldbookIds: ['book-a'],
            presetId: 'story-backup-preset',
            createdAt: 10,
            updatedAt: 20,
        };
        const preset: StoryTheaterPreset = {
            id: 'story-backup-preset',
            name: '備份測試',
            format: 'sullyos-story-preset',
            createdAt: 10,
            updatedAt: 20,
            document: {
                schema: 'sullyos.story-preset',
                version: 1,
                name: '備份測試',
                generation: { temperature: 0.8, topP: 1, frequencyPenalty: 0, presencePenalty: 0, maxTokens: 2048 },
                prompts: [{ id: 'p1', name: '規則', enabled: true, role: 'system', content: '只寫故事正文。' }],
            },
        };
        const mask: StoryTheaterMask = { id: 'story-mask', name: '夜航員', description: '來自另一條時間線', coreInstruction: '謹慎行動', worldview: '雨城', createdAt: 10, updatedAt: 20 };

        await DB.saveStoryTheater(entry);
        await DB.saveStoryTheaterPreset(preset);
        await DB.saveStoryTheaterMask(mask);
        const messageId = await DB.saveMessage({
            charId: `story-theater:${entry.id}`,
            role: 'assistant',
            type: 'text',
            content: 'The restored story floor',
            timestamp: 30,
            metadata: {
                source: 'story_theater',
                theaterId: entry.id,
                theaterAffinityInputs: [{ charId: 'char-a', delta: 2, reason: 'noticed change', awareness: 'noticed' }],
            },
        });
        const exported = JSON.parse(JSON.stringify(await DB.exportFullData()));
        expect(exported.storyTheaters).toContainEqual(entry);
        expect(exported.storyTheaterPresets).toContainEqual(preset);
        expect(exported.storyTheaterMasks).toContainEqual(mask);
        expect(exported.messages).toContainEqual(expect.objectContaining({ id: messageId, charId: `story-theater:${entry.id}`, content: 'The restored story floor' }));

        await DB.deleteStoryTheater(entry.id);
        await DB.deleteStoryTheaterPreset(preset.id);
        await DB.deleteStoryTheaterMask(mask.id);
        await DB.deleteMessages([messageId]);
        await DB.importFullData(exported as any);

        expect(await DB.getStoryTheaters()).toContainEqual(entry);
        expect(await DB.getStoryTheaterPresets()).toContainEqual(preset);
        expect(await DB.getStoryTheaterMasks()).toContainEqual(mask);
        const restoredMessages = await DB.getMessagesByCharId(`story-theater:${entry.id}`, true);
        const restoredFloor = restoredMessages.find(message => message.id === messageId);
        expect(restoredFloor?.metadata?.theaterAffinityInputs).toEqual([{ charId: 'char-a', delta: 2, reason: 'noticed change', awareness: 'noticed' }]);
    });
});
