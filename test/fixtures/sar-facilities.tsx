// Isolated browser QA only. Refuses to seed into a profile containing non-QA characters.
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OSProvider, useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import { SARAssemblyCabinetOverlay } from '../../apps/vrWorld/SARAssemblyCabinet';
import { SARGachaOverlay } from '../../apps/vrWorld/SARGacha';
import { SARModuleShopOverlay } from '../../apps/vrWorld/SARModuleShop';
import { SARHubPanels } from '../../apps/vrWorld/SARHubPanels';
import { FishingMarketOverlay } from '../../apps/vrWorld/FishingMarketOverlay';
import { SARFamiliarityDialog } from '../../apps/vrWorld/SARFamiliarityDialog';
import { SARObjectInspector } from '../../apps/vrWorld/SARObjectInspector';
import { createFishingMarketState, saveFishingMarketState } from '../../utils/vrWorld/fishingMarket';
import { ensureSARCommerce, readSARCommerce } from '../../utils/vrWorld/sarCommerce';
import { SAR_MODULE_CATALOG } from '../../utils/vrWorld/sarModuleShop';
import { getSARModules } from '../../utils/vrWorld/sarGacha';
import { SAR_FACILITY_IDS, sarFacilityGuideKey } from '../../utils/vrWorld/sarFacilityGuides';
const Garden = React.lazy(() => import('../../apps/vrWorld/dinosaur/DinosaurGarden').then(module => ({ default: module.DinosaurGarden })));
function Harness() {
    const os = useOS(), backRef = useRef<(() => boolean) | null>(null);
    const [view, setView] = useState(new URLSearchParams(location.search).get('facility') || 'cabinet');
    useEffect(() => { (window as any).facilityQA = { os, setView }; });
    const close = () => setView('closed');
    if (view === 'inspector') return <SARObjectInspector title="安全區檢查" onClose={close}><div style={{height:1400}}>長篇物品詳情</div></SARObjectInspector>;
    if (view === 'cabinet') return <SARAssemblyCabinetOverlay characters={os.characters} characterGroups={os.characterGroups} apiConfig={os.apiConfig} groups={os.groups} userProfile={os.userProfile} onClose={close}/>;
    if (view === 'gacha') return <React.Profiler id="gacha" onRender={(_id, _phase, duration) => { ((window as any).gachaCommits ||= []).push(duration); }}><SARGachaOverlay onClose={close}/></React.Profiler>;
    if (view === 'modules') return <SARModuleShopOverlay npcEnabled onClose={close}/>;
    if (view === 'warehouse' || view === 'settings') return <SARHubPanels panel={view} characters={os.characters} userProfile={os.userProfile} npcEnabled onChangeNpc={() => {}} caianMet onRequestRewind={() => {}} onClose={close} backRef={backRef}/>;
    if (view === 'water' || view === 'board') return <FishingMarketOverlay apiConfig={{baseUrl:"https://board-qa.invalid/v1",apiKey:"qa",model:"qa"}} key={view} initialEntry={view} characters={os.characters} userProfile={os.userProfile} onClose={close} onCharacterTrip={async (char, mode) => { ((window as any).facilityTripCalls ||= []).push({ id: char.id, mode }); return (window as any).facilityTripHandler ? (window as any).facilityTripHandler() : { ok: false, reason: 'qa' }; }}/>;
    if (view === 'garden') return <React.Suspense fallback={<p>打開箱庭…</p>}><Garden characters={os.characters} userProfile={os.userProfile} demo onClose={close} onCharacterTrip={async () => ({ ok: false, reason: 'qa' })}/></React.Suspense>;
    if (view === 'caian' || view === 'aiven') return <SARFamiliarityDialog npc={view} onEditUserChibi={() => {}} onClose={close}/>;
    return <p>設施已關閉</p>;
}
async function boot() {
    if (new URLSearchParams(location.search).get('guide') === 'off') for (const facility of SAR_FACILITY_IDS) localStorage.setItem(sarFacilityGuideKey(facility), 'done');
    const characters = await DB.getAllCharacters();
    if (characters.some(char => !char.id.startsWith('qa-facility-'))) throw Error('Use a fresh isolated browser profile for this fixture.');
    if (!characters.length) {
        for (let i = 0; i < 60; i++) await DB.saveCharacter({ id: `qa-facility-${i}`, name: i === 0 ? 'Sully' : `角色 ${String(i).padStart(2, '0')}`,
            avatar: '/assets/sar/caian-chibi.png', systemPrompt: '僅供隔離測試', groupId: i < 30 ? 'qa-a' : 'qa-b', vrState: { enabled: false, intervalMinutes: 120 } } as any);
        await DB.saveCharacterGroup({ id: 'qa-a', name: '第一組', createdAt: 1 });
        await DB.saveCharacterGroup({ id: 'qa-b', name: '第二組', createdAt: 1 });
        await DB.saveUserProfile({ name: 'USER', avatar: '', bio: '' } as any);
        const profile = { title: '潮汐圖書館', logline: '在天亮之前，給漂流的書找到一個名字。', identity: '守書人', lifePatch: '生活', relationship: '同伴', steelSeal: '不丟下一頁', patchCost: '代價', behaviorShift: '偏移', openingScene: '門口堆著舊書。', openingLine: '進來坐坐。', playerPrompt: '你想翻哪一本？', worldName: '潮汐群島' };
        localStorage.setItem('vr_sar_simulations_v1', JSON.stringify({ version: 2, cards: Array.from({ length: 17 }, (_, i) => ({ id: `qa-card-${i}`, charId: 'qa-facility-0', charName: 'Sully', variantId: 'variant-01', storyId: 'story-01', createdAt: i + 1, updatedAt: i + 1, profile: { ...profile, title: ['潮汐圖書館', '昨日來信', '霧中列車'][i % 3] + ' · ' + (i + 1) } })), runs: [] }));
        saveFishingMarketState(createFishingMarketState(42)); await ensureSARCommerce();
        const market = readSARCommerce().market;
        market.sarCommerce!.moduleShop.inventory = Object.fromEntries(SAR_MODULE_CATALOG.map(module => [module.id, 1]));
        market.sarCommerce!.gacha.collection = Object.fromEntries([...getSARModules('variant'), ...getSARModules('story')].slice(0, 20).map(module => [module.id, 1]));
        saveFishingMarketState(market);
        localStorage.setItem('vr_sar_club_state_v1', JSON.stringify({ version: 1, npcPreference: 'show', caianMet: true }));
    }
    if (new URLSearchParams(location.search).has('simple')) { localStorage.setItem('vr_fishing_simple_mode','true'); localStorage.setItem('sar-facility-guide-water-v1','done'); }
    (window as any).cabinetReads = [];
    const read = DB.getVRCardsByCharId;
    DB.getVRCardsByCharId = async id => {
        (window as any).cabinetReads.push(id);
        if ((window as any).failCabinetRead) { (window as any).failCabinetRead = false; throw new Error('QA cabinet read failure'); }
        return read(id);
    };
    createRoot(document.getElementById('root')!).render(<OSProvider><Harness/></OSProvider>);
}
void boot();
