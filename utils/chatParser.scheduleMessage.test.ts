import { describe, expect, it, vi, afterEach } from 'vitest';
import { ChatParser } from './chatParser';
import { DB } from './db';

// `[schedule_message | 時間 | fixed | 內容]` 排不上的兩種情況：時間解析不出來、時間已經
// 過去。角色在正文裡往往已經把話說出去了（「我到點叫你」），排不上就是一句空頭承諾。
//
// 離線補收時這條路特別常走：消息是凌晨兩點發的，人第二天早上九點才打開 App，重放到這裡
// 時約定的八點已經過去。以前這種情況一行日誌都沒有，排查時只能看到「角色說了但什麼都
// 沒發生」。現在會留一行 warn 說清是哪條、晚了多久。

const noop = () => {};

afterEach(() => { vi.restoreAllMocks(); });

const run = (content: string, charTz?: string) =>
    ChatParser.parseAndExecuteActions(content, `c-sched-${Date.now()}`, '阿一', noop, undefined, charTz);

describe('[schedule_message] 排不上時留痕', () => {
    it('時間已經過去 → warn 一行 + 不落庫', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
        const save = vi.spyOn(DB, 'saveScheduledMessage');

        const out = await run('睡吧\n[schedule_message | 2020-01-01 08:00:00 | fixed | 早安，起床啦]');

        expect(out).toBe('睡吧');
        expect(save).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        const line = warn.mock.calls[0].join(' ');
        expect(line).toContain('時間已經過去');
        expect(line).toContain('2020-01-01 08:00:00');
        expect(line).toContain('早安，起床啦');
    });

    it('時間解析不出來 → warn 一行 + 不落庫', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
        const save = vi.spyOn(DB, 'saveScheduledMessage');

        const out = await run('好\n[schedule_message | 明天早上 | fixed | 起床啦]');

        expect(out).toBe('好');
        expect(save).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0].join(' ')).toContain('時間解析不了');
    });

    it('時間還沒到 → 照常落庫, 不 warn', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
        const save = vi.spyOn(DB, 'saveScheduledMessage').mockResolvedValue(undefined as any);

        const future = new Date(Date.now() + 3600_000);
        const stamp = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${
            String(future.getDate()).padStart(2, '0')} ${String(future.getHours()).padStart(2, '0')}:${
            String(future.getMinutes()).padStart(2, '0')}:00`;

        const out = await run(`好\n[schedule_message | ${stamp} | fixed | 該出門了]`);

        expect(out).toBe('好');
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][0]).toMatchObject({ content: '該出門了' });
        expect(warn).not.toHaveBeenCalled();
    });
});

// 迴歸守衛：離線補收時一條消息會被拆成正文氣泡 + 卡片/系統提示。正文走
// applyAssistantPostProcessing 的 persistMessage 蓋上原始發送時刻，而 chatParser 這邊
// 以前是一水兒的裸 DB.saveMessage，默認寫庫當刻——用戶凌晨三點收到的那條消息，正文顯示
// 凌晨三點、戳一戳和轉帳顯示「早上九點打開 App 那一刻」，一條消息兩個時間。
describe('parseAndExecuteActions 落庫時間戳', () => {
    it('傳了 messageTimestamp → 戳一戳 / 轉帳 / 日程系統提示全用同一個時刻', async () => {
        const charId = `c-ts-${Date.now()}`;
        const sentAt = Date.UTC(2026, 7, 2, 19, 0);   // 凌晨三點（東八區）發出

        await ChatParser.parseAndExecuteActions(
            '睡吧\n[[ACTION:POKE]]\n[[ACTION:TRANSFER:520]]\n[[ACTION:ADD_EVENT | 面試 | 2026-08-03]]',
            charId, '阿一', noop, undefined, undefined, sentAt,
        );

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const stamped = msgs.filter(m => m.type !== 'text' || m.role === 'system');
        expect(stamped.length).toBeGreaterThanOrEqual(3);
        for (const m of stamped) expect(m.timestamp).toBe(sentAt);
    }, 20000);

    it('不傳 → 維持寫庫當刻（前台聊天那條路不變）', async () => {
        const charId = `c-ts-none-${Date.now()}`;
        const before = Date.now();
        await ChatParser.parseAndExecuteActions('[[ACTION:POKE]]', charId, '阿一', noop);

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        expect(msgs).toHaveLength(1);
        expect(msgs[0].timestamp).toBeGreaterThanOrEqual(before);
    }, 20000);
});
