/**
 * 聊天語言 ·「先寫再翻」的執行層（plans/chat-language.md 第 2 批）。
 *
 * 回覆存好之後，把這一輪新存的 TA 的文字氣泡交給翻譯 API，改寫成
 * `原文\n%%BILINGUAL%%\n譯文`（氣泡、語音、引用都認這個格式）。
 * 翻不成的在 metadata 標 `translationFailed`，氣泡下面給「沒翻成，點一下再翻」。
 */
import type { APIConfig, ChatLanguageConfig, Message } from '../types';
import { DB } from './db';
import { joinBilingual, needsPostTranslation, resolveChatLanguage } from './chatLanguage';
import { translateTexts } from './translateApi';

type LineArg = Parameters<typeof DB.getRecentMessagesByCharId>[0];

const isTranslatable = (m: Message): boolean =>
    m.role === 'assistant' && m.type === 'text' && typeof m.content === 'string' && needsPostTranslation(m.content);

/** 翻一批氣泡並寫回；回傳翻成的則數。失敗的標記 translationFailed（不丟錯）。 */
export async function translateMessagesInPlace(messages: Message[], to: string, apiConfig: APIConfig): Promise<number> {
    const targets = messages.filter(m => typeof m.id === 'number' && isTranslatable(m));
    if (!targets.length) return 0;
    try {
        const out = await translateTexts(targets.map(m => m.content), to, apiConfig);
        for (let i = 0; i < targets.length; i++) {
            const m = targets[i];
            const translated = out[i]?.trim();
            if (!translated) continue;
            await DB.updateMessage(m.id as number, joinBilingual(m.content, translated));
            if (m.metadata?.translationFailed) {
                await DB.updateMessageMetadata(m.id as number, prev => {
                    const { translationFailed: _drop, ...rest } = prev || {};
                    return rest;
                });
            }
        }
        return targets.length;
    } catch (e: any) {
        const reason = String(e?.message || '翻譯失敗').slice(0, 120);
        for (const m of targets) {
            await DB.updateMessageMetadata(m.id as number, prev => ({ ...(prev || {}), translationFailed: reason })).catch(() => {});
        }
        return 0;
    }
}

/**
 * 這一輪回覆存好之後呼叫：只翻 `sinceTs` 之後存的 TA 的文字氣泡。
 * 角色沒開「先寫再翻」就什麼都不做。
 */
export async function postTranslateRecentReplies(
    lineArg: LineArg,
    sinceTs: number,
    chatLanguage: ChatLanguageConfig | undefined,
    apiConfig: APIConfig,
): Promise<number> {
    const lang = resolveChatLanguage(chatLanguage);
    if (!lang.postTranslate || !lang.translateTo) return 0;
    const recent = await DB.getRecentMessagesByCharId(lineArg, 40);
    const fresh = recent.filter(m => (m.timestamp || 0) >= sinceTs);
    return translateMessagesInPlace(fresh, lang.translateTo, apiConfig);
}

/**
 * 雲端回覆（即時對話、主動消息）收件後補譯文：雲端一律只照說話語言寫，
 * 有設翻譯的角色在這裡翻（不管選的是順便翻還是先寫再翻）。只翻這一條 push 拆出來的氣泡。
 */
export async function translateCloudReply(
    lineArg: LineArg,
    pushMessageId: string | undefined,
    chatLanguage: ChatLanguageConfig | undefined,
    apiConfig: APIConfig,
): Promise<number> {
    const lang = resolveChatLanguage(chatLanguage);
    if (!lang.translating || !lang.translateTo || !pushMessageId) return 0;
    const recent = await DB.getRecentMessagesByCharId(lineArg, 40);
    const fromPush = recent.filter(m => (m.metadata as any)?.activeMsg2?.messageId === pushMessageId);
    return translateMessagesInPlace(fromPush, lang.translateTo, apiConfig);
}
