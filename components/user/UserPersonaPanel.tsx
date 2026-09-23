import React, { useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { processImage } from '../../utils/file';
import { migrateDataUrlToRef } from '../../utils/blobRef';
import TokenImg from '../os/TokenImg';
import { trackEvent } from '../../utils/analytics';
import type { UserGender } from '../../types';

const GENDER_OPTIONS: UserGender[] = ['男', '女', '保密', '二次元', '其他'];

/**
 * 檔案 App「身份卡」：同一個人維護的多套角色扮演身份（名字/頭像/簡介），全局切換「目前身份」。
 * 只是外顯裝扮——好感度/記憶/關係不跟著身份卡分開算，角色始終認得是同一個人（見 utils/userPersona.ts）。
 * 「真實身份」= 不套用任何身份卡，就是這張卡片本身——個人檔案頁頂部那張 Profile 卡只讀顯示
 * 當前生效的身份，編輯統一收進這裡（含真實身份自己的簡介，原本單獨一張「關於我/設定」卡）。
 */
const UserPersonaPanel: React.FC = () => {
    const { userProfileBase, updateUserProfile, addUserPersona, updateUserPersona, deleteUserPersona, setActivePersonaId, addToast } = useOS();
    const personas = userProfileBase.personas || [];
    const activeId = userProfileBase.activePersonaId;

    const [showInfo, setShowInfo] = useState(false);
    const [editingId, setEditingId] = useState<string | null | 'new' | 'real'>(null);
    const [draftName, setDraftName] = useState('');
    const [draftBio, setDraftBio] = useState('');
    const [draftAvatar, setDraftAvatar] = useState('');
    const [draftAvatarUrl, setDraftAvatarUrl] = useState('');
    const [draftGender, setDraftGender] = useState<UserGender | ''>('');
    const [draftCustomSetting, setDraftCustomSetting] = useState('');
    const [draftOtherDetails, setDraftOtherDetails] = useState('');
    const uploadRef = useRef<HTMLInputElement>(null);

    const isEditorOpen = editingId !== null;

    const loadDraft = (source: { name: string; avatar: string; bio: string; gender?: UserGender; customSetting?: string; otherDetails?: string }) => {
        setDraftName(source.name);
        setDraftBio(source.bio);
        setDraftAvatar(source.avatar);
        setDraftAvatarUrl(/^https?:\/\//i.test(source.avatar) ? source.avatar : '');
        setDraftGender(source.gender || '');
        setDraftCustomSetting(source.customSetting || '');
        setDraftOtherDetails(source.otherDetails || '');
    };

    const openNew = () => {
        setEditingId('new');
        loadDraft({ name: '', avatar: '', bio: '' });
    };

    const openEditReal = () => {
        setEditingId('real');
        loadDraft(userProfileBase);
    };

    const openEdit = (id: string) => {
        const p = personas.find(pp => pp.id === id);
        if (!p) return;
        setEditingId(id);
        loadDraft(p);
    };

    const closeEditor = () => setEditingId(null);

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            const base64 = await processImage(file);
            setDraftAvatar(await migrateDataUrlToRef(base64));
            setDraftAvatarUrl('');
        } catch (err: any) {
            addToast(err.message, 'error');
        }
    };

    const commitAvatarUrl = () => {
        const v = draftAvatarUrl.trim();
        if (!v) {
            if (/^https?:\/\//i.test(draftAvatar)) setDraftAvatar('');
            return;
        }
        try {
            const u = new URL(v);
            if (!/^https?:$/.test(u.protocol)) throw new Error();
        } catch {
            addToast('請填寫有效的 http(s) 圖片鏈接', 'error');
            return;
        }
        setDraftAvatar(v);
    };

    const handleSave = async () => {
        if (!draftName.trim()) { addToast('請起個名字', 'error'); return; }
        const fields = {
            name: draftName.trim(),
            avatar: draftAvatar,
            bio: draftBio.trim(),
            gender: draftGender || undefined,
            customSetting: draftCustomSetting.trim() || undefined,
            otherDetails: draftOtherDetails.trim() || undefined,
        };
        if (editingId === 'real') {
            updateUserProfile(fields);
            addToast('真實身份已更新', 'success');
        } else if (editingId === 'new') {
            const persona = await addUserPersona(fields);
            addToast('身份卡已建好', 'success');
            trackEvent('新建身份卡');
            // 新建的卡默認不自動切換，用戶自己決定要不要馬上套用
            void persona;
        } else if (editingId) {
            await updateUserPersona(editingId, fields);
            addToast('身份卡已更新', 'success');
        }
        closeEditor();
    };

    const handleDelete = async (id: string) => {
        await deleteUserPersona(id);
        addToast('身份卡已刪除', 'success');
        trackEvent('删除身份卡');
        if (editingId === id) closeEditor();
    };

    return (
        <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100 p-5">
            <div className="flex items-center gap-2 mb-1">
                <span className="w-7 h-7 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
                    </svg>
                </span>
                <h2 className="text-sm font-bold text-slate-700 flex-1">身份卡</h2>
                <button
                    onClick={() => setShowInfo(v => !v)}
                    aria-label="身份卡說明"
                    className={`w-6 h-6 rounded-full text-[11px] font-bold flex items-center justify-center transition-colors ${showInfo ? 'bg-primary text-white' : 'bg-slate-100 text-slate-400'}`}
                >
                    i
                </button>
            </div>
            {showInfo && (
                <p className="text-[11px] text-slate-400 mb-3 leading-relaxed bg-slate-50 rounded-xl px-3 py-2.5">
                    維護幾套角色扮演身份，切換「目前身份」後全部聊天（私聊/群聊/查手機/見面）都會看到這張卡的名字、頭像和簡介。只是外顯裝扮——好感度、記憶和關係都不會分開算，角色始終認得是同一個你。點擊卡片切換身份，點擊 ✎ 編輯名字/頭像/簡介（簡介會發給 AI）。想讓某個角色始終用某張身份卡、不跟著這裡切換？去下面「分角色身份指定」。
                </p>
            )}

            <div className="grid grid-cols-2 gap-2.5">
                {/* 真實身份：不套用任何身份卡 */}
                <div
                    onClick={() => setActivePersonaId(undefined)}
                    className={`relative flex items-center gap-2.5 rounded-2xl border p-2.5 text-left transition-all active:scale-[0.98] cursor-pointer ${!activeId ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-slate-200 bg-white'}`}
                >
                    <TokenImg value={userProfileBase.avatar} className="w-10 h-10 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                    <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-bold text-slate-700 truncate">{userProfileBase.name || '真實身份'}</div>
                        <div className="text-[9px] text-slate-400">{!activeId ? '目前身份' : '真實身份'}</div>
                    </div>
                    <button
                        onClick={(e) => { e.stopPropagation(); openEditReal(); }}
                        className="shrink-0 w-6 h-6 rounded-full bg-slate-100 text-slate-500 text-[10px] flex items-center justify-center active:scale-90 transition-transform"
                        aria-label="編輯真實身份"
                    >
                        ✎
                    </button>
                </div>

                {personas.map(p => {
                    const active = activeId === p.id;
                    return (
                        <div key={p.id}
                            onClick={() => setActivePersonaId(p.id)}
                            className={`relative flex items-center gap-2.5 rounded-2xl border p-2.5 text-left transition-all active:scale-[0.98] cursor-pointer ${active ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-slate-200 bg-white'}`}
                        >
                            <TokenImg value={p.avatar} className="w-10 h-10 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                            <div className="min-w-0 flex-1">
                                <div className="text-[11px] font-bold text-slate-700 truncate">{p.name}</div>
                                <div className="text-[9px] text-slate-400">{active ? '目前身份' : '點擊切換'}</div>
                            </div>
                            <button
                                onClick={(e) => { e.stopPropagation(); openEdit(p.id); }}
                                className="shrink-0 w-6 h-6 rounded-full bg-slate-100 text-slate-500 text-[10px] flex items-center justify-center active:scale-90 transition-transform"
                                aria-label="編輯身份卡"
                            >
                                ✎
                            </button>
                        </div>
                    );
                })}

                <button onClick={openNew} className="flex items-center justify-center gap-1.5 rounded-2xl border border-dashed border-slate-300 p-2.5 text-slate-400 hover:border-primary/40 hover:text-primary transition-colors">
                    <span className="text-base leading-none">+</span>
                    <span className="text-[11px] font-bold">新增身份卡</span>
                </button>
            </div>

            {isEditorOpen && (
                <div className="fixed inset-0 z-[120] flex flex-col bg-white animate-fade-in">
                    <div className="flex items-center justify-between px-4 border-b border-slate-100 shrink-0"
                        style={{ paddingTop: 'calc(0.75rem + var(--safe-top))', paddingBottom: '0.75rem' }}>
                        <button onClick={closeEditor} className="w-8 h-8 flex items-center justify-center text-2xl leading-none text-slate-400 hover:text-slate-600">×</button>
                        <div className="text-sm font-bold text-slate-800">
                            {editingId === 'new' ? '添加身份' : editingId === 'real' ? '編輯真實身份' : '編輯身份卡'}
                        </div>
                        <button onClick={handleSave} className="w-8 h-8 flex items-center justify-center text-primary">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.4} stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                            </svg>
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto px-5 py-5" style={{ paddingBottom: 'calc(1.5rem + var(--safe-bottom))' }}>
                        <div className="flex flex-col items-center mb-5">
                            <div onClick={() => uploadRef.current?.click()} className="relative w-20 h-20 rounded-full cursor-pointer group mb-2.5">
                                <TokenImg value={draftAvatar} className="w-full h-full rounded-full object-cover bg-slate-100 group-hover:opacity-80 transition-opacity" alt="" />
                                <div className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center ring-2 ring-white text-[10px]">✎</div>
                            </div>
                            <input type="file" ref={uploadRef} className="hidden" accept="image/*" onChange={handleUpload} />
                            <input
                                type="url"
                                value={draftAvatarUrl}
                                onChange={(e) => setDraftAvatarUrl(e.target.value)}
                                onBlur={commitAvatarUrl}
                                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                placeholder="或粘貼圖片 URL（回車確認）"
                                className="w-full max-w-xs bg-slate-50 focus:bg-white border border-slate-100 focus:border-primary/30 rounded-xl px-4 py-2 text-xs text-slate-500 outline-none transition-all placeholder:text-slate-300 text-center"
                            />
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">名字 (Name)</label>
                                <input
                                    value={draftName}
                                    onChange={(e) => setDraftName(e.target.value)}
                                    placeholder={editingId === 'real' ? '你的名字' : '這張身份卡的名字'}
                                    className="w-full bg-slate-50 focus:bg-white border border-slate-100 focus:border-primary/30 rounded-xl px-4 py-2.5 text-sm text-slate-700 outline-none transition-all placeholder:text-slate-300"
                                />
                            </div>

                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">性別</label>
                                <select
                                    value={draftGender}
                                    onChange={(e) => setDraftGender(e.target.value as UserGender | '')}
                                    className="w-full bg-slate-50 border border-slate-100 focus:border-primary/30 rounded-xl px-4 py-2.5 text-sm text-slate-700 outline-none transition-all appearance-none"
                                >
                                    <option value="">不設置</option>
                                    {GENDER_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
                                </select>
                            </div>

                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">簡介 (Bio)</label>
                                <textarea
                                    value={draftBio}
                                    onChange={(e) => setDraftBio(e.target.value)}
                                    placeholder={editingId === 'real' ? '關於我 / 設定：會發給 AI，讓它更瞭解你（例如：大學生、喜歡吃辣、性格內向）' : '這個身份的簡介，會發給 AI（可留空）'}
                                    className="w-full h-28 bg-slate-50 focus:bg-white border border-slate-100 focus:border-primary/30 rounded-xl px-4 py-2.5 text-sm text-slate-700 leading-relaxed resize-none outline-none transition-all placeholder:text-slate-300"
                                />
                            </div>

                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">自定義設定 (Custom Setting)</label>
                                <textarea
                                    value={draftCustomSetting}
                                    onChange={(e) => setDraftCustomSetting(e.target.value)}
                                    placeholder="比簡介更深度的補充，會發給 AI（可留空）"
                                    className="w-full h-24 bg-slate-50 focus:bg-white border border-slate-100 focus:border-primary/30 rounded-xl px-4 py-2.5 text-sm text-slate-700 leading-relaxed resize-none outline-none transition-all placeholder:text-slate-300"
                                />
                            </div>

                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">其他補充 (Other Details)</label>
                                <textarea
                                    value={draftOtherDetails}
                                    onChange={(e) => setDraftOtherDetails(e.target.value)}
                                    placeholder="任何想讓 AI 知道的其他信息（可留空）"
                                    className="w-full h-24 bg-slate-50 focus:bg-white border border-slate-100 focus:border-primary/30 rounded-xl px-4 py-2.5 text-sm text-slate-700 leading-relaxed resize-none outline-none transition-all placeholder:text-slate-300"
                                />
                            </div>
                        </div>

                        {editingId !== 'new' && editingId !== 'real' && (
                            <button
                                onClick={() => editingId && handleDelete(editingId)}
                                className="w-full mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-[11px] font-bold text-rose-500 active:scale-[0.98] transition-transform"
                            >
                                刪除這張身份卡
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default UserPersonaPanel;
