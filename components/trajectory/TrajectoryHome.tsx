import React, { useState } from 'react';
import { CaretLeft, Hourglass } from '@phosphor-icons/react';
import type { CharacterProfile } from '../../types';
import TokenImg from '../os/TokenImg';
import TrajectoryProfileTab from './TrajectoryProfileTab';

type TrajectoryTab = 'backstage' | 'moments' | 'ootd' | 'profile' | 'journey';

const TABS: { key: TrajectoryTab; label: string }[] = [
    { key: 'backstage', label: 'BACKSTAGE' },
    { key: 'moments', label: 'MOMENTS' },
    { key: 'ootd', label: 'OOTD' },
    { key: 'profile', label: 'PROFILE' },
    { key: 'journey', label: 'JOURNEY' },
];

const ComingSoon: React.FC<{ label: string }> = ({ label }) => (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2" style={{ background: '#120f1a', color: 'rgba(232,227,245,0.4)' }}>
        <Hourglass size={22} weight="light" />
        <div className="text-[12px]">{label} · 敬请期待</div>
    </div>
);

interface Props {
    targetChar: CharacterProfile;
    characters: CharacterProfile[];
    onBack: () => void;
    updateCharacter: (id: string, updater: (prev: CharacterProfile) => Partial<CharacterProfile>) => void;
    apiConfig: { baseUrl: string; apiKey: string; model: string } | null | undefined;
    addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const TrajectoryHome: React.FC<Props> = ({ targetChar, characters, onBack, updateCharacter, apiConfig, addToast }) => {
    const [selectedCharId, setSelectedCharId] = useState(targetChar.id);
    const [tab, setTab] = useState<TrajectoryTab>('profile');

    const selectedChar = characters.find(c => c.id === selectedCharId) || targetChar;

    return (
        <div className="absolute inset-0 w-full h-full flex flex-col z-[60]" style={{ background: '#120f1a', color: '#e8e3f5' }}>
            {/* Header */}
            <div className="shrink-0 flex items-center gap-3 px-4 pt-3 pb-2">
                <button onClick={onBack} className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(232,227,245,0.8)' }}>
                    <CaretLeft size={16} weight="bold" />
                </button>
                <div className="min-w-0">
                    <div className="text-[15px] font-bold leading-tight truncate">{selectedChar.name}</div>
                    <div className="text-[10px] tracking-[0.2em]" style={{ color: 'rgba(196,181,253,0.6)' }}>生活軌跡</div>
                </div>
            </div>

            {/* Character selector strip */}
            <div className="shrink-0 flex items-center gap-2.5 px-4 pb-3 overflow-x-auto no-scrollbar">
                {characters.map(c => {
                    const active = c.id === selectedCharId;
                    return (
                        <button key={c.id} onClick={() => setSelectedCharId(c.id)}
                            className="shrink-0 flex flex-col items-center gap-1 transition-opacity"
                            style={{ opacity: active ? 1 : 0.45 }}>
                            <TokenImg value={c.avatar} alt="" className="w-11 h-11 rounded-full object-cover"
                                style={{ border: active ? '2px solid #c4b5fd' : '2px solid transparent' }} />
                            <span className="text-[9px] max-w-[3.2rem] truncate" style={{ color: active ? '#e8e3f5' : 'rgba(232,227,245,0.5)' }}>{c.name}</span>
                        </button>
                    );
                })}
            </div>

            {/* Tab bar */}
            <div className="shrink-0 flex items-center gap-5 px-5 border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                {TABS.map(t => (
                    <button key={t.key} onClick={() => setTab(t.key)}
                        className="text-[11px] font-bold tracking-widest py-2.5 transition-colors"
                        style={{
                            color: tab === t.key ? '#e8e3f5' : 'rgba(232,227,245,0.3)',
                            borderBottom: tab === t.key ? '2px solid #c4b5fd' : '2px solid transparent',
                        }}>
                        {t.label}
                    </button>
                ))}
            </div>

            {tab === 'backstage' && <ComingSoon label="后台生活" />}
            {tab === 'moments' && <ComingSoon label="朋友圈" />}
            {tab === 'ootd' && <ComingSoon label="今日穿搭" />}
            {tab === 'journey' && <ComingSoon label="行程" />}
            {tab === 'profile' && (
                <TrajectoryProfileTab
                    char={selectedChar}
                    profile={selectedChar.phoneState?.trajectoryProfile}
                    onCommit={(next) => updateCharacter(selectedChar.id, (cur) => ({
                        phoneState: { ...cur.phoneState, records: cur.phoneState?.records || [], trajectoryProfile: next },
                    }))}
                    apiConfig={apiConfig}
                    addToast={addToast}
                />
            )}
        </div>
    );
};

export default TrajectoryHome;
