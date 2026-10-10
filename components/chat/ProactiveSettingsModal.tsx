
import React, { useState, useEffect } from 'react';
import Modal from '../os/Modal';
import { ApiPreset, APIConfig, CharacterProfile } from '../../types';
import { normalizeApiBaseUrl, normalizeApiCredential } from '../../utils/apiConfigNormalize';
import { extractModelIds } from '../../utils/modelList';
import { safeResponseJson } from '../../utils/safeApi';
import { ProactiveChat } from '../../utils/proactiveChat';
import { formatProactiveRange, normalizeProactiveRange, proactiveStopIndex, PROACTIVE_INTERVAL_STOPS } from '../../utils/proactiveTiming';
import IntervalRangeSlider from './IntervalRangeSlider';

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

const Switch: React.FC<{ on: boolean; onToggle: () => void; label: string }> = ({ on, onToggle, label }) => (
    <button
        onClick={onToggle}
        aria-label={label}
        aria-pressed={on}
        className={`w-12 h-7 shrink-0 rounded-full transition-colors relative ${on ? 'bg-violet-500' : 'bg-slate-200'}`}
    >
        <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${on ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
);

const ProactiveSettingsModal: React.FC<ProactiveSettingsModalProps> = ({
    isOpen, onClose, char, isProactiveActive, onSave, onStop, apiPresets, onAddApiPreset
}) => {
    const saved = char.proactiveConfig;
    const [enabled, setEnabled] = useState(saved?.enabled ?? false);
    const initialRange = normalizeProactiveRange(saved?.intervalMinutes ?? 60, saved?.maxIntervalMinutes);
    const [interval, setInterval_] = useState(initialRange.minMinutes);
    // 最長間隔：等於最短就是固定間隔
    const [maxInterval, setMaxInterval] = useState(initialRange.maxMinutes);
    const [followChat, setFollowChat] = useState(saved?.followChat !== false);
    const [skipWhenAsleep, setSkipWhenAsleep] = useState(!!saved?.skipWhenAsleep);
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
            const r = normalizeProactiveRange(s?.intervalMinutes ?? 60, s?.maxIntervalMinutes);
            setInterval_(r.minMinutes);
            setMaxInterval(r.maxMinutes);
            setFollowChat(s?.followChat !== false);
            setSkipWhenAsleep(!!s?.skipWhenAsleep);
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
        const range = normalizeProactiveRange(interval, maxInterval);
        onSave({
            enabled,
            intervalMinutes: range.minMinutes,
            ...(range.maxMinutes > range.minMinutes ? { maxIntervalMinutes: range.maxMinutes } : {}),
            followChat,
            skipWhenAsleep,
            useSecondaryApi: useSecondaryApi && !!secUrl,
            secondaryApi: useSecondaryApi && secUrl ? {
                baseUrl: secUrl,
                apiKey: secKey,
                model: secModel,
            } : undefined,
        });
        onClose();
    };

    const nextDueAt = isOpen && isProactiveActive ? ProactiveChat.getNextDueAt(char.id) : null;
    const nextDueLabel = nextDueAt
        ? new Date(nextDueAt).toLocaleString('zh-TW', {
            ...(new Date(nextDueAt).toDateString() !== new Date().toDateString() ? { month: 'numeric', day: 'numeric' } : {}),
            hour: '2-digit', minute: '2-digit', hour12: false,
        })
        : '';
    const effectiveMax = Math.max(interval, maxInterval);
    const charLabel = char.chatNickname?.trim() || char.name;
    const rangeLabel = formatProactiveRange(interval, effectiveMax);

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
                    開啟後，{charLabel} 會按照設定的間隔主動給你發消息，就像真人一樣隨手發來一條。想讓 TA 現在就主動說一句：最後一則是 TA 說的時候，按聊天頁右上角的閃電。
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
                        <span className="text-xs text-violet-600 font-medium">主動消息進行中{nextDueLabel ? ` · 下一次約 ${nextDueLabel}` : ''}</span>
                    </div>
                )}

                {/* Interval Selection */}
                {enabled && (
                    <>
                        <div>
                            <div className="flex items-baseline justify-between mb-2">
                                <label className="text-sm font-bold text-slate-700">發送間隔</label>
                                <span className="text-xs font-bold text-violet-600">{effectiveMax > interval ? rangeLabel : `固定 ${rangeLabel}`}</span>
                            </div>
                            <IntervalRangeSlider
                                minIdx={proactiveStopIndex(interval)}
                                maxIdx={proactiveStopIndex(effectiveMax)}
                                onChange={(a, b) => { setInterval_(PROACTIVE_INTERVAL_STOPS[a]); setMaxInterval(PROACTIVE_INTERVAL_STOPS[b]); }}
                            />
                            <p className="text-[11px] text-slate-400 leading-relaxed mt-2">
                                {effectiveMax > interval
                                    ? `每次在 ${rangeLabel}之間隨機抽一個時間，不會像鬧鐘一樣準點。兩個圓點疊在一起就是固定間隔。`
                                    : `固定每 ${rangeLabel}一次。把右邊的圓點往右拉，就會在範圍裡隨機。`}
                            </p>
                        </div>

                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <div className="text-sm font-bold text-slate-700">從最後一次聊天起算</div>
                                <p className="text-[11px] text-slate-400 leading-relaxed mt-0.5">
                                    你們剛聊過就先不發，等安靜下來滿 {formatProactiveRange(interval)}才開口；關掉則從上一次主動消息起算，聊得正熱也可能插進來。
                                </p>
                            </div>
                            <Switch on={followChat} onToggle={() => setFollowChat(v => !v)} label="從最後一次聊天起算" />
                        </div>

                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <div className="text-sm font-bold text-slate-700">{charLabel} 睡覺時不發</div>
                                <p className="text-[11px] text-slate-400 leading-relaxed mt-0.5">
                                    照 {charLabel} 當天的日程判斷（要開著日程），睡著時先不發，醒來後再發。
                                </p>
                            </div>
                            <Switch on={skipWhenAsleep} onToggle={() => setSkipWhenAsleep(v => !v)} label="睡覺時不發" />
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
