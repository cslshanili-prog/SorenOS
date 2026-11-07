import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ActiveMsg2TaskRecord, CharacterProfile } from '../types';

const cancelTask = vi.fn();
const scheduleCharacterTask = vi.fn();
vi.mock('./activeMsgClient', () => ({ ActiveMsgClient: { cancelTask: (...a: any[]) => cancelTask(...a), scheduleCharacterTask: (...a: any[]) => scheduleCharacterTask(...a) } }));

import { canCharSelfScheduleAmsg, isDateOfflinePaused, pauseAmsgForStory, resumeAmsgAfterStory, resumeFireTime } from './dateOffline';

const NOW = Date.UTC(2026, 10, 6, 12, 0);
const H = 3_600_000;
const task = (uuid: string, over: Partial<ActiveMsg2TaskRecord> = {}): ActiveMsg2TaskRecord => ({
    taskUuid: uuid, clientTaskId: `c-${uuid}`, mode: 'auto', firstSendTime: new Date(NOW + H).toISOString(), recurrenceType: 'none',
    expirePolicy: 'force', source: 'user', status: 'scheduled', createdAt: 1, ...over,
} as ActiveMsg2TaskRecord);
const char = (over: Partial<CharacterProfile> = {}) => ({ id: 'c1', name: '凱恩', activeMsg2Config: { enabled: true, tasks: [] }, ...over } as CharacterProfile);

/** 假的 updateCharacter：把 patch 套到 state 上 */
const store = (initial: CharacterProfile) => {
    let state = initial;
    const update = (_id: string, patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
    return { update, get: () => state };
};

beforeEach(() => { cancelTask.mockReset(); scheduleCharacterTask.mockReset(); });

describe('什麼時候暫停', () => {
    it('開關開著又有進行中的故事才算', () => {
        expect(isDateOfflinePaused(char({ dateOfflineMode: true, activeDateStoryId: 's' }))).toBe(true);
        expect(isDateOfflinePaused(char({ dateOfflineMode: true }))).toBe(false);
        expect(isDateOfflinePaused(char({ activeDateStoryId: 's' }))).toBe(false);
        expect(canCharSelfScheduleAmsg(char())).toBe(true);
        expect(canCharSelfScheduleAmsg(char({ dateOfflineMode: true, activeDateStoryId: 's' }))).toBe(false);
        expect(canCharSelfScheduleAmsg(char({ activeMsg2Config: { enabled: false } }))).toBe(false);
    });
});

describe('恢復時排在哪', () => {
    it('單次：還沒到就照原時間、過了就丟；重複：推到下一次', () => {
        expect(resumeFireTime(task('a', { firstSendTime: new Date(NOW + H).toISOString() }), NOW)).toBe(NOW + H);
        expect(resumeFireTime(task('b', { firstSendTime: new Date(NOW - H).toISOString() }), NOW)).toBeNull();
        expect(resumeFireTime(task('c', { firstSendTime: new Date(NOW + 60_000).toISOString() }), NOW)).toBeNull();
        const daily = task('d', { recurrenceType: 'daily', firstSendTime: new Date(NOW - 3 * 24 * H + 2 * H).toISOString() });
        expect(resumeFireTime(daily, NOW)).toBe(NOW + 2 * H);
        const dailyNow = task('e', { recurrenceType: 'daily', firstSendTime: new Date(NOW - 24 * H + 60_000).toISOString() });
        expect(resumeFireTime(dailyNow, NOW)).toBe(NOW + 60_000 + 24 * H);
    });
});

describe('暫停與恢復', () => {
    it('暫停：取消還會響的、留底；取消失敗的留在原清單', async () => {
        cancelTask.mockImplementation(async (uuid: string) => { if (uuid === 'bad') throw new Error('x'); return { uuid, alreadyGone: false }; });
        const s = store(char({ dateOfflineMode: true, activeDateStoryId: 's', activeMsg2Config: { enabled: true, tasks: [task('a'), task('bad'), task('old', { firstSendTime: new Date(NOW - 5 * H).toISOString() })] } }));
        const r = await pauseAmsgForStory(s.get(), s.update, NOW);
        expect(r).toEqual({ paused: 1, failed: 1 });
        expect(cancelTask.mock.calls.map(c => c[0])).toEqual(['a', 'bad']);
        expect(s.get().dateOfflinePause?.tasks.map(t => t.taskUuid)).toEqual(['a']);
        expect(s.get().activeMsg2Config?.tasks?.map(t => t.taskUuid)).toEqual(['bad', 'old']);
    });

    it('沒有任務也記下暫停（之後才知道要恢復）', async () => {
        const s = store(char({ dateOfflineMode: true, activeDateStoryId: 's' }));
        await pauseAmsgForStory(s.get(), s.update, NOW);
        expect(s.get().dateOfflinePause).toEqual({ since: NOW, tasks: [] });
        expect(cancelTask).not.toHaveBeenCalled();
    });

    it('恢復：照原樣排回去、角色自己排的標成自排、過點的丟掉；失敗的留著下次再試', async () => {
        scheduleCharacterTask.mockImplementation(async ({ task: t }: any) => {
            if (t.userMessage === 'fail') throw new Error('offline');
            return { uuid: `new-${t.userMessage}`, clientTaskId: 'cid', firstSendAt: t.firstSendTime };
        });
        const paused = [task('a', { userMessage: 'ok', source: 'character' }), task('b', { userMessage: 'fail' }), task('c', { userMessage: 'late', firstSendTime: new Date(NOW - H).toISOString() })];
        const s = store(char({ dateOfflineMode: true, dateOfflinePause: { since: NOW - 5 * H, tasks: paused } }));
        const deps = { userProfile: {} as any, groups: [], realtimeConfig: {} as any, apiConfig: {} as any };
        const r = await resumeAmsgAfterStory(s.get(), s.update, deps, NOW);
        expect(r).toEqual({ restored: 1, dropped: 1, failed: 1 });
        expect(scheduleCharacterTask.mock.calls[0][0].task).toMatchObject({ selfScheduled: true, firstSendTime: new Date(NOW + H).toISOString() });
        expect(s.get().activeMsg2Config?.tasks?.map(t => t.taskUuid)).toEqual(['new-ok']);
        expect(s.get().dateOfflinePause).toMatchObject({ tasks: [{ taskUuid: 'b' }], resuming: true });

        // 再試一次成功就清掉
        scheduleCharacterTask.mockImplementation(async ({ task: t }: any) => ({ uuid: 'new-b', clientTaskId: 'cid', firstSendAt: t.firstSendTime }));
        await resumeAmsgAfterStory(s.get(), s.update, deps, NOW);
        expect(s.get().dateOfflinePause).toBeUndefined();
        expect(s.get().activeMsg2Config?.tasks?.map(t => t.taskUuid).sort()).toEqual(['new-b', 'new-ok']);
    });

    it('用戶中途把 2.0 關了：不排回去', async () => {
        const s = store(char({ activeMsg2Config: { enabled: false }, dateOfflinePause: { since: 1, tasks: [task('a')] } }));
        const r = await resumeAmsgAfterStory(s.get(), s.update, { userProfile: {} as any, groups: [], realtimeConfig: {} as any, apiConfig: {} as any }, NOW);
        expect(r).toEqual({ restored: 0, dropped: 1, failed: 0 });
        expect(scheduleCharacterTask).not.toHaveBeenCalled();
        expect(s.get().dateOfflinePause).toBeUndefined();
    });
});
