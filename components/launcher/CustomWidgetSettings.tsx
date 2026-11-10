import React, { useEffect, useRef, useState } from 'react';
import type { CharacterProfile } from '../../types';
import TokenImg from '../os/TokenImg';
import { processImageToBlob } from '../../utils/file';
import { putImageBlob } from '../../utils/blobRef';
import { CUSTOM_WIDGET_SIZES, type CustomWidgetField, type CustomWidgetTemplate } from '../../utils/customWidget';
import { sizeLabel, type LauncherWidgetItem, type WidgetSize } from '../../utils/launcherLayout';

/**
 * 整理中點一下自訂小組件：這一份的尺寸、綁哪個角色、欄位、換圖。
 * 欄位跟圖都只改這一份，模板（還有桌面上其他份）不受影響；改模板走「編輯模板」。
 */

type Patch = Partial<Pick<LauncherWidgetItem, 'values' | 'images' | 'charId'>>;

/** 打字的欄位：先存在這裡，停一下（或離開輸入框）才寫回去，不然每個字都重載一次小組件 */
const TextValue: React.FC<{ field: CustomWidgetField; value: string; multiline?: boolean; onCommit: (value: string) => void }> = ({ field, value, multiline, onCommit }) => {
    const [text, setText] = useState(value);
    const commitRef = useRef(onCommit);
    commitRef.current = onCommit;
    useEffect(() => { setText(value); }, [value]);
    useEffect(() => {
        if (text === value) return;
        const timer = setTimeout(() => commitRef.current(text), 700);
        return () => clearTimeout(timer);
    }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
    const cls = 'w-full rounded-lg border border-[#3f362c]/15 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-[#4b4136]/50';
    const common = {
        value: text,
        placeholder: field.default ? `沒填就是「${field.default}」` : '',
        'aria-label': field.label,
        onBlur: () => { if (text !== value) onCommit(text); },
        className: cls,
    };
    return multiline
        ? <textarea {...common} rows={3} onChange={e => setText(e.target.value.slice(0, 2000))} />
        : <input {...common} type={field.type === 'number' ? 'number' : 'text'} onChange={e => setText(e.target.value.slice(0, 2000))} />;
};

const CustomWidgetSettings: React.FC<{
    item: LauncherWidgetItem;
    template: CustomWidgetTemplate;
    characters: CharacterProfile[];
    onResize: (size: WidgetSize) => void;
    onPatch: (patch: Patch) => void;
    onEditTemplate: () => void;
    onRemove: () => void;
    onClose: () => void;
    notify: (message: string, type?: 'info' | 'error' | 'success') => void;
}> = ({ item, template, characters, onResize, onPatch, onEditTemplate, onRemove, onClose, notify }) => {
    const fileRef = useRef<HTMLInputElement>(null);
    const uploadKey = useRef<string | null>(null);
    const values = item.values || {};
    const images = item.images || {};

    const setValue = (key: string, value: string) => {
        const next = { ...values };
        if (value === '') delete next[key]; else next[key] = value;
        onPatch({ values: next });
    };
    const setImage = (key: string, ref: string | null) => {
        const next = { ...images };
        if (ref) next[key] = ref; else delete next[key];
        onPatch({ images: next });
    };
    const pickImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        const key = uploadKey.current;
        if (!file || !key) return;
        try {
            const blob = await processImageToBlob(file, { maxWidth: 1000 });
            setImage(key, await putImageBlob(blob));
        } catch (error: any) {
            notify(error?.message || '圖片沒存成', 'error');
        }
    };

    const label = 'text-[11px] font-bold text-[#3f362c]/55';
    const control = 'w-full rounded-lg border border-[#3f362c]/15 bg-white px-2.5 py-1.5 text-[12px] outline-none';

    return (
        <div className="absolute inset-0 z-[60] flex items-end bg-black/30" data-launcher-control onClick={onClose}>
            <div className="w-full max-h-[80%] overflow-y-auto rounded-t-3xl bg-[#fffdf8] px-5 pt-4 text-[#3f362c]" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 1.25rem)' }} onClick={e => e.stopPropagation()}>
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[#3f362c]/15" />
                <div className="flex items-center justify-between gap-2">
                    <h3 className="min-w-0 truncate text-[15px] font-bold">{template.name}</h3>
                    <button type="button" onClick={onEditTemplate} className="shrink-0 rounded-full bg-[#3f362c]/[0.06] px-3 py-1 text-[11px] font-bold active:scale-95">編輯模板</button>
                </div>

                <div className="mt-3">
                    <div className={label}>尺寸（寬×高）</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {CUSTOM_WIDGET_SIZES.map(size => {
                            const current = size.w === item.w && size.h === item.h;
                            return (
                                <button key={sizeLabel(size)} type="button" onClick={() => onResize(size)}
                                    className={`rounded-full border px-3 py-1 text-[11px] font-bold tabular-nums active:scale-95 ${current ? 'border-[#4b4136] bg-[#4b4136] text-white' : 'border-[#3f362c]/15 bg-white'}`}>
                                    {sizeLabel(size)}
                                </button>
                            );
                        })}
                    </div>
                </div>

                <label className="mt-4 block">
                    <span className={label}>綁定角色</span>
                    <select value={item.charId && characters.some(c => c.id === item.charId) ? item.charId : ''} onChange={e => onPatch({ charId: e.target.value || undefined })} className={`${control} mt-1.5`}>
                        <option value="">跟著目前的角色</option>
                        {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                </label>

                {template.fields.length > 0 && (
                    <div className="mt-4 space-y-2.5">
                        <div className={label}>欄位（只改這一份）</div>
                        {template.fields.map(field => {
                            const value = values[field.key] ?? '';
                            return (
                                <div key={field.key} className="rounded-xl bg-[#3f362c]/[0.04] px-3 py-2.5">
                                    <div className="mb-1.5 text-[12px] font-bold">{field.label}</div>
                                    {field.type === 'select' ? (
                                        <select value={value} onChange={e => setValue(field.key, e.target.value)} aria-label={field.label} className={control}>
                                            <option value="">{field.default ? `預設（${field.default}）` : '預設'}</option>
                                            {(field.options || []).map(option => <option key={option} value={option}>{option}</option>)}
                                        </select>
                                    ) : field.type === 'color' ? (
                                        <div className="flex items-center gap-2">
                                            <input type="color" value={/^#[0-9a-f]{6}$/i.test(value || field.default || '') ? (value || field.default) : '#ffffff'}
                                                onChange={e => setValue(field.key, e.target.value)} aria-label={field.label} className="h-8 w-10 shrink-0 rounded border-0 bg-transparent" />
                                            <span className="flex-1 font-mono text-[11px] text-[#3f362c]/60">{value || (field.default ? `預設 ${field.default}` : '還沒選')}</span>
                                            {value && <button type="button" onClick={() => setValue(field.key, '')} className="text-[11px] font-bold text-[#3f362c]/50">用預設</button>}
                                        </div>
                                    ) : (
                                        <TextValue field={field} value={value} multiline={field.type === 'textarea'} onCommit={v => setValue(field.key, v)} />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                {template.imageKeys.length > 0 && (
                    <div className="mt-4 space-y-2">
                        <div className={label}>圖片（只換這一份）</div>
                        {template.imageKeys.map(key => {
                            const own = images[key];
                            const shown = own || template.images[key];
                            return (
                                <div key={key} className="flex items-center gap-3 rounded-xl bg-[#3f362c]/[0.04] p-2.5">
                                    <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-white text-[10px] text-[#3f362c]/35">
                                        {shown ? <TokenImg value={shown} className="h-full w-full object-cover" alt="" /> : '空'}
                                    </div>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate font-mono text-[12px] font-bold">{key}</span>
                                        <span className="block text-[10px] text-[#3f362c]/45">{own ? '這一份自己的圖' : shown ? '模板的圖' : '還沒有圖'}</span>
                                    </span>
                                    <button type="button" onClick={() => { uploadKey.current = key; fileRef.current?.click(); }} className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold shadow-sm">{shown ? '換' : '選圖'}</button>
                                    {own && <button type="button" onClick={() => setImage(key, null)} className="text-[11px] font-bold text-[#3f362c]/50">用模板的</button>}
                                </div>
                            );
                        })}
                        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickImage} />
                    </div>
                )}

                <div className="mt-4 grid grid-cols-2 gap-2">
                    <button type="button" onClick={onRemove} className="rounded-xl bg-red-50 py-2.5 text-[13px] font-bold text-red-500 active:scale-[0.98]">從桌面移除</button>
                    <button type="button" onClick={onClose} className="rounded-xl bg-[#4b4136] py-2.5 text-[13px] font-bold text-white active:scale-[0.98]">好了</button>
                </div>
            </div>
        </div>
    );
};

export default CustomWidgetSettings;
