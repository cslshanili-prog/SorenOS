
import React, { useState, useEffect } from 'react';
import { CharacterProfile, ApiPreset, APIConfig } from '../../types';
import { safeResponseJson, extractContent } from '../../utils/safeApi';

interface ChatApiSettingsPanelProps {
    char: CharacterProfile;
    apiPresets: ApiPreset[];
    addApiPreset: (name: string, config: APIConfig) => void;
    onSave: (config: CharacterProfile['chatApi']) => void;
}

const ChatApiSettingsPanel: React.FC<ChatApiSettingsPanelProps> = ({
    char, apiPresets, addApiPreset, onSave
}) => {
    const [mode, setMode] = useState<'global' | 'custom'>('global');
    const [url, setUrl] = useState('');
    const [key, setKey] = useState('');
    const [model, setModel] = useState('');
    const [showSavePreset, setShowSavePreset] = useState(false);
    const [newPresetName, setNewPresetName] = useState('');
    const [dirty, setDirty] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<string | null>(null);

    // Sync form state from character
    useEffect(() => {
        const api = char.chatApi;
        setMode(api?.baseUrl ? 'custom' : 'global');
        setUrl(api?.baseUrl ?? '');
        setKey(api?.apiKey ?? '');
        setModel(api?.model ?? '');
        setShowSavePreset(false);
        setNewPresetName('');
        setDirty(false);
        setTestResult(null);
    }, [char.id]);

    // 跟系統設置的「測試連接」同一種測法：真的發一句 Hi，看模型有沒有回。
    // 測的是輸入框裡現在的值，不用先保存。
    const canTest = !!(url.trim() && key.trim() && model.trim());
    const handleTest = async () => {
        if (!canTest || testing) return;
        setTesting(true);
        setTestResult(null);
        try {
            const res = await fetch(`${url.trim().replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key.trim()}` },
                body: JSON.stringify({ model: model.trim(), messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 }),
            });
            if (res.ok) {
                const reply = extractContent(await safeResponseJson(res));
                setTestResult(`✅ 連接成功 — 模型回覆: "${reply.slice(0, 30)}"`);
            } else {
                const text = await res.text().catch(() => '');
                setTestResult(`❌ HTTP ${res.status}: ${text.slice(0, 100)}`);
            }
        } catch (err: any) {
            setTestResult(`❌ 連接失敗: ${err?.message || err}`);
        } finally {
            setTesting(false);
        }
    };

    const loadPreset = (preset: ApiPreset) => {
        setUrl(preset.config.baseUrl);
        setKey(preset.config.apiKey);
        setModel(preset.config.model);
        setMode('custom');
        setDirty(true);
        setTestResult(null);
    };

    const handleSavePreset = () => {
        if (!newPresetName.trim()) return;
        addApiPreset(newPresetName.trim(), { baseUrl: url, apiKey: key, model });
        setNewPresetName('');
        setShowSavePreset(false);
    };

    const handleSave = () => {
        const api = mode === 'custom' && url ? { baseUrl: url, apiKey: key, model } : undefined;
        onSave(api);
        setDirty(false);
    };

    return (
        <div className="space-y-4">
            <div>
                <div className="text-xs font-bold text-slate-700 mb-1">🧠 對話模型 API</div>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                    這個角色私聊用哪個 API / 模型回覆。選「全局API」跟系統設置一致；選「自定義」可以單獨為這個角色配一個不同的 API。
                </p>
            </div>

            <div className="flex gap-2">
                <button
                    onClick={() => { setMode('global'); setDirty(true); }}
                    className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all border ${
                        mode === 'global'
                            ? 'bg-violet-100 border-violet-300 text-violet-700'
                            : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                    }`}
                >
                    全局API
                </button>
                <button
                    onClick={() => { setMode('custom'); setDirty(true); }}
                    className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all border ${
                        mode === 'custom'
                            ? 'bg-violet-100 border-violet-300 text-violet-700'
                            : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                    }`}
                >
                    自定義
                </button>
            </div>

            {mode === 'custom' && (
                <div className="space-y-3">
                    {apiPresets.length > 0 && (
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">我的預設</label>
                            <div className="flex gap-2 flex-wrap">
                                {apiPresets.map(preset => (
                                    <button
                                        key={preset.id}
                                        onClick={() => loadPreset(preset)}
                                        className="flex items-center bg-white border border-slate-200 rounded-lg px-3 py-1 shadow-sm text-xs font-medium text-slate-600 hover:text-pink-500 hover:border-pink-200 active:scale-95 transition-all"
                                    >
                                        {preset.name}
                                        <span className="ml-1.5 text-slate-300">{preset.config.model}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="flex items-center justify-between mb-0.5">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">角色專屬 API 配置</label>
                        <button
                            onClick={() => setShowSavePreset(!showSavePreset)}
                            className="text-[10px] bg-slate-100 text-slate-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform"
                        >
                            保存為預設
                        </button>
                    </div>

                    {showSavePreset && (
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={newPresetName}
                                onChange={e => setNewPresetName(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && handleSavePreset()}
                                placeholder="預設名稱..."
                                className="flex-1 bg-white/50 border border-slate-200/60 rounded-xl px-3 py-2 text-sm focus:bg-white transition-all"
                                autoFocus
                            />
                            <button
                                onClick={handleSavePreset}
                                className="px-4 py-2 bg-pink-500 text-white text-sm font-bold rounded-xl active:scale-95 transition-transform"
                            >
                                保存
                            </button>
                        </div>
                    )}

                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                        <input
                            type="text"
                            value={url}
                            onChange={e => { setUrl(e.target.value); setDirty(true); setTestResult(null); }}
                            placeholder="https://api.example.com/v1"
                            className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                        <input
                            type="password"
                            value={key}
                            onChange={e => { setKey(e.target.value); setDirty(true); setTestResult(null); }}
                            placeholder="sk-..."
                            className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Model</label>
                        <input
                            type="text"
                            value={model}
                            onChange={e => { setModel(e.target.value); setDirty(true); setTestResult(null); }}
                            placeholder="claude-haiku-4-5 / gpt-4o-mini / ..."
                            className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                        />
                    </div>

                    <button
                        onClick={handleTest}
                        disabled={testing || !canTest}
                        className={`w-full py-2.5 rounded-xl text-xs font-bold border active:scale-95 transition-all ${
                            testing || !canTest
                                ? 'border-slate-200 text-slate-400 bg-slate-50'
                                : 'border-violet-200 text-violet-600 bg-violet-50 hover:bg-violet-100'
                        }`}
                    >
                        {testing ? '測試中...' : '🧪 測試連接'}
                    </button>
                    {testResult && (
                        <div className={`text-xs px-3 py-2 rounded-xl break-all ${
                            testResult.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                        }`}>
                            {testResult}
                        </div>
                    )}
                </div>
            )}

            {mode === 'global' && (
                <div className="text-[11px] text-slate-400 bg-slate-50 border border-dashed border-slate-200 rounded-lg px-3 py-2">
                    當前跟隨系統設置裡的全局 API（{char.chatApi ? '本次切換尚未保存' : '未單獨配置'}）。
                </div>
            )}

            <button
                onClick={handleSave}
                disabled={!dirty}
                className={`w-full py-2.5 rounded-xl text-xs font-bold transition-all ${
                    dirty
                        ? 'bg-pink-500 text-white shadow-md active:scale-95'
                        : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                }`}
            >
                {dirty ? '保存對話模型設置' : '✓ 已保存'}
            </button>
        </div>
    );
};

export default React.memo(ChatApiSettingsPanel);
