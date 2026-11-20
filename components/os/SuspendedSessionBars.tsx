import React from 'react';
import { Heart, PhoneCall } from '@phosphor-icons/react';
import { AppID } from '../../types';
import { useOS } from '../../context/OSContext';
import { useSuspendedDate } from '../../utils/dateSuspend';

/**
 * 頂端「通話中 · TA」「見面中 · TA」：點一下回到掛著的那通電話／那場見面。
 *
 * 位置一律從安全區下緣起算（--safe-top）：iPhone 頂端那一截是系統狀態列，
 * 點擊會先被 iOS 吃掉（點狀態列捲回頂端），放在裡面的按鈕永遠點不到。
 * 以前「通話中」寫死 top: 28px，正好整條落在那一截裡。
 *
 * 顏色：通話是綠底白字（跟手機的通話中一樣），見面是琥珀底深字。都不用紅色：
 * 見面原本是紅底白字加一顆白點，看起來像報錯。前面的圖示跟各自 App 的圖示同一個。
 */
const SuspendedSessionBars: React.FC = () => {
    const { activeApp, isLocked, suspendedCall, resumeCall, openApp } = useOS();
    const suspendedDate = useSuspendedDate();
    const showCall = !!suspendedCall && activeApp !== AppID.Call;
    const showDate = !!suspendedDate && activeApp !== AppID.Date;
    if (isLocked || (!showCall && !showDate)) return null;

    const pill = 'pointer-events-auto flex items-center gap-1.5 rounded-full pl-2.5 pr-3 h-7 text-[11px] font-bold shadow-lg active:scale-95 transition-transform';

    return (
        <div
            className="absolute left-0 right-0 z-[55] flex flex-col items-center gap-1 pointer-events-none"
            style={{ top: 'calc(var(--safe-top, 0px) + 4px)' }}
        >
            {showCall && (
                <button type="button" onClick={resumeCall} className={`${pill} bg-emerald-500 text-white`} data-suspended-bar="call" aria-label={`回到和${suspendedCall!.charName}的通話`}>
                    <PhoneCall size={13} weight="fill" className="animate-pulse" />
                    <span className="max-w-[10rem] truncate">通話中 · {suspendedCall!.charName}</span>
                    <span className="opacity-70">返回</span>
                </button>
            )}
            {showDate && (
                <button type="button" onClick={() => openApp(AppID.Date)} className={`${pill} bg-amber-400 text-amber-950 ring-1 ring-amber-200/70`} data-suspended-bar="date" aria-label={`回到和${suspendedDate!.charName}的見面`}>
                    <Heart size={13} weight="fill" className="animate-pulse" />
                    <span className="max-w-[10rem] truncate">見面中 · {suspendedDate!.charName}</span>
                    <span className="opacity-70">返回</span>
                </button>
            )}
        </div>
    );
};

export default SuspendedSessionBars;
