import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// chatPrompts 是具名 import 進去的，只能在模塊邊界上替換。
vi.mock('./dailySchedule', () => ({
    getDailyScheduleForChar: vi.fn(async () => schedule),
}));

import { ChatPrompts } from './chatPrompts';
import { ContextBuilder } from './context';
import { DB } from './db';
import { RealtimeContextManager } from './realtimeContext';

// 迴歸守衛：主動消息的模板是最後一次聊天時打好、到點才渲染的。以前整份 system prompt
// 原樣烤進去，裡頭「打包這一刻」的狀態到觸發時全過期了——用戶在凌晨收到的那條消息，
// 角色照著中午那份世界說話：報著中午的鐘、說自己在健身房、勸人帶傘、還在祝昨天的節日。
//
// 每條對著一種當時會露出來的樣子；默認（前台聊天）那一路必須原樣保留。

const userProfile = { name: '條條' } as any;

const baseChar = (over: Record<string, unknown> = {}) => ({
    id: 'char-fp',
    name: '阿一',
    scheduleFeatureEnabled: true,
    ...over,
}) as any;

const realtimeConfig = { weatherEnabled: true, newsEnabled: true } as any;

// vi.mock 的工廠在模塊最頂上執行，schedule 必須是 var 提升上去的（const 會踩 TDZ）。
// eslint-disable-next-line no-var
var schedule = {
    id: 'char-fp_2026-08-02',
    charId: 'char-fp',
    date: '2026-08-02',
    generatedAt: 0,
    slots: [
        { startTime: '00:00', activity: '跑步', location: '健身房' },
        { startTime: '23:30', activity: '睡覺' },
    ],
} as any;

const build = async (char: any, forFirePack: boolean) => {
    const parts = await ChatPrompts.buildSystemPromptParts(
        char, userProfile, [], [], [], [],
        realtimeConfig, undefined, undefined, undefined, undefined, undefined,
        forFirePack ? { forFirePack: true } : undefined,
    );
    return `${parts.stable}\n${parts.volatileState}\n${parts.recencyTail}`;
};

beforeEach(() => {
    // 天氣/熱搜真去聯網太慢也不穩定，樁成固定內容；測的是「這一段進沒進 prompt」。
    vi.spyOn(RealtimeContextManager, 'fetchWeather').mockResolvedValue({
        city: '上海', description: '晴', temp: 31, feelsLike: 35, humidity: 60,
    } as any);
    vi.spyOn(RealtimeContextManager, 'fetchNews').mockResolvedValue([
        { title: '某某官宣', source: '微博' },
    ] as any);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('forFirePack —— 打包時刻的狀態一律不烤進模板', () => {
    // 這一塊不烤進來不等於主動消息看不到天氣熱搜：模板裡留著 AMSG_SLOT_REALTIME_WORLD，
    // worker 到點自己去拉一次再填（見 worker/amsg 的 realtimeWorld）。這裡守的是
    // 「別把打包那一刻的讀數醃進去」。
    it('【真實世界感知系統】整塊不進：當前真實時間 / 天氣 / 熱搜 / 真實世界鋼印', async () => {
        const normal = await build(baseChar(), false);
        expect(normal).toContain('真實世界感知系統');
        expect(normal).toContain('當前真實時間');
        expect(normal).toContain('實時天氣');
        expect(normal).toContain('最近真實發生的熱點');

        const packed = await build(baseChar(), true);
        expect(packed).not.toContain('真實世界感知系統');
        expect(packed).not.toContain('當前真實時間');
        expect(packed).not.toContain('實時天氣');
        expect(packed).not.toContain('最近真實發生的熱點');
        // 抬頭那句「⚠️ 以下信息來自真實世界」措辭比任何免責聲明都硬，一併帶走
        expect(packed).not.toContain('以下信息來自真實世界');
    });

    it('「現在是 X」時間塊不進（當前時間由 worker 到點填槽）', async () => {
        expect(await build(baseChar(), false)).toContain('現在是');
        expect(await build(baseChar(), true)).not.toContain('現在是');
    });

    it('日程當前時段不進（改由 AMSG_SLOT_SCENE 到點現挑）', async () => {
        expect(await build(baseChar(), false)).toContain('當前時段：');
        expect(await build(baseChar(), true)).not.toContain('當前時段：');
    });

    it('「你剛剛和對方結束了一通電話 / 見面」不進', async () => {
        const msgs = [
            { id: 1, charId: 'char-fp', role: 'assistant', type: 'text', content: '喂', timestamp: 1, metadata: { source: 'call' } },
            { id: 2, charId: 'char-fp', role: 'user', type: 'text', content: '嗯', timestamp: 2 },
        ] as any[];
        const withMsgs = async (forFirePack: boolean) => {
            const parts = await ChatPrompts.buildSystemPromptParts(
                baseChar(), userProfile, [], [], [], msgs,
                realtimeConfig, undefined, undefined, undefined, undefined, undefined,
                forFirePack ? { forFirePack: true } : undefined,
            );
            return parts.volatileState;
        };
        expect(await withMsgs(false)).toContain('你剛剛結束了語音通話');
        expect(await withMsgs(true)).not.toContain('系統提示｜模式切換');
    });

    it('生活記錄：摘要數據留著，代記工具說明不進', async () => {
        const char = baseChar({ id: 'char-fp-life', lifeRecordEnabled: true });
        const normal = await build(char, false);
        expect(normal).toContain('的生活記錄（潛意識背景）');
        expect(normal).toContain('代記工具');

        const packed = await build(char, true);
        expect(packed).toContain('的生活記錄（潛意識背景）');
        expect(packed).not.toContain('代記工具');
        expect(packed).not.toContain('[[LIFE:');
    });

    it('生活記錄的否決反饋不進、也不被消費掉（它是讀完就清的一次性內容）', async () => {
        const charId = `char-fp-fb-${Date.now()}`;
        const char = baseChar({ id: charId, name: '阿一', lifeRecordEnabled: true });
        await DB.saveLifeRecord({
            id: `life-fb-${Date.now()}`,
            module: 'med', kind: 'take', date: '2026-08-02', timestamp: Date.now(),
            payload: { name: '布洛芬' },
            recordedBy: charId, recordedByName: '阿一',
            reviewStatus: 'rejected', pendingFeedback: true,
        } as any);

        // 打包這一輪不該看到，也不該把 pendingFeedback 清掉
        expect(await build(char, true)).not.toContain('記錄反饋');

        // 用戶下次真正聊天時還在
        expect(await build(char, false)).toContain('記錄反饋');
    }, 20000);
});

// 迴歸守衛：「用戶此刻也在《彼方》裡」說的是用戶當下掛在哪個房間。烤進模板之後，
// 用戶下線好幾個小時了，角色還在說「看你小人掛在聽歌房」。worker 夠不著用戶此刻的
// 彼方狀態，所以這一段沒有到點補的槽位，屬於「不補」的那一類。
describe('彼方：用戶此刻掛在哪個房間不進打包', () => {
    const vrChar = () => baseChar({ id: 'char-fp-vr', vrState: { enabled: true } });
    const vrUser = {
        name: '條條',
        vrState: { enabled: true, currentRoom: 'music', activity: '發呆中' },
    } as any;

    const buildVr = async (forFirePack: boolean) => {
        const parts = await ChatPrompts.buildSystemPromptParts(
            vrChar(), vrUser, [], [], [], [],
            realtimeConfig, undefined, undefined, undefined, undefined, undefined,
            forFirePack ? { forFirePack: true } : undefined,
        );
        return `${parts.stable}\n${parts.volatileState}`;
    };

    it('前台聊天照常告訴角色用戶掛在哪個房間', async () => {
        const out = await buildVr(false);
        expect(out).toContain('此刻也在《彼方》');
        expect(out).toContain('【聽歌房】');
        expect(out).toContain('發呆中');
    });

    it('打包時整段不進；《彼方》是什麼的常駐框定照留（那個不隨時間變）', async () => {
        const out = await buildVr(true);
        expect(out).not.toContain('此刻也在《彼方》');
        expect(out).not.toContain('【聽歌房】');
        expect(out).not.toContain('發呆中');
        expect(out).toContain('關於《彼方》');
    });
});

describe('天氣開著但角色關了時間感知', () => {
    it('不該從天氣塊裡漏出「當前真實時間」', async () => {
        const char = baseChar({ id: 'char-fp-notime', timeAwarenessEnabled: false });
        const out = await build(char, false);
        expect(out).toContain('實時天氣');
        expect(out).not.toContain('當前真實時間');
    });
});

describe('ContextBuilder.buildScheduleInjection 仍是同一份實現', () => {
    it('轉發到 scheduleInjection 那個純葉子（worker 到點渲染共用它）', () => {
        const at = new Date(2026, 7, 2, 12, 0);
        expect(ContextBuilder.buildScheduleInjection(schedule, undefined, at))
            .toContain('當前時段：00:00 你正在跑步（健身房）');
    });
});

describe('群聊背景的時間標註', () => {
    const groups = [{ id: 'g-fp', name: '深夜茶話會', members: ['char-fp-grp'] }] as any;

    const groupBlock = async (forFirePack: boolean) => {
        const parts = await ChatPrompts.buildSystemPromptParts(
            baseChar({ id: 'char-fp-grp', customTimezoneEnabled: true, customTimezone: 'Asia/Shanghai' }),
            userProfile, groups, [], [], [],
            realtimeConfig, undefined, undefined, undefined, undefined, undefined,
            forFirePack ? { forFirePack: true } : undefined,
        );
        return parts.volatileState;
    };

    it('前台聊天帶「約 X 分鐘前」；打包時只留絕對時間戳', async () => {
        await DB.saveMessage({
            charId: 'user', groupId: 'g-fp', role: 'user', type: 'text',
            content: '今晚吃火鍋嗎', timestamp: Date.now() - 3 * 60_000,
        } as any);

        expect(await groupBlock(false)).toMatch(/· [约約]?\s*\d+\s*分[钟鐘]前|· [刚剛][刚剛]/);
        // 打包時的「剛才」到點渲染時早就不是那個剛才了：角色會把昨天的群聊說成
        // 「剛才群裡說晚上一起吃飯」。
        expect(await groupBlock(true)).not.toContain('分鐘前');
    }, 20000);
});

// 迴歸守衛：小紅書服務器多半跑在用戶自己電腦上（localhost:xxxx）。CF worker 連不上，
// 但提示詞照樣教角色「你有小紅書號的哦，可以幫你搜東西」——角色到點真去用，
// 撞一鼻子灰之後還會把沒發生的搜索說成發生過。夠不著的地址乾脆不進打包的那份提示詞。
describe('小紅書：worker 夠不著的服務器不寫進 fire_pack', () => {
    const withServer = async (serverUrl: string, forFirePack: boolean) => {
        const parts = await ChatPrompts.buildSystemPromptParts(
            baseChar({ id: 'char-fp-xhs', xhsEnabled: true }), userProfile, [], [], [], [],
            { ...realtimeConfig, xhsMcpConfig: { enabled: true, serverUrl } } as any,
            undefined, undefined, undefined, undefined, undefined,
            forFirePack ? { forFirePack: true } : undefined,
        );
        return parts.stable;
    };

    it('本機地址：前台照常教，打包時整段不進', async () => {
        expect(await withServer('http://localhost:18060', false)).toContain('小紅書');
        expect(await withServer('http://localhost:18060', true)).not.toContain('小紅書');
        expect(await withServer('http://192.168.1.7:18060', true)).not.toContain('小紅書');
    });

    it('公網地址：打包時照常帶上', async () => {
        expect(await withServer('https://xhs.example.com', true)).toContain('小紅書');
    });
});


describe('SAR public introduction', () => {
    it.each(['manual', 'scheduled'])('enabled %s characters know the public setting without the manual-only extra paragraph', async activityMode => {
        const char = baseChar({ vrState: { enabled: true, activityMode } });
        for (const firePack of [false, true]) {
            const out = await build(char, firePack);
            expect(out).toContain('凱恩和艾文是來自另一個世界的玩家');
            expect(out).toContain('是否見過、聊過、熟不熟，要以實際活動記錄和記憶為準');
            expect(out).not.toContain('僅手動活動');
        }
    });
    it('does not give disconnected characters the SAR introduction', async () => {
        expect(await build(baseChar({ vrState: { enabled: false } }), false)).not.toContain('凱恩和艾文是來自另一個世界的玩家');
    });
});
