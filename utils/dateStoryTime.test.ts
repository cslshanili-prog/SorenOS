import { describe, expect, it } from 'vitest';
import { applyClockToHistory, chatHistoryTimeOptions, describeClockNote, effectiveStoryTime, formatStoryClock, historyTimeOptions, isDateTimeOn, isDefaultStoryTime, makeChatClock, makeDateClock, nextStoryTimeAfter, startStoryTime, storyClock, storyTimeIsOwn } from './dateStoryTime';
import { ChatPrompts } from './chatPrompts';
import { ContextBuilder } from './context';
import { buildNewDateStory } from './dateStory';
import type { CharacterProfile, DateStory, DateStoryTime, Message } from '../types';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 7, 4, 0); // 台北 12:00
const char = (over: Partial<CharacterProfile> = {}) => ({ id: 'c1', name: '凱恩', timezoneEnabled: true, timezone: 'Asia/Taipei', ...over } as unknown as CharacterProfile);
const story = (time?: DateStory['time']): DateStory => ({ id: 's1', charId: 'c1', status: 'ongoing', createdAt: T0, updatedAt: T0, time });

describe('故事時鐘', () => {
    it('真實＋流動就是原本的樣子（不給時鐘）', () => {
        expect(isDefaultStoryTime(undefined)).toBe(true);
        expect(makeDateClock(char(), story(undefined), T0)).toBeNull();
        expect(makeDateClock(char(), story({ source: 'real', flow: 'flowing' }), T0)).toBeNull();
    });

    it('真實＋靜止：停在起算那一刻', () => {
        const clock = makeDateClock(char(), story({ source: 'real', flow: 'frozen', anchorAt: T0 }), T0 + 5 * H)!;
        expect(clock.now).toBe(T0);
        expect(clock.frozen).toBe(true);
        expect(clock.map(T0 + 9 * H)).toBe(T0);
    });

    it('自定義：照角色時區解讀；流動就跟著現實往前走，靜止就停著', () => {
        const tz = 'Asia/Taipei';
        const c = char({ timezoneEnabled: true, timezone: tz } as any);
        const flowing = makeDateClock(c, story({ source: 'custom', flow: 'flowing', customStart: '1920-03-01T20:00', anchorAt: T0 }), T0 + 2 * H)!;
        expect(flowing.custom).toBe(true);
        const frozen = makeDateClock(c, story({ source: 'custom', flow: 'frozen', customStart: '1920-03-01T20:00', anchorAt: T0 }), T0 + 2 * H)!;
        expect(flowing.now - frozen.now).toBe(2 * H);
        expect(frozen.map(T0 + 99 * H)).toBe(frozen.now);
        // 沒填自定義時間：流動的當成真實，靜止的停在起算那一刻
        expect(makeDateClock(c, story({ source: 'custom', flow: 'flowing', anchorAt: T0 }), T0)).toBeNull();
        expect(makeDateClock(c, story({ source: 'custom', flow: 'frozen', anchorAt: T0 }), T0 + H)!.now).toBe(T0);
    });

    it('還沒開始故事：用角色身上那份、從現在算；開新故事時帶進去並從故事開始算', () => {
        const draft = { source: 'real', flow: 'frozen' } as const;
        expect(makeDateClock(char({ dateNextStoryTime: draft }), null, T0)!.now).toBe(T0);
        expect(startStoryTime(draft, T0)).toEqual({ ...draft, anchorAt: T0 });
        expect(startStoryTime({ source: 'real', flow: 'flowing' }, T0)).toBeUndefined();
        const s = buildNewDateStory(char({ dateNextStoryTime: draft }), T0);
        expect(s.time).toEqual({ ...draft, anchorAt: T0 });
    });

    it('格式照角色時區', () => {
        expect(formatStoryClock({ now: T0 }, 'Asia/Taipei')).toBe('2026-11-07 12:00 週六');
    });
});

describe('記錄時間換成故事裡的', () => {
    it('只換這場故事的、關掉「距離上次多久」', () => {
        const msgs = [
            { id: 1, role: 'user', timestamp: T0 - 9 * H, metadata: { source: 'chat' } },
            { id: 2, role: 'assistant', timestamp: T0 + H, metadata: { source: 'date', dateStoryId: 's1' } },
            { id: 3, role: 'assistant', timestamp: T0 + H, metadata: { source: 'date', dateStoryId: 'old' } },
        ] as unknown as Message[];
        const clock = makeDateClock(char(), story({ source: 'real', flow: 'frozen', anchorAt: T0 }), T0 + 2 * H)!;
        const c = char();
        const out = applyClockToHistory(msgs, c, clock);
        expect(out.messages.map(m => m.timestamp)).toEqual([T0 - 9 * H, T0, T0 + H]);
        // 不再借角色的時間感知開關（那個開關一關連時間戳都沒了），距離上次多久交給 historyTimeOptions
        expect(out.char).toBe(c);
        expect(historyTimeOptions(char(), clock)).toEqual({ showTimestamps: true, skipTimeGapHint: true });
        expect(applyClockToHistory(msgs, char(), null).messages).toBe(msgs);
    });
});

describe('提示詞裡的時間', () => {
    it('內建模式：Time 那行換成故事時間、不帶現實時間段；感知頁一樣', async () => {
        const { DatePrompts } = await import('./datePrompts');
        const c = { id: 'c1', name: '凱恩', avatar: '', description: '', systemPrompt: '你是凱恩。', memories: [], timezoneEnabled: true, timezone: 'Asia/Taipei' } as unknown as CharacterProfile;
        const clock = makeDateClock(c, story({ source: 'custom', flow: 'frozen', customStart: '1920-03-01T20:00', anchorAt: T0 }))!;
        const history = [{ id: 9, charId: 'c1', role: 'user', type: 'text', content: '「嗨」', timestamp: Date.now(), metadata: { source: 'date' } }] as unknown as Message[];
        const { messages } = await DatePrompts.buildSessionPayload({ char: c, userProfile: { name: '小雨' } as any, allMsgs: history, emojis: [], userText: '「嗨」', variant: 'send', clock });
        const sys = String(messages[0].content);
        expect(sys).toContain('當前時間 1920');
        expect(sys).toContain('時間停在這一刻');
        expect(sys).not.toContain(`當前時間 ${new Date().getFullYear()}`);
        const peek = DatePrompts.buildPeekPayload({ char: c, userProfile: { name: '小雨' } as any, allMsgs: [], emojis: [], clock });
        const all = peek.messages.map(m => String(m.content)).join('\n');
        expect(all).toContain('故事裡的時間：1920');
        expect(all).not.toContain('時間上下文');
    });

    it('自訂預設：時間佔位和 {{time}} 巨集都是故事時間', async () => {
        const { buildMeetingPresetPayload } = await import('./meetingPresetSession');
        const c = { id: 'c1', name: '凱恩', avatar: '', description: '', systemPrompt: '你是凱恩。', memories: [], timezoneEnabled: true, timezone: 'Asia/Taipei' } as unknown as CharacterProfile;
        const clock = makeDateClock(c, story({ source: 'custom', flow: 'frozen', customStart: '1920-03-01T20:00', anchorAt: T0 }))!;
        const doc = { schema: 'soren.meeting-preset', version: 1, name: 't', generation: {}, regexScripts: [], groups: [], globalVars: {},
            prompts: [{ id: 'main', name: 'main', enabled: true, role: 'system', content: '現在 {{isodate}} {{time}}' }, { id: 'chatHistory', name: 'h', enabled: true, role: 'system', content: '', slot: 'chatHistory' }] } as any;
        const { messages } = await buildMeetingPresetPayload({ preset: doc, char: c, userProfile: { name: '小雨' } as any, allMsgs: [], emojis: [], userText: '「嗨」', clock });
        expect(messages[0].content).toBe('現在 1920-03-01 20:00');
        expect(messages.some(m => m.content.includes('當前時間（故事裡）：1920-03-01 20:00'))).toBe(true);
    });
});

// 2026-11-17 Liora 實測：設了自定義凌晨三點，模型照著幾十個真實時間戳寫成上個月傍晚。
// 修法：自定義時鐘下只有這場故事的訊息標時間（已換成故事時間），聊天記錄、上一場的不標；
// 而且「故事裡現在是幾點」貼在本輪用戶那句後面（內建和預設兩條路都貼），離生成最近。
describe('自定義時鐘：記錄裡只剩一把尺、現在幾點貼在最後', () => {
    const c = { id: 'c1', name: '凱恩', avatar: '', description: '', systemPrompt: '你是凱恩。', memories: [], timezoneEnabled: true, timezone: 'Asia/Taipei' } as unknown as CharacterProfile;
    const now = Date.now();
    const history = [
        { id: 1, charId: 'c1', role: 'user', type: 'text', content: '聊天裡說的', timestamp: now - 40 * 86_400_000, metadata: { source: 'chat' } },
        { id: 2, charId: 'c1', role: 'assistant', type: 'text', content: '上一場故事', timestamp: now - 30 * 86_400_000, metadata: { source: 'date', dateStoryId: 'old' } },
        { id: 3, charId: 'c1', role: 'assistant', type: 'text', content: '這一場', timestamp: now - 60_000, metadata: { source: 'date', dateStoryId: 's1' } },
        { id: 4, charId: 'c1', role: 'user', type: 'text', content: '「嗨」', timestamp: now, metadata: { source: 'date', dateStoryId: 's1' } },
    ] as unknown as Message[];

    it('historyTimeOptions：自定義只標這場的；線下感知關掉一則都不標', () => {
        const custom = makeDateClock(c, story({ source: 'custom', flow: 'flowing', customStart: '1920-03-01T20:00', anchorAt: now }), now)!;
        const opt = historyTimeOptions(c, custom);
        expect(opt.skipTimeGapHint).toBe(true);
        const show = opt.showTimestamps as (m: Message) => boolean;
        expect(history.map(show)).toEqual([false, false, true, true]);
        expect(historyTimeOptions({ ...c, dateTimeAwarenessEnabled: false }, custom)).toEqual({ showTimestamps: false, skipTimeGapHint: true });
        expect(historyTimeOptions(c, null)).toEqual({ showTimestamps: true, skipTimeGapHint: false });
    });

    it('內建模式：聊天記錄沒時間戳、這場的是 1920 年、本輪末尾寫故事裡現在幾點', async () => {
        const { DatePrompts } = await import('./datePrompts');
        const clock = makeDateClock(c, story({ source: 'custom', flow: 'flowing', customStart: '1920-03-01T20:00', anchorAt: now }), now)!;
        const { messages } = await DatePrompts.buildSessionPayload({ char: c, userProfile: { name: '小雨' } as any, allMsgs: history, emojis: [], userText: '「嗨」', variant: 'send', clock });
        const texts = messages.map(m => String(m.content));
        const chatLine = texts.find(t => t.includes('聊天裡說的'))!;
        expect(chatLine).not.toMatch(/\[\d{4}-\d{2}-\d{2}/);
        expect(texts.find(t => t.includes('上一場故事'))).not.toMatch(/\[\d{4}-\d{2}-\d{2}/);
        expect(texts.find(t => t.includes('這一場'))).toMatch(/\[1920-03-01 19:59\]/);
        expect(texts[texts.length - 1]).toContain('故事裡現在是 1920-03-01 20:00');
        expect(texts.join('\n')).not.toContain('距離上一條消息');
    });

    it('自訂預設：本輪那句後面也貼故事時間；真實時鐘不貼', async () => {
        const { buildMeetingPresetPayload } = await import('./meetingPresetSession');
        const doc = { schema: 'soren.meeting-preset', version: 1, name: 't', generation: {}, regexScripts: [], groups: [], globalVars: {},
            prompts: [{ id: 'main', name: 'main', enabled: true, role: 'system', content: 'x' }, { id: 'chatHistory', name: 'h', enabled: true, role: 'system', content: '', slot: 'chatHistory' }] } as any;
        const clock = makeDateClock(c, story({ source: 'custom', flow: 'frozen', customStart: '1920-03-01T20:00', anchorAt: now }), now)!;
        const withClock = await buildMeetingPresetPayload({ preset: doc, char: c, userProfile: { name: '小雨' } as any, allMsgs: history, emojis: [], userText: '「嗨」', clock });
        const lastWith = withClock.messages[withClock.messages.length - 1].content;
        expect(lastWith).toContain('「嗨」');
        expect(lastWith).toContain('故事裡現在是 1920-03-01 20:00');
        const noClock = await buildMeetingPresetPayload({ preset: doc, char: c, userProfile: { name: '小雨' } as any, allMsgs: history, emojis: [], userText: '「嗨」', clock: null });
        expect(noClock.messages[noClock.messages.length - 1].content).not.toContain('故事裡現在是');
    });
});

// 2026-11-17 Liora 實測：故事進行中設了自定義時間，按「開始新的故事」新的一場又變回真實。
// 設定存在那場故事身上，完結就跟著走了；現在完結時留給下一場。
describe('完結後時間設定留給下一場', () => {
    const custom: DateStoryTime = { source: 'custom', flow: 'flowing', customStart: '2026-11-15T01:10', anchorAt: T0 };
    it('舊故事的設定去掉起算點、搬到下一場；開新故事時重新起算', () => {
        const next = nextStoryTimeAfter(char(), story(custom));
        expect(next).toEqual({ source: 'custom', flow: 'flowing', customStart: '2026-11-15T01:10' });
        expect(buildNewDateStory(char({ dateNextStoryTime: next }), T0 + H).time).toEqual({ ...next, anchorAt: T0 + H });
    });
    it('角色身上另外設了下一場的就用角色的；舊故事是真實＋流動就沒得留', () => {
        const mine: DateStoryTime = { source: 'real', flow: 'frozen' };
        expect(nextStoryTimeAfter(char({ dateNextStoryTime: mine }), story(custom))).toBe(mine);
        expect(nextStoryTimeAfter(char(), story(undefined))).toBeUndefined();
        expect(nextStoryTimeAfter(char(), story({ source: 'real', flow: 'flowing', anchorAt: T0 }))).toBeUndefined();
    });
});

// 時間來源「關閉」（2026-11-17 併掉舊的「線下時間感知」開關）：提示詞不帶時間、記錄不標時間戳
describe('時間來源關閉', () => {
    const c = { id: 'c1', name: '凱恩', avatar: '', description: '', systemPrompt: '你是凱恩。', memories: [], timezoneEnabled: true, timezone: 'Asia/Taipei' } as unknown as CharacterProfile;
    const now = Date.now();
    const history = [
        { id: 1, charId: 'c1', role: 'user', type: 'text', content: '聊天裡說的', timestamp: now - 3 * 86_400_000, metadata: { source: 'chat' } },
        { id: 2, charId: 'c1', role: 'user', type: 'text', content: '「嗨」', timestamp: now, metadata: { source: 'date', dateStoryId: 's1' } },
    ] as unknown as Message[];

    it('makeDateClock：來源 off 或舊開關 false 都算關著；關著不是預設、也不是故事時鐘', () => {
        const offClock = makeDateClock(c, story({ source: 'off', flow: 'flowing' }), now)!;
        expect(offClock.off).toBe(true);
        expect(offClock.now).toBe(now);
        expect(storyClock(offClock)).toBeNull();
        expect(isDateTimeOn(offClock)).toBe(false);
        expect(makeDateClock({ ...c, dateTimeAwarenessEnabled: false }, null, now)!.off).toBe(true);
        expect(isDefaultStoryTime({ source: 'off', flow: 'flowing' })).toBe(false);
        expect(historyTimeOptions(c, offClock)).toEqual({ showTimestamps: false, skipTimeGapHint: true });
        expect(nextStoryTimeAfter(c, story({ source: 'off', flow: 'flowing', anchorAt: now }))).toEqual({ source: 'off', flow: 'flowing' });
    });

    it('內建模式：沒有當前時間、沒有時間戳、本輪末尾不寫幾點', async () => {
        const { DatePrompts } = await import('./datePrompts');
        const clock = makeDateClock(c, story({ source: 'off', flow: 'flowing' }), now)!;
        const { messages } = await DatePrompts.buildSessionPayload({ char: c, userProfile: { name: '小雨' } as any, allMsgs: history, emojis: [], userText: '「嗨」', variant: 'send', clock });
        const texts = messages.map(m => String(m.content));
        expect(texts[0]).not.toContain('當前時間');
        expect(texts[0]).not.toContain('### 當前時間');
        expect(texts.join('\n')).not.toMatch(/\[\d{4}-\d{2}-\d{2}/);
        expect(texts[texts.length - 1]).not.toMatch(/現在是|故事裡現在是/);
        const peek = DatePrompts.buildPeekPayload({ char: c, userProfile: { name: '小雨' } as any, allMsgs: history, emojis: [], clock });
        const all = peek.messages.map(m => String(m.content)).join('\n');
        expect(all).not.toContain('當前時間');
        expect(all).not.toContain('時間上下文');
    });

    it('自訂預設：time 佔位是空的、{{time}} 照現實（預設作者自己決定）、本輪不貼', async () => {
        const { buildMeetingPresetPayload } = await import('./meetingPresetSession');
        const doc = { schema: 'soren.meeting-preset', version: 1, name: 't', generation: {}, regexScripts: [], groups: [], globalVars: {},
            prompts: [{ id: 'main', name: 'main', enabled: true, role: 'system', content: 'x' }, { id: 't', name: 't', enabled: true, role: 'system', content: '', slot: 'time' }, { id: 'chatHistory', name: 'h', enabled: true, role: 'system', content: '', slot: 'chatHistory' }] } as any;
        const clock = makeDateClock(c, story({ source: 'off', flow: 'flowing' }), now)!;
        const { messages } = await buildMeetingPresetPayload({ preset: doc, char: c, userProfile: { name: '小雨' } as any, allMsgs: history, emojis: [], userText: '「嗨」', clock });
        expect(messages.some(m => m.content.includes('當前時間'))).toBe(false);
        expect(messages[messages.length - 1].content).not.toContain('故事裡現在是');
    });
});

// 私聊的時鐘（plans/time-system.md 第 2b 節，第 2 批）：char.chatTime；見面沒另外設就跟著它
describe('私聊的時鐘', () => {
    const c = { id: 'c1', name: '凱恩', avatar: '', description: '', systemPrompt: '你是凱恩。', memories: [], timezoneEnabled: true, timezone: 'Asia/Taipei' } as unknown as CharacterProfile;
    const now = Date.now();
    const custom: DateStoryTime = { source: 'custom', flow: 'flowing', customStart: '1920-03-01T20:00', anchorAt: now - H };

    it('makeChatClock：沒設回 null；自定義從填的時間起跟著現實走；靜止就停著', () => {
        expect(makeChatClock(c, now)).toBeNull();
        const flowing = makeChatClock({ ...c, chatTime: custom }, now)!;
        expect(formatStoryClock(flowing)).toBe('1920-03-01 21:00 週一');
        expect(flowing.custom).toBe(true);
        const frozen = makeChatClock({ ...c, chatTime: { ...custom, flow: 'frozen' } }, now)!;
        expect(formatStoryClock(frozen)).toBe('1920-03-01 20:00 週一');
        expect(frozen.frozen).toBe(true);
        // 私聊沒有「關閉」：存成 off 也當沒設
        expect(makeChatClock({ ...c, chatTime: { source: 'off', flow: 'flowing' } }, now)).toBeNull();
    });

    it('歷史照時鐘換算：流動的整條換、距離上次照算；靜止的不標、不算', () => {
        const flowing = makeChatClock({ ...c, chatTime: custom }, now)!;
        const opt = chatHistoryTimeOptions(flowing);
        expect(opt.mapTimestamp!(now)).toBe(flowing.now);
        expect(opt.showTimestamps).toBeUndefined();
        expect(chatHistoryTimeOptions(makeChatClock({ ...c, chatTime: { ...custom, flow: 'frozen' } }, now))).toEqual({ showTimestamps: false, skipTimeGapHint: true });
        expect(chatHistoryTimeOptions(null)).toEqual({});
    });

    it('buildMessageHistory 吃 mapTimestamp：時間戳和距離上次都是換算過的', () => {
        const history = [
            { id: 1, charId: 'c1', role: 'user', type: 'text', content: '早', timestamp: now - 3 * 86_400_000 },
            { id: 2, charId: 'c1', role: 'user', type: 'text', content: '嗨', timestamp: now },
        ] as unknown as Message[];
        const flowing = makeChatClock({ ...c, chatTime: custom }, now)!;
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 50, c, { name: '小雨' } as any, [], undefined, chatHistoryTimeOptions(flowing));
        const texts = apiMessages.map(m => String(m.content));
        expect(texts[0]).toMatch(/^\[1920-02-27 21:00\]/);
        expect(texts[1]).toMatch(/^\[1920-03-01 21:00\]/);
        expect(texts[1]).toContain('距離上一條消息: 3 天');
    });

    it('核心上下文的時間塊照時鐘說、附那句話；距離上次照同一把尺算', () => {
        const flowing = makeChatClock({ ...c, chatTime: custom }, now)!;
        const block = ContextBuilder.buildTimeAwarenessBlock(c, { now: flowing.now, clockNote: describeClockNote(flowing), lastInteractionTs: flowing.map(now - 2 * H) });
        expect(block).toContain('現在是 1920年3月1日 週一 晚上 21:00');
        expect(block).toContain('這是故事裡的時間，跟現實不同');
        expect(block).toContain('過去 2 小時');
    });

    it('見面沒另外設就跟著私聊；自己設了以自己的為準', () => {
        const withChat = { ...c, chatTime: custom };
        expect(effectiveStoryTime(withChat, null)).toBe(custom);
        expect(storyTimeIsOwn(withChat, null)).toBe(false);
        expect(formatStoryClock(makeDateClock(withChat, null, now)!)).toBe('1920-03-01 21:00 週一');
        expect(formatStoryClock(makeDateClock(withChat, story(undefined), now)!)).toBe('1920-03-01 21:00 週一');
        const own: DateStoryTime = { source: 'real', flow: 'frozen', anchorAt: now };
        expect(effectiveStoryTime({ ...withChat, dateNextStoryTime: own }, null)).toBe(own);
        expect(storyTimeIsOwn({ ...withChat, dateNextStoryTime: own }, null)).toBe(true);
        expect(effectiveStoryTime(withChat, story(own))).toBe(own);
        // 完結時：見面自己沒設（跟著私聊）就什麼都不留，下一場照樣跟私聊
        expect(nextStoryTimeAfter(withChat, story(undefined))).toBeUndefined();
    });
});
