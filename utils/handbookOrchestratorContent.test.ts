import { describe, it, expect, vi, afterEach } from 'vitest';
import { todayChatLines } from './handbookOrchestrator';
import { DB } from './db';
import { getLocalDateKey, getLocalDayRange } from './localDate';

// 手帳 v2 拼「今天聊了什麼」時，每條消息都會被塞進給模型的提示詞。
//
// 這裡歷來是 `content.slice(0, 200)` 的裸截斷。圖片改存 `blobref:<id>` 令牌（~28 字）之後
// 這道截斷就攔不住了：整個令牌能完好通過 200 字，卡片 JSON 裡的 charAvatar 也就排在開頭
// 幾十字的位置。到網絡出口（utils/apiBlobRefs.ts）令牌會被還原成整張 base64，
// 於是每輪請求都白發一張頭像。
//
// 正確姿勢是先過 normalizeMessageContent：卡片壓成一行摘要，圖片/表情換成佔位符。

const CHAR = { id: 'c1', name: '小角色' } as any;
const USER = '小明';

const DATE = getLocalDateKey(new Date());
const { start } = getLocalDayRange(DATE)!;

const BLOB_TOKEN = 'blobref:b_0123456789abcdef';

/** 交換日記卡：content 是整段 JSON，charAvatar 排在最前面幾十字裡。 */
const DIARY_CARD_JSON = JSON.stringify({
    type: 'diary_card',
    charAvatar: BLOB_TOKEN,
    date: DATE,
    userName: USER,
    userText: '今天去看了海',
    charText: '下次一起去',
});

const MESSAGES = [
    { id: 1, charId: 'c1', role: 'user', type: 'text', content: '今天去看海啦', timestamp: start + 1_000 },
    { id: 2, charId: 'c1', role: 'assistant', type: 'score_card', content: DIARY_CARD_JSON, timestamp: start + 2_000 },
    { id: 3, charId: 'c1', role: 'user', type: 'image', content: BLOB_TOKEN, timestamp: start + 3_000 },
    { id: 4, charId: 'c1', role: 'user', type: 'emoji', content: BLOB_TOKEN, timestamp: start + 4_000 },
];

afterEach(() => vi.restoreAllMocks());

const collect = async (): Promise<string> => {
    vi.spyOn(DB, 'getMessagesByCharId').mockResolvedValue(MESSAGES as any);
    const { lines } = await todayChatLines(CHAR, DATE, USER);
    return lines.join('\n');
};

describe('手帳 v2「今天聊了什麼」不洩漏圖片值', () => {
    it('整段文本里出現不了 blobref 令牌', async () => {
        const text = await collect();
        expect(text).not.toContain('blobref:');
    });

    it('圖片 / 表情消息壓成佔位符', async () => {
        const text = await collect();
        expect(text).toContain(`${USER}: [圖片]`);
        expect(text).toContain(`${USER}: [表情包]`);
    });

    it('卡片翻成一行摘要，而不是 dump 原始 JSON', async () => {
        const text = await collect();
        expect(text).toContain('[交換日記');
        expect(text).toContain('今天去看了海');
        expect(text).not.toContain('"charAvatar"');
    });

    it('普通文字消息原樣保留', async () => {
        const text = await collect();
        expect(text).toContain(`${USER}: 今天去看海啦`);
    });
});
