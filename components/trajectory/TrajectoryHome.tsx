import React, { useState } from 'react';
import { Broadcast, ImagesSquare, TShirt, IdentificationCard, Footprints, type Icon } from '@phosphor-icons/react';
import type { CharacterProfile, ImageGenApiConfig, NPCProfile } from '../../types';
import { TermHeader } from '../../apps/CheckPhone';
import TrajectoryProfileTab from './TrajectoryProfileTab';
import TrajectoryOotdTab from './TrajectoryOotdTab';
import TrajectoryMomentsTab from './TrajectoryMomentsTab';
import TrajectoryJourneyTab from './TrajectoryJourneyTab';

type TrajectoryTab = 'backstage' | 'moments' | 'ootd' | 'profile' | 'journey';

const ACCENT = '#a78bfa';

const TABS: { key: TrajectoryTab; label: string; Icon: Icon }[] = [
    { key: 'backstage', label: '后台生活', Icon: Broadcast },
    { key: 'moments', label: '朋友圈', Icon: ImagesSquare },
    { key: 'ootd', label: '今日穿搭', Icon: TShirt },
    { key: 'profile', label: 'Profile', Icon: IdentificationCard },
    { key: 'journey', label: '行程', Icon: Footprints },
];

const ComingSoon: React.FC<{ label: string }> = ({ label }) => (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-white/40">
        <div className="text-[12px]">{label} · 敬请期待</div>
    </div>
);

interface Props {
    targetChar: CharacterProfile;
    characters: CharacterProfile[];
    npcs: NPCProfile[];
    onBack: () => void;
    updateCharacter: (id: string, updater: (prev: CharacterProfile) => Partial<CharacterProfile>) => void;
    apiConfig: { baseUrl: string; apiKey: string; model: string } | null | undefined;
    imageGenConfig: ImageGenApiConfig | undefined;
    addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const TrajectoryHome: React.FC<Props> = ({ targetChar, characters, npcs, onBack, updateCharacter, apiConfig, imageGenConfig, addToast }) => {
    const [tab, setTab] = useState<TrajectoryTab>('profile');
    const activeTabLabel = TABS.find(t => t.key === tab)!.label;

    return (
        <div className="absolute inset-0 w-full h-full flex flex-col z-[60] overflow-hidden text-white"
            style={{ background: 'radial-gradient(140% 90% at 50% 0%, #15171d 0%, #0a0b0f 70%)' }}>
            <TermHeader title={activeTabLabel} sub="生活軌跡" accent={ACCENT} onBack={onBack} />

            {tab === 'backstage' && <ComingSoon label="后台生活" />}
            {tab === 'journey' && (
                <TrajectoryJourneyTab
                    char={targetChar}
                    characters={characters}
                    npcs={npcs}
                    entries={targetChar.phoneState?.trajectoryJourney || []}
                    onCommit={(next) => updateCharacter(targetChar.id, (cur) => ({
                        phoneState: { ...cur.phoneState, records: cur.phoneState?.records || [], trajectoryJourney: next },
                    }))}
                    apiConfig={apiConfig}
                    addToast={addToast}
                />
            )}
            {tab === 'moments' && (
                <TrajectoryMomentsTab
                    char={targetChar}
                    cover={targetChar.phoneState?.trajectoryMomentsCover}
                    onCommitCover={(next) => updateCharacter(targetChar.id, (cur) => ({
                        phoneState: { ...cur.phoneState, records: cur.phoneState?.records || [], trajectoryMomentsCover: next },
                    }))}
                    addToast={addToast}
                />
            )}
            {tab === 'ootd' && (
                <TrajectoryOotdTab
                    char={targetChar}
                    posts={targetChar.phoneState?.trajectoryOotd || []}
                    onCommit={(next) => updateCharacter(targetChar.id, (cur) => ({
                        phoneState: { ...cur.phoneState, records: cur.phoneState?.records || [], trajectoryOotd: next },
                    }))}
                    apiConfig={apiConfig}
                    imageGenConfig={imageGenConfig}
                    addToast={addToast}
                />
            )}
            {tab === 'profile' && (
                <TrajectoryProfileTab
                    char={targetChar}
                    profile={targetChar.phoneState?.trajectoryProfile}
                    onCommit={(next) => updateCharacter(targetChar.id, (cur) => ({
                        phoneState: { ...cur.phoneState, records: cur.phoneState?.records || [], trajectoryProfile: next },
                    }))}
                    apiConfig={apiConfig}
                    addToast={addToast}
                />
            )}

            {/* Floating glass nav —— 跟查手机主页那条一样的公版底部导览 */}
            <nav className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[90%] z-40">
                <div className="bg-white/[0.06] backdrop-blur-2xl rounded-[26px] border border-white/[0.1] shadow-[0_8px_40px_rgba(0,0,0,0.5)] flex justify-around items-center px-3 py-2.5">
                    {TABS.map(t => {
                        const active = tab === t.key;
                        return (
                            <button key={t.key} onClick={() => setTab(t.key)} aria-label={t.label}
                                className="flex items-center justify-center p-2.5 rounded-2xl transition active:scale-90"
                                style={{ color: active ? ACCENT : 'rgba(255,255,255,0.5)' }}>
                                <t.Icon size={22} weight={active ? 'fill' : 'light'} />
                            </button>
                        );
                    })}
                </div>
            </nav>
        </div>
    );
};

export default TrajectoryHome;
