/**
 * “繼續”在記錄裡只保留一個簡短、可讀的用戶側佔位；真正交給模型的調度詞
 * 按模式單獨構造，避免技術指令汙染沉浸式閱讀、導出和角色長期記憶。
 */
export const MEETING_CONTINUE_DISPLAY_TEXT = '（繼續）';

const safeName = (name: string | null | undefined, fallback: string): string => name?.trim() || fallback;

export const buildInPersonContinueInstruction = (
    userName: string | null | undefined,
    characterName: string | null | undefined,
): string => {
    const user = safeName(userName, '用戶');
    const character = safeName(characterName, '角色');
    return `[繼續當前見面]
本輪${user}沒有主動說話，也沒有采取新的行動。這不代表離場、結束或切回線上聊天：${user}與${character}仍然真實地待在同一物理空間，正在面對面共處。
請嚴格沿用當前見面模式已經設定的角色、關係、場景、文風、敘事人稱與視覺小說格式，由${character}根據自己的性格、意願和眼前正在發生的事主動把這一刻繼續下去。加強真實陪伴感：讓角色通過自然的注視、距離、動作、停頓、環境互動或主動開口陪在${user}身邊，並讓相處產生一項具體的新變化，而不是遠程發消息、原地等待或反問${user}接下來要做什麼。
不要解釋、複述或在正文中暴露這條調度指令；不要擅自替${user}補寫新的主動行為。`;
};

export const buildStoryContinueInstruction = (identityName: string | null | undefined): string => {
    const identity = safeName(identityName, '當前用戶側角色');
    return `[繼續當前劇情]
本輪${identity}沒有新增主動行為。把這視為故事中的一次自然留白，不代表場景結束，也不要求用戶補充輸入。
請嚴格沿用當前劇情已經啟用的原生預設及其文風、敘事視角、格式規則、轉述檔位和“用戶執筆權”邊界繼續下一回合。讓其他角色的自身目標、現場時間、既有因果和已經啟動的後果主動向前運行，形成新的動作、信息、關係變化或局面轉向；不要切換成普通聊天，不要停下來詢問${identity}要做什麼。
不要解釋、複述或在正文中暴露這條調度指令。`;
};
