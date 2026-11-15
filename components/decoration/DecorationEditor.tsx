import React, { useMemo, useState } from 'react';
import { CaretDown, CaretLeft, CaretUp, PencilSimple, Plus } from '@phosphor-icons/react';
import type { CharacterProfile, ChatTheme, GroupProfile, OSTheme } from '../../types';
import DecorationPreview from './DecorationPreview';
import ChatLayoutSettings from '../chat/ChatLayoutSettings';
import ChromeCssEditor from '../chat/ChromeCssEditor';
import WhiteboxSoundEditor from '../chat/WhiteboxSoundEditor';
import { PRESET_THEMES } from '../chat/ChatConstants';
import '../chat/ChatDecorationPanel.css';
import { LAYOUT_DEFAULTS, pickDecorationLayout } from '../../utils/chatDecoration';
import {
    CHARACTER_DECORATION_RESET, characterPatchFromDraft, groupIgnoredParts, themePatchFromDraft,
    type ChatBackgroundStyle, type DecorationDraft,
} from '../../utils/decorationTemplates';
import { putImageBlob, useBlobRefUrl } from '../../utils/blobRef';
import type { SoreHandoff } from '../../utils/assistant/handoff';
import AskSoreButton from '../assistant/AskSoreButton';

/**
 * 裝扮編輯頁（plans/decoration-app.md 第 4 節）：模板、全局、某個角色或群的「自訂」共用。
 * 改的是草稿，按「存」才寫；上半是用真元件畫的預覽，可以收起來讓編輯區佔滿。
 */
export type EditorSubject =
    | { kind: 'template'; name: string; usageCount: number }
    | { kind: 'global' }
    | { kind: 'character'; char: CharacterProfile }
    | { kind: 'group'; group: GroupProfile };

type Tab = 'layout' | 'bubble' | 'background' | 'sound' | 'css';

interface Props {
    subject: EditorSubject;
    initial: DecorationDraft;
    theme: OSTheme;
    customThemes: ChatTheme[];
    /** 預覽用的角色（模板、全局、群沒有自己的角色時拿第一個角色的名字頭像） */
    previewChar?: CharacterProfile;
    userAvatar?: string;
    busy?: boolean;
    onSave: (draft: DecorationDraft, name?: string) => void | Promise<void>;
    onBack: () => void;
    /** 去氣泡編輯；existing 給了就編那套，存完回來 onPicked 選上 */
    onOpenBubble: (existing: ChatTheme | undefined, onPicked: (id: string) => void) => void;
    /** 模板已經存過的話，它的 id（給「請 Sore 幫忙」） */
    templateId?: string;
}

const TAB_LABEL: Record<Tab, string> = { layout: '佈局', bubble: '氣泡', background: '背景', sound: '聲音', css: 'CSS' };
const BG_LABEL: Record<ChatBackgroundStyle, string> = { plain: '純色', grid: '網格', paper: '紙張', mesh: '柔光' };
const LAYOUT_KEYS = Object.keys(LAYOUT_DEFAULTS);

const FollowToggle: React.FC<{ on: boolean; label: string; onChange: (follow: boolean) => void; hint?: string }> = ({ on, label, onChange, hint }) => (
    <label className="flex items-center justify-between gap-3 rounded-2xl bg-white border border-slate-100 px-3.5 py-3 mb-4">
        <span className="text-[13px] text-slate-700">{label}{hint && <small className="block text-[11px] text-slate-400 mt-0.5">{hint}</small>}</span>
        <input type="checkbox" className="h-5 w-5 accent-violet-500" checked={on} onChange={e => onChange(e.target.checked)} />
    </label>
);

const DecorationEditor: React.FC<Props> = ({ subject, initial, theme, customThemes, previewChar, userAvatar, busy, onSave, onBack, onOpenBubble, templateId }) => {
    const [draft, setDraft] = useState<DecorationDraft>(() => structuredClone(initial));
    const [name, setName] = useState(subject.kind === 'template' ? subject.name : '');
    const [tab, setTab] = useState<Tab>(subject.kind === 'group' ? 'bubble' : 'layout');
    const [showPreview, setShowPreview] = useState(true);
    const [confirmLeave, setConfirmLeave] = useState(false);
    const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial) || (subject.kind === 'template' && name !== subject.name), [draft, initial, name, subject]);
    const isGlobal = subject.kind === 'global';
    const isGroup = subject.kind === 'group';
    const followLabel = isGlobal ? '' : '跟著全局默認';
    const set = (patch: Partial<DecorationDraft>) => setDraft(prev => {
        const next = { ...prev, ...patch };
        for (const key of Object.keys(patch) as Array<keyof DecorationDraft>) if (patch[key] === undefined) delete next[key];
        return next;
    });
    const allThemes = useMemo(() => [...Object.values(PRESET_THEMES), ...customThemes], [customThemes]);
    const bgUrl = useBlobRefUrl(draft.background?.image || undefined);

    // 預覽：草稿先寫到副本上，跟聊天畫面同一套合併
    const baseChar: CharacterProfile = subject.kind === 'character' ? subject.char
        : { ...(previewChar || ({ id: 'decoration-preview', name: '角色', avatar: '' } as CharacterProfile)), ...CHARACTER_DECORATION_RESET, decorationTemplateId: undefined };
    const simTheme: OSTheme = isGlobal ? { ...theme, ...themePatchFromDraft(draft) } : theme;
    const simChar: CharacterProfile = isGlobal ? baseChar
        : isGroup ? { ...baseChar, ...characterPatchFromDraft({ css: draft.css, cssStacksOnGlobal: true, bubbleThemeId: draft.bubbleThemeId, sound: draft.sound }) }
            : { ...baseChar, ...characterPatchFromDraft(draft) };

    const tabs: Tab[] = isGroup ? ['bubble', 'sound', 'css'] : ['layout', 'bubble', 'background', 'sound', 'css'];
    const title = subject.kind === 'template' ? '編輯模板' : subject.kind === 'global' ? '全局默認' : subject.kind === 'character' ? `${subject.char.name} · 自訂` : `群「${subject.group.name}」· 自訂`;
    const assist: Omit<SoreHandoff, 'from'> | undefined = isGlobal ? { location: 'chat_chrome_global' }
        : subject.kind === 'character' ? { location: 'chat_chrome_char', targetId: subject.char.id }
            : subject.kind === 'group' ? { location: 'chat_chrome_group', targetId: subject.group.id } : undefined;

    const layoutTheme: OSTheme = { ...theme, ...LAYOUT_DEFAULTS, ...(draft.layout || {}), chatBackgroundStyle: draft.background?.style || theme.chatBackgroundStyle };
    const changeLayout = (patch: Partial<OSTheme>) => {
        const layoutPatch = Object.fromEntries(Object.entries(patch).filter(([k]) => LAYOUT_KEYS.includes(k)));
        const next: Partial<DecorationDraft> = {};
        if (Object.keys(layoutPatch).length) next.layout = pickDecorationLayout({ ...LAYOUT_DEFAULTS, ...(draft.layout || {}), ...layoutPatch });
        if (patch.chatBackgroundStyle) next.background = { image: draft.background?.image ?? null, style: patch.chatBackgroundStyle };
        set(next);
    };

    const save = () => onSave(draft, subject.kind === 'template' ? (name.trim() || '我的裝扮') : undefined);
    const back = () => (dirty ? setConfirmLeave(true) : onBack());

    return (
        <div className="absolute inset-0 flex flex-col bg-slate-50" data-decoration-editor data-subject={subject.kind}>
            <div className="shrink-0 bg-white/95 backdrop-blur border-b border-slate-100" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center gap-2 px-3 py-2.5">
                    <button type="button" onClick={back} aria-label="返回" className="p-1.5 rounded-full hover:bg-black/5"><CaretLeft size={22} weight="bold" className="text-slate-600" /></button>
                    <div className="min-w-0 flex-1">
                        {subject.kind === 'template'
                            ? <input value={name} onChange={e => setName(e.target.value.slice(0, 60))} aria-label="模板名字" className="w-full bg-transparent text-[15px] font-bold outline-none" placeholder="模板名字" />
                            : <div className="truncate text-[15px] font-bold">{title}</div>}
                        <div className="text-[10px] text-slate-400 truncate">
                            {subject.kind === 'template' ? (subject.usageCount ? `${subject.usageCount} 個聊天在用，存了都會跟著變` : '還沒有聊天在用') : dirty ? '有沒存的改動' : '改完按「存」才會換上'}
                        </div>
                    </div>
                    <button type="button" onClick={() => setShowPreview(v => !v)} aria-label={showPreview ? '收起預覽' : '展開預覽'} className="p-2 rounded-full hover:bg-black/5 text-slate-500">
                        {showPreview ? <CaretUp size={18} weight="bold" /> : <CaretDown size={18} weight="bold" />}
                    </button>
                    <button type="button" onClick={() => void save()} disabled={busy || !dirty} className="rounded-full bg-violet-500 px-4 py-1.5 text-[13px] font-bold text-white disabled:opacity-40">存</button>
                </div>
            </div>

            {showPreview && (
                <div className="shrink-0 border-b border-slate-200 bg-white">
                    <DecorationPreview simTheme={simTheme} simChar={simChar} customThemes={customThemes} userAvatar={userAvatar} className="h-[38vh] min-h-[240px]" />
                    {isGroup && <div className="px-3 py-1 text-[10px] text-slate-400">群的預覽用私聊畫面示意：群只套 CSS、聲音、我的氣泡</div>}
                </div>
            )}

            <nav className="shrink-0 flex border-b border-slate-200 bg-white px-2" aria-label="裝扮分類">
                {tabs.map(t => (
                    <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}
                        className={`flex-1 py-2.5 text-[13px] border-b-2 ${tab === t ? 'border-violet-500 text-violet-700 font-bold' : 'border-transparent text-slate-500'}`}>{TAB_LABEL[t]}</button>
                ))}
            </nav>

            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 2rem)' }}>
                {tab === 'layout' && (<>
                    {!isGlobal && <FollowToggle on={!!draft.layout} label="自己的佈局" hint={draft.layout ? '關掉就跟著全局默認' : `現在${followLabel}`}
                        onChange={on => set({ layout: on ? pickDecorationLayout({ ...LAYOUT_DEFAULTS, ...Object.fromEntries(LAYOUT_KEYS.map(k => [k, (theme as unknown as Record<string, unknown>)[k]]).filter(([, v]) => v !== undefined)) }) : undefined })} />}
                    {(isGlobal || draft.layout) ? <ChatLayoutSettings theme={layoutTheme} updateTheme={changeLayout} /> : <p className="text-[12px] text-slate-400">打開上面的開關才能調；不打開就跟全局默認一樣。</p>}
                </>)}

                {tab === 'bubble' && (<>
                    {isGroup && <p className="text-[12px] text-slate-500 mb-3">群裡「我的氣泡」穿哪套；沒選是原本的紫色。</p>}
                    <div className="chat-decoration-bubbles">
                        {!isGlobal && (
                            <button type="button" aria-pressed={!draft.bubbleThemeId} onClick={() => set({ bubbleThemeId: undefined })}>
                                <span className="chat-decoration-bubble-sample" style={{ background: '#f1f5f9', color: '#64748b' }}>{isGroup ? '紫色' : '全局'}</span>
                                <span>{isGroup ? '原本的' : '跟著全局'}</span>
                            </button>
                        )}
                        {allThemes.map(item => (
                            <button key={item.id} type="button" aria-pressed={(draft.bubbleThemeId || (isGlobal ? 'default' : '')) === item.id} onClick={() => set({ bubbleThemeId: item.id })}>
                                <span className="chat-decoration-bubble-sample" style={{ background: item.user.backgroundColor, color: item.user.textColor, borderRadius: Math.min(item.user.borderRadius, 16) }}>你好呀</span>
                                <span>{item.name}</span>
                            </button>
                        ))}
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                        <button type="button" onClick={() => onOpenBubble(undefined, id => set({ bubbleThemeId: id }))} className="flex items-center gap-1 rounded-full bg-violet-50 px-3 py-1.5 text-[12px] font-bold text-violet-700"><Plus size={13} weight="bold" /> 做一套新的</button>
                        {(() => { const current = customThemes.find(t => t.id === draft.bubbleThemeId); return current ? (
                            <button type="button" onClick={() => onOpenBubble(current, id => set({ bubbleThemeId: id }))} className="flex items-center gap-1 rounded-full bg-white border border-slate-200 px-3 py-1.5 text-[12px] text-slate-600"><PencilSimple size={13} /> 編輯「{current.name}」</button>
                        ) : null; })()}
                    </div>
                    <p className="mt-3 text-[11px] text-slate-400">改氣泡主題本身，用到它的聊天都會跟著變。</p>
                </>)}

                {tab === 'background' && (<>
                    {!isGlobal && <FollowToggle on={!!draft.background} label="自己的背景" hint={draft.background ? '關掉就跟著全局默認' : `現在${followLabel}`}
                        onChange={on => set({ background: on ? { image: null, style: theme.chatBackgroundStyle || 'plain' } : undefined })} />}
                    {(isGlobal || draft.background) && (<>
                        {bgUrl ? <img className="chat-decoration-background" src={bgUrl} alt="背景圖" /> : <p className="text-[12px] text-slate-400 mb-2">沒有背景圖，用底紋。</p>}
                        <label className="chat-decoration-upload">選一張背景圖
                            <input aria-label="選擇背景圖片" type="file" accept="image/*" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void putImageBlob(f).then(ref => set({ background: { image: ref, style: draft.background?.style || 'plain' } })); }} />
                        </label>
                        {draft.background?.image && <button type="button" className="chat-decoration-link" onClick={() => set({ background: { image: null, style: draft.background?.style || 'plain' } })}>拿掉背景圖</button>}
                        <label className="chat-decoration-field">沒圖時的底紋
                            <select value={draft.background?.style || 'plain'} onChange={e => set({ background: { image: draft.background?.image ?? null, style: e.target.value as ChatBackgroundStyle } })}>
                                {(Object.keys(BG_LABEL) as ChatBackgroundStyle[]).map(v => <option key={v} value={v}>{BG_LABEL[v]}</option>)}
                            </select>
                        </label>
                    </>)}
                </>)}

                {tab === 'sound' && (<>
                    {!isGlobal && <FollowToggle on={!!draft.sound} label="自己的提示音" hint={draft.sound ? '關掉就跟著全局默認' : `現在${followLabel}`}
                        onChange={on => set({ sound: on ? { src: 'chime', volume: 0.6 } : undefined })} />}
                    {(isGlobal || draft.sound) && (
                        <WhiteboxSoundEditor sound={draft.sound || null} showBind={false}
                            onChangeSound={value => set({ sound: value ? { src: value.src, volume: value.volume ?? 0.6 } : (isGlobal ? undefined : { src: 'none' }) })}
                            hint={isGlobal ? '沒設提示音的聊天會用這裡的聲音。' : '新回覆到達時響一次。'} />
                    )}
                </>)}

                {tab === 'css' && (<>
                    {!isGlobal && <FollowToggle on={draft.css !== undefined} label="自己的 CSS" hint={draft.css !== undefined ? '關掉就跟著全局默認' : `現在${followLabel}`}
                        onChange={on => set({ css: on ? '' : undefined, cssStacksOnGlobal: on && isGroup ? true : undefined })} />}
                    {!isGlobal && !isGroup && draft.css !== undefined && (
                        <label className="flex items-center gap-2 mb-4 text-[12px] text-slate-600">
                            <input type="checkbox" className="h-4 w-4 accent-violet-500" checked={!!draft.cssStacksOnGlobal} onChange={e => set({ cssStacksOnGlobal: e.target.checked || undefined })} />
                            疊在全局 CSS 之上（不勾＝只用這份）
                        </label>
                    )}
                    {isGroup && draft.css !== undefined && <p className="text-[11px] text-slate-400 mb-3">群的 CSS 一律疊在全局 CSS 之上。</p>}
                    {(isGlobal || draft.css !== undefined) && <ChromeCssEditor value={draft.css || ''} onChange={css => set({ css })} assist={assist} />}
                    {subject.kind === 'template' && templateId && (
                        <div className="mt-3 flex items-center justify-between gap-2 rounded-2xl bg-amber-50/60 px-3 py-2">
                            <span className="text-[11px] text-amber-800">請 Sore 改這份模板（佈局、氣泡、CSS 都行），按套用才換</span>
                            <AskSoreButton location="decoration" targetId={templateId} targetName={subject.name} compact />
                        </div>
                    )}
                    {subject.kind === 'template' && !templateId && <p className="mt-3 text-[11px] text-slate-400">存好之後可以請 Sore 幫忙改這份模板。</p>}
                </>)}

                {isGroup && groupIgnoredParts(draft).length > 0 && <p className="mt-4 text-[11px] text-amber-600">群用不到：{groupIgnoredParts(draft).join('、')}</p>}
            </div>

            {confirmLeave && (
                <div className="absolute inset-0 z-30 bg-black/30 flex items-end" onClick={() => setConfirmLeave(false)}>
                    <div className="w-full rounded-t-3xl bg-white p-5 space-y-3" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 1.25rem)' }} onClick={e => e.stopPropagation()}>
                        <div className="text-[15px] font-bold">還沒存，要怎麼辦？</div>
                        <button type="button" disabled={busy} onClick={() => { setConfirmLeave(false); void save(); }} className="w-full rounded-2xl bg-violet-500 py-3 text-[14px] font-bold text-white">存起來</button>
                        <button type="button" onClick={() => { setConfirmLeave(false); onBack(); }} className="w-full rounded-2xl bg-slate-100 py-3 text-[14px] text-slate-600">不要了，直接離開</button>
                        <button type="button" onClick={() => setConfirmLeave(false)} className="w-full py-2 text-[13px] text-slate-400">繼續改</button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DecorationEditor;
