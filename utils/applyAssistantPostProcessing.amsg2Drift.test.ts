import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyAssistantPostProcessing, PostProcessCtx, XhsCaches } from './applyAssistantPostProcessing';
import { DB } from './db';

/**
 * 主動消息 2.0 的送達端：提示詞是幾小時前打包的，副作用到點才在本地跑。
 * 這份測試盯住兩類「時間差」引起的穿幫：
 *  1. 重放出來的副作用產物沒帶推送標記 → 處理失敗重來時被當成"上次什麼都沒做"，整套再跑一遍；
 *  2. 打包之後用戶把配置關掉（日記服務、HTML 卡片）→ 角色的話已經說滿，動作卻靜默蒸發。
 */

afterEach(() => { vi.restoreAllMocks(); });

const makeCtx = (char: any, extra: Partial<PostProcessCtx> = {}): PostProcessCtx => {
    const xhsCaches: XhsCaches = {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
    };
    return {
        char,
        userProfile: { name: '我' } as any,
        emojis: [],
        contextMsgs: [],
        fullMessages: [],
        initialData: {},
        historyMsgCount: 0,
        xhsCaches,
        api: {
            baseUrl: 'http://localhost:0',
            headers: {},
            effectiveApi: { baseUrl: 'http://localhost:0', apiKey: '', model: 'test' },
        },
        hooks: { setMessages: vi.fn(), addToast: vi.fn() },
        instantRender: true,
        ...extra,
    };
};

const pushMeta = (messageId: string) => ({
    source: 'active_msg_2',
    activeMsg2: { messageId, taskId: 'task-1' },
});

describe('directive 重放出來的副作用產物帶推送標記', () => {
    it('轉帳 directive 落庫的卡片帶 activeMsg2.messageId', async () => {
        const charId = `c-replay-transfer-${Date.now()}`;

        await applyAssistantPostProcessing('給你買奶茶', makeCtx({ id: charId, name: '阿一' }, {
            skipSecondPassLLM: true,
            directives: [{ type: 'transfer', amount: 520 }],
            mcdInheritMeta: pushMeta('push-1'),
        }));

        const msgs = await DB.getMessagesByCharId(charId, true);
        const card = msgs.find(m => m.type === 'transfer');
        // 修復前: 卡片沒有任何標記 → 重試清場認不出來, 這筆轉帳會被再轉一次
        expect(card?.metadata?.activeMsg2?.messageId).toBe('push-1');
        expect(card?.metadata?.amount).toBe('520');
        // 正文氣泡本來就帶標記, 順帶確認兩者對得上
        const text = msgs.find(m => m.type === 'text' && m.role === 'assistant');
        expect(text?.metadata?.activeMsg2?.messageId).toBe('push-1');
    });

    // 凍結的那首歌只能順著 directive 顯式遞給 chatParser: 重放時拼回的
    // `[[MUSIC_ACTION:add|深夜]]` 標籤裡只有歌單名, 帶不動歌名。這條接線斷了的話,
    // 音樂動作會靜默退回「取用戶此刻在聽的那首」—— 補收那刻用戶多半什麼都沒放,
    // 於是正文聊著這首歌, 卡片和加歌單整個不發生。
    it('music_action directive 裡凍結的歌遞到卡片上（用戶此刻沒在聽也照樣出卡）', async () => {
        const charId = `c-replay-music-${Date.now()}`;
        const addSong = vi.fn().mockResolvedValue({ playlistTitle: '深夜', created: false });

        await applyAssistantPostProcessing('這首真好聽', makeCtx({ id: charId, name: '阿一' }, {
            skipSecondPassLLM: true,
            directives: [{
                type: 'music_action', verb: 'add', args: ['深夜'],
                song: { id: 33, name: '夜航星', artists: '某某' },
            }],
            hooks: {
                setMessages: vi.fn(),
                addToast: vi.fn(),
                musicHooks: {
                    getListeningSnapshot: () => null,
                    joinListeningTogether: vi.fn(),
                    addSongToCharPlaylist: addSong,
                },
            },
        }));

        const card = (await DB.getMessagesByCharId(charId, true)).find(m => m.type === 'music_card');
        expect(card?.metadata?.song?.name).toBe('夜航星');
        expect(addSong.mock.calls[0][1]).toMatchObject({ id: 33, name: '夜航星' });
    });
});

describe('打包之後配置被關掉', () => {
    it('日記服務沒連上 → 落一條系統提示，而不是當無事發生', async () => {
        const charId = `c-diary-off-${Date.now()}`;

        await applyAssistantPostProcessing(
            '今天的事我想寫下來\n[[DIARY: 今天|見到你很開心]]',
            makeCtx({ id: charId, name: '阿一' }, { skipSecondPassLLM: true }),
        );

        const msgs = await DB.getMessagesByCharId(charId, true);
        const note = msgs.find(m => m.role === 'system');
        // 修復前: 標籤被靜默剝掉, 用戶只看到角色說"我想寫下來"然後什麼都沒發生
        expect(note?.content).toContain('想寫日記');
        expect(note?.content).toContain('沒寫成');
        expect(msgs.some(m => m.type === 'text' && m.content.includes('今天的事我想寫下來'))).toBe(true);
    });

    it('HTML 卡片開關關著 → 源碼降級成佔位文本，不把 <div> 漏進氣泡', async () => {
        const charId = `c-html-off-${Date.now()}`;

        await applyAssistantPostProcessing(
            '給你做了張卡片\n[html]<div class="x">生日快樂</div>[/html]',
            makeCtx({ id: charId, name: '阿一', htmlModeEnabled: false }, { skipSecondPassLLM: true }),
        );

        const msgs = await DB.getMessagesByCharId(charId, true);
        expect(msgs.some(m => m.type === 'html_card')).toBe(false);
        const all = msgs.map(m => m.content).join('\n');
        // 修復前: sanitize 和 hasDisplayContent 都不剝 [html], 整段 <div class="x"> 原樣進氣泡
        expect(all).not.toContain('<div');
        expect(all).toContain('[HTML 卡片]');
    });

    it('HTML 卡片開著時照常出卡片（不迴歸）', async () => {
        const charId = `c-html-on-${Date.now()}`;

        await applyAssistantPostProcessing(
            '給你做了張卡片\n[html]<div class="x">生日快樂</div>[/html]',
            makeCtx({ id: charId, name: '阿一', htmlModeEnabled: true }, { skipSecondPassLLM: true }),
        );

        const msgs = await DB.getMessagesByCharId(charId, true);
        const card = msgs.find(m => m.type === 'html_card');
        expect(card?.metadata?.htmlSource).toContain('生日快樂');
        expect(msgs.some(m => m.content.includes('[HTML 卡片]'))).toBe(false);
    });
});
