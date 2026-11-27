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
import type { BondRefMeta } from './bond/bondRef';
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
/**
 * 購物中心（桌面那個）：從羈絆的「打算送」按「去買」（plans/bond-batch5.md 2.3）——
 * 那件放進購物車、給誰預設 TA、留言預設是你寫的那句；這張單記在那條線上（lineKey），卡片也寫進那條線的私聊。
 */
export const mallLaunch = oneShot<{ recipientCharId: string; lineKey: string; productName?: string; note?: string }>();
/** 羈絆：直接進某段關係的空間（plans/bond-batch1.md 3.1）；page 'route' 是直接開路線設定頁 */
export const bondLaunch = oneShot<{ bondId: string; page?: 'home' | 'route' | 'moments' | 'collect'; collect?: BondCollectRequest; itemKey?: string; essayId?: string;
    /** 心意（第 3 批）：直接開哪一格、哪一題、哪張紙條、哪天的日記 */
    heart?: 'diary' | 'question' | 'note'; questionId?: string; slipId?: string; diaryDate?: string;
    /** 約定（第 4 批）：直接開那張願望、約定、默契、里程碑 */
    pact?: { kind: 'wish' | 'promise' | 'habit' | 'milestone'; entryId: string };
    /** 珍藏（第 5 批）：直接開那件禮物 */
    giftKey?: string;
    /** 珍藏：直接開那封信 */
    letterId?: string;
    /** 珍藏：直接開那封留給以後 */
    capsuleId?: string }>();
/**
 * 從羈絆跳回當時那則訊息（plans/bond-batch2.md 6.1）：私聊收到就載入那則附近、捲過去閃一下。
 * 線不是現在的身份時，呼叫端先切身份（setActivePersonaId）再開聊天。
 */
export const chatJumpLaunch = oneShot<{ charId: string; messageId: number }>();
/** 角色私聊（訊息列表裡那頁）：打開這兩人的私聊；有 messageId 就捲到那則（收存回來、拾光跳回來都用它） */
export const pairChatLaunch = oneShot<{ pairId: string; messageId?: number }>();
/** 帶去聊聊（plans/bond-batch2.md 6.2）：打開私聊時輸入框上方掛著這張卡；線由呼叫端先切好 */
export const chatBondRefLaunch = oneShot<{ charId: string; ref: BondRefMeta }>();
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
    /** 這個 App 有沒有登記回去的路（從別處直接開到某一頁時，返回就該回原處） */
    pending(app: AppID): boolean { return !!returnSlot && returnSlot.app === app; },
    /** openApp 用：跑去登記以外的 App，字條作廢 */
    forget(opening: AppID): void { if (returnSlot && returnSlot.app !== opening) returnSlot = null; },
};
