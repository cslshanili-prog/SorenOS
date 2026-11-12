import React, { useState } from 'react';
import ImageStylePicker, { EMPTY_PICK, pickOptions, type ImageStylePick } from '../image/ImageStylePicker';
import type { CharacterProfile } from '../../types';
import { useOS } from '../../context/OSContext';
import TokenImg from '../os/TokenImg';
import { ALT_SELF_LIMIT_DEFAULT, ALT_SELF_LIMIT_MAX, altsOf } from '../../utils/charAlt';
import { altDefaultAvatar as defaultAvatar, buildAltCharacter, requestAltDraft, type AltDraft } from '../../utils/charAltGenerate';
import { castAvatarPrompt } from '../../utils/castGenerate';
import { canGenerateFor } from '../../utils/imageStyle';
import { generateImage } from '../../utils/imageGeneration';
import { migrateDataUrlToRef } from '../../utils/blobRef';
import { trackEvent } from '../../utils/analytics';
import { altRequestStatusText, planAltRequest, unblockAltRequest } from '../../utils/altFriend';
import { globalPersonaKey } from '../../utils/userPersona';

const emptyDraft: AltDraft = { name: '', brief: '', purpose: '', appearance: '', greeting: '' };

/**
 * 本人編輯頁的「小號」那一區（關係線第 7 批，plans/persona-line-batch7.md）：上帝視角，列得出來；
 * 聊天裡的你不知道。可以幫它開一個（自己填或 AI 想），設它自己最多開幾個。
 */
const AltAccountsSection: React.FC<{
    owner: CharacterProfile;
    onOpenAlt: (alt: CharacterProfile) => void;
    onChangeLimit: (n: number) => void;
}> = ({ owner, onOpenAlt, onChangeLimit }) => {
    const { characters, apiConfig, addCharacters, deleteCharacter, updateCharacter, addToast, userProfileBase } = useOS();
    const now = Date.now();
    const alts = altsOf(owner.id, characters);
    const [draft, setDraft] = useState<AltDraft | null>(null);
    const [busy, setBusy] = useState(false);
    const [wantAvatar, setWantAvatar] = useState(false);
    const [stylePick, setStylePick] = useState<ImageStylePick>(EMPTY_PICK);
    const imageReady = canGenerateFor(apiConfig.imageGenConfig, 'avatar');
    const limit = owner.altSelfLimit ?? ALT_SELF_LIMIT_DEFAULT;

    const think = async () => {
        setBusy(true);
        try {
            const d = await requestAltDraft({ owner, existingNames: alts.map(a => a.name), apiConfig });
            setDraft(d);
        } catch (e: any) {
            addToast(e?.message || '沒想出來，再試一次', 'error');
        } finally {
            setBusy(false);
        }
    };

    const create = async () => {
        if (!draft?.name.trim() || busy) return;
        setBusy(true);
        try {
            let avatar = defaultAvatar(draft.name);
            if (wantAvatar && imageReady) {
                try {
                    const { dataUrl } = await generateImage(apiConfig.imageGenConfig!, castAvatarPrompt({ name: draft.name, appearance: draft.appearance, brief: draft.brief }), undefined, { feature: 'avatar', char: owner, hasPerson: true, ...pickOptions(stylePick) });
                    avatar = await migrateDataUrlToRef(dataUrl);
                } catch (e) {
                    console.warn('[小號] 頭像沒畫成，先用預設的', e);
                    addToast('頭像沒畫成，先用預設的', 'info');
                }
            }
            // 有寫招呼：過一陣子來加你（加的是本人主線那張卡）
            const req = draft.greeting?.trim() ? planAltRequest(undefined, { personaKey: owner.primaryPersonaKey || globalPersonaKey(userProfileBase), greeting: draft.greeting, now: Date.now() }) : null;
            await addCharacters([{ ...buildAltCharacter({ owner, draft, avatar, createdBy: 'user' }), ...(req ? { altFriendRequest: req } : {}) }]);
            trackEvent('帮角色开小号', { 头像: wantAvatar && imageReady ? '有' : '无' });
            addToast(`${owner.name} 多了一個小號「${draft.name}」`, 'success');
            setDraft(null);
        } finally {
            setBusy(false);
        }
    };

    const field = 'w-full bg-white rounded-xl px-3 py-2 text-xs text-slate-700 shadow-sm outline-none focus:ring-1 focus:ring-primary/20';

    return (
        <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">小號</label>
            <p className="text-[10px] text-slate-400 mb-2 leading-relaxed">你是上帝視角看得到；聊天、朋友圈裡的你不知道這些帳號是 TA。小號的人設和記憶都是本人的，對外只換名字、頭像和簡介。寫了招呼的小號過一陣子會來加你好友（訊息列表頂端「新的朋友」）；被拒了要不要再來，由 TA 自己決定。</p>
            {alts.length > 0 && (
                <div className="space-y-1.5 mb-2">
                    {alts.map(a => (
                        <div key={a.id} className="flex items-center gap-2 bg-white rounded-2xl px-3 py-2 shadow-sm">
                            <TokenImg value={a.avatar} className="w-9 h-9 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                            <button onClick={() => onOpenAlt(a)} className="min-w-0 flex-1 text-left">
                                <div className="text-sm font-bold text-slate-700 truncate">{a.name}<span className="ml-1.5 text-[9px] font-bold text-slate-400">{a.altCreatedBy === 'char' ? '它自己開的' : '你幫它開的'}</span></div>
                                <div className="text-[10px] text-slate-400 truncate">{a.altPurpose || a.description || '（沒寫理由）'}</div>
                                <div className="text-[10px] font-semibold text-violet-400 truncate">{altRequestStatusText(a, now)}{a.altRevealed ? ' · 你已經知道是 TA 了' : a.altDenied?.times ? ` · 你懷疑過 ${a.altDenied.times} 次，TA 沒認` : ''}</div>
                            </button>
                            {a.altFriendRequest?.status === 'pending' && a.altFriendRequest.at > now && (
                                <button onClick={() => updateCharacter(a.id, { altFriendRequest: { ...a.altFriendRequest!, at: Date.now() } })}
                                    className="shrink-0 px-2 py-1 rounded-lg bg-violet-50 text-[10px] font-bold text-violet-500">現在就來</button>
                            )}
                            {a.altFriendRequest?.status === 'blocked' && (
                                <button onClick={() => updateCharacter(a.id, { altFriendRequest: unblockAltRequest(a.altFriendRequest!) })}
                                    className="shrink-0 px-2 py-1 rounded-lg bg-slate-100 text-[10px] font-bold text-slate-500">解除封鎖</button>
                            )}
                            <button onClick={async () => { if (window.confirm(`收掉小號「${a.name}」？它的聊天紀錄會一起刪掉。`)) await deleteCharacter(a.id, { force: true }); }}
                                aria-label={`收掉 ${a.name}`} className="text-slate-300 hover:text-rose-400 px-1 text-lg leading-none">×</button>
                        </div>
                    ))}
                </div>
            )}

            {draft ? (
                <div className="bg-white/70 rounded-2xl p-3 space-y-2 shadow-sm">
                    <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value.slice(0, 20) })} placeholder="網名" className={field} />
                    <input value={draft.brief} onChange={e => setDraft({ ...draft, brief: e.target.value.slice(0, 80) })} placeholder="帳號簡介（別人看到的）" className={field} />
                    <textarea value={draft.purpose} onChange={e => setDraft({ ...draft, purpose: e.target.value.slice(0, 200) })} placeholder="開這個小號的真實理由（只有 TA 自己知道）" rows={2} className={`${field} resize-none`} />
                    <input value={draft.appearance} onChange={e => setDraft({ ...draft, appearance: e.target.value.slice(0, 200) })} placeholder="頭像要畫什麼（可留空）" className={field} />
                    <input value={draft.greeting || ''} onChange={e => setDraft({ ...draft, greeting: e.target.value.slice(0, 120) })} placeholder="加你好友時的招呼（留空＝先不來加你）" className={field} />
                    <label className={`flex items-center gap-2 text-[11px] text-slate-500 ${imageReady ? '' : 'opacity-50'}`}>
                        <input type="checkbox" checked={wantAvatar && imageReady} disabled={!imageReady} onChange={e => setWantAvatar(e.target.checked)} className="accent-violet-500" />
                        順便畫頭像{imageReady ? '' : '（要先配好生圖 API）'}
                    </label>
                    {wantAvatar && imageReady && <ImageStylePicker config={apiConfig.imageGenConfig} feature="avatar" char={owner} value={stylePick} onChange={setStylePick} />}
                    <div className="flex gap-2">
                        <button onClick={think} disabled={busy} className="px-3 py-2 rounded-xl bg-white text-xs font-bold text-violet-600 shadow-sm disabled:opacity-50">AI 幫我想</button>
                        <button onClick={() => setDraft(null)} disabled={busy} className="px-3 py-2 rounded-xl bg-white text-xs font-bold text-slate-400 shadow-sm">取消</button>
                        <button onClick={create} disabled={busy || !draft.name.trim()} className="flex-1 py-2 rounded-xl bg-violet-500 text-white text-xs font-bold disabled:opacity-50">{busy ? '處理中…' : '開這個小號'}</button>
                    </div>
                </div>
            ) : (
                <button onClick={() => setDraft({ ...emptyDraft })} className="w-full py-2.5 rounded-2xl bg-white text-xs font-bold text-violet-600 shadow-sm">＋ 幫 TA 開一個小號</button>
            )}

            <div className="flex items-center gap-2 mt-2.5">
                <span className="text-[10px] text-slate-400 shrink-0">它自己最多開幾個</span>
                <div className="flex gap-1">
                    {Array.from({ length: ALT_SELF_LIMIT_MAX + 1 }, (_, n) => (
                        <button key={n} onClick={() => onChangeLimit(n)} aria-pressed={n === limit}
                            className={`w-7 h-7 rounded-lg text-[11px] font-bold ${n === limit ? 'bg-violet-500 text-white' : 'bg-white text-slate-500 shadow-sm'}`}>{n}</button>
                    ))}
                </div>
            </div>
            <p className="text-[9px] text-slate-400 mt-1">0 ＝ 不讓它自己開；你幫它開的不算在裡面。</p>
        </div>
    );
};

export default AltAccountsSection;
