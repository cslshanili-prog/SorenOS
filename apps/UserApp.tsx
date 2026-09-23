
import React, { useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { chatReturnTarget } from '../utils/chatReturnTarget';
import IdentitySwitcher from '../components/user/IdentitySwitcher';
import UserProfileHome from '../components/user/UserProfileHome';

/**
 * 桌面「檔案」App：個人檔案。內容本體是 UserProfileHome（Chat 的「主頁」分頁也用同一份），
 * 頁首只留返回鍵和身份切換（頭像＋名字，下拉切換／新增身份卡）。
 */
const UserApp: React.FC = () => {
    const { closeApp, openApp } = useOS();

    // 有入口設過 chatReturnTarget 的，返回鍵回那裡而不是無腦回桌面；沒設的行為不變。
    const handleClose = useCallback(() => {
        const target = chatReturnTarget.consume();
        if (target) openApp(target); else closeApp();
    }, [openApp, closeApp]);

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col animate-fade-in">
            <div className="bg-white/70 backdrop-blur-md border-b border-slate-100 shrink-0 sticky top-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center px-4 py-3 gap-2">
                    <button onClick={handleClose} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform" aria-label="返回">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-6 h-6 text-slate-600">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <IdentitySwitcher />
                </div>
            </div>

            <div className="flex-1 min-h-0" style={{ paddingBottom: 'var(--safe-bottom)' }}>
                <UserProfileHome />
            </div>
        </div>
    );
};

export default UserApp;
