
import React, { useCallback, useState } from 'react';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';
import { chatReturnTarget } from '../utils/chatReturnTarget';
import LifeRecordPanel from '../components/lifeRecord/LifeRecordPanel';
import PerCharAvatarPicker from '../components/user/PerCharAvatarPicker';
import PerCharPersonaPicker from '../components/user/PerCharPersonaPicker';
import PerGroupPersonaPicker from '../components/user/PerGroupPersonaPicker';
import UserPersonaPanel from '../components/user/UserPersonaPanel';
import TokenImg from '../components/os/TokenImg';
import { trackEvent } from '../utils/analytics';

const UserApp: React.FC = () => {
    // userProfile 是套用了「目前身份」之後的那份——頂部這張卡只讀顯示當前生效的身份，
    // 編輯統一去下面「身份卡」（含真實身份自己的名字/頭像/簡介），選哪張就顯示哪張。
    const { closeApp, openApp, userProfile } = useOS();
    const [tab, setTab] = useState<'profile' | 'life'>('profile');

    // 從 Chat 主頁「主頁」tab 點進來的，返回鍵回 Chat 主頁而不是無腦回桌面；
    // 別的入口（設置裡的快捷方式等）沒設這個，行為不變。
    const handleClose = useCallback(() => {
        const target = chatReturnTarget.consume();
        if (target) openApp(target); else closeApp();
    }, [openApp, closeApp]);

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col animate-fade-in">
            {/* Header */}
            <div className="bg-white/70 backdrop-blur-md border-b border-slate-100 shrink-0 sticky top-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center px-4 py-3 gap-2">
                    <button onClick={handleClose} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-6 h-6 text-slate-600">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <h1 className="text-lg font-bold text-slate-700 tracking-wide">個人檔案</h1>
                </div>
                <p className="px-4 pb-2 text-[10px] leading-relaxed text-slate-400">生理期、藥盒、記帳與鍛鍊，也可以讓角色幫你記。</p>
                {/* Tab：我的檔案 / 生活記錄 */}
                <div className="flex gap-1.5 px-4 pb-2.5">
                    {([['profile', '我的檔案'], ['life', '生活記錄']] as const).map(([key, label]) => (
                        <button
                            key={key}
                            onClick={() => { setTab(key); trackEvent('切换个人档案标签页', { tab: key }); }}
                            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors ${
                                tab === key ? 'bg-primary text-white shadow-sm' : 'bg-slate-100 text-slate-400'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5 space-y-5">
                {tab === 'life' && <LifeRecordPanel />}
                {tab === 'profile' && <>

                {/* 身份卡：多套角色扮演身份，全局切換「目前身份」；真實身份的名字/頭像/簡介也在這裡編輯 */}
                <UserPersonaPanel />

                {/* Profile 卡：只讀顯示當前生效的身份（真實身份或切換到的身份卡），隨上面的選擇自動更新 */}
                <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.25)] border border-slate-100 overflow-hidden">
                    {/* Cover banner */}
                    <div className="relative h-24" style={{ background: 'linear-gradient(135deg, hsl(var(--primary-hue),var(--primary-sat),72%) 0%, hsl(var(--primary-hue),var(--primary-sat),60%) 100%)' }}>
                        {/* soft decorative blobs */}
                        <div className="absolute -top-6 -right-4 w-28 h-28 rounded-full" style={{ background: 'rgba(255,255,255,0.18)' }} />
                        <div className="absolute top-6 left-6 w-16 h-16 rounded-full" style={{ background: 'rgba(255,255,255,0.12)' }} />
                    </div>

                    <div className="px-6 pb-6 -mt-12">
                        <div className="relative w-24 h-24 rounded-full mx-auto">
                            <div className="w-full h-full rounded-full ring-4 ring-white bg-slate-100 overflow-hidden shadow-md">
                                <TokenImg value={userProfile.avatar} className="w-full h-full object-cover" />
                            </div>
                        </div>
                        <p className="mt-3 text-center text-xl font-bold text-slate-800">{userProfile.name}</p>
                        <p className="mt-1 text-center text-[10px] text-slate-400">當前生效的身份——去上面「身份卡」切換或編輯。</p>
                    </div>
                </div>

                {/* 分角色身份指定：給某個角色單獨綁一張身份卡，不跟著上面的全域切換走 */}
                <PerCharPersonaPicker />

                {/* 群聊身份指定：跟分角色身份指定同一個概念，鍵換成 groupId */}
                <PerGroupPersonaPicker />

                {/* 分角色聊天頭像：上面的頭像是宏觀默認，這裡可給每個角色的私聊單獨換「你」的頭像 */}
                <PerCharAvatarPicker />
                </>}
            </div>
        </div>
    );
};

export default UserApp;
