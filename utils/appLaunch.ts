/**
 * 從角色名片（components/chat/CharacterCard.tsx，plans/character-card.md）跳去別的 App 用的一次性字條。
 * 跟 utils/characterLaunch.ts 同一個模式：不走 context，只有對方 App 打開那一刻要讀。
 *
 * - calendarLaunch：行事曆直接停在「TA 的」，看的人用 activeCharacterId（呼叫的人先設好）
 * - memoryPalaceLaunch：記憶宮殿直接進這個角色的宮殿，不停在選人頁
 * - bondLaunch：羈絆直接進某段關係的空間（可直接開路線設定頁）
 * - appReturn：那個 App 按返回（OSContext.closeApp）時回到原本的聊天，而不是桌面；只認登記時的那個 App，
 *   中途跑去別的 App 就作廢
 */
import type { BondCollectRequest } from './bond/collect';
import type { AppID } from '../types';

const oneShot = <T>() => {
    let pending: T | null = null;
    return {
        request(intent: T): void { pending = intent; },
        peek(): T | null { return pending; },
        consume(): T | null { const v = pending; pending = null; return v; },
    };
};

export const calendarLaunch = oneShot<{ tab: 'theirs' }>();
export const memoryPalaceLaunch = oneShot<{ charId: string }>();
/** 羈絆：直接進某段關係的空間（plans/bond-batch1.md 3.1）；page 'route' 是直接開路線設定頁 */
export const bondLaunch = oneShot<{ bondId: string; page?: 'home' | 'route' | 'moments' | 'collect'; collect?: BondCollectRequest; itemKey?: string }>();
/**
 * 從羈絆跳回當時那則訊息（plans/bond-batch2.md 6.1）：私聊收到就載入那則附近、捲過去閃一下。
 * 線不是現在的身份時，呼叫端先切身份（setActivePersonaId）再開聊天。
 */
export const chatJumpLaunch = oneShot<{ charId: string; messageId: number }>();
/** 角色私聊（訊息列表裡那頁）：打開這兩人的私聊；有 messageId 就捲到那則（收存回來、拾光跳回來都用它） */
export const pairChatLaunch = oneShot<{ pairId: string; messageId?: number }>();
/** 見面：開那場故事、捲到那則 */
export const dateJumpLaunch = oneShot<{ charId: string; storyId: string; messageId: number }>();

let returnSlot: { app: AppID; back: () => void } | null = null;

export const appReturn = {
    /** 打開 app 之前登記：它關掉時呼叫 back */
    set(app: AppID, back: () => void): void { returnSlot = { app, back }; },
    /** closeApp 用：現在關的是登記的那個就拿走 back，不是就清掉 */
    take(closing: AppID): (() => void) | null {
        const slot = returnSlot;
        returnSlot = null;
        return slot && slot.app === closing ? slot.back : null;
    },
    /** openApp 用：跑去登記以外的 App，字條作廢 */
    forget(opening: AppID): void { if (returnSlot && returnSlot.app !== opening) returnSlot = null; },
};
