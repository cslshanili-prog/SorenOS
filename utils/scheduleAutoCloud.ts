/**
 * 日程自動生成的雲端那條路（plans/calendar.md 第 5 批）：角色排一條每天到點的後台任務（主動消息 2.0），
 * 頁面關著也會生成。契約在 utils/amsgScheduleJob.ts，worker 側在 worker/amsg/src/scheduleFire.ts。
 *
 * - 能不能交：主動消息 2.0 配好了 ＋ 這台 worker 認識後台任務 ＋ 這個角色的日程 API 配得齊（情緒那一行的口徑：
 *   角色單獨配的情緒 API，否則全局聊天 API）
 * - standing job：人設上下文＋接下來 8 天每天要帶的段；上線時每天刷一次（scheduleAutoRun 的 tick 順手做）
 * - 到點：ahead=1 → 角色那邊 20:00 排明天；ahead=0 → 00:30 排今天
 */

import type { CalendarEvent, CharacterProfile, GroupProfile, RealtimeConfig, Trip, UserProfile } from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { DB } from './db';
import { isAmsg2GlobalReady } from './amsg2ToolBridge';
import { buildCharEmotionCredRow } from './amsgLlmCredentials';
import { SCHEDULE_GENERATE_KIND, addDaysKey, buildScheduleJobInput, scheduleJobKey, type ScheduleJobInput } from './amsgScheduleJob';
import { loadCalendarEvents } from './calendarEvents';
import { buildAgreementsBlock, buildSchedulePromptBlock, buildTodosBlock, buildTripBlock, type NamedParticipant } from './scheduleGenParts';
import { buildCharContext, loadNamedParticipants, personTodayKey } from './scheduleGenerator';
import { charSchedulePerson } from './schedulePerson';
import { SCHEDULE_LLM_MAX_TOKENS, SCHEDULE_LLM_TEMPERATURE } from './schedulePromptCore';
import { isScheduleFeatureOn } from './scheduleFeature';
import { tripOn } from './trips';
import { resolveCharTimeZone } from './timezone';
import { resolveUserProfileForChar } from './userPersona';

const HEADER = '📅 [ScheduleAuto:雲端]';
/** standing job 帶幾天 */
const JOB_DAYS = 8;

export interface ScheduleAutoCloudScope {
    userProfileBase: UserProfile;
    apiConfig: { baseUrl: string; apiKey: string; model: string };
    groups?: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
}

const credRowFor = (char: CharacterProfile, apiConfig: ScheduleAutoCloudScope['apiConfig']) =>
    buildCharEmotionCredRow(char.id, char.emotionConfig?.api, apiConfig);

export type ScheduleAutoCloudGate = 'ok' | 'no-worker' | 'unsupported' | 'no-api' | 'unknown';

/** 這個角色能不能排雲端的自動生成 */
export const scheduleAutoCloudGate = async (char: CharacterProfile, apiConfig: ScheduleAutoCloudScope['apiConfig']): Promise<ScheduleAutoCloudGate> => {
    if (!credRowFor(char, apiConfig)) return 'no-api';
    if (!await isAmsg2GlobalReady()) return 'no-worker';
    const support = await ActiveMsgClient.probeBackgroundJobSupportDetailed();
    if (support === 'unsupported') return 'unsupported';
    if (support === 'unknown') return 'unknown';
    return 'ok';
};

/** 組這個角色的 standing job（人設上下文＋接下來幾天的段） */
export const buildScheduleJobForChar = async (
    char: CharacterProfile,
    scope: ScheduleAutoCloudScope,
    deps?: { events?: CalendarEvent[]; trips?: Trip[]; people?: NamedParticipant[] },
): Promise<ScheduleJobInput> => {
    const userProfile = resolveUserProfileForChar(scope.userProfileBase, char);
    const person = charSchedulePerson(char);
    const [events, trips, people, ctx] = await Promise.all([
        deps?.events ? Promise.resolve(deps.events) : loadCalendarEvents().catch(() => [] as CalendarEvent[]),
        deps?.trips ? Promise.resolve(deps.trips) : DB.getAllTrips().catch(() => [] as Trip[]),
        deps?.people ? Promise.resolve(deps.people) : loadNamedParticipants(scope.userProfileBase),
        buildCharContext(char, userProfile),
    ]);
    const nameOf = (p: { kind: string; id: string }) => people.find(x => x.participant.kind === p.kind && x.participant.id === p.id)?.name || '';
    const today = personTodayKey(person);
    const days = Array.from({ length: JOB_DAYS }, (_, i) => addDaysKey(today, i)).map(date => ({
        date,
        extra: buildSchedulePromptBlock(person.schedulePrompt)
            + buildTripBlock(tripOn(trips, person.participant, date), date)
            + buildAgreementsBlock(events, person.participant, date, nameOf)
            + buildTodosBlock(events, person.participant, date),
    }));
    return buildScheduleJobInput({
        charId: char.id, charName: char.name, userName: userProfile.name || '',
        style: person.style, tzId: resolveCharTimeZone(char) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        ahead: char.scheduleAuto?.ahead ?? 1,
        baseContext: ctx.baseContext, chatHistoryBlock: ctx.chatHistoryBlock, days, refreshedAt: Date.now(),
    });
};

/** 只刷新 standing job（不動任務） */
export const refreshScheduleJobInput = async (char: CharacterProfile, scope: ScheduleAutoCloudScope): Promise<void> => {
    const job = await buildScheduleJobForChar(char, scope);
    await ActiveMsgClient.putBackgroundJobInput(scheduleJobKey(char.id), job);
    console.log(`${HEADER} ${char.name} 的輸入刷好了（${job.days[0].date}～${job.days[job.days.length - 1].date}）`);
};

/** 排一條每天到點的後台任務；回 cloud 記錄（調用方寫回角色卡） */
export const submitScheduleAutoTask = async (char: CharacterProfile, scope: ScheduleAutoCloudScope): Promise<NonNullable<CharacterProfile['scheduleAuto']>['cloud']> => {
    if (!isScheduleFeatureOn(char)) throw new Error('這個角色沒開日程功能');
    const credRow = credRowFor(char, scope.apiConfig);
    if (!credRow) throw new Error('日程 API 沒配齊，排不了雲端');
    const job = await buildScheduleJobForChar(char, scope);
    const ahead = char.scheduleAuto?.ahead ?? 1;
    // 到點時刻：提早一天 → 那邊 20:00；當天 → 00:30。從明天的那個時刻起（今天的那一輪本機已經在做了）
    const firstDay = addDaysKey(job.days[0].date, 1);
    const firstSendTime = `${firstDay}T${ahead === 1 ? '20:00:00' : '00:30:00'}`;
    const { uuid } = await ActiveMsgClient.scheduleBackgroundJob({
        kind: SCHEDULE_GENERATE_KIND, charId: char.id, charName: char.name,
        jobKey: scheduleJobKey(char.id), jobId: `schedule-${char.id}`, jobInput: job, credRow,
        temperature: SCHEDULE_LLM_TEMPERATURE, maxTokens: SCHEDULE_LLM_MAX_TOKENS,
        recurring: { firstSendTime, recurrenceType: 'daily', tzId: job.tzId },
    });
    console.log(`${HEADER} ${char.name} 排好了每天 ${ahead === 1 ? '20:00 排明天' : '00:30 排今天'}（任務 ${uuid}）`);
    return { taskUuid: uuid, tzId: job.tzId, at: Date.now() };
};

/** 取消雲端那條（關掉自動生成、或改成只有本機時） */
export const cancelScheduleAutoTask = async (char: CharacterProfile): Promise<void> => {
    const cloud = char.scheduleAuto?.cloud;
    if (!cloud) return;
    await ActiveMsgClient.cancelTask(cloud.taskUuid).catch(e => console.warn(`${HEADER} 取消任務失敗（可能已經沒了）`, e));
    await ActiveMsgClient.clearBackgroundJobInput(scheduleJobKey(char.id)).catch(() => {});
};
