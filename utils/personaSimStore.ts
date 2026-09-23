// 全局「人格模擬」演出生成狀態。
// 放在模塊作用域而非 CheckPhone 內部，這樣：
//   1. 生成中即使離開查手機 App（甚至切到別的 OS App），狀態/提示依舊存在；
//   2. PhoneShell 裡的全局指示條可以隨處顯示進度，點一下深鏈回到演出。
import { useSyncExternalStore } from 'react';
import type { SimState } from '../apps/PersonaSim';

export type GlobalSimState = SimState & {
    charId?: string;
    charName?: string;
    deepLink?: boolean; // 用戶點了全局指示條，請求 CheckPhone 直接進入該演出
};

let state: GlobalSimState = { status: 'idle' };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export const personaSimStore = {
    get: (): GlobalSimState => state,
    set: (s: GlobalSimState) => { state = s; emit(); },
    reset: () => { state = { status: 'idle' }; emit(); },
    requestOpen: () => { state = { ...state, deepLink: true }; emit(); },
    clearDeepLink: () => { if (state.deepLink) { state = { ...state, deepLink: false }; emit(); } },
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
};

export function usePersonaSim(): GlobalSimState {
    return useSyncExternalStore(personaSimStore.subscribe, personaSimStore.get, personaSimStore.get);
}
