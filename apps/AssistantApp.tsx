import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretLeft, ChatsCircle, Gear, PaperPlaneRight, Plus, SmileyWink, Stop, Trash, X } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import type { AssistantMessage, AssistantProposal, AssistantSession } from '../types';
import { DB } from '../utils/db';
import { ActiveMsgStore } from '../utils/activeMsgStore';
import { trackEvent } from '../utils/analytics';
import { runSoreTurn } from '../utils/assistant/engine';
import { loadSorePrefs, resolveSoreApi, saveSorePrefs, type SoreApiSource } from '../utils/assistant/api';
import { makeSoreCall, testApiConnection } from '../utils/assistant/client';
import type { SoreToolContext } from '../utils/assistant/tools';
import type { CssData, CssWrite } from '../utils/assistant/cssLocations';
import { applyCssProposal, changedSinceApply, restoreCssProposal } from '../utils/assistant/applyProposal';
import ProposalCard from '../components/assistant/ProposalCard';

/**
 * AI 助手 Sore（plans/ai-assistant.md）。第 1 批答疑、第 2 批美化 CSS。
 * 對話存在 assistant_sessions；Sore 用哪組 API 存在這台裝置（utils/assistant/api.ts）。
 * 工具結果在畫面上只顯示一行小字，內容只給模型看；寫的工具出提案卡片，按「套用」才寫，快照跟著卡片存。
 */

const SUGGESTIONS = ['角色怎麼都不回我？', 'API 要怎麼設？', '主動消息怎麼開？', '怎麼備份資料？', '預設 App 是幹嘛的？'];

const newSessionId = () => `as_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const newMessageId = () => `am_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const sessionTitle = (messages: AssistantMessage[]) => {
    const first = messages.find(m => m.role === 'user')?.text.trim() || '新對話';
    return first.length > 24 ? `${first.slice(0, 24)}…` : first;
};

const sourceEventLabel = (source: SoreApiSource) => (source === 'auto' ? '自动' : source === 'global' ? '全域' : 'API库');

// 埋點屬性是固定枚舉（docs/analytics.md），用簡體
const LOCATION_EVENT_LABEL: Record<string, string> = {
    chat_chrome_global: '白框全域', chat_chrome_char: '白框角色', chat_chrome_group: '白框群',
    bubble_theme: '气泡', date: '见面', thinking_chain: '心象卡', journal: '交换日记', schedule: '日程',
};

const SoreAvatar: React.FC<{ size?: number }> = ({ size = 32 }) => (
    <div className="shrink-0 rounded-full bg-gradient-to-br from-amber-300 to-orange-400 flex items-center justify-center text-white shadow-sm" style={{ width: size, height: size }}>
        <SmileyWink size={size * 0.6} weight="fill" />
    </div>
);

const formatTime = (at: number) => {
    const d = new Date(at);
    const now = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

const AssistantApp: React.FC = () => {
    const {
        closeApp, addToast, apiConfig, apiPresets, memoryPalaceConfig, characters, groups, userProfileBase,
        theme, customThemes, updateTheme, updateCharacter, updateGroup, addCustomTheme, removeCustomTheme,
    } = useOS();
    const [sessions, setSessions] = useState<AssistantSession[]>([]);
    const [current, setCurrent] = useState<AssistantSession | null>(null);
    const [input, setInput] = useState('');
    const [running, setRunning] = useState(false);
    const [error, setError] = useState('');
    const [panel, setPanel] = useState<'none' | 'sessions' | 'settings'>('none');
    const [prefs, setPrefs] = useState(loadSorePrefs);
    const abortRef = useRef<AbortController | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [proposalBusy, setProposalBusy] = useState('');
    // 工具和套用都讀最新的那份（轉一輪的中途用戶可能在別處改過）
    const cssDataRef = useRef<CssData>({ theme, characters, groups, customThemes });
    cssDataRef.current = { theme, characters, groups, customThemes };

    const lightLLM = memoryPalaceConfig?.lightLLM;
    const api = useMemo(() => resolveSoreApi(prefs.apiSource, { apiConfig, lightLLM, apiPresets }), [prefs.apiSource, apiConfig, lightLLM, apiPresets]);

    useEffect(() => {
        void DB.getAssistantSessions().then(list => {
            setSessions(list);
            if (list[0]) setCurrent(list[0]);
        }).catch(() => { /* 讀不到就從空的開始 */ });
        return () => abortRef.current?.abort();
    }, []);

    useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [current?.messages.length, running]);

    const persist = useCallback(async (session: AssistantSession) => {
        setCurrent(session);
        setSessions(prev => [session, ...prev.filter(s => s.id !== session.id)]);
        try { await DB.saveAssistantSession(session); } catch { /* 存不了不擋對話 */ }
    }, []);

    const toolContext = useMemo<SoreToolContext>(() => ({
        settings: async () => {
            const global = await ActiveMsgStore.getGlobalConfig().catch(() => undefined);
            return {
                apiConfig,
                lightLLM,
                apiPresetCount: apiPresets.length,
                characters,
                groups,
                presetSceneDefaults: userProfileBase.presetSceneDefaults as Record<string, string | undefined> | undefined,
                amsgWorkerUrl: global?.workerUrl,
                soreApiLabel: api?.label,
            };
        },
        testApi: async target => testApiConnection(target === 'light' ? lightLLM : apiConfig),
        cssData: () => cssDataRef.current,
    }), [apiConfig, lightLLM, apiPresets, characters, groups, userProfileBase.presetSceneDefaults, api?.label]);

    const send = async (text: string) => {
        const content = text.trim();
        if (!content || running) return;
        if (!api) { setError('還沒有能用的 API：先去「設置 → API 設定」填好，或在記憶宮殿設定副 API。'); return; }
        setError('');
        setInput('');
        const now = Date.now();
        const base: AssistantSession = current || { id: newSessionId(), title: '新對話', messages: [], createdAt: now, updatedAt: now };
        const userMessage: AssistantMessage = { id: newMessageId(), role: 'user', text: content, at: now };
        let session: AssistantSession = { ...base, messages: [...base.messages, userMessage], updatedAt: now };
        session.title = sessionTitle(session.messages);
        await persist(session);
        trackEvent('向Sore提问', { 入口: '桌面' });

        const controller = new AbortController();
        abortRef.current = controller;
        setRunning(true);
        try {
            await runSoreTurn({
                history: session.messages,
                call: makeSoreCall(api, controller.signal),
                ctx: toolContext,
                signal: controller.signal,
                onMessage: async message => {
                    session = { ...session, messages: [...session.messages, message], updatedAt: Date.now() };
                    if (!controller.signal.aborted) await persist(session);
                },
            });
        } catch (err: any) {
            if (err?.name !== 'AbortError' && !controller.signal.aborted) setError(err?.message || String(err));
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setRunning(false);
        }
    };

    const writeCss = async (write: CssWrite) => {
        if (write.kind === 'theme') await updateTheme(write.patch);
        else if (write.kind === 'character') await updateCharacter(write.id, write.patch);
        else if (write.kind === 'group') await updateGroup(write.id, write.patch);
        else if (write.kind === 'chatTheme') await addCustomTheme(write.theme);
        else await removeCustomTheme(write.id);
    };

    const actOnProposal = async (messageId: string, action: 'apply' | 'reject' | 'restore') => {
        const session = current;
        const message = session?.messages.find(m => m.id === messageId);
        const proposal = message?.proposal;
        if (!session || !proposal || proposalBusy) return;
        const data = cssDataRef.current;
        if (action === 'restore' && changedSinceApply(proposal, data)
            && !window.confirm('套用之後這裡又被改過了，還原會把那些改動一起蓋掉。還是要還原？')) return;
        setProposalBusy(messageId);
        try {
            let next: AssistantProposal;
            if (action === 'apply') next = await applyCssProposal(proposal, data, writeCss);
            else if (action === 'restore') next = await restoreCssProposal(proposal, data, writeCss);
            else next = { ...proposal, status: 'rejected' };
            await persist({
                ...session,
                messages: session.messages.map(m => (m.id === messageId ? { ...m, proposal: next } : m)),
                updatedAt: Date.now(),
            });
            if (action === 'apply') addToast(proposal.css ? '套用了，去那頁看看；不喜歡可以按還原' : '清掉了', 'success');
            if (action === 'restore') addToast('還原了', 'success');
            trackEvent('处理Sore的提案', { 动作: action === 'apply' ? '套用' : action === 'restore' ? '还原' : '不要', 位置: LOCATION_EVENT_LABEL[proposal.location] || '其他' });
        } catch (err: any) {
            addToast(err?.message || String(err), 'error');
        } finally {
            setProposalBusy('');
        }
    };

    const stop = () => {
        abortRef.current?.abort();
        abortRef.current = null;
        setRunning(false);
    };

    const startNew = () => {
        if (running) stop();
        setCurrent(null);
        setError('');
        setPanel('none');
        setTimeout(() => textareaRef.current?.focus(), 50);
    };

    const removeSession = async (id: string) => {
        if (!window.confirm('刪掉這段對話？')) return;
        try { await DB.deleteAssistantSession(id); } catch { /* 下次讀就沒了 */ }
        setSessions(prev => prev.filter(s => s.id !== id));
        if (current?.id === id) setCurrent(null);
    };

    const chooseSource = (source: SoreApiSource) => {
        const next = { ...prefs, apiSource: source };
        setPrefs(next);
        saveSorePrefs(next);
        trackEvent('切换Sore的API', { 选择: sourceEventLabel(source) });
    };

    const messages = current?.messages || [];
    const toolLines = new Map<string, AssistantMessage[]>();
    // 工具結果掛在它前面那則助手訊息下面顯示
    let anchor = '';
    for (const m of messages) {
        if (m.role === 'assistant') anchor = m.id;
        else if (m.role === 'tool' && anchor) toolLines.set(anchor, [...(toolLines.get(anchor) || []), m]);
    }
    // 只叫了工具、沒說話的那則也要留著：工具那行和提案卡片掛在它下面
    const visible = messages.filter(m => m.role !== 'tool' && !(m.role === 'assistant' && !m.text.trim() && !toolLines.has(m.id)));

    return (
        <div className="h-full w-full flex flex-col bg-amber-50/40 text-slate-800" data-sore-app>
            <div className="shrink-0 bg-white/90 backdrop-blur border-b border-slate-100" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="relative flex items-center justify-between px-3 py-3">
                    <button type="button" onClick={closeApp} aria-label="返回" className="p-1.5 rounded-full hover:bg-black/5"><CaretLeft size={22} weight="bold" className="text-slate-600" /></button>
                    <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center leading-tight">
                        <h1 className="text-base font-bold">Sore</h1>
                        <span className="text-[10px] text-slate-400">{api ? api.label : '還沒有 API'}</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <button type="button" onClick={() => setPanel('sessions')} aria-label="對話列表" className="p-2 rounded-full hover:bg-black/5"><ChatsCircle size={20} className="text-slate-600" /></button>
                        <button type="button" onClick={() => setPanel('settings')} aria-label="Sore 設定" className="p-2 rounded-full hover:bg-black/5"><Gear size={20} className="text-slate-600" /></button>
                        <button type="button" onClick={startNew} aria-label="新對話" className="p-2 rounded-full hover:bg-black/5"><Plus size={20} weight="bold" className="text-slate-600" /></button>
                    </div>
                </div>
            </div>

            <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 space-y-3" data-sore-messages>
                {visible.length === 0 && (
                    <div className="pt-6 flex flex-col items-center text-center gap-3">
                        <SoreAvatar size={56} />
                        <div className="text-[15px] font-bold">我是 Sore 👋</div>
                        <p className="text-[12px] leading-relaxed text-slate-500 max-w-[260px]">手機哪裡怪怪的、不知道功能在哪，丟過來就對了。我看得到你有沒有設 API，看不到 Key，放心。</p>
                        <div className="flex flex-wrap justify-center gap-2 pt-2">
                            {SUGGESTIONS.map(s => (
                                <button key={s} type="button" disabled={running} onClick={() => void send(s)}
                                    className="rounded-full bg-white border border-amber-200 px-3 py-1.5 text-[12px] text-amber-700 shadow-sm active:scale-95 transition disabled:opacity-40">{s}</button>
                            ))}
                        </div>
                    </div>
                )}
                {visible.map(m => (m.role === 'user' ? (
                    <div key={m.id} className="flex justify-end">
                        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-slate-800 text-white px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap break-words">{m.text}</div>
                    </div>
                ) : (
                    <div key={m.id} className="flex items-start gap-2" data-sore-reply>
                        <SoreAvatar />
                        <div className="max-w-[80%] min-w-0 flex-1 space-y-1">
                            {!!m.text.trim() && (
                                <div className="w-fit max-w-full rounded-2xl rounded-tl-md bg-white border border-slate-100 shadow-sm px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap break-words">{m.text}</div>
                            )}
                            {(toolLines.get(m.id) || []).map(t => (t.proposal ? (
                                <ProposalCard key={t.id} proposal={t.proposal} busy={!!proposalBusy}
                                    onApply={() => void actOnProposal(t.id, 'apply')}
                                    onReject={() => void actOnProposal(t.id, 'reject')}
                                    onRestore={() => void actOnProposal(t.id, 'restore')} />
                            ) : (
                                <div key={t.id} className="text-[11px] text-slate-400 pl-1" data-sore-tool>
                                    {t.toolOk ? '🔍' : '⚠️'} {t.toolName === '系統' ? '查太多次，先停下' : `${t.toolName}${t.toolOk ? '' : '（沒成功）'}`}
                                </div>
                            )))}
                            <div className="text-[10px] text-slate-300 pl-1">{formatTime(m.at)}</div>
                        </div>
                    </div>
                )))}
                {running && (
                    <div className="flex items-center gap-2 text-[12px] text-slate-400" data-sore-thinking>
                        <SoreAvatar size={24} />
                        <span className="animate-pulse">Sore 正在想…</span>
                    </div>
                )}
                {error && (
                    <div className="rounded-xl bg-rose-50 border border-rose-100 px-3 py-2 text-[12px] text-rose-600 whitespace-pre-wrap break-words" data-sore-error>{error}</div>
                )}
            </div>

            <div className="shrink-0 bg-white/95 border-t border-slate-100 px-3 pt-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 0.5rem)' }}>
                <div className="flex items-end gap-2">
                    <textarea ref={textareaRef} value={input} rows={1} aria-label="問 Sore"
                        placeholder={api ? '問點什麼…' : '先設好 API 才能問我'}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input); } }}
                        className="flex-1 resize-none max-h-32 rounded-2xl bg-slate-100 px-3.5 py-2 text-[14px] outline-none focus:ring-2 focus:ring-amber-200" />
                    {running ? (
                        <button type="button" onClick={stop} aria-label="停下來" className="shrink-0 h-9 w-9 rounded-full bg-slate-200 flex items-center justify-center"><Stop size={16} weight="fill" className="text-slate-600" /></button>
                    ) : (
                        <button type="button" onClick={() => void send(input)} disabled={!input.trim()} aria-label="送出" className="shrink-0 h-9 w-9 rounded-full bg-amber-400 flex items-center justify-center disabled:opacity-40"><PaperPlaneRight size={16} weight="fill" className="text-white" /></button>
                    )}
                </div>
            </div>

            {panel !== 'none' && (
                <div className="absolute inset-0 z-30 bg-black/30 flex flex-col justify-end" onClick={() => setPanel('none')}>
                    <div className="bg-white rounded-t-3xl max-h-[75%] flex flex-col" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 1rem)' }} onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-5 pt-4 pb-2">
                            <div className="text-[15px] font-bold">{panel === 'sessions' ? '對話' : 'Sore 設定'}</div>
                            <button type="button" onClick={() => setPanel('none')} aria-label="關閉" className="p-1.5 rounded-full hover:bg-black/5"><X size={18} className="text-slate-500" /></button>
                        </div>
                        {panel === 'sessions' ? (
                            <div className="overflow-y-auto px-3 pb-2 space-y-1" data-sore-sessions>
                                <button type="button" onClick={startNew} className="w-full flex items-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-bold text-amber-700 hover:bg-amber-50"><Plus size={16} weight="bold" /> 新對話</button>
                                {sessions.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-slate-400">還沒聊過</div>}
                                {sessions.map(s => (
                                    <div key={s.id} className={`flex items-center gap-2 rounded-xl px-3 py-2.5 ${current?.id === s.id ? 'bg-amber-50' : 'hover:bg-slate-50'}`}>
                                        <button type="button" className="flex-1 min-w-0 text-left" onClick={() => { if (running) stop(); setCurrent(s); setError(''); setPanel('none'); }}>
                                            <div className="text-[13px] font-medium truncate">{s.title}</div>
                                            <div className="text-[10px] text-slate-400">{formatTime(s.updatedAt)}</div>
                                        </button>
                                        <button type="button" onClick={() => void removeSession(s.id)} aria-label={`刪除對話 ${s.title}`} className="p-1.5 rounded-full hover:bg-black/5"><Trash size={16} className="text-slate-400" /></button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="overflow-y-auto px-5 pb-2 space-y-3" data-sore-settings>
                                <label className="block space-y-1.5">
                                    <span className="text-[12px] font-bold text-slate-600">Sore 用哪組 API</span>
                                    <select aria-label="Sore 用哪組 API" value={prefs.apiSource} onChange={e => chooseSource(e.target.value as SoreApiSource)}
                                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px]">
                                        <option value="auto">自動（副 API 優先，沒設用全域）</option>
                                        <option value="global">全域 API</option>
                                        {apiPresets.map(p => <option key={p.id} value={`preset:${p.id}`}>API 庫 · {p.name}</option>)}
                                    </select>
                                </label>
                                <p className="text-[11px] leading-relaxed text-slate-400">
                                    現在用的是：{api ? `${api.label}（${api.model}）` : '沒有能用的'}。選的那組沒填好會自動往下退。答疑不需要太強的模型，便宜快的就夠。
                                </p>
                                <p className="text-[11px] leading-relaxed text-slate-400">Sore 看得到設定有沒有填、模型名，看不到 API Key；會改你東西的功能都要你按「套用」才會寫進去。</p>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default AssistantApp;
