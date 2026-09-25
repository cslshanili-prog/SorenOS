import React from 'react';
import { useOS } from '../context/OSContext';
import MomentsFeed from '../components/moments/MomentsFeed';

/**
 * 桌面 Dock 上的「朋友圈」：單一貼文池的用戶視角（路線圖第 6 項），跟 Chat 主頁的「動態」分頁是同一份。
 * 封面鋪到最頂，返回鍵、↻、＋ 浮在封面上。舊的沖浪 App（Spark / SocialApp）不動，退回桌面格子裡。
 */
const MomentsApp: React.FC = () => {
    const { closeApp } = useOS();
    return (
        <div className="h-full w-full bg-white flex flex-col animate-fade-in">
            <div className="flex-1 overflow-y-auto no-scrollbar" style={{ paddingBottom: 'calc(var(--safe-bottom) + 4rem)' }}>
                <MomentsFeed
                    onBack={closeApp}
                    emptyHint="還沒有動態。按右上角 ＋ 發第一條，或按 ↻ 讓角色們發幾篇。"
                />
            </div>
        </div>
    );
};

export default MomentsApp;
