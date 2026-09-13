
import React, { useState, useEffect } from 'react';
import { APIConfig, ImageGenApiConfig } from '../../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from '../../utils/apiConfigNormalize';
import { extractModelIds } from '../../utils/modelList';
import { safeResponseJson } from '../../utils/safeApi';
import { generateImage } from '../../utils/imageGeneration';

interface ImageGenSettingsPanelProps {
    apiConfig: APIConfig;
    updateApiConfig: (updates: Partial<APIConfig>) => void;
}

const DEFAULT_TEST_PROMPT = '一只趴在窗台上晒太阳的橘猫，插画风格';

const ImageGenSettingsPanel: React.FC<ImageGenSettingsPanelProps> = ({ apiConfig, updateApiConfig }) => {
    const cfg = apiConfig.imageGenConfig;

    const [charImageGenEnabled, setCharImageGenEnabled] = useState(!!cfg?.charImageGenEnabled);
    const [charImageSendEnabled, setCharImageSendEnabled] = useState(!!cfg?.charImageSendEnabled);
    const [url, setUrl] = useState(cfg?.baseUrl || '');
    const [key, setKey] = useState(cfg?.apiKey || '');
    const [model, setModel] = useState(cfg?.model || '');
    const [size, setSize] = useState(cfg?.size || '1024x1024');
    const [quality, setQuality] = useState(cfg?.quality || '');
    const [extraPrompt, setExtraPrompt] = useState(cfg?.extraPrompt || '');

    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [showModelModal, setShowModelModal] = useState(false);
    const [isLoadingModels, setIsLoadingModels] = useState(false);
    const [statusMsg, setStatusMsg] = useState('');

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
        setSize(cfg?.size || '1024x1024');
        setQuality(cfg?.quality || '');
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
        if (!baseUrl) { setStatusMsg('请先填写 URL'); return; }
        setIsLoadingModels(true);
        setStatusMsg('正在连接...');
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
                if (!models.includes(model)) setModel(models[0]);
                setStatusMsg(`获取到 ${models.length} 个模型`);
                setShowModelModal(true);
            } else {
                setStatusMsg('模型列表为空或格式不兼容');
            }
        } catch (error: any) {
            setStatusMsg(`连接失败${error?.message ? `：${error.message}` : ''}`);
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
                setTestConnectionResult('✅ 连接成功');
            } else {
                const text = await response.text().catch(() => '');
                setTestConnectionResult(`❌ HTTP ${response.status}: ${text.slice(0, 100)}`);
            }
        } catch (error: any) {
            setTestConnectionResult(`❌ 连接失败: ${error?.message || ''}`);
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
            setTestGenResult({ error: error?.message || '生成失败' });
        } finally {
            setTestingGen(false);
        }
    };

    return (
        <div className="space-y-4">
            <p className="text-[11px] text-slate-400 leading-relaxed pl-1">
                角色生图用的独立引擎（一般填 OpenAI 兼容的图片生成接口）。两个开关分别控制「能不能生图」和「角色能不能在聊天里自己发图」。
            </p>

            <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3">
                <div className="min-w-0 flex-1 pr-3">
                    <p className="text-xs font-bold text-slate-700">开启角色生图</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">总开关，关闭后测试生图和角色发图都不可用。</p>
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
                    <p className="text-xs font-bold text-slate-700">允许角色发图</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">角色在聊天里自主决定发图，暂未接入自动发送流程，后续版本再接。</p>
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
                        {isLoadingModels ? 'Fetching...' : '刷新模型列表'}
                    </button>
                </div>
                <button
                    onClick={() => setShowModelModal(true)}
                    title={model || 'Select Model...'}
                    className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-3 text-sm text-slate-700 flex justify-between items-center gap-2 active:bg-white transition-all shadow-sm"
                >
                    <span className="font-mono overflow-hidden whitespace-nowrap min-w-0 flex-1 text-left" style={{ direction: 'rtl', textOverflow: 'ellipsis' }}>
                        <bdi style={{ direction: 'ltr' }}>{model || 'Select Model...'}</bdi>
                    </span>
                </button>
                {showModelModal && (
                    <div className="mt-2 max-h-40 overflow-y-auto rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
                        {availableModels.length === 0 ? (
                            <div className="px-3 py-2 text-[11px] text-slate-400">
                                列表为空，可手动输入或点击"刷新模型列表"拉取
                            </div>
                        ) : availableModels.map(m => (
                            <button
                                key={m}
                                onClick={() => { setModel(m); setShowModelModal(false); }}
                                className={`w-full text-left px-3 py-2 text-xs font-mono ${m === model ? 'text-primary font-bold' : 'text-slate-600'}`}
                            >
                                {m}
                            </button>
                        ))}
                        <button onClick={() => setShowModelModal(false)} className="w-full text-center px-3 py-2 text-[11px] text-slate-400">
                            关闭
                        </button>
                    </div>
                )}
                <input
                    type="text"
                    value={model}
                    onChange={e => setModel(e.target.value)}
                    placeholder="也可以直接手打 model 名称"
                    className="mt-2 w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2 text-xs font-mono focus:bg-white transition-all"
                />
            </div>

            <div className="grid grid-cols-2 gap-2">
                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Size</label>
                    <input
                        type="text"
                        value={size}
                        onChange={e => setSize(e.target.value)}
                        placeholder="1024x1024"
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                    />
                </div>
                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Quality</label>
                    <input
                        type="text"
                        value={quality}
                        onChange={e => setQuality(e.target.value)}
                        placeholder="standard / hd"
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                    />
                </div>
            </div>

            <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">补充提示词</label>
                <textarea
                    value={extraPrompt}
                    onChange={e => setExtraPrompt(e.target.value)}
                    placeholder="拼在每次生成请求正文提示词后面，如画风、画质要求"
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
                {testingConnection ? '测试中...' : '🧪 测试连接'}
            </button>
            {testConnectionResult && <p className="text-[11px] text-slate-500 px-1">{testConnectionResult}</p>}

            <div className="pt-2 border-t border-slate-100 space-y-2">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block pl-1">测试生图</label>
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
                    {testingGen ? '生成中...' : '🖼️ 测试生图'}
                </button>
                {!charImageGenEnabled && <p className="text-[10px] text-amber-600">先打开上面「开启角色生图」才能测试。</p>}
                {testGenResult?.error && <p className="text-[11px] text-red-500 px-1">❌ {testGenResult.error}</p>}
                {testGenResult?.dataUrl && (
                    <img src={testGenResult.dataUrl} alt="测试生图结果" className="w-full rounded-2xl border border-slate-200" />
                )}
            </div>
        </div>
    );
};

export default React.memo(ImageGenSettingsPanel);
