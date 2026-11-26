/**
 * Tailwind 補丁（plans/todo.md 第 1 項的 B 案）。
 *
 * 樣式不是打包時編好的，是 cdn.tailwindcss.com 在瀏覽器裡邊跑邊產生：畫面每變一次就背景重算一次，
 * 算完把整份 CSS 寫回 <style>。重算是非同步的、最後寫回的是「最晚做完的那次」，不是最新的那次；
 * 畫面變動很密（剛開 App、切 App）、手機又慢時，舊的那次晚做完就把新的蓋掉。被蓋掉的樣式名它已經記成
 * 「做過了」，要等畫面出現沒見過的新樣式、或整份重做才會補回來——第一次進設置長歪就是這樣。
 *
 * 補法：剛開 App 和切 App 之後那幾秒，等畫面安靜下來（一段時間沒有新的節點或 class 變動，
 * 也就沒有別的重算在跑），叫它整份重做一次。整份重做＝重新指定一次 tailwind.config
 * （CDN 對 config 的寫入會清掉「做過了」的記號、從頭算一次）。
 * 不保證百分之百（極端情況重做本身也可能跟新的變動撞上），但安靜下來才做，撞上的機會很小；根治是 A 案（打包時編好）。
 */

const QUIET_MS = 350;
const BOOT_WINDOW_MS = 10_000;
const SWITCH_WINDOW_MS = 3_000;

type TailwindGlobal = { config?: unknown };

let armedUntil = 0;
let quietTimer: ReturnType<typeof setTimeout> | null = null;
let observer: MutationObserver | null = null;
let repairs = 0;

const tailwindGlobal = (): TailwindGlobal | undefined => (window as unknown as { tailwind?: TailwindGlobal }).tailwind;
/** index.html 把原始設定另外存在這裡：直接拿 tailwind.config 會拿到它包過的 Proxy，指定回去會一層包一層 */
const rawConfig = (): unknown => (window as unknown as { __sorenTailwindConfig?: unknown }).__sorenTailwindConfig;

function rebuild(): void {
    quietTimer = null;
    if (Date.now() > armedUntil + QUIET_MS) return;
    const tw = tailwindGlobal();
    const config = rawConfig();
    if (!tw || !config) return;
    tw.config = config;
    repairs += 1;
}

function scheduleQuietRebuild(): void {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(rebuild, QUIET_MS);
}

/** 接下來 ms 毫秒內，畫面一安靜就整份重做一次（期間每安靜一次做一次） */
export function armTailwindRepair(ms: number): void {
    if (typeof window === 'undefined' || !tailwindGlobal()) return;
    armedUntil = Math.max(armedUntil, Date.now() + ms);
    scheduleQuietRebuild();
}

/** 切 App 時呼叫（OSContext 的 activeApp 一變就叫） */
export function noteAppSwitchForTailwind(): void {
    armTailwindRepair(SWITCH_WINDOW_MS);
}

/** 開機時裝一次：盯著畫面的變動，在「掛號期間」等安靜下來再重做 */
export function installTailwindRepair(): void {
    if (typeof window === 'undefined' || observer || !tailwindGlobal() || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver(records => {
        if (Date.now() > armedUntil) return;
        // <head> 裡的變動多半是 Tailwind 自己把 CSS 寫回去，不算畫面變動，不然會自己觸發自己
        const head = document.head;
        if (records.every(r => head.contains(r.target))) return;
        scheduleQuietRebuild();
    });
    // 給開發調試面板和自動測試看：這次開 App 以來重做了幾次
    (window as unknown as { __sorenTailwindRepair?: { count: () => number } }).__sorenTailwindRepair = { count: () => repairs };
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    armTailwindRepair(BOOT_WINDOW_MS);
}

/** 開發調試用：這次開 App 以來重做了幾次 */
export const tailwindRepairCount = (): number => repairs;
