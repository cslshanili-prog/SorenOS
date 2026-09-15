
import React, { useState, useEffect } from 'react';
import { APIConfig, ImageGenApiConfig } from '../../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from '../../utils/apiConfigNormalize';
import { extractModelIds, isLikelyImageModel } from '../../utils/modelList';
import { safeResponseJson } from '../../utils/safeApi';
import { generateImage } from '../../utils/imageGeneration';

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
    const [url, setUrl] = useState(cfg?.baseUrl || '');
    const [key, setKey] = useState(cfg?.apiKey || '');
    const [model, setModel] = useState(cfg?.model || '');
    const [size, setSize] = useState(cfg?.size || SIZE_PRESETS[0]);
    const [sizeMode, setSizeMode] = useState<'preset' | 'custom'>(
        cfg?.size && !SIZE_PRESETS.includes(cfg.size) ? 'custom' : 'preset'
    );
    const [quality, setQuality] = useState(cfg?.quality || QUALITY_PRESETS[0].value);
    const [extraPrompt, setExtraPrompt] = useState(cfg?.extraPrompt || '');

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

    useEffect(() => {
        setCharImageGenEnabled(!!cfg?.charImageGenEnabled);
        setCharImageSendEnabled(!!cfg?.charImageSendEnabled);
        setUrl(cfg?.baseUrl || '');
        setKey(cfg?.apiKey || '');
        setModel(cfg?.model || '');
        setSize(cfg?.size || SIZE_PRESETS[0]);
        setSizeMode(cfg?.size && !SIZE_PRESETS.includes(cfg.size) ? 'custom' : 'preset');
        setQuality(cfg?.quality || QUALITY_PRESETS[0].value);
        setExtraPrompt(cfg?.extraPrompt || '');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const buildConfig = (): ImageGenApiConfig => ({
        charImageGenEnabled,
        charImageSendEnabled,
        baseUrl: normalizeApiBaseUrl(url),
        apiKey: normalizeApiCredential(key),
        model: normalizeApiModel(model),
        size: size.trim() || undefined,
        quality: quality.trim() || undefined,
        extraPrompt: extraPrompt.trim() || undefined,
    });

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
                // 猜不出任何生图模型时没必要默认过滤成空列表，直接退回显示全部。
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
            const result = await generateImage(buildConfig(), testPrompt.trim());
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

            <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">補充提示詞</label>
                <textarea
                    value={extraPrompt}
                    onChange={e => setExtraPrompt(e.target.value)}
                    placeholder="拼在每次生成請求正文提示詞後面，如畫風、畫質要求"
                    rows={2}
                    className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm resize-none focus:bg-white transition-all"
                />
            </div>

            <button onClick={handleSave} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg shadow-primary/20 bg-primary active:scale-95 transition-all">
                {statusMsg || '保存配置'}
            </button>

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
