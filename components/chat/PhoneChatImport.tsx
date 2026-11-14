import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretLeft, Warning } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import type { CharacterProfile, ChatLine, Message, MessageType } from '../../types';
import { DB } from '../../utils/db';
import { parsePhoneExport, findAlreadyImported, toMemoryFragments, type PhoneImport, type ImportedMessage } from '../../utils/chatImportPhone';
import { planImportRows, runImport, type DuplicateMode, type ImportPlace } from '../../utils/chatImportPhoneWrite';
import { lineFor } from '../../utils/chatLine';
import { personaNameForKey } from '../../utils/userPersona';
import { isAltChar } from '../../utils/charAlt';
import { trackEvent } from '../../utils/analytics';

/**
 * 從另一家手機風格 App 匯入聊天紀錄（plans/chat-import-export.md 第 2、3 節）。
 * 選檔 → 認格式 → 這一頁選放到哪、看預覽、勾記憶 → 匯入。不觸發任何 AI。
 *
 * preset：從私聊的聊天設置進來就固定那個角色那條線；從群組設置進來就固定那個群。
 * 檔案跟 preset 對不上（例如在私聊匯了群聊檔）就當作沒給 preset，自己選。
 */
export type ChatImportPreset = { kind: 'private'; charId: string; personaKey?: string } | { kind: 'group'; groupId: string };
export type ChatImportDone = { kind: 'private'; charId: string; personaKey?: string } | { kind: 'group'; groupId: string; members: string[] };

export interface PhoneChatImportHandle {
    /** 打開選檔（帶 preset 就固定放到哪） */
    open: (preset?: ChatImportPreset) => void;
}

const TYPE_LABEL: Partial<Record<MessageType, string>> = { text: '文字', image: '圖片', emoji: '貼圖', transfer: '轉帳', voice: '語音', system: '系統小字' };
const NEW = '__new__';

const fmtDate = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};

const PhoneChatImport = forwardRef<PhoneChatImportHandle, { onDone?: (r: ChatImportDone) => void }>(({ onDone }, ref) => {
    const { characters, groups, userProfileBase, addCharacter, updateCharacter, createGroup, updateGroup, addToast } = useOS();
    const inputRef = useRef<HTMLInputElement>(null);
    const presetRef = useRef<ChatImportPreset | undefined>(undefined);
    const [data, setData] = useState<PhoneImport | null>(null);
    const [preset, setPreset] = useState<ChatImportPreset | undefined>(undefined);
    const [presetDropped, setPresetDropped] = useState(false);
    // 私聊
    const [charTarget, setCharTarget] = useState<string>(NEW);
    const [personaTarget, setPersonaTarget] = useState<string | undefined>(undefined);
    // 群聊
    const [groupTarget, setGroupTarget] = useState<string>(NEW);
    const [speakerMap, setSpeakerMap] = useState<Record<string, string>>({});
    // 共用
    const [existing, setExisting] = useState<Message[] | null>(null);
    const [duplicate, setDuplicate] = useState<DuplicateMode>('skip');
    const [memoryOn, setMemoryOn] = useState<Record<string, boolean>>({});
    const [showMemories, setShowMemories] = useState(false);
    const [busy, setBusy] = useState(false);

    const pickable = useMemo(() => characters.filter(c => !isAltChar(c)), [characters]);

    const reset = () => {
        setData(null); setExisting(null); setDuplicate('skip'); setMemoryOn({}); setShowMemories(false);
        setPresetDropped(false); setSpeakerMap({});
    };

    useImperativeHandle(ref, () => ({
        open: (p?: ChatImportPreset) => { presetRef.current = p; inputRef.current?.click(); },
    }));

    const read = async (file: File) => {
        let parsed: PhoneImport;
        try {
            parsed = parsePhoneExport(JSON.parse(await file.text()));
        } catch (e: any) {
            addToast(e?.message === '不是認得的聊天紀錄檔' || e instanceof SyntaxError
                ? '認不出這個檔案。目前支援：另一家手機風格 App 匯出的私聊／群聊 JSON。SillyTavern 的聊天請到見面匯入，角色卡請到神經鏈接。'
                : (e?.message || '讀不出這個檔案'), 'error');
            return;
        }
        reset();
        const p = presetRef.current;
        const fits = !p || p.kind === parsed.kind;
        setPreset(fits ? p : undefined);
        setPresetDropped(!fits);
        if (parsed.kind === 'private') {
            if (fits && p?.kind === 'private') {
                setCharTarget(p.charId); setPersonaTarget(p.personaKey);
            } else {
                const same = pickable.find(c => c.name === parsed.character.name);
                setCharTarget(same ? same.id : NEW); setPersonaTarget(undefined);
            }
        } else {
            setGroupTarget(fits && p?.kind === 'group' ? p.groupId : (groups.find(g => g.name === parsed.group.name)?.id ?? NEW));
            const map: Record<string, string> = {};
            for (const sp of parsed.speakers) map[sp.name] = pickable.find(c => c.name === sp.name)?.id ?? NEW;
            setSpeakerMap(map);
        }
        setMemoryOn(Object.fromEntries(parsed.memories.map(m => [m.key, true])));
        setData(parsed);
    };

    // ─── 放到哪 ───
    const targetChar = data?.kind === 'private' && charTarget !== NEW ? characters.find(c => c.id === charTarget) : undefined;
    const lineKeys = targetChar ? (targetChar.knownPersonaKeys?.length ? targetChar.knownPersonaKeys : (targetChar.primaryPersonaKey ? [targetChar.primaryPersonaKey] : [])) : [];
    const line: ChatLine | null = data?.kind === 'private'
        ? (targetChar ? lineFor(targetChar, personaTarget) : null)
        : null;

    // 目標上已經有的訊息（算重複、提醒排序）
    useEffect(() => {
        let alive = true;
        setExisting(null);
        if (!data) return;
        const load = data.kind === 'private'
            ? (line ? DB.getMessagesByCharId(line, true) : Promise.resolve([] as Message[]))
            : (groupTarget !== NEW ? DB.getGroupMessages(groupTarget) : Promise.resolve([] as Message[]));
        load.then(rows => { if (alive) setExisting(rows); }).catch(() => { if (alive) setExisting([]); });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data, line?.charId, line?.personaKey, groupTarget]);

    const dup = useMemo(() => (data && existing ? findAlreadyImported(existing, data.messages) : null), [data, existing]);
    const dupCount = dup?.ids.size ?? 0;
    const otherCount = existing ? existing.length - (dup?.existingMessageIds.length ?? 0) : 0;
    /** 會新增（接在後面）的則數：重複的不管跳過還是覆蓋都不新增 */
    const newCount = data ? data.messages.length - dupCount : 0;

    const close = () => { reset(); presetRef.current = undefined; };

    // ─── 匯入 ───
    const nameForNew = async (name: string, extra: Partial<CharacterProfile> = {}): Promise<CharacterProfile> => {
        const c = await addCharacter();
        updateCharacter(c.id, { name, ...extra });
        // addCharacter 的 id 用毫秒時間，連建幾個要錯開
        await new Promise(r => setTimeout(r, 3));
        return { ...c, name, ...extra };
    };

    const doImport = async () => {
        if (!data || busy || existing === null) return;
        setBusy(true);
        try {
            if (data.kind === 'private') {
                let char = targetChar;
                let created = false;
                if (!char) {
                    const { name, role, description } = data.character;
                    char = await nameForNew(name, {
                        description: role || '',
                        systemPrompt: [role ? `身份：${role}` : '', description || ''].filter(Boolean).join('\n\n'),
                    });
                    created = true;
                }
                const ln = created ? { charId: char.id } : (line || { charId: char.id });
                const place = (): ImportPlace => ({ charId: char!.id, ...(ln.personaKey ? { personaKey: ln.personaKey } : {}) });
                const plan = planImportRows({ messages: data.messages, existing: created ? [] : existing, duplicate, place });
                const res = await runImport(plan, () => char!.name);
                const picked = data.memories.filter(m => memoryOn[m.key]);
                if (picked.length) {
                    const personaName = ln.personaKey ? personaNameForKey(userProfileBase, ln.personaKey) : undefined;
                    const frags = toMemoryFragments(picked).map(f => (ln.personaKey ? { ...f, personaKey: ln.personaKey, personaName } : f));
                    updateCharacter(char.id, prev => ({ memories: [...(prev.memories || []), ...frags] }));
                }
                trackEvent('导入聊天记录', { 来源: '另一家', 类型: '私聊', 目标: created ? '新建' : '现有', 重复: dupCount ? (duplicate === 'skip' ? '跳过' : '覆盖') : '无' });
                addToast(`已匯入 ${res.added} 則${res.overwritten ? `、覆蓋 ${res.overwritten} 則` : ''}${res.skippedDuplicates ? `（${res.skippedDuplicates} 則已經有了，跳過）` : ''}${picked.length ? `，記憶 ${picked.length} 條` : ''}`, 'success');
                close();
                onDone?.({ kind: 'private', charId: char.id, ...(ln.personaKey ? { personaKey: ln.personaKey } : {}) });
            } else {
                // 發話人 → 角色（沒對到的新建）
                const idByName: Record<string, string> = {};
                for (const sp of data.speakers) {
                    const chosen = speakerMap[sp.name];
                    idByName[sp.name] = chosen && chosen !== NEW ? chosen : (await nameForNew(sp.name)).id;
                }
                const memberIds = [...new Set(Object.values(idByName))];
                let groupId = groupTarget;
                let members = memberIds;
                const createdGroup = groupTarget === NEW;
                if (createdGroup) {
                    groupId = (await createGroup(data.group.name, memberIds)).id;
                } else {
                    const g = groups.find(x => x.id === groupTarget);
                    const missing = memberIds.filter(id => !g?.members.includes(id));
                    members = [...(g?.members || []), ...missing];
                    if (g && missing.length) await updateGroup(g.id, { members });
                }
                const fallbackId = memberIds[0] || 'user';
                const place = (m: ImportedMessage): ImportPlace | null => {
                    if (m.role === 'user') return { charId: 'user', groupId };
                    if (m.role === 'system') return { charId: (m.speaker && idByName[m.speaker]) || fallbackId, groupId };
                    const id = m.speaker ? idByName[m.speaker] : undefined;
                    return id ? { charId: id, groupId } : null;
                };
                const plan = planImportRows({ messages: data.messages, existing: createdGroup ? [] : existing, duplicate, place });
                const res = await runImport(plan, src => src?.speaker || '成員');
                trackEvent('导入聊天记录', { 来源: '另一家', 类型: '群聊', 目标: createdGroup ? '新建' : '现有', 重复: dupCount ? (duplicate === 'skip' ? '跳过' : '覆盖') : '无' });
                addToast(`已匯入 ${res.added} 則${res.overwritten ? `、覆蓋 ${res.overwritten} 則` : ''}${res.skippedDuplicates ? `（${res.skippedDuplicates} 則已經有了，跳過）` : ''}${res.unplaced ? `，${res.unplaced} 則對不到發話人沒收` : ''}`, 'success');
                close();
                onDone?.({ kind: 'group', groupId, members });
            }
        } catch (e: any) {
            addToast(`匯入失敗：${e?.message || '未知錯誤'}`, 'error');
        } finally {
            setBusy(false);
        }
    };

    // ─── 畫面 ───
    const d = data;
    const sel = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-700 focus:outline-none focus:border-violet-300';
    const card = 'rounded-2xl bg-white p-4 shadow-sm space-y-3';
    const h = 'text-[11px] font-bold uppercase tracking-wide text-slate-400';
    const pickedCount = d ? d.memories.filter(m => memoryOn[m.key]).length : 0;

    const page = d && (
        <div role="dialog" aria-label="匯入聊天紀錄" className="fixed inset-0 z-[10040] flex flex-col bg-slate-50 text-slate-800" style={{ height: 'var(--app-height, 100%)' }}>
            <div className="shrink-0 bg-white/90 backdrop-blur border-b border-slate-100" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="relative flex items-center px-3 py-3">
                    <button type="button" onClick={close} aria-label="返回" className="p-1.5 rounded-full hover:bg-black/5"><CaretLeft size={22} weight="bold" className="text-slate-600" /></button>
                    <h1 className="absolute left-1/2 -translate-x-1/2 text-base font-bold">匯入聊天紀錄</h1>
                </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 space-y-3">
                {/* 檔案 */}
                <div className={card}>
                    <div className="text-base font-bold truncate">{d.kind === 'private' ? `跟「${d.character.name}」的私聊` : `群聊「${d.group.name}」`}</div>
                    <div className="text-[11px] text-slate-400">另一家手機風格 App 的匯出檔{d.exportDate ? ` · 匯出於 ${fmtDate(Date.parse(d.exportDate) || 0)}` : ''}</div>
                    {presetDropped && <p className="text-[11px] text-amber-600">這是{d.kind === 'group' ? '群聊' : '私聊'}的紀錄，不是這裡的{d.kind === 'group' ? '私聊' : '群聊'}，下面自己選要放到哪。</p>}
                </div>

                {/* 放到哪 */}
                <div className={card}>
                    <div className={h}>放到哪</div>
                    {d.kind === 'private' ? (
                        <>
                            {preset?.kind === 'private' ? (
                                <div className="text-[13px]">「{targetChar?.name || '這個角色'}」{lineKeys.length > 1 && personaTarget ? `· 跟 ${personaNameForKey(userProfileBase, personaTarget)} 的那條線` : ''}</div>
                            ) : (
                                <select aria-label="選角色" className={sel} value={charTarget} onChange={e => { setCharTarget(e.target.value); setPersonaTarget(undefined); }}>
                                    <option value={NEW}>新建一個「{d.character.name}」</option>
                                    {[...pickable].sort((a, b) => Number(b.name === d.character.name) - Number(a.name === d.character.name)).map(c => (
                                        <option key={c.id} value={c.id}>{c.name}{c.name === d.character.name ? '（同名）' : ''}</option>
                                    ))}
                                </select>
                            )}
                            {preset?.kind !== 'private' && targetChar && lineKeys.length > 1 && (
                                <select aria-label="選線" className={sel} value={personaTarget ?? targetChar.primaryPersonaKey ?? ''} onChange={e => setPersonaTarget(e.target.value)}>
                                    {lineKeys.map(k => <option key={k} value={k}>跟 {personaNameForKey(userProfileBase, k)} 的那條線{k === targetChar.primaryPersonaKey ? '（主線）' : ''}</option>)}
                                </select>
                            )}
                            {charTarget === NEW && <p className="text-[11px] text-slate-400">新角色會帶上檔案裡的名字{d.character.role ? '、身份' : ''}{d.character.description ? '、簡介' : ''}，頭像和人設之後到神經鏈接補。</p>}
                        </>
                    ) : (
                        <>
                            {preset?.kind === 'group' ? (
                                <div className="text-[13px]">「{groups.find(g => g.id === groupTarget)?.name || '這個群'}」</div>
                            ) : (
                                <select aria-label="選群" className={sel} value={groupTarget} onChange={e => setGroupTarget(e.target.value)}>
                                    <option value={NEW}>新建群「{d.group.name}」</option>
                                    {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                                </select>
                            )}
                            <div className="pt-1 space-y-2">
                                <div className="text-[11px] text-slate-500">誰是誰（照名字對到 Soren 的角色，對不到的會新建）</div>
                                {d.speakers.map(sp => (
                                    <div key={sp.name} className="flex items-center gap-2">
                                        <div className="w-24 shrink-0 truncate text-[12px] text-slate-600" title={sp.name}>{sp.name}<span className="text-slate-400"> · {sp.count}</span></div>
                                        <select aria-label={`${sp.name} 是誰`} className={sel} value={speakerMap[sp.name] ?? NEW} onChange={e => setSpeakerMap(m => ({ ...m, [sp.name]: e.target.value }))}>
                                            <option value={NEW}>新建「{sp.name}」</option>
                                            {pickable.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                        </select>
                                    </div>
                                ))}
                                {groupTarget !== NEW && (() => {
                                    const g = groups.find(x => x.id === groupTarget);
                                    const outside = d.speakers.filter(sp => speakerMap[sp.name] === NEW || (speakerMap[sp.name] && !g?.members.includes(speakerMap[sp.name])));
                                    return outside.length ? <p className="text-[11px] text-slate-400">{outside.map(s => s.name).join('、')} 不在這個群裡，匯入時會加進群。</p> : null;
                                })()}
                            </div>
                        </>
                    )}
                </div>

                {/* 預覽 */}
                <div className={card}>
                    <div className={h}>裡面有什麼</div>
                    <div className="text-[13px]">
                        共 <b>{d.messages.length}</b> 則{d.range ? `，${fmtDate(d.range.from)} ～ ${fmtDate(d.range.to)}` : ''}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        {Object.entries(d.counts).map(([t, n]) => (
                            <span key={t} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">{TYPE_LABEL[t as MessageType] || t} {n}</span>
                        ))}
                        {d.messages.some(m => m.metadata.narration) && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">其中旁白 {d.messages.filter(m => m.metadata.narration).length}</span>}
                        {d.messages.some(m => m.metadata.thinkingChain) && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">帶心聲 {d.messages.filter(m => m.metadata.thinkingChain).length}</span>}
                    </div>
                    {Object.keys(d.skipped).length > 0 && (
                        <div className="text-[11px] text-slate-400">收不進來：{Object.entries(d.skipped).map(([k, n]) => `${k} ${n} 則`).join('、')}</div>
                    )}
                </div>

                {/* 已經有訊息／重複 */}
                {existing && dupCount > 0 && (
                    <div className={card}>
                        <div className={h}>重複</div>
                        <p className="text-[13px]">其中 <b>{dupCount}</b> 則已經匯過了。</p>
                        <div className="flex gap-2">
                            {(['skip', 'overwrite'] as const).map(mode => (
                                <button key={mode} type="button" onClick={() => setDuplicate(mode)}
                                    className={`flex-1 rounded-xl py-2 text-[12px] font-bold ${duplicate === mode ? 'bg-violet-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                    {mode === 'skip' ? '跳過已經有的' : '覆蓋'}
                                </button>
                            ))}
                        </div>
                        {duplicate === 'overwrite' && <p className="flex gap-1.5 text-[11px] text-amber-600"><Warning size={14} weight="bold" className="mt-px shrink-0" />這 {dupCount} 則會換回檔案裡的版本：在 Soren 裡改過、重新生成過的會被蓋掉。</p>}
                    </div>
                )}
                {existing && otherCount > 0 && newCount > 0 && (
                    <p className="flex gap-1.5 px-1 text-[11px] leading-relaxed text-amber-600">
                        <Warning size={14} weight="bold" className="mt-px shrink-0" />
                        這裡已經有 {otherCount} 則訊息。Soren 的訊息照寫進去的先後排，匯進來的會接在現有訊息後面（時間照原本的標），角色也會把它們當成最近聊的。想照時間排，建議匯到新角色{d.kind === 'group' ? '／新群' : '或空的線'}。
                    </p>
                )}

                {/* 記憶 */}
                {d.memories.length > 0 && (
                    d.kind === 'private' ? (
                        <div className={card}>
                            <div className="flex items-center justify-between">
                                <div className={h}>記憶（{pickedCount}／{d.memories.length}）</div>
                                <div className="flex gap-3 text-[11px] font-bold text-violet-500">
                                    <button type="button" onClick={() => setMemoryOn(Object.fromEntries(d.memories.map(m => [m.key, true])))}>全選</button>
                                    <button type="button" onClick={() => setMemoryOn({})}>全不選</button>
                                    <button type="button" onClick={() => setShowMemories(v => !v)}>{showMemories ? '收起' : '展開'}</button>
                                </div>
                            </div>
                            <p className="text-[11px] text-slate-400">他記得的事 {d.memories.filter(m => m.kind === 'fact').length} 條、總結 {d.memories.filter(m => m.kind === 'summary').length} 篇。勾的會收進角色記憶，標「匯入」；記憶宮殿之後手動或自動整理時才會進去。</p>
                            {showMemories && (
                                <div className="space-y-1.5">
                                    {d.memories.map(m => (
                                        <label key={m.key} className="flex items-start gap-2 rounded-xl bg-slate-50 p-2.5 text-[12px]">
                                            <input type="checkbox" className="mt-0.5 accent-violet-500" checked={!!memoryOn[m.key]} onChange={e => setMemoryOn(s => ({ ...s, [m.key]: e.target.checked }))} />
                                            <span className="min-w-0 flex-1">
                                                <span className="text-[10px] text-slate-400">{m.kind === 'fact' ? '記得的事' : '總結'} · {m.date}</span>
                                                <span className="mt-0.5 block whitespace-pre-wrap break-words text-slate-700 line-clamp-4">{m.summary}</span>
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    ) : (
                        <p className="px-1 text-[11px] text-slate-400">檔案裡的群聊總結 {d.memories.length} 篇不匯入（群聊的話題盒會照 Soren 自己的方式整理）。</p>
                    )
                )}

                <p className="px-1 pb-2 text-[10px] leading-relaxed text-slate-400">圖片和貼圖還是連到原本的圖床，那邊刪了或關了就看不到。匯入不會讓角色回話或總結，要接著聊照常傳一句就好。</p>
            </div>
            <div className="shrink-0 border-t border-slate-100 bg-white px-4 pt-3" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" onClick={() => void doImport()} disabled={busy || existing === null}
                    className="w-full rounded-2xl bg-violet-500 py-3 text-sm font-bold text-white disabled:opacity-50">
                    {busy ? '匯入中…' : existing === null ? '讀取中…' : '匯入'}
                </button>
            </div>
        </div>
    );

    return (
        <>
            <input ref={inputRef} type="file" accept=".json,application/json" className="hidden" aria-label="選聊天紀錄檔案"
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f); }} />
            {page && typeof document !== 'undefined' && createPortal(page, document.body)}
        </>
    );
});

export default PhoneChatImport;
