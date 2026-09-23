export interface DateLaunchIntent {
    surface: 'companion' | 'story';
}

type DateLaunchListener = (intent: DateLaunchIntent) => void;

const DATE_LAUNCH_EVENT = 'sullyos:date-launch';
let pending: DateLaunchIntent | null = null;

/**
 * 「見面」App 的輕量直達意圖。
 *
 * pending 負責 App 尚未掛載時的首幀直達；自定義事件負責 DateApp 已經打開時的即時切換。
 * 兩條路徑共用一個意圖，DateApp 應用後 consume，避免影響下一次普通打開。
 */
export const dateLaunch = {
    request(intent: DateLaunchIntent): void {
        pending = intent;
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent<DateLaunchIntent>(DATE_LAUNCH_EVENT, { detail: intent }));
        }
    },
    peek(): DateLaunchIntent | null {
        return pending;
    },
    consume(): DateLaunchIntent | null {
        const value = pending;
        pending = null;
        return value;
    },
    subscribe(listener: DateLaunchListener): () => void {
        if (typeof window === 'undefined') return () => {};
        const handler = (event: Event) => listener((event as CustomEvent<DateLaunchIntent>).detail);
        window.addEventListener(DATE_LAUNCH_EVENT, handler);
        return () => window.removeEventListener(DATE_LAUNCH_EVENT, handler);
    },
};
