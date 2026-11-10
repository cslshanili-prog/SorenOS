import React, { useMemo, useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react';
import { isPaperWallpaper, useOS } from '../context/OSContext';
import { INSTALLED_APPS, DOCK_APPS } from '../constants';
import { isDevDebugAvailable, subscribeDevDebugAvailability } from '../utils/devDebug';
import AppIcon from '../components/os/AppIcon';
import TokenImg from '../components/os/TokenImg';
import { useBlobRefUrl } from '../utils/blobRef';
import { DB } from '../utils/db';
import { isChatPreviewMessage } from '../utils/chatMessageVisibility';
import { CharacterProfile, Anniversary, AppID, DailySchedule } from '../types';
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
    BUILTIN_WIDGETS, GRID_COLS, GRID_ROWS, addPage, addWidget, buildLegacyLayout, cellFromPoint, hasWidget, inBounds, itemsInArea,
    moveItem, normalizeLayout, patchWidget, removePage, removeWidget, resizeWidget, sizeLabel,
    type BuiltinWidgetType, type LauncherItem, type LauncherLayout, type LauncherWidgetItem, type WidgetSize,
} from '../utils/launcherLayout';

const CompanionHome = React.lazy(() => import('../components/os/CompanionHome'));

// --- Isolated Components to prevent full re-renders ---

// 1. Clock Component (Consumes virtualTime)
const DesktopClock = React.memo(() => {
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

// 4. 月曆（原本最後一頁上半）
const CalendarWidget = React.memo(({ contentColor, openApp, anniversaries, acnh = false, paper = false }: any) => {
    const acDot = acnh ? '#6fba2c' : undefined;
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const monthName = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][currentMonth];
    const totalDays = new Date(currentYear, currentMonth + 1, 0).getDate();
    const startOffset = new Date(currentYear, currentMonth, 1).getDay();
    const calendarDays = Array.from({ length: totalDays }, (_, i) => i + 1);
    const paddingDays = Array.from({ length: startOffset }, () => null);
    return (
        <FitBox>
            <div className={`rounded-3xl p-5 ${cardClass(acnh, paper)}`} style={cardStyle(acnh, paper)}>
                <div className="flex justify-between items-center mb-3" style={{ color: contentColor }}>
                    <h3 className="text-xl font-bold tracking-widest">{monthName} {currentYear}</h3>
                    <div onClick={() => openApp('schedule')} className={`p-2 rounded-full cursor-pointer transition-colors ${acnh ? 'bg-[#82D5BB]/30 hover:bg-[#82D5BB]/50' : paper ? 'bg-[#788369]/10 hover:bg-[#788369]/20' : 'bg-white/20 hover:bg-white/40'}`}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                    </div>
                </div>
                <div className="grid grid-cols-7 gap-x-1 text-center mb-1.5">
                    {CALENDAR_WEEKDAYS.map(day => <div key={day.key} className="text-[10px] font-bold opacity-40" style={{ color: contentColor }}>{day.label}</div>)}
                </div>
                <div className="grid grid-cols-7 gap-y-1 gap-x-1 text-center">
                    {paddingDays.map((_, i) => <div key={`pad-${i}`} />)}
                    {calendarDays.map(day => {
                        const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                        const isToday = day === now.getDate();
                        const hasEvent = anniversaries.some((a: any) => a.date === dateStr || (a.repeatAnnually && a.date.slice(5) === dateStr.slice(5)));
                        return (
                            <div key={day} className="flex flex-col items-center justify-center h-8 relative">
                                <div
                                    className={`w-8 h-8 flex items-center justify-center rounded-full text-sm font-medium ${isToday ? (acnh ? 'text-white font-bold' : paper ? 'text-white font-bold' : 'bg-white text-black font-bold shadow-lg') : 'opacity-80'}`}
                                    style={isToday ? (acnh ? { background: '#19c8b9' } : paper ? { background: '#788369', boxShadow: '0 4px 10px rgba(91,72,51,0.14)' } : {}) : { color: contentColor }}
                                >
                                    {day}
                                </div>
                                {hasEvent && <div className="w-1.5 h-1.5 rounded-full absolute bottom-0 shadow-sm border border-black/10" style={{ background: acDot || (paper ? '#a66f52' : '#c084fc') }}></div>}
                            </div>
                        );
                    })}
                </div>
            </div>
        </FitBox>
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
interface DropPreview { pageId: string; x: number; y: number; w: number; h: number; ok: boolean }

// --- Main Launcher ---

const Launcher: React.FC = () => {
  const { openApp, characters, activeCharacterId, setActiveCharacterId, theme, updateTheme, lastMsgTimestamp, isDataLoaded, unreadMessages, addToast } = useOS();

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
      preview?: DropPreview | null;
  } | null>(null);
  const suppressLayoutClickUntil = useRef(0);
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
  const availableGridApps = useMemo(() => {
    return INSTALLED_APPS.filter(app =>
      !DOCK_APPS.includes(app.id)
      // 「捏臉·開發」僅在開發模式（右下角開發徽標可見或手動解鎖時）顯示
      && (app.id !== AppID.CharCreatorDev || devDebugVisible)
    );
  }, [devDebugVisible]);
  const appsById = useMemo(() => new Map(INSTALLED_APPS.map(app => [app.id as string, app])), []);

  // Dock 第三格從舊的 Social 換成朋友圈（Moments）：存過自訂順序的，原位替換，不然 Social 被濾掉、
  // 朋友圈接到最後，別的 App 會往前擠一格。
  const migrateLegacyDockOrder = (saved: string[] | undefined): string[] | undefined =>
      saved?.map(id => (id === AppID.Social ? AppID.Moments : id));
  const normalizeOrder = useCallback((saved: string[] | undefined, available: string[]) => {
      const valid = new Set(available);
      return [...(saved || []).filter((id, index, all) => valid.has(id) && all.indexOf(id) === index), ...available.filter(id => !(saved || []).includes(id))];
  }, []);

  const availableGridIds = useMemo(() => availableGridApps.map(app => app.id as string), [availableGridApps]);
  const [launcherDockOrder, setLauncherDockOrder] = useState<string[]>(() => normalizeOrder(migrateLegacyDockOrder(theme.launcherDockOrder), DOCK_APPS));
  const launcherDockOrderRef = useRef(launcherDockOrder);
  useEffect(() => { launcherDockOrderRef.current = launcherDockOrder; }, [launcherDockOrder]);
  useEffect(() => {
      if (layoutEditing) return;
      const next = normalizeOrder(migrateLegacyDockOrder(theme.launcherDockOrder), DOCK_APPS);
      launcherDockOrderRef.current = next;
      setLauncherDockOrder(next);
  }, [layoutEditing, normalizeOrder, theme.launcherDockOrder]);

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
  const commitLayout = useCallback((next: LauncherLayout) => {
      layoutRef.current = next;
      setLayout(next);
      void updateTheme({ launcherLayout: next });
  }, [updateTheme]);

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
      if (!scrollContainerRef.current || layoutEditing) return;
      isDragging.current = true;
      dragMoved.current = 0;
      startX.current = e.pageX - scrollContainerRef.current.offsetLeft;
      scrollLeftRef.current = scrollContainerRef.current.scrollLeft;
      scrollContainerRef.current.style.scrollBehavior = 'auto';
      scrollContainerRef.current.style.scrollSnapType = 'none';
      scrollContainerRef.current.style.cursor = 'grabbing';
  };

  const handleMouseMove = (e: React.MouseEvent) => {
      if (layoutEditing || !isDragging.current || !scrollContainerRef.current) return;
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
          if (!pointer?.active || pointer.kind !== 'grid' || !scroller || layoutPageTurnDirection.current !== direction) {
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
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if ((e.target as HTMLElement).closest('[data-launcher-control]')) return;
      const launcherRoot = e.currentTarget;
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-launcher-item]');
      if (!item) return;
      const key = item.dataset.launcherItem;
      const kind = item.dataset.launcherKind;
      if (!key || !kind) return;
      clearLayoutPressTimer();
      layoutPointer.current = { pointerId: e.pointerId, key, kind, x: e.clientX, y: e.clientY, active: layoutEditing, element: item };
      if (layoutEditing) {
          // 整理中：先不抓起來，移動超過一點才算拖；沒動就是點一下（打開小組件的設定）
          launcherRoot.setPointerCapture(e.pointerId);
          e.preventDefault();
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
      const item = layoutRef.current.pages.flatMap(p => p.items).find(i => i.id === pointer.key);
      if (!grid || !pageId || !item) {
          if (pointer.preview) { pointer.preview = null; setDropPreview(null); }
          return;
      }
      const cell = cellFromPoint(grid.getBoundingClientRect(), clientX, clientY);
      const size: WidgetSize = isWidget(item) ? { w: item.w, h: item.h } : { w: 1, h: 1 };
      const x = Math.max(0, Math.min(GRID_COLS - size.w, cell.x - (pointer.grabCellX || 0)));
      const y = Math.max(0, Math.min(GRID_ROWS - size.h, cell.y - (pointer.grabCellY || 0)));
      const prev = pointer.preview;
      if (prev && prev.pageId === pageId && prev.x === x && prev.y === y) return;
      const ok = inBounds(x, y, size) && moveItem(layoutRef.current, pointer.key, pageId, x, y).ok;
      const next = { pageId, x, y, ...size, ok };
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
      const rootRect = e.currentTarget.getBoundingClientRect();
      if (pointer.kind === 'grid' && e.clientX <= rootRect.left + 40) queueLayoutPageTurn(-1);
      else if (pointer.kind === 'grid' && e.clientX >= rootRect.right - 40) queueLayoutPageTurn(1);
      else clearLayoutPageTurn();
      if (pointer.kind === 'grid') {
          updateGridPreview(pointer, e.clientX, e.clientY);
          return;
      }
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-launcher-item]');
      const targetKey = target?.dataset.launcherItem;
      const targetKind = target?.dataset.launcherKind;
      const validTarget = !!targetKey && targetKind === pointer.kind && targetKey !== pointer.key;
      if (!validTarget) {
          pointer.targetElement?.classList.remove('launcher-drop-target');
          pointer.targetElement = undefined;
          pointer.lastTarget = undefined;
          return;
      }
      if (target === pointer.targetElement) return;
      pointer.targetElement?.classList.remove('launcher-drop-target');
      target?.classList.add('launcher-drop-target');
      pointer.targetElement = target;
      pointer.lastTarget = targetKey;
  };

  const finishLayoutPointer = (e?: React.PointerEvent<HTMLDivElement>) => {
      const pointer = layoutPointer.current;
      if (e && pointer && pointer.pointerId !== e.pointerId) return;
      clearLayoutPressTimer();
      clearLayoutPageTurn();
      if (pointer?.active) {
          suppressLayoutClickUntil.current = Date.now() + 500;
          pointer.element.style.pointerEvents = '';
          pointer.element.classList.remove('launcher-dragging');
          pointer.ghost?.remove();
          pointer.targetElement?.classList.remove('launcher-drop-target');
          if (!pointer.ghost && e) {
              // 整理中點一下：小組件打開設定
              const tapped = layoutRef.current.pages.flatMap(p => p.items).find(i => i.id === pointer.key);
              if (tapped && isWidget(tapped)) setSettingsItemId(tapped.id);
          } else if (pointer.kind === 'grid') {
              const preview = pointer.preview;
              if (preview?.ok) {
                  const result = moveItem(layoutRef.current, pointer.key, preview.pageId, preview.x, preview.y);
                  if (result.ok && result.layout !== layoutRef.current) commitLayout(result.layout);
              }
          } else if (pointer.kind === 'dock') {
              if (pointer.lastTarget) reorderDock(pointer.key, pointer.lastTarget);
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

  const contentColor = theme.contentColor || '#ffffff';
  const acnh = theme.skin === 'animalcrossing'; // 動森彩蛋：Dock 換奶油木質底
  const paper = theme.skin !== 'animalcrossing' && theme.skin !== 'mobilegame' && theme.skin !== 'tamagotchi' && isPaperWallpaper(theme.wallpaper);
  // 已遷移 App 外殼已收回到可見 viewport 底邊，dock 僅需自留視覺間距，無需再 + safe-bottom
  // （否則會比 home 條上方多讓 34px，dock 看起來懸空）。
  const launcherBottomInset = '1.25rem';

  const totalUnread = Object.values(unreadMessages).reduce((a, b) => a + b, 0);
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
              return <FitBox><DesktopClock /></FitBox>;
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
              return <CalendarWidget contentColor={contentColor} openApp={(id: string) => { if (!layoutEditing) openApp(id as AppID); }} anniversaries={anniversaries} acnh={acnh} paper={paper} />;
          case 'events':
              return <EventsWidget contentColor={contentColor} anniversaries={anniversaries} characters={characters} rows={item.h} acnh={acnh} paper={paper} />;
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
      className="h-full w-full flex flex-col relative z-10 overflow-hidden font-sans select-none"
      onPointerDown={handleLayoutPointerDown}
      onPointerMove={handleLayoutPointerMove}
      onPointerUp={finishLayoutPointer}
      onPointerCancel={finishLayoutPointer}
      onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('[data-launcher-item]')) e.preventDefault();
      }}
    >
      <style>{`
        .launcher-edit-item {
          touch-action: none;
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
              <span className="min-w-0 flex-1 truncate pl-1 text-[10px] font-semibold tracking-wide">拖到空格放下，一樣大的會交換</span>
              <button onClick={() => setAddSheetOpen(true)} className="shrink-0 px-2.5 py-1 rounded-full text-[10px] font-bold bg-white/15 active:scale-95">＋小組件</button>
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
            touchAction: layoutEditing ? 'none' : 'pan-x pan-y',
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
                                  appsById.get(item.appId) ? <AppIcon app={appsById.get(item.appId)!} onClick={() => { if (!layoutEditing) openApp(item.appId as AppID); }} size="md" /> : null
                              ) : renderWidget(item)}
                              {layoutEditing && isWidget(item) && (
                                  <button
                                    type="button"
                                    data-launcher-control
                                    onClick={() => handleRemoveWidget(item.id)}
                                    aria-label={`移除${BUILTIN_WIDGETS[item.widget]?.name || '小組件'}`}
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
                                border: `2px dashed ${dropPreview.ok ? 'rgba(255,255,255,0.75)' : 'rgba(248,113,113,0.85)'}`,
                                background: dropPreview.ok ? 'rgba(255,255,255,0.14)' : 'rgba(248,113,113,0.12)',
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
           <div
             className={`rounded-[1.75rem] px-4 py-3 flex gap-3 sm:gap-6 items-center mx-auto max-w-full justify-between overflow-x-auto no-scrollbar transform-gpu ${acnh || paper ? '' : 'bg-white/30 border border-white/25 shadow-[0_8px_40px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.08)]'}`}
             style={acnh ? { background: 'transparent' } : paper ? {
               background: 'rgba(224,221,215,0.42)',
               border: '1px solid rgba(91,72,51,0.07)',
               boxShadow: '0 6px 18px rgba(91,72,51,0.065)',
             } : undefined}
           >
               {dockAppsConfig.map(app => (
                   <div key={app.id} data-launcher-item={app.id} data-launcher-kind="dock" className={`relative ${layoutEditing ? 'launcher-edit-item' : ''}`}>
                        <AppIcon app={app} onClick={() => { if (!layoutEditing) openApp(app.id); }} variant="dock" size="md" />
                        {app.id === 'chat' && totalUnread > 0 && (
                            <div className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full text-white text-[9px] flex items-center justify-center border-2 border-white/20 shadow-sm font-bold pointer-events-none animate-pop-in">
                                {totalUnread > 9 ? '9+' : totalUnread}
                            </div>
                        )}
                   </div>
               ))}
           </div>
      </div>

      {/* ＋小組件 */}
      {addSheetOpen && (
          <div className="absolute inset-0 z-[60] flex items-end bg-black/30" data-launcher-control onClick={() => setAddSheetOpen(false)}>
              <div className="w-full max-h-[75%] overflow-y-auto rounded-t-3xl bg-[#fffdf8] px-5 pt-4 text-[#3f362c]" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 1.25rem)' }} onClick={e => e.stopPropagation()}>
                  <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[#3f362c]/15" />
                  <h3 className="text-[15px] font-bold">加一個小組件</h3>
                  <p className="mt-0.5 text-[11px] text-[#3f362c]/55">選尺寸（寬×高）就放上目前這一頁；放不下會放到後面有空的頁。</p>
                  <div className="mt-4 space-y-3">
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
                  <p className="mt-4 text-[10px] leading-relaxed text-[#3f362c]/45">自己寫 HTML／CSS 的小組件、匯入小組件檔，下一批就來。</p>
              </div>
          </div>
      )}

      {/* 小組件設定（整理中點一下小組件） */}
      {settingsItem && (
          <div className="absolute inset-0 z-[60] flex items-end bg-black/30" data-launcher-control onClick={() => setSettingsItemId(null)}>
              <div className="w-full rounded-t-3xl bg-[#fffdf8] px-5 pt-4 text-[#3f362c]" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 1.25rem)' }} onClick={e => e.stopPropagation()}>
                  <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[#3f362c]/15" />
                  <h3 className="text-[15px] font-bold">{BUILTIN_WIDGETS[settingsItem.widget]?.name || '小組件'}</h3>
                  <div className="mt-3">
                      <div className="text-[11px] font-bold text-[#3f362c]/55">尺寸（寬×高）</div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {BUILTIN_WIDGETS[settingsItem.widget]?.sizes.map(size => {
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
