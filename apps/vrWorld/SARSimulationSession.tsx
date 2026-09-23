import { trackSARFeature } from '../../utils/sarAnalytics';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowLeft, ArrowDown, ArrowUp, BookOpenText, CircleNotch, DotsThree, DownloadSimple, Moon, SealCheck, ShareNetwork, Sun, X } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile, Message, UserProfile } from '../../types';
import './sarReading.css';
import { findSARPendingReply, isSARDeletedReply, replaceSARSimulationReply, replaceSARSimulationUserMessage } from '../../utils/vrWorld/sarSimulationEdits';
import { shareOrDownloadBlob } from '../../utils/shareExport';
import {
    archiveSARSimulationRun,
    buildSARArchiveMarkdown,
    getSARArchiveFilename,
    getSARSimulationPhase,
    getSARWorldNarration,
    loadSARSimulationMessages,
    resolveSARWorldlineProfile,
    runSARSimulationTurn,
    shareSARArchiveWithCharacter,
    type SARIdentityCard,
    type SARSimulationRun,
} from '../../utils/vrWorld/sarSimulation';

export const SAR_SESSION_THEME_KEY = 'vr_sar_session_theme_v1';
export type SARSessionTheme = 'light' | 'dark';

export const readSARSessionTheme = (): SARSessionTheme => {
    try { return localStorage.getItem(SAR_SESSION_THEME_KEY) === 'dark' ? 'dark' : 'light'; }
    catch { return 'light'; }
};

const messageScene = (message: Message) => `第 ${Number(message.metadata?.sarTurn) || 0} 幕`;

export const SARSimulationSession: React.FC<{
    card: SARIdentityCard;
    run: SARSimulationRun;
    char?: CharacterProfile;
    apiConfig: APIConfig;
    userProfile: UserProfile;
    onRunChange: (run: SARSimulationRun) => void;
    onThemeChange?: (theme: SARSessionTheme) => void;
    onBack: () => void;
}> = ({ card, run, char, apiConfig, userProfile, onRunChange, onThemeChange, onBack }) => {
    useEffect(() => { trackSARFeature('simulation'); }, []);
    const [messages, setMessages] = useState<Message[]>([]);
    const [draft, setDraft] = useState('');
    const [replyAction, setReplyAction] = useState<{ message: Message; mode: 'menu' | 'edit' | 'delete' } | null>(null);
    const [editText, setEditText] = useState('');
    const [editNarration, setEditNarration] = useState('');
    const busyRef = useRef(false);
    const pendingReply = findSARPendingReply(messages);
    const [loading, setLoading] = useState(true);
    const [sending, setSending] = useState(false);
    const [pendingText, setPendingText] = useState('');
    const [streamText, setStreamText] = useState('');
    const [page, setPage] = useState<'story' | 'details'>('story');
    const [hasNewText, setHasNewText] = useState(false);
    const followEndRef = useRef(true);
    const [error, setError] = useState('');
    const [archiveConfirm, setArchiveConfirm] = useState(false);
    const [theme, setTheme] = useState<SARSessionTheme>(readSARSessionTheme);
    const [archiveAction, setArchiveAction] = useState('');
    const [sharing, setSharing] = useState(false);
    const logRef = useRef<HTMLDivElement>(null);
    const draftRef = useRef<HTMLTextAreaElement>(null);
    const textStateRef = useRef('');
    const active = run.status === 'active' && run.interactionsUsed < run.maxInteractions;

    const worldline = useMemo(() => resolveSARWorldlineProfile(card), [card]);
    const phase = useMemo(() => getSARSimulationPhase(run.interactionsUsed), [run.interactionsUsed]);

    useLayoutEffect(() => {
        const input = draftRef.current;
        if (!input || page !== 'story') return;
        const fit = () => {
            input.style.height = 'auto';
            const limit = Math.max(44, parseFloat(getComputedStyle(input).maxHeight) || 136);
            input.style.height = `${Math.min(input.scrollHeight, limit)}px`;
            input.style.overflowY = 'auto';
        };
        fit();
        let width = input.clientWidth;
        const observer = new ResizeObserver(() => {
            if (input.clientWidth !== width) { width = input.clientWidth; fit(); }
        });
        observer.observe(input);
        return () => observer.disconnect();
    }, [draft, page, active]);

    textStateRef.current = JSON.stringify({
        app: 'sar-simulation',
        identity: card.profile.title,
        character: card.charName,
        world: worldline.worldName,
        storyPhase: phase.label,
        page,
        activeCrisis: worldline.activeCrisis,
        sharedObjective: worldline.sharedObjective,
        countdown: worldline.countdown,
        status: run.status,
        archiveReason: run.archiveReason || null,
        progress: { used: run.interactionsUsed, max: run.maxInteractions },
        interactionMode: 'offline',
        readingTheme: theme,
        sending,
        archiveConfirm,
        archiveActions: active ? [] : ['reread', 'download', run.sharedAt ? 'shared' : 'share-to-character'],
        visibleMessages: messages.slice(-4).map(message => ({ role: message.role, scene: messageScene(message), worldNarration: getSARWorldNarration(message).slice(0, 140) || null, text: message.content.slice(0, 180) })),
        input: { enabled: active && Boolean(char) && !sending, draftLength: draft.length },
    });

    useEffect(() => {
        const target = window as Window & { render_game_to_text?: () => string; advanceTime?: (ms: number) => void };
        const previous = target.render_game_to_text;
        const previousAdvance = target.advanceTime;
        const renderState = () => textStateRef.current;
        target.render_game_to_text = renderState;
        target.advanceTime = () => undefined;
        return () => {
            if (target.render_game_to_text === renderState) {
                if (previous) target.render_game_to_text = previous;
                else delete target.render_game_to_text;
            }
            target.advanceTime = previousAdvance;
        };
    }, []);

    useEffect(() => {
        try { localStorage.setItem(SAR_SESSION_THEME_KEY, theme); } catch { /* 主題持久化失敗不影響閱讀。 */ }
        onThemeChange?.(theme);
    }, [theme, onThemeChange]);

    useEffect(() => {
        let live = true;
        setLoading(true);
        loadSARSimulationMessages(run.id)
            .then(items => { if (live) setMessages(items); })
            .catch(cause => { if (live) setError(cause?.message || '推演記錄讀取失敗'); })
            .finally(() => { if (live) setLoading(false); });
        return () => { live = false; };
    }, [run.id]);

    useEffect(() => {
        const node = logRef.current;
        if (!node) return;
        if (followEndRef.current) { node.scrollTop = node.scrollHeight; setHasNewText(false); }
        else setHasNewText(true);
    }, [messages, pendingText, streamText, sending]);

    useEffect(() => {
        if (active || loading) return;
        const node = logRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, [active, loading, messages.length, run.id]);

    const send = async (retryReplyId?: number) => {
        const retryId = retryReplyId ?? pendingReply?.id;
        const text = retryId !== undefined ? '' : draft.trim();
        if ((!text && retryId === undefined) || !char || (!active && retryId === undefined) || busyRef.current) return;
        busyRef.current = true;
        setReplyAction(null);
        followEndRef.current = true;
        setSending(true);
        setError('');
        setPendingText(text);
        setStreamText('');
        if (retryId === undefined) setDraft('');
        try {
            const result = await runSARSimulationTurn({
                card,
                run,
                char,
                apiConfig,
                userProfile,
                userText: text,
                retryReplyId: retryId,
                onDelta: setStreamText,
            });
            setMessages(result.messages);
            onRunChange(result.run);
        } catch (cause: any) {
            setError(cause?.message || '本輪推演中斷，沒有消耗互動次數');
            if (retryId === undefined) setDraft(text);
        } finally {
            setPendingText('');
            setStreamText('');
            setSending(false);
            busyRef.current = false;
        }
    };

    const saveReply = async (deleted = false) => {
        if (!replyAction || busyRef.current || (!deleted && !editText.trim())) return;
        busyRef.current = true; setSending(true); setError('');
        try {
            if (replyAction.message.role === 'user') {
                await replaceSARSimulationUserMessage(run.id, replyAction.message, editText);
            } else {
                await replaceSARSimulationReply(run.id, replyAction.message, { content: editText.trim(), worldNarration: editNarration.trim(), deleted });
            }
            setMessages(await loadSARSimulationMessages(run.id));
            setReplyAction(null);
            setArchiveAction(deleted ? '回覆已刪除，可從這一幕重新生成' : '修改已保存');
        } catch (cause: any) { setError(cause?.message || '保存失敗，原文未改動'); }
        finally { busyRef.current = false; setSending(false); }
    };
    const copyReply = async (message: Message) => {
        try {
            await navigator.clipboard.writeText([getSARWorldNarration(message), message.content].filter(Boolean).join('\n\n'));
            setArchiveAction('已複製這條回覆'); setReplyAction(null);
        } catch { setError('複製失敗，請檢查剪貼板權限'); }
    };

    const archive = () => {
        try {
            const archived = archiveSARSimulationRun(run.id);
            onRunChange(archived);
            setArchiveConfirm(false);
        } catch (cause: any) {
            setError(cause?.message || '緊急封存失敗');
        }
    };

    const reread = () => {
        followEndRef.current = false;
        logRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
        setArchiveAction('已回到檔案開頭');
    };

    const downloadArchive = async () => {
        try {
            const text = buildSARArchiveMarkdown(card, run, messages, userProfile.name);
            const result = await shareOrDownloadBlob({
                blob: new Blob([text], { type: 'text/markdown;charset=utf-8' }),
                fileName: getSARArchiveFilename(card, run),
                shareTitle: `${card.profile.title} · SAR 封存檔案`,
                preferDownloadOnWeb: true,
            });
            setArchiveAction(result === 'shared' ? '已打開系統文件保存/分享' : result === 'downloaded' ? '完整檔案已下載' : '已取消導出');
        } catch (cause: any) {
            setError(cause?.message || '檔案下載失敗');
        }
    };

    const shareToCharacter = async () => {
        if (sharing || run.sharedAt) return;
        setSharing(true);
        setError('');
        try {
            const updated = await shareSARArchiveWithCharacter({ card, run, messages, userName: userProfile.name });
            onRunChange(updated);
            setArchiveAction(`返航簡報已分享給${card.charName}`);
        } catch (cause: any) {
            setError(cause?.message || '返航簡報分享失敗');
        } finally {
            setSharing(false);
        }
    };


    const latest = () => { followEndRef.current = true; logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); setHasNewText(false); };
    return (
        <main className={`sars-session is-${theme}`}>
            <header className="sars-reader-header">
                <button type="button" disabled={page==='story'&&sending} aria-label={page==='details'?'返回故事':'返回身份卡'} onClick={page==='details'?()=>setPage('story'):onBack}><ArrowLeft size={21}/></button>
                <div><h1>{page==='details'?'演繹資料':card.profile.title}</h1><p>{worldline.worldName} · {card.charName}</p></div>
                {page==='story'&&<button type="button" aria-label="演繹資料與設置" onClick={()=>setPage('details')}><DotsThree size={25} weight="bold"/></button>}
            </header>
            <div className="sars-reader-body" hidden={page!=='story'}>
                <div className="sars-log" ref={logRef} onScroll={()=>{const el=logRef.current;if(el){followEndRef.current=el.scrollHeight-el.scrollTop-el.clientHeight<72;if(followEndRef.current)setHasNewText(false);}}}>
                    <div className="sars-reading-column">
                        <p className="sars-opening-label">故事從這裡開始</p>
                        <article className="sars-narration"><p>{card.profile.openingScene}</p></article>
                        <article className="sars-message is-assistant"><header>{card.charName}</header><p>{card.profile.openingLine}</p></article>
                        {loading?<div className="sars-loading"><CircleNotch size={17} className="animate-spin"/>正在翻開故事……</div>:messages.map(message=>isSARDeletedReply(message)
                            ? <div key={message.id} className="sars-deleted-reply"><span>{messageScene(message)} · 回覆已刪除</span><button type="button" disabled={sending||!char} onClick={()=>void send(message.id)}>生成這一幕</button></div>
                            : <React.Fragment key={message.id}>
                            {message.role==='assistant'&&getSARWorldNarration(message)&&<article className="sars-narration" aria-label="世界旁白"><p>{getSARWorldNarration(message)}</p></article>}
                            <article className={`sars-message is-${message.role}`} data-sar-message-id={message.id}><header>{message.role==='user'?userProfile.name:card.charName}<span>{messageScene(message)}</span>{(message.role==='assistant'||message.role==='user')&&<button type="button" className="sars-reply-menu" aria-label={messageScene(message)+(message.role==='user'?'我的消息操作':'回覆操作')} disabled={sending} onClick={()=>setReplyAction({message,mode:'menu'})}><DotsThree size={19}/></button>}</header><p>{message.content}</p></article>
                        </React.Fragment>)}
                        {pendingText&&<article className="sars-message is-user is-pending"><header>{userProfile.name}</header><p>{pendingText}</p></article>}
                        {sending&&<div className="sars-loading" role="status"><CircleNotch size={16} className="animate-spin"/>{streamText||'正在接續這一刻……'}</div>}
                        {!active&&!pendingReply&&<section className="sars-sealed">
                            <SealCheck size={28} weight="light"/><h2>{run.archiveReason==='completed'?'這一段故事，已收好':'故事暫存於此'}</h2>
                            <p>{run.archiveReason==='completed'?'這段共同經歷已經結束，原文留在這裡，隨時可以回來。':`保留到第 ${run.interactionsUsed} 次互動。封存後可以閱讀和導出，當前無法直接續寫。`}</p>
                            <div className="sars-archive-actions"><button type="button" onClick={reread}><BookOpenText size={17}/>從頭重讀</button><button type="button" onClick={()=>void downloadArchive()}><DownloadSimple size={17}/>保存全文</button><button type="button" disabled={sharing||!!run.sharedAt} onClick={()=>void shareToCharacter()}><ShareNetwork size={17}/>{run.sharedAt?'已分享':sharing?'正在分享…':`分享給${card.charName}`}</button></div>
                            {archiveAction&&<output role="status">{archiveAction}</output>}
                        </section>}
                    </div>
                </div>
                <footer className="sars-composer">
                    {hasNewText&&<button type="button" className="sars-new-text" onClick={latest}><ArrowDown size={14}/>回到最新內容</button>}
                    {error&&<p role="alert" className="sars-error">{error}</p>}
                    {archiveAction&&<output className="sars-action-status" role="status">{archiveAction}</output>}
                    {pendingReply&&<p className="sars-action-status">{messageScene(pendingReply)}等待重新生成，沿用當時的輸入。</p>}
                    {active||pendingReply?<div className="sars-compose-row">
                        <textarea ref={draftRef} rows={1} aria-label="你說的話或動作" value={draft} maxLength={4000} disabled={sending||!char||!!pendingReply} placeholder={pendingReply?'點擊生成，重試已刪除的回覆':char?'說些什麼，或做個動作…（回車換行，點擊發送）':'角色資料已不存在，無法繼續'} onChange={event=>setDraft(event.target.value)}/>
                        <button type="button" aria-label={pendingReply?'生成':'發送'} disabled={(!draft.trim()&&!pendingReply)||sending||!char} onClick={()=>void send()}>{sending?<CircleNotch size={19} className="animate-spin"/>:<ArrowUp size={21} weight="bold"/>}</button>
                    </div>:<div className="sars-readonly">已封存 · {run.interactionsUsed} 次互動</div>}
                </footer>
            </div>
            {page==='details'&&<section className="sars-details">
                <div className="sars-reading-column">
                    <div className="sars-progress"><span>本段互動</span><strong>{run.interactionsUsed}<small> / {run.maxInteractions}</small></strong></div>
                    <p className="sars-detail-note">{active?'每次發送成功後記一次。離開頁面可以稍後繼續；這段經歷將在五十次互動內自然收束。':'本段故事已封存，可以回看、保存全文或分享給角色。'}</p>
                    <button type="button" className="sars-setting-row" onClick={()=>setTheme(value=>value==='light'?'dark':'light')} aria-label={theme==='light'?'切換到深色閱讀':'切換到淺色閱讀'}><span>{theme==='light'?<Moon size={18}/>:<Sun size={18}/>}閱讀外觀</span><span>{theme==='light'?'淺色':'深色'}</span></button>
                    <details><summary>世界與開場</summary><h3>{worldline.worldName}</h3><p>{worldline.worldPremise}</p><h3>開場時的狀況</h3><p>{worldline.activeCrisis}</p><h3>角色起初關心的事</h3><p>{worldline.sharedObjective}</p><h3>故事裡的時間</h3><p>{worldline.countdown}</p><small>這裡是身份卡中的開場資料，後續變化以正文為準。</small></details>
                    <details><summary>角色與這次身份</summary><h3>{card.charName}</h3><p>{card.profile.identity}</p><h3>與你的關係</h3><p>{card.profile.relationship}</p></details>
                    {active&&<div className="sars-end-section"><button type="button" disabled={sending} onClick={()=>setArchiveConfirm(true)}><Archive size={17}/>提前封存</button><p>如果只是稍後再玩，直接返回即可。提前封存會結束這段演繹。</p></div>}
                    {error&&<p role="alert" className="sars-error">{error}</p>}
                </div>
            </section>}
            {replyAction&&<div className="sars-confirm" role="dialog" aria-modal="true" aria-label="回覆操作"><section>
                <button type="button" className="sars-confirm-close" aria-label="關閉回覆操作" disabled={sending} onClick={()=>setReplyAction(null)}><X size={18}/></button>
                <h2>{messageScene(replyAction.message)} · {replyAction.message.role==='user'?(replyAction.mode==='edit'?'修改我的消息':'我的消息操作'):replyAction.mode==='edit'?'修改回覆':replyAction.mode==='delete'?'刪除回覆？':'回覆操作'}</h2>
                {replyAction.mode==='menu'?<div className="sars-reply-actions">
                    <button type="button" onClick={()=>void copyReply(replyAction.message)}>複製</button>
                    <button type="button" onClick={()=>{setEditText(replyAction.message.content);setEditNarration(getSARWorldNarration(replyAction.message));setReplyAction({...replyAction,mode:'edit'});}}>修改</button>
                    {replyAction.message.role==='assistant'&&<><button type="button" disabled={!char} onClick={()=>void send(replyAction.message.id)}>重新生成</button>
                    <button type="button" onClick={()=>setReplyAction({...replyAction,mode:'delete'})}>刪除</button></>}
                </div>:replyAction.mode==='edit'?<>
                    {replyAction.message.role==='assistant'&&<label className="sars-edit-label">世界旁白<textarea aria-label="修改世界旁白" value={editNarration} maxLength={2400} disabled={sending} onChange={e=>setEditNarration(e.target.value)}/></label>}
                    <label className="sars-edit-label">{replyAction.message.role==='user'?'我的消息':'角色回覆'}<textarea aria-label={replyAction.message.role==='user'?'修改我的消息':'修改角色回覆'} value={editText} maxLength={replyAction.message.role==='user'?4000:12000} disabled={sending} onChange={e=>setEditText(e.target.value)}/></label>
                    <p>後續已有劇情不會自動改寫。</p><button type="button" className="sars-reply-submit" disabled={sending||!editText.trim()} onClick={()=>void saveReply()}>保存修改</button>
                </>:<><p>刪除這一幕的回覆與旁白，保留你的輸入。之後點生成會重試這一幕，後續已有劇情保留。</p><button type="button" className="sars-reply-submit" disabled={sending} onClick={()=>void saveReply(true)}>確認刪除回覆</button></>}
                {error&&<p role="alert" className="sars-error">{error}</p>}
            </section></div>}
            {archiveConfirm&&<div className="sars-confirm" role="alertdialog" aria-modal="true" aria-label="確認提前封存"><section><button type="button" className="sars-confirm-close" aria-label="取消封存" onClick={()=>setArchiveConfirm(false)}><X size={18}/></button><h2>把故事收在這裡？</h2><p>已完成 {run.interactionsUsed} 次互動。原文會完整保留，封存後當前無法直接續寫。</p><div><button type="button" onClick={()=>setArchiveConfirm(false)}>繼續演繹</button><button type="button" onClick={()=>{archive();setPage('story');}}>確認封存</button></div></section></div>}
        </main>
    );
};
