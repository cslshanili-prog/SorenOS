import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretLeft, CaretRight, Check, CopySimple, DownloadSimple, PencilSimple, Plus, ShareNetwork, Trash, UploadSimple, UsersThree } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import type { AppID, CharacterProfile, ChatTheme, GroupProfile } from '../types';
import ThemeMaker from './ThemeMaker';
import DecorationEditor, { type EditorSubject } from '../components/decoration/DecorationEditor';
import { PRESET_THEMES } from '../components/chat/ChatConstants';
import { isBenched } from '../utils/castRole';
import { portableTree, readDecorationFile, validateDecoration } from '../utils/chatDecoration';
import {
    characterPatchFromDraft, characterStatus, describeDraft, draftOfTemplate, duplicateTemplate, GROUP_DECORATION_RESET,
    CHARACTER_DECORATION_RESET, groupIgnoredParts, groupPatchFromDraft, groupStatus, makeTemplate, presetToTemplate,
    templateFromCharacter, templateFromGroup, templateFromTheme, templateToPresetDraft, templateUsage, themePatchFromDraft,
    themeStatus, type DecorationDraft, type DecorationStatus, type DecorationTargetRef, type DecorationTemplate,
} from '../utils/decorationTemplates';
import { loadDecorationTemplates, saveDecorationTemplates } from '../utils/decorationTemplateStore';
import { takeDecorationHandoff } from '../utils/decorationHandoff';
import { migrateChatThemeBlobRefs, migrateDataUrlToRef } from '../utils/blobRef';
import { shareOrDownloadFile } from '../utils/shareExport';
import { safeShareFileName } from '../utils/pngShare';
import { trackEvent } from '../utils/analytics';

/**
 * 裝扮 App（plans/decoration-app.md）：取代桌面的氣泡工坊。
 * 首頁三段：正在用（全局、每個角色、每個群用哪個模板）、我的模板、氣泡主題。
 * 模板是綁定：存模板時把所有用它的聊天重寫一次（寫穿，見 utils/decorationTemplates.ts）。
 */
type View =
    | { kind: 'home' }
    | { kind: 'edit'; subject: EditorSubject; initial: DecorationDraft; templateId?: string; target?: DecorationTargetRef }
    | { kind: 'bubble'; theme?: ChatTheme; onPicked?: (id: string) => void; back: View };

const targetKey = (t: DecorationTargetRef) => (t.kind === 'global' ? 'global' : `${t.kind}:${t.id}`);

const DecorationApp: React.FC = () => {
    const {
        closeApp, openApp, addToast, theme, updateTheme, characters, updateCharacter, groups, updateGroup,
        customThemes, addCustomTheme, userProfile,
    } = useOS();
    const [templates, setTemplates] = useState<DecorationTemplate[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [view, setView] = useState<View>({ kind: 'home' });
    const [busy, setBusy] = useState(false);
    const [targetSheet, setTargetSheet] = useState<DecorationTargetRef | null>(null);
    const [assignFor, setAssignFor] = useState<DecorationTemplate | null>(null);
    const [deleting, setDeleting] = useState<DecorationTemplate | null>(null);
    const [returnTo, setReturnTo] = useState<AppID | undefined>(undefined);
    const fileRef = useRef<HTMLInputElement>(null);

    // 最新的資料（寫穿時用，避免拿到舊的 closure）
    const dataRef = useRef({ theme, characters, groups, customThemes });
    dataRef.current = { theme, characters, groups, customThemes };

    const visibleChars = useMemo(() => characters.filter(c => !c.altOf && !isBenched(c)), [characters]);
    const allBubbles = useMemo(() => [...Object.values(PRESET_THEMES), ...customThemes], [customThemes]);
    const bubbleName = useCallback((id: string) => allBubbles.find(b => b.id === id)?.name || '找不到的氣泡', [allBubbles]);

    useEffect(() => {
        let alive = true;
        void loadDecorationTemplates({ existingBubbles: dataRef.current.customThemes, addBubble: addCustomTheme }).then(({ templates, migrated }) => {
            if (!alive) return;
            setTemplates(templates);
            setLoaded(true);
            if (migrated) addToast(`把原本的 ${migrated} 套整套預設搬成模板了`, 'info');
        }).catch(() => { if (alive) { setLoaded(true); addToast('模板讀不出來，重開一次試試', 'error'); } });
        const handoff = takeDecorationHandoff();
        if (handoff) {
            setReturnTo(handoff.from);
            if (handoff.target) setTargetSheet(handoff.target);
        }
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const leave = () => (returnTo ? openApp(returnTo) : closeApp());

    const persist = async (next: DecorationTemplate[]) => {
        setTemplates(next);
        await saveDecorationTemplates(next);
    };

    // ─── 寫給誰 ───

    const writeTemplateTo = async (target: DecorationTargetRef, template: DecorationTemplate) => {
        if (target.kind === 'global') await updateTheme(themePatchFromDraft(template, template.id));
        else if (target.kind === 'character') await updateCharacter(target.id, characterPatchFromDraft(template, template.id));
        else await updateGroup(target.id, groupPatchFromDraft(template, template.id));
    };

    /** 存模板：用它的每個聊天重寫一次 */
    const writeThrough = async (template: DecorationTemplate) => {
        const usage = templateUsage(template.id, dataRef.current);
        for (const target of usage) await writeTemplateTo(target, template);
        return usage.length;
    };

    const nameOf = (t: DecorationTargetRef) => (t.kind === 'global' ? '全局默認'
        : t.kind === 'character' ? (characters.find(c => c.id === t.id)?.name || '角色') : `群「${groups.find(g => g.id === t.id)?.name || ''}」`);

    const statusFor = (t: DecorationTargetRef): DecorationStatus => {
        if (t.kind === 'global') return themeStatus(theme, templates);
        if (t.kind === 'character') { const c = characters.find(x => x.id === t.id); return c ? characterStatus(c, templates) : { kind: 'follow' }; }
        const g = groups.find(x => x.id === t.id);
        return g ? groupStatus(g, templates) : { kind: 'follow' };
    };

    const currentDraftOf = (t: DecorationTargetRef): DecorationDraft => {
        if (t.kind === 'global') return templateFromTheme(theme);
        if (t.kind === 'character') return templateFromCharacter(characters.find(c => c.id === t.id)!, theme);
        return templateFromGroup(groups.find(g => g.id === t.id)!);
    };

    const editCustom = (t: DecorationTargetRef) => {
        const subject: EditorSubject = t.kind === 'global' ? { kind: 'global' }
            : t.kind === 'character' ? { kind: 'character', char: characters.find(c => c.id === t.id)! }
                : { kind: 'group', group: groups.find(g => g.id === t.id)! };
        setTargetSheet(null);
        setView({ kind: 'edit', subject, initial: currentDraftOf(t), target: t });
    };

    const editTemplate = (template: DecorationTemplate) => {
        setView({ kind: 'edit', subject: { kind: 'template', name: template.name, usageCount: templateUsage(template.id, dataRef.current).length }, initial: draftOfTemplate(template), templateId: template.id });
    };

    const newTemplate = (initial: DecorationDraft = {}) => {
        setView({ kind: 'edit', subject: { kind: 'template', name: '我的裝扮', usageCount: 0 }, initial });
    };

    const run = async (work: () => Promise<void>) => {
        setBusy(true);
        try { await work(); } catch (error: any) { addToast(error?.message || '沒成功，再試一次', 'error'); } finally { setBusy(false); }
    };

    const saveEditor = (draft: DecorationDraft, name?: string) => run(async () => {
        if (view.kind !== 'edit') return;
        if (view.subject.kind === 'template') {
            const now = Date.now();
            if (view.templateId) {
                const old = templates.find(t => t.id === view.templateId);
                if (!old) throw new Error('這份模板不見了');
                const updated: DecorationTemplate = { ...structuredClone(draft), id: old.id, name: name || old.name, createdAt: old.createdAt, updatedAt: now };
                await persist(templates.map(t => (t.id === old.id ? updated : t)));
                const count = await writeThrough(updated);
                addToast(count ? `存好了，${count} 個聊天一起換上` : '存好了', 'success');
                trackEvent('装扮模板保存', { 类型: '修改' });
                setView({ kind: 'home' });
            } else {
                const created = makeTemplate(name || '我的裝扮', draft, now);
                await persist([...templates, created]);
                addToast('新模板存好了，指定給聊天就會換上', 'success');
                trackEvent('装扮模板保存', { 类型: '新建' });
                setView({ kind: 'home' });
                setAssignFor(created);
            }
            return;
        }
        const target = view.target!;
        if (target.kind === 'global') await updateTheme(themePatchFromDraft(draft));
        else if (target.kind === 'character') await updateCharacter(target.id, characterPatchFromDraft(draft));
        else await updateGroup(target.id, groupPatchFromDraft(draft));
        addToast(`${nameOf(target)} 換好了`, 'success');
        trackEvent('装扮模板保存', { 类型: '自订' });
        setView({ kind: 'home' });
    });

    // ─── 換模板（正在用那一行） ───

    const pickForTarget = (t: DecorationTargetRef, choice: { kind: 'follow' } | { kind: 'template'; template: DecorationTemplate }) => run(async () => {
        if (choice.kind === 'follow') {
            if (t.kind === 'character') await updateCharacter(t.id, { ...CHARACTER_DECORATION_RESET, decorationTemplateId: undefined });
            else if (t.kind === 'group') await updateGroup(t.id, { ...GROUP_DECORATION_RESET, decorationTemplateId: undefined });
            addToast(`${nameOf(t)} 改成跟著全局`, 'success');
        } else {
            await writeTemplateTo(t, choice.template);
            addToast(`${nameOf(t)} 換上「${choice.template.name}」`, 'success');
            trackEvent('装扮模板指定', { 对象: t.kind === 'global' ? '全局' : t.kind === 'character' ? '角色' : '群' });
        }
        setTargetSheet(null);
    });

    const saveCustomAsTemplate = (t: DecorationTargetRef) => run(async () => {
        const created = makeTemplate(`${nameOf(t)} 的裝扮`, currentDraftOf(t));
        await persist([...templates, created]);
        await writeTemplateTo(t, created);
        addToast(`存成模板「${created.name}」，${nameOf(t)} 也改用它了`, 'success');
        trackEvent('装扮模板保存', { 类型: '存成模板' });
        setTargetSheet(null);
    });

    // ─── 指定給誰（模板卡片） ───

    const applyAssign = (template: DecorationTemplate, picked: Set<string>) => run(async () => {
        const before = new Set(templateUsage(template.id, dataRef.current).map(targetKey));
        const all: DecorationTargetRef[] = [{ kind: 'global' }, ...visibleChars.map(c => ({ kind: 'character', id: c.id } as const)), ...groups.map(g => ({ kind: 'group', id: g.id } as const))];
        let added = 0, removed = 0;
        for (const t of all) {
            const key = targetKey(t);
            if (picked.has(key) && !before.has(key)) { await writeTemplateTo(t, template); added++; }
            if (!picked.has(key) && before.has(key)) {
                // 不用這份了：留著現在的樣子，變成自訂
                if (t.kind === 'global') await updateTheme({ decorationTemplateId: undefined });
                else if (t.kind === 'character') await updateCharacter(t.id, { decorationTemplateId: undefined });
                else await updateGroup(t.id, { decorationTemplateId: undefined });
                removed++;
            }
        }
        if (added) trackEvent('装扮模板指定', { 对象: '批量' });
        addToast(added || removed ? `換上 ${added} 個${removed ? `，${removed} 個留著現在的樣子變自訂` : ''}` : '沒有變化', added || removed ? 'success' : 'info');
        setAssignFor(null);
    });

    // ─── 複製、刪除、匯入匯出 ───

    const duplicate = (template: DecorationTemplate) => run(async () => {
        const copy = duplicateTemplate(template, templates);
        const index = templates.findIndex(t => t.id === template.id);
        await persist([...templates.slice(0, index + 1), copy, ...templates.slice(index + 1)]);
        addToast(`複製了一份「${copy.name}」`, 'success');
        trackEvent('装扮模板复制');
    });

    const remove = (template: DecorationTemplate) => run(async () => {
        for (const t of templateUsage(template.id, dataRef.current)) {
            if (t.kind === 'global') await updateTheme({ decorationTemplateId: undefined });
            else if (t.kind === 'character') await updateCharacter(t.id, { decorationTemplateId: undefined });
            else await updateGroup(t.id, { decorationTemplateId: undefined });
        }
        await persist(templates.filter(t => t.id !== template.id));
        addToast('刪掉了；用它的聊天留著現在的樣子', 'success');
        setDeleting(null);
    });

    const exportTemplate = (template: DecorationTemplate) => run(async () => {
        const preset = validateDecoration(await portableTree(templateToPresetDraft(template, allBubbles)));
        await shareOrDownloadFile({ content: JSON.stringify(preset, null, 2), fileName: `${safeShareFileName(template.name)}.json`, mimeType: 'application/json', card: { kind: 'chat-decoration', title: template.name } });
        trackEvent('装扮模板导出');
    });

    const importFile = (file: File) => run(async () => {
        const item = await readDecorationFile(file);
        let created: DecorationTemplate;
        if (item.kind === 'image') {
            created = makeTemplate(item.name || '匯入的背景', { background: { image: await migrateDataUrlToRef(item.image), style: 'plain' } });
        } else {
            const { template, newBubble } = await presetToTemplate(item.preset, customThemes, {
                migrateImage: migrateDataUrlToRef, migrateBubble: migrateChatThemeBlobRefs, newBubbleId: () => `decoration-${crypto.randomUUID()}`,
            });
            if (newBubble) await addCustomTheme(newBubble);
            created = template;
        }
        await persist([...templates, created]);
        addToast(`匯入成模板「${created.name}」`, 'success');
        trackEvent('装扮模板导入', { 来源: item.kind === 'image' ? '图片' : '文件' });
        setAssignFor(created);
    });

    // ─── 畫面 ───

    if (view.kind === 'bubble') {
        return (
            <div className="h-full w-full relative" data-decoration-bubble>
                <ThemeMaker embedded={{ theme: view.theme, onExit: savedId => { if (savedId) view.onPicked?.(savedId); setView(view.back); } }} />
            </div>
        );
    }

    if (view.kind === 'edit') {
        return (
            <div className="h-full w-full relative">
                <DecorationEditor
                    key={view.templateId || (view.target ? targetKey(view.target) : 'new')}
                    subject={view.subject} initial={view.initial} theme={theme} customThemes={customThemes}
                    previewChar={visibleChars[0]} userAvatar={userProfile?.avatar} busy={busy}
                    onSave={saveEditor} onBack={() => setView({ kind: 'home' })}
                    onOpenBubble={(existing, onPicked) => setView({ kind: 'bubble', theme: existing, onPicked, back: view })}
                />
            </div>
        );
    }

    const statusChip = (s: DecorationStatus, t: DecorationTargetRef) => (
        <span className={`shrink-0 max-w-[45%] truncate rounded-full px-2.5 py-1 text-[11px] font-bold ${s.kind === 'template' ? 'bg-violet-100 text-violet-700' : s.kind === 'custom' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
            {s.kind === 'template' ? s.template.name : s.kind === 'custom' ? (t.kind === 'global' ? '自己的設定' : '自訂') : '跟著全局'}
        </span>
    );
    const row = (t: DecorationTargetRef, label: string, sub?: string, avatar?: string) => (
        <button key={targetKey(t)} type="button" onClick={() => setTargetSheet(t)} className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-slate-50" data-decoration-row={targetKey(t)}>
            {avatar !== undefined && (avatar ? <img src={avatar} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" /> : <span className="h-8 w-8 shrink-0 rounded-full bg-slate-200" />)}
            <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-slate-800">{label}</span>
                {sub && <span className="block truncate text-[11px] text-slate-400">{sub}</span>}
            </span>
            {statusChip(statusFor(t), t)}
            <CaretRight size={14} className="shrink-0 text-slate-300" />
        </button>
    );

    return (
        <div className="h-full w-full flex flex-col bg-slate-50 relative" data-decoration-app>
            <div className="shrink-0 bg-white/90 backdrop-blur border-b border-slate-100" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="relative flex items-center justify-between px-3 py-3">
                    <button type="button" onClick={leave} aria-label="返回" className="p-1.5 rounded-full hover:bg-black/5"><CaretLeft size={22} weight="bold" className="text-slate-600" /></button>
                    <h1 className="absolute left-1/2 -translate-x-1/2 text-base font-bold">裝扮</h1>
                    <div className="flex items-center gap-1">
                        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} aria-label="匯入模板" className="p-2 rounded-full hover:bg-black/5 disabled:opacity-40"><UploadSimple size={20} className="text-slate-600" /></button>
                        <button type="button" onClick={() => newTemplate()} aria-label="新模板" className="p-2 rounded-full hover:bg-black/5"><Plus size={20} weight="bold" className="text-slate-600" /></button>
                    </div>
                </div>
            </div>
            <input ref={fileRef} type="file" accept=".json,.css,.txt,.png,image/*,application/json,text/plain,text/css" className="hidden" aria-label="選裝扮檔案"
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />

            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-6" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 2rem)' }}>
                <section>
                    <h2 className="mb-2 px-1 text-[12px] font-bold text-slate-500">正在用</h2>
                    <div className="rounded-2xl bg-white border border-slate-100 divide-y divide-slate-100 overflow-hidden">
                        {row({ kind: 'global' }, '全局默認', '沒有自己設定的聊天都用這套')}
                        {visibleChars.map(c => row({ kind: 'character', id: c.id }, c.name, undefined, c.avatar || ''))}
                        {groups.map(g => row({ kind: 'group', id: g.id }, g.name, '群只套 CSS、聲音、我的氣泡', g.avatar || ''))}
                    </div>
                </section>

                <section>
                    <div className="mb-2 flex items-center justify-between px-1">
                        <h2 className="text-[12px] font-bold text-slate-500">我的模板</h2>
                        <button type="button" onClick={() => newTemplate()} className="flex items-center gap-1 text-[12px] font-bold text-violet-600"><Plus size={12} weight="bold" /> 新模板</button>
                    </div>
                    {!loaded ? <p className="px-1 text-[12px] text-slate-400">讀取中…</p> : templates.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-[12px] text-slate-400">
                            還沒有模板。按「新模板」做一套，或在「正在用」裡把某個聊天現在的樣子存成模板。
                        </div>
                    ) : (
                        <div className="space-y-2.5">
                            {templates.map(t => {
                                const usage = templateUsage(t.id, { theme, characters, groups });
                                return (
                                    <div key={t.id} className="rounded-2xl bg-white border border-slate-100 px-4 py-3" data-decoration-template={t.name}>
                                        <button type="button" onClick={() => editTemplate(t)} className="w-full text-left">
                                            <div className="flex items-center gap-2">
                                                <span className="min-w-0 flex-1 truncate text-[14px] font-bold text-slate-800">{t.name}</span>
                                                <span className="shrink-0 text-[11px] text-slate-400">{usage.length ? `${usage.length} 個聊天在用` : '沒人用'}</span>
                                                <span role="button" tabIndex={0} aria-label={`刪除 ${t.name}`} onClick={e => { e.stopPropagation(); if (!busy) setDeleting(t); }} className="shrink-0 -mr-1 p-1 text-slate-300"><Trash size={14} /></span>
                                            </div>
                                            <div className="mt-0.5 truncate text-[11px] text-slate-500">{describeDraft(t, bubbleName)}</div>
                                        </button>
                                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                                            <button type="button" disabled={busy} onClick={() => setAssignFor(t)} className="flex items-center gap-1 rounded-full bg-violet-50 px-3 py-1 text-[12px] font-bold text-violet-700"><UsersThree size={13} /> 指定給…</button>
                                            <button type="button" disabled={busy} onClick={() => editTemplate(t)} className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-[12px] text-slate-600"><PencilSimple size={13} /> 編輯</button>
                                            <button type="button" disabled={busy} onClick={() => duplicate(t)} className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-[12px] text-slate-600"><CopySimple size={13} /> 複製一份</button>
                                            <button type="button" disabled={busy} onClick={() => exportTemplate(t)} aria-label={`匯出 ${t.name}`} className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-[12px] text-slate-600"><ShareNetwork size={13} /> 匯出</button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </section>

                <section>
                    <div className="mb-2 flex items-center justify-between px-1">
                        <h2 className="text-[12px] font-bold text-slate-500">氣泡主題</h2>
                        <button type="button" onClick={() => setView({ kind: 'bubble', back: { kind: 'home' } })} className="flex items-center gap-1 text-[12px] font-bold text-violet-600"><Plus size={12} weight="bold" /> 做一套</button>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                        {allBubbles.map(b => (
                            <button key={b.id} type="button" onClick={() => setView({ kind: 'bubble', theme: b.type === 'preset' ? undefined : b, back: { kind: 'home' } })}
                                className="flex flex-col items-center gap-2 rounded-2xl bg-white border border-slate-100 px-2 py-3 min-w-0" data-decoration-bubble-item={b.name}>
                                <span className="rounded-xl px-2.5 py-1.5 text-[11px]" style={{ background: b.user.backgroundColor, color: b.user.textColor }}>你好呀</span>
                                <span className="max-w-full truncate text-[11px] text-slate-500">{b.name}</span>
                            </button>
                        ))}
                    </div>
                    <p className="mt-2 px-1 text-[11px] text-slate-400">內建的氣泡點進去會開一套新的來改。</p>
                </section>
            </div>

            {targetSheet && (() => {
                const t = targetSheet;
                const s = statusFor(t);
                const exists = t.kind === 'global' || (t.kind === 'character' ? characters.some(c => c.id === t.id) : groups.some(g => g.id === t.id));
                if (!exists) return null;
                const willReplace = s.kind === 'custom' && t.kind !== 'global';
                return (
                    <div className="absolute inset-0 z-30 bg-black/30 flex items-end" onClick={() => setTargetSheet(null)}>
                        <div className="w-full max-h-[80%] overflow-y-auto rounded-t-3xl bg-white p-5 space-y-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 1.25rem)' }} onClick={e => e.stopPropagation()} data-decoration-target-sheet>
                            <div className="text-[15px] font-bold">{nameOf(t)} 用哪套？</div>
                            {willReplace && <p className="text-[11px] text-amber-700 bg-amber-50 rounded-xl px-3 py-2">這個聊天現在是自訂的，換成別的會蓋掉；想留著可以先「存成模板」。</p>}
                            {t.kind === 'group' && <p className="text-[11px] text-slate-400">群只套模板裡的 CSS、聲音、我的氣泡。</p>}
                            {t.kind !== 'global' && (
                                <button type="button" disabled={busy} onClick={() => pickForTarget(t, { kind: 'follow' })} className="w-full flex items-center justify-between rounded-2xl border border-slate-200 px-4 py-3 text-left text-[14px]">
                                    跟著全局 {s.kind === 'follow' && <Check size={16} weight="bold" className="text-violet-600" />}
                                </button>
                            )}
                            {templates.map(tpl => (
                                <button key={tpl.id} type="button" disabled={busy} onClick={() => pickForTarget(t, { kind: 'template', template: tpl })} className="w-full flex items-center justify-between gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-left">
                                    <span className="min-w-0">
                                        <span className="block truncate text-[14px]">{tpl.name}</span>
                                        <span className="block truncate text-[11px] text-slate-400">{describeDraft(tpl, bubbleName)}{t.kind === 'group' && groupIgnoredParts(tpl).length ? `（群用不到${groupIgnoredParts(tpl).join('、')}）` : ''}</span>
                                    </span>
                                    {s.kind === 'template' && s.template.id === tpl.id && <Check size={16} weight="bold" className="shrink-0 text-violet-600" />}
                                </button>
                            ))}
                            <div className="flex gap-2 pt-1">
                                <button type="button" disabled={busy} onClick={() => editCustom(t)} className="flex-1 rounded-2xl bg-slate-100 py-3 text-[13px] text-slate-700">{s.kind === 'template' ? '只改這個聊天' : '編輯現在的樣子'}</button>
                                {s.kind !== 'template' && (t.kind === 'global' || s.kind === 'custom') && (
                                    <button type="button" disabled={busy} onClick={() => saveCustomAsTemplate(t)} className="flex-1 rounded-2xl bg-violet-50 py-3 text-[13px] font-bold text-violet-700"><DownloadSimple size={14} className="inline -mt-0.5" /> 存成模板</button>
                                )}
                            </div>
                            {s.kind === 'template' && <p className="text-[11px] text-slate-400">「只改這個聊天」存了之後，這個聊天就不跟著模板變了（變成自訂）。</p>}
                        </div>
                    </div>
                );
            })()}

            {assignFor && <AssignSheet template={assignFor} chars={visibleChars} groups={groups} theme={theme} characters={characters} busy={busy}
                onClose={() => setAssignFor(null)} onApply={picked => applyAssign(assignFor, picked)} />}

            {deleting && (
                <div className="absolute inset-0 z-30 bg-black/30 flex items-end" onClick={() => setDeleting(null)}>
                    <div className="w-full rounded-t-3xl bg-white p-5 space-y-3" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 1.25rem)' }} onClick={e => e.stopPropagation()}>
                        <div className="text-[15px] font-bold">刪掉「{deleting.name}」？</div>
                        <p className="text-[12px] text-slate-500">用它的聊天會留著現在的樣子，變成自訂。氣泡主題不會刪。</p>
                        <button type="button" disabled={busy} onClick={() => remove(deleting)} className="w-full rounded-2xl bg-rose-500 py-3 text-[14px] font-bold text-white">刪掉</button>
                        <button type="button" onClick={() => setDeleting(null)} className="w-full py-2 text-[13px] text-slate-400">算了</button>
                    </div>
                </div>
            )}
        </div>
    );
};

const AssignSheet: React.FC<{
    template: DecorationTemplate; chars: CharacterProfile[]; characters: CharacterProfile[]; groups: GroupProfile[];
    theme: Parameters<typeof templateUsage>[1]['theme']; busy: boolean;
    onClose: () => void; onApply: (picked: Set<string>) => void;
}> = ({ template, chars, characters, groups, theme, busy, onClose, onApply }) => {
    const initial = useMemo(() => new Set(templateUsage(template.id, { theme, characters, groups }).map(targetKey)), [template.id, theme, characters, groups]);
    const [picked, setPicked] = useState<Set<string>>(initial);
    const toggle = (key: string) => setPicked(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    const customReplaced = chars.filter(c => picked.has(`character:${c.id}`) && !initial.has(`character:${c.id}`) && characterStatus(c, []).kind === 'custom').length;
    const item = (key: string, label: string, sub?: string) => (
        <label key={key} className="flex items-center gap-3 px-1 py-2.5">
            <input type="checkbox" className="h-5 w-5 accent-violet-500" checked={picked.has(key)} onChange={() => toggle(key)} />
            <span className="min-w-0 flex-1"><span className="block truncate text-[14px]">{label}</span>{sub && <span className="block text-[11px] text-slate-400">{sub}</span>}</span>
        </label>
    );
    return (
        <div className="absolute inset-0 z-30 bg-black/30 flex items-end" onClick={onClose}>
            <div className="w-full max-h-[82%] flex flex-col rounded-t-3xl bg-white" onClick={e => e.stopPropagation()} data-decoration-assign>
                <div className="px-5 pt-5 pb-2">
                    <div className="text-[15px] font-bold">「{template.name}」指定給…</div>
                    <p className="text-[11px] text-slate-400 mt-1">勾了的聊天馬上換上；之後改這份模板，它們都會跟著變。取消勾的留著現在的樣子，變成自訂。</p>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-5 divide-y divide-slate-100">
                    {item('global', '全局默認', '沒有自己設定的聊天都用這套')}
                    {chars.map(c => item(`character:${c.id}`, c.name))}
                    {groups.map(g => item(`group:${g.id}`, `群「${g.name}」`, groupIgnoredParts(template).length ? `群用不到${groupIgnoredParts(template).join('、')}` : undefined))}
                </div>
                <div className="px-5 pt-3 space-y-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 1.25rem)' }}>
                    {customReplaced > 0 && <p className="text-[11px] text-amber-700">有 {customReplaced} 個自訂的聊天會被換掉。</p>}
                    <button type="button" disabled={busy} onClick={() => onApply(picked)} className="w-full rounded-2xl bg-violet-500 py-3 text-[14px] font-bold text-white disabled:opacity-40">好了</button>
                </div>
            </div>
        </div>
    );
};

export default DecorationApp;
