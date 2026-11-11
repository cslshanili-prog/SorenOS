import { useEffect, type RefObject } from 'react';

/**
 * iOS 點輸入框時會把它捲進畫面，連 overflow: hidden 的外層也一起捲（程式捲得動）。鍵盤收起後外層不會自己捲回去，
 * 桌面上的全螢幕面板（自訂小組件編輯器、設定）整塊往上跑：頂上的「儲存」「取消」看不到，底下露出一條黑。
 * 輸入框失焦後，把這個面板往上每一層 overflow: hidden 卻被捲動過的都拉回 0；正常的捲動區（auto / scroll）不動。
 */
export const useResetHiddenScroll = (ref: RefObject<HTMLElement | null>) => {
    useEffect(() => {
        const root = ref.current;
        if (!root) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const reset = () => {
            for (let el: HTMLElement | null = root; el && el !== document.body; el = el.parentElement) {
                if (el.scrollTop === 0 && el.scrollLeft === 0) continue;
                const style = getComputedStyle(el);
                if (style.overflowY === 'hidden' && el.scrollTop) el.scrollTop = 0;
                if (style.overflowX === 'hidden' && el.scrollLeft) el.scrollLeft = 0;
            }
        };
        const onFocusOut = () => {
            if (timer) clearTimeout(timer);
            // 等鍵盤收完、可視區量好再拉，太早拉 iOS 會再捲一次
            timer = setTimeout(reset, 250);
        };
        root.addEventListener('focusout', onFocusOut);
        reset();
        return () => {
            if (timer) clearTimeout(timer);
            root.removeEventListener('focusout', onFocusOut);
            reset();
        };
    }, [ref]);
};
