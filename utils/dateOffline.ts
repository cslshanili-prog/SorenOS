/**
 * 見面「故事進行中關閉線上功能」（plans/offline-date-redesign.md 第 6 項）。
 *
 * 開關在角色身上（dateOfflineMode），有一場進行中的故事時生效、完結自動恢復。停的是：
 * - 主動消息 2.0（雲端）：開始暫停時把這個角色排著的任務先取消、本機留一份（dateOfflinePause.tasks），
 *   恢復時照原樣排回去：重複的照排到下一次，單次的時間已經過了就丟掉。不改 Worker，誰的 Worker 都能用
 * - 本機定時消息（[schedule_message]）：暫停期間到點的直接丟掉（OSContext 的 5 秒輪詢）
 * - 私聊裡不教模型排新的定時消息、不給主動消息的排程工具
 * 朋友圈照常（Liora：線下見面時發個朋友圈按個讚也不奇怪）。
 */

import type { ActiveMsg2TaskRecord, APIConfig, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { applyScheduledTask, currentOccurrenceMs, getPendingTasks, isAmsg2EnabledForChar } from './amsg2Tasks';

/** 這個角色現在要不要停線上功能 */
export const isDateOfflinePaused = (char: Pick<CharacterProfile, 'dateOfflineMode' | 'activeDateStoryId'> | null | undefined): boolean =>
    !!char?.dateOfflineMode && !!char.activeDateStoryId;

/** 角色現在能不能自己排主動消息（面板開關開著、又沒在線下故事裡暫停） */
export const canCharSelfScheduleAmsg = (char: CharacterProfile): boolean =>
    isAmsg2EnabledForChar(char) && !isDateOfflinePaused(char);

const PERIOD_MS: Record<string, number> = { daily: 86_400_000, weekly: 7 * 86_400_000 };
/** 恢復時離現在太近的就往後推一輪（重複的）或丟掉（單次的），免得一恢復就馬上響 */
const RESUME_MARGIN_MS = 2 * 60_000;

/**
 * 恢復時，留下來的任務該排在哪一刻；回 null 就是不排了（單次的已經過點）。
 */
export const resumeFireTime = (task: ActiveMsg2TaskRecord, now = Date.now()): number | null => {
    const next = currentOccurrenceMs(task, now);
    if (next === null) return null;
    if (next > now + RESUME_MARGIN_MS) return next;
    const period = PERIOD_MS[task.recurrenceType];
    return period ? next + period * Math.ceil((now + RESUME_MARGIN_MS - next) / period) : null;
};

/** 暫停時要取消的：這個角色還會響的主動消息任務 */
export const tasksToPause = (char: CharacterProfile, now = Date.now()): ActiveMsg2TaskRecord[] =>
    char.activeMsg2Config ? getPendingTasks(char.activeMsg2Config, now) : [];

interface AmsgDeps {
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig: RealtimeConfig;
    apiConfig: APIConfig;
}

type Updater = (id: string, patch: Partial<CharacterProfile> | ((prev: CharacterProfile) => Partial<CharacterProfile>)) => void;

/**
 * 進入暫停：取消雲端任務、留底。取消失敗的那條留在原清單（遠端還活著），不放進留底。
 * 回傳暫停了幾條、幾條沒取消成。
 */
export const pauseAmsgForStory = async (char: CharacterProfile, updateCharacter: Updater, now = Date.now()): Promise<{ paused: number; failed: number }> => {
    const pending = tasksToPause(char, now);
    const cancelled: ActiveMsg2TaskRecord[] = [];
    let failed = 0;
    if (pending.length) {
        const { ActiveMsgClient } = await import('./activeMsgClient');
        for (const task of pending) {
            try { await ActiveMsgClient.cancelTask(task.taskUuid); cancelled.push(task); } catch { failed++; }
        }
    }
    const ids = new Set(cancelled.map(task => task.taskUuid));
    updateCharacter(char.id, prev => ({
        dateOfflinePause: { since: now, tasks: [...(prev.dateOfflinePause?.tasks || []), ...cancelled] },
        ...(prev.activeMsg2Config ? { activeMsg2Config: { ...prev.activeMsg2Config, tasks: (prev.activeMsg2Config.tasks || []).filter(task => !ids.has(task.taskUuid)) } } : {}),
    }));
    return { paused: cancelled.length, failed };
};

/**
 * 解除暫停：把留底的任務照原樣排回去。排不回去的（網路、Worker 連不上）留在留底裡、暫停記號不清，
 * 下次檢查時（見 DateApp 的同步）再試；全部處理完才清掉。
 */
export const resumeAmsgAfterStory = async (char: CharacterProfile, updateCharacter: Updater, deps: AmsgDeps, now = Date.now()): Promise<{ restored: number; dropped: number; failed: number }> => {
    const saved = char.dateOfflinePause?.tasks || [];
    let restored = 0, dropped = 0;
    const keep: ActiveMsg2TaskRecord[] = [];
    const records: ActiveMsg2TaskRecord[] = [];
    if (saved.length && isAmsg2EnabledForChar(char) && char.activeMsg2Config) {
        const { ActiveMsgClient } = await import('./activeMsgClient');
        for (const task of saved) {
            const at = resumeFireTime(task, now);
            if (at === null) { dropped++; continue; }
            try {
                const result = await ActiveMsgClient.scheduleCharacterTask({
                    char, config: char.activeMsg2Config,
                    task: {
                        mode: task.mode,
                        firstSendTime: new Date(at).toISOString(),
                        recurrenceType: task.recurrenceType,
                        promptHint: task.promptHint,
                        userMessage: task.userMessage,
                        expirePolicy: task.expirePolicy,
                        selfScheduled: task.source === 'character',
                    },
                    ...deps,
                });
                records.push({ ...task, taskUuid: result.uuid, clientTaskId: result.clientTaskId, firstSendTime: result.firstSendAt, nextSendAt: undefined, status: 'scheduled', lastError: undefined });
                restored++;
            } catch {
                keep.push(task);
            }
        }
    } else {
        // 2.0 被關掉了：不排回去，直接丟（用戶自己關的，排回去反而是幽靈任務）
        dropped = saved.length;
    }
    updateCharacter(char.id, prev => ({
        dateOfflinePause: keep.length ? { since: prev.dateOfflinePause?.since ?? now, tasks: keep, resuming: true } : undefined,
        ...(records.length && prev.activeMsg2Config
            ? { activeMsg2Config: { ...prev.activeMsg2Config, tasks: records.reduce((list, record) => applyScheduledTask(list, record, {}, now), prev.activeMsg2Config.tasks || []) } }
            : {}),
    }));
    return { restored, dropped, failed: keep.length };
};
