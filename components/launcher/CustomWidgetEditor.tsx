import React, { useEffect, useRef, useState } from 'react';
import type { CharacterProfile } from '../../types';
import { INSTALLED_APPS } from '../../constants';
import TokenImg from '../os/TokenImg';
import { processImageToBlob } from '../../utils/file';
import { putImageBlob } from '../../utils/blobRef';
import {
    BUILTIN_PLACEHOLDERS, CUSTOM_WIDGET_SIZES, isReservedKey, isValidKey, makeTemplateId, starterTemplate,
    type CustomFieldType, type CustomWidgetField, type CustomWidgetTemplate,
} from '../../utils/customWidget';
import { sizeLabel, type WidgetSize } from '../../utils/launcherLayout';
import CustomWidgetFrame from './CustomWidgetFrame';

/**
 * 自訂小組件編輯器：名字、尺寸、HTML、CSS、圖片素材、可填寫欄位，上面一直有預覽。
 * 存的是「模板」；放上桌面的每一份自己填欄位、換圖、綁角色（在桌面上點那一份）。
 */

type Tab = 'html' | 'css' | 'images' | 'fields' | 'help';

const FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
    text: '一行字', textarea: '多行字', color: '顏色', select: '選項', number: '數字', date: '日期',
};

const GAP_X = 8;   // 跟桌面網格的 columnGap / rowGap 一樣（0.5rem / 0.75rem）
const GAP_Y = 12;

/** 照桌面一格的大小算這個尺寸實際多大 */
export const pixelSize = (size: WidgetSize, cell: { w: number; h: number }) => ({
    width: cell.w * size.w + GAP_X * (size.w - 1),
    height: cell.h * size.h + GAP_Y * (size.h - 1),
});

const checkTemplate = (t: CustomWidgetTemplate): string | null => {
    if (!t.name.trim()) return '取個名字吧';
    if (!t.html.trim()) return 'HTML 還是空的';
    const keys = new Set<string>();
    for (const key of [...t.imageKeys, ...t.fields.map(f => f.key)]) {
        if (!isValidKey(key)) return `「${key || '（空白）'}」不能當鍵：1～40 字，不要空白和大括號`;
        if (isReservedKey(key)) return `「${key}」是內建的佔位符，換一個鍵`;
        if (keys.has(key)) return `鍵「${key}」重複了（圖片和欄位的鍵也不能一樣）`;
        keys.add(key);
    }
    for (const f of t.fields) if (f.type === 'select' && !f.options?.length) return `欄位「${f.label || f.key}」是選項，至少要一個選項`;
    return null;
};

const CustomWidgetEditor: React.FC<{
    initial: CustomWidgetTemplate | null;
    cell: { w: number; h: number };
    previewChar?: CharacterProfile | null;
    userName?: string;
    contentColor?: string;
    onSave: (template: CustomWidgetTemplate) => void;
    onClose: () => void;
    onExport?: (template: CustomWidgetTemplate) => void;
    notify: (message: string, type?: 'info' | 'error' | 'success') => void;
}> = ({ initial, cell, previewChar, userName, contentColor, onSave, onClose, onExport, notify }) => {
    const [draft, setDraft] = useState<CustomWidgetTemplate>(() => initial ? { ...initial } : {
        ...starterTemplate(), id: makeTemplateId(), createdAt: Date.now(), updatedAt: Date.now(),
    });
    const [preview, setPreview] = useState(draft);
    const [tab, setTab] = useState<Tab>('html');
    const [newImageKey, setNewImageKey] = useState('');
    const uploadKey = useRef<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const previewBox = useRef<HTMLDivElement>(null);
    const [boxWidth, setBoxWidth] = useState(320);

    // 打字時預覽晚一點跟上，不然每個字都重載一次 iframe
    useEffect(() => {
        const timer = setTimeout(() => setPreview(draft), 450);
        return () => clearTimeout(timer);
    }, [draft]);

    useEffect(() => {
        const el = previewBox.current;
        if (!el) return;
        const update = () => setBoxWidth(el.clientWidth);
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const patch = (next: Partial<CustomWidgetTemplate>) => setDraft(d => ({ ...d, ...next }));
    const patchField = (index: number, next: Partial<CustomWidgetField>) =>
        setDraft(d => ({ ...d, fields: d.fields.map((f, i) => (i === index ? { ...f, ...next } : f)) }));

    const real = pixelSize(draft, cell);
    const scale = Math.min(1, (boxWidth - 8) / real.width, 220 / real.height);

    const save = () => {
        const cleaned: CustomWidgetTemplate = {
            ...draft,
            name: draft.name.trim(),
            fields: draft.fields.map(f => ({
                ...f,
                key: f.key.trim(),
                label: f.label.trim() || f.key.trim(),
                ...(f.type === 'select' ? { options: (f.options || []).filter(o => o !== '') } : { options: undefined }),
            })),
            updatedAt: Date.now(),
        };
        const problem = checkTemplate(cleaned);
        if (problem) { notify(problem, 'error'); return; }
        onSave(cleaned);
    };

    const addImageKey = () => {
        const key = newImageKey.trim();
        if (!isValidKey(key) || isReservedKey(key)) { notify('這個鍵不能用：1～40 字、不要空白和大括號，也別用內建的佔位符', 'error'); return; }
        if (draft.imageKeys.includes(key) || draft.fields.some(f => f.key === key)) { notify(`鍵「${key}」已經有了`, 'error'); return; }
        patch({ imageKeys: [...draft.imageKeys, key] });
        setNewImageKey('');
    };

    const pickImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        const key = uploadKey.current;
        if (!file || !key) return;
        try {
            const blob = await processImageToBlob(file, { maxWidth: 1000 });
            const ref = await putImageBlob(blob);
            setDraft(d => ({ ...d, images: { ...d.images, [key]: ref } }));
        } catch (error: any) {
            notify(error?.message || '圖片沒存成', 'error');
        }
    };

    const input = 'w-full rounded-lg border border-[#3f362c]/15 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-[#4b4136]/50';
    const code = 'block w-full min-h-[16rem] flex-1 resize-none rounded-xl border border-[#3f362c]/15 bg-white p-3 font-mono text-[11.5px] leading-relaxed outline-none focus:border-[#4b4136]/50';

    return (
        <div className="absolute inset-0 z-[70] flex flex-col bg-[#fffdf8] text-[#3f362c]" data-launcher-control role="dialog" aria-label="編輯自訂小組件">
            <div className="flex shrink-0 items-center gap-2 border-b border-[#3f362c]/10 px-3 pb-2" style={{ paddingTop: 'max(0.75rem, var(--safe-top))' }}>
                <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-[12px] font-bold text-[#3f362c]/60 active:bg-[#3f362c]/5">取消</button>
                <input value={draft.name} onChange={e => patch({ name: e.target.value.slice(0, 60) })} placeholder="小組件名字" aria-label="小組件名字"
                    className="min-w-0 flex-1 rounded-lg bg-transparent px-1 text-center text-[15px] font-bold outline-none focus:bg-white" />
                {onExport && initial && (
                    <button type="button" onClick={() => onExport(draft)} className="rounded-full px-2.5 py-1.5 text-[12px] font-bold text-[#3f362c]/60 active:bg-[#3f362c]/5">匯出</button>
                )}
                <button type="button" onClick={save} className="rounded-full bg-[#4b4136] px-3.5 py-1.5 text-[12px] font-bold text-white active:scale-95">儲存</button>
            </div>

            <div className="shrink-0 border-b border-[#3f362c]/10 px-4 pb-3 pt-3">
                <div ref={previewBox} className="grid place-items-center rounded-2xl" style={{ height: 228, background: 'linear-gradient(135deg,#8a9bb0,#c3a6a0 55%,#e6d3b8)' }}>
                    {/* 虛線框是這個尺寸在桌面上佔的範圍 */}
                    <div style={{ width: real.width * scale, height: real.height * scale, outline: '1px dashed rgba(255,255,255,0.75)', outlineOffset: 2, borderRadius: 6 }}>
                        <div style={{ width: real.width, height: real.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                            <CustomWidgetFrame template={preview} size={draft} char={previewChar} userName={userName} contentColor={contentColor} interactive={false} />
                        </div>
                    </div>
                </div>
                <div className="mt-2.5 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                    <span className="shrink-0 text-[10px] font-bold text-[#3f362c]/50">預設尺寸</span>
                    {CUSTOM_WIDGET_SIZES.map(size => {
                        const current = size.w === draft.w && size.h === draft.h;
                        return (
                            <button key={sizeLabel(size)} type="button" onClick={() => patch(size)}
                                className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-bold tabular-nums ${current ? 'border-[#4b4136] bg-[#4b4136] text-white' : 'border-[#3f362c]/15 bg-white'}`}>
                                {sizeLabel(size)}
                            </button>
                        );
                    })}
                </div>
            </div>

            <div role="tablist" className="flex shrink-0 gap-1 px-3 pt-2">
                {([['html', 'HTML'], ['css', 'CSS'], ['images', `圖片${draft.imageKeys.length ? ` ${draft.imageKeys.length}` : ''}`], ['fields', `欄位${draft.fields.length ? ` ${draft.fields.length}` : ''}`], ['help', '佔位符']] as const).map(([value, label]) => (
                    <button key={value} role="tab" aria-selected={tab === value} type="button" onClick={() => setTab(value)}
                        className={`rounded-full px-3 py-1 text-[11px] font-bold ${tab === value ? 'bg-[#4b4136] text-white' : 'text-[#3f362c]/55'}`}>
                        {label}
                    </button>
                ))}
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6 pt-3" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 1.5rem)' }}>
                {tab === 'html' && (
                    <textarea value={draft.html} onChange={e => patch({ html: e.target.value })} className={code}
                        spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="HTML" placeholder={'<div class="card">{{time}}</div>'} />
                )}
                {tab === 'css' && (
                    <textarea value={draft.css} onChange={e => patch({ css: e.target.value })} className={code}
                        spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="CSS" placeholder=".card { height: 100%; }" />
                )}

                {tab === 'images' && (
                    <div className="space-y-2.5">
                        <p className="text-[11px] leading-relaxed text-[#3f362c]/55">每張圖一個鍵，HTML／CSS 裡寫 <code className="font-mono">{'{{鍵}}'}</code> 就是這張圖的網址。這裡選的是模板自帶的圖；放上桌面後，每一份還能換成自己的。</p>
                        {draft.imageKeys.map(key => (
                            <div key={key} className="flex items-center gap-3 rounded-xl bg-[#3f362c]/[0.04] p-2.5">
                                <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-white text-[10px] text-[#3f362c]/35"
                                    style={{ backgroundImage: 'repeating-conic-gradient(#eee 0 25%, #fff 0 50%)', backgroundSize: '12px 12px' }}>
                                    {draft.images[key] ? <TokenImg value={draft.images[key]} className="h-full w-full object-contain" alt="" /> : '空'}
                                </div>
                                <code className="min-w-0 flex-1 truncate font-mono text-[12px] font-bold">{`{{${key}}}`}</code>
                                <button type="button" onClick={() => { uploadKey.current = key; fileRef.current?.click(); }} className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold shadow-sm">{draft.images[key] ? '換' : '選圖'}</button>
                                <button type="button" aria-label={`刪掉 ${key}`} onClick={() => {
                                    const { [key]: _removed, ...rest } = draft.images;
                                    patch({ imageKeys: draft.imageKeys.filter(k => k !== key), images: rest });
                                }} className="rounded-full px-2 py-1 text-[13px] font-bold text-red-400">×</button>
                            </div>
                        ))}
                        <div className="flex gap-2">
                            <input value={newImageKey} onChange={e => setNewImageKey(e.target.value)} placeholder="新的圖片鍵，例如 img1" className={input}
                                onKeyDown={e => { if (e.key === 'Enter') addImageKey(); }} autoCapitalize="off" />
                            <button type="button" onClick={addImageKey} className="shrink-0 rounded-lg bg-[#4b4136] px-3 text-[12px] font-bold text-white">加一張</button>
                        </div>
                        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickImage} />
                    </div>
                )}

                {tab === 'fields' && (
                    <div className="space-y-2.5">
                        <p className="text-[11px] leading-relaxed text-[#3f362c]/55">放上桌面後，點那一份小組件就能填這些。HTML／CSS 裡寫 <code className="font-mono">{'{{鍵}}'}</code>，程式裡用 <code className="font-mono">await widget.getState('鍵')</code>。</p>
                        {draft.fields.map((field, index) => (
                            <div key={index} className="space-y-1.5 rounded-xl bg-[#3f362c]/[0.04] p-2.5">
                                <div className="flex gap-1.5">
                                    <input value={field.key} onChange={e => patchField(index, { key: e.target.value })} placeholder="鍵" aria-label="鍵" className={`${input} font-mono`} autoCapitalize="off" />
                                    <input value={field.label} onChange={e => patchField(index, { label: e.target.value.slice(0, 60) })} placeholder="顯示的名字" aria-label="顯示的名字" className={input} />
                                    <button type="button" aria-label="刪掉這個欄位" onClick={() => patch({ fields: draft.fields.filter((_, i) => i !== index) })} className="shrink-0 px-1.5 text-[14px] font-bold text-red-400">×</button>
                                </div>
                                <div className="flex gap-1.5">
                                    <select value={field.type} onChange={e => patchField(index, { type: e.target.value as CustomFieldType })} aria-label="類型" className={`${input} w-24 shrink-0`}>
                                        {(Object.keys(FIELD_TYPE_LABELS) as CustomFieldType[]).map(t => <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>)}
                                    </select>
                                    {field.type === 'color' ? (
                                        <div className="flex flex-1 items-center gap-1.5">
                                            <input type="color" value={/^#[0-9a-f]{6}$/i.test(field.default || '') ? field.default : '#ffffff'} onChange={e => patchField(index, { default: e.target.value })} aria-label="預設顏色" className="h-8 w-10 shrink-0 rounded border-0 bg-transparent" />
                                            <input value={field.default || ''} onChange={e => patchField(index, { default: e.target.value })} placeholder="預設值（可留空）" className={input} />
                                        </div>
                                    ) : (
                                        <input type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'} value={field.default || ''} onChange={e => patchField(index, { default: e.target.value })} placeholder="預設值（可留空）" aria-label="預設值" className={input} />
                                    )}
                                </div>
                                {field.type === 'select' && (
                                    <textarea value={(field.options || []).join('\n')} onChange={e => patchField(index, { options: e.target.value.split('\n') })}
                                        placeholder="選項，一行一個" aria-label="選項" rows={3} className={`${input} font-mono`} />
                                )}
                            </div>
                        ))}
                        <button type="button" onClick={() => patch({ fields: [...draft.fields, { key: `field${draft.fields.length + 1}`, label: '', type: 'text' }] })}
                            className="w-full rounded-xl border border-dashed border-[#3f362c]/25 py-2.5 text-[12px] font-bold text-[#3f362c]/60">＋ 加一個欄位</button>
                    </div>
                )}

                {tab === 'help' && (
                    <div className="space-y-3 text-[12px] leading-relaxed">
                        <div className="rounded-xl bg-[#3f362c]/[0.04] p-3">
                            {BUILTIN_PLACEHOLDERS.map(p => (
                                <div key={p.key} className="flex gap-2 py-0.5">
                                    <code className="w-40 shrink-0 font-mono text-[11px] font-bold">{`{{${p.key}}}`}</code>
                                    <span className="text-[#3f362c]/65">{p.label}</span>
                                </div>
                            ))}
                            <div className="flex gap-2 py-0.5">
                                <code className="w-40 shrink-0 font-mono text-[11px] font-bold">{'{{鍵}}'}</code>
                                <span className="text-[#3f362c]/65">欄位填的值、圖片的網址</span>
                            </div>
                        </div>
                        <p className="text-[#3f362c]/65">角色資料跟著放上桌面那一份綁的角色；沒綁就是目前的角色。HTML 文字裡的 <code className="font-mono">{'{{time}}'}</code> 會自己走，其他地方是放上去那一刻的值。</p>
                        <p className="text-[#3f362c]/65">可以寫 <code className="font-mono">{'<script>'}</code>，小組件關在沙盒裡跑，讀不到 Soren 的資料。程式裡能用：</p>
                        <pre className="overflow-x-auto rounded-xl bg-[#3f362c]/[0.06] p-3 font-mono text-[11px]">{`await widget.getState('鍵')   // 欄位值，沒填是 null
await widget.setState('鍵', 值) // 記住（點過之後才存）
await widget.getAll()         // 全部
widget.open('chat')           // 打開綁定角色的聊天
widget.size                   // { w, h } 幾格`}</pre>
                        <p className="text-[#3f362c]/65">點一下會傳進小組件（元素收得到 click）。在元素上加 <code className="font-mono">data-open="chat"</code>，點了就打開跟角色的聊天；也可以填 App 的代號：</p>
                        <div className="flex flex-wrap gap-1">
                            {INSTALLED_APPS.map(app => (
                                <span key={app.id} className="rounded-md bg-[#3f362c]/[0.05] px-1.5 py-0.5 text-[10px]"><code className="font-mono font-bold">{app.id}</code> {app.name}</span>
                            ))}
                        </div>
                        <p className="text-[#3f362c]/45">只認「點一下」：拖曳、輸入框、捲動在小組件裡不會動，桌面照常滑頁和長按整理。</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CustomWidgetEditor;
