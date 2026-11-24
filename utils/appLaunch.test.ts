import { describe, expect, it, vi } from 'vitest';
import { appReturn, calendarLaunch } from './appLaunch';
import { AppID } from '../types';

describe('角色名片跳出去再回來（plans/character-card.md）', () => {
    it('關掉登記的那個 App 才回去，拿一次就沒了', () => {
        const back = vi.fn();
        appReturn.set(AppID.Calendar, back);
        expect(appReturn.take(AppID.Character)).toBeNull();
        // 關錯的那次也把字條清掉了，之後不會誤用
        expect(appReturn.take(AppID.Calendar)).toBeNull();
        appReturn.set(AppID.Calendar, back);
        appReturn.take(AppID.Calendar)?.();
        expect(back).toHaveBeenCalledTimes(1);
        expect(appReturn.take(AppID.Calendar)).toBeNull();
    });
    it('中途跑去別的 App，字條作廢；開的就是登記的那個不作廢', () => {
        const back = vi.fn();
        appReturn.set(AppID.MemoryPalace, back);
        appReturn.forget(AppID.MemoryPalace);
        expect(appReturn.take(AppID.MemoryPalace)).toBe(back);
        appReturn.set(AppID.MemoryPalace, back);
        appReturn.forget(AppID.Date);
        expect(appReturn.take(AppID.MemoryPalace)).toBeNull();
    });
    it('一次性字條：peek 不拿走，consume 拿走', () => {
        calendarLaunch.request({ tab: 'theirs' });
        expect(calendarLaunch.peek()).toEqual({ tab: 'theirs' });
        expect(calendarLaunch.consume()).toEqual({ tab: 'theirs' });
        expect(calendarLaunch.peek()).toBeNull();
    });
});
