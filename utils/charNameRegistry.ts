/**
 * 模塊級 charId → 角色名 註冊表 — 與 MusicContext 的播放快照同一模式。
 *
 * 動機：私聊 prompt 的群聊背景注入（chatPrompts.buildSystemPromptParts）需要把
 * 群消息的發言人標成真實角色名，但它位於 utils 層、拿不到 OSContext 的 characters
 * state，而給 buildChatRequestPayload 的所有調用方（useChatAI / 主動消息 /
 * worldHome / 彼方 …）逐一穿參代價太高。OSProvider 在 characters 變化時把
 * 名字表寫到這裡，utils 層按需讀取。
 */

let __charNames: Record<string, string> = {};

export const setCharNameRegistry = (chars: Array<{ id: string; name: string }>): void => {
    const next: Record<string, string> = {};
    for (const c of chars) {
        if (c?.id && c?.name) next[c.id] = c.name;
    }
    __charNames = next;
};

export const getCharNameById = (id: string | undefined | null): string | null =>
    (id && __charNames[id]) || null;
