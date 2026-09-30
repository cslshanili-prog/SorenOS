import React, { useState, useEffect } from 'react';
import { safeResponseJson, extractContent } from '../../utils/safeApi';

interface ApiConnectionTestProps {
    url: string;
    apiKey: string;
    model: string;
}

/**
 * 「🧪 測試連接」按鈕＋結果條。跟系統設置的「測試連接」同一種測法：真的發一句 Hi，看模型有沒有回。
 * 測的是輸入框裡現在的值，不用先保存；三個欄位任一改動，上一次的結果就作廢。
 */
const ApiConnectionTest: React.FC<ApiConnectionTestProps> = ({ url, apiKey, model }) => {
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<string | null>(null);

    useEffect(() => { setTestResult(null); }, [url, apiKey, model]);

    const canTest = !!(url.trim() && apiKey.trim() && model.trim());
    const handleTest = async () => {
        if (!canTest || testing) return;
        setTesting(true);
        setTestResult(null);
        try {
            const res = await fetch(`${url.trim().replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey.trim()}` },
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

    return (
        <>
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
        </>
    );
};

export default ApiConnectionTest;
