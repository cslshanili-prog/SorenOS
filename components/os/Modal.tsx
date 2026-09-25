import React, { useEffect, useRef } from 'react';

interface ModalProps {
    isOpen: boolean;
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    footer?: React.ReactNode;
}

/**
 * 共用彈窗。高度跟著 --app-height 走（utils/iosStandalone.ts 在軟鍵盤升起時把它收到鍵盤上方的可視高度），
 * 不用 inset-0 / vh：iOS 全屏 PWA 彈鍵盤時「版面視窗」不會變矮，按它置中的彈窗會有半截跑到螢幕外，
 * 內容區也因為沒超出自己的上限而滑不動，只能收鍵盤才看得到剛打的字。
 * 卡片最高到可視區為止，標題和底部按鈕固定，中間內容區自己捲；鍵盤升起後把正在輸入的欄位捲進來。
 */
const Modal: React.FC<ModalProps> = ({ isOpen, title, onClose, children, footer }) => {
    const cardRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen || typeof window === 'undefined') return;
        const viewport = window.visualViewport;
        if (!viewport) return;
        let frame = 0;
        const revealFocused = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const active = document.activeElement as HTMLElement | null;
                if (!active || !cardRef.current?.contains(active)) return;
                try { active.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* 舊版 iOS */ }
            });
        };
        viewport.addEventListener('resize', revealFocused);
        return () => {
            cancelAnimationFrame(frame);
            viewport.removeEventListener('resize', revealFocused);
        };
    }, [isOpen]);

    if (!isOpen) return null;

    return (
        <div
            className="sully-modal-overlay fixed inset-x-0 top-0 z-[100] flex items-center justify-center p-6 animate-fade-in"
            style={{ height: 'var(--app-height, 100%)' }}
            onClick={e => e.stopPropagation()}
        >
            <div className="absolute inset-0 bg-black/40" onClick={onClose} />
            <div ref={cardRef} className="relative w-full max-w-sm max-h-full flex flex-col bg-white rounded-[2.5rem] shadow-2xl border border-white/20 overflow-hidden animate-slide-up">
                <div className="px-6 pt-6 pb-2 shrink-0">
                    <h3 className="text-lg font-bold text-slate-800 text-center">{title}</h3>
                </div>
                <div className="px-6 py-4 max-h-[60vh] min-h-0 shrink overflow-y-auto overscroll-contain no-scrollbar">
                    {children}
                </div>
                {footer ? (
                    <div className="px-6 pb-6 flex gap-3 shrink-0">
                        {footer}
                    </div>
                ) : (
                    <div className="px-6 pb-6 shrink-0">
                        <button
                            onClick={onClose}
                            className="w-full py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform"
                        >
                            關閉
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default Modal;
