/**
 * 聊天生成的全局廣播事件（對標彼方的 vr-session-start/end）。
 *
 * 背景：Chat App 切走是真 unmount（PhoneShell 按 activeApp switch 渲染），但
 * useChatAI.triggerAI 的異步閉包會繼續跑完並把回覆落庫（本地 fetch 路徑），
 * 情緒評估同理。過去這段"後台生成"對用戶完全不可見——切走就像死了。
 *
 * 這裡定義一組 window CustomEvent，由生成閉包在開始/結束時派發：
 *   - 根級 <ChatBroadcast/>（App.tsx，PhoneShell 之外）監聽並渲染
 *     「xx 正在回應…」「xx 正在感受…」全局橫幅，組件生命週期與 Chat 無關；
 *   - OSContext 監聽 reply 落庫事件，bump lastMsgTimestamp 讓當前掛載的
 *     Chat 重新 reloadMessages，並在用戶不在該會話時補未讀/toast——
 *     與雲端回覆的 'active-msg-received' 回落行為對齊。
 *
 * detail 一律是 { charId, charName }。
 */

export const CHAT_GEN_EVENTS = {
    /** 主回覆生成開始（本地 fetch 與即時對話兩條路徑都算） */
    replyStart: 'chat-gen-reply-start',
    /** 主回覆生成會話結束（triggerAI finally，成功/失敗/即時對話均觸發） */
    replyEnd: 'chat-gen-reply-end',
    /** 本地 fetch 路徑：回覆已全部落庫（後處理管線跑完）。即時對話路徑不發——它走 'active-msg-received' */
    replyArrived: 'chat-gen-reply-arrived',
    /** 情緒評估開始（本地 eval / 主動消息 eval / 上雲點燈） */
    emotionStart: 'chat-gen-emotion-start',
    /** 情緒評估結束（本地路徑自己派發；上雲路徑由下面的 emotionDone 接） */
    emotionEnd: 'chat-gen-emotion-end',
    /**
     * 即時對話的情緒評估有結論了——成功、失敗、雲端點名說這一輪沒成，都算。
     * 名字改不得：它是三方約定的線上事件名
     * （worker 推回後由 activeMsgRuntime 派發，Chat 頁的徽章和全局橫幅各自監聽）。
     * 派發一律走 announceEmotionDone，別再各處手寫字符串。
     */
    emotionDone: 'instant-emotion-done',
    /**
     * 情緒評估失敗（本地 fetch 報錯 / 雲端 worker 空結果 / 輸出解析全滅）。
     * 過去失敗只寫 console.warn，用戶側表現是「情緒不更新但沒任何報錯」，完全沒法自查
     * （真實用戶反饋）。OSContext 監聽本事件彈 toast（每角色帶冷卻），detail.reason 帶人話原因。
     */
    emotionFailed: 'chat-gen-emotion-failed',
} as const;

export interface ChatGenDetail {
    charId: string;
    charName: string;
    /** emotionFailed 專用：失敗原因（人話，可直接展示給用戶） */
    reason?: string;
    /**
     * 這一條最長掛多久（毫秒）。只有全局橫幅讀它，用來給「結束信號沒來」兜底。
     * 不給就用橫幅自己那一檔默認值。
     *
     * 之所以由派發方說了算：同一種生成在不同路徑上的時長天差地別——本地評估幾秒鐘，
     * 交給自己那台 worker 的即時對話可以跑滿十分鐘。橫幅這邊猜不出來，也不該猜。
     */
    ttlMs?: number;
}

export function announceChatGen(event: string, detail: ChatGenDetail): void {
    try {
        window.dispatchEvent(new CustomEvent(event, { detail }));
    } catch { /* SSR / 測試環境無 window */ }
}

/**
 * 上雲的情緒評估有結論了 —— 熄滅 Chat 頁的「情緒更新中」徽章和全局橫幅。
 *
 * 成功、失敗、雲端點名說這一輪沒成，都要發：這是那盞燈唯一的正常熄滅信號，
 * 不發的話用戶只能乾等安全網超時，中途還會看到一句誤導的提示。
 */
export function announceEmotionDone(charId: string): void {
    try {
        window.dispatchEvent(new CustomEvent(CHAT_GEN_EVENTS.emotionDone, { detail: { charId } }));
    } catch { /* SSR / 測試環境無 window */ }
}

// ─── 當前聊天視圖快照 ───
// ChatBroadcast 掛在 OSProvider 之外拿不到 activeApp/activeCharacterId，
// 由 OSContext 在視圖變化時寫入這個模塊級快照（同 MusicContext 的
// loadMusicPlaybackSnapshot 模式），並派發 CHAT_VIEW_CHANGED_EVENT 觸發重渲染。
// 用途：用戶正開著某角色的聊天頁時，該角色的橫幅不顯示（頁內已有打字指示），
// 切走的瞬間橫幅接棒出現。

export const CHAT_VIEW_CHANGED_EVENT = 'chat-view-changed';

interface ChatViewSnapshot {
    /** 當前是否開著 Chat App */
    chatOpen: boolean;
    /** Chat App 當前會話的角色 id（chatOpen=false 時無意義） */
    charId: string | null;
}

let chatView: ChatViewSnapshot = { chatOpen: false, charId: null };

export function setChatViewSnapshot(chatOpen: boolean, charId: string | null): void {
    if (chatView.chatOpen === chatOpen && chatView.charId === charId) return;
    chatView = { chatOpen, charId };
    try {
        window.dispatchEvent(new CustomEvent(CHAT_VIEW_CHANGED_EVENT));
    } catch { /* SSR */ }
}

export function getChatViewSnapshot(): ChatViewSnapshot {
    return chatView;
}
