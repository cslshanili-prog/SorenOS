import { describe, expect, it, vi, afterEach } from 'vitest';
import { ChatParser } from './chatParser';
import { DB } from './db';

/**
 * 主動消息 2.0 的送達端重放：一條推送到點才在本地跑副作用，跟「角色寫這句話」隔著幾小時。
 * 這份測試盯住三件在那個時間差裡會出錯的事：
 *  1. 副作用產物要帶上這條推送的標記（認不出來 = 處理失敗重來時整套副作用再跑一遍）；
 *  2. 角色說「這筆我收下了」，收的必須是它寫這句話時看得到的那筆；
 *  3. 熱點卡的鏈接寧可不掛，也別按相似標題猜錯一條。
 */

const noop = () => {};

afterEach(() => { vi.restoreAllMocks(); });

const inheritMeta = {
    source: 'active_msg_2',
    activeMsg2: { messageId: 'push-abc', taskId: 'task-1' },
};

describe('parseAndExecuteActions 的副作用產物繼承推送標記', () => {
    it('戳一戳 / 轉帳卡 / 日程系統提示都帶上 activeMsg2.messageId', async () => {
        const charId = `c-inherit-${Date.now()}`;

        await ChatParser.parseAndExecuteActions(
            '給你\n[[ACTION:POKE]]\n[[ACTION:TRANSFER:520]]\n[[ACTION:ADD_EVENT | 面試 | 2099-08-03]]',
            charId, '阿一', noop, undefined, undefined, undefined, inheritMeta,
        );

        const msgs = await DB.getMessagesByCharId(charId, true);
        expect(msgs.length).toBe(3);
        for (const m of msgs) {
            // 修復前: 副作用產物一個標記都不帶 → 重試時被當成"上次什麼都沒做", 轉帳再跑一遍
            expect(m.metadata?.activeMsg2?.messageId).toBe('push-abc');
            expect(m.metadata?.source).toBe('active_msg_2');
        }
        // 卡片自己的字段不能被繼承的元數據擠掉
        const transfer = msgs.find(m => m.type === 'transfer');
        expect(transfer?.metadata?.amount).toBe('520');
        expect(transfer?.metadata?.status).toBe('pending');
    });

    it('不傳 inheritMeta 時元數據保持原樣（本地聊天路徑不受影響）', async () => {
        const charId = `c-inherit-none-${Date.now()}`;

        await ChatParser.parseAndExecuteActions(
            '[[ACTION:TRANSFER:66]]', charId, '阿一', noop,
        );

        const [transfer] = await DB.getMessagesByCharId(charId, true);
        expect(transfer.metadata).toEqual({ amount: '66', status: 'pending' });
    });

    it('熱點卡也帶標記', async () => {
        const charId = `c-inherit-news-${Date.now()}`;
        vi.spyOn(DB, 'getLatestHotNewsSnapshot').mockResolvedValue(null as any);

        await ChatParser.parseAndExecuteActions(
            '[[NEWS_CARD: 微博|某某官宣]]', charId, '阿一', noop,
            undefined, undefined, undefined, inheritMeta,
        );

        const [card] = await DB.getMessagesByCharId(charId, true);
        expect(card.type).toBe('news_card');
        expect(card.metadata?.activeMsg2?.messageId).toBe('push-abc');
        expect(card.metadata?.title).toBe('某某官宣');
    });
});

describe('TRANSFER_ACCEPT 結算哪一筆', () => {
    /** 造一筆用戶發出的待收轉帳 */
    const putPending = (charId: string, amount: string, timestamp: number) =>
        DB.saveMessage({
            charId, role: 'user', type: 'transfer', content: '[轉帳]',
            timestamp, metadata: { amount, status: 'pending' },
        } as any);

    it('收的是消息發出那一刻就存在的那筆，而不是用戶後來新轉的', async () => {
        const charId = `c-accept-${Date.now()}`;
        const sentAt = Date.now() - 6 * 3600_000;   // 角色是六小時前說的這句話
        await putPending(charId, '5', sentAt - 60_000);      // 夜裡那筆 5 塊
        await putPending(charId, '1000', sentAt + 3600_000); // 用戶早上新轉的 1000

        await ChatParser.parseAndExecuteActions(
            '這五塊我收下啦\n[[ACTION:TRANSFER_ACCEPT]]',
            charId, '阿一', noop, undefined, undefined, sentAt,
        );

        const msgs = await DB.getMessagesByCharId(charId, true);
        // 修復前: 取"重放時刻最新的一筆待收" → 把早上那 1000 給收了
        const receipt = msgs.find(m => m.role === 'assistant' && m.metadata?.receipt === 'accepted');
        expect(receipt?.metadata?.amount).toBe('5');
        const five = msgs.find(m => m.role === 'user' && m.metadata?.amount === '5');
        const thousand = msgs.find(m => m.role === 'user' && m.metadata?.amount === '1000');
        expect(five?.metadata?.status).toBe('accepted');
        expect(thousand?.metadata?.status).toBe('pending');
    });

    it('消息發出時一筆待收都沒有 → 退回按最新一筆結算並留一行日誌', async () => {
        const charId = `c-accept-late-${Date.now()}`;
        const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
        const sentAt = Date.now() - 6 * 3600_000;
        await putPending(charId, '1000', sentAt + 3600_000);

        await ChatParser.parseAndExecuteActions(
            '[[ACTION:TRANSFER_ACCEPT]]', charId, '阿一', noop, undefined, undefined, sentAt,
        );

        const msgs = await DB.getMessagesByCharId(charId, true);
        expect(msgs.find(m => m.role === 'assistant')?.metadata?.amount).toBe('1000');
        expect(warn.mock.calls.some(c => c.join(' ').includes('並沒有待收的轉帳'))).toBe(true);
    });

    it('不傳時間戳時維持老行為：結算最新一筆', async () => {
        const charId = `c-accept-now-${Date.now()}`;
        await putPending(charId, '5', Date.now() - 60_000);
        await putPending(charId, '1000', Date.now());

        await ChatParser.parseAndExecuteActions(
            '[[ACTION:TRANSFER_ACCEPT]]', charId, '阿一', noop,
        );

        const msgs = await DB.getMessagesByCharId(charId, true);
        expect(msgs.find(m => m.role === 'assistant')?.metadata?.amount).toBe('1000');
    });
});

describe('NEWS_CARD 回填鏈接', () => {
    const snapshotOf = (titles: Array<{ title: string; url: string }>) => ({
        id: 'x', date: '2026-08-02', slot: 0, slotLabel: '早間', platforms: ['weibo'],
        fetchedAt: Date.now(),
        items: titles.map(t => ({ title: t.title, url: t.url, source: '微博', desc: '' })),
    });

    it('兩條相似標題都能對上 → 這張卡不掛鏈接', async () => {
        const charId = `c-news-ambiguous-${Date.now()}`;
        vi.spyOn(console, 'warn').mockImplementation(noop);
        vi.spyOn(DB, 'getLatestHotNewsSnapshot').mockResolvedValue(snapshotOf([
            { title: '某某官宣退圈', url: 'https://example.com/a' },
            { title: '某某官宣新劇開機', url: 'https://example.com/b' },
        ]) as any);

        await ChatParser.parseAndExecuteActions(
            '[[NEWS_CARD: 微博|某某官宣]]', charId, '阿一', noop,
        );

        const [card] = await DB.getMessagesByCharId(charId, true);
        // 修復前: 模糊匹配挑第一條 → 卡片標題說 A、點進去是 B
        expect(card.metadata?.url).toBeUndefined();
        expect(card.metadata?.title).toBe('某某官宣');
    });

    it('只有一條對得上 → 照常補鏈接', async () => {
        const charId = `c-news-unique-${Date.now()}`;
        vi.spyOn(DB, 'getLatestHotNewsSnapshot').mockResolvedValue(snapshotOf([
            { title: '某某官宣退圈', url: 'https://example.com/a' },
            { title: '完全無關的另一條', url: 'https://example.com/z' },
        ]) as any);

        await ChatParser.parseAndExecuteActions(
            '[[NEWS_CARD: 微博|某某官宣]]', charId, '阿一', noop,
        );

        const [card] = await DB.getMessagesByCharId(charId, true);
        expect(card.metadata?.url).toBe('https://example.com/a');
    });

    it('標題完全一致時優先精確匹配，不受相似標題干擾', async () => {
        const charId = `c-news-exact-${Date.now()}`;
        vi.spyOn(DB, 'getLatestHotNewsSnapshot').mockResolvedValue(snapshotOf([
            { title: '某某官宣退圈的後續報道', url: 'https://example.com/b' },
            { title: '某某官宣退圈', url: 'https://example.com/a' },
        ]) as any);

        await ChatParser.parseAndExecuteActions(
            '[[NEWS_CARD: 微博|某某官宣退圈]]', charId, '阿一', noop,
        );

        const [card] = await DB.getMessagesByCharId(charId, true);
        expect(card.metadata?.url).toBe('https://example.com/a');
    });
});

describe('MUSIC_ACTION 取不到"正在聽"快照', () => {
    it('留一行日誌說明這條音樂動作跳過了（補收時用戶多半早就不聽了）', async () => {
        const charId = `c-music-${Date.now()}`;
        const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
        const addSong = vi.fn();

        const out = await ChatParser.parseAndExecuteActions(
            '這首真好聽[[MUSIC_ACTION:add|深夜]]', charId, '阿一', noop,
            { getListeningSnapshot: () => null, joinListeningTogether: noop, addSongToCharPlaylist: addSong as any },
        );

        expect(out).toBe('這首真好聽');
        expect(addSong).not.toHaveBeenCalled();
        // 修復前: 整個動作靜默蒸發, 排查時一點線索都沒有
        expect(warn.mock.calls.some(c => c.join(' ').includes('正在聽'))).toBe(true);
    });
});

/**
 * 定時消息的正文是角色幾小時前對著**它自己那時在聽的那首**寫的，而
 * `[[MUSIC_ACTION:add|歌單標題]]` 標籤裡只有歌單名、沒有歌名。只按「用戶此刻在聽的那首」
 * 重放的話：補收那一刻用戶多半什麼都沒放 → 卡片和加歌單整個不發生；就算用戶恰好在聽，
 * 加的也是用戶那首，不是角色說的那首。worker 到點把那首凍進 directive，調用方
 * （applyAssistantPostProcessing）當參數遞進來，這裡認它。
 */
describe('MUSIC_ACTION 用推送裡凍結的那首歌重放', () => {
    /** 角色自己的歌單（凍結的歌就是從這裡的抽樣池挑的，回來按 id 能補齊封面/時長） */
    const putCharWithPlaylist = (charId: string) => DB.saveCharacter({
        id: charId,
        name: '阿一',
        musicProfile: {
            bio: '', genreTags: [], signatureArtists: [], likedSongIds: [], recentPlays: [],
            playlists: [{
                id: 'pl-1', title: '深夜', description: '', coverStyle: 'gradient-01',
                createdAt: 0, updatedAt: 0,
                songs: [{
                    id: 33, name: '夜航星', artists: '某某', album: '星塵',
                    albumPic: 'https://example.com/cover.jpg', duration: 233000, fee: 0,
                    source: 'discovered',
                }],
            }],
        },
    } as any);

    it('用戶此刻沒在聽歌，照樣出卡片 + 加歌單（用角色說的那首）', async () => {
        const charId = `c-music-frozen-${Date.now()}`;
        await putCharWithPlaylist(charId);
        const addSong = vi.fn().mockResolvedValue({ playlistTitle: '深夜', created: false });

        await ChatParser.parseAndExecuteActions(
            '在聽《夜航星》，也收進歌單了[[MUSIC_ACTION:add|深夜]]', charId, '阿一', noop,
            { getListeningSnapshot: () => null, joinListeningTogether: noop, addSongToCharPlaylist: addSong },
            undefined, undefined, inheritMeta,
            { id: 33, name: '夜航星', artists: '某某' },
        );

        // 修復前: 快照為空 → 整條音樂動作跳過，正文聊著這首歌、卡片和歌單動作卻沒發生
        const [card] = await DB.getMessagesByCharId(charId, true);
        expect(card.type).toBe('music_card');
        expect(card.metadata?.song?.name).toBe('夜航星');
        // 卡片要封面/時長，directive 帶不動這些字段，回角色歌單按 id 補齊
        expect(card.metadata?.song?.songId).toBe(33);
        expect(card.metadata?.song?.albumPic).toBe('https://example.com/cover.jpg');
        expect(card.metadata?.song?.duration).toBe(233000);
        expect(card.metadata?.activeMsg2?.messageId).toBe('push-abc');
        expect(addSong).toHaveBeenCalledTimes(1);
        expect(addSong.mock.calls[0][1]).toMatchObject({ id: 33, name: '夜航星' });
        // 這首是角色自己在聽的，不是從用戶那兒收來的：標成 'user' 會讓之後的提示詞
        // 說「這首是 ta 給我的」
        expect(addSong.mock.calls[0][1].source).toBe('discovered');
        expect(addSong.mock.calls[0][2]).toEqual({ kind: 'existing', title: '深夜' });
    });

    it('用戶此刻在聽別的歌 → 認角色說的那首，不是用戶那首', async () => {
        const charId = `c-music-frozen-conflict-${Date.now()}`;
        await putCharWithPlaylist(charId);
        const addSong = vi.fn().mockResolvedValue({ playlistTitle: '深夜', created: false });
        const userSong = {
            songId: 99, name: '用戶在聽的歌', artists: '別人', album: '', albumPic: '', duration: 0, fee: 0,
        };

        await ChatParser.parseAndExecuteActions(
            '[[MUSIC_ACTION:add|深夜]]', charId, '阿一', noop,
            { getListeningSnapshot: () => userSong, joinListeningTogether: noop, addSongToCharPlaylist: addSong },
            undefined, undefined, inheritMeta,
            { id: 33, name: '夜航星', artists: '某某' },
        );

        // 修復前: 卡片和加進歌單的都是用戶那首，跟正文說的對不上
        const [card] = await DB.getMessagesByCharId(charId, true);
        expect(card.metadata?.song?.name).toBe('夜航星');
        expect(addSong.mock.calls[0][1].id).toBe(33);
    });

    it('歌單裡找不到（id 和歌名都對不上）→ 只用推送帶的那幾個字段，不改口說成用戶那首', async () => {
        const charId = `c-music-frozen-miss-${Date.now()}`;
        await putCharWithPlaylist(charId);
        const addSong = vi.fn().mockResolvedValue({ playlistTitle: '深夜', created: false });

        await ChatParser.parseAndExecuteActions(
            '[[MUSIC_ACTION:add|深夜]]', charId, '阿一', noop,
            {
                getListeningSnapshot: () => ({
                    songId: 99, name: '用戶在聽的歌', artists: '別人', album: '', albumPic: '', duration: 0, fee: 0,
                }),
                joinListeningTogether: noop,
                addSongToCharPlaylist: addSong,
            },
            undefined, undefined, inheritMeta,
            { id: 777, name: '早就被刪掉的歌', artists: '誰' },
        );

        const [card] = await DB.getMessagesByCharId(charId, true);
        expect(card.metadata?.song).toMatchObject({ songId: 777, name: '早就被刪掉的歌', albumPic: '' });
    });

    it('沒傳凍結的歌（本地聊天）→ 取用戶此刻在聽的那首', async () => {
        const charId = `c-music-live-${Date.now()}`;
        const addSong = vi.fn().mockResolvedValue({ playlistTitle: '我喜歡的音樂', created: false });
        const userSong = {
            songId: 99, name: '用戶在聽的歌', artists: '別人', album: '', albumPic: '', duration: 0, fee: 0,
        };

        await ChatParser.parseAndExecuteActions(
            '[[MUSIC_ACTION:add]]', charId, '阿一', noop,
            { getListeningSnapshot: () => userSong, joinListeningTogether: noop, addSongToCharPlaylist: addSong },
            undefined, undefined, inheritMeta,
        );

        const [card] = await DB.getMessagesByCharId(charId, true);
        expect(card.metadata?.song?.name).toBe('用戶在聽的歌');
        // 從用戶那兒收來的歌照舊打 'user' 標（提示詞會說「這首是 ta 給我的」）
        expect(addSong.mock.calls[0][1].source).toBe('user');
    });
});
