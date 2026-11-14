import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretLeft, Warning } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import type { CharacterProfile, DateStory, Message } from '../../types';
import { DB } from '../../utils/db';
import { lineArgOf, lineMsgFields } from '../../utils/chatLine';
import { findAlreadyImported } from '../../utils/chatImportPhone';
import { planImportRows, runImport, type DuplicateMode } from '../../utils/chatImportPhoneWrite';
import { parseStChat, stChatTitle, type StChatImport as Parsed } from '../../utils/stChat';
import { buildNewDateStory, dateStoryLabel, loadActiveDateStory, saveDateStory } from '../../utils/dateStory';
import { trackEvent } from '../../utils/analytics';

/**
 * 見面記錄「匯入 SillyTavern 聊天」（plans/chat-import-export.md 第 4 節）：一份 .jsonl ＝ 一場見面故事。
 * 放在這個角色這條線上；同一份再匯一次，就補進原本那場（跳過已經有的）或原地覆蓋。不觸發任何 AI。
 */
export interface StChatImportHandle { open: () => void }

interface Pending {
    data: Parsed;
    title: string;
    existing: Message[];
    /** 已經匯過的話：原本那場 */
    prevStory: DateStory | null;
    dupCount: number;
    active: DateStory | null;
}

const fmtDate = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };

const StChatImport = forwardRef<StChatImportHandle, {
    char: CharacterProfile;
    /** 匯完要設成進行中時寫回角色（DateApp 的 updateCharacter 會寫到這條線上） */
    onSetActive: (storyId: string) => void;
    onDone: (story: DateStory) => void;
}>(({ char, onSetActive, onDone }, ref) => {
    const { addToast } = useOS();
    const inputRef = useRef<HTMLInputElement>(null);
    const [p, setP] = useState<Pending | null>(null);
    const [duplicate, setDuplicate] = useState<DuplicateMode>('skip');
    const [continueIt, setContinueIt] = useState(true);
    const [busy, setBusy] = useState(false);

    useImperativeHandle(ref, () => ({ open: () => inputRef.current?.click() }));

    const read = async (file: File) => {
        let data: Parsed;
        try {
            data = parseStChat(await file.text());
        } catch (e: any) {
            addToast(`${e?.message || '讀不出這個檔案'}。這裡收 SillyTavern 匯出的聊天（.jsonl）；角色卡請到神經鏈接匯入。`, 'error');
            return;
        }
        if (!data.messages.length) { addToast('這份聊天裡沒有收得進來的訊息', 'error'); return; }
        const existing = await DB.getRecentMessagesByCharIdAndSource(lineArgOf(char), 'date', 100000).catch(() => [] as Message[]);
        const dup = findAlreadyImported(existing, data.messages);
        let prevStory: DateStory | null = null;
        if (dup.existingMessageIds.length) {
            const counts: Record<string, number> = {};
            const hit = new Set(dup.existingMessageIds);
            for (const m of existing) if (hit.has(m.id) && m.metadata?.dateStoryId) counts[m.metadata.dateStoryId] = (counts[m.metadata.dateStoryId] || 0) + 1;
            const storyId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
            prevStory = storyId ? (await DB.getDateStory(storyId).catch(() => undefined)) || null : null;
        }
        const active = await loadActiveDateStory(char).catch(() => null);
        setDuplicate('skip');
        setContinueIt(!active);
        setP({ data, title: stChatTitle(file.name), existing, prevStory, dupCount: dup.existingMessageIds.length, active });
    };

    const close = () => setP(null);

    const doImport = async () => {
        if (!p || busy) return;
        setBusy(true);
        try {
            const { data } = p;
            const range = data.range!;
            let story = p.prevStory;
            let created = false;
            if (!story) {
                const ongoing = continueIt && !p.active;
                // 匯進來的是別處的舊故事：不拿走角色身上「下一場」的大綱和時間設定
                story = buildNewDateStory(char, Date.now(), {
                    title: p.title.trim() || undefined,
                    scenario: undefined,
                    time: undefined,
                    createdAt: range.from,
                    status: ongoing ? 'ongoing' : 'completed',
                    ...(ongoing ? {} : { completedAt: range.to }),
                });
                story = await saveDateStory(story);
                created = true;
            }
            const fields = lineMsgFields(char);
            const storyId = story.id;
            const plan = planImportRows({
                messages: data.messages.map(m => ({ ...m, metadata: { ...m.metadata, dateStoryId: storyId } })),
                existing: created ? [] : p.existing,
                duplicate,
                place: () => fields,
            });
            const res = await runImport(plan, () => char.name);
            if (created && story.status === 'ongoing') onSetActive(story.id);
            trackEvent('导入聊天记录', { 来源: 'SillyTavern', 类型: '见面故事', 目标: created ? '新建' : '现有', 重复: p.dupCount ? (duplicate === 'skip' ? '跳过' : '覆盖') : '无' });
            addToast(created
                ? `已匯入「${dateStoryLabel(story)}」，${res.added} 則${story.status === 'ongoing' ? '，下次見面可以接著' : '，收在已完結'}`
                : `「${dateStoryLabel(story)}」補上 ${res.added} 則${res.overwritten ? `、覆蓋 ${res.overwritten} 則` : ''}`, 'success');
            close();
            onDone(story);
        } catch (e: any) {
            addToast(`匯入失敗：${e?.message || '未知錯誤'}`, 'error');
        } finally {
            setBusy(false);
        }
    };

    const card = 'rounded-2xl bg-white p-4 shadow-sm space-y-3';
    const h = 'text-[11px] font-bold uppercase tracking-wide text-slate-400';
    const newCount = p ? p.data.messages.length - p.dupCount : 0;
    const nothingNew = !!p?.prevStory && duplicate === 'skip' && newCount === 0;
    const st = p?.data.stats;

    const page = p && st && (
        <div role="dialog" aria-label="匯入 SillyTavern 聊天" className="fixed inset-0 z-[10040] flex flex-col bg-slate-50 text-slate-800" style={{ height: 'var(--app-height, 100%)' }}>
            <div className="shrink-0 bg-white/90 backdrop-blur border-b border-slate-100" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="relative flex items-center px-3 py-3">
                    <button type="button" onClick={close} aria-label="返回" className="p-1.5 rounded-full hover:bg-black/5"><CaretLeft size={22} weight="bold" className="text-slate-600" /></button>
                    <h1 className="absolute left-1/2 -translate-x-1/2 text-base font-bold">匯入 SillyTavern 聊天</h1>
                </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 space-y-3">
                <div className={card}>
                    <div className={h}>{p.prevStory ? '已經匯過' : '變成一場見面故事'}</div>
                    {p.prevStory ? (
                        <>
                            <p className="text-[13px]">這份聊天匯過了，在「{dateStoryLabel(p.prevStory)}」裡（{p.dupCount} 則已經有了{newCount > 0 ? `，檔案裡多了 ${newCount} 則` : ''}）。</p>
                            <div className="flex gap-2">
                                {(['skip', 'overwrite'] as const).map(mode => (
                                    <button key={mode} type="button" onClick={() => setDuplicate(mode)}
                                        className={`flex-1 rounded-xl py-2 text-[12px] font-bold ${duplicate === mode ? 'bg-violet-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                        {mode === 'skip' ? '只補上新的' : '覆蓋'}
                                    </button>
                                ))}
                            </div>
                            {duplicate === 'overwrite' && <p className="flex gap-1.5 text-[11px] text-amber-600"><Warning size={14} weight="bold" className="mt-px shrink-0" />已經有的 {p.dupCount} 則會換回檔案裡的版本：在 Soren 裡改過、重新生成過的會被蓋掉。</p>}
                        </>
                    ) : (
                        <>
                            <label className="block text-[11px] text-slate-500">故事名字
                                <input value={p.title} onChange={e => setP({ ...p, title: e.target.value })} maxLength={40} placeholder="沒填就用開始的日期"
                                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-700 focus:outline-none focus:border-violet-300" />
                            </label>
                            {p.active ? (
                                <p className="text-[11px] text-slate-400">「{char.name}」現在有一場進行中的故事（「{dateStoryLabel(p.active)}」），匯入的這場先收進已完結，在「按故事」裡回看。</p>
                            ) : (
                                <label className="flex items-center gap-2 text-[12px] text-slate-600">
                                    <input type="checkbox" className="accent-violet-500" checked={continueIt} onChange={e => setContinueIt(e.target.checked)} />
                                    匯完設成進行中，下次見面接著這場
                                </label>
                            )}
                        </>
                    )}
                    {p.data.charName && p.data.charName !== char.name && (
                        <p className="flex gap-1.5 text-[11px] text-amber-600"><Warning size={14} weight="bold" className="mt-px shrink-0" />檔案裡的角色叫「{p.data.charName}」，會放在「{char.name}」這裡。</p>
                    )}
                </div>

                <div className={card}>
                    <div className={h}>裡面有什麼</div>
                    <div className="text-[13px]">共 <b>{p.data.messages.length}</b> 則{p.data.range ? `，${fmtDate(p.data.range.from)} ～ ${fmtDate(p.data.range.to)}` : ''}</div>
                    <div className="flex flex-wrap gap-1.5">
                        {[[`${char.name}`, st.char], ['你', st.user], ['帶思考過程', st.withThinking], ['ST 裡隱藏的', st.hidden]].filter(([, n]) => Number(n) > 0).map(([k, n]) => (
                            <span key={String(k)} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">{k} {n}</span>
                        ))}
                    </div>
                    <div className="space-y-1 text-[11px] text-slate-400">
                        {st.droppedSwipes > 0 && <div>只收當時選的那一版，其他 {st.droppedSwipes} 個版本（swipe）不收。</div>}
                        {st.images > 0 && <div>你在 ST 傳的 {st.images} 張圖存在 ST 本機，帶不過來。</div>}
                        {Object.keys(p.data.skipped).length > 0 && <div>收不進來：{Object.entries(p.data.skipped).map(([k, n]) => `${k} ${n} 則`).join('、')}</div>}
                    </div>
                </div>

                <p className="px-1 pb-2 text-[10px] leading-relaxed text-slate-400">
                    思考過程收進每則的「思考過程」；正文裡其他的標籤（像 &lt;content_format&gt;、狀態欄）原樣留著，要好看就到見面設定匯入同一套 ST 預設和正則。匯入不會讓角色回話或總結。
                </p>
            </div>
            <div className="shrink-0 border-t border-slate-100 bg-white px-4 pt-3" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" onClick={() => void doImport()} disabled={busy || nothingNew}
                    className="w-full rounded-2xl bg-violet-500 py-3 text-sm font-bold text-white disabled:opacity-50">
                    {busy ? '匯入中…' : nothingNew ? '沒有新的可以補' : '匯入'}
                </button>
            </div>
        </div>
    );

    return (
        <>
            <input ref={inputRef} type="file" accept=".jsonl,.json,application/jsonl,application/x-ndjson,text/plain" className="hidden" aria-label="選 SillyTavern 聊天檔"
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f); }} />
            {page && typeof document !== 'undefined' && createPortal(page, document.body)}
        </>
    );
});

export default StChatImport;
