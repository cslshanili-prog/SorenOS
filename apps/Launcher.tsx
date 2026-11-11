import React, { useMemo, useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react';
import { isPaperWallpaper, useOS } from '../context/OSContext';
import { INSTALLED_APPS, DOCK_APPS } from '../constants';
import { isDevDebugAvailable, subscribeDevDebugAvailability } from '../utils/devDebug';
import AppIcon from '../components/os/AppIcon';
import TokenImg from '../components/os/TokenImg';
import { useBlobRefUrl } from '../utils/blobRef';
import { dockContainerLook } from '../utils/dockStyle';
import { DB } from '../utils/db';
import { isChatPreviewMessage } from '../utils/chatMessageVisibility';
import { CharacterProfile, Anniversary, AppID, DailySchedule, type OSTheme } from '../types';
import { anniversaryCharNames, nextOccurrenceDate } from '../utils/anniversary';
import { ScheduleHomeWidget, ScheduleFullscreenViewer } from '../components/schedule/ScheduleHomeWidget';
import NowPlayingSquareWidget from '../components/os/NowPlayingSquareWidget';
import MobileGameHome from '../components/os/MobileGameHome';
import TamagotchiHome from '../components/os/TamagotchiHome';
import { getDailyScheduleForChar } from '../utils/dailySchedule';
import { useLocalDateKey } from '../hooks/useLocalDateKey';
import { resolveCharTimeZone } from '../utils/timezone';
import { trackEvent } from '../utils/analytics';
import { processImageToBlob } from '../utils/file';
import { putImageBlob } from '../utils/blobRef';
import {
    BUILTIN_WIDGETS, GRID_COLS, GRID_ROWS, addCustomWidget, addPage, addWidget, buildLegacyLayout, cellFromPoint, countCustomWidgetsOf, hasWidget, inBounds, itemsInArea,
    moveItem, normalizeLayout, patchWidget, removeCustomWidgetsOf, removePage, removeWidget, resizeWidget, sizeLabel,
    DOCK_MAX, moveAppToDock, moveDockAppToGrid, normalizeDockOrder,
    type BuiltinWidgetType, type LauncherItem, type LauncherLayout, type LauncherWidgetItem, type WidgetSize,
} from '../utils/launcherLayout';
import {
    WIDGET_FILE_EXT, buildWidgetFile, makeTemplateId, parseWidgetFile, type CustomWidgetTemplate,
} from '../utils/customWidget';
import { dataUrlToBlob, resolveRefToDataUrl } from '../utils/blobRef';
import { shareOrDownloadFile } from '../utils/shareExport';
import { safeShareFileName } from '../utils/pngShare';
import CustomWidgetFrame from '../components/launcher/CustomWidgetFrame';
import CustomWidgetSettings from '../components/launcher/CustomWidgetSettings';
import CustomWidgetEditor, { pixelSize } from '../components/launcher/CustomWidgetEditor';
import { STARTER_TEMPLATES, WIDGET_STARTERS, findUntouchedStarterCopies, isStarterTemplateId, starterTemplateId, type WidgetStarter } from '../utils/widgetStarters';

const CompanionHome = React.lazy(() => import('../components/os/CompanionHome'));

// --- Isolated Components to prevent full re-renders ---

// 1. Clock Component (Consumes virtualTime)
/** compact：只留一排星期、日期和時間，不把 4×2 那套等比縮小。wide 是 4×1（置中），narrow 是 2×1（靠左、星期縮寫） */
const DesktopClock = React.memo(({ compact }: { compact?: 'wide' | 'narrow' }) => {
    const { virtualTime, theme } = useOS();
    const contentColor = theme.contentColor || '#ffffff';
    const paper = theme.skin !== 'animalcrossing' && theme.skin !== 'mobilegame' && theme.skin !== 'tamagotchi' && isPaperWallpaper(theme.wallpaper);

    const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const now = new Date();
    const dayName = days[now.getDay()];
    const monthName = months[now.getMonth()];
    const dateNum = now.getDate().toString().padStart(2, '0');
    const yearNum = now.getFullYear();

    // 簡單問候（基於虛擬時間）
    const greeting = virtualTime.hours < 5 ? 'Good Night'
        : virtualTime.hours < 12 ? 'Good Morning'
        : virtualTime.hours < 18 ? 'Good Afternoon'
        : 'Good Evening';

    const hh = virtualTime.hours.toString().padStart(2, '0');
    const mm = virtualTime.minutes.toString().padStart(2, '0');

    if (compact) {
        const acnhSkin = theme.skin === 'animalcrossing';
        const narrow = compact === 'narrow';
        const timeSize = narrow
            ? (acnhSkin ? 'text-[2.3rem] font-extrabold tracking-[1px]' : paper ? 'text-[2.5rem] font-semibold tracking-[-0.04em]' : 'text-[2.6rem] font-black tracking-tighter drop-shadow-xl')
            : (acnhSkin ? 'text-[2.9rem] font-extrabold tracking-[2px]' : paper ? 'text-[3.2rem] font-semibold tracking-[-0.04em]' : 'text-[3.4rem] font-black tracking-tighter drop-shadow-xl');
        return (
            <div className={`flex h-full w-full flex-col justify-center px-1 select-none ${narrow ? 'items-start' : 'items-center text-center'}`} style={{ color: acnhSkin ? '#8b7355' : contentColor }}>
                <div className={`${narrow ? 'text-[9px] tracking-[0.16em]' : 'text-[10px] tracking-[0.22em]'} whitespace-nowrap font-bold opacity-75`}>{narrow ? dayName.slice(0, 3) : dayName}, {Number(dateNum)} {monthName}</div>
                <div className={`mt-1 whitespace-nowrap leading-[0.9] ${timeSize}`}
                    style={{ fontFamily: acnhSkin ? undefined : paper ? `'Iowan Old Style', 'Baskerville', 'Times New Roman', serif` : `'Space Grotesk', 'SF Pro Display', sans-serif`, fontFeatureSettings: '"tnum"' }}>
                    {hh}<span className="mx-0.5 font-thin opacity-35 animate-pulse">:</span>{mm}
                </div>
            </div>
        );
    }

    // 動森彩蛋：NookPhone 主屏時鐘 —— 問候 + 大號時間(主角) + 星期·日期
    if (theme.skin === 'animalcrossing') {
        const weekdayTitle = dayName.charAt(0) + dayName.slice(1).toLowerCase();
        const monthTitle = monthName.charAt(0) + monthName.slice(1).toLowerCase();
        return (
            <div className="mt-7 mb-5 text-center animate-fade-in select-none">
                <div className="text-[13px] font-extrabold tracking-wide" style={{ color: '#8a7a5c' }}>
                    🍃 {greeting}, Resident
                </div>
                <div className="text-[3.5rem] font-extrabold leading-none mt-1.5 tracking-[2px]" style={{ color: '#8b7355' }}>
                    {hh}<span className="animate-pulse" style={{ color: '#cfcab2' }}>:</span>{mm}
                </div>
                <div className="text-[15px] font-bold mt-1.5" style={{ color: '#725C4E' }}>
                    {weekdayTitle} · {monthTitle} {Number(dateNum)}
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col mb-5 mt-5 relative animate-fade-in" style={{ color: contentColor }}>
            {/* 頂部裝飾 — 狀態膠囊 + 細線 */}
            <div className="flex items-center gap-2 mb-3 opacity-90">
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
                    style={{
                        background: paper ? 'rgba(224,221,215,0.30)' : 'rgba(255,255,255,0.28)',
                        border: paper ? '1px solid rgba(91,72,51,0.07)' : '1px solid rgba(255,255,255,0.18)',
                    }}>
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: paper ? '#788369' : '#4ade80', boxShadow: paper ? 'none' : '0 0 6px #4ade80' }} />
                    <span className="text-[9px] font-bold tracking-[0.2em] uppercase">System Online</span>
                </div>
                <div className="h-[1px] flex-1 bg-gradient-to-r from-current to-transparent opacity-30" />
                <span className="text-[9px] tracking-[0.2em] uppercase opacity-60">{yearNum}</span>
            </div>

            {/* 問候 */}
            <div className="text-[11px] tracking-[0.25em] uppercase opacity-55 font-semibold mb-1">
                {greeting}
            </div>

            {/* 主時鐘 */}
            <div className="flex items-end gap-4">
                <div className="relative">
                    <div className={`${paper ? 'text-[5.65rem] font-semibold tracking-[-0.055em] drop-shadow-[0_2px_0_rgba(255,255,255,0.34)]' : 'text-[6.25rem] font-black tracking-tighter drop-shadow-2xl'} leading-[0.84]`}
                        style={{ fontFamily: paper ? `'Iowan Old Style', 'Baskerville', 'Times New Roman', serif` : `'Space Grotesk', 'SF Pro Display', sans-serif`, fontFeatureSettings: '"tnum"' }}>
                        <span>{virtualTime.hours.toString().padStart(2, '0')}</span>
                        <span className="opacity-35 font-thin mx-0.5 animate-pulse">:</span>
                        <span>{virtualTime.minutes.toString().padStart(2, '0')}</span>
                    </div>
                    {/* 細光斑 */}
                    {!paper && <div className="absolute -top-2 -right-3 w-8 h-8 rounded-full pointer-events-none"
                        style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.4), transparent 70%)' }} />}
                </div>

                <div className="flex flex-col justify-end pb-2.5 gap-0.5">
                    <div className="text-[10px] font-bold tracking-[0.22em] opacity-85">{dayName}</div>
                    <div className="flex items-baseline gap-1">
                        <div className="text-2xl font-black leading-none" style={{ fontFamily: `'Space Grotesk', sans-serif` }}>{dateNum}</div>
                        <div className="text-[10px] font-bold tracking-[0.2em] opacity-70">{monthName}</div>
                    </div>
                </div>
            </div>
        </div>
    );
});

// 2. Character Widget (Consumes Character Data & Messages)
const CharacterWidget = React.memo(({ 
    char, 
    unreadCount, 
    lastMessage, 
    onClick, 
    contentColor,
    paper = false,
    fill = false,
}: { 
    char: CharacterProfile | null, 
    unreadCount: number, 
    lastMessage: string, 
    onClick: () => void,
    contentColor: string,
    paper?: boolean,
    /** 放在桌面網格裡：撐滿格子，不自己留間距 */
    fill?: boolean,
}) => {
    const { theme } = useOS();
    const acnh = theme.skin === 'animalcrossing'; // 動森彩蛋：會"說話"的村民卡
    // 卡片底的虛化頭像畫在 CSS background-image 上，吃不到 TokenImg 的解析，這裡自己解析一次。
    const avatarUrl = useBlobRefUrl(char?.avatar);

    // 動森：村民頭像 + AC 對話氣泡（顯示最近消息，點開聊天）
    if (acnh) {
        return (
            <div className={`${fill ? 'h-full flex items-center' : 'mb-4'} animate-fade-in`} onClick={onClick}>
                <div className="flex items-end gap-2.5 cursor-pointer active:scale-[0.98] transition-transform">
                    {/* 村民頭像（圓角方塊 + 白邊） */}
                    <div className="relative w-[60px] h-[60px] shrink-0 rounded-[26%] overflow-hidden bg-[#e8e2d6]"
                        style={{ border: '3px solid #ffffff', boxShadow: '0 4px 10px -2px rgba(61,52,40,0.28)' }}>
                        {char?.avatar
                            ? <TokenImg value={char.avatar} className="w-full h-full object-cover" alt="char" loading="lazy" />
                            : <div className="w-full h-full flex items-center justify-center text-2xl">🍃</div>}
                        {unreadCount > 0 && (
                            <div className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-[#fc736d] rounded-full flex items-center justify-center text-[10px] font-bold text-white"
                                style={{ border: '2px solid #fff' }}>
                                {unreadCount > 9 ? '9+' : unreadCount}
                            </div>
                        )}
                    </div>
                    {/* AC 對話氣泡 */}
                    <div className="relative flex-1 min-w-0 mb-1">
                        <div className="absolute -left-1.5 bottom-3 w-3 h-3 rotate-45"
                            style={{ background: '#FFFBF2', borderLeft: '2px solid #ece0c8', borderBottom: '2px solid #ece0c8' }} />
                        <div className="relative rounded-2xl px-3.5 py-2.5"
                            style={{ background: '#FFFBF2', border: '2px solid #ece0c8', boxShadow: '0 4px 12px -5px rgba(120,90,40,0.25)' }}>
                            <div className="flex items-center gap-1.5 mb-0.5">
                                <span className="text-[13px] font-extrabold truncate" style={{ color: '#725d42' }}>{char?.name || 'Resident'}</span>
                                <span className="text-[11px] leading-none">{unreadCount > 0 ? '💬' : '🍃'}</span>
                            </div>
                            <div className="text-[11px] leading-snug line-clamp-2" style={{ color: '#9f8b68' }}>{lastMessage}</div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={`${fill ? 'h-full' : 'mb-3'} group animate-fade-in`}>
             <div
                className={`relative ${fill ? 'h-full' : 'h-24'} w-full overflow-hidden rounded-3xl cursor-pointer transition-transform duration-300 active:scale-[0.98]`}
                onClick={onClick}
                style={paper ? {
                    background: 'rgba(224,221,215,0.40)',
                    border: '1px solid rgba(91,72,51,0.07)',
                    boxShadow: '0 5px 16px rgba(91,72,51,0.055)',
                } : acnh ? {
                    background: 'rgb(247,243,223)',
                    border: '2px solid #e8e2d6',
                    boxShadow: '0 8px 24px 0 rgba(61,52,40,0.14)',
                } : {
                    background: 'rgba(255,255,255,0.08)',
                    backdropFilter: 'blur(24px) saturate(1.4)',
                    WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.08)',
                }}
             >
                 {/* 背景虛化角色頭像（動森模式下省略，避免糊在奶油底上） */}
                 {!acnh && !paper && avatarUrl && (
                     <div className="absolute inset-0 opacity-25 pointer-events-none"
                         style={{
                             backgroundImage: `url(${avatarUrl})`,
                             backgroundSize: 'cover',
                             backgroundPosition: 'center',
                             filter: 'blur(30px) saturate(1.6)',
                             transform: 'scale(1.3)',
                         }} />
                 )}

                 <div className="relative flex items-center p-3 gap-3 h-full">
                     {/* 頭像 */}
                     <div className={`w-[68px] h-[68px] shrink-0 rounded-2xl overflow-hidden relative ${paper ? 'bg-[#ded2c1]' : 'bg-slate-800'}`}
                         style={{
                             border: paper ? '1px solid rgba(91,72,51,0.14)' : acnh ? '2px solid #e8e2d6' : '1.5px solid rgba(255,255,255,0.25)',
                             boxShadow: paper ? '0 5px 14px rgba(91,72,51,0.13)' : acnh ? '0 4px 12px -4px rgba(61,52,40,0.25)' : '0 4px 14px rgba(0,0,0,0.25)',
                         }}>
                         {char ? (
                             <TokenImg value={char.avatar} className="w-full h-full object-cover" alt="char" loading="lazy" />
                         ) : <div className="w-full h-full bg-white/10 animate-pulse" />}
                         {unreadCount > 0 ? (
                            <div className="absolute bottom-0.5 right-0.5 min-w-[16px] h-[16px] px-1 bg-red-500 rounded-full border border-white/30 shadow-sm flex items-center justify-center text-[9px] font-bold text-white">
                                {unreadCount > 9 ? '9+' : unreadCount}
                            </div>
                         ) : (
                            <div className="absolute bottom-1 right-1 w-2.5 h-2.5 rounded-full border-2 border-white/60" style={{ background: paper ? '#788369' : '#4ade80', boxShadow: paper ? 'none' : '0 0 6px #4ade80' }}></div>
                         )}
                     </div>

                     {/* 文本 */}
                     <div className="flex-1 min-w-0 flex flex-col justify-center gap-1" style={{ color: contentColor }}>
                         <div className="flex items-center gap-1.5">
                             <h3 className={`text-[15px] font-bold tracking-wide truncate ${paper ? '' : 'drop-shadow-md'}`}>
                                 {char?.name || 'NO SIGNAL'}
                             </h3>
                             {unreadCount > 0 ? (
                                 <div className="px-1.5 py-px rounded-full text-[8px] font-bold uppercase tracking-[0.15em]"
                                     style={{ background: 'rgba(239,68,68,0.9)', color: 'white' }}>NEW</div>
                             ) : (
                                 <div className="px-1.5 py-px rounded-full text-[8px] font-bold uppercase tracking-[0.15em]"
                                     style={paper ? { background: 'rgba(120,131,105,0.16)', color: '#68725b' } : acnh ? { background: '#7cba4c', color: 'white' } : { background: 'rgba(255,255,255,0.18)' }}>Online</div>
                             )}
                         </div>
                         <div className="text-xs font-medium leading-relaxed opacity-85 flex items-start gap-1.5">
                            <span
                                aria-hidden="true"
                                className="shrink-0 mt-[0.42em] opacity-45"
                                style={{ width: 0, height: 0, borderTop: '3px solid transparent', borderBottom: '3px solid transparent', borderLeft: '4px solid currentColor' }}
                            />
                            <span className="line-clamp-2">{lastMessage}</span>
                         </div>
                     </div>
                 </div>
             </div>
        </div>
    );
});


// 3. 撐滿格子：內容比格子高就等比縮小（時鐘、日程、月曆這些有自己的自然高度）
const FitBox: React.FC<{ children: React.ReactNode; align?: 'center' | 'start' }> = ({ children, align = 'center' }) => {
    const outer = useRef<HTMLDivElement>(null);
    const inner = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(1);
    useLayoutEffect(() => {
        const o = outer.current;
        const i = inner.current;
        if (!o || !i) return;
        const measure = () => {
            const ih = i.offsetHeight;
            const iw = i.scrollWidth;
            const next = ih > 0 ? Math.min(1, o.clientHeight / ih, iw > 0 ? o.clientWidth / iw : 1) : 1;
            setScale(prev => (Math.abs(prev - next) > 0.01 ? Math.max(0.4, next) : prev));
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        ro.observe(o);
        ro.observe(i);
        return () => ro.disconnect();
    }, []);
    return (
        <div ref={outer} className={`w-full h-full overflow-hidden flex ${align === 'start' ? 'items-start' : 'items-center'} justify-center`}>
            <div ref={inner} className="w-full shrink-0" style={{ transform: scale < 1 ? `scale(${scale})` : undefined, transformOrigin: align === 'start' ? 'top center' : 'center' }}>
                {children}
            </div>
        </div>
    );
};

// 3b. 格子裡的正方形（格子不一定是方的）：取寬高較小的那邊
const SquareBox: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const ref = useRef<HTMLDivElement>(null);
    const [side, setSide] = useState(0);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measure = () => setSide(Math.floor(Math.min(el.clientWidth, el.clientHeight)));
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return (
        <div ref={ref} className="w-full h-full flex items-center justify-center">
            {side > 0 && <div style={{ width: side, height: side }}>{children}</div>}
        </div>
    );
};

// 3c. 圖片小組件：預設不加邊框和陰影，去背的 PNG 直接透出；外框要自己開
const ImageWidget = React.memo(({ image, frame = false, contentColor, acnh = false, editing = false }: {
    image?: string,
    frame?: boolean,
    contentColor: string,
    acnh?: boolean,
    editing?: boolean,
}) => {
    const { theme } = useOS();
    const paper = theme.skin !== 'animalcrossing' && theme.skin !== 'mobilegame' && theme.skin !== 'tamagotchi' && isPaperWallpaper(theme.wallpaper);
    if (image) {
        const frameStyle: React.CSSProperties | undefined = !frame ? undefined : paper ? {
            border: '1px solid rgba(91,72,51,0.10)', boxShadow: '0 5px 16px rgba(91,72,51,0.08)',
        } : acnh ? {
            border: '2px solid #e8e2d6', boxShadow: '0 6px 18px rgba(61,52,40,0.12)',
        } : {
            border: '1px solid rgba(255,255,255,0.2)', boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
        };
        return (
            <div className={`w-full h-full animate-fade-in ${frame ? 'rounded-2xl overflow-hidden' : ''}`} style={frameStyle}>
                <TokenImg value={image} alt="" className={`w-full h-full ${frame ? 'object-cover' : 'object-contain'}`} loading="lazy" />
            </div>
        );
    }
    return (
        <div className="w-full h-full rounded-[1.5rem] flex flex-col items-center justify-center gap-1.5 px-2 text-center animate-fade-in"
            style={paper ? { background: 'rgba(224,221,215,0.38)', border: '1px dashed rgba(91,72,51,0.18)', color: contentColor }
                : acnh ? { background: 'rgb(247,243,223)', border: '2px dashed #e8e2d6', color: '#8b7355' }
                : { background: 'rgba(255,255,255,0.18)', border: '1px dashed rgba(255,255,255,0.35)', color: contentColor }}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor" className="w-5 h-5 opacity-70">
                <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
            </svg>
            <div className="text-[9px] leading-tight opacity-60 whitespace-pre-line">{editing ? '點一下選圖片' : '長按桌面\n設定圖片'}</div>
        </div>
    );
});
const CALENDAR_WEEKDAYS = [
    { key: 'sun', label: 'S' },
    { key: 'mon', label: 'M' },
    { key: 'tue', label: 'T' },
    { key: 'wed', label: 'W' },
    { key: 'thu', label: 'T' },
    { key: 'fri', label: 'F' },
    { key: 'sat', label: 'S' },
] as const;


const cardStyle = (acnh: boolean, paper: boolean): React.CSSProperties | undefined =>
    paper ? { background: 'rgba(224,221,215,0.36)', border: '1px solid rgba(91,72,51,0.07)', boxShadow: '0 5px 16px rgba(91,72,51,0.05)' }
        : acnh ? { background: 'rgb(247,243,223)', border: '2px solid #e8e2d6', boxShadow: '0 6px 18px rgba(61,52,40,0.12)' }
        : undefined;
const cardClass = (acnh: boolean, paper: boolean) => (acnh ? 'shadow-sm' : paper ? '' : 'bg-white/25 border border-white/25 shadow-xl');

// 4. 月曆（原本最後一頁上半）。尺寸不同畫法不同：
//   4×3／4×4 整個月（格子撐滿高度，4×4 底下多一行「下一個紀念日」）；4×1 只有這一週一條；2×2 只顯示今天。
const calendarHasEvent = (anniversaries: Anniversary[], dateStr: string) =>
    anniversaries.some(a => a.date === dateStr || (a.repeatAnnually && a.date.slice(5) === dateStr.slice(5)));
const ymdOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const MONTHS_EN = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS_EN = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

const CalendarWidget = React.memo(({ contentColor, openApp, anniversaries, acnh = false, paper = false, w = 4, h = 3 }: any) => {
    const acDot = acnh ? '#6fba2c' : undefined;
    const dotColor = acDot || (paper ? '#a66f52' : '#c084fc');
    const now = new Date();
    const todayStr = ymdOf(now);
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const monthName = MONTHS_EN[currentMonth];
    const todayBubble = (isToday: boolean): { className: string; style: React.CSSProperties } => isToday
        ? (acnh ? { className: 'text-white font-bold', style: { background: '#19c8b9' } }
            : paper ? { className: 'text-white font-bold', style: { background: '#788369', boxShadow: '0 4px 10px rgba(91,72,51,0.14)' } }
            : { className: 'bg-white text-black font-bold shadow-lg', style: {} })
        : { className: 'opacity-80', style: { color: contentColor } };
    const upcoming = useMemo(() => (anniversaries as Anniversary[])
        .map(a => ({ a, next: nextOccurrenceDate(a, todayStr) }))
        .filter(x => x.next >= todayStr)
        .sort((x, y) => x.next.localeCompare(y.next))[0], [anniversaries, todayStr]);
    const daysUntil = (dateStr: string) => Math.round((new Date(`${dateStr}T00:00:00`).getTime() - new Date(`${todayStr}T00:00:00`).getTime()) / 86400000);
    const todayEvents = (anniversaries as Anniversary[]).filter(a => calendarHasEvent([a], todayStr));
    const shell = `h-full w-full rounded-3xl ${cardClass(acnh, paper)}`;

    // 2×2：今天
    if (w <= 2) {
        return (
            <div className={`${shell} flex flex-col items-center justify-center p-3 text-center`} style={{ ...cardStyle(acnh, paper), color: contentColor }}>
                <div className="text-[10px] font-bold tracking-[0.22em] opacity-60">{monthName} {currentYear}</div>
                <div className="my-1 text-[3.4rem] font-black leading-none" style={{ fontFamily: `'Space Grotesk', sans-serif` }}>{now.getDate()}</div>
                <div className="text-[10px] font-bold tracking-[0.22em] opacity-80">{WEEKDAYS_EN[now.getDay()]}</div>
                <div className="mt-2 flex max-w-full items-center gap-1 text-[10px] opacity-70">
                    {todayEvents.length ? <><span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dotColor }} /><span className="truncate">{todayEvents[0].title}</span></>
                        : upcoming ? <span className="truncate">{upcoming.a.title} · 還有 {daysUntil(upcoming.next)} 天</span> : null}
                </div>
            </div>
        );
    }

    // 4×1：這一週
    if (h <= 1) {
        const start = new Date(currentYear, currentMonth, now.getDate() - now.getDay());
        const week = Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
        return (
            <div className={`${shell} flex items-center gap-2 px-3`} style={cardStyle(acnh, paper)}>
                <div className="shrink-0 text-center leading-tight" style={{ color: contentColor }}>
                    <div className="text-[13px] font-black tracking-widest">{monthName}</div>
                    <div className="text-[9px] font-bold opacity-50">{currentYear}</div>
                </div>
                <div className="grid min-w-0 flex-1 grid-cols-7 text-center">
                    {week.map((d, i) => {
                        const isToday = ymdOf(d) === todayStr;
                        const bubble = todayBubble(isToday);
                        return (
                            <div key={i} className="relative flex flex-col items-center gap-0.5">
                                <div className="text-[9px] font-bold opacity-40" style={{ color: contentColor }}>{CALENDAR_WEEKDAYS[i].label}</div>
                                <div className={`flex h-7 w-7 items-center justify-center rounded-full text-[13px] font-medium ${bubble.className}`} style={bubble.style}>{d.getDate()}</div>
                                {calendarHasEvent(anniversaries, ymdOf(d)) && <div className="absolute -bottom-1 h-1 w-1 rounded-full" style={{ background: dotColor }} />}
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    }

    // 4×3／4×4：整個月，格子撐滿
    const totalDays = new Date(currentYear, currentMonth + 1, 0).getDate();
    const startOffset = new Date(currentYear, currentMonth, 1).getDay();
    const cells: Array<number | null> = [...Array.from({ length: startOffset }, () => null), ...Array.from({ length: totalDays }, (_, i) => i + 1)];
    const weeks = Math.ceil(cells.length / 7);
    const big = h >= 4;
    return (
        <div className={`${shell} flex flex-col p-4`} style={cardStyle(acnh, paper)}>
            <div className="mb-2 flex shrink-0 items-center justify-between" style={{ color: contentColor }}>
                <h3 className="text-xl font-bold tracking-widest">{monthName} {currentYear}</h3>
                <div onClick={() => openApp('schedule')} className={`p-2 rounded-full cursor-pointer transition-colors ${acnh ? 'bg-[#82D5BB]/30 hover:bg-[#82D5BB]/50' : paper ? 'bg-[#788369]/10 hover:bg-[#788369]/20' : 'bg-white/20 hover:bg-white/40'}`}>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                </div>
            </div>
            <div className="mb-1 grid shrink-0 grid-cols-7 gap-x-1 text-center">
                {CALENDAR_WEEKDAYS.map(day => <div key={day.key} className="text-[10px] font-bold opacity-40" style={{ color: contentColor }}>{day.label}</div>)}
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-7 gap-x-1 text-center" style={{ gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))` }}>
                {cells.map((day, index) => {
                    if (day === null) return <div key={`pad-${index}`} />;
                    const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    const bubble = todayBubble(day === now.getDate());
                    return (
                        <div key={day} className="relative flex min-h-0 items-center justify-center">
                            <div className={`flex aspect-square h-full max-h-9 items-center justify-center rounded-full ${big ? 'text-[15px]' : 'text-sm'} font-medium ${bubble.className}`} style={bubble.style}>{day}</div>
                            {calendarHasEvent(anniversaries, dateStr) && <div className="absolute bottom-0 h-1.5 w-1.5 rounded-full border border-black/10 shadow-sm" style={{ background: dotColor }} />}
                        </div>
                    );
                })}
            </div>
            {big && (
                <div className="mt-2 flex shrink-0 items-center gap-1.5 border-t border-current/10 pt-2 text-[11px]" style={{ color: contentColor, borderColor: 'rgba(127,127,127,0.18)' }}>
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dotColor }} />
                    {upcoming
                        ? <span className="min-w-0 truncate opacity-80">{daysUntil(upcoming.next) === 0 ? `今天是「${upcoming.a.title}」` : `${upcoming.a.title} · 還有 ${daysUntil(upcoming.next)} 天`}</span>
                        : <span className="opacity-50">還沒有紀念日</span>}
                </div>
            )}
        </div>
    );
});

// 4b. 紀念日（原本最後一頁下半）：一頁幾則照小組件的高度
const EventsWidget = React.memo(({ contentColor, anniversaries, characters, rows = 3, acnh = false, paper = false }: any) => {
    const acDot = acnh ? '#6fba2c' : undefined;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const upcomingEvents = useMemo(
        () => [...(anniversaries as any[])]
            .filter((a: any) => nextOccurrenceDate(a, todayStr) >= todayStr)
            .sort((a: any, b: any) => nextOccurrenceDate(a, todayStr).localeCompare(nextOccurrenceDate(b, todayStr))),
        [anniversaries, todayStr],
    );
    const perPage = Math.max(1, rows - 1);
    const eventPageCount = Math.max(1, Math.ceil(upcomingEvents.length / perPage));
    const [eventPage, setEventPage] = useState(0);
    useEffect(() => {
        if (eventPage > eventPageCount - 1) setEventPage(eventPageCount - 1);
    }, [eventPageCount, eventPage]);
    const pagedEvents = upcomingEvents.slice(eventPage * perPage, eventPage * perPage + perPage);
    return (
        <div className={`w-full h-full rounded-3xl p-4 flex flex-col overflow-hidden ${cardClass(acnh, paper)}`} style={cardStyle(acnh, paper)}>
            <div className="flex items-center justify-between mb-3 shrink-0">
                <h3 className="text-xs font-bold opacity-60 uppercase tracking-widest flex items-center gap-2" style={{ color: contentColor }}>
                    <span className="w-2 h-2 rounded-full" style={{ background: acDot || (paper ? '#a66f52' : '#c084fc') }}></span> Upcoming Events
                </h3>
                {eventPageCount > 1 && (
                    <div className="flex items-center gap-2 shrink-0" style={{ color: contentColor }}>
                        <button onClick={(e) => { e.stopPropagation(); setEventPage(p => Math.max(0, p - 1)); }} disabled={eventPage === 0}
                            className={`w-6 h-6 rounded-full flex items-center justify-center disabled:opacity-25 transition-colors active:scale-90 ${paper ? 'bg-[#788369]/10 hover:bg-[#788369]/20' : 'bg-white/15 hover:bg-white/30'}`} aria-label="Previous events">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
                        </button>
                        <span className="text-[10px] font-mono opacity-60 tabular-nums">{eventPage + 1}/{eventPageCount}</span>
                        <button onClick={(e) => { e.stopPropagation(); setEventPage(p => Math.min(eventPageCount - 1, p + 1)); }} disabled={eventPage >= eventPageCount - 1}
                            className={`w-6 h-6 rounded-full flex items-center justify-center disabled:opacity-25 transition-colors active:scale-90 ${paper ? 'bg-[#788369]/10 hover:bg-[#788369]/20' : 'bg-white/15 hover:bg-white/30'}`} aria-label="Next events">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                        </button>
                    </div>
                )}
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-hidden">
                {upcomingEvents.length > 0 ? pagedEvents.map((anni: any) => (
                    <div key={anni.id} className={`flex items-center gap-3 p-2.5 rounded-xl ${acnh ? 'bg-[#efe7d4] border border-[#e0d6c0]' : paper ? 'bg-[#f3ecdf]/70 border border-[#5b4833]/10' : 'bg-white/5 border border-white/10'}`}>
                        <div className={`w-9 h-9 shrink-0 rounded-lg flex flex-col items-center justify-center ${acnh ? 'bg-[#82D5BB] text-white border border-[#6cc0a6]' : paper ? 'bg-[#a66f52]/12 text-[#8c5d46] border border-[#a66f52]/15' : 'bg-purple-500/20 text-purple-200 border border-purple-500/30'}`}>
                            <span className="text-[9px] opacity-70">{anni.date.split('-')[1]}</span>
                            <span className="text-sm font-bold leading-none">{anni.date.split('-')[2]}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold truncate" style={{ color: contentColor }}>{anni.title}</div>
                            <div className="text-[10px] opacity-50 truncate" style={{ color: contentColor }}>{anniversaryCharNames(anni, characters)}</div>
                        </div>
                    </div>
                )) : (
                    <div className="text-center opacity-30 text-xs py-6" style={{ color: contentColor }}>No upcoming events</div>
                )}
            </div>
        </div>
    );
});

// --- Persist scroll page across remounts (e.g. returning from apps) ---
let _lastPageIndex = 0;

const isWidget = (item: LauncherItem): item is LauncherWidgetItem => item.kind === 'widget';

/** 拖到哪一格：預覽框的位置、能不能放 */
/** push：放下去會把蓋到的往下擠 */
interface DropPreview { pageId: string; x: number; y: number; w: number; h: number; ok: boolean; push?: boolean }

// --- Main Launcher ---

const Launcher: React.FC = () => {
  const { openApp, characters, activeCharacterId, setActiveCharacterId, theme, updateTheme, lastMsgTimestamp, isDataLoaded, unreadMessages, addToast, userProfile } = useOS();

  // Local state for widget data to prevent context trashing
  const [widgetChar, setWidgetChar] = useState<CharacterProfile | null>(null);
  const [lastMessage, setLastMessage] = useState<string>('');
  const [anniversaries, setAnniversaries] = useState<Anniversary[]>([]);
  const [scheduleData, setScheduleData] = useState<DailySchedule | null>(null);
  const [scheduleCharId, setScheduleCharId] = useState<string | null>(null);
  const [scheduleViewerOpen, setScheduleViewerOpen] = useState(false);
  const [layoutEditing, setLayoutEditing] = useState(false);
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [settingsItemId, setSettingsItemId] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const widgetFileInputRef = useRef<HTMLInputElement>(null);
  /** 自訂小組件編輯器：null 關著；initial 是要改的模板（新建是 null）；placeAfterSave 存好順手放上桌面 */
  // retargetItemId：從桌面上某一份範本點「編輯模板」，存好後那一份改指新複製出來的模板
  const [editorState, setEditorState] = useState<{ initial: CustomWidgetTemplate | null; placeAfterSave?: boolean; retargetItemId?: string } | null>(null);
  const [gridCell, setGridCell] = useState({ w: 76, h: 88 });
  const layoutPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutPointer = useRef<{
      pointerId: number;
      key: string;
      kind: string;
      x: number;
      y: number;
      active: boolean;
      element: HTMLElement;
      ghost?: HTMLElement;
      grabOffsetX?: number;
      grabOffsetY?: number;
      grabCellX?: number;
      grabCellY?: number;
      lastTarget?: string;
      targetElement?: HTMLElement;
      /** 網格的 app 拖到 Dock 上：index 是蓋到 Dock 的第幾個（交換），沒有是放在空處（接在最後） */
      dockTarget?: { index?: number } | null;
      /** 按下去的時候已經在整理中 */
      editMode?: boolean;
      preview?: DropPreview | null;
  } | null>(null);
  const suppressLayoutClickUntil = useRef(0);
  const launcherRootRef = useRef<HTMLDivElement>(null);
  // 抓起東西之後擋掉捲動：React 的 onTouchMove 是 passive 的，preventDefault 沒用，只能自己掛非 passive 的。
  // 不抓的時候不擋，整理中照樣能左右滑頁。
  useEffect(() => {
      const root = launcherRootRef.current;
      if (!root) return;
      const onTouchMove = (event: TouchEvent) => { if (layoutPointer.current?.active && event.cancelable) event.preventDefault(); };
      root.addEventListener('touchmove', onTouchMove, { passive: false });
      return () => root.removeEventListener('touchmove', onTouchMove);
  }, [theme.skin]); // 手遊風、電子寵物、觸感陪伴換掉整個桌面，換回來要重掛
  const layoutPageTurnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutPageTurnDirection = useRef<-1 | 0 | 1>(0);

  const [activePageIndex, setActivePageIndex] = useState(_lastPageIndex);
  const activePageIndexRef = useRef(_lastPageIndex);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Mouse Drag Logic refs
  const isDragging = useRef(false);
  const startX = useRef(0);
  const scrollLeftRef = useRef(0);
  const dragMoved = useRef(0);

  // 跟隨 DevDebug 可用性：prod 用戶在設置頁連點 5 下解鎖後，CharCreatorDev 立刻出現；
  // 點「關閉」/ 刷新（prod 自動失效）也立刻消失。
  const [devDebugVisible, setDevDebugVisible] = useState(() => isDevDebugAvailable());
  useEffect(() => subscribeDevDebugAvailability(setDevDebugVisible), []);
  // 桌面上能出現的 app（Dock 和網格合起來）；「捏臉·開發」僅在開發模式（右下角開發徽標可見或手動解鎖時）顯示
  const installedIds = useMemo(() => INSTALLED_APPS
      .filter(app => app.id !== AppID.CharCreatorDev || devDebugVisible)
      .map(app => app.id as string), [devDebugVisible]);
  const appsById = useMemo(() => new Map(INSTALLED_APPS.map(app => [app.id as string, app])), []);

  // Dock 第三格從舊的 Social 換成朋友圈（Moments）：存過自訂順序的，原位替換，不然 Social 被濾掉、
  // 朋友圈接到最後，別的 App 會往前擠一格。
  const migrateLegacyDockOrder = (saved: string[] | undefined): string[] | undefined =>
      saved?.map(id => (id === AppID.Social ? AppID.Moments : id));
  const normalizeOrder = useCallback((saved: string[] | undefined, available: string[]) => {
      const valid = new Set(available);
      return [...(saved || []).filter((id, index, all) => valid.has(id) && all.indexOf(id) === index), ...available.filter(id => !(saved || []).includes(id))];
  }, []);

  // Dock（utils/launcherLayout.ts 的 normalizeDockOrder）：沒存過是預設那四個；存過照存的，搬走的不會自動補回來
  const [launcherDockOrder, setLauncherDockOrder] = useState<string[]>(() => normalizeDockOrder(migrateLegacyDockOrder(theme.launcherDockOrder), installedIds, DOCK_APPS));
  const launcherDockOrderRef = useRef(launcherDockOrder);
  useEffect(() => { launcherDockOrderRef.current = launcherDockOrder; }, [launcherDockOrder]);
  useEffect(() => {
      if (layoutEditing) return;
      const next = normalizeDockOrder(migrateLegacyDockOrder(theme.launcherDockOrder), installedIds, DOCK_APPS);
      launcherDockOrderRef.current = next;
      setLauncherDockOrder(next);
  }, [layoutEditing, installedIds, theme.launcherDockOrder]);
  const setDockOrder = useCallback((next: string[]) => {
      launcherDockOrderRef.current = next;
      setLauncherDockOrder(next);
  }, []);
  // 網格上的 app＝全部扣掉 Dock 裡的
  const availableGridIds = useMemo(() => installedIds.filter(id => !launcherDockOrder.includes(id)), [installedIds, launcherDockOrder]);

  // 桌面網格（utils/launcherLayout.ts）：存過就用存的，沒存過照舊版寫死的那幾頁排出來
  const resolveLayout = useCallback((): LauncherLayout => {
      const saved = normalizeLayout(theme.launcherLayout, availableGridIds);
      if (saved) return saved;
      const legacy = buildLegacyLayout({
          gridAppIds: normalizeOrder(theme.launcherAppOrder, availableGridIds),
          pinwheelOrder: theme.launcherPinwheelOrder,
          widgetImages: theme.launcherWidgets,
          hasDecorations: !!theme.desktopDecorations?.length,
      });
      return normalizeLayout(legacy, availableGridIds) || legacy;
  }, [availableGridIds, normalizeOrder, theme.launcherLayout, theme.launcherAppOrder, theme.launcherPinwheelOrder, theme.launcherWidgets, theme.desktopDecorations]);
  const [layout, setLayout] = useState<LauncherLayout>(resolveLayout);
  const layoutRef = useRef(layout);
  useEffect(() => {
      if (layoutEditing) return;
      const next = resolveLayout();
      layoutRef.current = next;
      setLayout(next);
  }, [layoutEditing, resolveLayout]);
  /** extra：同一次要一起寫的主題欄位。updateTheme 是拿當下的 theme 合併，連著呼叫兩次後一次會蓋掉前一次 */
  const commitLayout = useCallback((next: LauncherLayout, extra?: Partial<OSTheme>) => {
      layoutRef.current = next;
      setLayout(next);
      void updateTheme({ ...extra, launcherLayout: next });
  }, [updateTheme]);

  // Dock 樣式（外觀 → Dock，utils/dockStyle.ts）：自訂的底圖要先把令牌解成網址
  const dockImageUrl = useBlobRefUrl(theme.dockStyle === 'custom' ? theme.dockCustom?.image : undefined);

  // 自訂小組件的模板（utils/customWidget.ts）
  const customTemplates = useMemo(() => theme.launcherCustomWidgets || [], [theme.launcherCustomWidgets]);
  // 解析桌面上那幾份：自己的模板＋範本（`starter:<id>`，從程式現拿、不存進「我的小組件」）
  const customTemplatesById = useMemo(() => new Map([...STARTER_TEMPLATES, ...customTemplates].map(t => [t.id, t])), [customTemplates]);

  const dockAppsConfig = useMemo(() => {
      return launcherDockOrder.map(id => appsById.get(id)).filter(Boolean) as typeof INSTALLED_APPS;
  }, [launcherDockOrder, appsById]);

  const totalPages = layout.pages.length;
  useEffect(() => { activePageIndexRef.current = activePageIndex; }, [activePageIndex]);
  useEffect(() => {
      if (activePageIndex > totalPages - 1) {
          const last = Math.max(0, totalPages - 1);
          setActivePageIndex(last);
          activePageIndexRef.current = last;
          _lastPageIndex = last;
      }
  }, [activePageIndex, totalPages]);

  useEffect(() => {
      let cancelled = false;
      const loadData = async () => {
          // SAFEGUARD: If characters array is empty, reset widget char
          if (!characters || characters.length === 0) {
              setWidgetChar(null);
              setLastMessage('No Character Connected');
              setAnniversaries([]);
              return;
          }

          const targetChar = characters.find(c => c.id === activeCharacterId) || characters[0];
          setWidgetChar(targetChar);

          try {
              const [recent, annis] = await Promise.all([
                  DB.getRecentMessagesWithCount(targetChar.id, 1, isChatPreviewMessage),
                  DB.getAllAnniversaries()
              ]);
              if (cancelled) return;
              const last = recent.messages[0];
              if (last) {
                  const cleanContent = last.content.replace(/\[.*?\]/g, '').trim();
                  setLastMessage(cleanContent || (last.type === 'image' ? '[圖片]' : '[消息]'));
              } else {
                  setLastMessage(targetChar.description || "System Ready.");
              }
              setAnniversaries(annis);
          } catch (e) {
              console.error(e);
          }
      };

      if (isDataLoaded) {
          loadData();
      }
      return () => { cancelled = true; };
  }, [activeCharacterId, lastMsgTimestamp, isDataLoaded, characters]); // Trigger on characters change

  // Schedule widget data loading
  const scheduleChar = useMemo(() => {
      if (!characters || characters.length === 0) return null;
      if (scheduleCharId) return characters.find(c => c.id === scheduleCharId) || characters[0];
      return characters.find(c => c.id === activeCharacterId) || characters[0];
  }, [characters, scheduleCharId, activeCharacterId]);
  const scheduleDateKey = useLocalDateKey(resolveCharTimeZone(scheduleChar));

  useEffect(() => {
      if (!scheduleChar || !isDataLoaded) return;
      getDailyScheduleForChar(scheduleChar).then(s => setScheduleData(s)).catch(() => {});
  }, [scheduleChar, isDataLoaded, scheduleDateKey]);

  // Restore scroll position BEFORE paint to avoid visible flash/slide
  useLayoutEffect(() => {
      const el = scrollContainerRef.current;
      if (el && _lastPageIndex > 0) {
          el.style.scrollBehavior = 'auto';
          el.scrollLeft = el.clientWidth * _lastPageIndex;
          requestAnimationFrame(() => { el.style.scrollBehavior = 'smooth'; });
      }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleScroll = () => {
      if (scrollContainerRef.current) {
          const width = scrollContainerRef.current.clientWidth;
          const scrollLeft = scrollContainerRef.current.scrollLeft;
          const index = Math.round(scrollLeft / width);
          setActivePageIndex(index);
          activePageIndexRef.current = index;
          _lastPageIndex = index; // Persist across remounts
      }
  };

  const scrollToPage = (index: number) => {
      const scroller = scrollContainerRef.current;
      activePageIndexRef.current = index;
      setActivePageIndex(index);
      _lastPageIndex = index;
      // 新加的頁要等渲染出來才捲得過去
      requestAnimationFrame(() => scroller?.scrollTo({ left: scroller.clientWidth * index, behavior: 'smooth' }));
  };

  // --- Mouse Drag Handlers ---
  const handleMouseDown = (e: React.MouseEvent) => {
      if (!scrollContainerRef.current) return;
      // 整理中按在 app／小組件上是要拖它；按在空白處照樣能滑頁
      if (layoutEditing && (e.target as HTMLElement).closest('[data-launcher-item],[data-launcher-control]')) return;
      isDragging.current = true;
      dragMoved.current = 0;
      startX.current = e.pageX - scrollContainerRef.current.offsetLeft;
      scrollLeftRef.current = scrollContainerRef.current.scrollLeft;
      scrollContainerRef.current.style.scrollBehavior = 'auto';
      scrollContainerRef.current.style.scrollSnapType = 'none';
      scrollContainerRef.current.style.cursor = 'grabbing';
  };

  const handleMouseMove = (e: React.MouseEvent) => {
      if (!isDragging.current || !scrollContainerRef.current) return;
      e.preventDefault();
      const x = e.pageX - scrollContainerRef.current.offsetLeft;
      const walk = (x - startX.current);
      scrollContainerRef.current.scrollLeft = scrollLeftRef.current - walk;
      dragMoved.current = Math.abs(x - (startX.current + scrollContainerRef.current.offsetLeft));
  };

  const handleMouseUp = () => {
      if (!isDragging.current || !scrollContainerRef.current) return;
      isDragging.current = false;
      scrollContainerRef.current.style.scrollBehavior = 'smooth';
      scrollContainerRef.current.style.scrollSnapType = 'x mandatory';
      scrollContainerRef.current.style.cursor = 'grab';
  };

  const handleMouseLeave = () => {
      if (isDragging.current) handleMouseUp();
  };

  const handleClickCapture = (e: React.MouseEvent) => {
      if (dragMoved.current > 5 || Date.now() < suppressLayoutClickUntil.current) {
          e.stopPropagation();
          e.preventDefault();
      }
  };

  const reorderDock = useCallback((source: string, target: string) => {
      if (source === target) return;
      const items = launcherDockOrderRef.current;
      const from = items.indexOf(source);
      const to = items.indexOf(target);
      if (from < 0 || to < 0) return;
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      launcherDockOrderRef.current = next;
      setLauncherDockOrder(next);
  }, []);

  const clearLayoutPressTimer = useCallback(() => {
      if (layoutPressTimer.current) clearTimeout(layoutPressTimer.current);
      layoutPressTimer.current = null;
  }, []);

  const clearLayoutPageTurn = useCallback(() => {
      if (layoutPageTurnTimer.current) clearTimeout(layoutPageTurnTimer.current);
      layoutPageTurnTimer.current = null;
      layoutPageTurnDirection.current = 0;
  }, []);

  const activateLayoutDrag = useCallback((pointer: NonNullable<typeof layoutPointer.current>) => {
      if (pointer.ghost) return;
      const rect = pointer.element.getBoundingClientRect();
      const ghost = pointer.element.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('data-launcher-item');
      ghost.removeAttribute('data-launcher-kind');
      ghost.classList.remove('launcher-edit-item', 'launcher-drop-target');
      ghost.classList.add('launcher-drag-ghost');
      Object.assign(ghost.style, {
          position: 'fixed',
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          margin: '0',
          pointerEvents: 'none',
          zIndex: '9999',
          transform: 'scale(1.04)',
          transformOrigin: 'center',
          transition: 'none',
          gridColumn: '',
          gridRow: '',
      });
      document.body.appendChild(ghost);
      pointer.ghost = ghost;
      pointer.grabOffsetX = pointer.x - rect.left;
      pointer.grabOffsetY = pointer.y - rect.top;
      if (pointer.kind === 'grid') {
          const item = layoutRef.current.pages.flatMap(p => p.items).find(i => i.id === pointer.key);
          const w = item && isWidget(item) ? item.w : 1;
          const h = item && isWidget(item) ? item.h : 1;
          pointer.grabCellX = Math.min(w - 1, Math.max(0, Math.floor(((pointer.x - rect.left) / rect.width) * w)));
          pointer.grabCellY = Math.min(h - 1, Math.max(0, Math.floor(((pointer.y - rect.top) / rect.height) * h)));
      }
      pointer.element.classList.add('launcher-dragging');
      pointer.element.style.pointerEvents = 'none';
  }, []);

  const queueLayoutPageTurn = useCallback((direction: -1 | 1) => {
      if (layoutPageTurnDirection.current === direction && layoutPageTurnTimer.current) return;
      clearLayoutPageTurn();
      layoutPageTurnDirection.current = direction;
      const turn = () => {
          const pointer = layoutPointer.current;
          const scroller = scrollContainerRef.current;
          if (!pointer?.active || !scroller || layoutPageTurnDirection.current !== direction) {
              clearLayoutPageTurn();
              return;
          }
          const maxPage = Math.max(0, layoutRef.current.pages.length - 1);
          const nextPage = Math.max(0, Math.min(maxPage, activePageIndexRef.current + direction));
          if (nextPage === activePageIndexRef.current) {
              clearLayoutPageTurn();
              return;
          }
          pointer.preview = null;
          setDropPreview(null);
          activePageIndexRef.current = nextPage;
          setActivePageIndex(nextPage);
          _lastPageIndex = nextPage;
          scroller.scrollTo({ left: scroller.clientWidth * nextPage, behavior: 'smooth' });
          layoutPageTurnTimer.current = setTimeout(turn, 760);
      };
      layoutPageTurnTimer.current = setTimeout(turn, 560);
  }, [clearLayoutPageTurn]);

  useEffect(() => () => {
      clearLayoutPressTimer();
      clearLayoutPageTurn();
      layoutPointer.current?.ghost?.remove();
  }, [clearLayoutPageTurn, clearLayoutPressTimer]);

  const handleLayoutPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      // 手指不走滑鼠拖頁那條；iOS 補發的相容滑鼠事件偶爾只有 mousedown 沒有 mouseup，留著的位移會把之後的點擊全擋掉
      if (e.pointerType !== 'mouse') { isDragging.current = false; dragMoved.current = 0; }
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if ((e.target as HTMLElement).closest('[data-launcher-control]')) return;
      const launcherRoot = e.currentTarget;
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-launcher-item]');
      if (!item) return;
      const key = item.dataset.launcherItem;
      const kind = item.dataset.launcherKind;
      if (!key || !kind) return;
      clearLayoutPressTimer();
      // 上一次的沒收乾淨（iOS 長按圖片跳出系統選單時不一定給 pointerup／pointercancel）：先收掉殘留的影子和半透明
      if (layoutPointer.current) finishLayoutPointer();
      layoutPointer.current = { pointerId: e.pointerId, key, kind, x: e.clientX, y: e.clientY, active: false, element: item, editMode: layoutEditing };
      if (layoutEditing) {
          // 整理中：手指按住不動一下（180ms）才抓起來，按下去馬上滑就是翻頁（按在 app 上也能滑）；
          // 抓起來之後的 touchmove 由 useEffect 那個非 passive 的監聽擋掉捲動。沒動就放開是點一下（打開小組件的設定）。
          // 滑鼠不會捲頁，直接抓。
          const arm = () => {
              const pointer = layoutPointer.current;
              if (!pointer || pointer.pointerId !== e.pointerId) return;
              pointer.active = true;
              try { launcherRoot.setPointerCapture(e.pointerId); } catch { /* 指標已經沒了 */ }
          };
          if (e.pointerType === 'mouse') { arm(); e.preventDefault(); return; }
          layoutPressTimer.current = setTimeout(arm, 180);
          return;
      }
      layoutPressTimer.current = setTimeout(() => {
          if (!layoutPointer.current || layoutPointer.current.pointerId !== e.pointerId) return;
          layoutPointer.current.active = true;
          activateLayoutDrag(layoutPointer.current);
          launcherRoot.setPointerCapture(e.pointerId);
          isDragging.current = false;
          suppressLayoutClickUntil.current = Date.now() + 700;
          setLayoutEditing(true);
          trackEvent('进入桌面整理模式');
      }, 520);
  };

  const updateGridPreview = (pointer: NonNullable<typeof layoutPointer.current>, clientX: number, clientY: number) => {
      const grid = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-launcher-grid]');
      const pageId = grid?.dataset.launcherGrid;
      // 從 Dock 拖出來的：pointer.key 是 app id，不在網格上
      const fromDock = pointer.kind === 'dock';
      const item = fromDock ? null : layoutRef.current.pages.flatMap(p => p.items).find(i => i.id === pointer.key);
      if (!grid || !pageId || (!fromDock && !item)) {
          if (pointer.preview) { pointer.preview = null; setDropPreview(null); }
          return;
      }
      const cell = cellFromPoint(grid.getBoundingClientRect(), clientX, clientY);
      const size: WidgetSize = item && isWidget(item) ? { w: item.w, h: item.h } : { w: 1, h: 1 };
      const x = Math.max(0, Math.min(GRID_COLS - size.w, cell.x - (pointer.grabCellX || 0)));
      const y = Math.max(0, Math.min(GRID_ROWS - size.h, cell.y - (pointer.grabCellY || 0)));
      const prev = pointer.preview;
      if (prev && prev.pageId === pageId && prev.x === x && prev.y === y) return;
      const result = !inBounds(x, y, size) ? null
          : fromDock ? moveDockAppToGrid(layoutRef.current, launcherDockOrderRef.current, pointer.key, pageId, x, y)
          : moveItem(layoutRef.current, pointer.key, pageId, x, y);
      const ok = !!result?.ok;
      // 蓋到東西、又不是一樣大的交換：放下去會往下擠
      const targetPage = layoutRef.current.pages.find(p => p.id === pageId);
      const blockers = targetPage ? itemsInArea(targetPage, { x, y, ...size }, fromDock ? undefined : pointer.key) : [];
      const swap = blockers.length === 1 && blockers[0].x === x && blockers[0].y === y
          && (isWidget(blockers[0]) ? blockers[0].w : 1) === size.w && (isWidget(blockers[0]) ? blockers[0].h : 1) === size.h;
      const next = { pageId, x, y, ...size, ok, push: ok && blockers.length > 0 && !swap };
      pointer.preview = next;
      setDropPreview(next);
  };

  const handleLayoutPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const pointer = layoutPointer.current;
      if (!pointer || pointer.pointerId !== e.pointerId) return;
      if (!pointer.active) {
          if (Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 9) {
              clearLayoutPressTimer();
              layoutPointer.current = null;
          }
          return;
      }
      e.preventDefault();
      if (!pointer.ghost) {
          if (Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) < 6) return;
          activateLayoutDrag(pointer);
      }
      if (pointer.ghost) {
          pointer.ghost.style.left = `${e.clientX - (pointer.grabOffsetX || 0)}px`;
          pointer.ghost.style.top = `${e.clientY - (pointer.grabOffsetY || 0)}px`;
      }
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const overDock = under?.closest<HTMLElement>('[data-launcher-dock]');
      const rootRect = e.currentTarget.getBoundingClientRect();
      if (!overDock && e.clientX <= rootRect.left + 40) queueLayoutPageTurn(-1);
      else if (!overDock && e.clientX >= rootRect.right - 40) queueLayoutPageTurn(1);
      else clearLayoutPageTurn();
      const highlight = (el: HTMLElement | undefined, className: string) => {
          if (el === pointer.targetElement) return;
          pointer.targetElement?.classList.remove('launcher-drop-target', 'launcher-dock-drop');
          el?.classList.add(className);
          pointer.targetElement = el;
      };

      if (!overDock) {
          // 在網格上：網格的東西照舊；Dock 拖出來的 app 也看格子
          highlight(undefined, '');
          pointer.lastTarget = undefined;
          pointer.dockTarget = null;
          updateGridPreview(pointer, e.clientX, e.clientY);
          return;
      }
      if (pointer.preview) { pointer.preview = null; setDropPreview(null); }
      const dockItem = under?.closest<HTMLElement>('[data-launcher-kind="dock"]');
      const dockKey = dockItem?.dataset.launcherItem;
      if (pointer.kind === 'dock') {
          // Dock 裡互換順序
          if (dockKey && dockKey !== pointer.key) { highlight(dockItem!, 'launcher-drop-target'); pointer.lastTarget = dockKey; }
          else { highlight(undefined, ''); pointer.lastTarget = undefined; }
          return;
      }
      // 網格的 app 拖到 Dock：蓋到某一個是交換，空處是接在最後（小組件放不進 Dock）
      const dragged = layoutRef.current.pages.flatMap(p => p.items).find(i => i.id === pointer.key);
      if (!dragged || dragged.kind !== 'app') { highlight(undefined, ''); pointer.dockTarget = null; return; }
      const index = dockKey ? launcherDockOrderRef.current.indexOf(dockKey) : -1;
      if (index >= 0) { highlight(dockItem!, 'launcher-drop-target'); pointer.dockTarget = { index }; }
      else if (launcherDockOrderRef.current.length < DOCK_MAX) { highlight(overDock, 'launcher-dock-drop'); pointer.dockTarget = {}; }
      else { highlight(undefined, ''); pointer.dockTarget = null; }
  };

  const finishLayoutPointer = (e?: React.PointerEvent<HTMLDivElement>) => {
      const pointer = layoutPointer.current;
      if (e && pointer && pointer.pointerId !== e.pointerId) return;
      clearLayoutPressTimer();
      clearLayoutPageTurn();
      if (pointer && !pointer.active && pointer.editMode && e?.type === 'pointerup' && Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) < 9) {
          // 整理中很快點一下（還沒抓起來就放開）：小組件打開設定
          const tapped = layoutRef.current.pages.flatMap(p => p.items).find(i => i.id === pointer.key);
          if (tapped && isWidget(tapped)) setSettingsItemId(tapped.id);
      }
      if (pointer?.active) {
          suppressLayoutClickUntil.current = Date.now() + 500;
          pointer.element.style.pointerEvents = '';
          pointer.element.classList.remove('launcher-dragging');
          pointer.ghost?.remove();
          pointer.targetElement?.classList.remove('launcher-drop-target', 'launcher-dock-drop');
          if (!pointer.ghost && e?.type === 'pointerup') {
              // 整理中點一下：小組件打開設定
              const tapped = layoutRef.current.pages.flatMap(p => p.items).find(i => i.id === pointer.key);
              if (tapped && isWidget(tapped)) setSettingsItemId(tapped.id);
          } else if (pointer.kind === 'grid' && pointer.dockTarget) {
              // 網格的 app 放進 Dock（Dock 和版面一次寫回去）
              const result = moveAppToDock(layoutRef.current, launcherDockOrderRef.current, pointer.key, pointer.dockTarget.index);
              if (result.ok) { setDockOrder(result.dock); commitLayout(result.layout, { launcherDockOrder: result.dock }); }
          } else if (pointer.kind === 'dock' && pointer.preview?.ok) {
              // Dock 的 app 放到網格
              const preview = pointer.preview;
              const result = moveDockAppToGrid(layoutRef.current, launcherDockOrderRef.current, pointer.key, preview.pageId, preview.x, preview.y);
              if (result.ok) {
                  setDockOrder(result.dock);
                  commitLayout(result.layout, { launcherDockOrder: result.dock });
                  if (result.overflowed) addToast(`這頁擠不下，${result.overflowed} 個移到後面的頁了`, 'info');
              }
          } else if (pointer.kind === 'grid') {
              const preview = pointer.preview;
              if (preview?.ok) {
                  const result = moveItem(layoutRef.current, pointer.key, preview.pageId, preview.x, preview.y);
                  if (result.ok && result.layout !== layoutRef.current) {
                      commitLayout(result.layout);
                      if (result.overflowed) addToast(`這頁擠不下，${result.overflowed} 個移到後面的頁了`, 'info');
                  }
              }
          } else if (pointer.kind === 'dock' && pointer.lastTarget) {
              reorderDock(pointer.key, pointer.lastTarget);
              void updateTheme({ launcherDockOrder: launcherDockOrderRef.current });
          }
      }
      setDropPreview(null);
      layoutPointer.current = null;
  };

  const finishLayoutEditing = () => {
      finishLayoutPointer();
      setLayoutEditing(false);
      setAddSheetOpen(false);
      setSettingsItemId(null);
  };

  // --- 整理模式的動作 ---
  const handleAddWidget = (widgetType: BuiltinWidgetType, size: WidgetSize) => {
      const result = addWidget(layoutRef.current, activePageIndexRef.current, widgetType, size);
      commitLayout(result.layout);
      setAddSheetOpen(false);
      const pageIndex = result.layout.pages.findIndex(p => p.id === result.pageId);
      if (pageIndex >= 0 && pageIndex !== activePageIndexRef.current) scrollToPage(pageIndex);
      trackEvent('桌面新增小组件', { 类型: widgetType, 尺寸: sizeLabel(size) });
      if (widgetType === 'image') setSettingsItemId(result.item.id);
  };
  const handleAddPage = () => {
      const result = addPage(layoutRef.current, activePageIndexRef.current);
      commitLayout(result.layout);
      scrollToPage(result.pageIndex);
  };
  const handleRemovePage = (pageId: string) => {
      commitLayout(removePage(layoutRef.current, pageId));
  };
  const handleRemoveWidget = (itemId: string) => {
      commitLayout(removeWidget(layoutRef.current, itemId));
      if (settingsItemId === itemId) setSettingsItemId(null);
  };
  const handleResizeWidget = (itemId: string, size: WidgetSize) => {
      const result = resizeWidget(layoutRef.current, itemId, size);
      if (!result.ok) { addToast(`這一頁放不下 ${sizeLabel(size)}，先挪出空位`, 'info'); return; }
      commitLayout(result.layout);
  };
  const handlePickImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file || !settingsItemId) return;
      try {
          const blob = await processImageToBlob(file, { maxWidth: 1600 });
          const ref = await putImageBlob(blob);
          commitLayout(patchWidget(layoutRef.current, settingsItemId, { image: ref }));
      } catch (error: any) {
          addToast(error?.message || '圖片沒存成', 'error');
      }
  };

  // --- 自訂小組件 ---
  /** 桌面一格實際多大：編輯器預覽照這個比例畫 */
  const measureGridCell = () => {
      const grid = scrollContainerRef.current?.querySelectorAll<HTMLElement>('[data-launcher-grid]')[activePageIndexRef.current];
      const rect = grid?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
          setGridCell({ w: (rect.width - 8 * (GRID_COLS - 1)) / GRID_COLS, h: (rect.height - 12 * (GRID_ROWS - 1)) / GRID_ROWS });
      }
  };
  const openEditor = (initial: CustomWidgetTemplate | null, placeAfterSave = false, retargetItemId?: string) => {
      measureGridCell();
      setAddSheetOpen(false);
      setSettingsItemId(null);
      setEditorState({ initial, placeAfterSave, retargetItemId });
  };
  /** 桌面上某一份的「編輯模板」：範本不能直接改，複製一份成自己的，存好那一份改指它 */
  const editTemplateOf = (item: LauncherWidgetItem) => {
      const template = customTemplatesById.get(item.templateId || '');
      if (!template) return;
      if (!isStarterTemplateId(template.id)) { openEditor(template); return; }
      const now = Date.now();
      openEditor({ ...template, id: makeTemplateId(), createdAt: now, updatedAt: now }, false, item.id);
  };
  const placeCustomWidget = (template: CustomWidgetTemplate, extra?: Partial<OSTheme>) => {
      const size = { w: template.w, h: template.h };
      const result = addCustomWidget(layoutRef.current, activePageIndexRef.current, template.id, size);
      commitLayout(result.layout, extra);
      setAddSheetOpen(false);
      const pageIndex = result.layout.pages.findIndex(p => p.id === result.pageId);
      if (pageIndex >= 0 && pageIndex !== activePageIndexRef.current) scrollToPage(pageIndex);
      trackEvent('桌面新增小组件', { 类型: 'custom', 尺寸: sizeLabel(size) });
      return result.item;
  };
  /**
   * 用範本：放上桌面的那一份直接指著範本（`starter:<id>`），不複製進「我的小組件」，從桌面移除就什麼都不留。
   * 要填東西才好看的（日子、照片）順手打開這一份的設定。
   */
  const applyStarter = (starter: WidgetStarter) => {
      const template = customTemplatesById.get(starterTemplateId(starter.id));
      if (!template) return;
      const item = placeCustomWidget(template);
      trackEvent('使用桌面小组件范本', { 范本: starter.id });
      if (starter.needsSetup) setSettingsItemId(item.id);
  };
  const starterPreviews = useMemo(() => WIDGET_STARTERS.map(starter => ({ starter, template: customTemplatesById.get(starterTemplateId(starter.id))! })), [customTemplatesById]);
  // 舊版「用這個」複製進「我的小組件」、還沒改過的那些：桌面上的改指範本、複製品拿掉（只做一次，之後就沒有了）
  useEffect(() => {
      if (layoutEditing || !customTemplates.length) return;
      const copies = findUntouchedStarterCopies(customTemplates);
      if (!copies.size) return;
      const nextLayout: LauncherLayout = {
          ...layoutRef.current,
          pages: layoutRef.current.pages.map(page => ({
              ...page,
              items: page.items.map(item => (item.kind === 'widget' && item.templateId && copies.has(item.templateId) ? { ...item, templateId: copies.get(item.templateId) } : item)),
          })),
      };
      commitLayout(nextLayout, { launcherCustomWidgets: customTemplates.filter(t => !copies.has(t.id)) });
  }, [layoutEditing, customTemplates, commitLayout]);
  const saveTemplate = (template: CustomWidgetTemplate) => {
      const exists = customTemplates.some(t => t.id === template.id);
      const next = exists ? customTemplates.map(t => (t.id === template.id ? template : t)) : [...customTemplates, template];
      if (!exists) trackEvent('新建桌面自订小组件');
      if (editorState?.retargetItemId) commitLayout(patchWidget(layoutRef.current, editorState.retargetItemId, { templateId: template.id }), { launcherCustomWidgets: next });
      else if (editorState?.placeAfterSave && !exists) placeCustomWidget(template, { launcherCustomWidgets: next });
      else void updateTheme({ launcherCustomWidgets: next });
      setEditorState(null);
      addToast(exists ? '模板存好了，桌面上用它的都會更新' : '小組件做好了', 'success');
  };
  const deleteTemplate = (template: CustomWidgetTemplate) => {
      const used = countCustomWidgetsOf(layoutRef.current, template.id);
      if (!window.confirm(used ? `刪掉「${template.name}」？桌面上用它的 ${used} 份也會一起拿掉。` : `刪掉「${template.name}」？`)) return;
      const next = customTemplates.filter(t => t.id !== template.id);
      if (used) commitLayout(removeCustomWidgetsOf(layoutRef.current, template.id), { launcherCustomWidgets: next });
      else void updateTheme({ launcherCustomWidgets: next });
  };
  const exportTemplate = async (template: CustomWidgetTemplate) => {
      try {
          const imageData: Record<string, string> = {};
          for (const key of template.imageKeys) {
              const ref = template.images[key];
              if (ref) imageData[key] = await resolveRefToDataUrl(ref);
          }
          await shareOrDownloadFile({
              content: JSON.stringify(buildWidgetFile(template, imageData), null, 2),
              fileName: `${safeShareFileName(template.name)}${WIDGET_FILE_EXT}`,
              mimeType: 'application/json',
          });
          trackEvent('导出桌面小组件文件');
      } catch (error: any) {
          addToast(error?.message || '匯出失敗', 'error');
      }
  };
  const handleImportWidgetFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) { addToast('檔案太大了（超過 20 MB）', 'error'); return; }
      const parsed = parseWidgetFile(await file.text());
      if (!parsed.ok) { addToast(parsed.error, 'error'); return; }
      const images: Record<string, string> = {};
      for (const [key, dataUrl] of Object.entries(parsed.file.imageData)) {
          try { images[key] = await putImageBlob(dataUrlToBlob(dataUrl)); } catch { /* 壞掉的圖就當沒帶 */ }
      }
      const now = Date.now();
      const template: CustomWidgetTemplate = { ...parsed.file.template, images, id: makeTemplateId(), createdAt: now, updatedAt: now };
      void updateTheme({ launcherCustomWidgets: [...customTemplates, template] });
      trackEvent('导入桌面小组件文件');
      const missing = template.imageKeys.filter(k => !images[k]).length;
      const notes = [...parsed.file.notes, missing ? `有 ${missing} 張圖要自己選（放上桌面後點它，或編輯模板）` : ''].filter(Boolean);
      addToast(`匯入了「${template.name}」${notes.length ? `：${notes.join('；')}` : ''}`, 'success');
  };
  /** 小組件裡點了 data-open／widget.open：chat 進綁定角色的聊天，其他只認桌面上有的 App */
  const handleCustomOpen = (target: string, char: CharacterProfile | null) => {
      if (layoutEditing) return;
      if (target === 'chat') {
          if (!char) { openApp(AppID.ChatHub); return; }
          setActiveCharacterId(char.id);
          openApp(AppID.Chat);
          return;
      }
      const app = appsById.get(target);
      if (app) openApp(app.id as AppID);
  };

  const contentColor = theme.contentColor || '#ffffff';
  const acnh = theme.skin === 'animalcrossing'; // 動森彩蛋：Dock 換奶油木質底
  const paper = theme.skin !== 'animalcrossing' && theme.skin !== 'mobilegame' && theme.skin !== 'tamagotchi' && isPaperWallpaper(theme.wallpaper);
  // 已遷移 App 外殼已收回到可見 viewport 底邊，dock 僅需自留視覺間距，無需再 + safe-bottom
  // （否則會比 home 條上方多讓 34px，dock 看起來懸空）。
  const launcherBottomInset = '1.25rem';

  const totalUnread = Object.values(unreadMessages).reduce((a, b) => a + b, 0);
  // 訊息的未讀紅點：Message（chat_hub）在 Dock 或桌面上都掛。以前只認舊的 chat 代號，Dock 換成 Message 後就沒出現過
  const unreadBadge = (appId: string) => (appId === AppID.ChatHub || appId === AppID.Chat) && totalUnread > 0 ? (
      <div className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full text-white text-[9px] flex items-center justify-center border-2 border-white/20 shadow-sm font-bold pointer-events-none animate-pop-in">
          {totalUnread > 9 ? '9+' : totalUnread}
      </div>
  ) : null;
  const dockLook = dockContainerLook(theme.dockStyle, theme.dockCustom, { acnh, paper, imageUrl: dockImageUrl });
  const widgetUnread = widgetChar && unreadMessages[widgetChar.id] ? unreadMessages[widgetChar.id] : 0;
  // 角色卡片：直接進這個角色的聊天視窗，返回回桌面。還沒有角色時退回 Chat 主頁。
  const openWidgetChat = () => {
      if (layoutEditing) return;
      if (!widgetChar) { openApp(AppID.ChatHub); return; }
      setActiveCharacterId(widgetChar.id);
      openApp(AppID.Chat);
      trackEvent('桌面角色卡片直接进聊天');
  };

  // 手遊主題：整頁換成二次元手遊首頁佈局（獨立組件自渲染），不走下面的默認/動森啟動器。
  if (theme.skin === 'mobilegame') {
    return <MobileGameHome />;
  }

  // 電子寵物主題：桌面即養成機——角色真實小屋做舞台 + 四顆糖果實體鍵（獨立組件自渲染）。
  if (theme.skin === 'tamagotchi') {
    return <TamagotchiHome />;
  }

  if (theme.skin === 'companion') {
    return (
      <React.Suspense fallback={<div className="h-full w-full bg-[#100d1c]" />}>
        <CompanionHome />
      </React.Suspense>
    );
  }

  const renderWidget = (item: LauncherWidgetItem) => {
      switch (item.widget) {
          case 'clock':
              return item.h <= 1 ? <DesktopClock compact={item.w <= 2 ? 'narrow' : 'wide'} /> : <FitBox><DesktopClock /></FitBox>;
          case 'character':
              return <CharacterWidget char={widgetChar} unreadCount={widgetUnread} lastMessage={lastMessage} onClick={openWidgetChat} contentColor={contentColor} paper={paper} fill />;
          case 'schedule':
              return scheduleChar ? (
                  <FitBox>
                      <ScheduleHomeWidget
                          schedule={scheduleData}
                          character={scheduleChar}
                          contentColor={contentColor}
                          onOpen={() => { if (layoutEditing) return; setScheduleViewerOpen(true); trackEvent('打开角色日程面板'); }}
                          acnh={acnh}
                          paper={paper}
                      />
                  </FitBox>
              ) : null;
          case 'music':
              return <SquareBox><NowPlayingSquareWidget contentColor={contentColor} /></SquareBox>;
          case 'image':
              return <ImageWidget image={item.image} frame={item.frame} contentColor={contentColor} acnh={acnh} editing={layoutEditing} />;
          case 'calendar':
              return <CalendarWidget contentColor={contentColor} openApp={(id: string) => { if (!layoutEditing) openApp(id as AppID); }} anniversaries={anniversaries} acnh={acnh} paper={paper} w={item.w} h={item.h} />;
          case 'events':
              return <EventsWidget contentColor={contentColor} anniversaries={anniversaries} characters={characters} rows={item.h} acnh={acnh} paper={paper} />;
          case 'custom': {
              const template = item.templateId ? customTemplatesById.get(item.templateId) : undefined;
              if (!template) {
                  return (
                      <div className="grid h-full w-full place-items-center rounded-2xl border border-dashed text-center text-[10px] opacity-60" style={{ color: contentColor, borderColor: contentColor }}>
                          模板不見了
                      </div>
                  );
              }
              const char = (item.charId && characters.find(c => c.id === item.charId)) || widgetChar;
              return (
                  <CustomWidgetFrame
                    template={template}
                    size={item}
                    values={item.values}
                    images={item.images}
                    char={char}
                    unread={char ? unreadMessages[char.id] || 0 : 0}
                    lastMsgTimestamp={lastMsgTimestamp}
                    userName={userProfile?.name}
                    contentColor={contentColor}
                    interactive={!layoutEditing}
                    onOpen={target => handleCustomOpen(target, char)}
                    state={item.state}
                    onStateChange={next => commitLayout(patchWidget(layoutRef.current, item.id, { state: next }))}
                  />
              );
          }
          default:
              return null;
      }
  };

  // 桌面裝飾 DIY 那層：跟著舊版第 3 頁那一頁；沒有標記（新排的版面）就放第 3 頁
  const decorationsPageId = (layout.pages.find(p => p.decorations) || layout.pages[Math.min(2, layout.pages.length - 1)])?.id;

  const settingsItem = settingsItemId
      ? layout.pages.flatMap(p => p.items).find((i): i is LauncherWidgetItem => i.id === settingsItemId && isWidget(i)) || null
      : null;
  const editBar = {
      background: 'rgba(75,65,54,0.88)', color: '#fffdf8', boxShadow: '0 8px 24px rgba(75,65,54,0.20)',
  } as const;

  return (
    <div
      ref={launcherRootRef}
      className="h-full w-full flex flex-col relative z-10 overflow-hidden font-sans select-none"
      style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
      onPointerDown={handleLayoutPointerDown}
      onPointerMove={handleLayoutPointerMove}
      onPointerUp={finishLayoutPointer}
      onPointerCancel={finishLayoutPointer}
      onLostPointerCapture={() => { if (layoutPointer.current?.active) finishLayoutPointer(); }}
      onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('[data-launcher-item]')) e.preventDefault();
      }}
    >
      <style>{`
        /* 桌面上的圖片不吃指標：iOS 長按圖片會跳「儲存到照片」那個系統選單、或被當成原生拖曳，桌面就收不到長按和拖動 */
        [data-launcher-item] img {
          pointer-events: none;
          -webkit-user-drag: none;
          -webkit-touch-callout: none;
          user-select: none;
        }
        .launcher-edit-item {
          touch-action: pan-x;
          cursor: grab;
          transition: transform 180ms cubic-bezier(.2,.75,.25,1), opacity 150ms ease, filter 150ms ease;
          will-change: transform;
          animation: launcherJiggle 260ms ease-in-out infinite alternate;
        }
        .launcher-edit-item:nth-child(2n) { animation-delay: -130ms; }
        @keyframes launcherJiggle { from { transform: rotate(-0.9deg); } to { transform: rotate(0.9deg); } }
        @media (prefers-reduced-motion: reduce) { .launcher-edit-item { animation: none; } }
        .launcher-dragging {
          cursor: grabbing;
          opacity: .18;
          animation: none;
        }
        .launcher-drag-ghost {
          opacity: .96;
          filter: drop-shadow(0 12px 14px rgba(75,65,54,.18));
          cursor: grabbing;
          animation: none;
        }
        .launcher-dock-drop {
          outline: 2px dashed rgba(255,255,255,.75);
          outline-offset: 3px;
        }
        .launcher-drop-target {
          transform: scale(.93);
          opacity: .52;
          outline: 1.5px dashed rgba(75,65,54,.36);
          outline-offset: 5px;
          border-radius: 1.35rem;
        }
      `}</style>

      {layoutEditing && (
          <div className="absolute top-[calc(var(--safe-top)+0.65rem)] left-3 right-3 z-50 flex items-center gap-1.5 rounded-full px-2.5 py-1.5" style={editBar} data-launcher-control>
              <span className="min-w-0 flex-1 truncate pl-1 text-[10px] font-semibold tracking-wide">拖到哪放哪，蓋到的會往下擠</span>
              <button onClick={() => { measureGridCell(); setAddSheetOpen(true); }} className="shrink-0 px-2.5 py-1 rounded-full text-[10px] font-bold bg-white/15 active:scale-95">＋小組件</button>
              <button onClick={handleAddPage} className="shrink-0 px-2.5 py-1 rounded-full text-[10px] font-bold bg-white/15 active:scale-95">＋頁面</button>
              <button onClick={finishLayoutEditing} className="shrink-0 px-2.5 py-1 rounded-full text-[10px] font-bold bg-white text-[#4b4136] active:scale-95">完成</button>
          </div>
      )}

      {/* 動森模式跳過：這層冷藍光斑會汙染奶油底 */}
      {!acnh && (
      <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-20 -right-20 w-80 h-80 rounded-full" style={{ background: paper ? 'radial-gradient(circle, rgba(255,255,255,0.22) 0%, transparent 68%)' : 'radial-gradient(circle, rgba(255,255,255,0.05) 0%, transparent 70%)' }}></div>
          <div className="absolute -bottom-20 -left-20 w-80 h-80 rounded-full" style={{ background: paper ? 'radial-gradient(circle, rgba(123,104,78,0.06) 0%, transparent 68%)' : 'radial-gradient(circle, rgba(59,130,246,0.08) 0%, transparent 70%)' }}></div>
      </div>
      )}

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onClickCapture={handleClickCapture}
        className="flex-1 flex overflow-x-auto snap-x snap-mandatory no-scrollbar cursor-grab active:cursor-grabbing"
        style={{
            scrollBehavior: 'smooth',
            overscrollBehaviorX: 'contain',
            overscrollBehaviorY: 'none',
            // 整理中只能左右滑頁；按在 app／小組件上也能滑，按住不動一下才是抓起來拖（見 handleLayoutPointerDown）
            touchAction: layoutEditing ? 'pan-x' : 'pan-x pan-y',
            willChange: 'scroll-position',
            contain: 'layout paint',
            transform: 'translateZ(0)',
            WebkitOverflowScrolling: 'touch',
        }}
      >
          {layout.pages.map((page) => (
              <div
                key={page.id}
                className="w-full flex-shrink-0 snap-center snap-always flex flex-col px-6 pt-12 pb-8 h-full"
                style={{ contentVisibility: 'auto', contain: 'layout paint', transform: 'translateZ(0)' }}
              >
                  <div
                    data-launcher-grid={page.id}
                    className="relative flex-1 min-h-0 grid"
                    style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 1fr))`, columnGap: '0.5rem', rowGap: '0.75rem' }}
                  >
                      {page.items.map(item => (
                          <div
                            key={item.id}
                            data-launcher-item={item.id}
                            data-launcher-kind="grid"
                            className={`relative min-w-0 min-h-0 ${item.kind === 'app' ? 'flex items-center justify-center transition-transform duration-200 active:scale-95' : ''} ${layoutEditing ? 'launcher-edit-item' : ''}`}
                            style={{ gridColumn: `${item.x + 1} / span ${isWidget(item) ? item.w : 1}`, gridRow: `${item.y + 1} / span ${isWidget(item) ? item.h : 1}` }}
                          >
                              {item.kind === 'app' ? (
                                  appsById.get(item.appId) ? <><AppIcon app={appsById.get(item.appId)!} onClick={() => { if (!layoutEditing) openApp(item.appId as AppID); }} size="md" />{unreadBadge(item.appId)}</> : null
                              ) : renderWidget(item)}
                              {layoutEditing && isWidget(item) && (
                                  <button
                                    type="button"
                                    data-launcher-control
                                    onClick={() => handleRemoveWidget(item.id)}
                                    aria-label={`移除${item.widget === 'custom' ? customTemplatesById.get(item.templateId || '')?.name || '自訂小組件' : BUILTIN_WIDGETS[item.widget]?.name || '小組件'}`}
                                    className="absolute -left-1.5 -top-1.5 z-10 grid h-6 w-6 place-items-center rounded-full bg-[#4b4136]/85 text-[14px] font-bold leading-none text-white shadow active:scale-90"
                                  >−</button>
                              )}
                          </div>
                      ))}

                      {dropPreview && dropPreview.pageId === page.id && (
                          <div
                            className="pointer-events-none rounded-2xl"
                            style={{
                                gridColumn: `${dropPreview.x + 1} / span ${dropPreview.w}`,
                                gridRow: `${dropPreview.y + 1} / span ${dropPreview.h}`,
                                border: `2px dashed ${!dropPreview.ok ? 'rgba(248,113,113,0.85)' : dropPreview.push ? 'rgba(253,224,71,0.9)' : 'rgba(255,255,255,0.75)'}`,
                                background: !dropPreview.ok ? 'rgba(248,113,113,0.12)' : dropPreview.push ? 'rgba(253,224,71,0.14)' : 'rgba(255,255,255,0.14)',
                            }}
                          />
                      )}

                      {layoutEditing && page.items.length === 0 && (
                          <div className="col-span-4 row-span-6 flex flex-col items-center justify-center gap-3" style={{ gridColumn: '1 / span 4', gridRow: '1 / span 6', color: contentColor }}>
                              <span className="text-[11px] opacity-60">空白頁，把東西拖過來</span>
                              {layout.pages.length > 1 && (
                                  <button type="button" data-launcher-control onClick={() => handleRemovePage(page.id)}
                                    className="rounded-full px-3 py-1.5 text-[11px] font-bold" style={editBar}>刪除這一頁</button>
                              )}
                          </div>
                      )}

                      {/* 舊版第 3 頁那層自由擺放的桌面裝飾，跟著那一頁 */}
                      {page.id === decorationsPageId && theme.desktopDecorations && theme.desktopDecorations.length > 0 && (
                          <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
                              {theme.desktopDecorations.map(deco => (
                                  <img
                                    key={deco.id}
                                    src={deco.content}
                                    alt=""
                                    loading="lazy"
                                    className="absolute w-16 h-16 object-contain select-none"
                                    style={{
                                      left: `${deco.x}%`,
                                      top: `${deco.y}%`,
                                      transform: `translate(-50%, -50%) scale(${deco.scale}) rotate(${deco.rotation}deg)${deco.flip ? ' scaleX(-1)' : ''}`,
                                      opacity: deco.opacity,
                                      zIndex: deco.zIndex,
                                      filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.15))',
                                    }}
                                  />
                              ))}
                          </div>
                      )}
                  </div>
              </div>
          ))}
      </div>

      {/* Page Indicators */}
      <div
          className="absolute left-0 w-full flex justify-center gap-1 pointer-events-none z-20"
          style={{ bottom: `calc(${launcherBottomInset} + 5.5rem)` }}
          aria-hidden="true"
      >
          {Array.from({ length: totalPages }).map((_, i) => (
              // 每個頁碼佔固定 16px 槽位，只動畫內部圓點（快速劃過多頁時 WebKit 改寬會擠成方塊串）。
              <div key={i} className="flex h-1.5 w-4 shrink-0 items-center justify-center">
                  <div
                    className={`h-1.5 rounded-full transform-gpu transition-[width,opacity] duration-300 ${activePageIndex === i ? 'w-4 opacity-100' : 'w-1.5 opacity-40'}`}
                    style={{ backgroundColor: contentColor }}
                  />
              </div>
          ))}
      </div>

      {/* Floating Dock */}
      <div
           className="mt-auto flex justify-center w-full px-4 relative z-30"
           style={{ paddingBottom: launcherBottomInset }}
      >
           {/* data-launcher-dock：拖動時認得出「在 Dock 上」；空的 Dock 平常不畫，整理中留一塊能放東西的地方 */}
           {(dockAppsConfig.length > 0 || layoutEditing) && (
           <div
             data-launcher-dock
             className={`rounded-[1.75rem] px-4 py-3 flex ${dockAppsConfig.length >= DOCK_MAX ? 'gap-2' : 'gap-3 sm:gap-6'} items-center mx-auto max-w-full justify-between overflow-x-auto no-scrollbar transform-gpu ${dockLook.className}`}
             style={{ ...dockLook.style, ...(dockAppsConfig.length === 0 ? { minWidth: '12rem', minHeight: '4.75rem', justifyContent: 'center' } : {}) }}
           >
               {dockAppsConfig.length === 0 && <span className="text-[10px] font-semibold opacity-60" style={{ color: contentColor }}>把 app 拖到這裡</span>}
               {dockAppsConfig.map(app => (
                   <div key={app.id} data-launcher-item={app.id} data-launcher-kind="dock" className={`relative ${layoutEditing ? 'launcher-edit-item' : ''}`}>
                        <AppIcon app={app} onClick={() => { if (!layoutEditing) openApp(app.id); }} variant="dock" size="md" />
                        {unreadBadge(app.id)}
                   </div>
               ))}
           </div>
           )}
      </div>

      {/* ＋小組件 */}
      {addSheetOpen && (
          <div className="absolute inset-0 z-[60] flex items-end bg-black/30" data-launcher-control onClick={() => setAddSheetOpen(false)}>
              <div className="w-full max-h-[75%] overflow-y-auto rounded-t-3xl bg-[#fffdf8] px-5 pt-4 text-[#3f362c]" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 1.25rem)' }} onClick={e => e.stopPropagation()}>
                  <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[#3f362c]/15" />
                  <h3 className="text-[15px] font-bold">加一個小組件</h3>
                  <p className="mt-0.5 text-[11px] text-[#3f362c]/55">選尺寸（寬×高）就放上目前這一頁；放不下會放到後面有空的頁。</p>
                  <div className="mt-4 text-[11px] font-bold text-[#3f362c]/55">不知道放什麼？從範本開始</div>
                  <div className="mt-1.5 grid grid-cols-2 gap-2">
                      {starterPreviews.map(({ starter, template }) => {
                          const real = pixelSize(template, gridCell);
                          const scale = Math.min(1, 132 / real.width, 92 / real.height);
                          return (
                              <div key={starter.id} className="flex flex-col rounded-2xl bg-[#3f362c]/[0.04] p-2">
                                  <div className="grid h-[100px] place-items-center overflow-hidden rounded-xl" style={{ background: 'linear-gradient(135deg,#8a9bb0,#c3a6a0 55%,#e6d3b8)' }} aria-hidden="true">
                                      <div style={{ width: real.width * scale, height: real.height * scale }}>
                                          <div style={{ width: real.width, height: real.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                                              <CustomWidgetFrame template={template} size={template} char={widgetChar} userName={userProfile?.name} contentColor={contentColor} interactive={false} />
                                          </div>
                                      </div>
                                  </div>
                                  <div className="mt-1.5 flex items-baseline justify-between gap-1 px-0.5">
                                      <span className="truncate text-[12px] font-bold">{starter.name}</span>
                                      <span className="shrink-0 text-[10px] tabular-nums text-[#3f362c]/45">{sizeLabel(template)}</span>
                                  </div>
                                  <p className="mb-1.5 mt-0.5 line-clamp-2 px-0.5 text-[10px] leading-snug text-[#3f362c]/55">{starter.description}</p>
                                  <button type="button" onClick={() => applyStarter(starter)} className="mt-auto rounded-full bg-[#4b4136] py-1 text-[11px] font-bold text-white active:scale-95">用這個</button>
                              </div>
                          );
                      })}
                  </div>
                  <div className="mt-5 text-[11px] font-bold text-[#3f362c]/55">內建</div>
                  <div className="mt-1.5 space-y-3">
                      {(Object.keys(BUILTIN_WIDGETS) as BuiltinWidgetType[]).map(type => {
                          const spec = BUILTIN_WIDGETS[type];
                          const taken = !spec.multiple && hasWidget(layout, type);
                          return (
                              <div key={type} className="rounded-2xl bg-[#3f362c]/[0.04] px-3.5 py-3">
                                  <div className="flex items-center justify-between">
                                      <span className="text-[13px] font-bold">{spec.name}</span>
                                      {taken && <span className="text-[10px] text-[#3f362c]/45">桌面上已經有了</span>}
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                      {spec.sizes.map(size => (
                                          <button key={sizeLabel(size)} type="button" disabled={taken} onClick={() => handleAddWidget(type, size)}
                                            className="rounded-full border border-[#3f362c]/15 bg-white px-3 py-1 text-[11px] font-bold tabular-nums active:scale-95 disabled:opacity-35">
                                              {sizeLabel(size)}
                                          </button>
                                      ))}
                                  </div>
                              </div>
                          );
                      })}
                  </div>
                  <div className="mt-5 flex items-center justify-between">
                      <h4 className="text-[13px] font-bold">自訂小組件</h4>
                      <div className="flex gap-1.5">
                          <button type="button" onClick={() => widgetFileInputRef.current?.click()} className="rounded-full border border-[#3f362c]/15 bg-white px-3 py-1 text-[11px] font-bold active:scale-95">匯入檔案</button>
                          <button type="button" onClick={() => openEditor(null, true)} className="rounded-full bg-[#4b4136] px-3 py-1 text-[11px] font-bold text-white active:scale-95">＋新建</button>
                      </div>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[#3f362c]/55">自己寫 HTML／CSS，或匯入 <code className="font-mono">{WIDGET_FILE_EXT}</code> 小組件檔。</p>
                  <div className="mt-4 text-[11px] font-bold text-[#3f362c]/55">我的小組件</div>
                  <div className="mt-1.5 space-y-2">
                      {customTemplates.length === 0 && (
                          <div className="rounded-2xl border border-dashed border-[#3f362c]/20 px-3.5 py-4 text-center text-[11px] text-[#3f362c]/45">還沒有自己的。用上面的範本，或按「＋新建」</div>
                      )}
                      {customTemplates.map(template => {
                          const used = countCustomWidgetsOf(layout, template.id);
                          return (
                              <div key={template.id} className="rounded-2xl bg-[#3f362c]/[0.04] px-3.5 py-3">
                                  <div className="flex items-center justify-between gap-2">
                                      <span className="min-w-0 truncate text-[13px] font-bold">{template.name}</span>
                                      <span className="shrink-0 text-[10px] tabular-nums text-[#3f362c]/45">{sizeLabel(template)}{used ? ` · 桌面上 ${used} 份` : ''}</span>
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                      <button type="button" onClick={() => placeCustomWidget(template)} className="rounded-full bg-[#4b4136] px-3 py-1 text-[11px] font-bold text-white active:scale-95">放上桌面</button>
                                      <button type="button" onClick={() => openEditor(template)} className="rounded-full border border-[#3f362c]/15 bg-white px-3 py-1 text-[11px] font-bold active:scale-95">編輯</button>
                                      <button type="button" onClick={() => exportTemplate(template)} className="rounded-full border border-[#3f362c]/15 bg-white px-3 py-1 text-[11px] font-bold active:scale-95">匯出</button>
                                      <button type="button" onClick={() => deleteTemplate(template)} className="rounded-full px-2.5 py-1 text-[11px] font-bold text-red-400 active:scale-95">刪除</button>
                                  </div>
                              </div>
                          );
                      })}
                  </div>
              </div>
          </div>
      )}

      {/* 自訂小組件這一份的設定 */}
      {settingsItem && settingsItem.widget === 'custom' && customTemplatesById.get(settingsItem.templateId || '') && (
          <CustomWidgetSettings
            item={settingsItem}
            template={customTemplatesById.get(settingsItem.templateId || '')!}
            characters={characters}
            onResize={size => handleResizeWidget(settingsItem.id, size)}
            onPatch={patch => commitLayout(patchWidget(layoutRef.current, settingsItem.id, patch))}
            onEditTemplate={() => editTemplateOf(settingsItem)}
            onRemove={() => handleRemoveWidget(settingsItem.id)}
            onClose={() => setSettingsItemId(null)}
            notify={addToast}
          />
      )}

      {/* 小組件設定（整理中點一下小組件） */}
      {settingsItem && (settingsItem.widget !== 'custom' || !customTemplatesById.get(settingsItem.templateId || '')) && (
          <div className="absolute inset-0 z-[60] flex items-end bg-black/30" data-launcher-control onClick={() => setSettingsItemId(null)}>
              <div className="w-full rounded-t-3xl bg-[#fffdf8] px-5 pt-4 text-[#3f362c]" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 1.25rem)' }} onClick={e => e.stopPropagation()}>
                  <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[#3f362c]/15" />
                  <h3 className="text-[15px] font-bold">{settingsItem.widget === 'custom' ? '模板不見了' : BUILTIN_WIDGETS[settingsItem.widget]?.name || '小組件'}</h3>
                  <div className="mt-3">
                      <div className="text-[11px] font-bold text-[#3f362c]/55">尺寸（寬×高）</div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {settingsItem.widget !== 'custom' && BUILTIN_WIDGETS[settingsItem.widget]?.sizes.map(size => {
                              const current = size.w === settingsItem.w && size.h === settingsItem.h;
                              return (
                                  <button key={sizeLabel(size)} type="button" onClick={() => handleResizeWidget(settingsItem.id, size)}
                                    className={`rounded-full border px-3 py-1 text-[11px] font-bold tabular-nums active:scale-95 ${current ? 'border-[#4b4136] bg-[#4b4136] text-white' : 'border-[#3f362c]/15 bg-white'}`}>
                                      {sizeLabel(size)}
                                  </button>
                              );
                          })}
                      </div>
                  </div>
                  {settingsItem.widget === 'image' && (
                      <div className="mt-4 space-y-2.5">
                          <button type="button" onClick={() => imageInputRef.current?.click()} className="w-full rounded-xl bg-[#3f362c]/[0.06] py-2.5 text-[13px] font-bold active:scale-[0.98]">
                              {settingsItem.image ? '換一張圖片' : '選一張圖片'}
                          </button>
                          <label className="flex items-center justify-between rounded-xl bg-[#3f362c]/[0.04] px-3.5 py-2.5">
                              <span>
                                  <span className="block text-[13px] font-bold">外框與陰影</span>
                                  <span className="block text-[10px] text-[#3f362c]/50">關著時去背的 PNG 直接透出、不留白框；開了會裁成圓角卡片</span>
                              </span>
                              <input type="checkbox" checked={!!settingsItem.frame} onChange={e => commitLayout(patchWidget(layoutRef.current, settingsItem.id, { frame: e.target.checked }))} className="h-5 w-5 accent-[#4b4136]" />
                          </label>
                      </div>
                  )}
                  <div className="mt-4 grid grid-cols-2 gap-2">
                      <button type="button" onClick={() => handleRemoveWidget(settingsItem.id)} className="rounded-xl bg-red-50 py-2.5 text-[13px] font-bold text-red-500 active:scale-[0.98]">移除</button>
                      <button type="button" onClick={() => setSettingsItemId(null)} className="rounded-xl bg-[#4b4136] py-2.5 text-[13px] font-bold text-white active:scale-[0.98]">好了</button>
                  </div>
              </div>
          </div>
      )}
      <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handlePickImage} />
      <input ref={widgetFileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImportWidgetFile} />

      {editorState && (
          <CustomWidgetEditor
            initial={editorState.initial}
            cell={gridCell}
            previewChar={widgetChar}
            userName={userProfile?.name}
            contentColor={contentColor}
            onSave={saveTemplate}
            onClose={() => setEditorState(null)}
            onExport={exportTemplate}
            notify={addToast}
          />
      )}

      <ScheduleFullscreenViewer
          open={scheduleViewerOpen}
          onClose={() => setScheduleViewerOpen(false)}
          characters={characters}
          activeCharId={scheduleChar?.id || null}
          onSwitchCharacter={(id) => setScheduleCharId(id)}
          schedule={scheduleData}
          activeCharacter={scheduleChar}
          contentColor={contentColor}
      />

    </div>
  );
};

export default Launcher;
