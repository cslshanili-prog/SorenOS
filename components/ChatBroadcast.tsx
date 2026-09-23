import React, { useEffect, useState } from 'react';
import { CHAT_GEN_EVENTS, CHAT_VIEW_CHANGED_EVENT, getChatViewSnapshot } from '../utils/chatGenEvents';
import { AMSG_INSTANT_CHAT_PENDING_EVENT, listInstantChatPendings } from '../utils/amsgInstantChat';
import { INSTANT_TOTAL_TIMEOUT_MS } from '../worker/amsg/src/instantChat';

/**
 * 聊天生成全局橫幅（對標彼方的 VRBroadcast，App 根級掛載）。
 *
 * 監聽 useChatAI / evaluateEmotionBackground 派發的 chat-gen-* 事件，顯示
 * 「xx 正在回應…」「xx 正在感受…」。生成閉包在 Chat 卸載後繼續跑，事件照發，
 * 所以用戶切走 Chat 也能看到生成還活著；點橫幅跳回該角色的聊天頁
 * （複用 OSContext 已有的 'active-msg-open' 監聽）。
 *
 * 抑制規則：用戶正開著該角色的聊天頁時不顯示（頁內已有打字/情緒指示燈），
 * 切走的瞬間由 CHAT_VIEW_CHANGED_EVENT 觸發重渲染、橫幅接棒。
 *
 * 結束信號都在 finally 裡派發，正常不會漏；TTL 只是兜底（上雲那兩條路的
 * emotionDone 可能因 worker 被殺/推送丟失而永不到達）。
 */

type GenKind = 'reply' | 'emotion';
interface GenEntry { kind: GenKind; charId: string; charName: string; startedAt: number; ttlMs: number; }

// 兜底過期的默認檔：主回覆對齊 instant 300s 超時 + 本地重試餘量；情緒評估按本地評估的量級給。
//
// 派發方可以用 detail.ttlMs 單條覆蓋，上雲的情緒評估就是這麼幹的：同一個「正在感受」
// 在本地是幾秒鐘的事，交給自己那台 worker 的即時對話卻能跑滿十分鐘。這裡要是一律按
// 默認檔掃掉，橫幅會在角色還在雲端想著的時候先自己消失，用戶以為沒在跑了。
// 覆蓋值與 Chat 頁那盞徽章用的是同一個數（見 useChatAI 的 cloudEvalTimeoutMs），
// 兩處必須一起改——不然橫幅和徽章會一前一後滅，看著像出了兩次故障。
const TTL_MS: Record<GenKind, number> = { reply: 6 * 60_000, emotion: 2 * 60_000 };

const LABEL: Record<GenKind, string> = { reply: '正在回應', emotion: '正在感受' };

// 即時對話待收條目的兜底 TTL：worker fire 上限 + 一分鐘推送在途（與 useChatAI 的
// cloudEvalTimeoutMs 同一來源推導，worker 調預算兩邊一起動）。正常熄滅不靠它——
// 待收記錄銷帳（回覆到了 / 判失敗）那一刻事件就把條目撤了。
const INSTANT_PENDING_TTL_MS = INSTANT_TOTAL_TIMEOUT_MS + 60_000;

const ChatBroadcast: React.FC = () => {
    const [entries, setEntries] = useState<GenEntry[]>([]);
    const [, setViewTick] = useState(0);
    // 即時對話的「正在回應」不靠 replyStart/replyEnd 撐：instant 分支 POST 完就 return，
    // finally 的 replyEnd 幾秒內就把事件條目撤了，而云端還要跑最長十分鐘。這裡直接以
    // 待收記錄為準（localStorage 持久，重啟後橫幅也還在）——受理點亮、銷帳熄滅。
    const [, setPendingTick] = useState(0);

    useEffect(() => {
        const add = (kind: GenKind) => (e: Event) => {
            const d = (e as CustomEvent).detail as { charId?: string; charName?: string; ttlMs?: number };
            if (!d?.charId) return;
            const ttlMs = typeof d.ttlMs === 'number' && d.ttlMs > 0 ? d.ttlMs : TTL_MS[kind];
            setEntries(prev => prev.some(x => x.kind === kind && x.charId === d.charId)
                ? prev
                : [...prev, { kind, charId: d.charId!, charName: d.charName || '', startedAt: Date.now(), ttlMs }]);
        };
        const remove = (kind: GenKind) => (e: Event) => {
            const id = (e as CustomEvent).detail?.charId;
            if (!id) return;
            setEntries(prev => {
                const next = prev.filter(x => !(x.kind === kind && x.charId === id));
                return next.length === prev.length ? prev : next;
            });
        };
        const onReplyStart = add('reply');
        const onReplyEnd = remove('reply');
        const onEmotionStart = add('emotion');
        const onEmotionEnd = remove('emotion');
        const onView = () => setViewTick(n => n + 1);
        window.addEventListener(CHAT_GEN_EVENTS.replyStart, onReplyStart);
        window.addEventListener(CHAT_GEN_EVENTS.replyEnd, onReplyEnd);
        window.addEventListener(CHAT_GEN_EVENTS.emotionStart, onEmotionStart);
        window.addEventListener(CHAT_GEN_EVENTS.emotionEnd, onEmotionEnd);
        // 上雲的情緒評估在 worker 跑，結束信號由 activeMsgRuntime / 收尾判定派發
        window.addEventListener(CHAT_GEN_EVENTS.emotionDone, onEmotionEnd);
        window.addEventListener(CHAT_VIEW_CHANGED_EVENT, onView);
        const onPending = () => setPendingTick(n => n + 1);
        window.addEventListener(AMSG_INSTANT_CHAT_PENDING_EVENT, onPending);
        const sweeper = setInterval(() => {
            const now = Date.now();
            setEntries(prev => {
                const next = prev.filter(x => now - x.startedAt < x.ttlMs);
                return next.length === prev.length ? prev : next;
            });
            // 待收條目的 TTL 過期只在渲染時判，欠著回覆時靠這個 tick 保證有下一次渲染。
            if (listInstantChatPendings().length > 0) setPendingTick(n => n + 1);
        }, 15_000);
        return () => {
            window.removeEventListener(AMSG_INSTANT_CHAT_PENDING_EVENT, onPending);
            window.removeEventListener(CHAT_GEN_EVENTS.replyStart, onReplyStart);
            window.removeEventListener(CHAT_GEN_EVENTS.replyEnd, onReplyEnd);
            window.removeEventListener(CHAT_GEN_EVENTS.emotionStart, onEmotionStart);
            window.removeEventListener(CHAT_GEN_EVENTS.emotionEnd, onEmotionEnd);
            window.removeEventListener(CHAT_GEN_EVENTS.emotionDone, onEmotionEnd);
            window.removeEventListener(CHAT_VIEW_CHANGED_EVENT, onView);
            clearInterval(sweeper);
        };
    }, []);

    // 即時對話待收 → 「正在回應」條目（同角色已有事件驅動的 reply 條目時不重複）。
    const now = Date.now();
    const cloudEntries: GenEntry[] = listInstantChatPendings()
        .filter(p => now - p.acceptedAt < INSTANT_PENDING_TTL_MS)
        .filter(p => !entries.some(e => e.kind === 'reply' && e.charId === p.charId))
        .map(p => ({
            kind: 'reply' as const, charId: p.charId, charName: p.charName || '',
            startedAt: p.acceptedAt, ttlMs: INSTANT_PENDING_TTL_MS,
        }));

    const view = getChatViewSnapshot();
    const visible = [...entries, ...cloudEntries].filter(x => !(view.chatOpen && view.charId === x.charId));
    if (visible.length === 0) return null;
    // 回覆優先於情緒展示（同角色兩個都在跑時"正在回應"信息量更大）
    const cur = [...visible].sort((a, b) =>
        (a.kind === b.kind ? a.startedAt - b.startedAt : (a.kind === 'reply' ? 1 : -1))
    )[visible.length - 1];
    const extra = visible.length > 1 ? ` 等 ${visible.length} 項` : '';

    const jump = () => {
        try {
            window.dispatchEvent(new CustomEvent('active-msg-open', { detail: { charId: cur.charId } }));
        } catch { /* ignore */ }
    };

    return (
        <div className="fixed left-1/2 -translate-x-1/2 z-[999]"
            style={{ top: 'calc(var(--safe-top) + 44px)' }}>
            <style>{`@keyframes chatbcin{from{opacity:0;transform:translateY(-14px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
                     @keyframes chatbcdot{0%,60%,100%{opacity:.35;transform:translateY(0)}30%{opacity:1;transform:translateY(-2px)}}`}</style>
            <button type="button" onClick={jump}
                className="relative flex items-center gap-2.5 pl-3 pr-3.5 py-1.5 rounded-full overflow-hidden backdrop-blur-xl cursor-pointer"
                style={{
                    animation: 'chatbcin .45s cubic-bezier(.2,.9,.3,1.2)',
                    background: 'linear-gradient(100deg, rgba(20,36,32,.85), rgba(12,22,20,.85))',
                    border: '1px solid rgba(160,230,200,.28)',
                    boxShadow: '0 10px 30px rgba(0,0,0,.45), inset 0 1px 0 rgba(190,240,215,.16), 0 0 18px rgba(110,220,170,.15)',
                }}>
                <span className="relative text-[12px] opacity-85" style={{ filter: 'drop-shadow(0 0 5px rgba(140,235,190,.6))' }}>
                    {cur.kind === 'reply' ? '💬' : '🫧'}
                </span>
                <span className="relative text-[11px] tracking-[0.04em] text-white/90 whitespace-nowrap font-light">
                    <span className="text-emerald-200/90 font-normal">{cur.charName}</span>{extra} {LABEL[cur.kind]}
                </span>
                <span className="relative flex gap-1">
                    {[0, 1, 2].map(i => (
                        <span key={i} className="w-1 h-1 rounded-full bg-emerald-100/80"
                            style={{ animation: 'chatbcdot 1.2s infinite', animationDelay: `${i * 0.2}s` }} />
                    ))}
                </span>
            </button>
        </div>
    );
};

export default ChatBroadcast;
