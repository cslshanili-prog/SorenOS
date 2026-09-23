import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { extractJson, parseCharBeat, parseNpcScene, storyTimeLabel, buildModeRule, buildWorldCharTurn, buildNpcTurn, parseRolledNpcs, buildNpcRollPrompt, NARRATIVE_STYLES, narrationPersonGuide, realNowSeg, realObserveTarget, worldTimeLabel, formatRealClock, migrateWorldDaySegs, SEGMENTS_PER_DAY, worldNow, worldTzLabel, clampRealClockToNow, alignCharToWorldClock } from './prompts';
import { applyRelationshipDeltas, collectSeeds, buildSummary, dropDuplicatePosts } from './engine';
import { ensureThreads, applyBeatToThreads, applyNpcGroupLines, applyNpcDms, npcInboxes, dmThreadsOf, groupThreadOf, formatThreadForPrompt, dmThreadId, GROUP_THREAD_ID } from './threads';
import { WorldScheduler } from './scheduler';
import type { CharacterProfile, WorldProfile } from '../../types';

// scheduler 的 attachListeners 會訪問 document/window（node 環境下沒有），補最簡 stub。
const g = globalThis as any;
if (typeof g.document === 'undefined') g.document = { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} };
if (typeof g.window === 'undefined') g.window = { addEventListener() {}, removeEventListener() {} };

const mkChar = (id: string, name: string): CharacterProfile => ({ id, name } as CharacterProfile);

const mkWorld = (overrides: Partial<WorldProfile> = {}): WorldProfile => ({
    id: 'w1', name: '栗子鎮', worldview: '海邊小鎮', mode: 'light',
    memberIds: ['a', 'b'], npcs: [], houses: [], relationships: [],
    storyClock: 0, createdAt: 0, updatedAt: 0,
    ...overrides,
});

describe('storyTimeLabel', () => {
    it('一天四段推進：早上/中午/晚上/凌晨（凌晨按次日稱呼）', () => {
        expect(storyTimeLabel(0)).toBe('第1天早上');
        expect(storyTimeLabel(1)).toBe('第1天中午');
        expect(storyTimeLabel(2)).toBe('第1天晚上');
        expect(storyTimeLabel(3)).toBe('第2天凌晨'); // 第1天晚上熬過午夜 = 第2天凌晨
        expect(storyTimeLabel(4)).toBe('第2天早上');
        expect(storyTimeLabel(6)).toBe('第2天晚上');
    });
});

describe('migrateWorldDaySegs（三段制舊存檔 → 四段制）', () => {
    it('sim 世界按「保持天數與段位」換算 storyClock/simSummarizedClock', () => {
        // 舊 45 = 第16天早上（45/3=15 天整）→ 新 15*4+0=60，仍是第16天早上
        const w = mkWorld({ timeMode: 'sim', storyClock: 45, simSummarizedClock: 60 });
        expect(migrateWorldDaySegs(w)).toBe(true);
        expect(w.storyClock).toBe(60);
        expect(w.simSummarizedClock).toBe(80); // 舊 60 = 20 天整 → 新 80
        expect(w.clockSegs).toBe(SEGMENTS_PER_DAY);
        expect(storyTimeLabel(w.storyClock)).toBe('第16天早上'); // 遷移前後天數/段位一致
    });
    it('real 世界不換算 storyClock（只是輪次計數），僅打標記', () => {
        const w = mkWorld({ timeMode: 'real', storyClock: 45 });
        expect(migrateWorldDaySegs(w)).toBe(true);
        expect(w.storyClock).toBe(45);
        expect(w.clockSegs).toBe(SEGMENTS_PER_DAY);
    });
    it('已遷移過的不重複處理', () => {
        const w = mkWorld({ timeMode: 'sim', storyClock: 60, clockSegs: SEGMENTS_PER_DAY });
        expect(migrateWorldDaySegs(w)).toBe(false);
        expect(w.storyClock).toBe(60);
    });
});

describe('extractJson', () => {
    it('解析 ```json 圍欄', () => {
        expect(extractJson('前導文字\n```json\n{"a":1}\n```\n尾巴')).toEqual({ a: 1 });
    });
    it('解析裸 JSON（夾雜正文）', () => {
        expect(extractJson('我來啦 {"a":1} 完事')).toEqual({ a: 1 });
    });
    it('容忍尾逗號', () => {
        expect(extractJson('{"a":1,}')).toEqual({ a: 1 });
    });
    it('剝掉 <think> 塊', () => {
        expect(extractJson('<think>{"x":9}</think>{"a":1}')).toEqual({ a: 1 });
    });
    it('解析失敗返回 null', () => {
        expect(extractJson('完全不是 JSON')).toBeNull();
    });
});

describe('parseCharBeat', () => {
    const char = mkChar('a', '小滿');
    const members = ['小滿', '阿嵐'];

    it('完整解析一拍', () => {
        const raw = JSON.stringify({
            location: '同居小屋的廚房',
            narrative: '小滿把昨晚剩的湯熱了。',
            mood: '鬆弛',
            statusPanel: { 體力: 72, 心情值: 88 },
            phone: { posts: ['今天的湯'], dms: [{ to: '阿嵐', lines: ['湯好了，快回來'] }] },
            relationships: [{ with: '阿嵐', delta: 2, reason: '一起吃了早飯' }],
        });
        const beat = parseCharBeat(raw, char, members);
        expect(beat.location).toBe('同居小屋的廚房');
        expect(beat.mood).toBe('鬆弛');
        expect(beat.statusPanel).toEqual({ 體力: 72, 心情值: 88 });
        expect(beat.phone?.dms?.[0].to).toBe('阿嵐');
        expect(beat.relationshipDeltas?.[0]).toMatchObject({ withName: '阿嵐', delta: 2 });
    });

    it('JSON 解析失敗時把原文兜底進 narrative，不丟內容', () => {
        const beat = parseCharBeat('她只是安靜地坐在窗邊，看了一下午的海。', char, members);
        expect(beat.narrative).toContain('看了一下午的海');
        expect(beat.charName).toBe('小滿');
    });

    it('解析時間軸/備忘錄/衝動/秘密（schema v3）', () => {
        const raw = JSON.stringify({
            location: '鎮上', narrative: 'x'.repeat(50), mood: '複雜',
            timeline: [
                { time: '9:00', place: '畫室', event: '畫畫', shared: true },
                { time: '11:30', place: '酒吧', event: '偷偷喝了一杯', shared: false },
                { event: '' }, // 無效條目被過濾
            ],
            memo: ['買顏料', '別忘了道歉'],
            impulse: { text: '想辭職', options: ['辭', '再忍忍'] },
            secrets: [{ text: '偷偷去了酒吧', hideFrom: ['阿嵐', '陌生人'] }],
        });
        const beat = parseCharBeat(raw, char, members);
        expect(beat.timeline).toHaveLength(2);
        expect(beat.timeline![1].shared).toBe(false);
        expect(beat.memo).toEqual(['買顏料', '別忘了道歉']);
        expect(beat.impulse).toEqual({ text: '想辭職', options: ['辭', '再忍忍'] });
        // hideFrom 只保留真實成員
        expect(beat.secrets).toEqual([{ text: '偷偷去了酒吧', hideFrom: ['阿嵐'] }]);
    });

    it('解析當面對話與群聊發言，過濾非成員的對話對象', () => {
        const raw = JSON.stringify({
            location: '客廳', narrative: 'x', mood: 'y',
            dialogues: [{ with: '阿嵐', lines: ['早啊'] }, { with: '路人', lines: ['?'] }],
            phone: { group: ['今天誰做飯'] },
        });
        const beat = parseCharBeat(raw, char, members);
        expect(beat.dialogues).toEqual([{ with: '阿嵐', lines: ['早啊'] }]);
        expect(beat.phone?.group).toEqual(['今天誰做飯']);
    });

    it('過濾非成員的私聊對象與關係對象，delta 截斷到 ±4', () => {
        const raw = JSON.stringify({
            location: '鎮上', narrative: 'x', mood: 'y',
            phone: { dms: [{ to: '陌生人', lines: ['?'] }, { to: '阿嵐', lines: ['在嗎'] }] },
            relationships: [{ with: '路人甲', delta: 3 }, { with: '阿嵐', delta: 99 }],
        });
        const beat = parseCharBeat(raw, char, members);
        expect(beat.phone?.dms).toHaveLength(1);
        expect(beat.relationshipDeltas).toHaveLength(1);
        expect(beat.relationshipDeltas?.[0].delta).toBe(4);
    });
});

describe('parseNpcScene', () => {
    it('解析 scene + hooks + 群聊冒泡', () => {
        const out = parseNpcScene('```json\n{"scene":"麵包店飄香。","hooks":["老闆娘多烤了一爐"],"groupLines":[{"name":"老闆娘","line":"栗子包出爐咯"}]}\n```');
        expect(out.scene).toBe('麵包店飄香。');
        expect(out.hooks).toEqual(['老闆娘多烤了一爐']);
        expect(out.groupLines).toEqual([{ name: '老闆娘', line: '栗子包出爐咯' }]);
    });
    it('解析失敗時原文兜底', () => {
        const out = parseNpcScene('鎮子很安靜。');
        expect(out.scene).toBe('鎮子很安靜。');
        expect(out.hooks).toEqual([]);
        expect(out.groupLines).toEqual([]);
    });
});

describe('文風預設', () => {
    it('新增「日常輕喜劇」preset 可用', () => {
        expect(NARRATIVE_STYLES.sitcom).toBeTruthy();
        expect(NARRATIVE_STYLES.sitcom.name).toBe('日常輕喜劇');
        expect(NARRATIVE_STYLES.sitcom.guide.length).toBeGreaterThan(20);
    });
});

describe('AI roll NPC', () => {
    it('buildNpcRollPrompt 帶上世界觀、角色人設、已有 NPC 與數量', () => {
        const prompt = buildNpcRollPrompt({
            worldName: '栗子鎮', worldview: '海邊小鎮',
            members: [{ name: '小滿', persona: '畫師，怕生' }],
            count: 3, existingNames: ['老闆娘'],
        });
        expect(prompt).toContain('栗子鎮');
        expect(prompt).toContain('小滿：畫師，怕生');
        expect(prompt).toContain('老闆娘');
        expect(prompt).toContain('3');
    });

    it('parseRolledNpcs：解析 npcs，補默認 emoji，過濾空名/重名/超量', () => {
        const raw = JSON.stringify({
            npcs: [
                { name: '麵包店老闆娘', persona: '熱心腸', emoji: '🥖' },
                { name: '', persona: 'x' },                 // 空名過濾
                { name: '老張', persona: '修鞋的' },          // 無 emoji → 默認
                { name: '老闆娘', persona: '重名' },          // 與已有重名過濾
            ],
        });
        const out = parseRolledNpcs(raw, ['老闆娘']);
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({ name: '麵包店老闆娘', persona: '熱心腸', emoji: '🥖' });
        expect(out[1].emoji).toBe('🙂');
    });

    it('parseRolledNpcs：裸數組也能解析，解析失敗返回空', () => {
        expect(parseRolledNpcs('[{"name":"阿福","persona":"門衛"}]')).toHaveLength(1);
        expect(parseRolledNpcs('不是 JSON')).toEqual([]);
    });
});

describe('關係看法（label）可變 + 敘述人稱', () => {
    const char = mkChar('a', '小滿');
    const members = ['小滿', '阿嵐'];

    it('parseCharBeat：重大轉折時解析 relabel → newLabel', () => {
        const raw = JSON.stringify({
            location: '鎮上', narrative: 'x', mood: 'y',
            relationships: [{ with: '阿嵐', delta: 3, reason: '一起扛過事', relabel: '不打不相識的損友' }],
        });
        const beat = parseCharBeat(raw, char, members);
        expect(beat.relationshipDeltas?.[0]).toMatchObject({ withName: '阿嵐', delta: 3, newLabel: '不打不相識的損友' });
    });

    it('parseCharBeat：沒給 relabel 時 newLabel 為 undefined', () => {
        const raw = JSON.stringify({ location: 'x', narrative: 'x', mood: 'y', relationships: [{ with: '阿嵐', delta: 1 }] });
        const beat = parseCharBeat(raw, char, members);
        expect(beat.relationshipDeltas?.[0].newLabel).toBeUndefined();
    });

    it('narrationPersonGuide：隨設置切換第一/二/三人稱', () => {
        expect(narrationPersonGuide({ narrationPerson: 'first' } as any, '小滿')).toContain('第一人稱');
        expect(narrationPersonGuide({ narrationPerson: 'second' } as any, '小滿')).toContain('第二人稱');
        expect(narrationPersonGuide({ narrationPerson: 'third' } as any, '小滿')).toContain('第三人稱');
        expect(narrationPersonGuide({} as any, '小滿')).toContain('第一人稱'); // 默認
    });
});

describe('真實時間（跟現實早/中/晚/凌晨同步，錯過當天可補、隔天不補）', () => {
    const at = (s: string) => new Date(s);

    it('realNowSeg：按小時分早/中/晚/凌晨（0~5點=凌晨，歸屬前一天的劇情日）', () => {
        expect(realNowSeg(at('2026-06-15T08:00:00')).seg).toBe(0); // 早
        expect(realNowSeg(at('2026-06-15T13:00:00')).seg).toBe(1); // 中
        expect(realNowSeg(at('2026-06-15T20:00:00')).seg).toBe(2); // 晚
        expect(realNowSeg(at('2026-06-15T13:00:00')).dayKey).toBe('2026-06-15');
        // 6月15日凌晨2點 = 6月14日這個劇情日的下半夜（seg=3），保證段序單調
        expect(realNowSeg(at('2026-06-15T02:00:00'))).toEqual({ dayKey: '2026-06-14', seg: 3 });
        expect(realNowSeg(at('2026-06-01T01:00:00'))).toEqual({ dayKey: '2026-05-31', seg: 3 }); // 跨月
    });

    it('formatRealClock：凌晨顯示次日日期', () => {
        expect(formatRealClock({ dayKey: '2026-06-15', seg: 2 })).toBe('2026年6月15日 週一 晚上');
        expect(formatRealClock({ dayKey: '2026-06-15', seg: 3 })).toBe('2026年6月16日 週二 凌晨');
    });

    it('沒演過 → 演當前這一段（凌晨也一樣）', () => {
        expect(realObserveTarget(mkWorld({ timeMode: 'real' }), at('2026-06-15T13:00:00'))).toEqual({ dayKey: '2026-06-15', seg: 1 });
        expect(realObserveTarget(mkWorld({ timeMode: 'real' }), at('2026-06-15T02:00:00'))).toEqual({ dayKey: '2026-06-14', seg: 3 });
    });

    it('同一天落後 → 補下一段；已追上 → null', () => {
        const w = mkWorld({ timeMode: 'real', realClock: { dayKey: '2026-06-15', seg: 0 } });
        expect(realObserveTarget(w, at('2026-06-15T20:00:00'))).toEqual({ dayKey: '2026-06-15', seg: 1 }); // 只補一段
        expect(realObserveTarget(mkWorld({ timeMode: 'real', realClock: { dayKey: '2026-06-15', seg: 2 } }), at('2026-06-15T20:00:00'))).toBeNull();
    });

    it('凌晨接在晚上後面：演過晚上、熬到下半夜 → 補凌晨；演過凌晨 → 追平', () => {
        const w = mkWorld({ timeMode: 'real', realClock: { dayKey: '2026-06-15', seg: 2 } });
        expect(realObserveTarget(w, at('2026-06-16T01:30:00'))).toEqual({ dayKey: '2026-06-15', seg: 3 });
        const w2 = mkWorld({ timeMode: 'real', realClock: { dayKey: '2026-06-15', seg: 3 } });
        expect(realObserveTarget(w2, at('2026-06-16T03:00:00'))).toBeNull(); // 已追上
        expect(realObserveTarget(w2, at('2026-06-16T08:00:00'))).toEqual({ dayKey: '2026-06-16', seg: 0 }); // 天亮進新一天
    });

    it('隔天沒補的丟掉 → 直接跳到今天最早一段', () => {
        const w = mkWorld({ timeMode: 'real', realClock: { dayKey: '2026-06-13', seg: 1 } });
        expect(realObserveTarget(w, at('2026-06-15T20:00:00'))).toEqual({ dayKey: '2026-06-15', seg: 0 });
    });

    it('worldTimeLabel：real 模式顯示已演到的現實段', () => {
        const w = mkWorld({ timeMode: 'real', realClock: { dayKey: '2026-06-15', seg: 2 } });
        expect(worldTimeLabel(w)).toContain('2026年6月15日');
        expect(worldTimeLabel(w)).toContain('晚上');
    });

    it('世界時區決定當前牆上時間與觀測段', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-06-11T00:30:00.000Z'));
            const w = mkWorld({ timeMode: 'real', timezone: 'Asia/Tokyo' });
            const now = worldNow(w);
            expect([now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()])
                .toEqual([2026, 6, 11, 9, 30]);
            expect(realObserveTarget(w)).toEqual({ dayKey: '2026-06-11', seg: 0 });
            expect(worldTzLabel(w)).toContain('東京');
        } finally {
            vi.useRealTimers();
        }
    });

    it('往西切時區會把未來的 realClock 壓回世界當下', () => {
        const w = mkWorld({
            timeMode: 'real',
            timezone: 'America/Los_Angeles',
            realClock: { dayKey: '2026-06-11', seg: 2 },
        });
        const losAngelesNow = worldNow(w, new Date('2026-06-11T12:00:00.000Z')); // 當地 05:00
        expect(clampRealClockToNow(w, losAngelesNow)).toBe(true);
        expect(w.realClock).toEqual({ dayKey: '2026-06-11', seg: 0 });
        expect(clampRealClockToNow(w, losAngelesNow)).toBe(false);
    });

    it('real 世界用世界時區覆蓋角色時區，sim 世界保留角色設置', () => {
        const char = { ...mkChar('a', '阿嵐'), customTimezoneEnabled: true, customTimezone: 'Asia/Tokyo' };
        const aligned = alignCharToWorldClock(
            mkWorld({ timeMode: 'real', timezone: 'America/Los_Angeles' }),
            char,
        );
        expect(aligned).not.toBe(char);
        expect(aligned.customTimezoneEnabled).toBe(true);
        expect(aligned.customTimezone).toBe('America/Los_Angeles');
        expect(char.customTimezone).toBe('Asia/Tokyo'); // 不汙染角色卡

        const followingDevice = alignCharToWorldClock(mkWorld({ timeMode: 'real' }), char);
        expect(followingDevice.customTimezoneEnabled).toBe(false);
        expect(followingDevice.customTimezone).toBe('');
        expect(alignCharToWorldClock(mkWorld({ timeMode: 'sim' }), char)).toBe(char);
    });
});

describe('buildModeRule（三檔 user 存在感）', () => {
    it('輕度：user 依舊是最重要的人', () => {
        expect(buildModeRule('light', '阿月')).toContain('最重要的人');
    });
    it('中度：user 是普通一員', () => {
        expect(buildModeRule('medium', '阿月')).toContain('普通一員');
    });
    it('重度：user 不存在，禁止提及', () => {
        const rule = buildModeRule('heavy', '阿月');
        expect(rule).toContain('不存在');
        expect(rule).toContain('絕對不要提及');
    });
});

describe('buildWorldCharTurn', () => {
    it('傳遞路徑：公開行程可見，瞞下的行程/正文/心情不外洩', () => {
        const world = mkWorld();
        const members = [mkChar('a', '小滿'), mkChar('b', '阿嵐')];
        const turn = buildWorldCharTurn({
            world, char: members[1], members, storyTime: '第1天白天', round: 1,
            beatsSoFar: [{
                charId: 'a', charName: '小滿', location: '鎮上', narrative: '她在酒吧後巷哭了一場。', mood: '低落',
                timeline: [
                    { time: '9:00', place: '畫室', event: '畫了一上午', shared: true },
                    { time: '11:30', place: '酒吧', event: '偷偷去喝了一杯', shared: false },
                ],
            }],
            userName: '阿月',
        });
        // 傳遞路徑：公開行程可見；瞞下的行程、narrative、mood 都不可見
        expect(turn).toContain('9:00 在畫室：畫了一上午');
        expect(turn).not.toContain('酒吧');
        expect(turn).not.toContain('哭了一場');
        expect(turn).not.toContain('低落');
    });

    it('當面對話完整傳給對話對象，公開動態全員可見', () => {
        const world = mkWorld({ houses: [{ id: 'h1', name: '合租屋', residentIds: ['a', 'b'] }] });
        const members = [mkChar('a', '小滿'), mkChar('b', '阿嵐')];
        const turn = buildWorldCharTurn({
            world, char: members[1], members, storyTime: '第1天白天', round: 1,
            beatsSoFar: [{
                charId: 'a', charName: '小滿', location: '合租屋的廚房', narrative: 'x', mood: 'y',
                dialogues: [{ with: '阿嵐', lines: ['湯好了，趁熱'] }],
            }],
            recentPosts: [{ name: '小滿', post: '今天的湯格外香' }],
            userName: '',
        });
        expect(turn).toContain('當面對你說');
        expect(turn).toContain('「湯好了，趁熱」');
        expect(turn).toContain('小滿：今天的湯格外香'); // 社交媒體公開
    });

    it('伏筆爆發與用戶心聲注入', () => {
        const world = mkWorld();
        const members = [mkChar('a', '小滿'), mkChar('b', '阿嵐')];
        const turn = buildWorldCharTurn({
            world, char: members[1], members, storyTime: '第2天白天', round: 3, beatsSoFar: [],
            exposures: ['你發現/聽說了 小滿 一直瞞著的事：偷偷去了酒吧。'],
            directive: { impulseText: '想辭職去學烘焙', text: '去吧，我支持你' },
            userName: '阿月',
        });
        expect(turn).toContain('繞不開的事');
        expect(turn).toContain('偷偷去了酒吧');
        expect(turn).toContain('心裡的聲音');
        expect(turn).toContain('去吧，我支持你');
        expect(turn).toContain('阿月'); // light 模式：聯想到 user
    });

    it('手機段：先演繹角色剛發的私聊/群聊出現在後演繹角色的上下文裡，標【剛剛】', () => {
        const world = mkWorld();
        const members = [mkChar('a', '小滿'), mkChar('b', '阿嵐')];
        applyBeatToThreads(world, {
            charId: 'a', charName: '小滿', location: 'x', narrative: 'y', mood: 'z',
            phone: { dms: [{ to: '阿嵐', lines: ['睡了嗎'] }], group: ['今晚月色不錯'] },
        }, members, 3, '第2天白天');
        const turn = buildWorldCharTurn({ world, char: members[1], members, storyTime: '第2天白天', round: 3, beatsSoFar: [], userName: '' });
        expect(turn).toContain('與 小滿 的私聊');
        expect(turn).toContain('【剛剛】 小滿：睡了嗎');
        expect(turn).toContain('【剛剛】 小滿：今晚月色不錯');
    });

    it('關係有向：自己的視角帶數值，對方對自己只有模糊體感（不洩露數值與關係名）', () => {
        const world = mkWorld({
            relationships: [
                { fromId: 'a', toId: 'b', label: '單戀', value: 85 },
                { fromId: 'b', toId: 'a', label: '普通同事', value: 30 },
            ],
        });
        const members = [mkChar('a', '小滿'), mkChar('b', '阿嵐')];
        const turn = buildWorldCharTurn({ world, char: members[0], members, storyTime: '第1天白天', round: 1, beatsSoFar: [], userName: '' });
        expect(turn).toContain('你對 阿嵐');
        expect(turn).toContain('「單戀」');        // 理智上的標籤
        expect(turn).toContain('好感 85（親密無間）'); // 自己的好感數值 + 檔位
        expect(turn).toContain('你能隱約感覺到 阿嵐 對你的態度：有好感'); // 對方 30 → 有好感（只給檔位）
        expect(turn).not.toContain('好感 30');    // 對方的數值是對方的內心，不洩露
        expect(turn).not.toContain('普通同事');   // 對方眼中的關係名同理
    });

    it('凌晨輪注入「深夜更衝動感性」段落，timeline 約束改為 0~5 點', () => {
        const world = mkWorld();
        const members = [mkChar('a', '小滿'), mkChar('b', '阿嵐')];
        const turn = buildWorldCharTurn({ world, char: members[0], members, storyTime: '第2天凌晨', round: 4, beatsSoFar: [], userName: '' });
        expect(turn).toContain('此刻是凌晨');
        expect(turn).toContain('更**衝動、更感性**');
        expect(turn).toContain('凌晨0點到5點');
        // 白天輪不帶凌晨段落
        const dayTurn = buildWorldCharTurn({ world, char: members[0], members, storyTime: '第1天早上', round: 1, beatsSoFar: [], userName: '' });
        expect(dayTurn).not.toContain('此刻是凌晨');
        expect(dayTurn).toContain('清晨到上午');
    });

    it('NPC 世界引擎的凌晨輪帶「鎮子睡著了」的深夜基調', () => {
        const world = mkWorld({ npcs: [{ id: 'n1', name: '老闆娘', persona: '麵包店' }] });
        const members = [mkChar('a', '小滿')];
        const night = buildNpcTurn({ world, members, storyTime: '第2天凌晨' });
        expect(night).toContain('現在是凌晨');
        expect(night).toContain('鎮子基本睡著了');
        const day = buildNpcTurn({ world, members, storyTime: '第1天早上' });
        expect(day).not.toContain('鎮子基本睡著了');
    });

    it('獨居與同居安排都體現在 prompt 裡', () => {
        const world = mkWorld({ houses: [{ id: 'h1', name: '合租屋', residentIds: ['a', 'b'] }], memberIds: ['a', 'b', 'c'] });
        const members = [mkChar('a', '小滿'), mkChar('b', '阿嵐'), mkChar('c', '十一')];
        const turn = buildWorldCharTurn({ world, char: members[0], members, storyTime: '第1天白天', round: 1, beatsSoFar: [], userName: '' });
        expect(turn).toContain('合租屋：小滿、阿嵐 同住');
        expect(turn).toContain('十一 獨居');
    });
});

describe('世界消息線程（交替傳遞）', () => {
    const members = [{ id: 'a', name: '小滿' }, { id: 'b', name: '阿嵐' }];

    it('A 發的私聊與 B 的回覆進同一條 dm 線程，按時間交替', () => {
        const world = mkWorld();
        applyBeatToThreads(world, { charId: 'a', charName: '小滿', location: 'x', narrative: 'y', mood: 'z', phone: { dms: [{ to: '阿嵐', lines: ['在嗎', '想你了'] }] } }, members, 1, '第1天白天');
        applyBeatToThreads(world, { charId: 'b', charName: '阿嵐', location: 'x', narrative: 'y', mood: 'z', phone: { dms: [{ to: '小滿', lines: ['剛看到，怎麼啦'] }] } }, members, 1, '第1天白天');
        const threads = dmThreadsOf(world, 'a');
        expect(threads).toHaveLength(1);
        expect(threads[0].id).toBe(dmThreadId('a', 'b'));
        expect(threads[0].messages.map(m => `${m.fromName}:${m.text}`)).toEqual([
            '小滿:在嗎', '小滿:想你了', '阿嵐:剛看到，怎麼啦',
        ]);
        // B 的視角是同一條線程
        expect(dmThreadsOf(world, 'b')[0].id).toBe(threads[0].id);
    });

    it('群聊：成員發言與 NPC 冒泡都進 group_main，NPC 名字必須真實存在', () => {
        const world = mkWorld({ npcs: [{ id: 'n1', name: '老闆娘', persona: '麵包店' }] });
        ensureThreads(world);
        applyNpcGroupLines(world, [{ name: '老闆娘', line: '新出爐的栗子包！' }, { name: '不存在的人', line: 'x' }], 1, '第1天白天');
        applyBeatToThreads(world, { charId: 'a', charName: '小滿', location: 'x', narrative: 'y', mood: 'z', phone: { group: ['衝了'] } }, members, 1, '第1天白天');
        const group = groupThreadOf(world)!;
        expect(group.id).toBe(GROUP_THREAD_ID);
        expect(group.messages.map(m => m.fromName)).toEqual(['老闆娘', '小滿']);
    });

    it('群聊/私聊去重：同一發送者把上一輪的話原樣再發一遍會被丟掉（只差空白也算）', () => {
        const world = mkWorld({ npcs: [{ id: 'n1', name: '老闆娘', persona: '麵包店' }] });
        ensureThreads(world);
        // 第1輪：小滿在群裡說「今天天氣真好」
        applyBeatToThreads(world, { charId: 'a', charName: '小滿', location: 'x', narrative: 'y', mood: 'z', phone: { group: ['今天天氣真好'] } }, members, 1, '第1天白天');
        // 第2輪：小滿又把同一句（只差空白）原樣發一遍 → 丟棄；NPC 重複冒泡同句也丟
        applyBeatToThreads(world, { charId: 'a', charName: '小滿', location: 'x', narrative: 'y', mood: 'z', phone: { group: [' 今天天氣真好 ', '換個新話題'] } }, members, 2, '第1天夜晚');
        applyNpcGroupLines(world, [{ name: '老闆娘', line: '新出爐的栗子包！' }, { name: '老闆娘', line: '新出爐的栗子包！' }], 2, '第1天夜晚');
        const group = groupThreadOf(world)!;
        expect(group.messages.map(m => m.text)).toEqual(['今天天氣真好', '換個新話題', '新出爐的栗子包！']);
    });

    it('formatThreadForPrompt：本輪消息標【剛剛】，歷史消息標劇情時間', () => {
        const world = mkWorld();
        applyBeatToThreads(world, { charId: 'a', charName: '小滿', location: 'x', narrative: 'y', mood: 'z', phone: { dms: [{ to: '阿嵐', lines: ['老消息'] }] } }, members, 1, '第1天白天');
        applyBeatToThreads(world, { charId: 'a', charName: '小滿', location: 'x', narrative: 'y', mood: 'z', phone: { dms: [{ to: '阿嵐', lines: ['新消息'] }] } }, members, 2, '第1天夜晚');
        const text = formatThreadForPrompt(dmThreadsOf(world, 'b')[0], 'b', 10, 2);
        expect(text).toContain('[第1天白天] 小滿：老消息');
        expect(text).toContain('【剛剛】 小滿：新消息');
    });
});

describe('NPC 私聊（角色發、NPC 那一輪統一回復）', () => {
    const members = [{ id: 'a', name: '小滿' }];

    it('parseCharBeat：可以給 NPC 發私信（to=NPC名也保留）', () => {
        const raw = JSON.stringify({ location: 'x', narrative: 'x', mood: 'y', phone: { dms: [{ to: '老闆娘', lines: ['今天還有栗子包嗎'] }] } });
        const beat = parseCharBeat(raw, mkChar('a', '小滿'), ['小滿'], ['老闆娘']);
        expect(beat.phone?.dms?.[0]).toEqual({ to: '老闆娘', lines: ['今天還有栗子包嗎'] });
    });

    it('applyBeatToThreads：角色→NPC 私信落進 char↔npc 線程；npcInboxes 能撈到待回', () => {
        const world = mkWorld({ npcs: [{ id: 'n1', name: '老闆娘', persona: '麵包店' }] });
        applyBeatToThreads(world, { charId: 'a', charName: '小滿', location: 'x', narrative: 'y', mood: 'z', phone: { dms: [{ to: '老闆娘', lines: ['還有栗子包嗎'] }] } }, members, 1, '第1天早上');
        const tid = dmThreadId('a', 'n1');
        expect(dmThreadsOf(world, 'a').some(t => t.id === tid)).toBe(true);
        const inbox = npcInboxes(world);
        expect(inbox).toHaveLength(1);
        expect(inbox[0]).toMatchObject({ npcName: '老闆娘', memberName: '小滿' });
    });

    it('applyNpcDms：NPC 回覆後該線程不再算待回', () => {
        const world = mkWorld({ npcs: [{ id: 'n1', name: '老闆娘', persona: '麵包店' }] });
        applyBeatToThreads(world, { charId: 'a', charName: '小滿', location: 'x', narrative: 'y', mood: 'z', phone: { dms: [{ to: '老闆娘', lines: ['還有栗子包嗎'] }] } }, members, 1, '第1天早上');
        applyNpcDms(world, [{ from: '老闆娘', to: '小滿', lines: ['剛出爐，給你留倆'] }], members, 1, '第1天早上');
        expect(npcInboxes(world)).toHaveLength(0);
        const thread = dmThreadsOf(world, 'a').find(t => t.id === dmThreadId('a', 'n1'))!;
        expect(thread.messages.map(m => `${m.fromName}:${m.text}`)).toEqual(['小滿:還有栗子包嗎', '老闆娘:剛出爐，給你留倆']);
    });

    it('parseNpcScene：解析 NPC 私信回覆', () => {
        const out = parseNpcScene('```json\n{"scene":"x","hooks":[],"groupLines":[],"dms":[{"from":"老闆娘","to":"小滿","lines":["給你留倆"]}]}\n```');
        expect(out.dms).toEqual([{ from: '老闆娘', to: '小滿', lines: ['給你留倆'] }]);
    });

    it('parseNpcScene：解析動態點贊/評論（NPC+路人），likes 鉗整數', () => {
        const out = parseNpcScene('```json\n{"scene":"x","feedReactions":[{"ref":"3_a_0","likes":"12","comments":[{"from":"街角咖啡師","text":"好可愛！"},{"from":"路人乙"}]}]}\n```');
        expect(out.feedReactions).toHaveLength(1);
        expect(out.feedReactions[0]).toMatchObject({ ref: '3_a_0', likes: 12 });
        expect(out.feedReactions[0].comments).toEqual([{ from: '街角咖啡師', text: '好可愛！' }]); // 無 text 的被過濾
    });
});

describe('applyRelationshipDeltas（有向回填）', () => {
    const members = [{ id: 'a', name: '小滿' }, { id: 'b', name: '阿嵐' }];

    it('只改"該角色→對方"這條邊，反向不動', () => {
        const world = mkWorld({
            relationships: [
                { fromId: 'a', toId: 'b', value: 60 },
                { fromId: 'b', toId: 'a', value: 20 },
            ],
        });
        applyRelationshipDeltas(world, [
            { charId: 'a', charName: '小滿', location: 'x', narrative: 'y', mood: 'z', relationshipDeltas: [{ withName: '阿嵐', delta: 3 }] },
        ], members);
        expect(world.relationships.find(r => r.fromId === 'a' && r.toId === 'b')!.value).toBe(63);
        expect(world.relationships.find(r => r.fromId === 'b' && r.toId === 'a')!.value).toBe(20);
    });

    it('不存在的邊按 0（陌生中立）起步，數值鉗在 -100~100（可為負）', () => {
        const world = mkWorld({ relationships: [{ fromId: 'a', toId: 'b', value: 99 }] });
        applyRelationshipDeltas(world, [
            { charId: 'a', charName: '小滿', location: 'x', narrative: 'y', mood: 'z', relationshipDeltas: [{ withName: '阿嵐', delta: 4 }] },
            { charId: 'b', charName: '阿嵐', location: 'x', narrative: 'y', mood: 'z', relationshipDeltas: [{ withName: '小滿', delta: -4 }] },
        ], members);
        expect(world.relationships.find(r => r.fromId === 'a' && r.toId === 'b')!.value).toBe(100); // 99+4 鉗到 100
        expect(world.relationships.find(r => r.fromId === 'b' && r.toId === 'a')!.value).toBe(-4);  // 新邊 0 起步 −4 → 負數
    });
});

describe('伏筆與摘要防洩密', () => {
    it('collectSeeds：顯式 secrets + timeline 未聲張條目自動補伏筆，不重複', () => {
        const world = mkWorld();
        collectSeeds(world, {
            charId: 'b', charName: '阿嵐', location: 'x', narrative: 'y', mood: 'z',
            timeline: [
                { time: '9:00', place: '圖書館', event: '看書', shared: true },
                { time: '22:00', place: '酒吧', event: '偷偷去喝了一杯', shared: false },
                { time: '23:30', place: '河邊', event: '一個人坐了很久', shared: false },
            ],
            secrets: [{ text: '偷偷去喝了一杯', hideFrom: ['小滿'] }],
        }, 2, '第1天夜晚');
        const seeds = world.seeds!;
        // 顯式 secret 1 條 + timeline 自動補 1 條（河邊；酒吧已被 secrets 覆蓋不重複）
        expect(seeds).toHaveLength(2);
        expect(seeds[0]).toMatchObject({ charName: '阿嵐', text: '偷偷去喝了一杯', hideFrom: ['小滿'], status: 'pending' });
        expect(seeds[1].text).toContain('河邊');
        expect(seeds[1].hideFrom).toEqual([]);
    });

    it('buildSummary 只用公開信息：瞞下的事和正文絕不進全員可見的摘要', () => {
        const summary = buildSummary('第1天夜晚', [{
            charId: 'b', charName: '阿嵐', location: '鎮上', narrative: '她在酒吧後巷給前任打了電話。', mood: '崩潰',
            timeline: [
                { time: '20:00', place: '餐廳', event: '和同事聚餐', shared: true },
                { time: '22:00', place: '酒吧', event: '偷偷去喝了一杯', shared: false },
            ],
        }], []);
        expect(summary).toContain('和同事聚餐');
        expect(summary).not.toContain('酒吧');
        expect(summary).not.toContain('前任');
        expect(summary).not.toContain('崩潰');
    });
});

describe('動態去重 dropDuplicatePosts', () => {
    it('剔除和最近動態重複的 post（含只差空白/換行的）', () => {
        const beat: any = {
            charId: 'b', charName: '阿嵐', location: 'x', narrative: 'y', mood: 'z',
            phone: { posts: ['有些東西揣在懷裡沉甸甸的', '今天陽光真好', ' 今天陽光真好 '] },
        };
        dropDuplicatePosts(beat, [{ post: '有些東西揣在懷裡沉甸甸的' }]);
        // 與最近動態重複的第一條被剔除；本拍內只差空白的重複也只留一條
        expect(beat.phone.posts).toEqual(['今天陽光真好']);
    });

    it('沒有重複時原樣保留；空白條目被剔除', () => {
        const beat: any = { charId: 'b', charName: '阿嵐', location: 'x', narrative: 'y', mood: 'z', phone: { posts: ['全新的一條', '   '] } };
        dropDuplicatePosts(beat, [{ post: '別的內容' }]);
        expect(beat.phone.posts).toEqual(['全新的一條']);
    });
});

describe('WorldScheduler', () => {
    beforeEach(() => {
        localStorage.removeItem('world_tick_slots');
        localStorage.removeItem('world_tick_fired');
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        WorldScheduler.onTrigger(() => {});
    });

    it('reconcile：今天已過去的時段視為已耗盡，不補火（防止配置完瞬間連燒）', () => {
        vi.setSystemTime(new Date('2026-06-11T15:00:00')); // 15點：凌晨/早/午已過
        const fired: string[] = [];
        WorldScheduler.onTrigger((id) => { fired.push(id); });
        WorldScheduler.reconcile([{ worldId: 'w1', slots: ['latenight', 'morning', 'noon', 'evening'] }]);
        const rec = JSON.parse(localStorage.getItem('world_tick_fired')!).w1;
        expect(rec.fired).toEqual(['latenight', 'morning', 'noon']);
        expect(fired).toEqual([]); // 不立即觸發
    });

    it('latenight 時段：凌晨 2 點後起火', () => {
        vi.setSystemTime(new Date('2026-06-11T01:00:00'));
        const fired: string[] = [];
        WorldScheduler.onTrigger((id, trigger) => { fired.push(`${id}:${trigger}`); });
        WorldScheduler.reconcile([{ worldId: 'w1', slots: ['latenight'] }]);
        vi.advanceTimersByTime(61_000); // 1點多：還沒到
        expect(fired).toEqual([]);
        vi.setSystemTime(new Date('2026-06-11T02:30:00'));
        vi.advanceTimersByTime(61_000);
        expect(fired).toEqual(['w1:tick']);
    });

    it('到點觸發當天未跑的時段，且每時段一天最多一次', () => {
        vi.setSystemTime(new Date('2026-06-11T08:00:00'));
        const fired: string[] = [];
        WorldScheduler.onTrigger((id, trigger) => { fired.push(`${id}:${trigger}`); });
        WorldScheduler.reconcile([{ worldId: 'w1', slots: ['morning'] }]);
        expect(fired).toEqual([]);
        vi.setSystemTime(new Date('2026-06-11T09:30:00'));
        vi.advanceTimersByTime(61_000); // 主線程輪詢
        expect(fired).toEqual(['w1:tick']);
        vi.advanceTimersByTime(10 * 61_000); // 同一天不再重複
        expect(fired).toEqual(['w1:tick']);
    });

    it('跨天后時段配額重置', () => {
        vi.setSystemTime(new Date('2026-06-11T10:00:00'));
        const fired: string[] = [];
        WorldScheduler.onTrigger(() => { fired.push('x'); });
        WorldScheduler.reconcile([{ worldId: 'w1', slots: ['morning'] }]); // 10點：morning 已耗盡
        vi.advanceTimersByTime(61_000);
        expect(fired).toHaveLength(0);
        vi.setSystemTime(new Date('2026-06-12T09:30:00')); // 第二天早上
        vi.advanceTimersByTime(61_000);
        expect(fired).toHaveLength(1);
    });

    it('移除世界後清掉殘留', () => {
        WorldScheduler.reconcile([{ worldId: 'w1', slots: ['evening'] }]);
        expect(JSON.parse(localStorage.getItem('world_tick_slots')!).w1).toBeTruthy();
        WorldScheduler.reconcile([]);
        expect(localStorage.getItem('world_tick_slots')).toBeNull();
    });

    it('每個世界按自己的時區計算日期和已耗盡時段', () => {
        vi.setSystemTime(new Date('2026-06-11T00:30:00.000Z'));
        WorldScheduler.reconcile([
            { worldId: 'tokyo', slots: ['noon'], tz: 'Asia/Tokyo' },
            { worldId: 'los-angeles', slots: ['noon'], tz: 'America/Los_Angeles' },
        ]);
        const fired = JSON.parse(localStorage.getItem('world_tick_fired')!);
        expect(fired.tokyo).toEqual({ date: '2026-06-11', fired: [] }); // 東京 09:30
        expect(fired['los-angeles']).toEqual({ date: '2026-06-10', fired: ['noon'] }); // 洛杉磯 17:30
    });

    it('兼容舊版 slot[] 存儲格式', () => {
        vi.setSystemTime(new Date(2026, 5, 11, 9, 30));
        localStorage.setItem('world_tick_slots', JSON.stringify({ legacy: ['morning'] }));
        localStorage.setItem('world_tick_fired', JSON.stringify({
            legacy: { date: '2026-06-11', fired: [] },
        }));
        const fired: string[] = [];
        WorldScheduler.onTrigger((id) => { fired.push(id); });
        expect(fired).toEqual(['legacy']);
    });

    it('同一日內換時區會重算配額，未來時段仍能在新時區觸發', () => {
        vi.setSystemTime(new Date('2026-06-11T12:00:00.000Z')); // 東京 21:00，洛杉磯 05:00
        const fired: string[] = [];
        WorldScheduler.onTrigger((id) => { fired.push(id); });
        WorldScheduler.reconcile([{ worldId: 'w1', slots: ['evening'], tz: 'Asia/Tokyo' }]);
        expect(JSON.parse(localStorage.getItem('world_tick_fired')!).w1.fired).toEqual(['evening']);

        WorldScheduler.reconcile([{ worldId: 'w1', slots: ['evening'], tz: 'America/Los_Angeles' }]);
        expect(JSON.parse(localStorage.getItem('world_tick_fired')!).w1.fired).toEqual([]);

        vi.setSystemTime(new Date('2026-06-12T04:30:00.000Z')); // 洛杉磯仍是 6/11，21:30
        vi.advanceTimersByTime(61_000);
        expect(fired).toEqual(['w1']);
    });
});
