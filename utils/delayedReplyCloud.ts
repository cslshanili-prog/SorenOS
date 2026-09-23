import type { APIConfig, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { isAmsg2EnabledForChar } from './amsg2Tasks';
import { markAmsgStateDirty } from './amsgStateSync';
import { AMSG_DELAYED_REPLY_SUBTYPE } from './amsgTaskKinds';
import {
    attachCloudToDelayedReply, buildCloudDelayedReplyInstruction, CLOUD_HANDOFF_DELAY_MS,
    listOverdueCloudDelayedReplies, takeDelayedReply, takeDueDelayedReplies, type PendingDelayedReply,
} from './delayedReply';
import { getReadNoReplyDecision } from './readNoReplyRuntime';

/**
 * 延遲自動回覆 × 主動消息 2.0：把「到點回覆」也交一份給雲端，App 關著也回得來、有推播。
 *
 * 借的是一次性 prompted 任務的殼（跟角色自己排的定時消息同一條排程路），差別在：
 * - 不進任務清單（messageSubtype 標 delayed-reply，面板對帳時擋掉），不佔連發額度；
 * - 「本次任務」指令整段換成「你現在才看到對方的訊息，回他」；
 * - expirePolicy 用 force：用戶正開著聊天也照樣回（那道「用戶在就別打擾」的閘是給主動消息的）；
 * - 時間排在本地 dueAt 之後一分鐘。頁面開著時本地到點先回、順手取消雲端那條；頁面在背景
 *   或關了，就由雲端生成、推播過來。
 * 雲端的包是排任務時打的，之後用戶又傳的訊息靠 amsgStateSync 打髒補傳（那道門認這筆待回）。
 *
 * 不交雲端的情形都留在本地照舊：角色沒開 2.0、沒配 Worker、離到點太近（服務端要求至少提前
 * 一分鐘）、到點那一刻會觸發已讀不回（那要看當下的日程判斷，雲端做不了），或排程失敗。
 */

/** 雲端那條離現在至少要這麼遠：服務端要求 ≥ 60 秒，再留打包上傳的時間。 */
const CLOUD_MIN_LEAD_MS = 150_000;

const handingOff = new Set<string>();
const lastStatusCheck = new Map<string, number>();
const STATUS_CHECK_INTERVAL_MS = 60_000;

const cancelCloudTask = (uuid: string) => {
    ActiveMsgClient.cancelTask(uuid).catch(e => console.warn('[延遲自動回覆] 取消雲端任務失敗', uuid, e));
};

/**
 * 用戶剛傳完訊息、這個角色排好了待回之後調用。
 * 還沒交雲端 → 看條件交一條；已經交了 → 打髒，讓雲端的包帶上這則新訊息。
 */
export async function handoffDelayedReplyToCloud(params: {
    char: CharacterProfile;
    entry: PendingDelayedReply;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig: RealtimeConfig;
    apiConfig: APIConfig;
}): Promise<void> {
    const { char, entry, userProfile, groups, realtimeConfig, apiConfig } = params;
    if (entry.cloud || handingOff.has(char.id)) {
        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
        return;
    }
    if (!isAmsg2EnabledForChar(char) || !char.activeMsg2Config) return;
    const sendAt = entry.dueAt + CLOUD_HANDOFF_DELAY_MS;
    if (sendAt - Date.now() < CLOUD_MIN_LEAD_MS) return;
    const workerUrl = await ActiveMsgStore.getGlobalConfig().then(c => c.workerUrl?.trim()).catch(() => '');
    if (!workerUrl) return;
    const decision = await getReadNoReplyDecision(char, new Date(entry.dueAt)).catch(() => null);
    if (decision) return;

    handingOff.add(char.id);
    try {
        const result = await ActiveMsgClient.scheduleCharacterTask({
            char,
            config: char.activeMsg2Config,
            task: {
                mode: 'prompted',
                firstSendTime: new Date(sendAt).toISOString(),
                recurrenceType: 'none',
                expirePolicy: 'force',
                subtype: AMSG_DELAYED_REPLY_SUBTYPE,
                instruction: buildCloudDelayedReplyInstruction(userProfile.name || ''),
            },
            userProfile, groups, realtimeConfig, apiConfig,
        });
        if (!attachCloudToDelayedReply(char.id, entry.dueAt, { uuid: result.uuid, sendAt })) {
            // 交雲端的這幾秒裡已經回過了（手動回覆 / 本地到點）：剛建的那條不要了
            cancelCloudTask(result.uuid);
            return;
        }
        // 打包之後才落庫的訊息（連發的第二則）補傳一次
        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
    } catch (e) {
        console.warn('[延遲自動回覆] 交給雲端失敗，留在本地回', e);
    } finally {
        handingOff.delete(char.id);
    }
}

/** 這一輪已經在回了（手動回覆、重新生成…）：本地那筆和雲端那條一起作廢。 */
export function cancelDelayedReplyEverywhere(charId: string): void {
    const entry = takeDelayedReply(charId);
    if (entry?.cloud) cancelCloudTask(entry.cloud.uuid);
}

/** 到點、該由本地回的角色（交了雲端但本地搶先的，順手取消雲端那條）。 */
export function takeDueDelayedRepliesForLocal(visible: boolean): string[] {
    return takeDueDelayedReplies(Date.now(), { visible }).map(({ charId, entry }) => {
        if (entry.cloud) cancelCloudTask(entry.cloud.uuid);
        return charId;
    });
}

/**
 * 交了雲端、過點好一陣子還沒收到回覆的：問雲端那條怎麼了。
 * - 還在排隊 / 重試 → 繼續等；
 * - 行沒了 → 已經發過（推播或補收會送到），這筆銷掉；但 Worker 留了這條的跳過紀錄
 *  （last_skip，例如每日上限滿了），或角色的 2.0 已經被關掉（多半是跟著「取消全部」被掐掉），
 *   就改由本地回；
 * - 失敗了 → 本地回。
 * 問不到就下次再問。回傳要由本地回的角色 id。
 */
export async function resolveOverdueCloudDelayedReplies(
    characters: CharacterProfile[],
): Promise<string[]> {
    const now = Date.now();
    const local: string[] = [];
    for (const { charId, entry } of listOverdueCloudDelayedReplies(now)) {
        const uuid = entry.cloud!.uuid;
        if (now - (lastStatusCheck.get(uuid) ?? 0) < STATUS_CHECK_INTERVAL_MS) continue;
        lastStatusCheck.set(uuid, now);
        const char = characters.find(c => c.id === charId);
        try {
            const status = await ActiveMsgClient.getRemoteTaskStatus(uuid);
            if (status.state === 'pending') continue;
            // 行沒了也可能是被 Worker 的閘跳過（主動頻率的每日上限等）：跳過會留一筆 last_skip
            const skipped = status.state === 'gone'
                && (await ActiveMsgClient.readLastSkip(charId).catch(() => null))?.taskUuid === uuid;
            takeDelayedReply(charId);
            lastStatusCheck.delete(uuid);
            if (status.state === 'completed' || skipped || !char || !isAmsg2EnabledForChar(char)) local.push(charId);
        } catch (e) {
            console.warn('[延遲自動回覆] 問不到雲端任務狀態，稍後再問', uuid, e);
        }
    }
    return local;
}
