/**
 * 私聊開場白（CharacterProfile.greetings 裡勾了私聊的）：一條線還沒有任何私聊訊息時，打開聊天就由角色先傳一段。
 * 好幾段就隨機挑一段；{{char}}／{{user}} 跟見面開場白一樣用 expandGreeting 換（其餘 ST 巨集照規則）。
 * 不叫 AI、不算主動消息；拉黑中的那條線不送（拉黑時任何路徑都不能讓角色傳私聊訊息）。
 */
import type { CharacterProfile } from '../types';
import { expandGreeting, pickGreeting } from './dateExtras';
import { chatGreetingsOf } from './greetings';

export const hasChatGreeting = (char: Pick<CharacterProfile, 'greetings' | 'dateGreetings'> | null | undefined): boolean =>
    chatGreetingsOf(char).some(g => g.text.trim());

/** 要送的那則（content＋metadata）；沒有開場白、拉黑中、換完是空的就回 null */
export function chatGreetingMessage(
    char: Pick<CharacterProfile, 'name' | 'greetings' | 'dateGreetings' | 'chatBlock'>,
    userName: string,
    rng: () => number = Math.random,
): { content: string; metadata: { chatGreeting: true; greetingId: string } } | null {
    if (char.chatBlock) return null;
    const g = pickGreeting(chatGreetingsOf(char), undefined, rng);
    if (!g) return null;
    const content = expandGreeting(g.text, char.name, userName);
    return content ? { content, metadata: { chatGreeting: true, greetingId: g.id } } : null;
}
