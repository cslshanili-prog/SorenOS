import React, { useEffect, useRef, useState } from 'react';
import ExpandableTextarea from '../common/ExpandableTextarea';
import { createPortal } from 'react-dom';
import { useOS } from '../../context/OSContext';
import { processImage } from '../../utils/file';
import { migrateDataUrlToRef } from '../../utils/blobRef';
import TokenImg from '../os/TokenImg';
import { trackEvent } from '../../utils/analytics';
import type { CharacterProfile, UserGender } from '../../types';
import CharacterImageGenPanel from '../character/CharacterImageGenPanel';
import PersonaLinksSection from './PersonaLinksSection';
import VoiceProfileFields from '../voice/VoiceProfileFields';
import { REAL_IDENTITY_PERSONA_ID } from '../../utils/userPersona';
import { COMMON_TIMEZONES } from '../../utils/timezone';
import { personaExtraSetting } from '../../utils/personaSetting';

/** 有填任何一家的音色才存；全空就不留一個空殼 */
const hasAnyVoice = (vp: CharacterProfile['voiceProfile']): boolean =>
    !!(vp && (vp.voiceId?.trim() || vp.fishReferenceId?.trim() || vp.elevenLabsVoiceId?.trim() || vp.timberWeights?.length));

const GENDER_OPTIONS: UserGender[] = ['男', '女', '保密', '二次元', '其他'];

/** 'new' = 新增身份卡；'real' = 真實身份（不套用任何身份卡時的那份）；其餘是身份卡 id。 */
export type UserPersonaEditTarget = 'new' | 'real' | string;

/**
 * 身份卡編輯器（全螢幕）：新增身份卡、編輯某張身份卡、或編輯真實身份自己的名字/頭像/簡介。
 * 身份卡只是外顯裝扮——好感度/記憶/關係不跟著身份卡分開算，角色始終認得是同一個人
 * （見 utils/userPersona.ts）。切換「目前身份」在 IdentitySwitcher 的下拉選單裡。
 */
const UserPersonaEditor: React.FC<{ target: UserPersonaEditTarget; onClose: () => void }> = ({ target, onClose }) => {
    const { userProfileBase, updateUserProfile, addUserPersona, updateUserPersona, deleteUserPersona, addToast, apiConfig, personaLinesEnabled } = useOS();
    const personas = userProfileBase.personas || [];
    const editingId = target;

    const [draftName, setDraftName] = useState('');
    const [draftBio, setDraftBio] = useState('');
    const [draftAvatar, setDraftAvatar] = useState('');
    const [draftAvatarUrl, setDraftAvatarUrl] = useState('');
    const [draftGender, setDraftGender] = useState<UserGender | ''>('');
    // 補充設定：舊的「自定義設定」「其他補充」兩格合成一格（utils/personaSetting.ts）
    const [draftExtra, setDraftExtra] = useState('');
    // 長相（生圖參考圖＋外觀提示詞），見面「拍下這一刻」用
    const [draftImageGen, setDraftImageGen] = useState<CharacterProfile['imageGenCharConfig']>(undefined);
    // 聲音（私聊發語音條用，plans/user-voice.md）
    const [draftVoice, setDraftVoice] = useState<CharacterProfile['voiceProfile']>(undefined);
    // 所在地（時區，plans/time-system.md 第 2c 節）：算你跟角色的時差用；空＝跟設備
    const [draftTimezone, setDraftTimezone] = useState('');
    const uploadRef = useRef<HTMLInputElement>(null);

    const loadDraft = (source: { name: string; avatar: string; bio: string; gender?: UserGender; customSetting?: string; otherDetails?: string; imageGenConfig?: CharacterProfile['imageGenCharConfig']; voiceProfile?: CharacterProfile['voiceProfile']; timezone?: string }) => {
        setDraftImageGen(source.imageGenConfig);
        setDraftVoice(source.voiceProfile);
        setDraftTimezone(source.timezone || '');
        setDraftName(source.name);
        setDraftBio(source.bio);
        setDraftAvatar(source.avatar);
        setDraftAvatarUrl(/^https?:\/\//i.test(source.avatar) ? source.avatar : '');
        setDraftGender(source.gender || '');
        setDraftExtra(personaExtraSetting(source));
    };

    // 只在打開時載入一次草稿，編輯途中別被外部更新蓋掉
    useEffect(() => {
        if (target === 'new') loadDraft({ name: '', avatar: '', bio: '' });
        else if (target === 'real') loadDraft(userProfileBase);
        else {
            const p = personas.find(pp => pp.id === target);
            if (p) loadDraft(p); else onClose();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target]);

    const closeEditor = onClose;

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
            customSetting: draftExtra.trim() || undefined,
            // 舊的那格併進來了，存檔時清掉，免得讀的時候又接一次
            otherDetails: undefined,
            imageGenConfig: draftImageGen && (draftImageGen.referenceImage || draftImageGen.characterPrompt?.trim()) ? draftImageGen : undefined,
            voiceProfile: hasAnyVoice(draftVoice) ? draftVoice : undefined,
            timezone: draftTimezone || undefined,
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
        closeEditor();
    };

    // 掛到 body：編輯器是從頁首的身份切換器打開的，頁首有 backdrop-blur 和 sticky z-10，
    // fixed 會被困在頁首的層級裡，下面個人檔案的封面卡片（換封面、＋）就會蓋上來。
    return createPortal(
        <div className="fixed inset-0 z-[120] flex flex-col bg-white animate-fade-in">
            <div className="flex items-center justify-between px-4 border-b border-slate-100 shrink-0"
                style={{ paddingTop: 'calc(0.75rem + var(--safe-top))', paddingBottom: '0.75rem' }}>
                <button onClick={closeEditor} className="w-8 h-8 flex items-center justify-center text-2xl leading-none text-slate-400 hover:text-slate-600">×</button>
                <div className="text-sm font-bold text-slate-800">
                    {editingId === 'new' ? '添加身份' : editingId === 'real' ? '編輯真實身份' : '編輯身份卡'}
                </div>
                <button onClick={handleSave} aria-label="保存" className="w-8 h-8 flex items-center justify-center text-primary">
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
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">所在地（時區）</label>
                        <select
                            value={draftTimezone}
                            onChange={(e) => setDraftTimezone(e.target.value)}
                            aria-label="所在地（時區）"
                            className="w-full bg-slate-50 border border-slate-100 focus:border-primary/30 rounded-xl px-4 py-2.5 text-sm text-slate-700 outline-none transition-all appearance-none"
                        >
                            <option value="">跟設備</option>
                            {COMMON_TIMEZONES.map(tz => <option key={tz.id} value={tz.id}>{tz.label}</option>)}
                        </select>
                        <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">這個身份住在哪：角色有自己的時區時，會知道你那邊現在幾點、你們差幾小時。架空世界用不上。</p>
                    </div>

                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">簡介 (Bio)</label>
                        <ExpandableTextarea title="簡介"
                            value={draftBio}
                            onChange={v => setDraftBio(v)}
                            placeholder={editingId === 'real' ? '關於我 / 設定：會發給 AI，讓它更瞭解你（例如：大學生、喜歡吃辣、性格內向）' : '這個身份的簡介，會發給 AI（可留空）'}
                            className="w-full h-28 bg-slate-50 focus:bg-white border border-slate-100 focus:border-primary/30 rounded-xl px-4 py-2.5 text-sm text-slate-700 leading-relaxed resize-none outline-none transition-all placeholder:text-slate-300"
                        />
                        <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">所有功能都讀這格。一兩句就能認出你的基本設定寫這裡。</p>
                    </div>

                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">補充設定 (Details)</label>
                        <ExpandableTextarea title="補充設定"
                            value={draftExtra}
                            onChange={v => setDraftExtra(v)}
                            placeholder="比較長的細節：背景故事、跟角色的關係、喜好忌諱、想提醒 AI 的事（可留空）"
                            className="w-full h-32 bg-slate-50 focus:bg-white border border-slate-100 focus:border-primary/30 rounded-xl px-4 py-2.5 text-sm text-slate-700 leading-relaxed resize-none outline-none transition-all placeholder:text-slate-300"
                        />
                        <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">聊天、群聊、電話、見面都會帶上。劇情（沒戴面具時）、協同工作、記憶整理、小說、好友申請只看上面的簡介，最要緊的請寫在簡介。</p>
                    </div>
                </div>

                <div className="mt-5">
                    <CharacterImageGenPanel
                        subject="user"
                        charName={draftName.trim() || (editingId === 'real' ? '你' : '這張身份卡')}
                        value={draftImageGen}
                        onChange={setDraftImageGen}
                        globalImageGenEnabled={!!apiConfig.imageGenConfig?.charImageGenEnabled}
                    />
                </div>

                <div className="mt-5">
                    <VoiceProfileFields
                        value={draftVoice}
                        onChange={setDraftVoice}
                        apiConfig={apiConfig}
                        addToast={addToast}
                        speakerName={draftName.trim() || '我'}
                        title={editingId === 'real' ? '我的聲音' : '這張卡的聲音'}
                        hint="私聊裡你發語音條時，用這個聲音念出來。跟角色同一套：用哪家看設置 → 其他 API 的語音服務商，下面填那一家的音色就行。"
                        speedOwner={editingId === 'real' ? '你' : '這張卡'}
                        showPreview
                        onVoiceApplied={() => trackEvent('身份卡选了音色')}
                    />
                </div>

                {/* 身份連結（關係線預覽開著才有；新卡要先存起來才有 id） */}
                {personaLinesEnabled && editingId !== 'new' && (
                    <PersonaLinksSection personaKey={editingId === 'real' ? REAL_IDENTITY_PERSONA_ID : editingId} />
                )}

                {editingId !== 'new' && editingId !== 'real' && (
                    <button
                        onClick={() => editingId && handleDelete(editingId)}
                        className="w-full mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-[11px] font-bold text-rose-500 active:scale-[0.98] transition-transform"
                    >
                        刪除這張身份卡
                    </button>
                )}
            </div>
        </div>,
        document.body,
    );
};

export default UserPersonaEditor;
