import React, { useState, useRef, useEffect } from 'react';
import { useOS } from '../../context/OSContext';
import { CharacterProfile, SpriteConfig, SkinSet } from '../../types';
import { processImageToBlob } from '../../utils/file';
import { putImageBlob } from '../../utils/blobRef';
import { pickDateFallbackSprite } from '../../utils/dateSprites';
import TokenImg from '../os/TokenImg';

// 角色立繪（原本在見面「場景佈置」裡）。見面改成純閱讀以後不再用立繪，
// 但桌面陪伴（形象選「見面立繪」時，每套皮膚是一套服裝）、白色情人節／情人節／七夕活動、
// 視訊通話的靜態立繪都還拿它，所以管理介面搬到神經鏈接。資料欄位沒變（sprites / dateSkinSets /
// activeSkinSetId / customDateSprites / spriteConfig）。

// 標準情緒列表
const REQUIRED_EMOTIONS = ['normal', 'happy', 'angry', 'sad', 'shy'];
const DEFAULT_SPRITE_CONFIG: SpriteConfig = { scale: 1, x: 0, y: 0 };

/** 可摺疊分區卡片：標題常駐，內容默認收起，點標題展開。用原生 <details> 省狀態。 */
const Section: React.FC<{ title: string; defaultOpen?: boolean; children: React.ReactNode }> = ({ title, defaultOpen, children }) => (
    <details open={defaultOpen} className="group bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <summary className="list-none cursor-pointer select-none flex items-center justify-between gap-2 px-4 py-3.5 active:bg-slate-50 [&::-webkit-details-marker]:hidden">
            <h3 className="text-xs font-bold text-slate-400 uppercase">{title}</h3>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-slate-300 transition-transform group-open:rotate-180 shrink-0"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" /></svg>
        </summary>
        <div className="px-4 pb-4 pt-1">{children}</div>
    </details>
);

/** 神經鏈接「形象」分頁裡的入口卡片。 */
export const CharacterSpritePanel: React.FC<{ charId: string; onOpen: () => void }> = ({ charId, onOpen }) => {
    const { characters } = useOS();
    const char = characters.find(c => c.id === charId);
    const preview = pickDateFallbackSprite(char?.sprites, [...REQUIRED_EMOTIONS, ...(char?.customDateSprites || [])]);
    const count = Object.keys(char?.sprites || {}).filter(key => key !== 'chibi').length;
    const skins = (char?.dateSkinSets || []).length;
    return (
        <button onClick={onOpen} className="w-full flex items-center gap-4 bg-white rounded-2xl border border-slate-100 shadow-sm p-4 text-left active:scale-[0.98] transition-transform">
            <div className="w-16 h-20 shrink-0 rounded-xl bg-slate-100 overflow-hidden flex items-center justify-center">
                {preview ? <TokenImg value={preview} className="w-full h-full object-cover" /> : <span className="text-slate-300 text-2xl">+</span>}
            </div>
            <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-slate-700">角色立繪</div>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">桌面陪伴、節日活動和視訊通話用的半身立繪。{count > 0 ? `已上傳 ${count} 張` : '還沒有上傳'}{skins > 0 ? `，${skins} 套皮膚` : ''}。</p>
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-slate-300 shrink-0"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
        </button>
    );
};

const CharacterSpriteManager: React.FC<{ charId: string; onClose: () => void }> = ({ charId, onClose }) => {
    const { characters, updateCharacter, addToast, registerBackHandler } = useOS();
    const char = characters.find(c => c.id === charId) as CharacterProfile;
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => registerBackHandler(() => { onClose(); return true; }), [registerBackHandler, onClose]);

    const [uploadTarget, setUploadTarget] = useState<'sprite' | 'skin-sprite'>('sprite');
    const [targetEmotionKey, setTargetEmotionKey] = useState<string>('');
    const [tempSpriteConfig, setTempSpriteConfig] = useState<SpriteConfig>(DEFAULT_SPRITE_CONFIG);
    const [newEmotionName, setNewEmotionName] = useState<string>('');

    // Skin system state
    const [newSkinName, setNewSkinName] = useState('');
    const [editingSkinId, setEditingSkinId] = useState<string | null>(null);
    const [skinUrlInput, setSkinUrlInput] = useState('');
    const [skinUrlEmotionKey, setSkinUrlEmotionKey] = useState('');
    const [showUrlModal, setShowUrlModal] = useState(false);
    const [urlTargetSkinId, setUrlTargetSkinId] = useState<string | null>(null); // null = default sprites
    const skinSets = char.dateSkinSets || [];
    const activeSkinId = char.activeSkinSetId || null;

    // Sync config on mount
    useEffect(() => {
        if (char.spriteConfig) {
            setTempSpriteConfig(char.spriteConfig);
        }
    }, [char.id]);

    const sprites = char.sprites || {};
    // Preview shows active skin set's sprites if one is selected
    const previewSprites = React.useMemo(() => {
        if (activeSkinId) {
            const skin = skinSets.find(s => s.id === activeSkinId);
            if (skin && Object.keys(skin.sprites).length > 0) return skin.sprites;
        }
        return sprites;
    }, [activeSkinId, skinSets, sprites]);
    const currentSpriteImg = pickDateFallbackSprite(
        previewSprites,
        [...REQUIRED_EMOTIONS, ...(char.customDateSprites || [])],
        char.avatar,
    );

    const triggerUpload = (target: 'sprite', emotionKey?: string) => {
        setUploadTarget(target);
        if (emotionKey) setTargetEmotionKey(emotionKey);
        fileInputRef.current?.click();
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            // 立繪也改存 Blob，字段裡只留 blobref 令牌。壓縮口徑和以前一模一樣：
            // 不傳參 = 長邊 1200 / 質量 0.85 / PNG·WebP 保留透明通道，只是產物從
            // base64 換成二進制。別跟著背景抄 skipCompression，那是背景要原畫質。
            const blob = await processImageToBlob(file);
            const ref = await putImageBlob(blob);
            if (uploadTarget === 'skin-sprite') {
                // Upload to a specific skin set
                const key = targetEmotionKey.trim().toLowerCase();
                const skinId = editingSkinId;
                if (!key || !skinId) { addToast('參數丟失', 'error'); return; }
                const updatedSets = (char.dateSkinSets || []).map(s =>
                    s.id === skinId ? { ...s, sprites: { ...s.sprites, [key]: ref } } : s
                );
                updateCharacter(char.id, { dateSkinSets: updatedSets });
                addToast(`皮膚立繪 [${key}] 已保存`, 'success');
                setTargetEmotionKey('');
            } else {
                const key = targetEmotionKey.trim().toLowerCase();
                if (!key) { addToast('情緒Key丟失', 'error'); return; }
                const newSprites = { ...(char.sprites || {}), [key]: ref };
                updateCharacter(char.id, { sprites: newSprites });
                addToast(`立繪 [${key}] 已保存`, 'success');
                setTargetEmotionKey('');
            }
        } catch (e: any) {
            addToast(e.message, 'error');
        } finally {
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    // --- Skin Set Management ---
    const handleCreateSkinSet = () => {
        const name = newSkinName.trim();
        if (!name) { addToast('請輸入皮膚名稱', 'error'); return; }
        if (skinSets.some(s => s.name === name)) { addToast('該名稱已存在', 'error'); return; }
        const newSkin: SkinSet = { id: `skin_${Date.now()}`, name, sprites: {} };
        updateCharacter(char.id, { dateSkinSets: [...skinSets, newSkin] });
        setNewSkinName('');
        addToast(`皮膚 [${name}] 已創建`, 'success');
    };

    const handleDeleteSkinSet = (skinId: string) => {
        const updated = skinSets.filter(s => s.id !== skinId);
        const patch: Partial<CharacterProfile> = { dateSkinSets: updated };
        if (activeSkinId === skinId) patch.activeSkinSetId = undefined;
        updateCharacter(char.id, patch);
        if (editingSkinId === skinId) setEditingSkinId(null);
        addToast('已刪除皮膚', 'success');
    };

    const handleActivateSkin = (skinId: string | null) => {
        updateCharacter(char.id, { activeSkinSetId: skinId || undefined });
        addToast(skinId ? '已切換皮膚' : '已切換為默認立繪', 'success');
    };

    const triggerSkinSpriteUpload = (skinId: string, emotionKey: string) => {
        setUploadTarget('skin-sprite');
        setEditingSkinId(skinId);
        setTargetEmotionKey(emotionKey);
        fileInputRef.current?.click();
    };

    const handleUrlSubmit = () => {
        const url = skinUrlInput.trim();
        const key = skinUrlEmotionKey.trim().toLowerCase();
        if (!url || !key) { addToast('請填寫完整', 'error'); return; }
        // Basic URL validation
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            addToast('請輸入有效的 URL (http/https)', 'error'); return;
        }

        if (urlTargetSkinId) {
            // Save to skin set
            const updatedSets = (char.dateSkinSets || []).map(s =>
                s.id === urlTargetSkinId ? { ...s, sprites: { ...s.sprites, [key]: url } } : s
            );
            updateCharacter(char.id, { dateSkinSets: updatedSets });
        } else {
            // Save to default sprites
            const newSprites = { ...(char.sprites || {}), [key]: url };
            updateCharacter(char.id, { sprites: newSprites });
        }
        addToast(`立繪 [${key}] URL 已保存`, 'success');
        setSkinUrlInput('');
        setSkinUrlEmotionKey('');
        setShowUrlModal(false);
    };

    const handleSaveSettings = () => {
        updateCharacter(char.id, { spriteConfig: tempSpriteConfig });
        addToast('位置已保存', 'success');
    };

    const customEmotions = char.customDateSprites || [];

    const handleAddCustomEmotion = () => {
        const key = newEmotionName.trim().toLowerCase().replace(/\s+/g, '_');
        if (!key) { addToast('請輸入情緒名稱', 'error'); return; }
        if (REQUIRED_EMOTIONS.includes(key)) { addToast('該名稱與默認情緒重複', 'error'); return; }
        if (customEmotions.includes(key)) { addToast('該自定義情緒已存在', 'error'); return; }
        if (key === 'chibi') { addToast('不能使用 chibi 作為情緒名', 'error'); return; }
        const updated = [...customEmotions, key];
        updateCharacter(char.id, { customDateSprites: updated });
        setNewEmotionName('');
        addToast(`已添加自定義情緒 [${key}]`, 'success');
    };

    const handleDeleteCustomEmotion = (key: string) => {
        const updated = customEmotions.filter(e => e !== key);
        updateCharacter(char.id, { customDateSprites: updated });
        // Also remove the sprite image for this emotion
        const newSprites = { ...(char.sprites || {}) };
        delete newSprites[key];
        updateCharacter(char.id, { sprites: newSprites, customDateSprites: updated });
        addToast(`已刪除自定義情緒 [${key}]`, 'success');
    };

    return (
        <div className="fixed inset-0 z-[80] bg-slate-50 flex flex-col">
            <div className="min-h-16 flex items-center justify-between px-4 pb-2 border-b border-slate-200 bg-white shrink-0 z-20" style={{ paddingTop: 'max(0.5rem, var(--safe-top))' }}>
                <button onClick={onClose} aria-label="返回" className="p-2 -ml-2 text-slate-600 active:scale-95 transition-transform">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                </button>
                <span className="font-bold text-slate-700">角色立繪</span>
                <div className="w-8"></div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-8" style={{ paddingBottom: 'calc(var(--safe-bottom) + 2rem)' }}>
                <div className="-mx-5 -mt-5 h-64 bg-slate-800 relative overflow-hidden shrink-0 border-b border-slate-200">
                    <div className="absolute inset-0 flex items-end justify-center pointer-events-none">
                        <TokenImg
                        value={currentSpriteImg}
                        className="max-h-[90%] object-contain transition-transform"
                        style={{
                            transform: `translate(${tempSpriteConfig.x}%, ${tempSpriteConfig.y}%) scale(${tempSpriteConfig.scale})`
                        }}
                        />
                    </div>
                    <div className="absolute top-2 left-2 bg-black/50 text-white text-[10px] px-2 py-1 rounded backdrop-blur-sm">預覽 (Preview)</div>
                </div>

                <Section title="立繪位置調整">
                    <div className="space-y-6">
                        <div>
                            <div className="flex justify-between text-[10px] text-slate-500 mb-2"><span>大小縮放 (Scale)</span><span>{tempSpriteConfig.scale.toFixed(1)}x</span></div>
                            <input type="range" min="0.5" max="2.0" step="0.1" value={tempSpriteConfig.scale} onChange={e => setTempSpriteConfig({...tempSpriteConfig, scale: parseFloat(e.target.value)})} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary" />
                        </div>
                        <div>
                            <div className="flex justify-between text-[10px] text-slate-500 mb-2"><span>左右偏移 (X)</span><span>{tempSpriteConfig.x}%</span></div>
                            <input type="range" min="-100" max="100" step="5" value={tempSpriteConfig.x} onChange={e => setTempSpriteConfig({...tempSpriteConfig, x: parseInt(e.target.value)})} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary" />
                        </div>
                            <div>
                            <div className="flex justify-between text-[10px] text-slate-500 mb-2"><span>上下偏移 (Y)</span><span>{tempSpriteConfig.y}%</span></div>
                            <input type="range" min="-50" max="50" step="5" value={tempSpriteConfig.y} onChange={e => setTempSpriteConfig({...tempSpriteConfig, y: parseInt(e.target.value)})} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary" />
                        </div>
                        <button onClick={handleSaveSettings} className="w-full py-2.5 bg-primary text-white text-sm font-bold rounded-xl active:scale-95 transition-transform">保存位置</button>
                    </div>
                </Section>

                <Section title="基礎情緒立繪">
                    <div className="grid grid-cols-3 gap-3">
                        {REQUIRED_EMOTIONS.map(key => (
                            <div key={key} onClick={() => triggerUpload('sprite', key)} className="flex flex-col gap-2 group cursor-pointer">
                                <div className={`aspect-[3/4] rounded-xl overflow-hidden relative border ${sprites[key] ? 'border-slate-200 bg-white' : 'border-dashed border-slate-300 bg-slate-100'} shadow-sm flex items-center justify-center transition-all group-hover:border-primary`}>
                                    {sprites[key] ? (
                                        <>
                                            <TokenImg value={sprites[key]} className="w-full h-full object-cover" />
                                            <div className="absolute inset-0 bg-black/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><span className="text-white text-[10px]">更換</span></div>
                                        </>
                                    ) : <span className="text-slate-300 text-2xl">+</span>}
                                </div>
                                <div className="text-center">
                                    <div className="text-xs font-bold text-slate-600 capitalize">{key}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </Section>

                <Section title="自定義情緒 (Custom Emotions)">
                    <p className="text-[11px] text-slate-400 mb-4">為這個角色添加專屬表情。每個角色的自定義情緒互相獨立。</p>

                    {/* Existing custom emotions grid */}
                    {customEmotions.length > 0 && (
                        <div className="grid grid-cols-3 gap-3 mb-4">
                            {customEmotions.map(key => (
                                <div key={key} className="flex flex-col gap-2 group relative">
                                    <div
                                        onClick={() => triggerUpload('sprite', key)}
                                        className={`aspect-[3/4] rounded-xl overflow-hidden relative border ${sprites[key] ? 'border-slate-200 bg-white' : 'border-dashed border-slate-300 bg-slate-100'} shadow-sm flex items-center justify-center transition-all group-hover:border-primary cursor-pointer`}
                                    >
                                        {sprites[key] ? (
                                            <>
                                                <TokenImg value={sprites[key]} className="w-full h-full object-cover" />
                                                <div className="absolute inset-0 bg-black/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><span className="text-white text-[10px]">更換</span></div>
                                            </>
                                        ) : <span className="text-slate-300 text-2xl">+</span>}
                                    </div>
                                    <div className="text-center flex items-center justify-center gap-1">
                                        <div className="text-xs font-bold text-slate-600 capitalize truncate">{key}</div>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleDeleteCustomEmotion(key); }}
                                            className="text-slate-300 hover:text-red-400 transition-colors shrink-0"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Add new custom emotion */}
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={newEmotionName}
                            onChange={e => setNewEmotionName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleAddCustomEmotion(); }}
                            placeholder="輸入情緒名 (如 scared, excited...)"
                            className="flex-1 px-4 py-3 bg-slate-100 rounded-xl text-sm focus:ring-1 focus:ring-primary/30 outline-none transition-all"
                        />
                        <button
                            onClick={handleAddCustomEmotion}
                            disabled={!newEmotionName.trim()}
                            className="px-5 py-3 bg-primary text-white text-sm font-bold rounded-xl disabled:opacity-40 active:scale-95 transition-all"
                        >
                            添加
                        </button>
                    </div>
                </Section>

                {/* URL Upload for Default Sprites */}
                <Section title="圖床 URL 上傳">
                    <p className="text-[11px] text-slate-400 mb-3">直接粘貼圖片 URL 作為默認立繪</p>
                    <button
                        onClick={() => { setUrlTargetSkinId(null); setShowUrlModal(true); }}
                        className="w-full py-2.5 bg-slate-100 text-slate-600 text-sm font-medium rounded-xl hover:bg-slate-200 transition-colors active:scale-95"
                    >
                        + 通過 URL 添加立繪
                    </button>
                </Section>

                {/* Skin Sets System */}
                <Section title="皮膚系統 (Skin Sets)">
                    <p className="text-[11px] text-slate-400 mb-4">為角色創建多套立繪皮膚。切換後，桌面陪伴和節日活動會改用這一套。</p>

                    {/* Active skin indicator */}
                    <div className="mb-4 flex items-center gap-2 text-xs">
                        <span className="text-slate-400">當前激活:</span>
                        <span className="font-bold text-slate-700">{activeSkinId ? (skinSets.find(s => s.id === activeSkinId)?.name || '未知') : '默認立繪'}</span>
                        {activeSkinId && (
                            <button onClick={() => handleActivateSkin(null)} className="text-[10px] text-primary underline">切回默認</button>
                        )}
                    </div>

                    {/* Existing skin sets */}
                    <div className="space-y-3 mb-4">
                        {skinSets.map(skin => (
                            <div key={skin.id} className={`bg-white rounded-2xl border shadow-sm overflow-hidden ${activeSkinId === skin.id ? 'border-primary ring-1 ring-primary/20' : 'border-slate-100'}`}>
                                <div className="p-3 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className="font-bold text-sm text-slate-700">{skin.name}</span>
                                        <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">{Object.keys(skin.sprites).length} 個表情</span>
                                        {activeSkinId === skin.id && <span className="text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-full font-bold">使用中</span>}
                                    </div>
                                    <div className="flex items-center gap-1">
                                        {activeSkinId !== skin.id && (
                                            <button onClick={() => handleActivateSkin(skin.id)} className="text-[10px] text-primary font-bold px-2 py-1 rounded-lg hover:bg-primary/5 transition-colors">激活</button>
                                        )}
                                        <button onClick={() => setEditingSkinId(editingSkinId === skin.id ? null : skin.id)} className="text-[10px] text-slate-500 px-2 py-1 rounded-lg hover:bg-slate-100 transition-colors">
                                            {editingSkinId === skin.id ? '收起' : '編輯'}
                                        </button>
                                        <button onClick={() => handleDeleteSkinSet(skin.id)} className="text-slate-300 hover:text-red-400 transition-colors p-1">
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                                        </button>
                                    </div>
                                </div>

                                {/* Expanded edit view */}
                                {editingSkinId === skin.id && (
                                    <div className="border-t border-slate-100 p-3">
                                        <div className="grid grid-cols-3 gap-2 mb-3">
                                            {[...REQUIRED_EMOTIONS, ...(char.customDateSprites || [])].map(emoKey => (
                                                <div key={emoKey} onClick={() => triggerSkinSpriteUpload(skin.id, emoKey)} className="flex flex-col gap-1 group cursor-pointer">
                                                    <div className={`aspect-[3/4] rounded-lg overflow-hidden relative border ${skin.sprites[emoKey] ? 'border-slate-200 bg-white' : 'border-dashed border-slate-300 bg-slate-50'} flex items-center justify-center transition-all group-hover:border-primary`}>
                                                        {skin.sprites[emoKey] ? (
                                                            <>
                                                                <TokenImg value={skin.sprites[emoKey]} className="w-full h-full object-cover" />
                                                                <div className="absolute inset-0 bg-black/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><span className="text-white text-[9px]">更換</span></div>
                                                            </>
                                                        ) : <span className="text-slate-300 text-lg">+</span>}
                                                    </div>
                                                    <div className="text-[10px] font-bold text-slate-500 capitalize text-center truncate">{emoKey}</div>
                                                </div>
                                            ))}
                                        </div>
                                        <button
                                            onClick={() => { setUrlTargetSkinId(skin.id); setShowUrlModal(true); }}
                                            className="w-full py-2 bg-slate-50 text-slate-500 text-[11px] font-medium rounded-lg hover:bg-slate-100 transition-colors"
                                        >
                                            + 通過 URL 添加立繪到此皮膚
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {/* Create new skin set */}
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={newSkinName}
                            onChange={e => setNewSkinName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleCreateSkinSet(); }}
                            placeholder="皮膚名稱 (如 冬裝、泳裝...)"
                            className="flex-1 px-4 py-3 bg-slate-100 rounded-xl text-sm focus:ring-1 focus:ring-primary/30 outline-none transition-all"
                        />
                        <button
                            onClick={handleCreateSkinSet}
                            disabled={!newSkinName.trim()}
                            className="px-5 py-3 bg-primary text-white text-sm font-bold rounded-xl disabled:opacity-40 active:scale-95 transition-all"
                        >
                            創建
                        </button>
                    </div>
                </Section>

                <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFileUpload} />
            </div>

            {/* URL Input Modal */}
            {showUrlModal && (
                <div className="fixed inset-0 z-[300] bg-black/40 backdrop-blur-sm flex items-center justify-center p-6" onClick={() => setShowUrlModal(false)}>
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
                        <div className="p-4 border-b border-slate-100">
                            <h3 className="font-bold text-slate-700 text-sm">通過 URL 添加立繪</h3>
                            <p className="text-[11px] text-slate-400 mt-1">{urlTargetSkinId ? `目標: ${skinSets.find(s => s.id === urlTargetSkinId)?.name}` : '目標: 默認立繪'}</p>
                        </div>
                        <div className="p-4 space-y-3">
                            <div>
                                <label className="text-[11px] text-slate-500 font-bold mb-1 block">情緒</label>
                                <select
                                    value={skinUrlEmotionKey}
                                    onChange={e => setSkinUrlEmotionKey(e.target.value)}
                                    className="w-full px-3 py-2.5 bg-slate-100 rounded-xl text-sm outline-none"
                                >
                                    <option value="">選擇情緒...</option>
                                    {[...REQUIRED_EMOTIONS, ...(char.customDateSprites || [])].map(k => (
                                        <option key={k} value={k}>{k}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="text-[11px] text-slate-500 font-bold mb-1 block">圖片 URL</label>
                                <input
                                    type="text"
                                    value={skinUrlInput}
                                    onChange={e => setSkinUrlInput(e.target.value)}
                                    placeholder="https://example.com/sprite.png"
                                    className="w-full px-3 py-2.5 bg-slate-100 rounded-xl text-sm outline-none focus:ring-1 focus:ring-primary/30"
                                />
                            </div>
                            {skinUrlInput && skinUrlInput.startsWith('http') && (
                                <div className="bg-slate-50 rounded-xl p-2 flex items-center justify-center h-24">
                                    <img src={skinUrlInput} className="max-h-full max-w-full object-contain rounded" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                </div>
                            )}
                        </div>
                        <div className="p-4 border-t border-slate-100 flex gap-2">
                            <button onClick={() => setShowUrlModal(false)} className="flex-1 py-2.5 bg-slate-100 text-slate-600 font-bold text-sm rounded-xl">取消</button>
                            <button onClick={handleUrlSubmit} disabled={!skinUrlInput.trim() || !skinUrlEmotionKey} className="flex-1 py-2.5 bg-primary text-white font-bold text-sm rounded-xl disabled:opacity-40 active:scale-95 transition-all">確認添加</button>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
};

export default CharacterSpriteManager;
