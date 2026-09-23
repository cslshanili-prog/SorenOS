import { describe, it, expect } from 'vitest';
import { renderFireSceneBlock, resolveFireSceneSong, type AmsgFireScene } from './amsgFireScene';
import type { RenderableSchedule } from './scheduleInjection';

// 迴歸守衛：角色的「當前時段」和由它推出來的「此刻在聽的歌」以前是跟著角色設定一起
// 烤進 fire_pack 模板的——說的是打包那一刻的事。凌晨三點觸發時，角色會照著中午打的包
// 說「我在健身房呢，今天多跑了兩公里」。
//
// 現在這兩塊隨包只帶原始素材（整天的作息表 + 歌單抽樣池），worker 到點按角色時區現挑。
// 下面每條都對著一種「烤死」會露出來的樣子。

const schedule: RenderableSchedule = {
    slots: [
        { startTime: '08:00', activity: '起床做早飯' },
        { startTime: '14:00', activity: '跑步', location: '健身房' },
        { startTime: '22:00', activity: '戴著耳機癱在沙發上', innerThought: '今天有點累' },
    ],
};

const songs = [
    { id: 1, name: '夜航星', artists: '某某' },
    { id: 2, name: '海底', artists: '另一位' },
];

const scene: AmsgFireScene = { charId: 'char-1', dateKey: '2026-08-02', schedule, songPool: songs };

/** 2026-08-02 的某個上海時刻（上海 = UTC+8，無夏令時）。 */
const shanghaiAt = (hour: number, minute = 0) =>
    Date.UTC(2026, 7, 2, hour - 8, minute);

describe('renderFireSceneBlock — 到點現挑時段', () => {
    it('同一份作息表，不同觸發時刻挑出不同時段', () => {
        const noon = renderFireSceneBlock(scene, shanghaiAt(14, 30), { tzId: 'Asia/Shanghai' });
        expect(noon).toContain('當前時段：14:00 你正在跑步（健身房）');
        expect(noon).toContain('之後安排：22:00 戴著耳機癱在沙發上');

        const lateNight = renderFireSceneBlock(scene, shanghaiAt(23, 10), { tzId: 'Asia/Shanghai' });
        expect(lateNight).toContain('當前時段：22:00 你正在戴著耳機癱在沙發上');
        expect(lateNight).not.toContain('跑步');
        expect(lateNight).not.toContain('健身房');
    });

    it('按角色時區讀表，不吃 worker 自己的 UTC', () => {
        // 同一個絕對時刻：上海是下午 14:30，紐約是凌晨 02:30（當天第一條 08:00 還沒到）。
        // 時區吃錯的話，紐約角色會在凌晨兩點半說自己正在健身房跑步。
        const at = shanghaiAt(14, 30);
        expect(renderFireSceneBlock(scene, at, { tzId: 'Asia/Shanghai' })).toContain('14:00 你正在跑步');
        const ny = renderFireSceneBlock(scene, at, { tzId: 'America/New_York' });
        // 這條釘的是「挑中哪一條」，不是那句引子怎麼寫（凌晨那檔的措辭由 scheduleInjection 定）。
        expect(ny).toContain('起床做早飯（08:00）');
        expect(ny).not.toContain('跑步');
    });

    it('今天第一條還沒到點 → 說「稍後先」，不硬安一個當前時段', () => {
        const out = renderFireSceneBlock(scene, shanghaiAt(6), { tzId: 'Asia/Shanghai' });
        expect(out).toContain('今天還沒開始活動，稍後先起床做早飯（08:00）');
        expect(out).not.toContain('當前時段');
    });

    it('時段暗示在聽歌 → 補一句此刻在聽什麼；不暗示的時段不補', () => {
        const listening = renderFireSceneBlock(scene, shanghaiAt(22, 30), { tzId: 'Asia/Shanghai' });
        expect(listening).toMatch(/你此刻在[听聽]：《(夜航星|海底)》/);

        const running = renderFireSceneBlock(scene, shanghaiAt(14, 30), { tzId: 'Asia/Shanghai' });
        expect(running).not.toContain('你此刻在聽');
    });

    it('同一時段內反覆觸發抽到同一首歌（別每條主動消息換一首）', () => {
        const a = renderFireSceneBlock(scene, shanghaiAt(22, 10), { tzId: 'Asia/Shanghai' });
        const b = renderFireSceneBlock(scene, shanghaiAt(23, 50), { tzId: 'Asia/Shanghai' });
        const songOf = (s: string) => s.match(/你此刻在[听聽]：《(.+?)》/)?.[1];
        expect(songOf(a)).toBeTruthy();
        expect(songOf(b)).toBe(songOf(a));
    });

    it('歌單是空的 → 只有日程，不硬編一首歌', () => {
        const out = renderFireSceneBlock({ ...scene, songPool: [] }, shanghaiAt(22, 30), { tzId: 'Asia/Shanghai' });
        expect(out).toContain('22:00 你正在戴著耳機');
        expect(out).not.toContain('你此刻在聽');
    });

    it('沒日程 / 空表 → 空串（槽位被抹平，模板跟沒這回事一樣）', () => {
        expect(renderFireSceneBlock(null, shanghaiAt(14), { tzId: 'Asia/Shanghai' })).toBe('');
        expect(renderFireSceneBlock(
            { ...scene, schedule: { ...schedule, slots: [] } },
            shanghaiAt(14),
            { tzId: 'Asia/Shanghai' },
        )).toBe('');
    });

    // 迴歸守衛：日程表裡只有「幾點做什麼」，沒有日期。週五晚上打的包週日上午觸發時，
    // 光按牆鍾時分照樣挑得出「09:00 晨會」——角色於是在週日說自己正在開週五的會。
    // 到點先比日期，跨天了整段不用（寧缺勿錯，跟「實時世界拉不到就整段消失」同一條線）。
    it('同一天觸發 → 照常渲染', () => {
        const out = renderFireSceneBlock(scene, shanghaiAt(14, 30), { tzId: 'Asia/Shanghai' });
        expect(out).toContain('當前時段：14:00 你正在跑步（健身房）');
    });

    it('跨天觸發 → 整段消失（日程和「此刻在聽」一起走）', () => {
        // 上海 8/4 22:30：按時分挑的話正好落在「戴著耳機癱在沙發上」那一檔，還會帶出一首歌。
        const nextDays = Date.UTC(2026, 7, 4, 22 - 8, 30);
        expect(renderFireSceneBlock(scene, nextDays, { tzId: 'Asia/Shanghai' })).toBe('');
    });

    it('跨天判定按角色時區算，不是 UTC 日曆日', () => {
        // 上海 8/3 00:30（= 8/2 16:30Z）：UTC 還是 8/2，角色那邊已經翻篇了。
        const justAfterMidnight = Date.UTC(2026, 7, 2, 16, 30);
        expect(renderFireSceneBlock(scene, justAfterMidnight, { tzId: 'Asia/Shanghai' })).toBe('');
        // 同一時刻的紐約角色還停在 8/2 12:30，表照用。
        expect(renderFireSceneBlock(
            { ...scene, dateKey: '2026-08-02' },
            justAfterMidnight,
            { tzId: 'America/New_York' },
        )).toContain('當前時段：08:00');
    });

    // 迴歸守衛：`[[MUSIC_ACTION:add|歌單標題]]` 標籤裡只有歌單名，沒有歌名。worker 要把
    // 這次挑中的那首凍進 directive，客戶端重放時才知道正文說的是哪首歌 —— 凍的那首必須
    // 跟 prompt 裡寫的嚴格一致，兩處各挑一次就會出現「正文說 A、卡片是 B」。
    it('挑出來的那首跟 prompt 裡寫的是同一首', () => {
        const at = shanghaiAt(22, 30);
        const song = resolveFireSceneSong(scene, at, { tzId: 'Asia/Shanghai' });
        expect(song).not.toBeNull();
        expect(renderFireSceneBlock(scene, at, { tzId: 'Asia/Shanghai' }))
            .toContain(`你此刻在聽：《${song!.name}》— ${song!.artists}`);
    });

    it('正文裡沒有「你此刻在聽」的場合一律返回 null（別凍一首沒人提過的歌）', () => {
        const tz = { tzId: 'Asia/Shanghai' };
        // 不暗示聽歌的時段
        expect(resolveFireSceneSong(scene, shanghaiAt(14, 30), tz)).toBeNull();
        // 歌單是空的
        expect(resolveFireSceneSong({ ...scene, songPool: [] }, shanghaiAt(22, 30), tz)).toBeNull();
        // 沒日程 / 空表
        expect(resolveFireSceneSong(null, shanghaiAt(22, 30), tz)).toBeNull();
        expect(resolveFireSceneSong(
            { ...scene, schedule: { ...schedule, slots: [] } }, shanghaiAt(22, 30), tz,
        )).toBeNull();
        // 跨天：整段作廢，「此刻在聽」跟著走
        expect(resolveFireSceneSong(scene, Date.UTC(2026, 7, 4, 22 - 8, 30), tz)).toBeNull();
        for (const out of [
            renderFireSceneBlock(scene, shanghaiAt(14, 30), tz),
            renderFireSceneBlock({ ...scene, songPool: [] }, shanghaiAt(22, 30), tz),
        ]) {
            expect(out).not.toContain('你此刻在聽');
        }
    });

    it('同一時段內反覆觸發凍的是同一首（跟 prompt 一樣不跳歌）', () => {
        const tz = { tzId: 'Asia/Shanghai' };
        expect(resolveFireSceneSong(scene, shanghaiAt(23, 50), tz))
            .toEqual(resolveFireSceneSong(scene, shanghaiAt(22, 10), tz));
    });

    it('意識流獨白按觸發時刻的時段取（不是打包時刻那一檔）', () => {
        const withFlow: AmsgFireScene = {
            ...scene,
            schedule: {
                ...schedule,
                flowNarrative: { morning: '早上的念頭', afternoon: '下午的念頭', evening: '晚上的念頭' },
            },
        };
        expect(renderFireSceneBlock(withFlow, shanghaiAt(9), { tzId: 'Asia/Shanghai' })).toContain('早上的念頭');
        expect(renderFireSceneBlock(withFlow, shanghaiAt(21), { tzId: 'Asia/Shanghai' })).toContain('晚上的念頭');
    });
});

// 角色關掉「時間感知」後，前台連「現在幾點」都讀不到，這一段卻照舊寫著
// 「當前時段：22:00 你正在…」——鍾從日程這條縫漏了出去。取值與今日節日同源
// （worker 從 tool_pack.timeAwarenessEnabled 讀），日程內容本身不受影響。
describe('renderFireSceneBlock — 鐘點跟著「時間感知」開關', () => {
    const tz = { tzId: 'Asia/Shanghai' };

    it('默認（不傳）照常報時段，老行為不變', () => {
        const out = renderFireSceneBlock(scene, shanghaiAt(14, 30), tz);
        expect(out).toContain('當前時段：14:00 你正在跑步（健身房）');
    });

    it('includeClock=false 時活動還在、鐘點消失', () => {
        const out = renderFireSceneBlock(scene, shanghaiAt(14, 30), tz, { includeClock: false });
        expect(out).toContain('你正在跑步（健身房）');
        expect(out).toContain('之後安排：戴著耳機癱在沙發上');
        expect(out).not.toContain('14:00');
        expect(out).not.toContain('22:00');
    });

    it('今天第一條還沒到點那句同樣不帶鐘點', () => {
        const out = renderFireSceneBlock(scene, shanghaiAt(6), tz, { includeClock: false });
        expect(out).toContain('稍後先起床做早飯');
        expect(out).not.toContain('08:00');
    });

    it('「此刻在聽什麼」不受影響——那不是鐘點', () => {
        const out = renderFireSceneBlock(scene, shanghaiAt(22, 30), tz, { includeClock: false });
        expect(out).toContain('你此刻在聽');
    });
});

// 到點主動開口的角色最容易撞上「表上寫著睡覺、我卻正在給對方發消息」，所以這條路也要
// 帶上改日程的能力說明——沒有它，角色只能頂著「我在睡覺」硬說。
describe('renderFireSceneBlock — 主動消息也教改日程', () => {
    const tz = { tzId: 'Asia/Shanghai' };

    it('到點渲染時帶上改日程的能力說明', () => {
        const out = renderFireSceneBlock(scene, shanghaiAt(23, 10), tz);
        expect(out).toContain('[[ACTION:CHANGE_SCHEDULE');
        expect(out).toContain('不是必須履行的命令');
    });

    it('示例時段取當前這一條（最後一條日程之後沒有「下一條」）', () => {
        const out = renderFireSceneBlock(scene, shanghaiAt(23, 10), tz);
        expect(out).toContain('[[ACTION:CHANGE_SCHEDULE | 22:00 | 去超市]]');
    });

    it('措辭不提「上表」——主動消息只給當前時段和下一條，沒有完整日程可指', () => {
        const out = renderFireSceneBlock(scene, shanghaiAt(14, 30), tz);
        expect(out).not.toContain('來自上表');
        expect(out).toContain('原樣抄上面出現過的');
    });

    it('關掉鐘點時連這條一起收起來（沒有時段可抄，寫不出指令）', () => {
        const out = renderFireSceneBlock(scene, shanghaiAt(14, 30), tz, { includeClock: false });
        expect(out).not.toContain('CHANGE_SCHEDULE');
    });
});

