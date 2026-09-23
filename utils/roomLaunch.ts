/**
 * 「進小屋意圖」輕量 store（module-level，無 React 依賴）。
 *
 * openApp(AppID.Room) 只能打開小屋 App、無法指定進哪個分區 / 是否直接開夢境。
 * 桌面主題（TamagotchiHome）的世界化入口（家園門、像素電視、床頭夢境…）需要
 * 「打開小屋 App 並落到指定 tab / 指定角色 / 直接開夢境」——用這個 store 傳意圖：
 * 調用方先 request(...) 再 openApp(Room)，RoomApp 掛載時 consume() 一次並應用。
 */

export interface RoomLaunchIntent {
    charId?: string;
    tab?: 'room' | 'worldHome' | 'pixelHome';
    /** 進該角色房間後直接打開夢境演出 */
    openDream?: boolean;
}

let pending: RoomLaunchIntent | null = null;

export const roomLaunch = {
    request(intent: RoomLaunchIntent): void {
        pending = intent;
    },
    /** 只讀，不清空——供 useState 惰性初始化把首幀就渲染成目標視圖（避免閃一下 select）。 */
    peek(): RoomLaunchIntent | null {
        return pending;
    },
    /** 取出並清空（只應用一次，避免下次進小屋還殘留舊意圖）。 */
    consume(): RoomLaunchIntent | null {
        const v = pending;
        pending = null;
        return v;
    },
};
