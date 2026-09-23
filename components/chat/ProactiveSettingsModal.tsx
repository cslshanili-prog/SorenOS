
import React, { useState, useEffect } from 'react';
import Modal from '../os/Modal';
import { ApiPreset, APIConfig, CharacterProfile } from '../../types';
import { normalizeApiBaseUrl, normalizeApiCredential } from '../../utils/apiConfigNormalize';
import { extractModelIds } from '../../utils/modelList';
import { safeResponseJson } from '../../utils/safeApi';

interface ProactiveSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    char: CharacterProfile;
    isProactiveActive: boolean;
    onSave: (config: NonNullable<CharacterProfile['proactiveConfig']>) => void;
    onStop: () => void;
    apiPresets: ApiPreset[];
    onAddApiPreset: (name: string, config: APIConfig) => void;
}

const INTERVAL_OPTIONS = [
    { label: '30 分鐘', value: 30 },
    { label: '1 小時', value: 60 },
    { label: '2 小時', value: 120 },
    { label: '4 小時', value: 240 },
    { label: '8 小時', value: 480 },
    { label: '12 小時', value: 720 },
    { label: '24 小時', value: 1440 },
];

const ProactiveSettingsModal: React.FC<ProactiveSettingsModalProps> = ({
    isOpen, onClose, char, isProactiveActive, onSave, onStop, apiPresets, onAddApiPreset
}) => {
    const saved = char.proactiveConfig;
    const [enabled, setEnabled] = useState(saved?.enabled ?? false);
    const [interval, setInterval_] = useState(saved?.intervalMinutes ?? 60);
    const [useSecondaryApi, setUseSecondaryApi] = useState(saved?.useSecondaryApi ?? false);
    const [secUrl, setSecUrl] = useState(saved?.secondaryApi?.baseUrl ?? '');
    const [secKey, setSecKey] = useState(saved?.secondaryApi?.apiKey ?? '');
    const [secModel, setSecModel] = useState(saved?.secondaryApi?.model ?? '');
    const [showApiSection, setShowApiSection] = useState(saved?.useSecondaryApi ?? false);
    const [showSavePreset, setShowSavePreset] = useState(false);
    const [newPresetName, setNewPresetName] = useState('');
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [showModelModal, setShowModelModal] = useState(false);
    const [isLoadingModels, setIsLoadingModels] = useState(false);
    const [modelSearchQuery, setModelSearchQuery] = useState('');
    const [modelStatusMsg, setModelStatusMsg] = useState('');
    const [testingConnection, setTestingConnection] = useState(false);
    const [testConnectionResult, setTestConnectionResult] = useState<string | null>(null);

    // Reset form when modal opens with new char data
    useEffect(() => {
        if (isOpen) {
            const s = char.proactiveConfig;
            setEnabled(s?.enabled ?? false);
            setInterval_(s?.intervalMinutes ?? 60);
            setUseSecondaryApi(s?.useSecondaryApi ?? false);
            setSecUrl(s?.secondaryApi?.baseUrl ?? '');
            setSecKey(s?.secondaryApi?.apiKey ?? '');
            setSecModel(s?.secondaryApi?.model ?? '');
            setShowApiSection(s?.useSecondaryApi ?? false);
            setShowSavePreset(false);
            setNewPresetName('');
            setTestConnectionResult(null);
        }
    }, [isOpen, char.id]);

    const handleSave = () => {
        onSave({
            enabled,
            intervalMinutes: interval,
            useSecondaryApi: useSecondaryApi && !!secUrl,
            secondaryApi: useSecondaryApi && secUrl ? {
                baseUrl: secUrl,
                apiKey: secKey,
                model: secModel,
            } : undefined,
        });
        onClose();
    };

    const handleStop = () => {
        onStop();
        setEnabled(false);
        onClose();
    };

    const loadPreset = (preset: ApiPreset) => {
        setSecUrl(preset.config.baseUrl);
        setSecKey(preset.config.apiKey);
        setSecModel(preset.config.model);
        setTestConnectionResult(null);
    };

    const handleSavePreset = () => {
        if (!newPresetName.trim()) return;
        onAddApiPreset(newPresetName.trim(), { baseUrl: secUrl, apiKey: secKey, model: secModel });
        setNewPresetName('');
        setShowSavePreset(false);
    };

    const fetchModels = async () => {
        const baseUrl = normalizeApiBaseUrl(secUrl);
        const key = normalizeApiCredential(secKey);
        if (!baseUrl) { setModelStatusMsg('請先填寫 URL'); return; }
        setIsLoadingModels(true);
        setModelStatusMsg('正在連接...');
        try {
            const response = await fetch(`${baseUrl}/models`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await safeResponseJson(response);
            const models = extractModelIds(data);
            if (models.length > 0) {
                setAvailableModels(models);
                setModelSearchQuery('');
                setModelStatusMsg(`獲取到 ${models.length} 個模型`);
                setShowModelModal(true);
            } else {
                setModelStatusMsg('模型列表為空或格式不兼容');
            }
        } catch (error: any) {
            setModelStatusMsg(`連接失敗${error?.message ? `：${error.message}` : ''}`);
        } finally {
            setIsLoadingModels(false);
        }
    };

    const handleTestConnection = async () => {
        const baseUrl = normalizeApiBaseUrl(secUrl);
        if (!baseUrl) return;
        setTestingConnection(true);
        setTestConnectionResult(null);
        try {
            const response = await fetch(`${baseUrl}/models`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${normalizeApiCredential(secKey)}`, 'Content-Type': 'application/json' },
            });
            if (response.ok) {
                setTestConnectionResult('✅ 連接成功');
            } else {
                const text = await response.text().catch(() => '');
                setTestConnectionResult(`❌ HTTP ${response.status}${text ? `：${text.slice(0, 100)}` : ''}`);
            }
        } catch (error: any) {
            setTestConnectionResult(`❌ 連接失敗${error?.message ? `：${error.message}` : ''}`);
        } finally {
            setTestingConnection(false);
        }
    };

    return (
        <Modal isOpen={isOpen} title="主動消息" onClose={onClose} footer={
            <>
                <button onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">
                    取消
                </button>
                {isProactiveActive ? (
                    <button onClick={handleStop} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl active:scale-95 transition-transform shadow-lg">
                        停止
                    </button>
                ) : null}
                <button onClick={handleSave} className="flex-1 py-3 bg-violet-500 text-white font-bold rounded-2xl active:scale-95 transition-transform shadow-lg">
                    {enabled ? '啟動' : '保存'}
                </button>
            </>
        }>
            <div className="space-y-5">
                {/* Description */}
                <p className="text-xs text-slate-400 leading-relaxed">
                    開啟後，{char.name} 會按照設定的間隔主動給你發消息，就像真人一樣隨手發來一條。
                </p>

                {/* Enable Toggle */}
                <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-700">啟用主動消息</span>
                    <button
                        onClick={() => setEnabled(!enabled)}
                        className={`w-12 h-7 rounded-full transition-colors relative ${enabled ? 'bg-violet-500' : 'bg-slate-200'}`}
                    >
                        <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                </div>

                {/* Status indicator */}
                {isProactiveActive && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-violet-50 rounded-xl border border-violet-100">
                        <span className="w-2 h-2 bg-violet-500 rounded-full animate-pulse" />
                        <span className="text-xs text-violet-600 font-medium">主動消息進行中</span>
                    </div>
                )}

                {/* Interval Selection */}
                {enabled && (
                    <>
                        <div>
                            <label className="text-sm font-bold text-slate-700 block mb-2">發送間隔</label>
                            <div className="grid grid-cols-3 gap-2">
                                {INTERVAL_OPTIONS.map(opt => (
                                    <button
                                        key={opt.value}
                                        onClick={() => setInterval_(opt.value)}
                                        className={`py-2 px-3 rounded-xl text-xs font-bold transition-all ${interval === opt.value
                                            ? 'bg-violet-500 text-white shadow-md'
                                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                                        }`}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Secondary API Toggle */}
                        <div className="pt-2 border-t border-slate-100">
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-sm font-bold text-slate-700">使用副 API</span>
                                <button
                                    onClick={() => { setUseSecondaryApi(!useSecondaryApi); setShowApiSection(!useSecondaryApi); }}
                                    className={`w-12 h-7 rounded-full transition-colors relative ${useSecondaryApi ? 'bg-violet-500' : 'bg-slate-200'}`}
                                >
                                    <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${useSecondaryApi ? 'translate-x-5' : 'translate-x-0'}`} />
                                </button>
                            </div>
                            <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
                                不開啟則依次退回：角色自己的對話模型 API → 全局主 API。
                            </p>

                            {showApiSection && (
                                <div className="space-y-2 bg-slate-50 rounded-2xl p-3">
                                    {apiPresets.length > 0 && (
                                        <div>
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">我的預設</label>
                                            <div className="flex gap-2 flex-wrap">
                                                {apiPresets.map((preset) => (
                                                    <button
                                                        key={preset.id}
                                                        onClick={() => loadPreset(preset)}
                                                        className="flex items-center bg-white border border-slate-200 rounded-lg px-3 py-1 shadow-sm text-xs font-medium text-slate-600 hover:text-violet-500 hover:border-violet-200 active:scale-95 transition-all"
                                                    >
                                                        {preset.name}
                                                        <span className="ml-1.5 text-slate-300">{preset.config.model}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    <input value={secUrl} onChange={e => { setSecUrl(e.target.value); setTestConnectionResult(null); }} placeholder="API URL" className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200" />
                                    <input type="password" value={secKey} onChange={e => { setSecKey(e.target.value); setTestConnectionResult(null); }} placeholder="API Key" className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200" />
                                    <div>
                                        <div className="flex justify-between items-center mb-1">
                                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</span>
                                            <button onClick={fetchModels} disabled={isLoadingModels} className="text-[10px] text-violet-500 font-bold">
                                                {isLoadingModels ? '拉取中...' : '刷新模型列表'}
                                            </button>
                                        </div>
                                        <input value={secModel} onChange={e => setSecModel(e.target.value)} placeholder="Model，或點右上角刷新拉取" className="w-full px-3 py-2 bg-white rounded-xl text-sm border border-slate-200" />
                                        {modelStatusMsg && <p className="text-[10px] text-slate-400 mt-1">{modelStatusMsg}</p>}
                                    </div>
                                    <div className="flex items-center gap-2 pt-1">
                                        <button
                                            onClick={handleTestConnection}
                                            disabled={testingConnection || !secUrl.trim()}
                                            className="flex-1 py-2 bg-white text-slate-600 text-xs font-bold rounded-xl border border-slate-200 disabled:opacity-50 active:scale-95 transition-transform"
                                        >
                                            {testingConnection ? '測試中...' : '🧪 測試連接'}
                                        </button>
                                        <button
                                            onClick={() => setShowSavePreset(v => !v)}
                                            className="flex-1 py-2 bg-white text-slate-600 text-xs font-bold rounded-xl border border-slate-200 active:scale-95 transition-transform"
                                        >
                                            保存為預設
                                        </button>
                                    </div>
                                    {testConnectionResult && <p className="text-[10px] text-slate-500">{testConnectionResult}</p>}
                                    {showSavePreset && (
                                        <div className="flex gap-2">
                                            <input
                                                type="text"
                                                value={newPresetName}
                                                onChange={e => setNewPresetName(e.target.value)}
                                                onKeyDown={e => e.key === 'Enter' && handleSavePreset()}
                                                placeholder="預設名稱..."
                                                className="flex-1 bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs"
                                                autoFocus
                                            />
                                            <button onClick={handleSavePreset} className="px-4 py-2 bg-violet-500 text-white text-xs font-bold rounded-xl active:scale-95 transition-transform">
                                                保存
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>

            {showModelModal && (() => {
                const query = modelSearchQuery.trim().toLowerCase();
                const filteredList = query ? availableModels.filter(m => m.toLowerCase().includes(query)) : availableModels;
                return (
                    <Modal isOpen title="選擇模型" onClose={() => setShowModelModal(false)}>
                        <div className="space-y-2">
                            <input
                                type="text"
                                value={modelSearchQuery}
                                onChange={e => setModelSearchQuery(e.target.value)}
                                placeholder="搜索模型..."
                                className="w-full bg-slate-50 border border-slate-200/60 rounded-xl px-3 py-2 text-xs font-mono"
                                autoFocus
                            />
                            <div className="max-h-72 overflow-y-auto space-y-1 no-scrollbar">
                                {filteredList.length === 0 && (
                                    <p className="text-[11px] text-slate-400 text-center py-4">沒有匹配的模型</p>
                                )}
                                {filteredList.map(m => (
                                    <button
                                        key={m}
                                        onClick={() => { setSecModel(m); setShowModelModal(false); }}
                                        className="w-full text-left px-3 py-2 rounded-xl text-xs font-mono bg-slate-50 hover:bg-violet-50 hover:text-violet-600 transition-colors"
                                    >
                                        {m}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </Modal>
                );
            })()}
        </Modal>
    );
};

export default React.memo(ProactiveSettingsModal);
