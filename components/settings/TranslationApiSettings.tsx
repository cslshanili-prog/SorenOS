import React, { useEffect, useState } from 'react';
import type { APIConfig, ApiPreset, TranslationApiConfig, TranslationProvider } from '../../types';
import { TRANSLATION_PROVIDERS, translateTexts, translationReadiness } from '../../utils/translateApi';

const TEST_TEXT = 'Hey, you okay? I saved you the last slice of cake.';

const Field: React.FC<{ label: string; value: string; onChange: (v: string) => void; placeholder?: string; secret?: boolean; mono?: boolean }> = ({ label, value, onChange, placeholder, secret, mono }) => (
    <div>
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">{label}</label>
        <input
            type={secret ? 'password' : 'text'}
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder}
            aria-label={label}
            autoComplete="off"
            className={`w-full bg-white/60 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm focus:bg-white transition-all ${mono ? 'font-mono' : ''}`}
        />
    </div>
);

/**
 * 系統設置 →「翻譯 API」（plans/chat-language.md 第 2 批）。
 * 草稿在這裡改，按「保存」才寫回 apiConfig.translationApi。Key 只存這台裝置。
 */
const TranslationApiSettings: React.FC<{
    apiConfig: APIConfig;
    updateApiConfig: (updates: Partial<APIConfig>) => void;
    apiPresets: ApiPreset[];
}> = ({ apiConfig, updateApiConfig, apiPresets }) => {
    const saved = apiConfig.translationApi;
    const [draft, setDraft] = useState<TranslationApiConfig>(() => saved || { provider: 'llm' });
    const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
    const [testing, setTesting] = useState(false);
    useEffect(() => { setDraft(apiConfig.translationApi || { provider: 'llm' }); }, [apiConfig.translationApi]);

    const set = (patch: Partial<TranslationApiConfig>) => { setDraft(d => ({ ...d, ...patch })); setTest(null); };
    const dirty = JSON.stringify(draft) !== JSON.stringify(saved || { provider: 'llm' });
    const draftConfig: APIConfig = { ...apiConfig, translationApi: draft };
    const readiness = translationReadiness(draftConfig);

    const save = () => {
        const clean: TranslationApiConfig = { provider: draft.provider };
        for (const k of ['baseUrl', 'apiKey', 'model', 'deeplKey', 'googleKey', 'azureKey', 'azureRegion'] as const) {
            const v = draft[k]?.trim();
            if (v) clean[k] = v;
        }
        updateApiConfig({ translationApi: clean });
    };

    const runTest = async () => {
        setTesting(true);
        setTest(null);
        try {
            const [out] = await translateTexts([TEST_TEXT], '繁體中文', draftConfig);
            setTest({ ok: true, text: out });
        } catch (e: any) {
            setTest({ ok: false, text: e?.message || '翻譯失敗' });
        } finally {
            setTesting(false);
        }
    };

    const p = draft.provider;
    return (
        <div className="space-y-4" data-translation-api>
            <p className="text-[10px] text-slate-400 leading-relaxed px-1">
                聊天語言選了「先寫再翻」的角色，和「我的訊息自動譯出」會用這裡翻。沒特別設就用主 API 的聊天模型。
                Key 只存在這台裝置。
            </p>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="翻譯服務">
                {TRANSLATION_PROVIDERS.map(opt => (
                    <button key={opt.value} type="button" role="radio" aria-checked={p === opt.value}
                        onClick={() => set({ provider: opt.value as TranslationProvider })}
                        className={`rounded-2xl border px-3 py-2.5 text-left transition-colors ${p === opt.value ? 'border-sky-300 bg-sky-50' : 'border-slate-200 bg-white'}`}>
                        <span className={`block text-[12px] font-bold ${p === opt.value ? 'text-sky-700' : 'text-slate-600'}`}>{opt.label}</span>
                        <span className="block mt-0.5 text-[10px] leading-snug text-slate-400">{opt.hint}</span>
                    </button>
                ))}
            </div>

            {p === 'llm' && (
                <div className="space-y-3">
                    {apiPresets.length > 0 && (
                        <div className="rounded-2xl border border-sky-100 bg-white/70 p-3">
                            <div className="text-[10px] font-bold text-sky-500 uppercase tracking-widest mb-2">從模型預設載入</div>
                            <div className="flex gap-2 flex-wrap">
                                {apiPresets.map(preset => (
                                    <button key={preset.id} type="button"
                                        onClick={() => set({ baseUrl: preset.config.baseUrl, apiKey: preset.config.apiKey, model: preset.config.model })}
                                        className="max-w-full px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-[11px] font-medium text-slate-500 truncate">
                                        {preset.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    <Field label="URL" value={draft.baseUrl || ''} onChange={v => set({ baseUrl: v })} placeholder="留空＝用主 API" mono />
                    <Field label="Key" value={draft.apiKey || ''} onChange={v => set({ apiKey: v })} placeholder="留空＝用主 API" secret mono />
                    <Field label="Model" value={draft.model || ''} onChange={v => set({ model: v })} placeholder="留空＝用主 API 的模型" mono />
                </div>
            )}
            {p === 'deepl' && (
                <div className="space-y-2">
                    <Field label="DeepL Key" value={draft.deeplKey || ''} onChange={v => set({ deeplKey: v })} placeholder="Free 版結尾是 :fx" secret mono />
                    <p className="text-[10px] text-slate-400 leading-relaxed px-1">DeepL 不讓瀏覽器直接呼叫，會經過你在「主動消息 2.0」設好的 Worker 轉一手（Worker 要是 2026-11-15 之後的版本）。Key 每次帶過去，Worker 不存。</p>
                </div>
            )}
            {p === 'google' && (
                <Field label="Google API Key" value={draft.googleKey || ''} onChange={v => set({ googleKey: v })} placeholder="Cloud Translation API" secret mono />
            )}
            {p === 'azure' && (
                <div className="space-y-3">
                    <Field label="Azure Key" value={draft.azureKey || ''} onChange={v => set({ azureKey: v })} secret mono />
                    <Field label="區域" value={draft.azureRegion || ''} onChange={v => set({ azureRegion: v })} placeholder="例如 eastasia" mono />
                </div>
            )}

            {!readiness.ready && <p className="text-[11px] text-amber-600 px-1">{readiness.reason}</p>}

            <div className="flex gap-2">
                <button type="button" onClick={runTest} disabled={!readiness.ready || testing}
                    className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-[12px] font-bold text-slate-600 disabled:opacity-40">
                    {testing ? '翻譯中…' : '測試一句'}
                </button>
                <button type="button" onClick={save} disabled={!dirty}
                    className="flex-1 rounded-xl bg-sky-500 py-2.5 text-[12px] font-bold text-white disabled:bg-slate-200 disabled:text-slate-400">
                    保存
                </button>
            </div>
            {test && (
                <div className={`rounded-xl px-3 py-2 text-[11px] leading-relaxed ${test.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600'}`} data-translation-test>
                    {test.ok ? <>「{TEST_TEXT}」→「{test.text}」</> : test.text}
                </div>
            )}
        </div>
    );
};

export default TranslationApiSettings;
