// 日程注入文本的迴歸守衛。
//
// 主動消息到點生成跟前台聊天共用 buildScheduleInjection，而主動消息把「凌晨觸發」變成了
// 常態：日程第一條在 07:00，凌晨一點觸發時按「今天剛要開始」寫，角色就會頂著清晨的心境
// 說話。凌晨 0-5 點算前一夜的尾巴，獨白取「晚」檔、措辭也得是夜裡的說法。
import { describe, expect, it } from 'vitest';
import { buildScheduleInjection, getFlowNarrativeKey, type RenderableSchedule } from './scheduleInjection';

const schedule: RenderableSchedule = {
    slots: [
        { startTime: '07:00', activity: '晨跑' },
        { startTime: '13:00', activity: '寫稿' },
        { startTime: '22:00', activity: '看劇' },
    ],
    flowNarrative: {
        morning: '清晨的空氣很好，今天想跑遠一點。',
        afternoon: '稿子卡在第三段。',
        evening: '夜裡安靜下來了，腦子還轉著。',
    },
};

/** 用本地時間構造，getHours() 就是寫死的那個點，不受機器時區影響。 */
const at = (hour: number, minute = 0) => new Date(2026, 7, 2, hour, minute);

describe('凌晨 0-5 點算前一夜的延續', () => {
    it('凌晨一點、今天第一條還沒到 → 獨白取「晚」檔，不是清晨那句', () => {
        const out = buildScheduleInjection(schedule, undefined, at(1));
        expect(out).toContain('夜裡安靜下來了');
        expect(out).not.toContain('清晨的空氣很好');
    });

    it('凌晨的措辭是夜裡的說法，不帶「稍後先」那種白天感', () => {
        const out = buildScheduleInjection(schedule, undefined, at(3, 40));
        expect(out).toContain('夜深了');
        expect(out).not.toContain('稍後先');
        // 最早那件事還是要說清楚，只是換個語氣
        expect(out).toContain('晨跑');
        expect(out).toContain('07:00');
    });

    it('過了 5 點還沒到第一條 → 回到原來的白天措辭與「早」檔獨白', () => {
        const out = buildScheduleInjection(schedule, undefined, at(6));
        expect(out).toContain('今天還沒開始活動，稍後先晨跑（07:00）');
        expect(out).toContain('清晨的空氣很好');
        expect(out).not.toContain('夜深了');
    });

    it('白天正落在某條日程上時一切照舊', () => {
        const out = buildScheduleInjection(schedule, undefined, at(14));
        expect(out).toContain('當前時段：13:00 你正在寫稿');
        expect(out).toContain('之後安排：22:00 看劇');
        expect(out).toContain('稿子卡在第三段');
    });

    it('ChatApp 主請求可注入完整日程，並用一個簡單標籤教角色調整計劃', () => {
        const out = buildScheduleInjection(schedule, undefined, at(14), {
            includeFullDay: true,
            includeChangeInstruction: true,
        });
        expect(out).toContain('你今天的完整日程：');
        expect(out).toContain('- 07:00 晨跑');
        expect(out).toContain('- 13:00 寫稿');
        expect(out).toContain('- 22:00 看劇');
        expect(out).toContain('[[ACTION:CHANGE_SCHEDULE | 22:00 | 去超市]]');
        expect(out).toContain('正在進行的這一條和它之後的都能改，已經過去的不能');
    });
});

// 一天最後一條日程開始之後就沒有「下一條」了，而那條通常是睡覺。以前這個能力說明
// 掛在「有下一條」上，於是最需要「我今晚不睡了」這個出口的時候恰恰不教。
describe('夜裡最後一條日程之後仍然教改日程', () => {
    it('已經落在最後一條上時，示例時段退回當前這一條', () => {
        const out = buildScheduleInjection(schedule, undefined, at(23, 30), {
            includeFullDay: true,
            includeChangeInstruction: true,
        });
        expect(out).toContain('當前時段：22:00 你正在看劇');
        expect(out).toContain('[[ACTION:CHANGE_SCHEDULE | 22:00 | 去超市]]');
    });

    it('說明裡點破「表跟實際對不上就改」，別讓角色把日程當成必須履行的命令', () => {
        const out = buildScheduleInjection(schedule, undefined, at(23, 30), {
            includeChangeInstruction: true,
        });
        expect(out).toContain('不是必須履行的命令');
        expect(out).toContain('改成你實際在做的事');
    });
});

// 「時間感知」關掉的角色不該從日程塊裡讀到精確鐘點——那正是這個開關要擋的東西。
// 日程本身照給：它有自己的總開關。對齊天氣塊 includeTime 的處理。
describe('includeClock=false 時日程不報鐘點', () => {
    const noClock = { includeFullDay: true, includeChangeInstruction: true, includeClock: false };

    it('當前時段與之後安排都只剩活動本身', () => {
        const out = buildScheduleInjection(schedule, undefined, at(14), noClock);
        expect(out).toContain('當前時段：你正在寫稿');
        expect(out).toContain('之後安排：看劇');
        expect(out).not.toContain('13:00');
        expect(out).not.toContain('22:00');
    });

    it('完整日程表保留順序但不帶時刻', () => {
        const out = buildScheduleInjection(schedule, undefined, at(14), noClock);
        expect(out).toContain('- 晨跑');
        expect(out).toContain('- 寫稿');
        expect(out).not.toContain('07:00');
    });

    it('不教改日程——那條指令拿時段當定位符，角色看不到時刻就寫不出來', () => {
        const out = buildScheduleInjection(schedule, undefined, at(14), noClock);
        expect(out).not.toContain('CHANGE_SCHEDULE');
    });

    it('凌晨那句同樣不帶鐘點', () => {
        const out = buildScheduleInjection(schedule, undefined, at(3), noClock);
        expect(out).toContain('夜深了');
        expect(out).toContain('晨跑');
        expect(out).not.toContain('07:00');
    });
});

describe('意識流檔位', () => {
    it('一天三檔的通用取法本身沒變（小劇場、桌面小屋還按它取色）', () => {
        expect(getFlowNarrativeKey(1)).toBe('morning');
        expect(getFlowNarrativeKey(9)).toBe('morning');
        expect(getFlowNarrativeKey(13)).toBe('afternoon');
        expect(getFlowNarrativeKey(21)).toBe('evening');
    });
});

describe('日程不是給對方列的待辦', () => {
    // 病象：用戶隨口說「今天想看書」，之後每一輪結尾都被問「書看到哪了」。日程這條路
    // 走得通——生成側明寫「對話裡提到的事必須嚴格遵循」，意識系那檔還把「惦記對方」
    // 列為推薦動作，對方的計劃因此會滲進 slot 的 description；角色也能用
    // CHANGE_SCHEDULE 往表裡寫任意文本。而這張表每輪全量注入、貼著生成點。
    // 「不是台詞」那句 footnote 只跟著意識流獨白，管不到日程行，所以那兩段一直是裸的。
    const withUserPlan: RenderableSchedule = {
        slots: [
            { startTime: '13:00', activity: '寫稿' },
            { startTime: '20:00', activity: '看書', description: '小明說他今天也想看書，順手翻兩頁' },
        ],
    };
    const SCOPE = '不是給對方列的待辦';

    it('完整日程那份帶上分寸句', () => {
        const out = buildScheduleInjection(withUserPlan, undefined, at(14), { includeFullDay: true });
        expect(out).toContain('小明說他今天也想看書'); // 內容照給，管的是怎麼讀它
        expect(out).toContain(SCOPE);
        expect(out).toContain('不用追著問進展');
    });

    it('沒有意識流獨白時也帶 —— 那句「不是台詞」管的不是這件事', () => {
        const out = buildScheduleInjection(withUserPlan, undefined, at(14), { includeFullDay: true });
        expect(out).not.toContain('不是台詞'); // 這份沒有獨白，footnote 本就不出現
        expect(out).toContain(SCOPE);
    });

    it('主動消息到點那份（不列完整日程）同樣帶', () => {
        const out = buildScheduleInjection(withUserPlan, '腦子裡還轉著那段稿子。', at(14), {
            includeChangeInstruction: true,
        });
        expect(out).toContain('不是台詞');  // 有獨白，footnote 在
        expect(out).toContain(SCOPE);       // 分寸句也在，兩句各管各的
    });

    it('分寸句在塊尾，排在改期教學之後', () => {
        const out = buildScheduleInjection(withUserPlan, undefined, at(14), {
            includeFullDay: true,
            includeChangeInstruction: true,
        });
        expect(out.indexOf(SCOPE)).toBeGreaterThan(out.indexOf('CHANGE_SCHEDULE'));
    });
});
