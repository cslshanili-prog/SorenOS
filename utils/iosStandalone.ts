let hasInstalledIOSStandaloneWorkaround = false;
let stableStandaloneHeight = 0;
// 這台設備要不要做鍵盤避讓（iOS 全屏 PWA / 安卓瀏覽器）。裝載時定下，
// setViewportVars 靠它決定要不要碰 body 上的鍵盤態標記——普通桌面瀏覽器一律不碰。
let keyboardFixesEnabled = false;
// 安全區只在旋轉 / 窗口尺寸變化時才變，緩存探測結果，避免 visualViewport 滾動、聚焦時反覆同步重排。
// 上下各自獨立緩存：某邊讀到非 0 才鎖定；iOS 啟動早期某邊可能瞬時為 0，此時該邊不鎖、下次繼續探測，
// 避免「一邊真值、一邊瞬時 0」被整體鎖死（否則 home 條避讓會失效，直到旋轉/尺寸變化才恢復）。
let cachedTopInset: number | null = null;
let cachedBottomInset: number | null = null;

// 用一個隱藏探針同時讀取上下安全區：單次插入 + 單次 getComputedStyle（一次 reflow）。
// env() 在本項目 iOS 全屏 PWA 下偶發返回 0，故需 JS 探測兜底。
export const readSafeAreaInsets = (): { top: number; bottom: number } => {
    if (typeof document === 'undefined' || !document.body) {
        return { top: cachedTopInset ?? 0, bottom: cachedBottomInset ?? 0 };
    }
    // 兩邊都已鎖定有效值，直接用緩存，不再插探針重排。
    if (cachedTopInset !== null && cachedBottomInset !== null) {
        return { top: cachedTopInset, bottom: cachedBottomInset };
    }

    const probe = document.createElement('div');
    probe.style.position = 'fixed';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.opacity = '0';
    probe.style.paddingTop = 'env(safe-area-inset-top)';
    probe.style.paddingBottom = 'env(safe-area-inset-bottom)';
    document.body.appendChild(probe);

    const computed = window.getComputedStyle(probe);
    const top = Math.round(parseFloat(computed.paddingTop) || 0);
    const bottom = Math.round(parseFloat(computed.paddingBottom) || 0);

    document.body.removeChild(probe);

    // 各邊只在讀到非 0 時鎖定；仍為 0 的邊保持未緩存，下次事件繼續探測，讀到真值再鎖。
    if (cachedTopInset === null && top > 0) cachedTopInset = top;
    if (cachedBottomInset === null && bottom > 0) cachedBottomInset = bottom;

    return { top: cachedTopInset ?? top, bottom: cachedBottomInset ?? bottom };
};

export const isIOSDevice = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

export const isStandaloneDisplayMode = (): boolean => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(display-mode: standalone)').matches || !!(window.navigator as Navigator & { standalone?: boolean }).standalone;
};

export const isIOSStandaloneWebApp = (): boolean => isIOSDevice() && isStandaloneDisplayMode();

// 安卓機（Chrome / Edge 等）。安卓普通瀏覽器彈軟鍵盤時經常不按 interactive-widget=resizes-content
// 迴流，而是縮小可視區、把整頁往上頂（頂欄被切、退出重進才恢復）。需要和 iOS 全屏 PWA 一樣，
// 讓 app 高度跟隨可視區並鎖死外層滾動。
export const isAndroidDevice = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    return /Android/i.test(navigator.userAgent || '');
};

export type StatusBarMode = 'standard' | 'compact' | 'hidden';

// 三檔狀態欄模式。沒有新字段的舊存檔繼續讀取 hideStatusBar；兩者都沒寫過時沿用平台默認。
// compact 會保留 SullyOS 時間/電量，但把它們放入頂部安全區，不再在安全區下方額外佔一行。
export const resolveStatusBarMode = (
    statusBarMode?: StatusBarMode,
    legacyHideStatusBar?: boolean,
    platformDefaultHidden: boolean = isIOSStandaloneWebApp(),
): StatusBarMode => {
    if (statusBarMode === 'standard' || statusBarMode === 'compact' || statusBarMode === 'hidden') {
        return statusBarMode;
    }
    return (legacyHideStatusBar ?? platformDefaultHidden) ? 'hidden' : 'standard';
};

// 頂部時鐘/電量條是否隱藏：外觀「隱藏頂部時間欄」開關顯式設過就聽用戶的；沒設過(undefined)按平台默認——
// iOS 全屏 PWA 系統狀態欄(真實時間/電量)刪不掉，默認隱藏 SullyOS 這條避免雙顯。
// 必須用 ?? 而非 ||：顯式 false（用戶主動要顯示）不能被平台默認 true 蓋掉。
// 只決定時鐘/電量條；錯誤指示器、系統調試終端等與本開關無關，始終獨立顯示。
export const isStatusBarHidden = (
    hideStatusBar?: boolean,
    platformDefaultHidden: boolean = isIOSStandaloneWebApp(),
): boolean => hideStatusBar ?? platformDefaultHidden;

const isTextEntryElement = (target: EventTarget | null): target is HTMLElement => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
};

const setViewportVars = () => {
    if (typeof document === 'undefined') return;
    const shouldStabilizeHeight = isIOSStandaloneWebApp();
    const innerHeight = Math.round(window.innerHeight);
    const viewportHeight = Math.round(window.visualViewport?.height || innerHeight);
    const viewportOffsetTop = Math.round(window.visualViewport?.offsetTop || 0);
    // 單次探針讀取上下安全區。頂部 env 偶發返回 0，探測不到時退回 44px（約狀態欄/劉海高度），避免頂欄內容懟進劉海。
    const safeInsets = shouldStabilizeHeight ? readSafeAreaInsets() : { top: 0, bottom: 0 };
    const bottomSafeInset = safeInsets.bottom;
    const topSafeInset = shouldStabilizeHeight ? (safeInsets.top > 0 ? safeInsets.top : 44) : 0;

    let fullAppHeight: number;
    let keyboardInset: number;
    let keyboardOpen: boolean;

    if (shouldStabilizeHeight) {
        // 全屏 PWA 沒有地址欄，可視高度只在軟鍵盤彈出時變矮。基線取「見過的最大可視高度」。
        if (!stableStandaloneHeight || viewportHeight > stableStandaloneHeight) {
            stableStandaloneHeight = viewportHeight;
        }
        // 鍵盤態判據用「可視高度變矮」而非 obscuredHeight：iOS 26 起 standalone 會把 layout viewport 也一起縮，
        // innerHeight 跟著變矮，obscuredHeight 算出來是 0 而失效。viewportHeight > 150 是對 iOS 偶發髒值的護欄——
        // 鍵盤動畫期 visualViewport 偶爾報錯值，此時退化成「無鍵盤態」，寧可不避讓也不要把佈局撐崩成滿屏白。
        keyboardOpen = viewportHeight > 150 && viewportHeight < stableStandaloneHeight - 100;
        // 鍵盤態：app 高度收到當前可視區（home 條已被鍵盤蓋，不再疊加 safe）；無鍵盤態：基線 + safe（底部給 home 條留位）。
        fullAppHeight = keyboardOpen ? viewportHeight : stableStandaloneHeight + bottomSafeInset;
        // standalone 下鍵盤避讓改由「app 高度跟隨可視區」統一處理，keyboard-inset 置 0，避免 CallApp 等再疊一層 padding。
        keyboardInset = 0;
        // iOS 26 鍵盤彈出會把整頁頂上去（visualViewport.offsetTop > 0），拉回頂部對齊可視區；
        // 配合 ios-keyboard-open 下的 touchmove 攔截（見 installIOSStandaloneWorkaround），把外層滾動徹底鎖死。
        if (keyboardOpen && viewportOffsetTop > 0) {
            window.scrollTo(0, 0);
        }
    } else {
        stableStandaloneHeight = 0;
        // obscuredHeight = 被軟鍵盤蓋住的高度。安卓瀏覽器若按 resizes-content 迴流，
        // innerHeight 會跟著縮，obscuredHeight ≈ 0（走無鍵盤分支，佈局自行迴流，什麼都不用做）；
        // 若不迴流而是縮小可視區/頂起整頁，obscuredHeight > 120，進入鍵盤分支統一避讓。
        const obscuredHeight = Math.max(0, innerHeight - viewportHeight - viewportOffsetTop);
        keyboardOpen = obscuredHeight > 120;
        // 鍵盤避讓統一用「app 高度跟隨可視區」，不再靠 keyboard-inset 讓各 App 自己疊 padding。
        keyboardInset = 0;
        if (keyboardOpen) {
            // 安卓 Chrome/Edge：app 高度收到鍵盤上方的可視區，輸入框自然落在可視區內；
            // 再把被瀏覽器頂起的外層滾動拉回頂部（配合 body.ios-keyboard-open 的 touchmove 鎖定），
            // 界面不再整體上移、退出重進才恢復。
            fullAppHeight = viewportHeight;
            if (viewportOffsetTop > 0) window.scrollTo(0, 0);
        } else {
            fullAppHeight = Math.max(innerHeight, viewportHeight + viewportOffsetTop);
        }
    }

    // 鍵盤態標記和 --app-height 必須同源：標記一掛，外殼就鋪到 app 高度多出的那段底部安全區、
    // 輸入欄同時收掉自己的讓位間隙，兩者淨位移為 0 —— 前提是高度也同時收到鍵盤上方。
    // 所以判據只認「可視區真的變矮了」，不認「輸入框拿到了焦點」：設備上鍵盤彈不出來時
    // （接了外接鍵盤、輸入法異常），焦點照樣進得來，但可視區紋絲不動，此時掛標記就會把
    // 輸入條整條推出屏幕、home 條騎到輸入框上。順帶這樣也不再依賴 focusout 來摘標記——
    // 聚焦中的輸入框被直接卸載（退出聊天頁）時 WebKit 不派發 focusout，標記會永久卡住。
    if (keyboardFixesEnabled) {
        document.body.classList.toggle('ios-keyboard-open', keyboardOpen);
    }

    document.documentElement.style.setProperty('--app-height', `${fullAppHeight}px`);
    document.documentElement.style.setProperty('--visual-viewport-height', `${viewportHeight}px`);
    document.documentElement.style.setProperty('--keyboard-inset', `${keyboardInset}px`);
    document.documentElement.style.setProperty('--standalone-safe-area-bottom', `${bottomSafeInset}px`);
    document.documentElement.style.setProperty('--standalone-safe-area-top', `${topSafeInset}px`);
};

export const installIOSStandaloneWorkaround = () => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (hasInstalledIOSStandaloneWorkaround) return;

    hasInstalledIOSStandaloneWorkaround = true;
    const useStandaloneFixes = isIOSStandaloneWebApp();
    // iOS 全屏 PWA 與安卓瀏覽器都需要這套鍵盤避讓：可視區一變矮就掛 keyboard 類 + 鎖外層滾動。
    // 安卓 Chrome/Edge 彈鍵盤時會把整頁頂起，同樣靠這套壓回去。
    const useKeyboardFixes = useStandaloneFixes || isAndroidDevice();
    keyboardFixesEnabled = useKeyboardFixes;
    if (useStandaloneFixes) {
        document.documentElement.classList.add('ios-standalone');
        document.body.classList.add('ios-standalone');
    }

    const handleViewportChange = () => {
        setViewportVars();
    };

    // 只有旋轉 / 窗口尺寸變化才真的改變安全區：讓緩存失效後重新探測（滾動、聚焦走緩存，不再重排）。
    const handleSafeAreaChange = () => {
        cachedTopInset = null;
        cachedBottomInset = null;
        setViewportVars();
    };

    // 聚焦只當「立刻重算一次」的時機，不直接判鍵盤態：此刻鍵盤還沒彈起來，
    // 要等 visualViewport 真的變矮，setViewportVars 才會掛上標記、同時把高度收到鍵盤上方。
    const handleFocusIn = (event: FocusEvent) => {
        if (!isTextEntryElement(event.target)) return;
        setViewportVars();

        const target = event.target;
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                if (document.activeElement !== target) return;
                try {
                    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                } catch {
                    // Ignore scroll failures on older iOS builds.
                }
            });
        });
    };

    // 鍵盤收起由 visualViewport 變化驅動，這裡只做一次兜底重算，
    // 防 iOS 偶發漏發 resize 讓高度停在鍵盤態。
    const handleFocusOut = () => {
        window.setTimeout(setViewportVars, 180);
    };

    // 鍵盤彈出時鎖死外層滾動：只放行可滾區（消息列表等 .overflow-y-auto）內部滾動，其餘 touchmove 一律攔掉。
    // 不鎖的話 iOS 會在輸入框聚焦時隨手勢把整頁頂飛（visualViewport.offsetTop 漂移、露出底層色塊、閃爍）。
    const handleTouchMove = (event: TouchEvent) => {
        if (!document.body.classList.contains('ios-keyboard-open')) return;
        const target = event.target as Element | null;
        if (target?.closest('.overflow-y-auto')) return;
        event.preventDefault();
    };

    window.addEventListener('resize', handleSafeAreaChange);
    window.addEventListener('orientationchange', handleSafeAreaChange);
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('scroll', handleViewportChange);
    if (useKeyboardFixes) {
        document.addEventListener('focusin', handleFocusIn);
        document.addEventListener('focusout', handleFocusOut);
        document.addEventListener('touchmove', handleTouchMove, { passive: false });
    }
    setViewportVars();

    // iOS standalone 冷啟動時 env() / JS probe 偶發都給 0；resize / orientationchange 整場可能都不觸發，
    // 緩存就會被鎖在 0，底部控件整場貼 home 條。這裡在啟動後階梯式重探幾次，遇到任一邊還沒鎖定就再試。
    if (useStandaloneFixes) {
        const RETRY_DELAYS_MS = [120, 500, 1500, 3000];
        for (const delay of RETRY_DELAYS_MS) {
            window.setTimeout(() => {
                if (cachedTopInset !== null && cachedBottomInset !== null) return; // 兩邊都已鎖定，無需再試
                setViewportVars();
            }, delay);
        }
    }
};
