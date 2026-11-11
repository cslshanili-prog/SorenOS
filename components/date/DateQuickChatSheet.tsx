import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import TokenImg from '../os/TokenImg';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import { pickQuickChatTargets, QUICK_CHAT_LIMIT, type QuickChatCandidate } from '../../utils/dateSuspend';

/**
 * 見面選單「去私聊」：最多列 5 個人（有未讀的在前，其餘照最近聊過的排），
 * 最後一行「所有訊息」打開訊息列表。點了就走，見面掛著，頂端那條點一下回來。
 */
const DateQuickChatSheet: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    onPickChat: (charId: string) => void;
    onAllMessages: () => void;
}> = ({ isOpen, onClose, onPickChat, onAllMessages }) => {
    const { characters, unreadMessages } = useOS();
    const [rows, setRows] = useState<QuickChatCandidate[] | null>(null);

    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        setRows(null);
        (async () => {
            const candidates = await Promise.all(characters.map(async (c): Promise<QuickChatCandidate> => {
                const [msg] = await DB.getRecentMessagesByCharId(c.id, 1, true).catch(() => [] as Awaited<ReturnType<typeof DB.getRecentMessagesByCharId>>);
                return { id: c.id, name: c.chatNickname?.trim() || c.name, avatar: c.avatar, lastAt: msg ? msg.timestamp : null, unread: unreadMessages[c.id] || 0 };
            }));
            if (!cancelled) setRows(pickQuickChatTargets(candidates, QUICK_CHAT_LIMIT));
        })();
        return () => { cancelled = true; };
        // 開著的時候未讀變了就重排
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, unreadMessages]);

    return (
        <Modal isOpen={isOpen} title="去私聊" onClose={onClose}>
            <div className="text-center text-[11px] text-slate-400 -mt-1 mb-3">見面先掛著，頂端那條點一下就回來</div>
            <div className="space-y-1.5">
                {rows === null && <div className="py-6 text-center text-xs text-slate-400">讀取中…</div>}
                {rows?.length === 0 && <div className="py-4 text-center text-xs text-slate-400">還沒有私聊過的人</div>}
                {rows?.map(row => (
                    <button key={row.id} type="button" onClick={() => onPickChat(row.id)}
                        className="w-full flex items-center gap-3 rounded-2xl bg-slate-50 px-3 py-2.5 text-left active:scale-[0.98] transition-transform">
                        <TokenImg value={row.avatar} className="w-10 h-10 rounded-xl object-cover bg-slate-200 shrink-0" alt="" />
                        <span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-700">{row.name}</span>
                        {row.unread > 0 && (
                            <span className="shrink-0 min-w-[1.25rem] h-5 px-1.5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center tabular-nums">
                                {row.unread > 99 ? '99+' : row.unread}
                            </span>
                        )}
                    </button>
                ))}
                <button type="button" onClick={onAllMessages}
                    className="w-full flex items-center justify-between rounded-2xl px-3 py-3 text-sm font-bold text-slate-500 active:bg-slate-50">
                    <span>所有訊息</span>
                    <span aria-hidden="true">→</span>
                </button>
            </div>
        </Modal>
    );
};

export default DateQuickChatSheet;
