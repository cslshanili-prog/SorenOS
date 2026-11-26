/**
 * 匯出跳出系統的分享面板／存檔畫面再回來，iOS（尤其「加到主畫面」的 App）偶爾留下放大又偏移的畫面：
 * 時鐘右邊、小組件左邊被切掉，不能兩指縮小、只能左右滑，關掉重開才好（plans/todo.md 第 2 項）。
 *
 * 做法：匯出前先「掛號」，回到 App（visibilitychange／pageshow／focus）和分享結束時，
 * 把 <meta name="viewport"> 改一下再改回原樣，逼 iOS 重新套用縮放，順手捲回原點。
 * 只動 initial-scale 那一格的寫法、隨即還原整串原文，viewport-fit 等其他設定（docs/ios-status-bar-edge.md）不受影響。
 */

const ARM_MS = 3 * 60_000;
let armedUntil = 0;
let listening = false;

const onReturn = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (Date.now() > armedUntil) { stopListening(); return; }
    resetViewportZoom();
    // 有的機型回到前景後畫面還在動，晚一點再補一次
    setTimeout(resetViewportZoom, 400);
};

function stopListening(): void {
    if (!listening || typeof window === 'undefined') return;
    listening = false;
    document.removeEventListener('visibilitychange', onReturn);
    window.removeEventListener('pageshow', onReturn);
    window.removeEventListener('focus', onReturn);
}

/** 換掉 initial-scale 的寫法（數值不變），讓字串不同、iOS 才會重新套用；原本沒寫就補一格 */
export function nudgedViewportContent(content: string): string {
    if (/initial-scale\s*=/.test(content)) {
        return content.replace(/initial-scale\s*=\s*([^,\s]+)/, (_m, v: string) => `initial-scale=${v === '1.0' ? '1' : '1.0'}`);
    }
    return `${content}, initial-scale=1`;
}

/** 重設縮放與水平捲動；沒有 viewport meta 或不在瀏覽器裡就什麼都不做 */
export function resetViewportZoom(): void {
    if (typeof document === 'undefined') return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (meta) {
        const original = meta.content;
        meta.content = nudgedViewportContent(original);
        requestAnimationFrame(() => {
            // 這中間別人改過（例如 iOS 頂端那套）就不蓋回去
            if (meta.content === nudgedViewportContent(original)) meta.content = original;
        });
    }
    try {
        if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
        document.documentElement.scrollLeft = 0;
        document.body.scrollLeft = 0;
    } catch { /* 捲不了就算了 */ }
}

/** 要跳去系統分享／存檔之前呼叫：接下來幾分鐘內回到 App 就重設一次 */
export function armViewportReset(): void {
    if (typeof window === 'undefined') return;
    armedUntil = Date.now() + ARM_MS;
    if (listening) return;
    listening = true;
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('pageshow', onReturn);
    window.addEventListener('focus', onReturn);
}

/** 分享／下載那一步結束（成功、取消、失敗都算）：馬上和稍後各重設一次 */
export function settleViewportReset(): void {
    if (typeof window === 'undefined') return;
    resetViewportZoom();
    setTimeout(resetViewportZoom, 350);
}
