import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CaretLeft, PaperPlaneRight } from '@phosphor-icons/react';
import TokenImg from '../os/TokenImg';
import type { APIConfig, CharacterProfile, Message } from '../../types';
import { charCount, TEMP_CHAT_CHANGED_EVENT, tempChatMetaOf } from '../../utils/tempChat';
import { generateCharTempMessage, loadTempChatState, sendUserTempMessage } from '../../utils/tempChatRuntime';
import { trackEvent } from '../../utils/analytics';

interface Props {
    char: CharacterProfile;
    chatUser: { name: string; avatar: string };
    apiConfig: APIConfig;
    onClose: () => void;
    /** 角色（拉黑的那方）在臨時會話裡決定解除：由聊天頁寫回角色、落系統提示 */
    onCharUnblock: () => void;
    addToast: (msg: string, type: 'info' | 'success' | 'error') => void;
}

/**
 * 臨時會話（設計見 plans/block-temp-chat-design.md）：拉黑期間雙方唯一的窄管道。
 * 雙方每天各 N 次、每次最多 M 字；你送一句，角色（今天還有次數的話）回一句——
 * 角色是拉黑的那方時，也可能順便解除拉黑。
 */
const TempChatSheet: React.FC<Props> = ({ char, chatUser, apiConfig, onClose, onCharUnblock, addToast }) => {
    const [thread, setThread] = useState<Message[]>([]);
    const [userLeft, setUserLeft] = useState(0);
    const [charLeft, setCharLeft] = useState(0);
    const [maxChars, setMaxChars] = useState(50);
    const [daily, setDaily] = useState(3);
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const charName = char.chatNickname?.trim() || char.name;
    const blockedByChar = char.chatBlock?.by === 'char';

    const reload = useCallback(async () => {
        const state = await loadTempChatState(char);
        setThread(state.thread);
        setUserLeft(state.userRemaining);
        setCharLeft(state.charRemaining);
        setMaxChars(state.limits.maxChars);
        setDaily(state.limits.daily);
    }, [char]);

    useEffect(() => { void reload(); }, [reload]);
    useEffect(() => {
        const onChange = (e: Event) => { if ((e as CustomEvent<{ charId: string }>).detail?.charId === char.id) void reload(); };
        window.addEventListener(TEMP_CHAT_CHANGED_EVENT, onChange);
        return () => window.removeEventListener(TEMP_CHAT_CHANGED_EVENT, onChange);
    }, [char.id, reload]);
    useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [thread.length, busy]);

    const count = charCount(input.trim());
    const canSend = !busy && userLeft > 0 && count > 0 && count <= maxChars;

    const handleSend = async () => {
        if (!canSend) return;
        const sent = await sendUserTempMessage(char, input);
        if (!sent.ok) { addToast(sent.reason, 'info'); return; }
        setInput('');
        trackEvent('临时会话发送', { blockedBy: blockedByChar ? 'char' : 'user' });
        await reload();
        setBusy(true);
        try {
            const result = await generateCharTempMessage({ char, apiConfig, userName: chatUser.name || '你', replying: true });
            await reload();
            if (!result) addToast(`${charName} 今天的次數用完了，明天才能回你`, 'info');
            else if (!result.message && !result.unblock) addToast(`${charName} 看了，沒有回`, 'info');
            if (result?.unblock) onCharUnblock();
        } catch (e) {
            console.warn('[臨時會話] 角色回話失敗', e);
            addToast('對方的回覆沒有送到（API 出錯）', 'error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[110] flex flex-col bg-slate-100 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="shrink-0 bg-white/90 backdrop-blur-md border-b border-slate-200" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center gap-2 px-3 py-3">
                    <button onClick={onClose} className="p-1.5 rounded-full hover:bg-black/5 active:scale-90 transition-transform" aria-label="關閉臨時會話">
                        <CaretLeft size={22} className="text-slate-700" />
                    </button>
                    <TokenImg value={char.avatar} className="w-9 h-9 rounded-full object-cover bg-slate-100" alt="" />
                    <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-bold text-slate-800 truncate">{charName} · 臨時會話</div>
                        <div className="text-[11px] text-slate-400">
                            {blockedByChar ? 'TA 把你拉黑了' : '你把 TA 拉黑了'}・雙方每天各 {daily} 次、每次最多 {maxChars} 字
                        </div>
                    </div>
                </div>
            </div>

            <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3">
                {thread.length === 0 && (
                    <p className="pt-10 text-center text-[12px] leading-relaxed text-slate-400 whitespace-pre-line">
                        {blockedByChar
                            ? `私聊的訊息 ${charName} 收不到，這裡是唯一傳得過去的地方。\n挑最想說的講。`
                            : `你拉黑了 ${charName}，TA 的訊息只能從這裡傳給你。`}
                    </p>
                )}
                {thread.map(m => {
                    const mine = tempChatMetaOf(m)?.from === 'user';
                    return (
                        <div key={m.id} className={`flex items-end gap-2 ${mine ? 'justify-end' : ''}`}>
                            {!mine && <TokenImg value={char.avatar} className="w-7 h-7 rounded-full object-cover bg-slate-200 shrink-0" alt="" />}
                            <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap ${mine ? 'bg-slate-800 text-white rounded-br-md' : 'bg-white text-slate-800 rounded-bl-md shadow-sm'}`}>
                                {typeof m.content === 'string' ? m.content : ''}
                            </div>
                        </div>
                    );
                })}
                {busy && <div className="text-[11px] text-slate-400 pl-9">對方正在輸入…</div>}
            </div>

            <div className="shrink-0 border-t border-slate-200 bg-white px-3 pt-2" style={{ paddingBottom: 'calc(var(--safe-bottom) + 0.5rem)' }}>
                <div className="flex items-center justify-between px-1 pb-1.5 text-[11px] text-slate-400">
                    <span>你今天還剩 <b className={userLeft ? 'text-slate-700' : 'text-rose-500'}>{userLeft}</b> 次・{charName} 還剩 {charLeft} 次</span>
                    <span className={count > maxChars ? 'text-rose-500 font-bold' : ''}>{count}/{maxChars}</span>
                </div>
                <div className="flex items-end gap-2">
                    <textarea
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        disabled={userLeft <= 0}
                        rows={1}
                        placeholder={userLeft > 0 ? '挑最想說的講…' : '今天的次數用完了，明天再說吧'}
                        className="flex-1 max-h-28 resize-none rounded-2xl bg-slate-100 px-3.5 py-2.5 text-[14px] text-slate-800 outline-none placeholder:text-slate-400 disabled:opacity-60"
                    />
                    <button onClick={handleSend} disabled={!canSend} aria-label="送出"
                        className="mb-0.5 flex h-10 w-10 items-center justify-center rounded-full bg-slate-800 text-white transition active:scale-90 disabled:bg-slate-300">
                        <PaperPlaneRight size={18} weight="fill" />
                    </button>
                </div>
            </div>
        </div>
    );
};

export default TempChatSheet;
