import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { flattenImageContentParts } from './chatRequestPayload';

// 鎖住「彼方/家園等獨立 API 場景把歷史圖片壓平成純文本」的修復。
//
// 鏈路: 用戶在聊天裡發過圖 → buildMessageHistory 把該條構造成
//   content: [{type:'text',...}, {type:'image_url',...}]
// → 彼方/家園複用同一份歷史發給自己配置的 API。目標模型若不支持視覺
// (DeepSeek 等), 對 image_url 直接 400: "unknown variant `image_url`,
// expected `text`"。修復後這兩條路徑經 flattenImageContentParts 壓平,
// 只保留 text 部分 (自帶 [User sent an image] 佔位), 與 buildMessageHistory
// 的"圖片數據已丟失"分支產出同形。

const char = { id: 'c1', name: '小角色' } as any;
const userProfile = { name: '我' } as any;

const t0 = Date.now() - 60_000;
const makeHistory = () => ([
    { id: 1, charId: 'c1', role: 'user', type: 'image', content: 'data:image/jpeg;base64,AAAA', timestamp: t0 },
    { id: 2, charId: 'c1', role: 'user', type: 'text', content: '看看這張圖', timestamp: t0 + 1000 },
] as any[]);

describe('flattenImageContentParts', () => {
    it('把 image_url 多模態消息壓平成純文本, 保留 text 佔位', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(makeHistory(), 10, char, userProfile, []);
        // 前置確認: 有圖片數據時 buildMessageHistory 確實產出數組 content (bug 的源頭)
        const imgMsg = apiMessages.find((m: any) => Array.isArray(m.content));
        expect(imgMsg).toBeTruthy();

        const flat = flattenImageContentParts(apiMessages);
        for (const m of flat) {
            expect(typeof m.content).toBe('string');
        }
        const flatImg = flat[apiMessages.indexOf(imgMsg!)];
        expect(flatImg.content).toContain('[User sent an image]');
        expect(flatImg.content).not.toContain('data:image');
    });

    it('純文本消息原樣返回 (引用同一對象, 不誤傷)', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(makeHistory(), 10, char, userProfile, []);
        const flat = flattenImageContentParts(apiMessages);
        const textIdx = apiMessages.findIndex((m: any) => typeof m.content === 'string');
        expect(flat[textIdx]).toBe(apiMessages[textIdx]);
        expect(flat[textIdx].content).toContain('看看這張圖');
    });

    it('沒有 text 部分的數組 content 兜底為 [圖片]', () => {
        const flat = flattenImageContentParts([
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }] },
        ]);
        expect(flat[0].content).toBe('[圖片]');
    });
});
