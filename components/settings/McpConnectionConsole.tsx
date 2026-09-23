import React, { useMemo, useState } from 'react';
import {
    CaretDown,
    CheckCircle,
    GlobeHemisphereWest,
    LockKey,
    Plus,
    SpinnerGap,
    Trash,
    WarningCircle,
} from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { trackEvent } from '../../utils/analytics';
import {
    createMcpServer,
    getMcpUseNativeTools,
    loadMcpServers,
    resetMcpSession,
    saveMcpServers,
    setMcpUseNativeTools,
    testMcpConnection,
    type McpConnectionStage,
    type McpServerConfig,
} from '../../utils/mcpClient';

type TestState = {
    tone: 'running' | 'ok' | 'error' | 'stale';
    message: string;
};

const FieldLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <label className="mb-1.5 block text-[10px] font-bold text-slate-500">
        {children}
    </label>
);

const PortToggle: React.FC<{
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
}> = ({ checked, onChange, label }) => (
    <label className="relative inline-flex shrink-0 cursor-pointer items-center">
        <span className="sr-only">{label}</span>
        <input
            type="checkbox"
            checked={checked}
            onChange={event => onChange(event.target.checked)}
            className="peer sr-only"
        />
        <span className="h-6 w-11 rounded-full bg-slate-200 transition-colors peer-checked:bg-violet-500" />
        <span className="absolute left-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
    </label>
);

const stageCopy = (stage: McpConnectionStage): string => (
    stage === 'initialize' ? '正在協商協議與會話…' : '握手完成，正在讀取工具清單…'
);

const endpointChanged = (patch: Partial<McpServerConfig>): boolean => (
    ['url', 'token', 'customHeaders', 'proxyUrl', 'proxyKey'] as const
).some(key => Object.prototype.hasOwnProperty.call(patch, key));

const formatTestTime = (timestamp?: number): string => {
    if (!timestamp) return '';
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        }).format(timestamp);
    } catch { return ''; }
};

/**
 * SullyOS 的通用 MCP 入口。
 *
 * 不做服務商模板或關係預設；配置順序固定為
 * 端點 → 憑據 → 代理 → 適用聊天 → 實際連接測試。
 */
const McpConnectionConsole: React.FC<{
    addToast: (message: string, type?: any) => void;
    onMcpConfigChanged?: () => void;
}> = ({ addToast, onMcpConfigChanged }) => {
    const { characters, groups } = useOS();
    const [servers, setServers] = useState<McpServerConfig[]>(() => loadMcpServers());
    const [expandedId, setExpandedId] = useState<string | null>(() => loadMcpServers()[0]?.id || null);
    const [testingId, setTestingId] = useState<string | null>(null);
    const [testStates, setTestStates] = useState<Record<string, TestState>>({});
    const [useNativeTools, setUseNativeToolsState] = useState(() => getMcpUseNativeTools());

    const summary = useMemo(() => {
        const live = servers.filter(server => server.enabled && (server.tools?.length || 0) > 0);
        return {
            live: live.length,
            tools: live.reduce((count, server) => count + (server.tools?.length || 0), 0),
        };
    }, [servers]);

    const persist = (next: McpServerConfig[]) => {
        setServers(next);
        saveMcpServers(next);
        onMcpConfigChanged?.();
    };

    const update = (id: string, patch: Partial<McpServerConfig>) => {
        const mustRetest = endpointChanged(patch);
        const safePatch: Partial<McpServerConfig> = mustRetest
            ? { ...patch, enabled: false, tools: undefined, lastConnection: undefined }
            : patch;
        persist(servers.map(server => server.id === id
            ? { ...server, ...safePatch, updatedAt: Date.now() }
            : server));
        if (mustRetest) {
            resetMcpSession(id);
            setTestStates(current => ({
                ...current,
                [id]: { tone: 'stale', message: '連接參數已變化，請重新測試後再啟用。' },
            }));
        }
    };

    const addServer = () => {
        const next = createMcpServer(`MCP 服務器 ${servers.length + 1}`, '');
        persist([...servers, next]);
        setExpandedId(next.id);
        trackEvent('添加 MCP 服务器');
    };

    const removeServer = (server: McpServerConfig) => {
        if (!window.confirm(`刪除「${server.name || '未命名服務器'}」？\n\n本機保存的 URL、憑據和工具清單會一併刪除。`)) return;
        resetMcpSession(server.id);
        persist(servers.filter(item => item.id !== server.id));
        setExpandedId(current => current === server.id ? null : current);
        trackEvent('删除 MCP 服务器');
    };

    const discover = async (server: McpServerConfig) => {
        if (!server.url.trim()) {
            addToast('先填寫 MCP 端點 URL', 'error');
            return;
        }
        setTestingId(server.id);
        setTestStates(current => ({
            ...current,
            [server.id]: { tone: 'running', message: '正在建立連接…' },
        }));
        try {
            const result = await testMcpConnection(server, stage => {
                setTestStates(current => ({
                    ...current,
                    [server.id]: { tone: 'running', message: stageCopy(stage) },
                }));
            });
            if (result.ok && result.tools && result.connection) {
                update(server.id, { tools: result.tools, lastConnection: result.connection });
                setTestStates(current => ({
                    ...current,
                    [server.id]: { tone: 'ok', message: result.message },
                }));
                addToast(`${server.name || 'MCP 服務器'}已連接`, 'success');
                trackEvent('测试 MCP 服务器连接', {
                    result: result.tools.length ? 'connected' : 'connected-no-tools',
                    protocol: result.connection.protocolVersion,
                });
            } else {
                setTestStates(current => ({
                    ...current,
                    [server.id]: { tone: 'error', message: result.message },
                }));
                const message = result.message || '';
                const failureKind = /超[时時]/.test(message) ? 'timeout'
                    : /[鉴鑑][权權]失[败敗]/.test(message) ? 'auth-failed'
                    : /[请請]求失[败敗]/.test(message) ? 'fetch-failed'
                    : /[协協][议議]版本不兼容/.test(message) ? 'protocol-version'
                    : /MCP HTTP/.test(message) ? 'http-error'
                    : 'other';
                trackEvent('测试 MCP 服务器连接', { result: 'failed', failureKind });
            }
        } finally {
            setTestingId(null);
        }
    };

    const inputClass = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-violet-400 focus:ring-2 focus:ring-violet-100';

    return (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-700">
            <header className="border-b border-violet-100 bg-violet-50/60 px-4 py-4">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h3 className="text-sm font-bold text-slate-800">MCP 工具服務器</h3>
                        <p className="mt-1 max-w-[250px] text-[10px] leading-relaxed text-slate-500">
                            連接 MCP，讓角色在聊天時使用你接入的工具。
                            <span className="mt-1 block text-slate-400">支持 Streamable HTTP</span>
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={addServer}
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-violet-100 px-3 text-[10px] font-bold text-violet-700 transition-transform active:scale-95"
                    >
                        <Plus size={14} weight="bold" /> 添加服務器
                    </button>
                </div>
                <div className="mt-3 flex items-center gap-3 text-[10px] text-slate-500">
                    <span><b className="text-violet-700">{summary.live}</b> 個已啟用</span>
                    <span><b className="text-slate-700">{summary.tools}</b> 個工具</span>
                    <span className="ml-auto">配置保存在本機</span>
                </div>
            </header>

            <section className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[11px] font-bold">
                        原生 tools 工具調用
                        <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[8px] font-bold text-emerald-700">推薦</span>
                    </div>
                    <p className="mt-0.5 text-[9px] leading-relaxed text-slate-400">
                        默認使用 tools / function calling；只有中轉明確不支持時才關閉。
                    </p>
                </div>
                <PortToggle
                    label="標準工具通道"
                    checked={useNativeTools}
                    onChange={next => {
                        setUseNativeToolsState(next);
                        setMcpUseNativeTools(next);
                        onMcpConfigChanged?.();
                        trackEvent('切换原生工具调用', { state: next ? 'on' : 'off' });
                    }}
                />
            </section>

            <div>
                {!servers.length && (
                    <div className="px-6 py-10 text-center">
                        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-violet-50 text-violet-500">
                            <Plus size={20} />
                        </div>
                        <p className="text-xs font-bold text-slate-700">還沒有 MCP 服務器</p>
                        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">添加一個 Streamable HTTP 地址即可開始配置。</p>
                    </div>
                )}

                {servers.map(server => {
                    const expanded = expandedId === server.id;
                    const ready = (server.tools?.length || 0) > 0;
                    const live = server.enabled && ready;
                    const state = testStates[server.id];
                    return (
                        <article key={server.id} className="border-b border-slate-100 last:border-b-0">
                            <div className="flex items-center gap-3 px-4 py-3">
                                <button
                                    type="button"
                                    onClick={() => setExpandedId(expanded ? null : server.id)}
                                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                                >
                                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${live ? 'bg-emerald-500' : ready ? 'bg-slate-300' : 'border border-slate-300'}`}>
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-xs font-bold text-slate-700">{server.name || '未命名服務器'}</span>
                                        <span className="mt-0.5 block truncate text-[9px] text-slate-400">
                                            {live ? '已啟用' : ready ? '已連接，未啟用' : '尚未測試'}
                                            {ready ? ` · ${server.tools?.length} 個工具` : ''}
                                            {server.lastConnection?.protocolVersion ? ` · ${server.lastConnection.protocolVersion}` : ''}
                                        </span>
                                    </span>
                                    <CaretDown size={14} className={`shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                                </button>
                                <PortToggle
                                    label={`啟用 ${server.name}`}
                                    checked={server.enabled}
                                    onChange={next => {
                                        if (next && !ready) {
                                            addToast('請先測試連接並讀取工具，再啟用這個服務器', 'error');
                                            return;
                                        }
                                        update(server.id, { enabled: next });
                                    }}
                                />
                            </div>

                            {expanded && (
                                <div className="border-t border-slate-100 bg-slate-50/60 px-4 pb-5 pt-4">
                                    <div className="grid grid-cols-[28px_1fr] gap-x-2 gap-y-4">
                                        <span className="pt-6 text-[9px] font-bold text-violet-400">01</span>
                                        <div className="space-y-3">
                                            <div>
                                                <FieldLabel>服務器名稱</FieldLabel>
                                                <input className={inputClass} value={server.name} onChange={event => update(server.id, { name: event.target.value })} placeholder="例如：我的資料庫" />
                                            </div>
                                            <div>
                                                <FieldLabel>Streamable HTTP 端點</FieldLabel>
                                                <input className={`${inputClass} font-mono`} value={server.url} onChange={event => update(server.id, { url: event.target.value.trim() })} placeholder="https://example.com/mcp" />
                                            </div>
                                        </div>

                                        <span className="pt-6 text-[9px] font-bold text-violet-400">02</span>
                                        <div className="space-y-3 border-t border-slate-200 pt-4">
                                            <div className="flex items-center gap-2 text-[11px] font-bold"><LockKey size={14} /> 鑑權</div>
                                            <div>
                                                <FieldLabel>Bearer Token · 可選</FieldLabel>
                                                <input type="password" className={`${inputClass} font-mono`} value={server.token || ''} onChange={event => update(server.id, { token: event.target.value.trim() })} placeholder="只保存在本機" />
                                            </div>
                                            {(server.customHeaders || []).map((header, index) => (
                                                <div key={index} className="grid grid-cols-[0.8fr_1fr_34px] gap-1.5">
                                                    <input
                                                        className={`${inputClass} min-w-0 px-2 font-mono text-[10px]`}
                                                        value={header.name}
                                                        onChange={event => update(server.id, { customHeaders: (server.customHeaders || []).map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })}
                                                        placeholder="X-API-Key"
                                                        aria-label={`自定義請求頭 ${index + 1} 名稱`}
                                                    />
                                                    <input
                                                        type="password"
                                                        className={`${inputClass} min-w-0 px-2 font-mono text-[10px]`}
                                                        value={header.value}
                                                        onChange={event => update(server.id, { customHeaders: (server.customHeaders || []).map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item) })}
                                                        placeholder="value"
                                                        aria-label={`自定義請求頭 ${index + 1} 值`}
                                                    />
                                                    <button type="button" onClick={() => update(server.id, { customHeaders: (server.customHeaders || []).filter((_, itemIndex) => itemIndex !== index) })} className="rounded-xl border border-slate-200 text-slate-400" aria-label={`刪除請求頭 ${index + 1}`}>×</button>
                                                </div>
                                            ))}
                                            <button type="button" onClick={() => update(server.id, { customHeaders: [...(server.customHeaders || []), { name: '', value: '' }] })} className="text-[10px] font-bold text-violet-600">+ 添加自定義請求頭</button>
                                            <details className="group border-t border-dashed border-slate-200 pt-3">
                                                <summary className="flex cursor-pointer list-none items-center gap-2 text-[10px] font-bold text-slate-500">
                                                    <GlobeHemisphereWest size={14} /> 跨域代理（可選）
                                                    <CaretDown size={12} className="ml-auto transition-transform group-open:rotate-180" />
                                                </summary>
                                                <div className="mt-3 space-y-3">
                                                    <div>
                                                        <FieldLabel>代理 URL · 留空為直連</FieldLabel>
                                                        <input className={`${inputClass} font-mono`} value={server.proxyUrl || ''} onChange={event => update(server.id, { proxyUrl: event.target.value.trim() })} placeholder="http://localhost:18061 或你的 Worker" />
                                                    </div>
                                                    {!!server.proxyUrl?.trim() && (
                                                        <div>
                                                            <FieldLabel>代理密鑰 · 可選</FieldLabel>
                                                            <input type="password" className={`${inputClass} font-mono`} value={server.proxyKey || ''} onChange={event => update(server.id, { proxyKey: event.target.value.trim() })} placeholder="PROXY_KEY" />
                                                        </div>
                                                    )}
                                                    <p className="text-[9px] leading-relaxed text-slate-400">用於解決瀏覽器 CORS 限制。代理由你自行部署，Soren 不強制經過中央服務器。</p>
                                                </div>
                                            </details>
                                        </div>

                                        <span className="pt-6 text-[9px] font-bold text-violet-400">03</span>
                                        <div className="border-t border-slate-200 pt-4">
                                            <div className="mb-2 text-[11px] font-bold">適用聊天</div>
                                            <div className="flex flex-wrap gap-1.5">
                                                <button type="button" onClick={() => update(server.id, { charIds: [] })} className={`rounded-lg border px-2.5 py-1 text-[9px] font-bold ${!server.charIds?.length ? 'border-violet-500 bg-violet-500 text-white' : 'border-slate-200 bg-white text-slate-500'}`}>全部聊天</button>
                                                {characters.map(character => {
                                                    const selected = !!server.charIds?.includes(character.id);
                                                    return <button key={character.id} type="button" onClick={() => {
                                                        const current = server.charIds || [];
                                                        update(server.id, { charIds: selected ? current.filter(id => id !== character.id) : [...current, character.id] });
                                                    }} className={`rounded-lg border px-2.5 py-1 text-[9px] font-bold ${selected ? 'border-violet-500 bg-violet-500 text-white' : 'border-slate-200 bg-white text-slate-500'}`}>{character.name}</button>;
                                                })}
                                                {groups.map(group => {
                                                    const selected = !!server.charIds?.includes(group.id);
                                                    return <button key={group.id} type="button" onClick={() => {
                                                        const current = server.charIds || [];
                                                        update(server.id, { charIds: selected ? current.filter(id => id !== group.id) : [...current, group.id] });
                                                    }} className={`rounded-lg border px-2.5 py-1 text-[9px] font-bold ${selected ? 'border-violet-500 bg-violet-500 text-white' : 'border-slate-200 bg-white text-slate-500'}`}>{group.name}</button>;
                                                })}
                                            </div>
                                        </div>

                                    </div>

                                    <div className="mt-5 flex gap-2">
                                        <button
                                            type="button"
                                            disabled={testingId === server.id}
                                            onClick={() => discover(server)}
                                            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-violet-500 py-2.5 text-[10px] font-bold text-white transition-transform active:scale-[0.98] disabled:opacity-60"
                                        >
                                            {testingId === server.id ? <SpinnerGap size={14} className="animate-spin" /> : <CheckCircle size={14} weight="bold" />}
                                            {testingId === server.id ? '正在測試連接' : ready ? '重新測試連接' : '測試並讀取工具'}
                                        </button>
                                        <button type="button" onClick={() => removeServer(server)} className="flex w-11 items-center justify-center rounded-xl border border-rose-200 bg-white text-rose-500" aria-label="刪除服務器"><Trash size={15} /></button>
                                    </div>

                                    {state && (
                                        <div className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-[9px] leading-relaxed ${state.tone === 'ok' ? 'bg-emerald-50 text-emerald-700' : state.tone === 'running' ? 'bg-sky-50 text-sky-700' : state.tone === 'stale' ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-600'}`}>
                                            {state.tone === 'ok' ? <CheckCircle size={13} className="mt-0.5 shrink-0" /> : state.tone === 'running' ? <SpinnerGap size={13} className="mt-0.5 shrink-0 animate-spin" /> : <WarningCircle size={13} className="mt-0.5 shrink-0" />}
                                            <span>{state.message}</span>
                                        </div>
                                    )}

                                    {ready && (
                                        <div className="mt-4 border-t border-slate-200 pt-3">
                                            <div className="flex items-center justify-between text-[9px] font-bold text-slate-400">
                                                <span>工具列表</span>
                                                <span>{formatTestTime(server.lastConnection?.testedAt)}</span>
                                            </div>
                                            <div className="mt-2 divide-y divide-slate-100 border-y border-slate-100">
                                                {(server.tools || []).slice(0, 12).map(tool => (
                                                    <div key={tool.name} className="flex items-start gap-2 py-1.5 text-[9px]">
                                                        <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-violet-400" />
                                                        <span className="min-w-0 flex-1 font-mono text-slate-600">{tool.title || tool.name}</span>
                                                    </div>
                                                ))}
                                            </div>
                                            {(server.tools?.length || 0) > 12 && <p className="mt-2 text-right text-[9px] text-slate-400">另有 {(server.tools?.length || 0) - 12} 個工具</p>}
                                        </div>
                                    )}
                                </div>
                            )}
                        </article>
                    );
                })}
            </div>

            <footer className="border-t border-slate-100 bg-slate-50/60 px-4 py-3 text-[9px] leading-relaxed text-slate-400">
                URL、Token 與自定義請求頭保存在本機。使用自己的代理時，請求只經過你指定的轉接點。
            </footer>
        </div>
    );
};

export default McpConnectionConsole;
