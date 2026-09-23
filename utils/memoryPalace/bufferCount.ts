import type { Message } from '../../types';

/**
 * 純計算：記憶宮殿"未同步"緩衝區條數——即真正能被 pipeline 處理的歷史消息數。
 *
 * 口徑必須和 pipeline 的緩衝區定義一致：
 *   - 排除熱區（最後 hotZoneSize 條永遠留在上下文，不參與處理）
 *   - 排除已處理（id <= hwm）
 *
 * 切勿退回 "id > hwm" 裸過濾——那會把永遠不處理的熱區也算進未同步，
 * UI 會顯示幾百條待處理、用戶點了卻跑不出新水位，等於騙人。
 * 這個坑已經踩過一次，bufferCount.test.ts 把正確口徑釘住了。
 *
 * @param semanticMessages 已過濾成"語義相關"的消息（可不排序，本函數內部按 id 排序）
 * @param hwm 當前高水位標記（id <= hwm 視為已處理）
 * @param hotZoneSize 角色檔位解析出的熱區大小；舊角色默認 200
 */
export function countUnprocessedBufferMessages(
    semanticMessages: Message[],
    hwm: number,
    hotZoneSize = 200,
): number {
    const sorted = [...semanticMessages].sort((a, b) => a.id - b.id);
    const normalizedHotZoneSize = Math.max(0, Math.floor(hotZoneSize));
    if (sorted.length <= normalizedHotZoneSize) return 0;
    const hotZoneStartId = normalizedHotZoneSize === 0
        ? Number.POSITIVE_INFINITY
        : sorted[sorted.length - normalizedHotZoneSize].id;
    let count = 0;
    for (const m of sorted) {
        if (m.id > hwm && m.id < hotZoneStartId) count++;
    }
    return count;
}

/**
 * 一鍵存入時按“用戶眼裡看到的聊天條數”劃邊界，而不是按語義消息條數劃邊界。
 * 這樣“保留最近 10 條”會精確保留最後 10 條原文；圖片、卡片等消息不會讓
 * 紫色水位線與橙色原文範圍錯開。
 */
export function getOneShotTargetHighWaterMark(
    sourceMessages: Message[],
    retainRecentMessages: number,
): number {
    const sortedPrivateMessages = sourceMessages
        .filter(message => !message.groupId)
        .slice()
        .sort((a, b) => a.id - b.id);
    const retained = Math.max(0, Math.floor(retainRecentMessages));
    const targetIndex = sortedPrivateMessages.length - retained - 1;
    return targetIndex >= 0 ? sortedPrivateMessages[targetIndex].id : 0;
}

/** 一鍵存入實際會交給記憶提取管線的語義消息數。 */
export function countOneShotPendingMessages(
    semanticMessages: Message[],
    sourceMessages: Message[],
    hwm: number,
    retainRecentMessages: number,
): number {
    const targetHighWaterMark = getOneShotTargetHighWaterMark(sourceMessages, retainRecentMessages);
    return semanticMessages.filter(message => (
        message.id > hwm && message.id <= targetHighWaterMark
    )).length;
}
