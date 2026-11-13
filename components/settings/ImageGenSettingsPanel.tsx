
import React, { useState, useEffect } from 'react';
import { APIConfig, ImageApiPreset, ImageGenApiConfig, ImageStylePreset } from '../../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from '../../utils/apiConfigNormalize';
import { extractModelIds, isLikelyImageModel } from '../../utils/modelList';
import { safeResponseJson } from '../../utils/safeApi';
import { generateImage } from '../../utils/imageGeneration';
import ExpandableTextarea from '../common/ExpandableTextarea';
import { clearInputFidelityUnsupported, isInputFidelityUnsupported, modelTakesInputFidelity } from '../../utils/faceLock';
import { BUILTIN_STYLES, FEATURE_OFF, IMAGE_FEATURES, newImageApiId, newStyleId, normalizeImageGenConfig, resetBuiltinStyle, restoreBuiltinStyles, STYLE_NONE } from '../../utils/imageStyle';

interface ImageGenSettingsPanelProps {
    apiConfig: APIConfig;
    updateApiConfig: (updates: Partial<APIConfig>) => void;
}

const DEFAULT_TEST_PROMPT = '一隻趴在窗台上曬太陽的橘貓，插畫風格';
const SIZE_PRESETS = ['1024x1024', '1024x1536', '1536x1024'];
const QUALITY_PRESETS: { label: string; value: string }[] = [
    { label: 'Auto', value: 'auto' },
    { label: 'Standard', value: 'standard' },
    { label: 'HD', value: 'hd' },
];

const ImageGenSettingsPanel: React.FC<ImageGenSettingsPanelProps> = ({ apiConfig, updateApiConfig }) => {
    const cfg = apiConfig.imageGenConfig;

    const [charImageGenEnabled, setCharImageGenEnabled] = useState(!!cfg?.charImageGenEnabled);
    const [charImageSendEnabled, setCharImageSendEnabled] = useState(!!cfg?.charImageSendEnabled);
    // API 庫與畫風庫（plans/image-style-presets.md）：草稿在這裡改，按「保存配置」才寫回
    const blankApi = (): ImageApiPreset => ({ id: newImageApiId(), name: '生圖 API', baseUrl: '', apiKey: '', model: '' });
    const [apis, setApis] = useState<ImageApiPreset[]>(() => (cfg?.apiPresets?.length ? cfg.apiPresets : [blankApi()]));
    const [activeApiId, setActiveApiId] = useState<string>(() => cfg?.activeApiId || apis[0].id);
    const [editingApiId, setEditingApiId] = useState<string>(() => activeApiId);
    const editingApi = apis.find(a => a.id === editingApiId) || apis[0];
    // 「這組不收 input_fidelity」記在裝置上（utils/faceLock.ts）；按重新試試後靠 tick 重讀
    const [fidelityTick, setFidelityTick] = useState(0);
    const fidelityUnsupported = React.useMemo(() => !!editingApi && isInputFidelityUnsupported(editingApi.baseUrl, editingApi.model),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [editingApi?.baseUrl, editingApi?.model, fidelityTick]);
    const patchApi = (patch: Partial<ImageApiPreset>) => setApis(list => list.map(a => (a.id === editingApi.id ? { ...a, ...patch } : a)));
    const url = editingApi.baseUrl;
    const key = editingApi.apiKey;
    const model = editingApi.model;
    const size = editingApi.size || SIZE_PRESETS[0];
    const quality = editingApi.quality || QUALITY_PRESETS[0].value;
    const setUrl = (v: string) => patchApi({ baseUrl: v });
    const setKey = (v: string) => patchApi({ apiKey: v });
    const setModel = (v: string) => patchApi({ model: v });
    const setSize = (v: string) => patchApi({ size: v });
    const setQuality = (v: string) => patchApi({ quality: v });
    const [sizeMode, setSizeMode] = useState<'preset' | 'custom'>(
        editingApi.size && !SIZE_PRESETS.includes(editingApi.size) ? 'custom' : 'preset'
    );
    useEffect(() => {
        setSizeMode(editingApi.size && !SIZE_PRESETS.includes(editingApi.size) ? 'custom' : 'preset');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editingApiId]);

    const [styles, setStyles] = useState<ImageStylePreset[]>(() => cfg?.stylePresets || BUILTIN_STYLES.map(b => ({ ...b })));
    const [globalStyleId, setGlobalStyleId] = useState<string | undefined>(cfg?.globalStyleId);
    const [openStyleId, setOpenStyleId] = useState<string | null>(null);
    const patchStyle = (id: string, patch: Partial<ImageStylePreset>) => setStyles(list => list.map(st => (st.id === id ? { ...st, ...patch } : st)));
    const [testStyleId, setTestStyleId] = useState<string>('');
    const [featureStyles, setFeatureStyles] = useState<NonNullable<ImageGenApiConfig['featureStyles']>>(() => cfg?.featureStyles || {});

    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [showModelModal, setShowModelModal] = useState(false);
    const [isLoadingModels, setIsLoadingModels] = useState(false);
    const [statusMsg, setStatusMsg] = useState('');
    const [modelSearchQuery, setModelSearchQuery] = useState('');
    const [showAllModels, setShowAllModels] = useState(false);

    const [testingConnection, setTestingConnection] = useState(false);
    const [testConnectionResult, setTestConnectionResult] = useState<string | null>(null);

    const [testPrompt, setTestPrompt] = useState(DEFAULT_TEST_PROMPT);
    const [testingGen, setTestingGen] = useState(false);
    const [testGenResult, setTestGenResult] = useState<{ dataUrl?: string; error?: string } | null>(null);


    const buildConfig = (overrideActiveApiId?: string): ImageGenApiConfig => normalizeImageGenConfig({
        charImageGenEnabled,
        charImageSendEnabled,
        apiPresets: apis.map(a => ({
            ...a,
            name: a.name.trim() || a.model.trim() || '生圖 API',
            baseUrl: normalizeApiBaseUrl(a.baseUrl),
            apiKey: normalizeApiCredential(a.apiKey),
            model: normalizeApiModel(a.model),
            size: a.size?.trim() || undefined,
            quality: a.quality?.trim() || undefined,
        })),
        activeApiId: overrideActiveApiId || activeApiId,
        stylePresets: styles.map(st => ({ ...st, name: st.name.trim() || '未命名畫風' })),
        globalStyleId,
        builtinStylesSeeded: true,
        // 生圖預設在資料庫生圖那頁存的：這裡只顯示、刪，存 API 時照舊帶上
        ...(apiConfig.imageGenConfig?.genPresets ? { genPresets: apiConfig.imageGenConfig.genPresets } : {}),
        // 指到刪掉的畫風就當跟全域
        featureStyles: Object.fromEntries(Object.entries(featureStyles).filter(([, v]) => v && (v === FEATURE_OFF || v === STYLE_NONE || styles.some(st => st.id === v)))),
    })!;

    // 畫風庫、全域畫風、各處畫風：改了就存（只寫這幾欄，API 草稿照舊等「保存 API 設定」）
    const savedCfgRef = React.useRef(apiConfig.imageGenConfig);
    savedCfgRef.current = apiConfig.imageGenConfig;
    const updateRef = React.useRef(updateApiConfig);
    updateRef.current = updateApiConfig;
    const firstStyleRun = React.useRef(true);
    useEffect(() => {
        if (firstStyleRun.current) { firstStyleRun.current = false; return; }
        const t = window.setTimeout(() => {
            const base = savedCfgRef.current || {};
            updateRef.current({ imageGenConfig: normalizeImageGenConfig({
                ...base,
                stylePresets: styles.map(st => ({ ...st, name: st.name.trim() || '未命名畫風' })),
                globalStyleId,
                builtinStylesSeeded: true,
                featureStyles: Object.fromEntries(Object.entries(featureStyles).filter(([, v]) => v && (v === FEATURE_OFF || v === STYLE_NONE || styles.some(st => st.id === v)))),
            })! });
        }, 500);
        return () => window.clearTimeout(t);
    }, [styles, globalStyleId, featureStyles]);

    const handleSave = () => {
        updateApiConfig({ imageGenConfig: buildConfig() });
        setStatusMsg('已保存');
        setTimeout(() => setStatusMsg(''), 1500);
    };

    const fetchModels = async () => {
        const baseUrl = normalizeApiBaseUrl(url);
        const apiKey = normalizeApiCredential(key);
        if (!baseUrl) { setStatusMsg('請先填寫 URL'); return; }
        setIsLoadingModels(true);
        setStatusMsg('正在連接...');
        try {
            const response = await fetch(`${baseUrl}/models`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await safeResponseJson(response);
            const models = extractModelIds(data);
            if (models.length > 0) {
                setAvailableModels(models);
                setModelSearchQuery('');
                const imageLikelyCount = models.filter(isLikelyImageModel).length;
                // 猜不出任何生圖模型時沒必要默認過濾成空列表，直接退回顯示全部。
                setShowAllModels(imageLikelyCount === 0);
                if (!models.includes(model)) setModel(models[0]);
                setStatusMsg(
                    imageLikelyCount > 0
                        ? `獲取到 ${models.length} 個模型，猜到 ${imageLikelyCount} 個可能是生圖模型`
                        : `獲取到 ${models.length} 個模型`
                );
                setShowModelModal(true);
            } else {
                setStatusMsg('模型列表為空或格式不兼容');
            }
        } catch (error: any) {
            setStatusMsg(`連接失敗${error?.message ? `：${error.message}` : ''}`);
        } finally {
            setIsLoadingModels(false);
        }
    };

    const handleTestConnection = async () => {
        const baseUrl = normalizeApiBaseUrl(url);
        if (!baseUrl || !model.trim()) return;
        setTestingConnection(true);
        setTestConnectionResult(null);
        try {
            const response = await fetch(`${baseUrl}/models`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${normalizeApiCredential(key)}`, 'Content-Type': 'application/json' },
            });
            if (response.ok) {
                setTestConnectionResult('✅ 連接成功');
            } else {
                const text = await response.text().catch(() => '');
                setTestConnectionResult(`❌ HTTP ${response.status}: ${text.slice(0, 100)}`);
            }
        } catch (error: any) {
            setTestConnectionResult(`❌ 連接失敗: ${error?.message || ''}`);
        } finally {
            setTestingConnection(false);
        }
    };

    const handleTestGenerate = async () => {
        if (!testPrompt.trim()) return;
        setTestingGen(true);
        setTestGenResult(null);
        try {
            const result = await generateImage(buildConfig(editingApi.id), testPrompt.trim(), undefined, { styleId: testStyleId || undefined });
            setTestGenResult({ dataUrl: result.dataUrl });
        } catch (error: any) {
            setTestGenResult({ error: error?.message || '生成失敗' });
        } finally {
            setTestingGen(false);
        }
    };

    return (
        <div className="space-y-4">
            <p className="text-[11px] text-slate-400 leading-relaxed pl-1">
                角色生圖用的獨立引擎（一般填 OpenAI 兼容的圖片生成接口）。兩個開關分別控制「能不能生圖」和「角色能不能在聊天裡自己發圖」。
            </p>

            <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3">
                <div className="min-w-0 flex-1 pr-3">
                    <p className="text-xs font-bold text-slate-700">開啟角色生圖</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">總開關，關閉後測試生圖和角色發圖都不可用。</p>
                </div>
                <button
                    onClick={() => setCharImageGenEnabled(v => !v)}
                    className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center flex-shrink-0 ${charImageGenEnabled ? 'bg-primary' : 'bg-slate-300'}`}
                >
                    <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${charImageGenEnabled ? 'translate-x-4' : ''}`} />
                </button>
            </div>

            <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3">
                <div className="min-w-0 flex-1 pr-3">
                    <p className="text-xs font-bold text-slate-700">允許角色發圖</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">角色在聊天裡自主決定發圖並直接發送。僅接入本地/前台聊天（含即時對話），主動消息 2.0 雲端背景生成暫未接入。</p>
                </div>
                <button
                    onClick={() => setCharImageSendEnabled(v => !v)}
                    className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center flex-shrink-0 ${charImageSendEnabled ? 'bg-primary' : 'bg-slate-300'}`}
                >
                    <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${charImageSendEnabled ? 'translate-x-4' : ''}`} />
                </button>
            </div>

            <div className="pt-2 border-t border-slate-100">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">生圖 API</label>
                <p className="text-[10px] text-slate-400 mb-2 pl-1 leading-relaxed">可以存好幾組（不同中轉、不同模型），打勾的那組是全域；畫風可以偏好某一組，那組失敗會自動改用全域那組。</p>
                <div className="flex flex-wrap gap-1.5">
                    {apis.map(a => (
                        <button key={a.id} onClick={() => setEditingApiId(a.id)} aria-pressed={a.id === editingApi.id}
                            className={`px-3 py-1.5 rounded-full text-[11px] font-bold border ${a.id === editingApi.id ? 'bg-primary text-white border-primary' : 'bg-white/60 text-slate-600 border-slate-200'}`}>
                            {a.id === activeApiId ? '✓ ' : ''}{a.name || a.model || '未命名'}
                        </button>
                    ))}
                    <button onClick={() => { const a = blankApi(); setApis(list => [...list, { ...a, name: `生圖 API ${list.length + 1}` }]); setEditingApiId(a.id); }}
                        className="px-3 py-1.5 rounded-full text-[11px] font-bold border border-dashed border-slate-300 text-slate-500">＋ 新增一組</button>
                </div>
            </div>

            <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">名稱</label>
                <input
                    type="text"
                    value={editingApi.name}
                    onChange={e => patchApi({ name: e.target.value.slice(0, 30) })}
                    placeholder="例如：主力、備用"
                    className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm focus:bg-white transition-all"
                />
            </div>

            <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                <input
                    type="text"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    placeholder="https://api.example.com/v1"
                    className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                />
            </div>
            <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                <input
                    type="password"
                    value={key}
                    onChange={e => setKey(e.target.value)}
                    placeholder="sk-..."
                    className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                />
            </div>

            <div>
                <div className="flex justify-between items-center mb-1.5 pl-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                    <button onClick={fetchModels} disabled={isLoadingModels} className="text-[10px] text-primary font-bold">
                        {isLoadingModels ? '拉取中...' : '刷新模型列表'}
                    </button>
                </div>
                <button
                    onClick={() => setShowModelModal(true)}
                    title={model || '選擇模型...'}
                    className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-3 text-sm text-slate-700 flex justify-between items-center gap-2 active:bg-white transition-all shadow-sm"
                >
                    <span className="font-mono overflow-hidden whitespace-nowrap min-w-0 flex-1 text-left" style={{ direction: 'rtl', textOverflow: 'ellipsis' }}>
                        <bdi style={{ direction: 'ltr' }}>{model || '選擇模型...'}</bdi>
                    </span>
                </button>
                {showModelModal && (() => {
                    const imageLikelyModels = availableModels.filter(isLikelyImageModel);
                    const hasImageLikely = imageLikelyModels.length > 0 && imageLikelyModels.length < availableModels.length;
                    const baseList = showAllModels || !hasImageLikely ? availableModels : imageLikelyModels;
                    const query = modelSearchQuery.trim().toLowerCase();
                    const filteredList = query ? baseList.filter(m => m.toLowerCase().includes(query)) : baseList;
                    return (
                        <div className="mt-2 rounded-xl border border-slate-200 bg-white overflow-hidden">
                            {availableModels.length > 0 && (
                                <div className="p-2 border-b border-slate-100 space-y-1.5">
                                    <input
                                        type="text"
                                        value={modelSearchQuery}
                                        onChange={e => setModelSearchQuery(e.target.value)}
                                        placeholder="搜尋模型名稱..."
                                        className="w-full bg-slate-50 border border-slate-200/60 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                                    />
                                    {hasImageLikely && (
                                        <button
                                            onClick={() => setShowAllModels(v => !v)}
                                            className="text-[10px] text-primary font-bold"
                                        >
                                            {showAllModels ? '只看可能是生圖模型的' : `顯示全部模型（${availableModels.length}）`}
                                        </button>
                                    )}
                                </div>
                            )}
                            <div className="max-h-40 overflow-y-auto divide-y divide-slate-100">
                                {availableModels.length === 0 ? (
                                    <div className="px-3 py-2 text-[11px] text-slate-400">
                                        列表為空，可手動輸入或點擊「刷新模型列表」拉取
                                    </div>
                                ) : filteredList.length === 0 ? (
                                    <div className="px-3 py-2 text-[11px] text-slate-400">
                                        沒有符合的模型
                                    </div>
                                ) : filteredList.map(m => (
                                    <button
                                        key={m}
                                        onClick={() => { setModel(m); setShowModelModal(false); }}
                                        className={`w-full text-left px-3 py-2 text-xs font-mono ${m === model ? 'text-primary font-bold' : 'text-slate-600'}`}
                                    >
                                        {m}
                                    </button>
                                ))}
                            </div>
                            <button onClick={() => setShowModelModal(false)} className="w-full text-center px-3 py-2 text-[11px] text-slate-400 border-t border-slate-100">
                                關閉
                            </button>
                        </div>
                    );
                })()}
                <input
                    type="text"
                    value={model}
                    onChange={e => setModel(e.target.value)}
                    placeholder="也可以直接手打 model 名稱"
                    className="mt-2 w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2 text-xs font-mono focus:bg-white transition-all"
                />
            </div>

            <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Size</label>
                <div className="grid grid-cols-4 gap-1.5">
                    {SIZE_PRESETS.map(preset => (
                        <button
                            key={preset}
                            onClick={() => { setSize(preset); setSizeMode('preset'); }}
                            className={`py-2 rounded-xl text-[11px] font-bold border transition-all ${
                                sizeMode === 'preset' && size === preset
                                    ? 'bg-primary text-white border-primary'
                                    : 'bg-white/50 border-slate-200/60 text-slate-600'
                            }`}
                        >
                            {preset}
                        </button>
                    ))}
                    <button
                        onClick={() => setSizeMode('custom')}
                        className={`py-2 rounded-xl text-[11px] font-bold border transition-all ${
                            sizeMode === 'custom' ? 'bg-primary text-white border-primary' : 'bg-white/50 border-slate-200/60 text-slate-600'
                        }`}
                    >
                        自行輸入
                    </button>
                </div>
                {sizeMode === 'custom' && (
                    <input
                        type="text"
                        value={size}
                        onChange={e => setSize(e.target.value)}
                        placeholder="如 1024x1024"
                        className="mt-2 w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2 text-xs font-mono focus:bg-white transition-all"
                    />
                )}
            </div>

            <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Quality</label>
                <div className="grid grid-cols-3 gap-1.5">
                    {QUALITY_PRESETS.map(preset => (
                        <button
                            key={preset.value}
                            onClick={() => setQuality(preset.value)}
                            className={`py-2 rounded-xl text-[11px] font-bold border transition-all ${
                                quality === preset.value ? 'bg-primary text-white border-primary' : 'bg-white/50 border-slate-200/60 text-slate-600'
                            }`}
                        >
                            {preset.label}
                        </button>
                    ))}
                </div>
            </div>

            <label className="flex items-start gap-2 text-[11px] text-slate-600 pl-1">
                <input type="checkbox" checked={!!editingApi.negativePromptField} onChange={e => patchApi({ negativePromptField: e.target.checked })} className="mt-0.5 accent-primary" />
                <span>這家支援 <code className="font-mono">negative_prompt</code> 欄位<span className="block text-[10px] text-slate-400">不確定就不要勾：沒勾時負面提示詞寫成「避免：…」接在正文後面；勾了才另外送欄位，不收的接口可能直接報錯。</span></span>
            </label>

            <label className="flex items-start gap-2 text-[11px] text-slate-600 pl-1">
                <input type="checkbox" checked={editingApi.inputFidelity !== 'off'} onChange={e => patchApi({ inputFidelity: e.target.checked ? undefined : 'off' })} className="mt-0.5 accent-primary" />
                <span>鎖臉「還原」時送強度參數 <code className="font-mono">input_fidelity</code>
                    <span className="block text-[10px] text-slate-400">
                        {modelTakesInputFidelity(editingApi.model) ? '只有 GPT-Image 系列有這個參數。中轉站不收（報錯）會自動拿掉重送一次，並記住之後不再送；收了卻沒傳下去的看不出來。' : '這組的模型不是 GPT-Image，不會送，只用提示詞控制鎖臉強度。'}
                    </span>
                    {modelTakesInputFidelity(editingApi.model) && fidelityUnsupported && (
                        <span className="mt-1 flex items-center gap-2 text-[10px] text-amber-600">
                            這台裝置記得這組不收（之前送了報錯）
                            <button type="button" onClick={e => { e.preventDefault(); clearInputFidelityUnsupported(editingApi.baseUrl, editingApi.model); setFidelityTick(t => t + 1); }} className="font-bold underline">重新試試</button>
                        </span>
                    )}
                </span>
            </label>

            <div className="flex gap-2">
                {editingApi.id !== activeApiId && (
                    <button onClick={() => setActiveApiId(editingApi.id)} className="flex-1 py-2 rounded-xl text-xs font-bold border border-primary/30 text-primary bg-primary/5">設為全域</button>
                )}
                {apis.length > 1 && (
                    <button onClick={() => {
                        if (!window.confirm(`刪掉「${editingApi.name || editingApi.model || '這組'}」？`)) return;
                        const rest = apis.filter(a => a.id !== editingApi.id);
                        setApis(rest);
                        if (activeApiId === editingApi.id) setActiveApiId(rest[0].id);
                        setStyles(list => list.map(st => (st.apiId === editingApi.id ? { ...st, apiId: undefined } : st)));
                        setEditingApiId(rest[0].id);
                    }} className="px-4 py-2 rounded-xl text-xs font-bold border border-slate-200 text-rose-400 bg-white/60">刪除這組</button>
                )}
            </div>

            <button onClick={handleSave} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg shadow-primary/20 bg-primary active:scale-95 transition-all">
                {statusMsg || '保存 API 設定'}
            </button>
            <p className="text-[10px] text-slate-400 -mt-2 pl-1">上面的開關和 API 按這顆存；下面的畫風庫、各處畫風改了就存。</p>

            <div className="pt-2 border-t border-slate-100 space-y-2">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block pl-1">畫風庫</label>
                <p className="text-[10px] text-slate-400 pl-1 leading-relaxed">存好幾套畫風，挑一套當全域。「畫面有人時才加」那段只在畫面裡有人時拼上去（臉、皮膚、構圖），拍咖啡、風景時不會硬塞一張臉。</p>
                <div className="flex items-center gap-2 bg-white/60 border border-slate-200/60 rounded-xl px-3 py-2">
                    <span className="text-[11px] font-bold text-slate-500 shrink-0">全域畫風</span>
                    <select value={globalStyleId || ''} onChange={e => setGlobalStyleId(e.target.value || undefined)} className="flex-1 min-w-0 bg-transparent text-xs text-slate-700 outline-none">
                        <option value="">不套畫風</option>
                        {styles.map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
                    </select>
                </div>
                {styles.map(st => {
                    const open = openStyleId === st.id;
                    return (
                        <div key={st.id} className="bg-white/60 border border-slate-200/60 rounded-xl overflow-hidden">
                            <button onClick={() => setOpenStyleId(open ? null : st.id)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left">
                                <span className="flex-1 min-w-0 truncate text-xs font-bold text-slate-700">{st.name || '未命名畫風'}</span>
                                {st.id === globalStyleId && <span className="text-[9px] font-bold text-white bg-primary rounded-full px-1.5 py-0.5">全域</span>}
                                {st.builtinKey && <span className="text-[9px] font-bold text-slate-400 bg-slate-100 rounded-full px-1.5 py-0.5">內建</span>}
                                <span className={`text-slate-400 text-xs transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden>⌄</span>
                            </button>
                            {open && (
                                <div className="px-3 pb-3 space-y-2">
                                    <input value={st.name} onChange={e => patchStyle(st.id, { name: e.target.value.slice(0, 30) })} placeholder="畫風名稱"
                                        className="w-full bg-white border border-slate-200/60 rounded-lg px-3 py-2 text-xs" />
                                    <div>
                                        <div className="text-[10px] font-bold text-slate-400 mb-1">每次都加（畫風、質感、光影、色調）</div>
                                        <ExpandableTextarea title={`${st.name}・每次都加`} value={st.prompt} onChange={v => patchStyle(st.id, { prompt: v })} rows={4}
                                            className="w-full bg-white border border-slate-200/60 rounded-lg px-3 py-2 text-xs resize-y" />
                                    </div>
                                    <div>
                                        <div className="text-[10px] font-bold text-slate-400 mb-1">畫面有人時才加（臉、皮膚、構圖）</div>
                                        <ExpandableTextarea title={`${st.name}・畫面有人時才加`} value={st.portraitPrompt || ''} onChange={v => patchStyle(st.id, { portraitPrompt: v || undefined })} rows={3}
                                            className="w-full bg-white border border-slate-200/60 rounded-lg px-3 py-2 text-xs resize-y" />
                                    </div>
                                    <div>
                                        <div className="text-[10px] font-bold text-slate-400 mb-1">避免（負面提示詞，選填）</div>
                                        <ExpandableTextarea title={`${st.name}・避免`} value={st.negativePrompt || ''} onChange={v => patchStyle(st.id, { negativePrompt: v || undefined })} rows={2}
                                            className="w-full bg-white border border-slate-200/60 rounded-lg px-3 py-2 text-xs resize-y" />
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] font-bold text-slate-400 shrink-0">偏好的 API</span>
                                        <select value={st.apiId || ''} onChange={e => patchStyle(st.id, { apiId: e.target.value || undefined })} className="flex-1 min-w-0 bg-white border border-slate-200/60 rounded-lg px-2 py-1.5 text-xs">
                                            <option value="">跟全域</option>
                                            {apis.map(a => <option key={a.id} value={a.id}>{a.name || a.model || '未命名'}</option>)}
                                        </select>
                                    </div>
                                    <div className="flex flex-wrap gap-2 pt-1">
                                        {st.id !== globalStyleId && <button onClick={() => setGlobalStyleId(st.id)} className="px-3 py-1.5 rounded-lg text-[11px] font-bold border border-primary/30 text-primary bg-primary/5">設為全域</button>}
                                        {st.builtinKey && <button onClick={() => setStyles(list => list.map(x => (x.id === st.id ? resetBuiltinStyle(x) : x)))} className="px-3 py-1.5 rounded-lg text-[11px] font-bold border border-slate-200 text-slate-500 bg-white">恢復原文</button>}
                                        <button onClick={() => {
                                            if (!window.confirm(`刪掉畫風「${st.name || '未命名'}」？`)) return;
                                            setStyles(list => list.filter(x => x.id !== st.id));
                                            if (globalStyleId === st.id) setGlobalStyleId(undefined);
                                            setOpenStyleId(null);
                                        }} className="px-3 py-1.5 rounded-lg text-[11px] font-bold border border-slate-200 text-rose-400 bg-white">刪除</button>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
                <div className="flex gap-2">
                    <button onClick={() => { const id = newStyleId(); setStyles(list => [...list, { id, name: '新畫風', prompt: '' }]); setOpenStyleId(id); }}
                        className="flex-1 py-2 rounded-xl text-xs font-bold border border-dashed border-slate-300 text-slate-500">＋ 新增畫風</button>
                    {BUILTIN_STYLES.some(b => !styles.some(st => st.builtinKey === b.builtinKey)) && (
                        <button onClick={() => setStyles(list => restoreBuiltinStyles(list))} className="px-3 py-2 rounded-xl text-xs font-bold border border-slate-200 text-slate-500 bg-white/60">恢復內建畫風</button>
                    )}
                </div>
            </div>

            <div className="pt-2 border-t border-slate-100 space-y-2">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block pl-1">各處畫風</label>
                <p className="text-[10px] text-slate-400 pl-1 leading-relaxed">每一處各自決定：跟全域、用某一套，或乾脆關掉這裡的生圖。角色、世界自己指定了畫風的，照角色、世界的；「關閉」誰也蓋不過。</p>
                <div className="bg-white/60 border border-slate-200/60 rounded-xl divide-y divide-slate-100">
                    {IMAGE_FEATURES.map(f => (
                        <div key={f.key} className="flex items-center gap-2 px-3 py-2">
                            <div className="min-w-0 flex-1">
                                <div className="text-xs font-bold text-slate-700">{f.label}</div>
                                <div className="text-[10px] text-slate-400 truncate">{f.hint}</div>
                            </div>
                            <select aria-label={`${f.label}的畫風`} value={featureStyles[f.key] || ''}
                                onChange={e => setFeatureStyles(prev => { const next = { ...prev }; if (e.target.value) next[f.key] = e.target.value; else delete next[f.key]; return next; })}
                                className={`w-32 shrink-0 bg-white border border-slate-200/60 rounded-lg px-2 py-1.5 text-[11px] ${featureStyles[f.key] === FEATURE_OFF ? 'text-rose-400' : 'text-slate-600'}`}>
                                <option value="">跟全域</option>
                                <option value={FEATURE_OFF}>關閉</option>
                                <option value={STYLE_NONE}>不套畫風</option>
                                {styles.map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
                            </select>
                        </div>
                    ))}
                </div>
            </div>


            {(apiConfig.imageGenConfig?.genPresets || []).length > 0 && (
                <div className="pt-2 border-t border-slate-100 space-y-2">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block pl-1">生圖預設</label>
                    <p className="text-[10px] text-slate-400 pl-1">在資料庫生圖的「參數」存的組合（API＋畫風＋尺寸＋畫質）。</p>
                    {(apiConfig.imageGenConfig?.genPresets || []).map(p => (
                        <div key={p.id} className="flex items-center gap-2 bg-white/60 border border-slate-200/60 rounded-xl px-3 py-2">
                            <div className="min-w-0 flex-1">
                                <div className="text-xs font-bold text-slate-700 truncate">{p.name}</div>
                                <div className="text-[10px] text-slate-400 truncate">
                                    {[apis.find(a => a.id === p.apiId)?.name || (p.apiId ? '（刪掉的 API）' : '跟設定的 API'), p.styleId === STYLE_NONE ? '不套畫風' : styles.find(st => st.id === p.styleId)?.name || '跟設定的畫風', p.size, p.quality].filter(Boolean).join(' · ')}
                                </div>
                            </div>
                            <button onClick={() => {
                                if (!window.confirm(`刪掉生圖預設「${p.name}」？`)) return;
                                const cfg = apiConfig.imageGenConfig || {};
                                updateApiConfig({ imageGenConfig: { ...cfg, genPresets: (cfg.genPresets || []).filter(x => x.id !== p.id) } });
                            }} className="shrink-0 px-2 py-1 rounded-lg text-[11px] font-bold text-rose-400 bg-white border border-slate-200">刪除</button>
                        </div>
                    ))}
                </div>
            )}

            <button
                onClick={handleTestConnection}
                disabled={testingConnection || !url.trim()}
                className={`w-full py-2.5 rounded-2xl font-bold text-sm border active:scale-95 transition-all ${
                    testingConnection || !url.trim() ? 'border-slate-200 text-slate-400 bg-slate-50' : 'border-primary/30 text-primary bg-primary/5 hover:bg-primary/10'
                }`}
            >
                {testingConnection ? '測試中...' : '🧪 測試連接'}
            </button>
            {testConnectionResult && <p className="text-[11px] text-slate-500 px-1">{testConnectionResult}</p>}

            <div className="pt-2 border-t border-slate-100 space-y-2">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block pl-1">測試生圖</label>
                <p className="text-[10px] text-slate-400 pl-1">用上面正在看的那組 API 生一張。</p>
                <select value={testStyleId} onChange={e => setTestStyleId(e.target.value)} className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-3 py-2 text-xs">
                    <option value="">畫風：跟全域</option>
                    <option value={STYLE_NONE}>畫風：不套</option>
                    {styles.map(st => <option key={st.id} value={st.id}>畫風：{st.name}</option>)}
                </select>
                <textarea
                    value={testPrompt}
                    onChange={e => setTestPrompt(e.target.value)}
                    rows={2}
                    className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm resize-none focus:bg-white transition-all"
                />
                <button
                    onClick={handleTestGenerate}
                    disabled={testingGen || !charImageGenEnabled || !url.trim() || !model.trim()}
                    className={`w-full py-2.5 rounded-2xl font-bold text-sm border active:scale-95 transition-all ${
                        testingGen || !charImageGenEnabled || !url.trim() || !model.trim()
                            ? 'border-slate-200 text-slate-400 bg-slate-50'
                            : 'border-primary/30 text-primary bg-primary/5 hover:bg-primary/10'
                    }`}
                >
                    {testingGen ? '生成中...' : '🖼️ 測試生圖'}
                </button>
                {!charImageGenEnabled && <p className="text-[10px] text-amber-600">先打開上面「開啟角色生圖」才能測試。</p>}
                {testGenResult?.error && <p className="text-[11px] text-red-500 px-1">❌ {testGenResult.error}</p>}
                {testGenResult?.dataUrl && (
                    <img src={testGenResult.dataUrl} alt="測試生圖結果" className="w-full rounded-2xl border border-slate-200" />
                )}
            </div>
        </div>
    );
};

export default React.memo(ImageGenSettingsPanel);
