import { describe, expect, it } from 'vitest';

import type { Anticipation, MemoryNode } from './types';
import { MemoryNodeDB } from './db';
import { expandAndFormat } from './formatter';

// 便利貼不佔召回名額、每輪全量注入，置頂最長 30 天；窗台期盼裡的 anchor 更是長期掛著。
// 兩處以前都是裸注入——只把事情擺出來，沒說該怎麼對待它。結果就是角色一旦記下一件事，
// 之後每段結尾都在追問進展、催對方快去辦。
//
// 同倉庫裡 Notion 筆記塊（chatPrompts 的「不要每次都提」）和用藥提醒（lifeRecords 的
// 「別反覆催」）早就配了同類措辭，這兩處補齊後別再退回去。

const charId = 'char-pinned-restraint';

const pinnedNode = (id: string, content: string): MemoryNode => ({
    id,
    charId,
    content,
    room: 'user_room',
    tags: [],
    importance: 6,
    mood: 'neutral',
    embedded: true,
    createdAt: Date.now() - 24 * 60 * 60 * 1000,
    lastAccessedAt: Date.now(),
    accessCount: 0,
    eventBoxId: null,
    pinnedUntil: Date.now() + 3 * 24 * 60 * 60 * 1000,
});

const anticipation = (id: string, content: string, status: Anticipation['status']): Anticipation => ({
    id,
    charId,
    content,
    status,
    createdAt: Date.now() - 24 * 60 * 60 * 1000,
} as Anticipation);

describe('便利貼與窗台期盼的分寸措辭', () => {
    it('便利貼擺出來的同時說清「記著不等於要一直說」', async () => {
        await MemoryNodeDB.save(pinnedNode('pin-1', '小明後天要考試'));
        const out = await expandAndFormat([], charId, [], '小明');

        expect(out).toContain('便利貼（近期重要事項）');
        expect(out).toContain('小明後天要考試');
        // 對症的三件事：別每輪都說、別追問進展、別替對方安排時間
        expect(out).toContain('記著不等於要一直說');
        expect(out).toContain('不必每次聊天都追問進展');
        expect(out).toContain('不必替 ta 安排什麼時候去做');
    });

    it('窗台期盼同樣帶分寸，別被當成待辦清單', async () => {
        const out = await expandAndFormat(
            [], charId, [anticipation('ant-1', '想一起去看海', 'active')], '小明',
        );

        expect(out).toContain('窗台期盼');
        expect(out).toContain('想一起去看海');
        expect(out).toContain('不是待辦清單');
        expect(out).toContain('不必每次都提起來');
    });

    it('沒有便利貼也沒有期盼時，這兩句都不該憑空出現', async () => {
        const out = await expandAndFormat([], 'char-empty-restraint', [], '小明');
        expect(out).toBe('');
    });
});
