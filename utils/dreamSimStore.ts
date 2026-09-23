// 全局「夢境」生成狀態。
// 放在模塊作用域而非 DreamTheater 內部，這樣：
//   1. 生成中即使離開小屋 App（甚至切到別的 OS App），狀態/提示依舊存在；
//   2. PhoneShell 裡的全局指示條可以隨處顯示進度，點一下深鏈回到那場夢。
import { useSyncExternalStore } from 'react';
import type { DreamScript } from '../types';

export type DreamGenState =
    | { status: 'idle' }
    | { status: 'loading'; charId: string; charName: string }
    | { status: 'ready'; charId: string; charName: string; script: DreamScript }
    | { status: 'error'; charId: string; charName: string };

export type GlobalDreamState = DreamGenState & {
    deepLink?: boolean; // 用戶點了全局指示條，請求小屋直接進入那場夢
};

let state: GlobalDreamState = { status: 'idle' };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export const dreamSimStore = {
    get: (): GlobalDreamState => state,
    set: (s: GlobalDreamState) => { state = s; emit(); },
    reset: () => { state = { status: 'idle' }; emit(); },
    requestOpen: () => { state = { ...state, deepLink: true }; emit(); },
    clearDeepLink: () => { if (state.deepLink) { state = { ...state, deepLink: false }; emit(); } },
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
};

export function useDreamSim(): GlobalDreamState {
    return useSyncExternalStore(dreamSimStore.subscribe, dreamSimStore.get, dreamSimStore.get);
}
