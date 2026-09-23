/**
 * 「角色在後台改了自己的日程」這條結果的形狀 —— 純函數零依賴，瀏覽器與 Cloudflare
 * Worker 共用同一份（同 utils/scheduleChangeParse.ts 的路子）。
 *
 * 為什麼日程改動要單獨走一條結果通道：一次 fire 只要沒寫出正文就整條不發（空正文的
 * 推送橫幅是空白的，而訂閱按 userVisibleOnly 建，發一條不彈的就是跟瀏覽器違約）。
 * 別的副作用丟了就丟了——角色一個字沒說卻在小紅書點了贊，本身就穿幫，該等客戶端上線
 * 時主動拉。日程改動不一樣：它不是做給用戶看的動作，是角色在糾正自己的表。丟掉的話，
 * 下一次 fire 讀到的還是那條舊安排，角色會反覆想改又反覆改不掉。
 *
 * 所以走 `ctx.emitResult`：落進服務端收件箱（客戶端下次 `GET /outbox?since=` 一定
 * 拿得到），不佔聊天正文，也不需要為它硬發一條沒內容的推送。
 */

/** 一條日程改動：把某個時段換成另一件事。與 scheduleChangeParse 的同名結構一致。 */
export interface AmsgScheduleChangeItem {
    startTime: string;
    activity: string;
}

/** 結果的名字（`emitResult` 的 resultKind），客戶端按它分流。 */
export const SCHEDULE_CHANGE_RESULT_KIND = 'schedule-change';

export interface AmsgScheduleChangeResult {
    resultKind: typeof SCHEDULE_CHANGE_RESULT_KIND;
    v: 1;
    charId: string;
    /**
     * 這句話**說出口**的時刻（epoch 毫秒）。
     *
     * 結果可能在收件箱裡躺一夜，用戶第二天早上才打開 App。按拿到它的那一刻判的話，
     * 昨晚那句「22:00 改成陪你聊天」會落到今天的 22:00 上——角色昨晚的一句話，改了
     * 今天的安排。客戶端拿這個時刻判時段，隔天的整批丟棄。
     */
    spokenAt: number;
    directives: AmsgScheduleChangeItem[];
}

/** 組一條結果（版本號只有這一處寫，別在調用點手抄）。 */
export function buildScheduleChangeResult(args: {
    charId: string;
    spokenAt: number;
    directives: AmsgScheduleChangeItem[];
}): AmsgScheduleChangeResult {
    return {
        resultKind: SCHEDULE_CHANGE_RESULT_KIND,
        v: 1,
        charId: args.charId,
        spokenAt: args.spokenAt,
        directives: args.directives.map((d) => ({ startTime: d.startTime, activity: d.activity })),
    };
}

/** 讀回一條結果；形狀對不上返回 null（客戶端據此銷帳丟棄並留日誌，不改任何表）。 */
export function parseScheduleChangeResult(raw: unknown): AmsgScheduleChangeResult | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    if (o.resultKind !== SCHEDULE_CHANGE_RESULT_KIND || o.v !== 1) return null;
    if (typeof o.charId !== 'string' || !o.charId) return null;
    if (typeof o.spokenAt !== 'number' || !Number.isFinite(o.spokenAt)) return null;
    if (!Array.isArray(o.directives)) return null;

    const directives: AmsgScheduleChangeItem[] = [];
    for (const d of o.directives) {
        if (!d || typeof d !== 'object') continue;
        const row = d as Record<string, unknown>;
        if (typeof row.startTime !== 'string' || typeof row.activity !== 'string') continue;
        if (!row.startTime.trim() || !row.activity.trim()) continue;
        directives.push({ startTime: row.startTime, activity: row.activity });
    }
    // 一條有效的都沒有 = 這條結果沒有內容可執行，當形狀壞了處理（銷帳丟棄）。
    if (directives.length === 0) return null;

    return {
        resultKind: SCHEDULE_CHANGE_RESULT_KIND,
        v: 1,
        charId: o.charId,
        spokenAt: o.spokenAt,
        directives,
    };
}
