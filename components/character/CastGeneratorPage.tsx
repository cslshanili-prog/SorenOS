import React, { useMemo, useState } from 'react';
import ImageStylePicker, { EMPTY_PICK, pickOptions, type ImageStylePick } from '../image/ImageStylePicker';
import { createPortal } from 'react-dom';
import { ArrowsClockwise, CaretLeft, Sparkle } from '@phosphor-icons/react';
import type { CharacterProfile } from '../../types';
import { useOS } from '../../context/OSContext';
import TokenImg from '../os/TokenImg';
import { isSupporting } from '../../utils/castRole';
import { resolveUserProfileForChar } from '../../utils/userPersona';
import { buildCastCharacters, castAvatarPrompt, CAST_GEN_MAX, CAST_GEN_MIN, type CastDraft } from '../../utils/castGenerate';
import { requestCastDrafts } from '../../utils/castGenerateRun';
import { canGenerateFor } from '../../utils/imageStyle';
import { generateImage } from '../../utils/imageGeneration';
import { migrateDataUrlToRef } from '../../utils/blobRef';
import { trackEvent } from '../../utils/analytics';

const defaultAvatar = (seed: string) => {
    const colors = ['FF9AA2', 'FFB7B2', 'FFDAC1', 'E2F0CB', 'B5EAD7', 'C7CEEA', 'e2e8f0', 'fcd34d', 'fca5a5'];
    const color = colors[seed.charCodeAt(0) % colors.length];
    const letter = seed.charAt(0).toUpperCase();
    return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%23${color}"/><text x="50" y="55" font-family="sans-serif" font-weight="bold" font-size="50" text-anchor="middle" dy=".3em" fill="white" opacity="0.9">${letter}</text></svg>`;
};

type DraftRow = CastDraft & { key: string; checked: boolean; busy?: boolean };

const rowOf = (d: CastDraft, i: number): DraftRow => ({ ...d, key: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`, checked: true });

/**
 * AI 批量生成配角（plans/persona-line-batch6.md 第 6 節）：選主角 → 幾個、方向、勾選 → 生成 → 先看再存。
 */
const CastGeneratorPage: React.FC<{ initialLeadId?: string; onClose: () => void; onCreated: (count: number) => void }> = ({ initialLeadId, onClose, onCreated }) => {
    const { characters, apiConfig, userProfileBase, addCharacters, updateCharacter, addToast } = useOS();
    const leads = useMemo(() => characters.filter(c => !isSupporting(c)), [characters]);
    const [leadId, setLeadId] = useState(initialLeadId && leads.some(c => c.id === initialLeadId) ? initialLeadId : leads[0]?.id || '');
    const [count, setCount] = useState(3);
    const [direction, setDirection] = useState('');
    const [includeUser, setIncludeUser] = useState(false);
    const [wantAvatar, setWantAvatar] = useState(false);
    const [stylePick, setStylePick] = useState<ImageStylePick>(EMPTY_PICK);
    const [rows, setRows] = useState<DraftRow[]>([]);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState('');

    const lead = characters.find(c => c.id === leadId) || null;
    const worldChars = useMemo(() => (lead ? characters.filter(c => c.id !== lead.id && (lead.groupId ? c.groupId === lead.groupId : !c.groupId)) : []), [characters, lead]);
    const userName = lead ? resolveUserProfileForChar(userProfileBase, lead).name || '你' : '你';
    const imageReady = canGenerateFor(apiConfig.imageGenConfig, 'avatar');

    const generate = async () => {
        if (!lead || busy) return;
        setBusy(true);
        try {
            const drafts = await requestCastDrafts({ lead, worldChars, count, direction, includeUser, userName, apiConfig });
            setRows(drafts.slice(0, CAST_GEN_MAX).map(rowOf));
        } catch (e: any) {
            addToast(e?.message || '生成失敗', 'error');
        } finally {
            setBusy(false);
        }
    };

    const regenerateOne = async (key: string) => {
        if (!lead) return;
        const target = rows.find(r => r.key === key);
        if (!target) return;
        setRows(prev => prev.map(r => (r.key === key ? { ...r, busy: true } : r)));
        try {
            const [d] = await requestCastDrafts({
                lead, worldChars, count: 1, includeUser, userName, apiConfig,
                direction: `${direction.trim() ? `${direction.trim()}\n` : ''}換一個人，不要跟「${target.name}」重複，也不要跟這一批的其他人重複。`,
                avoidNames: rows.map(r => r.name),
            });
            setRows(prev => prev.map(r => (r.key === key ? { ...d, key, checked: true } : r)));
        } catch (e: any) {
            addToast(e?.message || '重生失敗', 'error');
            setRows(prev => prev.map(r => (r.key === key ? { ...r, busy: false } : r)));
        }
    };

    const patchRow = (key: string, patch: Partial<DraftRow>) => setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)));

    const create = async () => {
        if (!lead || busy) return;
        const picked = rows.filter(r => r.checked && r.name.trim());
        if (!picked.length) { addToast('至少勾一個', 'info'); return; }
        setBusy(true);
        let avatarFailed = 0;
        try {
            const withAvatars: Array<CastDraft & { avatar?: string }> = [];
            for (let i = 0; i < picked.length; i++) {
                const r = picked[i];
                let avatar: string | undefined;
                if (wantAvatar && imageReady) {
                    setProgress(`正在畫 ${r.name} 的頭像（${i + 1}/${picked.length}）…`);
                    try {
                        // 畫風照主角那邊（角色 > 世界 > 頭像那格 > 全域）；「這次的風格」有寫就再加在後面
                        const { dataUrl } = await generateImage(apiConfig.imageGenConfig!, castAvatarPrompt(r), undefined, { feature: 'avatar', char: lead, hasPerson: true, ...pickOptions(stylePick) });
                        avatar = await migrateDataUrlToRef(dataUrl);
                    } catch (e) {
                        avatarFailed++;
                        console.warn(`[生成配角] ${r.name} 的頭像沒畫成`, e);
                    }
                }
                withAvatars.push({ name: r.name, brief: r.brief, persona: r.persona, appearance: r.appearance, relations: r.relations, avatar });
            }
            setProgress('正在建立…');
            const { chars, contactsForExisting } = buildCastCharacters({
                drafts: withAvatars, lead, existing: characters, userName, includeUser, defaultAvatar,
            });
            await addCharacters(chars);
            for (const [charId, contacts] of Object.entries(contactsForExisting)) {
                updateCharacter(charId, prev => ({
                    phoneState: { ...prev.phoneState, records: prev.phoneState?.records || [], contacts: [...(prev.phoneState?.contacts || []), ...contacts] },
                }));
            }
            trackEvent('AI 生成配角', { 数量: chars.length === 1 ? '1' : chars.length <= 3 ? '2-3' : '4-5', 头像: wantAvatar && imageReady ? '有' : '无' });
            if (avatarFailed) addToast(`${avatarFailed} 張頭像沒畫成，先用預設的，之後可以在編輯頁換`, 'info');
            onCreated(chars.length);
        } catch (e: any) {
            addToast(e?.message || '建立失敗', 'error');
        } finally {
            setBusy(false);
            setProgress('');
        }
    };

    const field = 'w-full bg-white border border-slate-200 focus:border-violet-300 rounded-xl px-3 py-2 text-sm text-slate-700 outline-none placeholder:text-slate-300';

    return createPortal(
        <div className="fixed inset-0 z-[110] flex flex-col bg-slate-50 animate-fade-in">
            <div className="flex items-center gap-2 px-3 bg-white border-b border-slate-100 shrink-0" style={{ paddingTop: 'calc(0.6rem + var(--safe-top))', paddingBottom: '0.6rem' }}>
                <button onClick={() => (rows.length && !busy ? setRows([]) : onClose())} aria-label="返回" className="w-9 h-9 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-100">
                    <CaretLeft size={20} weight="bold" />
                </button>
                <div className="text-sm font-bold text-slate-800">AI 生成配角</div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4" style={{ paddingBottom: 'calc(6rem + var(--safe-bottom))' }}>
                {!rows.length ? (
                    <>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">為哪位主角生成</label>
                            {leads.length === 0 ? <p className="text-xs text-slate-400">還沒有主角</p> : (
                                <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
                                    {leads.map(c => (
                                        <button key={c.id} onClick={() => setLeadId(c.id)} aria-pressed={c.id === leadId}
                                            className={`shrink-0 flex flex-col items-center gap-1 w-16 py-2 rounded-2xl border ${c.id === leadId ? 'border-violet-400 bg-violet-50' : 'border-transparent'}`}>
                                            <TokenImg value={c.avatar} className="w-11 h-11 rounded-full object-cover bg-slate-100" alt="" />
                                            <span className="text-[11px] font-bold text-slate-600 truncate max-w-full px-1">{c.name}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                            {lead && <p className="text-[10px] text-slate-400 mt-1">會讀「{lead.name}」的人設、世界觀、常駐世界書，還有同一個世界裡的 {worldChars.length} 個人。</p>}
                        </div>

                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">一次幾個</label>
                            <div className="flex gap-2">
                                {Array.from({ length: CAST_GEN_MAX - CAST_GEN_MIN + 1 }, (_, i) => i + CAST_GEN_MIN).map(n => (
                                    <button key={n} onClick={() => setCount(n)} aria-pressed={n === count}
                                        className={`w-10 h-10 rounded-xl text-sm font-bold ${n === count ? 'bg-violet-500 text-white' : 'bg-white text-slate-500 border border-slate-200'}`}>{n}</button>
                                ))}
                            </div>
                        </div>

                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">方向（可以留空）</label>
                            <textarea value={direction} onChange={e => setDirection(e.target.value.slice(0, 300))} rows={3} className={`${field} resize-none`}
                                placeholder="例如：他的聯姻對象和她的閨蜜；公司裡會跟他作對的人。留空就照人設挑劇情上最用得到的人。" />
                        </div>

                        <label className="flex items-start gap-3 bg-white rounded-2xl border border-slate-100 px-4 py-3">
                            <input type="checkbox" checked={includeUser} onChange={e => setIncludeUser(e.target.checked)} className="mt-0.5 accent-violet-500" />
                            <span className="text-xs text-slate-600 leading-relaxed">也可以跟你有關係<span className="block text-[10px] text-slate-400">例如舊識、前任、對手。跟你的是「{userName}」（{lead?.name || '主角'}的主線那張卡）。</span></span>
                        </label>

                        <label className={`flex items-start gap-3 bg-white rounded-2xl border border-slate-100 px-4 py-3 ${imageReady ? '' : 'opacity-60'}`}>
                            <input type="checkbox" checked={wantAvatar && imageReady} disabled={!imageReady} onChange={e => setWantAvatar(e.target.checked)} className="mt-0.5 accent-violet-500" />
                            <span className="text-xs text-slate-600 leading-relaxed flex-1">順便畫頭像
                                <span className="block text-[10px] text-slate-400">{imageReady ? '照每個人的外觀一張張畫；畫風照主角那邊（角色、世界、各處畫風的頭像那格），也可以這次換一套。' : '要先在設置裡配好生圖 API。'}</span>
                                {wantAvatar && imageReady && (
                                    <ImageStylePicker config={apiConfig.imageGenConfig} feature="avatar" char={lead} value={stylePick} onChange={setStylePick} className="mt-2" />
                                )}
                            </span>
                        </label>
                    </>
                ) : (
                    <>
                        <p className="text-[11px] text-slate-400">先看看，可以改、單張重生、取消勾選，按「建立」才會存成配角。</p>
                        {rows.map(r => (
                            <div key={r.key} className={`rounded-2xl bg-white border px-4 py-3 space-y-2 ${r.checked ? 'border-violet-200' : 'border-slate-100 opacity-60'}`}>
                                <div className="flex items-center gap-2">
                                    <input type="checkbox" checked={r.checked} onChange={e => patchRow(r.key, { checked: e.target.checked })} aria-label={`建立 ${r.name}`} className="accent-violet-500" />
                                    <input value={r.name} onChange={e => patchRow(r.key, { name: e.target.value.slice(0, 20) })} className="flex-1 min-w-0 text-base font-bold text-slate-800 bg-transparent outline-none" />
                                    <button onClick={() => regenerateOne(r.key)} disabled={r.busy} title="單張重生" aria-label={`重生 ${r.name}`}
                                        className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 disabled:animate-spin">
                                        <ArrowsClockwise size={16} />
                                    </button>
                                </div>
                                <input value={r.brief} onChange={e => patchRow(r.key, { brief: e.target.value.slice(0, 80) })} className={`${field} text-xs`} placeholder="一句話" />
                                <textarea value={r.persona} onChange={e => patchRow(r.key, { persona: e.target.value.slice(0, 3000) })} rows={5} className={`${field} text-xs resize-none leading-relaxed`} placeholder="人設" />
                                <input value={r.appearance} onChange={e => patchRow(r.key, { appearance: e.target.value.slice(0, 300) })} className={`${field} text-xs`} placeholder="外觀（畫頭像用）" />
                                {r.relations.length > 0 && (
                                    <div className="space-y-1">
                                        {r.relations.map((rel, i) => (
                                            <div key={i} className="flex items-center gap-1.5 text-[11px] text-slate-500">
                                                <span className="shrink-0">跟「{rel.target}」：</span>
                                                <input value={rel.relation} onChange={e => patchRow(r.key, { relations: r.relations.map((x, j) => (j === i ? { ...x, relation: e.target.value.slice(0, 80) } : x)) })}
                                                    className="flex-1 min-w-0 bg-slate-50 rounded-lg px-2 py-1 outline-none" />
                                                <button onClick={() => patchRow(r.key, { relations: r.relations.filter((_, j) => j !== i) })} aria-label="拿掉這條關係" className="text-slate-300 px-1">×</button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </>
                )}
            </div>

            <div className="absolute bottom-0 inset-x-0 px-5 pt-3 bg-gradient-to-t from-slate-50 via-slate-50 to-transparent" style={{ paddingBottom: 'calc(1rem + var(--safe-bottom))' }}>
                {progress && <p className="text-[11px] text-slate-500 text-center mb-2">{progress}</p>}
                {!rows.length ? (
                    <button onClick={generate} disabled={busy || !lead}
                        className="w-full py-3 rounded-2xl bg-violet-500 text-white text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-60">
                        <Sparkle size={16} weight="fill" />{busy ? '生成中…' : `生成 ${count} 個配角`}
                    </button>
                ) : (
                    <div className="flex gap-2">
                        <button onClick={generate} disabled={busy} className="px-4 py-3 rounded-2xl bg-white border border-slate-200 text-sm font-bold text-slate-600 disabled:opacity-60">整批重生</button>
                        <button onClick={create} disabled={busy}
                            className="flex-1 py-3 rounded-2xl bg-violet-500 text-white text-sm font-bold disabled:opacity-60">
                            {busy ? '建立中…' : `建立 ${rows.filter(r => r.checked).length} 個配角`}
                        </button>
                    </div>
                )}
            </div>
        </div>,
        document.body,
    );
};

export default CastGeneratorPage;
