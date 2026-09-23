import { describe, it, expect } from 'vitest';
import { formatTaskTime, fromDatetimeLocalValue, toDatetimeLocalValue } from './amsg2Tasks';
import { buildAmsg2TaskContextText } from './amsg2TaskContext';
import {
    AMSG_SLOT_CURRENT_TIME, AMSG_SLOT_USER_CLOCK, FIRE_PACK_VERSION,
    formatFireTimeShort, renderFirePack, type AmsgFirePack,
} from './amsgFirePack';
import { buildFireScheduleBlock, buildFireScheduleTool, resolveSendAtMs } from './amsgFireSchedule';
import type { ActiveMsg2TaskRecord } from '../types';

// 迴歸守衛：同一條任務，角色在聊天裡看到的時間和到點生成時看到的時間必須是同一個鍾。
//
// 以前不是：聊天側（排程現狀塊 / schedule、list 工具的回話）用 toLocaleString 不帶
// timeZone，吃的是**設備**時區；fire 側一律按 fire_pack.tzId 也就是**角色**時區渲染。
// 設備在中國、角色在紐約時，同一條任務兩邊差整整 12 小時——角色剛說「我 21:00 找你」，
// 下一輪的排程清單裡那條寫著 09:00。

const CHAR_TZ = 'America/New_York';
const DEVICE_TZ = 'Asia/Shanghai';
const AT = Date.UTC(2026, 7, 2, 13, 0);   // 上海 21:00 / 紐約 09:00

const task = (over: Partial<ActiveMsg2TaskRecord> = {}): ActiveMsg2TaskRecord => ({
    taskUuid: 'aabbccdd-0000-0000-0000-000000000000',
    clientTaskId: 'c1',
    mode: 'auto',
    firstSendTime: new Date(AT).toISOString(),
    recurrenceType: 'none',
    expirePolicy: 'expire',
    ...over,
} as ActiveMsg2TaskRecord);

describe('給角色看的時間跟 fire 側同一個鍾', () => {
    it('排程現狀塊按角色時區寫，不吃設備時區', () => {
        const text = buildAmsg2TaskContextText([task()], [], AT - 60_000, CHAR_TZ)!;
        // 紐約角色看到的是自己的 09:00
        expect(text).toContain('09:00');
        expect(text).not.toContain('21:00');
    });

    it('跟 worker 到點渲染的那份對得上', () => {
        const chatSide = formatTaskTime(AT, CHAR_TZ);
        const fireSide = formatFireTimeShort(AT, { tzId: CHAR_TZ });
        // 格式不同（一個帶年、一個短格式），但小時分鐘必須是同一個
        expect(chatSide).toContain('09:00');
        expect(fireSide).toContain('09:00');
    });

    it('不傳時區仍跟著設備走——設置面板上的任務卡是給用戶自己看的', () => {
        // 這條釘的是「面板別被順手改成角色時區」：用戶看的是自己桌上的鐘。
        const forUser = formatTaskTime(AT);
        const forChar = formatTaskTime(AT, CHAR_TZ);
        expect(forUser).not.toBe(forChar);
    });
});

// 迴歸守衛：上面那幾條釘的是「角色的鐘處處一致」，這一組釘的是另一半——**用戶的鐘**
// 以前一個字都沒上雲。角色只看得到自己那邊的時間，「晚上九點跟他說一聲」在紐約角色
// 手裡就是排到上海用戶的凌晨三點，而且它沒有任何線索能察覺這件事。
describe('角色知道對方那邊現在幾點', () => {
    const pack: AmsgFirePack = {
        v: FIRE_PACK_VERSION, builtAt: 1, pendingTasks: [], scene: null, selfScheduleEnabled: true, lastUserMessageAt: null,
        template: `當前本地時間（你所在地）：${AMSG_SLOT_CURRENT_TIME}${AMSG_SLOT_USER_CLOCK}`,
        tzId: CHAR_TZ,
        userTzId: DEVICE_TZ,
        targetName: '小明同學',
    };

    it('兩個鍾一起出現，各自把主語寫在文案裡（別長成兩個打架的時間）', () => {
        const out = renderFirePack(pack, AT, '指令');
        // 角色那邊 09:00，用戶那邊 21:00，同一時刻
        expect(out).toContain('當前本地時間（你所在地）：2026年8月2日 週日 上午 09:00');
        expect(out).toContain('對方所在時區參考：小明同學那邊現在是 8月2日 晚上 21:00');
    });

    it('兩邊同一個時區時不重複報鍾', () => {
        expect(renderFirePack({ ...pack, userTzId: CHAR_TZ }, AT, '指令'))
            .not.toContain('對方所在時區參考');
    });

    it('自排工具的說明裡提醒了時差（排時間前先想想對方那邊幾點）', () => {
        const opts = { nowMs: AT, tz: { tzId: CHAR_TZ } };
        expect(buildFireScheduleBlock('native', opts)).toContain('對方那邊是幾點');
        expect(buildFireScheduleBlock('text', opts)).toContain('對方那邊是幾點');
        expect(JSON.stringify(buildFireScheduleTool(opts).function.parameters))
            .toContain('別把消息排到對方的深夜');
    });
});

describe('角色寫的 send_at 按它自己的鐘解析', () => {
    it('裸牆鍾按角色時區還原，跟 worker 同一份規則', () => {
        // 紐約角色說「明早九點」寫成 2026-08-03T09:00:00。
        const raw = '2026-08-03T09:00:00';
        expect(resolveSendAtMs(raw, { tzId: CHAR_TZ })).toBe(Date.UTC(2026, 7, 3, 13, 0));
        // 按設備（上海）解釋的話會算成 UTC 01:00 —— 差整整 12 小時。
        expect(resolveSendAtMs(raw, { tzId: DEVICE_TZ })).toBe(Date.UTC(2026, 7, 3, 1, 0));
    });

    it('帶顯式偏移的照標註解析（模型硬要寫也不算錯）', () => {
        expect(resolveSendAtMs('2026-08-03T09:00:00+08:00', { tzId: CHAR_TZ }))
            .toBe(Date.UTC(2026, 7, 3, 1, 0));
    });
});

// 上面那條規則只對「角色自己排程」成立。設置面板的時間框是給用戶填的，填的是用戶桌上
// 的鐘——同一個裸牆鍾交給排程接口，就會被當成角色那邊的牆鍾。角色在紐約、用戶在中國時，
// 用戶填 15:26 會排到次日 03:26：面板一開始還按設備鍾倒計時，等遠端對完帳才跳成 03:26，
// 用戶看到的是「填的時間過點了不響，列表裡時間還自己變了」。
// 面板因此在交出去之前先折成絕對時刻，讓後面所有環節只認這一刻。
describe('面板填的時間按用戶的鐘落地', () => {
    const PANEL_VALUE = '2026-08-03T09:00';   // 用戶在 datetime-local 裡填的

    it('折成絕對時刻後，按誰的時區解析都是同一刻', () => {
        const handed = fromDatetimeLocalValue(PANEL_VALUE);
        expect(resolveSendAtMs(handed, { tzId: CHAR_TZ }))
            .toBe(resolveSendAtMs(handed, { tzId: DEVICE_TZ }));
        // 而且就是用戶填的那一刻（按設備時區還原）
        expect(resolveSendAtMs(handed, { tzId: CHAR_TZ })).toBe(new Date(PANEL_VALUE).getTime());
    });

    it('裸牆鍾直接交出去會被角色時區挪走——這是修掉的那條路', () => {
        expect(resolveSendAtMs(PANEL_VALUE, { tzId: CHAR_TZ }))
            .not.toBe(resolveSendAtMs(PANEL_VALUE, { tzId: DEVICE_TZ }));
    });

    it('折過去再折回來，編輯時時間框裡還是用戶填的那個值', () => {
        expect(toDatetimeLocalValue(fromDatetimeLocalValue(PANEL_VALUE))).toBe(PANEL_VALUE);
    });

    it('空值 / 壞值原樣返回，由下游報錯', () => {
        expect(fromDatetimeLocalValue('')).toBe('');
        expect(fromDatetimeLocalValue('不是時間')).toBe('不是時間');
    });
});
