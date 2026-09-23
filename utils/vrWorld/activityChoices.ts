import type { CharacterProfile, VRRoomId, VRSARActivity } from '../../types';

/** Only executable activities belong here; user-only collections/NPC stories are not destinations. */
export const ORDINARY_ACTIVITIES: { id: VRRoomId; name: string; description: string }[] = [
    { id:'library', name:'圖書館', description:'讀書、留下批註' },
    { id:'theater', name:'劇院', description:'即興寫劇本投稿' },
    { id:'music', name:'聽歌房', description:'點歌、聽歌與銳評' },
    { id:'guestbook', name:'留言簿', description:'發帖、回覆和版聊' },
    { id:'gym', name:'娛樂室', description:'遊戲、學習或隨意玩耍' },
    { id:'postoffice', name:'郵局', description:'寫信、讀信與回信' },
];
export const SAR_ACTIVITIES: { id: VRSARActivity; name: string; description: string }[] = [
    { id:'cabinet', name:'抽芯片演繹', description:'抽臨時芯片，推演故事並寫隨筆' },
    { id:'module-shop', name:'模塊商店', description:'研究、購買或裝載模塊' },
    { id:'fishing', name:'水域釣魚', description:'釣一竿，決定魚獲去留' },
    { id:'market', name:'佈告板', description:'看行情、交易、發需求或留言' },
    { id:'garden', name:'恐龍箱庭', description:'擺弄庭院、續寫小劇場與留便籤' },
];

export function sarActivityPool(char: Pick<CharacterProfile,'vrState'>, gardenAvailable: boolean, manual = false): { id: VRSARActivity; weight: number }[] {
    if (!manual && char.vrState?.excludedAutoRooms?.includes('sar')) return [];
    // Preserve existing probabilities before filtering: garden's 20% replaces part of the shop's 21%.
    const pool: { id: VRSARActivity; weight: number }[] = [
        {id:'fishing',weight:30}, {id:'market',weight:20},
        ...(gardenAvailable ? [{id:'garden' as const,weight:20}] : []),
        {id:'module-shop',weight:gardenAvailable ? 1 : 21}, {id:'cabinet',weight:29},
    ];
    const excluded = manual ? [] : char.vrState?.excludedAutoSARActivities || [];
    return pool.filter(a => !excluded.includes(a.id));
}

export function rollSARActivity(char: Pick<CharacterProfile,'vrState'>, gardenAvailable: boolean, manual = false, forced?: VRSARActivity, random:()=>number = Math.random): VRSARActivity | null {
    // A manual invitation still goes through the selected activity's real preconditions at execution time.
    if (manual && forced) return SAR_ACTIVITIES.some(a=>a.id===forced) ? forced : null;
    const pool = sarActivityPool(char,gardenAvailable,manual);
    if (forced) return pool.some(a=>a.id===forced) ? forced : null;
    if (!pool.length) return null;
    const n = Number(random());
    let cursor = (Number.isFinite(n) ? Math.max(0,Math.min(.999999999,n)) : 0) * pool.reduce((sum,a)=>sum+a.weight,0);
    for (const item of pool) { cursor -= item.weight; if (cursor < 0) return item.id; }
    return pool.at(-1)!.id;
}
