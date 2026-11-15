/**
 * 聊天根容器的底色、底紋、背景圖（聊天畫面和裝扮 App 的預覽共用，plans/decoration-app.md）。
 * 動森彩蛋另外處理，不在這裡。
 */
import type React from 'react';
import type { OSTheme } from '../types';

export const chatRootLook = (osTheme: Pick<OSTheme, 'chatChromeStyle' | 'chatBackgroundStyle'>, resolvedBackground?: string | null): { className: string; style: React.CSSProperties } => {
    const chrome = osTheme.chatChromeStyle || 'soft';
    const bg = osTheme.chatBackgroundStyle || 'plain';
    const base = 'flex flex-col h-full overflow-hidden relative font-sans transition-[background-image,background-color] duration-500';
    const className = `${base} ${chrome === 'pixel' ? 'bg-[#efe1cf]' : chrome === 'flat' ? 'bg-white' : chrome === 'floating' ? 'bg-[#eef2ff]' : 'bg-[#f1f5f9]'}`;
    // 令牌還在讀盤、或者圖已經丟了時 resolvedBackground 是 undefined，這一幀按「沒設背景」的樣式走，免得渲染出一個 url("undefined")。
    const style: React.CSSProperties = resolvedBackground
        ? { backgroundImage: `url("${resolvedBackground}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
        : bg === 'grid'
            ? {
                backgroundColor: chrome === 'pixel' ? '#efe1cf' : '#f8fafc',
                backgroundImage: 'linear-gradient(rgba(148,163,184,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.14) 1px, transparent 1px)',
                backgroundSize: '20px 20px',
            }
            : bg === 'paper'
                ? {
                    backgroundColor: chrome === 'pixel' ? '#f4e8d9' : '#f9f7f2',
                    backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(148,163,184,0.12) 1px, transparent 0)',
                    backgroundSize: '16px 16px',
                }
                : bg === 'mesh'
                    ? {
                        backgroundColor: '#f8fafc',
                        backgroundImage: 'radial-gradient(circle at 15% 20%, rgba(59,130,246,0.18), transparent 28%), radial-gradient(circle at 85% 15%, rgba(244,114,182,0.18), transparent 24%), radial-gradient(circle at 60% 75%, rgba(45,212,191,0.18), transparent 26%)',
                    }
                    : { backgroundImage: 'none' };
    return { className, style };
};
