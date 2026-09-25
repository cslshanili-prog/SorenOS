import React from 'react';
import { CaretLeft } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import MomentsFeed from '../components/moments/MomentsFeed';

/**
 * 桌面 Dock 上的「朋友圈」：單一貼文池的用戶視角（路線圖第 6 項），跟 Chat 主頁的「動態」分頁是同一份。
 * 舊的沖浪 App（Spark / SocialApp）不動，退回桌面格子裡。
 */
const MomentsApp: React.FC = () => {
    const { closeApp } = useOS();
    return (
        <div className="h-full w-full bg-slate-50 flex flex-col animate-fade-in">
            <div className="bg-white/80 backdrop-blur-md border-b border-slate-100 shrink-0 sticky top-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center gap-2 px-3 py-3">
                    <button onClick={closeApp} aria-label="返回" className="p-1.5 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                        <CaretLeft size={22} className="text-slate-600" />
                    </button>
                    <span className="text-base font-bold text-slate-800">朋友圈</span>
                </div>
            </div>
            <div className="flex-1 overflow-y-auto no-scrollbar" style={{ paddingBottom: 'calc(var(--safe-bottom) + 4rem)' }}>
                <MomentsFeed
                    viewerId="user"
                    interactive
                    emptyHint="還沒有動態。發第一條吧，角色們看得到、也會在底下回你。"
                />
            </div>
        </div>
    );
};

export default MomentsApp;
