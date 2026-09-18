import React, { useState } from 'react';
import { CaretLeft, CheckCircle, Circle, MapPin, PaperPlaneTilt, Plus, X } from '@phosphor-icons/react';
import type { CharacterProfile, NPCProfile, TrajectoryJourneyEntry } from '../../types';
import { buildTrajectoryJourneyPrompt, createTrajectoryJourneyEntry } from '../../utils/trajectory';
import { ContextBuilder } from '../../utils/context';
import { safeResponseJson, extractContent } from '../../utils/safeApi';
import { DB } from '../../utils/db';

interface Props {
    char: CharacterProfile;
    characters: CharacterProfile[];
    npcs: NPCProfile[];
    entries: TrajectoryJourneyEntry[];
    onCommit: (next: TrajectoryJourneyEntry[]) => void;
    apiConfig: { baseUrl: string; apiKey: string; model: string } | null | undefined;
    addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

type Participant = { key: string; name: string; description: string; charId?: string };

const formatDate = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const TrajectoryJourneyTab: React.FC<Props> = ({ char, characters, npcs, entries, onCommit, apiConfig, addToast }) => {
    const [view, setView] = useState<'list' | 'new'>('list');
    const [detailEntry, setDetailEntry] = useState<TrajectoryJourneyEntry | null>(null);
    const [kind, setKind] = useState<'日常' | '事件'>('日常');
    const [time, setTime] = useState('');
    const [location, setLocation] = useState('');
    const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
    const [detail, setDetail] = useState('');
    const [generating, setGenerating] = useState(false);
    const [syncingToChat, setSyncingToChat] = useState(false);

    const pool: Participant[] = [
        ...characters.filter(c => c.id !== char.id).map(c => ({ key: `char:${c.id}`, name: c.name, description: c.worldview?.trim().slice(0, 60) || '', charId: c.id })),
        ...npcs.map(n => ({ key: `npc:${n.id}`, name: n.name, description: n.description?.trim().slice(0, 60) || '' })),
    ];

    const toggleParticipant = (key: string) => {
        setSelectedKeys(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
    };

    const resetForm = () => {
        setKind('日常'); setTime(''); setLocation(''); setSelectedKeys([]); setDetail('');
    };

    const handleGenerate = async () => {
        if (!apiConfig?.baseUrl || !apiConfig?.apiKey) { addToast('先在设置里配置好 API', 'info'); return; }
        setGenerating(true);
        try {
            const participants = pool.filter(p => selectedKeys.includes(p.key)).map(p => ({ name: p.name, description: p.description }));
            const roleSettingsBlock = ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true });
            const prompt = buildTrajectoryJourneyPrompt(roleSettingsBlock, { kind, time, location, participants, detail });
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [{ role: 'system', content: roleSettingsBlock }, { role: 'user', content: prompt }],
                    temperature: 0.9,
                }),
            });
            if (!response.ok) throw new Error(`API Error ${response.status}`);
            const data = await safeResponseJson(response);
            const story = extractContent(data).trim();
            if (!story) { addToast('这次没生成出内容，再试一次', 'error'); return; }

            const participantCharIds = pool.filter(p => selectedKeys.includes(p.key) && p.charId).map(p => p.charId!);
            const entry = createTrajectoryJourneyEntry({
                kind, time, location, participantNames: participants.map(p => p.name), participantCharIds, detail, story,
            });
            onCommit([entry, ...entries]);
            addToast('这段行程生成好了', 'success');
            resetForm();
            setView('list');
            setDetailEntry(entry);
        } catch (e) {
            console.warn('[Trajectory] Journey 生成失败:', e);
            addToast('生成失败，稍后再试', 'error');
        } finally {
            setGenerating(false);
        }
    };

    // 是否同步进私聊留给生成完之后由用户自己决定（详情面板里的按钮），生成本身不带副作用。
    // 同一条记录同时发给「见面对象」里所有真实角色自己的私聊——不然角色A有这段记忆、
    // 一起出现的角色B/C却没有，后面聊起来会对不上（"我们昨天不是约好了"／"我们哪有约"）。
    // 内容原样复用（third-person 叙事本来就中立），不用另外分视角改写。NPC 没有自己的
    // 私聊，跳过。
    const handleSyncToChat = async (entry: TrajectoryJourneyEntry) => {
        setSyncingToChat(true);
        try {
            const buildMessage = (charId: string) => DB.saveMessage({
                charId, role: 'assistant', type: 'phone_card',
                content: `[你手机的軌跡 App] ${entry.story}`,
                metadata: { phoneCard: { app: '軌跡', title: `${entry.kind} · ${entry.location || entry.time || '一段行程'}`, value: entry.participantNames.join('、') || undefined, detail: entry.story } },
            } as any);
            const messageId = await buildMessage(char.id);
            await Promise.all((entry.participantCharIds || []).map(id => buildMessage(id)));
            const next = entries.map(e => e.id === entry.id ? { ...e, syncedMessageId: messageId } : e);
            onCommit(next);
            setDetailEntry(prev => prev && prev.id === entry.id ? { ...prev, syncedMessageId: messageId } : prev);
            const others = entry.participantCharIds?.length || 0;
            addToast(others ? `已同步到私聊（含见面的 ${others} 位角色）` : '已同步到私聊', 'success');
        } catch (e) {
            console.warn('[Trajectory] Journey 同步私聊失败:', e);
            addToast('同步失败，稍后再试', 'error');
        } finally {
            setSyncingToChat(false);
        }
    };

    if (view === 'new') {
        return (
            <div className="flex-1 min-h-0 flex flex-col text-white/90">
                <div className="shrink-0 flex items-center gap-2 px-5 pt-3 pb-2">
                    <button onClick={() => setView('list')} className="w-7 h-7 rounded-full flex items-center justify-center bg-white/[0.06]">
                        <CaretLeft size={14} weight="bold" />
                    </button>
                    <div className="text-[13px] font-bold">查看一段行程</div>
                </div>

                <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-28 space-y-4">
                    <div>
                        <div className="text-[10px] tracking-widest text-white/40 mb-1.5">类型</div>
                        <div className="flex gap-2">
                            {(['日常', '事件'] as const).map(k => (
                                <button key={k} onClick={() => setKind(k)} className="px-4 py-1.5 rounded-full text-[12px] font-bold"
                                    style={{ background: kind === k ? '#a78bfa' : 'rgba(255,255,255,0.08)', color: kind === k ? '#15111f' : 'rgba(255,255,255,0.6)' }}>
                                    {k}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <div className="text-[10px] tracking-widest text-white/40 mb-1.5">时间</div>
                        <input value={time} onChange={e => setTime(e.target.value)} placeholder="如：今晚八点、下周三下午"
                            className="w-full bg-white/[0.05] border border-white/10 rounded-xl px-3.5 py-2.5 text-[13px] outline-none placeholder:text-white/25" />
                    </div>

                    <div>
                        <div className="text-[10px] tracking-widest text-white/40 mb-1.5">地点 / 场景</div>
                        <input value={location} onChange={e => setLocation(e.target.value)} placeholder="如：老城区咖啡馆"
                            className="w-full bg-white/[0.05] border border-white/10 rounded-xl px-3.5 py-2.5 text-[13px] outline-none placeholder:text-white/25" />
                    </div>

                    <div>
                        <div className="text-[10px] tracking-widest text-white/40 mb-1.5">见面人物（可多选）</div>
                        {pool.length === 0 ? (
                            <div className="text-[11px] text-white/35">还没有其他角色或 NPC 可以选</div>
                        ) : (
                            <div className="flex flex-wrap gap-2">
                                {pool.map(p => {
                                    const active = selectedKeys.includes(p.key);
                                    return (
                                        <button key={p.key} onClick={() => toggleParticipant(p.key)}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold"
                                            style={{ background: active ? 'rgba(167,139,250,0.18)' : 'rgba(255,255,255,0.05)', color: active ? '#c4b5fd' : 'rgba(255,255,255,0.6)', border: `1px solid ${active ? '#a78bfa' : 'rgba(255,255,255,0.1)'}` }}>
                                            {active ? <CheckCircle size={13} weight="fill" /> : <Circle size={13} weight="light" />}
                                            {p.name}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    <div>
                        <div className="text-[10px] tracking-widest text-white/40 mb-1.5">补充细节（选填）</div>
                        <textarea value={detail} onChange={e => setDetail(e.target.value)} rows={3} placeholder="给生成一点方向提示"
                            className="w-full bg-white/[0.05] border border-white/10 rounded-xl px-3.5 py-2.5 text-[13px] outline-none resize-none placeholder:text-white/25" />
                    </div>

                    <button onClick={handleGenerate} disabled={generating}
                        className="w-full py-3 rounded-2xl text-[13px] font-bold disabled:opacity-50"
                        style={{ background: '#a78bfa', color: '#15111f' }}>
                        {generating ? '生成中…' : '开始'}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 min-h-0 flex flex-col text-white/90">
            <div className="shrink-0 flex items-center justify-between px-5 pt-3 pb-2">
                <div className="text-[11px] tracking-widest text-white/40">过往见面</div>
                <button onClick={() => setView('new')} aria-label="查看一段新行程"
                    className="w-8 h-8 rounded-full flex items-center justify-center" style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.12)' }}>
                    <Plus size={16} weight="bold" />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-28 space-y-2.5">
                {entries.length === 0 && (
                    <div className="text-center pt-16 text-[12px] text-white/40">
                        还没有行程记录，点右上角 + 查看 {char.name} 的一段行程
                    </div>
                )}
                {entries.map(entry => (
                    <button key={entry.id} onClick={() => setDetailEntry(entry)} className="w-full text-left rounded-2xl px-4 py-3"
                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                        <div className="flex items-center gap-2 mb-1">
                            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgba(167,139,250,0.15)', color: '#c4b5fd' }}>{entry.kind}</span>
                            <span className="text-[10px] text-white/35 flex items-center gap-1"><MapPin size={10} />{entry.location || '未指定地点'}</span>
                        </div>
                        <div className="text-[12.5px] text-white/80 line-clamp-2">{entry.story}</div>
                        <div className="flex items-center justify-between mt-1.5 text-[10px] text-white/35">
                            <span>{entry.participantNames.join('、') || '独自一人'}</span>
                            <span>{formatDate(entry.createdAt)}</span>
                        </div>
                    </button>
                ))}
            </div>

            {detailEntry && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-6" onClick={() => setDetailEntry(null)}>
                    <div className="absolute inset-0 bg-black/60" />
                    <div className="relative w-full max-w-xs max-h-[75vh] overflow-y-auto no-scrollbar rounded-[2rem] shadow-2xl p-5"
                        style={{ background: '#1a1626' }} onClick={e => e.stopPropagation()}>
                        <button onClick={() => setDetailEntry(null)} aria-label="关闭"
                            className="absolute top-3 right-3 w-7 h-7 rounded-full bg-black/40 flex items-center justify-center text-white/80">
                            <X size={14} weight="bold" />
                        </button>
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgba(167,139,250,0.15)', color: '#c4b5fd' }}>{detailEntry.kind}</span>
                            <span className="text-[10px] text-white/40">{formatDate(detailEntry.createdAt)}</span>
                        </div>
                        <div className="text-[11px] text-white/50 mb-3 space-y-0.5">
                            {detailEntry.time && <div>时间：{detailEntry.time}</div>}
                            {detailEntry.location && <div>地点：{detailEntry.location}</div>}
                            <div>见面对象：{detailEntry.participantNames.join('、') || '独自一人'}</div>
                        </div>
                        <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-white/85">{detailEntry.story}</p>
                        <button onClick={() => void handleSyncToChat(detailEntry)} disabled={syncingToChat || !!detailEntry.syncedMessageId}
                            className="w-full mt-4 py-3 rounded-2xl text-[12px] font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
                            style={{ background: 'rgba(167,139,250,0.14)', color: '#c4b5fd', border: '1px solid rgba(167,139,250,0.25)' }}>
                            <PaperPlaneTilt size={15} weight="bold" />
                            {detailEntry.syncedMessageId ? '已同步到私聊' : (syncingToChat ? '同步中…' : '同步到私聊')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TrajectoryJourneyTab;
