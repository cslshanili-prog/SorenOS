/**
 * 日程自動生成的本機那條路（plans/calendar.md 第 5 批）：頁面開著時每幾分鐘看一次，
 * 該排的（今天沒有／那邊 20:00 之後明天還沒有／這週有缺）就排，一次只跑一個人、一天最多試兩次。
 * 角色排了雲端任務的，本機只補今天的（明天交給雲端）；順手每天刷一次雲端的 standing job。
 */

import type { CharacterProfile, GroupProfile, RealtimeConfig, ScheduleAutoConfig, UserProfile } from '../types';
import { DB } from './db';
import { isAltChar } from './charAlt';
import { addDaysKey } from './amsgScheduleJob';
import { generateScheduleFor, generateWeekFor, personTodayKey } from './scheduleGenerator';
import { isScheduleFeatureOn } from './scheduleFeature';
import { charSchedulePerson, personaSchedulePerson, type SchedulePerson } from './schedulePerson';
import { resolveCharacterMeterApi } from './characterApi';
import { resolveUserProfileForChar, REAL_IDENTITY_PERSONA_ID } from './userPersona';
import { markAmsgStateDirty } from './amsgStateSync';
import { nowInTimeZone } from './timezone';

const HEADER = '📅 [ScheduleAuto]';
/** 提早一天：那邊幾點之後才排明天 */
export const AHEAD_FROM_HOUR = 20;
const ATTEMPT_KEY = 'soren_schedule_auto_attempts_v1';
const REFRESH_KEY = 'soren_schedule_auto_cloud_refresh_v1';
const MAX_ATTEMPTS_PER_DAY = 2;
const RETRY_GAP_MS = 60 * 60 * 1000;

interface AttemptRecord { [key: string]: { n: number; at: number } }
const readAttempts = (): AttemptRecord => { try { return JSON.parse(localStorage.getItem(ATTEMPT_KEY) || '{}') || {}; } catch { return {}; } };
const writeAttempts = (r: AttemptRecord) => { try { localStorage.setItem(ATTEMPT_KEY, JSON.stringify(r)); } catch { /* 存不了就算了 */ } };

export interface AutoTarget {
    person: SchedulePerson;
    auto: ScheduleAutoConfig;
    /** 'day' 時要排的那天；'week' 時是起點 */
    dateKey: string;
    mode: 'day' | 'week';
    /** 角色排了雲端任務：本機只補今天 */
    cloud: boolean;
}

/** 純判斷：這個人此刻該不該排、排哪天（exists 回這天有沒有日程） */
export const decideAutoTarget = (person: SchedulePerson, auto: ScheduleAutoConfig | undefined, now: Date, cloud: boolean): { dateKey: string; mode: 'day' | 'week' } | null => {
    if (!auto?.enabled) return null;
    const local = nowInTimeZone(person.timezone, now);
    const today = personTodayKey(person, now);
    if (auto.every === 'week' && !cloud) return { dateKey: today, mode: 'week' };
    // 雲端負責明天；本機只在今天還沒排時補今天
    if (cloud) return { dateKey: today, mode: 'day' };
    if (auto.ahead === 1 && local.getHours() >= AHEAD_FROM_HOUR) return { dateKey: addDaysKey(today, 1), mode: 'day' };
    return { dateKey: today, mode: 'day' };
};

const attemptKey = (person: SchedulePerson, dateKey: string, mode: string) => `${person.scheduleId}|${mode}|${dateKey}`;

export interface ScheduleAutoScope {
    characters: CharacterProfile[];
    userProfileBase: UserProfile;
    apiConfig: { baseUrl: string; apiKey: string; model: string };
    groups: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
}

let running = false;

/** 一次 tick：找出該排的、排第一個；雲端的 standing job 每天刷一次 */
export const runScheduleAutoTick = async (scope: ScheduleAutoScope, now = new Date()): Promise<void> => {
    if (running) return;
    running = true;
    try {
        const people: Array<{ person: SchedulePerson; auto: ScheduleAutoConfig | undefined; api: ScheduleAutoScope['apiConfig']; userProfile: UserProfile; char?: CharacterProfile }> = [];
        for (const c of scope.characters) {
            if (isAltChar(c) || !isScheduleFeatureOn(c) || !c.scheduleAuto?.enabled) continue;
            people.push({ person: charSchedulePerson(c), auto: c.scheduleAuto, api: resolveCharacterMeterApi(c, scope.apiConfig as any), userProfile: resolveUserProfileForChar(scope.userProfileBase, c), char: c });
        }
        const keys = [REAL_IDENTITY_PERSONA_ID, ...(scope.userProfileBase.personas || []).map(p => p.id)];
        for (const key of keys) {
            const auto = key === REAL_IDENTITY_PERSONA_ID ? scope.userProfileBase.scheduleAuto : scope.userProfileBase.personas?.find(p => p.id === key)?.scheduleAuto;
            if (!auto?.enabled) continue;
            people.push({ person: personaSchedulePerson(scope.userProfileBase, key), auto, api: scope.apiConfig, userProfile: scope.userProfileBase });
        }
        if (!people.length) return;
        if (!scope.apiConfig.apiKey && people.every(p => !p.api.apiKey)) return;

        const attempts = readAttempts();
        for (const entry of people) {
            const cloud = !!entry.char?.scheduleAuto?.cloud;
            const target = decideAutoTarget(entry.person, entry.auto, now, cloud);
            if (!target) continue;
            const key = attemptKey(entry.person, target.dateKey, target.mode);
            const rec = attempts[key];
            if (rec && (rec.n >= MAX_ATTEMPTS_PER_DAY || now.getTime() - rec.at < RETRY_GAP_MS)) continue;
            if (target.mode === 'day') {
                const has = await DB.getDailySchedule(entry.person.scheduleId, target.dateKey).catch(() => null);
                if (has) continue;
            } else {
                const missing = await Promise.all(Array.from({ length: 7 }, (_, i) => DB.getDailySchedule(entry.person.scheduleId, addDaysKey(target.dateKey, i)).catch(() => null)));
                if (missing.every(Boolean)) continue;
            }
            if (!entry.api.apiKey) continue;
            attempts[key] = { n: (rec?.n || 0) + 1, at: now.getTime() };
            writeAttempts(attempts);
            console.log(`${HEADER} ${entry.person.name} ${target.mode === 'week' ? `這週（${target.dateKey} 起）` : target.dateKey} 還沒排，本機排`);
            try {
                if (target.mode === 'week') await generateWeekFor(entry.person, entry.userProfile, entry.api, { startKey: target.dateKey });
                else await generateScheduleFor(entry.person, entry.userProfile, entry.api, { dateKey: target.dateKey, purpose: '自動生成日程' });
                if (entry.char) markAmsgStateDirty({ char: entry.char, userProfile: entry.userProfile, groups: scope.groups, realtimeConfig: scope.realtimeConfig });
            } catch (e) {
                console.warn(`${HEADER} ${entry.person.name} 自動生成失敗`, e);
            }
            break; // 一次 tick 只排一個人，下一輪再來
        }

        // 雲端的 standing job：每天刷一次（約定、待辦、出行會變）
        await refreshCloudJobsDaily(scope, people.filter(p => p.char?.scheduleAuto?.cloud).map(p => p.char!), now);
    } finally {
        running = false;
    }
};

const refreshCloudJobsDaily = async (scope: ScheduleAutoScope, chars: CharacterProfile[], now: Date) => {
    if (!chars.length) return;
    let done: Record<string, string> = {};
    try { done = JSON.parse(localStorage.getItem(REFRESH_KEY) || '{}') || {}; } catch { /* 空 */ }
    const today = now.toISOString().slice(0, 10);
    const due = chars.filter(c => done[c.id] !== today);
    if (!due.length) return;
    const { refreshScheduleJobInput } = await import('./scheduleAutoCloud');
    for (const c of due) {
        try {
            await refreshScheduleJobInput(c, { userProfileBase: scope.userProfileBase, apiConfig: scope.apiConfig, groups: scope.groups, realtimeConfig: scope.realtimeConfig });
            done[c.id] = today;
        } catch (e) {
            console.warn(`${HEADER} ${c.name} 的雲端輸入沒刷成（下次 tick 再試）`, e);
        }
    }
    try { localStorage.setItem(REFRESH_KEY, JSON.stringify(done)); } catch { /* 空 */ }
};
