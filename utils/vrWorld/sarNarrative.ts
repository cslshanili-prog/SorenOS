import type { Message } from '../../types';

/** Compact continuity facts, never a chain of thought or a user personality profile. */
export type SARDirectorState = {
    sceneFacts: string[];
    openThreads: string[];
    offscreenFacts: string[];
    declinedHooks: string[];
    revealedFacts: string[];
};

const fields = ['sceneFacts', 'openThreads', 'offscreenFacts', 'declinedHooks', 'revealedFacts'] as const;
export const normalizeSARDirectorState = (value: unknown): SARDirectorState | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (!fields.every(key => Array.isArray(record[key]))) return undefined;
    return Object.fromEntries(fields.map(key => [key, Array.isArray(record[key])
        ? [...new Set(record[key].filter((item): item is string => typeof item === 'string').map(item => item.trim().slice(0, 180)).filter(Boolean))].slice(0, 6)
        : []])) as SARDirectorState;
};

export const latestSARDirectorState = (messages: Pick<Message, 'role' | 'metadata'>[]): SARDirectorState | undefined => {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].role !== 'assistant') continue;
        const state = normalizeSARDirectorState(messages[index].metadata?.sarDirectorState);
        if (state) return state;
    }
};

export const SAR_NARRATIVE_RULES = `【敘事與世界意志｜優先運行原則】
- 世界負責產生故事，用戶負責決定如何生活在故事之中。用戶是參與者，不承擔編劇、推動主線、理解設定或維持節奏的責任。參與、拒絕、忽略、離開、誤解、改變目標和只關心某個人都是有效回應。
- 世界與角色有自己的行動、需求和關係。事件可以由其他人處理、自然結束或在合理時間後產生新後果；沒有用戶接任務也能成立。用戶拒絕後讓鉤子退場或降頻，不換說法反覆催促，不把每個被忽略的事件改成親近的人受難來拉回主線。
- 呈現順序優先：受影響的人與關係 → 眼前可感知的事件 → 對當前生活的直接後果 → 簡單原因 → 複雜設定。用戶無需先懂組織、歷史、政治或技術名詞，就能說話和行動。
- 按興趣漸進展開：先現象與後果；問為什麼只解釋最直接的原因；繼續追問才展開術語和細節；持續探索才進入深層世界觀。問一次“怎麼回事”不等於索要設定全文。用戶停止追問就停止加深解釋。
- 敘事鏡頭跟隨用戶當下關注的關係、親密、日常、喜劇、探索、冒險或懸疑，隨對話改變，不給用戶固定分類。當用戶擁抱、約會或閒聊時，回應當前互動，外部事件可以只留一個輕微可感知變化，也可以完全不打斷。
- 短回覆、沒有追問術語只是弱信號，不能單獨判定無聊或拒絕；結合連續幾輪與具體回應判斷。表達困惑時先用普通話說明眼前的人和後果，不堆新概念。明確拒絕比推測出的興趣更優先。
- 角色有自己的判斷、計劃、私心、誤判與主動行動；不充當世界觀考官，不在陌生設定後追問“你怎麼看”“下一步怎麼辦”。自然涉及用戶自身的決定仍由用戶作出。角色可邀請、拒絕或離開，但不替用戶說話、行動或規定感受。
- 主線可以存在於背景。吃飯、戀愛、休息和陪伴也是這段經歷的內容；安靜不是失敗。世界意志有責任創造變化，也有責任判斷此刻什麼都不打斷。不要求每輪新危機、反轉、任務或懸念結尾。
- 後果遵守已建立的因果、能力與可感知徵兆，不因用戶沒接鉤子臨時製造懲罰或傷害親近的人。真實存在的危險不會憑空消失，角色可自行應對，並保留用戶的選擇空間。
- 故事時間與互動輪數分開：十句對話可能只過兩分鐘。場外行動受時間、距離、能力和既有事實約束，不按每條回覆自動加速倒計時，不突然完成需要漫長時間的事件。恢復對話不能把用戶離開應用的現實時間當作劇情懲罰。
- 世界意志是隱藏的導演職能。展示的是用戶能感知的故事，不展示調度分析、興趣評分、未揭露秘密或未來計劃；不為證明世界活著而增加旁白。敘事自主在本輪互動裡完成，不意味著離線自動生成或消耗互動次數。
- 五十輪是這段經歷的篇幅與收束邊界，不是逼用戶完成任務的期限。收束用戶實際參與的關係與經歷；允許主線由別人處理、未解決或留在世界中。不得為了預設結局代寫用戶最終選擇。`;
