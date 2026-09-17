import React, { useState } from 'react';
import { CaretDown, CircleNotch, ClockCountdown } from '@phosphor-icons/react';
import type { CharacterProfile, CharacterTrajectoryProfile } from '../../types';
import { buildTrajectoryProfilePrompt, parseTrajectoryProfile, toggleTrajectoryChecklistItem } from '../../utils/trajectory';
import { ContextBuilder } from '../../utils/context';
import { safeResponseJson, extractContent, extractJson } from '../../utils/safeApi';

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

const TrajectoryProfileTab: React.FC<Props> = ({ char, profile, onCommit, apiConfig, addToast }) => {
    const [subTab, setSubTab] = useState<ProfileSubTab>('archives');
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    const handleRefresh = async () => {
        if (!apiConfig?.baseUrl || !apiConfig?.apiKey) { addToast('先在设置里配置好 API', 'info'); return; }
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
                addToast('这次没解析出内容，再试一次', 'error');
                return;
            }
            onCommit(next);
            addToast('Profile 已刷新', 'success');
        } catch (e) {
            console.warn('[Trajectory] Profile 生成失败:', e);
            addToast('生成失败，稍后再试', 'error');
        } finally {
            setRefreshing(false);
        }
    };

    const handleToggleChecklist = (itemId: string) => {
        if (!profile) return;
        onCommit(toggleTrajectoryChecklistItem(profile, itemId));
    };

    const empty = !profile || (!profile.archives.length && !profile.objectives.length && !profile.checklist.length);

    return (
        <div className="flex-1 min-h-0 flex flex-col" style={{ background: '#120f1a', color: '#e8e3f5' }}>
            <div className="shrink-0 flex items-center justify-between px-5 pt-3 pb-2">
                <div className="flex items-center gap-4">
                    {SUB_TABS.map(t => (
                        <button key={t.key} onClick={() => setSubTab(t.key)}
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

            <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-8 space-y-3">
                {empty && (
                    <div className="text-center pt-16 text-[12px]" style={{ color: 'rgba(232,227,245,0.4)' }}>
                        还没有内容，点右上角刷新生成 {char.name} 的 Profile
                    </div>
                )}

                {subTab === 'archives' && profile?.archives.map(doc => {
                    const isOpen = expandedId === doc.id;
                    return (
                        <button key={doc.id} onClick={() => setExpandedId(isOpen ? null : doc.id)}
                            className="w-full text-left rounded-2xl px-4 py-3.5 transition"
                            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
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
                    </div>
                ))}

                {subTab === 'checklist' && profile?.checklist.map(item => (
                    <button key={item.id} onClick={() => handleToggleChecklist(item.id)}
                        className="w-full text-left rounded-2xl px-4 py-3 flex items-center gap-3 transition"
                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', opacity: item.done ? 0.55 : 1 }}>
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
                ))}
            </div>
        </div>
    );
};

export default TrajectoryProfileTab;
