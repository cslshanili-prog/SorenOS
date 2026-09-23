import React, { useMemo, useState } from 'react';
import { CaretDown, CircleNotch, ClockCountdown, PaperPlaneTilt, Trash } from '@phosphor-icons/react';
import type { CharacterProfile, CharacterTrajectoryProfile, TrajectoryArchiveDoc, TrajectoryChecklistItem, TrajectoryObjective } from '../../types';
import { buildTrajectoryProfilePrompt, groupTrajectoryChecklistByBatch, parseTrajectoryProfile, toggleTrajectoryChecklistItem } from '../../utils/trajectory';
import { ContextBuilder } from '../../utils/context';
import { safeResponseJson, extractContent, extractJson } from '../../utils/safeApi';
import { DB } from '../../utils/db';

type ProfileSubTab = 'archives' | 'objective' | 'checklist';

const SUB_TABS: { key: ProfileSubTab; label: string }[] = [
    { key: 'archives', label: 'ARCHIVES' },
    { key: 'objective', label: 'OBJECTIVE' },
    { key: 'checklist', label: 'CHECKLIST' },
];

interface Props {
    char: CharacterProfile;
    profile: CharacterTrajectoryProfile | undefined;
    onCommit: (next: CharacterTrajectoryProfile) => void;
    apiConfig: { baseUrl: string; apiKey: string; model: string } | null | undefined;
    addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const formatBatchHeading = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const TrajectoryProfileTab: React.FC<Props> = ({ char, profile, onCommit, apiConfig, addToast }) => {
    const [subTab, setSubTab] = useState<ProfileSubTab>('archives');
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [syncingId, setSyncingId] = useState<string | null>(null);
    const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

    const checklistBatches = useMemo(() => groupTrajectoryChecklistByBatch(profile?.checklist || []), [profile?.checklist]);

    const handleRefresh = async () => {
        if (!apiConfig?.baseUrl || !apiConfig?.apiKey) { addToast('先在設置裡配置好 API', 'info'); return; }
        setRefreshing(true);
        try {
            const roleSettingsBlock = ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true });
            const prompt = buildTrajectoryProfilePrompt(roleSettingsBlock, profile);
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [{ role: 'system', content: roleSettingsBlock }, { role: 'user', content: prompt }],
                    temperature: 0.95,
                }),
            });
            if (!response.ok) throw new Error(`API Error ${response.status}`);
            const data = await safeResponseJson(response);
            const content = extractContent(data);
            const json = extractJson(content);
            const next = parseTrajectoryProfile(json);
            if (!next.archives.length && !next.objectives.length && !next.checklist.length) {
                addToast('這次沒解析出內容，再試一次', 'error');
                return;
            }
            onCommit(next);
            addToast('Profile 已刷新', 'success');
        } catch (e) {
            console.warn('[Trajectory] Profile 生成失敗:', e);
            addToast('生成失敗，稍後再試', 'error');
        } finally {
            setRefreshing(false);
        }
    };

    const handleToggleChecklist = (itemId: string) => {
        if (!profile) return;
        onCommit(toggleTrajectoryChecklistItem(profile, itemId));
    };

    const handleSyncArchive = async (doc: TrajectoryArchiveDoc) => {
        if (!profile) return;
        setSyncingId(doc.id);
        try {
            const messageId = await DB.saveMessage({
                charId: char.id, role: 'assistant', type: 'phone_card',
                content: `[你手機的 軌跡 App · Archives] ${doc.title}`,
                metadata: { phoneCard: { app: '軌跡 · Archives', title: doc.title, value: doc.category, detail: doc.content } },
            } as any);
            onCommit({ ...profile, archives: profile.archives.map(d => d.id === doc.id ? { ...d, syncedMessageId: messageId } : d) });
            addToast('已同步到私聊', 'success');
        } catch (e) {
            console.warn('[Trajectory] Profile Archives 同步私聊失敗:', e);
            addToast('同步失敗，稍後再試', 'error');
        } finally {
            setSyncingId(null);
        }
    };

    const handleSyncObjective = async (obj: TrajectoryObjective) => {
        if (!profile) return;
        setSyncingId(obj.id);
        try {
            const messageId = await DB.saveMessage({
                charId: char.id, role: 'assistant', type: 'phone_card',
                content: `[你手機的 軌跡 App · Objective] ${obj.title}（進度 ${obj.progress}%）`,
                metadata: { phoneCard: { app: '軌跡 · Objective', title: obj.title, value: `進度 ${obj.progress}%`, detail: obj.detail } },
            } as any);
            onCommit({ ...profile, objectives: profile.objectives.map(o => o.id === obj.id ? { ...o, syncedMessageId: messageId } : o) });
            addToast('已同步到私聊', 'success');
        } catch (e) {
            console.warn('[Trajectory] Profile Objective 同步私聊失敗:', e);
            addToast('同步失敗，稍後再試', 'error');
        } finally {
            setSyncingId(null);
        }
    };

    const handleSyncChecklistItem = async (item: TrajectoryChecklistItem) => {
        if (!profile) return;
        setSyncingId(item.id);
        try {
            const messageId = await DB.saveMessage({
                charId: char.id, role: 'assistant', type: 'phone_card',
                content: `[你手機的 軌跡 App · Checklist] ${item.title}`,
                metadata: { phoneCard: { app: '軌跡 · Checklist', title: item.title, value: item.dueLabel, detail: item.done ? '已完成' : '待完成' } },
            } as any);
            onCommit({ ...profile, checklist: profile.checklist.map(c => c.id === item.id ? { ...c, syncedMessageId: messageId } : c) });
            addToast('已同步到私聊', 'success');
        } catch (e) {
            console.warn('[Trajectory] Profile Checklist 同步私聊失敗:', e);
            addToast('同步失敗，稍後再試', 'error');
        } finally {
            setSyncingId(null);
        }
    };

    const handleDeleteArchive = (doc: TrajectoryArchiveDoc) => {
        if (!profile) return;
        onCommit({ ...profile, archives: profile.archives.filter(d => d.id !== doc.id) });
        setPendingDeleteId(null);
        if (expandedId === doc.id) setExpandedId(null);
        addToast('已刪除', 'success');
    };

    const handleDeleteObjective = (obj: TrajectoryObjective) => {
        if (!profile) return;
        onCommit({ ...profile, objectives: profile.objectives.filter(o => o.id !== obj.id) });
        setPendingDeleteId(null);
        addToast('已刪除', 'success');
    };

    const handleDeleteChecklistItem = (item: TrajectoryChecklistItem) => {
        if (!profile) return;
        onCommit({ ...profile, checklist: profile.checklist.filter(c => c.id !== item.id) });
        setPendingDeleteId(null);
        addToast('已刪除', 'success');
    };

    const empty = !profile || (!profile.archives.length && !profile.objectives.length && !profile.checklist.length);

    return (
        <div className="flex-1 min-h-0 flex flex-col" style={{ color: '#e8e3f5' }}>
            <div className="shrink-0 flex items-center justify-between px-5 pt-3 pb-2">
                <div className="flex items-center gap-4">
                    {SUB_TABS.map(t => (
                        <button key={t.key} onClick={() => { setSubTab(t.key); setPendingDeleteId(null); }}
                            className="text-[12px] font-bold tracking-widest pb-1.5 transition-colors"
                            style={{
                                color: subTab === t.key ? '#c4b5fd' : 'rgba(232,227,245,0.35)',
                                borderBottom: subTab === t.key ? '2px solid #c4b5fd' : '2px solid transparent',
                            }}>
                            {t.label}
                        </button>
                    ))}
                </div>
                <button onClick={handleRefresh} disabled={refreshing} aria-label="刷新 Profile"
                    className="w-8 h-8 rounded-full flex items-center justify-center transition disabled:opacity-50"
                    style={{ color: '#c4b5fd', background: 'rgba(196,181,253,0.1)' }}>
                    <CircleNotch size={16} weight="bold" className={refreshing ? 'animate-spin' : ''} />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-28 space-y-3">
                {empty && (
                    <div className="text-center pt-16 text-[12px]" style={{ color: 'rgba(232,227,245,0.4)' }}>
                        還沒有內容，點右上角刷新生成 {char.name} 的 Profile
                    </div>
                )}

                {subTab === 'archives' && profile?.archives.map(doc => {
                    const isOpen = expandedId === doc.id;
                    return (
                        <div key={doc.id} className="w-full rounded-2xl px-4 py-3.5 transition"
                            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                            <button onClick={() => setExpandedId(isOpen ? null : doc.id)} className="w-full text-left">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="text-[13px] font-bold leading-snug">{doc.title}</div>
                                        <div className="text-[9px] tracking-widest mt-1" style={{ color: 'rgba(196,181,253,0.6)' }}>{doc.category}</div>
                                    </div>
                                    <CaretDown size={14} weight="bold" style={{ color: 'rgba(232,227,245,0.4)', transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .2s', flexShrink: 0, marginTop: 2 }} />
                                </div>
                                {isOpen && doc.content && (
                                    <div className="mt-3 pt-3 text-[12px] leading-relaxed whitespace-pre-wrap" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', color: 'rgba(232,227,245,0.8)' }}>
                                        {doc.content}
                                    </div>
                                )}
                            </button>
                            {isOpen && (pendingDeleteId === doc.id ? (
                                <div className="mt-3 flex items-center gap-2">
                                    <div className="flex-1 text-[11px]" style={{ color: 'rgba(252,165,165,0.9)' }}>確定刪除這份檔案？</div>
                                    <button onClick={() => setPendingDeleteId(null)} className="px-3 py-2 rounded-xl text-[11px] font-bold"
                                        style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}>取消</button>
                                    <button onClick={() => handleDeleteArchive(doc)} className="px-3 py-2 rounded-xl text-[11px] font-bold"
                                        style={{ background: 'rgba(244,63,94,0.18)', color: '#fca5a5', border: '1px solid rgba(244,63,94,0.35)' }}>刪除</button>
                                </div>
                            ) : (
                                <div className="mt-3 flex items-center gap-2">
                                    <button onClick={() => void handleSyncArchive(doc)} disabled={syncingId === doc.id || !!doc.syncedMessageId}
                                        className="flex-1 py-2.5 rounded-xl text-[11px] font-semibold flex items-center justify-center gap-1.5 disabled:opacity-60"
                                        style={{ background: 'rgba(167,139,250,0.14)', color: '#c4b5fd', border: '1px solid rgba(167,139,250,0.25)' }}>
                                        <PaperPlaneTilt size={13} weight="bold" />
                                        {doc.syncedMessageId ? '已同步到私聊' : (syncingId === doc.id ? '同步中…' : '同步到私聊')}
                                    </button>
                                    <button onClick={() => setPendingDeleteId(doc.id)} aria-label="刪除" title="刪除"
                                        className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'rgba(244,63,94,0.12)', color: '#fca5a5' }}>
                                        <Trash size={14} weight="bold" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    );
                })}

                {subTab === 'objective' && profile?.objectives.map(obj => (
                    <div key={obj.id} className="rounded-2xl px-4 py-3.5"
                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                        <div className="flex items-start justify-between gap-2 mb-1">
                            <div>
                                <div className="text-[13px] font-bold leading-snug">{obj.title}</div>
                                <div className="text-[9px] tracking-widest mt-0.5" style={{ color: 'rgba(232,227,245,0.35)' }}>TARGET PROGRESS</div>
                            </div>
                            <div className="text-[17px] font-bold shrink-0" style={{ color: '#c4b5fd' }}>{obj.progress}%</div>
                        </div>
                        <div className="h-1.5 rounded-full overflow-hidden mt-2" style={{ background: 'rgba(255,255,255,0.08)' }}>
                            <div className="h-full rounded-full" style={{ width: `${obj.progress}%`, background: 'linear-gradient(90deg, #a78bfa, #c4b5fd)' }} />
                        </div>
                        {obj.detail && (
                            <div className="text-[11.5px] leading-relaxed mt-3 rounded-xl px-3 py-2" style={{ background: 'rgba(255,255,255,0.03)', color: 'rgba(232,227,245,0.7)' }}>
                                {obj.detail}
                            </div>
                        )}
                        {pendingDeleteId === obj.id ? (
                            <div className="mt-3 flex items-center gap-2">
                                <div className="flex-1 text-[11px]" style={{ color: 'rgba(252,165,165,0.9)' }}>確定刪除這項目標？</div>
                                <button onClick={() => setPendingDeleteId(null)} className="px-3 py-2 rounded-xl text-[11px] font-bold"
                                    style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}>取消</button>
                                <button onClick={() => handleDeleteObjective(obj)} className="px-3 py-2 rounded-xl text-[11px] font-bold"
                                    style={{ background: 'rgba(244,63,94,0.18)', color: '#fca5a5', border: '1px solid rgba(244,63,94,0.35)' }}>刪除</button>
                            </div>
                        ) : (
                            <div className="mt-3 flex items-center gap-2">
                                <button onClick={() => void handleSyncObjective(obj)} disabled={syncingId === obj.id || !!obj.syncedMessageId}
                                    className="flex-1 py-2.5 rounded-xl text-[11px] font-semibold flex items-center justify-center gap-1.5 disabled:opacity-60"
                                    style={{ background: 'rgba(167,139,250,0.14)', color: '#c4b5fd', border: '1px solid rgba(167,139,250,0.25)' }}>
                                    <PaperPlaneTilt size={13} weight="bold" />
                                    {obj.syncedMessageId ? '已同步到私聊' : (syncingId === obj.id ? '同步中…' : '同步到私聊')}
                                </button>
                                <button onClick={() => setPendingDeleteId(obj.id)} aria-label="刪除" title="刪除"
                                    className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'rgba(244,63,94,0.12)', color: '#fca5a5' }}>
                                    <Trash size={14} weight="bold" />
                                </button>
                            </div>
                        )}
                    </div>
                ))}

                {subTab === 'checklist' && checklistBatches.map(batch => (
                    <div key={batch.timestamp}>
                        <div className="text-[11px] mb-2 tracking-wide" style={{ color: 'rgba(232,227,245,0.4)' }}>{formatBatchHeading(batch.timestamp)}</div>
                        <div className="space-y-2">
                            {batch.items.map(item => (
                                <div key={item.id} className="w-full rounded-2xl px-4 py-3 flex items-center gap-3 transition"
                                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', opacity: pendingDeleteId === item.id ? 1 : (item.done ? 0.55 : 1) }}>
                                    {pendingDeleteId === item.id ? (
                                        <>
                                            <div className="flex-1 text-[12px]" style={{ color: 'rgba(252,165,165,0.9)' }}>確定刪除這條待辦？</div>
                                            <button onClick={() => setPendingDeleteId(null)} className="px-3 py-1.5 rounded-lg text-[11px] font-bold shrink-0"
                                                style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}>取消</button>
                                            <button onClick={() => handleDeleteChecklistItem(item)} className="px-3 py-1.5 rounded-lg text-[11px] font-bold shrink-0"
                                                style={{ background: 'rgba(244,63,94,0.18)', color: '#fca5a5', border: '1px solid rgba(244,63,94,0.35)' }}>刪除</button>
                                        </>
                                    ) : (
                                        <>
                                            <button onClick={() => handleToggleChecklist(item.id)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                                                <span className="w-5 h-5 rounded-md flex items-center justify-center shrink-0"
                                                    style={{ border: `1.5px solid ${item.done ? '#c4b5fd' : 'rgba(232,227,245,0.3)'}`, background: item.done ? '#c4b5fd' : 'transparent' }}>
                                                    {item.done && <span style={{ color: '#120f1a', fontSize: 12, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                                                </span>
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-[13px] font-bold" style={{ textDecoration: item.done ? 'line-through' : 'none' }}>{item.title}</div>
                                                    <div className="flex items-center gap-1 text-[10px] mt-0.5" style={{ color: 'rgba(232,227,245,0.4)' }}>
                                                        <ClockCountdown size={11} weight="bold" /> {item.dueLabel}
                                                    </div>
                                                </div>
                                            </button>
                                            <button onClick={() => void handleSyncChecklistItem(item)} disabled={syncingId === item.id || !!item.syncedMessageId}
                                                aria-label="同步到私聊" title={item.syncedMessageId ? '已同步到私聊' : '同步到私聊'}
                                                className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 disabled:opacity-60"
                                                style={{ background: 'rgba(167,139,250,0.14)', color: '#c4b5fd' }}>
                                                {syncingId === item.id
                                                    ? <CircleNotch size={13} weight="bold" className="animate-spin" />
                                                    : <PaperPlaneTilt size={13} weight="bold" />}
                                            </button>
                                            <button onClick={() => setPendingDeleteId(item.id)} aria-label="刪除" title="刪除"
                                                className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                                                style={{ background: 'rgba(244,63,94,0.12)', color: '#fca5a5' }}>
                                                <Trash size={13} weight="bold" />
                                            </button>
                                        </>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default TrajectoryProfileTab;
