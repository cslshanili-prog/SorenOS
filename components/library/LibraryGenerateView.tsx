import React, { useMemo, useState } from 'react';
import { isImageFeatureOff } from '../../utils/imageStyle';
import { useOS } from '../../context/OSContext';
import type { GalleryImage, LibraryAccess, LibraryGenKind } from '../../types';
import TokenImg from '../os/TokenImg';
import LibraryAccessPicker from './LibraryAccessPicker';
import LibraryDescribeButton from './LibraryDescribeButton';
import { trackEvent } from '../../utils/analytics';
import { DB } from '../../utils/db';
import { migrateDataUrlToRef } from '../../utils/blobRef';
import { getLocalDateKey } from '../../utils/localDate';
import { resolveUserProfileForChar } from '../../utils/userPersona';
import { LIBRARY_DESCRIPTION_MAX, makeLibraryImageId, normalizeLibraryDescription } from '../../utils/library';
import {
    LIBRARY_GEN_KINDS,
    LIBRARY_GEN_PROMPT_MAX,
    LibraryGenResult,
    LibraryGenSubject,
    canGenerateInLibrary,
    defaultLibraryGenAccess,
    describeLibraryGenLock,
    generateLibraryImage,
    isPeopleKind,
    libraryGenSubjectError,
    subjectKey,
} from '../../utils/libraryGenerate';

const USER_KEY = 'user';

/**
 * 資料庫：在這裡生成（plans/asset-library-design.md 第三批）。
 * 選類型 → 選人（獨照一個、合照兩個以上，你也算一個）→ 寫想拍什麼 → 生成 → 先看預覽，
 * 滿意了寫描述、選誰能用再存；不滿意重新生成，沒存的不會留下來。
 */
const LibraryGenerateView: React.FC<{ onSaved: (image: GalleryImage) => void }> = ({ onSaved }) => {
    const { characters, characterGroups, apiConfig, userProfile, userProfileBase, addToast } = useOS();
    const imageConfig = apiConfig.imageGenConfig;
    const [kind, setKind] = useState<LibraryGenKind>('solo');
    const [picked, setPicked] = useState<string[]>([]);
    const [prompt, setPrompt] = useState('');
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<LibraryGenResult | null>(null);
    const [description, setDescription] = useState('');
    const [access, setAccess] = useState<LibraryAccess>({ mode: 'all' });
    const [saving, setSaving] = useState(false);

    const people = isPeopleKind(kind);
    const firstChar = characters.find(c => picked.includes(c.id));
    // 你的長相：照片裡第一個角色認識的那張身份卡；只有你自己的話用目前的身份卡
    const userForPhoto = useMemo(
        () => (firstChar ? resolveUserProfileForChar(userProfileBase, firstChar) : userProfile),
        [firstChar, userProfileBase, userProfile],
    );
    const subjects: LibraryGenSubject[] = useMemo(() => picked.flatMap((key): LibraryGenSubject[] => {
        if (key === USER_KEY) return [{ type: 'user', profile: userForPhoto }];
        const char = characters.find(c => c.id === key);
        return char ? [{ type: 'char', char }] : [];
    }), [picked, characters, userForPhoto]);

    const subjectError = people ? libraryGenSubjectError(kind, subjects.length) : null;
    const kindInfo = LIBRARY_GEN_KINDS.find(k => k.kind === kind)!;

    const switchKind = (next: LibraryGenKind) => {
        setKind(next);
        if (next === 'solo') setPicked(prev => prev.slice(0, 1));
    };

    const togglePerson = (key: string) => {
        setPicked(prev => {
            if (kind === 'solo') return prev[0] === key ? [] : [key];
            return prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
        });
    };

    const run = async () => {
        if (busy || !canGenerateInLibrary(imageConfig)) return;
        setBusy(true);
        try {
            const next = await generateLibraryImage({ kind, prompt, subjects: people ? subjects : [], imageConfig });
            setResult(next);
            if (next.apiFallbackFrom) addToast(`「${next.apiFallbackFrom}」沒回應，這張改用全域那組 API`, 'info');
            if (!description.trim()) setDescription(prompt.trim().slice(0, LIBRARY_DESCRIPTION_MAX));
            if (!result) setAccess(defaultLibraryGenAccess(kind, people ? subjects : []));
            trackEvent('在资料库生成照片', { 类型: ({ solo: '独照', group: '合照', object: '物品', scenery: '风景' } as const)[kind] });
        } catch (error: any) {
            addToast(`沒生成成：${error?.message || '未知錯誤'}`, 'error');
        } finally {
            setBusy(false);
        }
    };

    const save = async () => {
        if (!result || saving) return;
        setSaving(true);
        try {
            const url = await migrateDataUrlToRef(result.dataUrl);
            const image: GalleryImage = {
                id: makeLibraryImageId(),
                charId: '',
                url,
                timestamp: Date.now(),
                sender: 'user',
                origin: 'generated',
                access,
                savedDate: getLocalDateKey(new Date()),
                generation: {
                    kind,
                    prompt: result.prompt,
                    subjects: people ? subjects.map(subjectKey) : [],
                    locked: result.lockedCount,
                    wanted: result.wantedLocks,
                },
                ...(normalizeLibraryDescription(description) ? { description: normalizeLibraryDescription(description) } : {}),
            };
            await DB.saveGalleryImage(image);
            addToast('存進資料庫了', 'success');
            onSaved(image);
        } catch (error: any) {
            addToast(`沒存成：${error?.message || '未知錯誤'}`, 'error');
        } finally {
            setSaving(false);
        }
    };

    if (!canGenerateInLibrary(imageConfig)) {
        return (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
                {isImageFeatureOff(imageConfig, 'library') ? (<>
                    <p className="text-sm font-bold text-slate-500">資料庫的生圖關掉了</p>
                    <p className="text-[12px] leading-relaxed text-slate-400">到「設置 → 生圖API → 各處畫風」把「資料庫生圖」改回來，就能在這裡生成照片。</p>
                </>) : (<>
                    <p className="text-sm font-bold text-slate-500">還沒設生圖 API</p>
                    <p className="text-[12px] leading-relaxed text-slate-400">到「設置 → 生圖 API」填好網址和模型，就能在這裡生成照片。</p>
                </>)}
            </div>
        );
    }

    const personChip = (key: string, name: string, avatar: string | undefined, hasRef: boolean) => {
        const on = picked.includes(key);
        return (
            <button key={key} type="button" role={kind === 'solo' ? 'radio' : 'checkbox'} aria-checked={on} aria-label={name} onClick={() => togglePerson(key)}
                className="flex min-w-0 flex-col items-center gap-1">
                <span className={`relative block h-12 w-12 overflow-hidden rounded-full bg-slate-200 ring-2 transition ${on ? 'ring-slate-800' : 'ring-transparent opacity-60'}`}>
                    <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-slate-400">{name.charAt(0)}</span>
                    {avatar && <TokenImg value={avatar} alt="" className="relative h-full w-full object-cover" onError={event => { event.currentTarget.style.display = 'none'; }} />}
                    {on && <span className="absolute inset-0 flex items-center justify-center bg-slate-900/30 text-sm font-bold text-white">{kind === 'group' ? picked.indexOf(key) + 1 : '✓'}</span>}
                </span>
                <span className={`w-full truncate text-center text-[10px] ${on ? 'font-bold text-slate-700' : 'text-slate-400'}`}>{name}</span>
                <span className={`text-[9px] ${hasRef ? 'text-emerald-500' : 'text-slate-300'}`}>{hasRef ? '會鎖臉' : '沒參考圖'}</span>
            </button>
        );
    };

    const hasRef = (cfg?: { referenceEnabled?: boolean; referenceImage?: string }) => !!(cfg?.referenceEnabled && cfg.referenceImage);

    return (
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-10 pt-4 animate-fade-in">
            <div role="radiogroup" aria-label="類型" className="grid grid-cols-4 gap-1 rounded-xl bg-slate-100 p-1">
                {LIBRARY_GEN_KINDS.map(option => (
                    <button key={option.kind} type="button" role="radio" aria-checked={kind === option.kind} onClick={() => switchKind(option.kind)}
                        className={`rounded-lg py-1.5 text-[12px] font-bold transition ${kind === option.kind ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}>
                        {option.label}
                    </button>
                ))}
            </div>

            {people && (
                <section className="space-y-2">
                    <div className="flex items-baseline justify-between">
                        <h3 className="text-[11px] font-bold text-slate-400">{kind === 'solo' ? '拍誰' : '照片裡有誰'}</h3>
                        {subjectError ? <span className="text-[11px] text-slate-400">{subjectError}</span> : picked.includes(USER_KEY) && <span className="truncate text-[11px] text-slate-400">你的長相照「{userForPhoto.name}」</span>}
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                        {personChip(USER_KEY, '你', userForPhoto.avatar, hasRef(userForPhoto.imageGenConfig))}
                        {characters.map(char => personChip(char.id, char.name, char.avatar, hasRef(char.imageGenCharConfig)))}
                    </div>
                </section>
            )}

            <section className="space-y-1.5">
                <h3 className="text-[11px] font-bold text-slate-400">想拍什麼</h3>
                <textarea
                    value={prompt}
                    onChange={event => setPrompt(event.target.value.slice(0, LIBRARY_GEN_PROMPT_MAX))}
                    rows={4}
                    placeholder={kindInfo.placeholder}
                    className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] leading-relaxed text-slate-700 outline-none focus:border-slate-400"
                />
                {people && <p className="text-[11px] leading-relaxed text-slate-400">寫地點、動作、表情、光線就好，長相會照每個人自己的設定和參考圖。</p>}
            </section>

            <button onClick={run} disabled={busy || !!subjectError || !prompt.trim()}
                className={`w-full rounded-2xl py-3 text-[14px] font-bold transition active:scale-[0.98] disabled:opacity-40 ${result ? 'border border-slate-300 bg-white text-slate-700' : 'bg-slate-800 text-white shadow-sm'}`}>
                {busy ? '生成中，可能要等一下…' : result ? '重新生成' : '生成'}
            </button>

            {result && (
                <>
                    <div className="space-y-1.5">
                        <div className="flex max-h-[50vh] items-center justify-center overflow-hidden rounded-2xl bg-slate-900">
                            <img src={result.dataUrl} alt="生成的照片" className={`max-h-[50vh] max-w-full object-contain transition-opacity ${busy ? 'opacity-40' : ''}`} />
                        </div>
                        {people && <p className="text-center text-[11px] text-slate-400">{describeLibraryGenLock(result.lockedCount, result.wantedLocks, result.lockError, result.peopleCount)}</p>}
                    </div>
                    <section className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                            <h3 className="shrink-0 text-[11px] font-bold text-slate-400">描述</h3>
                            <LibraryDescribeButton getImageUrl={() => result.dataUrl} current={description} onChange={setDescription} />
                        </div>
                        <textarea
                            value={description}
                            onChange={event => setDescription(event.target.value.slice(0, LIBRARY_DESCRIPTION_MAX))}
                            rows={3}
                            className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] leading-relaxed text-slate-700 outline-none focus:border-slate-400"
                        />
                    </section>
                    <section className="space-y-2">
                        <h3 className="text-[11px] font-bold text-slate-400">誰能用</h3>
                        <LibraryAccessPicker value={access} onChange={setAccess} characters={characters} worlds={characterGroups} />
                    </section>
                    <button onClick={save} disabled={saving || busy}
                        className="w-full rounded-2xl bg-slate-800 py-3 text-[14px] font-bold text-white shadow-sm transition active:scale-[0.98] disabled:opacity-40">
                        {saving ? '存進去中…' : '滿意，存進資料庫'}
                    </button>
                </>
            )}
        </div>
    );
};

export default LibraryGenerateView;
