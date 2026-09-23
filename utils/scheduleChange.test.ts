import { describe, expect, it } from 'vitest';
import type { DailySchedule } from '../types';
import { applyAssistantScheduleChanges, applyScheduleChanges, extractScheduleChangeDirectives } from './scheduleChange';
import { DB } from './db';

const schedule: DailySchedule = {
    id: 'char-1_2026-08-15',
    charId: 'char-1',
    date: '2026-08-15',
    generatedAt: new Date(2026, 7, 15, 8).getTime(),
    slots: [
        { startTime: '08:00', activity: '起床', location: '家' },
        { startTime: '14:00', activity: '寫稿', description: '完成第三章', innerThought: '別再拖稿了' },
        { startTime: '18:30', activity: '健身', location: '健身房', theater: { generatedAt: 1, lines: [{ text: '跑步' }] } },
        { startTime: '22:00', activity: '看電影' },
    ],
    flowNarrative: { afternoon: '晚上還得去健身。' },
};

const at = (hour: number, minute = 0) => new Date(2026, 7, 15, hour, minute);

describe('extractScheduleChangeDirectives', () => {
    it('識別規範格式並把控制標籤從聊天正文隱藏', () => {
        const result = extractScheduleChangeDirectives('那今晚就不練啦。\n[[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]');
        expect(result.cleanedText).toBe('那今晚就不練啦。');
        expect(result.directives).toEqual([{ startTime: '18:30', activity: '去超市' }]);
        expect(result.malformedCount).toBe(0);
    });

    it.each([
        '【【修改日程：18:30：去超市】】',
        '[[change schedule: (18:30): 去超市]]',
        '【change schedue：（18：30）：去超市】',
        '【【修改日程：18點30分：去超市】】',
        'change_schedule：18時30分：去超市',
        '[[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]',
        '[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]',
        '[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]',
        '[[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市',
        'ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]',
        'ACTION:CHANGE_SCHEDULE | 18:30 | 去超市',
    ])('容錯括號、標點、中文別名與 schedue 拼寫：%s', (raw) => {
        const result = extractScheduleChangeDirectives(raw);
        expect(result.cleanedText).toBe('');
        expect(result.directives).toEqual([{ startTime: '18:30', activity: '去超市' }]);
    });

    // push 路徑上這個標籤不是原樣送到客戶端的：worker classifier 把它摘成
    // change_schedule directive（不摘的話會被 sanitize 連 raw 一起剝掉），客戶端再由
    // reconstructDirectiveTags 拼回標籤交給這裡解析。拼回來的是**不帶空格**的形態，
    // 跟提示詞裡教的規範寫法差一層空格——這條釘住那個往返，別哪天正則收緊就斷了。
    it('客戶端把 worker directive 拼回的無空格形態解析得動', () => {
        const result = extractScheduleChangeDirectives('[[ACTION:CHANGE_SCHEDULE|22:00|陪你聊天]]');
        expect(result.directives).toEqual([{ startTime: '22:00', activity: '陪你聊天' }]);
        expect(result.cleanedText).toBe('');
    });

    it('無法確定時段時只隱藏控制標籤並記為 malformed，不猜測目標', () => {
        const result = extractScheduleChangeDirectives('好。\n[[ACTION:CHANGE_SCHEDULE | 晚一點 | 去超市]]');
        expect(result.cleanedText).toBe('好。');
        expect(result.directives).toEqual([]);
        expect(result.malformedCount).toBe(1);
    });

    // 無括號那一層只從行首起算。這幾條是它的邊界：說到「改日程」三個字的大白話必須
    // 原樣留在正文裡，既不能憑空多出一條日程改動，也不能把後半句吃掉。這份解析跑在
    // 每一條模型輸出上，誤判一次的代價是全局的。
    describe('大白話提到「改日程」不算指令', () => {
        it.each([
            ['好，我改日程：22點陪你聊天', []],
            ['那我把今天的安排改一下，改日程 22:00 陪你', []],
            ['I will change schedule tomorrow, ok?', []],
            ['剛才說要修改日程的事，我再想想', []],
        ])('%s → 正文原樣保留，不產生指令', (raw) => {
            const result = extractScheduleChangeDirectives(raw as string);
            expect(result.cleanedText).toBe(raw);
            expect(result.directives).toEqual([]);
            expect(result.malformedCount).toBe(0);
        });

        // 清洗（剝標籤留下的空行、去首尾空白）只在真剝掉了東西時才發生。沒認出標籤
        // 還照樣清洗的話，每一條普通回覆都會被順手改一遍格式。
        it('沒認出日程標籤時連空行和尾隨空格都不動', () => {
            const raw = '第一段。\n\n\n第二段。   \n';
            const result = extractScheduleChangeDirectives(raw);
            expect(result.cleanedText).toBe(raw);
            expect(result.directives).toEqual([]);
            expect(result.malformedCount).toBe(0);
        });

        // 這條是取捨本身，不是漏洞：跟在正文後面的**裸**標籤（一個括號都沒打）就此
        // 不再識別。要認它就得允許無括號那一層從行中起算，而那一層一旦不錨行首，上面
        // 那幾條大白話會被從「改日程」一路吃到行尾——既憑空造出一條改動，又把用戶看到
        // 的正文截斷。漏認一條要靠猜才認得出的指令，比誤改一條日程 + 吞掉半句話便宜。
        // 規範寫法有括號兜底，走上面那一層，不受影響。
        it('裸標籤跟在正文同一行時不識別，正文一個字都不動', () => {
            const raw = '那今晚不睡了陪你。ACTION:CHANGE_SCHEDULE | 22:00 | 陪你聊天';
            const result = extractScheduleChangeDirectives(raw);
            expect(result.cleanedText).toBe(raw);
            expect(result.directives).toEqual([]);
            expect(result.malformedCount).toBe(0);
        });

        it('前半句是正文、後半句才是標籤時，標籤仍走帶括號那一層，正文不被吞', () => {
            const result = extractScheduleChangeDirectives('那今晚不練了 [[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]');
            expect(result.cleanedText).toBe('那今晚不練了');
            expect(result.directives).toEqual([{ startTime: '18:30', activity: '去超市' }]);
        });
    });

    // 反向守衛：錨行首不能把「獨佔一行、只是漏了括號」這類真指令一起收緊掉。
    it.each([
        'ACTION:CHANGE_SCHEDULE | 18:30 | 去超市',
        '  [[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]',
        '\t修改日程：18:30：去超市',
    ])('行首（含縮進）的無括號 / 漏括號指令照舊識別：%s', (raw) => {
        const result = extractScheduleChangeDirectives(raw);
        expect(result.directives).toEqual([{ startTime: '18:30', activity: '去超市' }]);
    });

    it('多行裡第二行才是指令時，前一行正文完整保留', () => {
        const result = extractScheduleChangeDirectives('今晚有別的安排。\nACTION:CHANGE_SCHEDULE | 18:30 | 去超市');
        expect(result.cleanedText).toBe('今晚有別的安排。');
        expect(result.directives).toEqual([{ startTime: '18:30', activity: '去超市' }]);
    });
});

describe('applyScheduleChanges', () => {
    it('只改未來已有時段，並清掉圍繞舊活動生成的衝突信息', () => {
        const result = applyScheduleChanges(
            schedule,
            [{ startTime: '18:30', activity: '去超市' }],
            null,
            at(14, 5),
        );
        expect(result.changes).toEqual([{ startTime: '18:30', before: '健身', after: '去超市' }]);
        expect(result.schedule.slots[2]).toEqual({ startTime: '18:30', activity: '去超市' });
        expect(result.schedule.flowNarrative).toBeUndefined();
        expect(schedule.slots[2].activity).toBe('健身');
    });

    it('拒絕已經過去的時段和表裡不存在的時段', () => {
        const result = applyScheduleChanges(schedule, [
            { startTime: '08:00', activity: '睡懶覺' },
            { startTime: '19:00', activity: '散步' },
        ], null, at(14));
        expect(result.changes).toEqual([]);
        expect(result.rejectedCount).toBe(2);
        expect(result.schedule).toBe(schedule);
    });

    // 夜裡最後一條日程通常是睡覺，人卻還在聊天。當前這一條要是也改不了，角色讀到的
    // 「你正在睡覺」就永遠撤不下來，每輪都被它推著去道晚安。
    it('當前正在進行的那一條可以改', () => {
        const result = applyScheduleChanges(
            schedule,
            [{ startTime: '14:00', activity: '陪對方聊天' }],
            null,
            at(15, 20),
        );
        expect(result.changes).toEqual([{ startTime: '14:00', before: '寫稿', after: '陪對方聊天' }]);
        expect(result.schedule.slots[1]).toEqual({ startTime: '14:00', activity: '陪對方聊天' });
    });

    it('放開當前時段沒有順帶放開更早的：同一輪裡改早上會被單獨拒掉', () => {
        const result = applyScheduleChanges(schedule, [
            { startTime: '08:00', activity: '睡懶覺' },
            { startTime: '14:00', activity: '陪對方聊天' },
        ], null, at(15));
        expect(result.changes).toEqual([{ startTime: '14:00', before: '寫稿', after: '陪對方聊天' }]);
        expect(result.rejectedCount).toBe(1);
        expect(result.schedule.slots[0].activity).toBe('起床');
    });

    it('凌晨還沒輪到今天第一條時沒有當前時段，整張表都算未來、照常能改', () => {
        const result = applyScheduleChanges(
            schedule,
            [{ startTime: '08:00', activity: '睡懶覺' }],
            null,
            at(3),
        );
        expect(result.changes).toEqual([{ startTime: '08:00', before: '起床', after: '睡懶覺' }]);
        expect(result.rejectedCount).toBe(0);
    });

    it('同一時段重複輸出時摺疊為“最初計劃 → 最終計劃”', () => {
        const result = applyScheduleChanges(schedule, [
            { startTime: '22:00', activity: '看書' },
            { startTime: '22:00', activity: '早點睡' },
        ], null, at(18));
        expect(result.changes).toEqual([{ startTime: '22:00', before: '看電影', after: '早點睡' }]);
        expect(result.schedule.slots[3].activity).toBe('早點睡');
    });

    // 「當前是第幾條」跟日程卡 / 首頁小組件用同一個函數，落點也從當前時段起找。一張表裡
    // 萬一有兩條一樣的 startTime，要改的是還沒過去的那條。
    it('同一個 startTime 出現兩次時，改的是當前時段那條', () => {
        const dup: DailySchedule = {
            ...schedule,
            slots: [
                { startTime: '08:00', activity: '起床' },
                { startTime: '22:00', activity: '早先那條' },
                { startTime: '22:00', activity: '當前這條' },
            ],
        };
        const result = applyScheduleChanges(dup, [{ startTime: '22:00', activity: '陪你聊天' }], null, at(22, 30));
        expect(result.schedule.slots[1].activity).toBe('早先那條');
        expect(result.schedule.slots[2].activity).toBe('陪你聊天');
        expect(result.rejectedCount).toBe(0);
    });
});

// 主動消息把「說出口」和「落庫」拉開了距離：一條 push 可能在收件箱裡躺一夜，用戶第二天
// 早上才打開 App。按處理那一刻判的話，昨晚那句「22:00 改成陪你聊天」會落到**今天**的
// 22:00 上——角色昨晚的一句話，改了今天的安排。調用方傳 push 的 sentAt，隔天整批丟棄。
describe('applyAssistantScheduleChanges — 按說出口那一刻判，不是按處理那一刻', () => {
    const char = { id: 'char-overnight' } as any;
    const tag = '[[ACTION:CHANGE_SCHEDULE | 22:00 | 陪你聊天]]';

    /** 今天這張表（日期 key 跟著「今天」走，測試不依賴固定日期）。 */
    const todaySchedule = () => {
        const now = new Date();
        const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        return {
            id: `${char.id}_${key}`,
            charId: char.id,
            date: key,
            generatedAt: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8).getTime(),
            slots: [
                { startTime: '08:00', activity: '起床' },
                { startTime: '22:00', activity: '睡覺' },
            ],
        };
    };

    /** 昨天那張表（用戶昨天用過 App 就會留著）。 */
    const yesterdaySchedule = () => {
        const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return {
            id: `${char.id}_${key}`,
            charId: char.id,
            date: key,
            generatedAt: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8).getTime(),
            slots: [
                { startTime: '08:00', activity: '起床' },
                { startTime: '22:00', activity: '睡覺' },
            ],
        };
    };

    // 關鍵在於「昨天那張表還在庫裡」：沒有日曆日門檻的話，昨晚說出口的改動會照著
    // 昨天的日期 key 取到那張表並改寫它——改一張已經翻篇的表，白寫一次庫；而真正
    // 危險的是調用方壓根不傳時刻（舊行為），那時它取的是**今天**的表，昨晚的一句話
    // 會蓋掉今天晚上的安排。門檻把這兩種都堵掉：隔天的整批不落庫。
    it('昨晚說出口的改動隔天已經沒有落點 → 整批丟棄，兩天的表都不動', async () => {
        await DB.saveDailySchedule(todaySchedule() as any);
        await DB.saveDailySchedule(yesterdaySchedule() as any);
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const result = await applyAssistantScheduleChanges(tag, char, yesterday);

        expect(result.changes).toEqual([]);
        expect(result.rejectedCount).toBe(1);
        // 標籤仍然從正文裡摘掉（不能漏給用戶看）
        expect(result.cleanedText).toBe('');
        const storedYesterday = await DB.getDailySchedule(char.id, yesterdaySchedule().date);
        expect(storedYesterday?.slots[1].activity).toBe('睡覺');
        const storedToday = await DB.getDailySchedule(char.id, todaySchedule().date);
        expect(storedToday?.slots[1].activity).toBe('睡覺');
    });

    it('同一天說出口的照常落庫', async () => {
        await DB.saveDailySchedule(todaySchedule() as any);
        // 23:30 說的：22:00 那條是「當前正在進行」，可以改
        const spokenAt = new Date();
        spokenAt.setHours(23, 30, 0, 0);

        const result = await applyAssistantScheduleChanges(tag, char, spokenAt);

        expect(result.changes).toEqual([{ startTime: '22:00', before: '睡覺', after: '陪你聊天' }]);
        const stored = await DB.getDailySchedule(char.id, todaySchedule().date);
        expect(stored?.slots[1].activity).toBe('陪你聊天');
    });
});

