import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';

export const CHAT_AUTO_REPLY_DELAY_MS = 2000;

interface Options {
    enabled: boolean;
    conversationId: string | null;
    active: boolean;
    blocked: boolean;
    generating: boolean;
    onGenerate: () => void;
}

const newWork = () => ({ pending: false, sends: new Set<symbol>(), cancelVersion: 0 });

/** 只處理本次聊天實際發送的消息；歷史加載、切角色和取消都不會補觸發。 */
export function useChatAutoReply(options: Options) {
    const current = useRef(options);
    useLayoutEffect(() => { current.current = options; });
    const workRef = useRef(newWork());
    const [revision, refresh] = useReducer(n => n + 1, 0);
    const [seconds, setSeconds] = useState<number | null>(null);
    const [visible, setVisible] = useState(() => !document.hidden);

    const cancel = useCallback(() => {
        const work = workRef.current;
        work.pending = false;
        work.cancelVersion++;
        setSeconds(null);
        refresh();
    }, []);

    useLayoutEffect(() => {
        workRef.current = newWork();
        setSeconds(null);
        refresh();
        return () => { workRef.current = newWork(); };
    }, [options.conversationId, options.enabled, options.active]);

    // 手動閃電、重生成或其他生成入口已經接手時，取消尚未執行的自動回覆。
    useLayoutEffect(() => {
        if (options.generating) cancel();
    }, [options.generating, cancel]);

    useEffect(() => {
        const onVisibility = () => setVisible(!document.hidden);
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, []);

    // 從發送開始就暫停計時，直到圖片處理、落庫和聊天刷新都結束。
    // 返回的完成函數綁定本次會話；切走或取消後，晚到的結果不會重新啟動倒計時。
    const beginSend = useCallback((conversationId: string | null) => {
        if (!current.current.enabled || !current.current.active || conversationId !== current.current.conversationId) {
            return (_sent: boolean) => {};
        }
        const work = workRef.current;
        const token = Symbol();
        const version = work.cancelVersion;
        work.sends.add(token);
        setSeconds(null);
        refresh();
        return (sent: boolean) => {
            if (workRef.current !== work || !work.sends.delete(token)) return;
            if (sent && version === work.cancelVersion) work.pending = true;
            refresh();
        };
    }, []);

    useEffect(() => {
        const work = workRef.current;
        const ready = () => {
            const latest = current.current;
            return workRef.current === work && work.pending && work.sends.size === 0
                && latest.enabled && latest.active && !latest.blocked && !latest.generating
                && !document.hidden;
        };
        if (!visible || !ready()) {
            setSeconds(null);
            return;
        }
        setSeconds(2);
        const tick = window.setTimeout(() => { if (ready()) setSeconds(1); }, 1000);
        const timer = window.setTimeout(() => {
            if (!ready()) return;
            cancel();
            current.current.onGenerate();
        }, CHAT_AUTO_REPLY_DELAY_MS);
        return () => { window.clearTimeout(tick); window.clearTimeout(timer); };
    }, [revision, visible, options.enabled, options.active, options.blocked, options.generating, options.conversationId, cancel]);

    return { seconds, beginSend, cancel };
}
