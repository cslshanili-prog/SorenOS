import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check } from '@phosphor-icons/react';
import type { CharacterProfile, CharLineFields, ChatTheme, GroupProfile, OSTheme } from '../../types';
import { PRESET_THEMES } from '../chat/ChatConstants';
import {
    CHARACTER_DECORATION_RESET, GROUP_DECORATION_RESET, characterHasOwnDecoration, characterPatchFromDraft, describeDraft,
    groupIgnoredParts, groupPatchFromDraft, groupStatus, makeTemplate, statusOf, uniqueTemplateName, templateFromCharacter, templateFromGroup,
    type DecorationStatus, type DecorationTemplate,
} from '../../utils/decorationTemplates';
import { DECORATION_TEMPLATES_CHANGED_EVENT, loadDecorationTemplates, saveDecorationTemplates } from '../../utils/decorationTemplateStore';
import { trackEvent } from '../../utils/analytics';

/**
 * 聊天裡「＋→聊天裝扮」（plans/decoration-app.md 第 6 節）：只選模板，點一下就換上，背後的聊天就是預覽；
 * 沒有輸入框（鍵盤不會跳出來擋住）。要細調就「到裝扮 App 編輯」。
 * 角色的非主線：沒設的照主線，所以第一格是「跟著主線」。
 */
export type QuickPanelTarget =
    | { kind: 'character'; char: CharacterProfile; /** 非主線：那條線自己存的欄位；主線不給 */ lineOwn?: CharLineFields | null }
    | { kind: 'group'; group: GroupProfile };

interface Props {
    target: QuickPanelTarget;
    theme: OSTheme;
    customThemes: ChatTheme[];
    addCustomTheme: (theme: ChatTheme) => void | Promise<void>;
    /** 寫回去（私聊是照線走的 updateCharacter，群是 updateGroup） */
    apply: (patch: Partial<CharacterProfile> & Partial<GroupProfile>) => void | Promise<void>;
    onOpenApp: () => void;
    onClose: () => void;
    /** 面板底下多放的東西（群：直接改白框、提示音） */
    extra?: React.ReactNode;
}

const DECORATION_KEYS = [...Object.keys(CHARACTER_DECORATION_RESET), 'decorationTemplateId'];

const DecorationQuickPanel: React.FC<Props> = ({ target, theme, customThemes, addCustomTheme, apply, onOpenApp, onClose, extra }) => {
    const [templates, setTemplates] = useState<DecorationTemplate[] | null>(null);
    const [collapsed, setCollapsed] = useState(false);
    const [pending, setPending] = useState<DecorationTemplate | 'follow' | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let alive = true;
        const load = () => void loadDecorationTemplates({ existingBubbles: customThemes, addBubble: addCustomTheme })
            .then(r => { if (alive) setTemplates(r.templates); })
            .catch(() => { if (alive) setTemplates([]); });
        load();
        window.addEventListener(DECORATION_TEMPLATES_CHANGED_EVENT, load);
        return () => { alive = false; window.removeEventListener(DECORATION_TEMPLATES_CHANGED_EVENT, load); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const isLine = target.kind === 'character' && target.lineOwn !== undefined;
    const name = target.kind === 'character' ? target.char.name : target.group.name;
    const followLabel = isLine ? '跟著主線' : '跟著全局';
    const bubbles = useMemo(() => [...Object.values(PRESET_THEMES), ...customThemes], [customThemes]);
    const bubbleName = (id: string) => bubbles.find(b => b.id === id)?.name || '找不到的氣泡';
    const list = templates || [];

    const status: DecorationStatus = (() => {
        if (target.kind === 'group') return groupStatus(target.group, list);
        if (isLine) {
            const own = target.lineOwn || {};
            const hasOwn = DECORATION_KEYS.some(k => (own as Record<string, unknown>)[k] !== undefined);
            if (!hasOwn) return { kind: 'follow' };
            return statusOf(own, list, true);
        }
        return statusOf(target.char, list, characterHasOwnDecoration(target.char));
    })();

    const run = async (work: () => Promise<void> | void) => {
        setBusy(true);
        try { await work(); } finally { setBusy(false); }
    };

    const doApply = (choice: DecorationTemplate | 'follow') => run(async () => {
        if (choice === 'follow') {
            await apply(target.kind === 'group'
                ? { ...GROUP_DECORATION_RESET, decorationTemplateId: undefined }
                : { ...CHARACTER_DECORATION_RESET, decorationTemplateId: undefined });
        } else {
            await apply(target.kind === 'group' ? groupPatchFromDraft(choice, choice.id) : characterPatchFromDraft(choice, choice.id));
            trackEvent('装扮模板指定', { 对象: target.kind === 'group' ? '群' : '角色' });
        }
        setPending(null);
    });

    const pick = (choice: DecorationTemplate | 'follow') => {
        if (status.kind === 'template' && choice !== 'follow' && status.template.id === choice.id) return;
        if (status.kind === 'follow' && choice === 'follow') return;
        // 自訂的樣子會被蓋掉：先問
        if (status.kind === 'custom') { setPending(choice); return; }
        void doApply(choice);
    };

    const saveCustomThenApply = (choice: DecorationTemplate | 'follow' | null) => run(async () => {
        const draft = target.kind === 'group' ? templateFromGroup(target.group) : templateFromCharacter(target.char, theme);
        const created = makeTemplate(uniqueTemplateName(`${name} 的裝扮`, list), draft);
        const next = [...list, created];
        await saveDecorationTemplates(next);
        setTemplates(next);
        trackEvent('装扮模板保存', { 类型: '存成模板' });
        await apply(target.kind === 'group' ? groupPatchFromDraft(created, created.id) : characterPatchFromDraft(created, created.id));
        if (choice) await doApply(choice);
        setPending(null);
    });

    const card = (key: string, title: string, sub: string, active: boolean, onClick: () => void) => (
        <button key={key} type="button" disabled={busy} onClick={onClick} data-quick-template={title}
            className={`flex w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition active:scale-[0.99] ${active ? 'border-violet-300 bg-violet-50' : 'border-slate-200 bg-white'}`}>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-bold text-slate-800">{title}</span>
                <span className="block truncate text-[11px] text-slate-400">{sub}</span>
            </span>
            {active && <Check size={16} weight="bold" className="shrink-0 text-violet-600" />}
        </button>
    );

    return createPortal(
        <div className="fixed inset-x-0 bottom-0 z-[110] flex justify-center pointer-events-none" data-decoration-quick>
            <div className="pointer-events-auto w-full max-w-[560px] rounded-t-3xl border border-slate-200 bg-[#faf9fc]/95 backdrop-blur-xl shadow-[0_-10px_48px_#20162e20] flex flex-col"
                style={{ maxHeight: 'min(62vh, calc(100dvh - var(--safe-top, 0px) - 16px))', paddingBottom: 'var(--safe-bottom, 0px)' }}>
                <div className="flex items-center gap-2 px-5 pt-4 pb-3">
                    <div className="min-w-0 flex-1">
                        <div className="text-[10px] tracking-[0.25em] text-slate-400">{target.kind === 'group' ? 'GROUP' : 'CHATAPP'}</div>
                        <div className="truncate text-[18px] font-medium text-slate-800">裝扮 · {name}</div>
                    </div>
                    <button type="button" onClick={() => setCollapsed(v => !v)} className="rounded-full bg-[#eeeaf3] px-3.5 py-2 text-[12px] text-[#6c5b85]">{collapsed ? '展開' : '看效果'}</button>
                    <button type="button" onClick={onClose} className="rounded-full bg-[#76618d] px-3.5 py-2 text-[12px] text-white">完成</button>
                </div>
                {!collapsed && (<>
                    <div className="px-5 pb-2 text-[11px] text-slate-500">
                        現在：{status.kind === 'template' ? `模板「${status.template.name}」` : status.kind === 'custom' ? '自訂（只有這個聊天的樣子）' : followLabel}
                        {target.kind === 'group' && '　· 群只套 CSS、聲音、我的氣泡'}
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pb-3 space-y-2">
                        {templates === null ? <p className="py-4 text-center text-[12px] text-slate-400">讀取中…</p> : (<>
                            {status.kind === 'custom' && card('custom', '自訂（現在的樣子）', '換別的會蓋掉；可以先存成模板', true, () => {})}
                            {card('follow', followLabel, isLine ? '這條線沒設的都照主線' : '用全局默認的樣子', status.kind === 'follow', () => pick('follow'))}
                            {list.map(t => card(t.id, t.name,
                                `${describeDraft(t, bubbleName)}${target.kind === 'group' && groupIgnoredParts(t).length ? `（群用不到${groupIgnoredParts(t).join('、')}）` : ''}`,
                                status.kind === 'template' && status.template.id === t.id, () => pick(t)))}
                            {!list.length && <p className="py-2 text-center text-[12px] text-slate-400">還沒有模板，到裝扮 App 做一套</p>}
                        </>)}
                    </div>
                    {pending && (
                        <div className="mx-5 mb-2 rounded-2xl bg-amber-50 border border-amber-200 p-3 space-y-2" data-quick-confirm>
                            <div className="text-[12px] text-amber-800">這個聊天現在是自訂的，換成「{pending === 'follow' ? followLabel : pending.name}」會蓋掉它。</div>
                            <div className="flex gap-2">
                                <button type="button" disabled={busy} onClick={() => saveCustomThenApply(pending)} className="flex-1 rounded-full bg-white border border-amber-300 py-2 text-[12px] font-bold text-amber-800">先存成模板再換</button>
                                <button type="button" disabled={busy} onClick={() => doApply(pending)} className="flex-1 rounded-full bg-amber-500 py-2 text-[12px] font-bold text-white">直接換</button>
                                <button type="button" onClick={() => setPending(null)} className="px-2 text-[12px] text-amber-700">取消</button>
                            </div>
                        </div>
                    )}
                    <div className="px-5 pb-4 pt-1 space-y-2 border-t border-slate-100">
                        {status.kind === 'custom' && !pending && (
                            <button type="button" disabled={busy} onClick={() => saveCustomThenApply(null)} className="w-full rounded-2xl bg-violet-50 py-2.5 text-[13px] font-bold text-violet-700">把現在的樣子存成模板</button>
                        )}
                        <button type="button" onClick={onOpenApp} className="flex w-full items-center justify-center gap-1.5 rounded-2xl bg-slate-800 py-3 text-[13px] font-bold text-white" data-quick-open-app>
                            到裝扮 App 編輯 <ArrowRight size={14} weight="bold" />
                        </button>
                        {extra}
                    </div>
                </>)}
            </div>
        </div>,
        document.body,
    );
};

export default DecorationQuickPanel;
