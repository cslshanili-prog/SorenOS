import React, { useEffect, useRef, useState } from 'react';
import { CaretDown, LockKey, Play, Star } from '@phosphor-icons/react';
import { FISHING_MARKET_STORAGE_KEY, readFishingMarketState } from '../../utils/vrWorld/fishingMarket';
import { CAIAN_SCENES } from '../../utils/vrWorld/sarFamiliarity/caian';
import { AIVEN_SCENES } from '../../utils/vrWorld/sarFamiliarity/aiven';
import { freshFamiliarity, type FamiliarityProgress, type FamiliarityState } from '../../utils/vrWorld/sarFamiliarity/storageTypes';
import type { FamiliarityNpc, FamiliarityScene } from '../../utils/vrWorld/sarFamiliarity/types';
import { canPreviewFamiliarityEvent, useSARExpressionReviewEnabled } from '../../utils/vrWorld/sarFamiliarity/devPreview';
import { SARPortrait } from './SARNpcArt';
import { readExpressionEdits, subscribeExpressionEdits, type ExpressionEdit } from '../../utils/vrWorld/sarFamiliarity/expressionReview';
import { SARExpressionExport } from './SARExpressionReview';
import './sar-familiarity-roster.css';

const PROFILES = {
    caian: { name: '凱恩', roman: 'Caian', number: '01', role: 'SAR 社長', occupation: '彼方兼職管理員',
        description: [
            '來自另一個世界的彼方玩家。和艾文一起取得了活動室的臨時管理權限後，非常自然地把這裡改造成了 SAR 的活動據點。',
            '看起來是精力過剩的熱血社長，實際上是個重度遊戲宅。喜歡遊戲、動畫、新技術和一切看起來“可以加個功能”的東西，最近正在興致勃勃地研究彼方的人格推演與模塊系統。',
            '似乎對人工人格與 AI 有一些不同尋常的執著。',
        ], quote: ['“閒置空間就是應該充分利用！所以我加個扭蛋機也很合理吧？”'] },
    aiven: { name: '艾文', roman: 'Aiven', number: '02', role: 'SAR 掛名成員', occupation: '彼方兼職管理員',
        description: [
            '和凱恩來自同一個世界。本人並沒有多少經營活動室的熱情，大部分時間都待在水邊釣魚。',
            '喜歡魚和恐龍。掌握著大量不知道什麼時候才會派上用場的魚類與古生物知識。話很少，但並不難相處。就算沒有話題，和他一起坐著似乎也沒關係。',
            '最近釣上來的東西越來越不對勁。',
        ], quote: ['“剛才釣到一張角色卡。”', '“……字泡掉了。”'] },
} as const;
const SCENES = { caian: CAIAN_SCENES, aiven: AIVEN_SCENES };
const ranks = [1, 2, 3] as const;
const rankNames = ['一', '二', '三', '四', '五'];
const formatDate = (at: number) => new Date(at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });

function MemoryRow({ scene, progress, index, onOpen }: { scene: FamiliarityScene; progress: FamiliarityProgress; index: number; onOpen: () => void }) {
    const completed = progress.completed[scene.id], preview = !completed && canPreviewFamiliarityEvent(scene), available = !!completed || preview;
    const label = available ? scene.title : scene.kind === 'event' ? `${rankNames[scene.rank - 1]}星事件` : `${scene.kind === 'topic' ? '話題' : '彩蛋'} ${String(index + 1).padStart(2, '0')}`;
    return <button data-scene-id={scene.id} className={`sar-roster-memory ${available ? 'is-complete' : 'is-locked'}`} type="button" disabled={!available} onClick={onOpen} aria-label={available ? `回顧${scene.title}` : `${label} · 尚未解鎖`}>
        <span className="sar-roster-memory-icon">{available ? <Play size={15} weight="fill"/> : <LockKey size={15}/>}</span>
        <span className="sar-roster-memory-title"><strong>{label}</strong><small>{completed ? `${formatDate(completed.at)} · 已收錄` : preview ? '臨時開放 · 測試回顧' : '尚未解鎖'}</small></span>
        {scene.kind === 'event' && <span className="sar-roster-memory-rank">{'★'.repeat(scene.rank)}</span>}
    </button>;
}

export function SARFamiliarityRoster({ onOpenScene }: { onOpenScene: (npc: FamiliarityNpc, sceneId?: string) => void }) {
    const reviewEnabled=useSARExpressionReviewEnabled();
    const [npc, setNpc] = useState<FamiliarityNpc>('caian');
    const [tab, setTab] = useState<'profile' | 'memories'>('profile');
    const [state, setState] = useState<FamiliarityState>(() => freshFamiliarity());
    const [error, setError] = useState('');
    const [edits,setEdits]=useState<ExpressionEdit[]>([]),[reviewError,setReviewError]=useState('');
    const root = useRef<HTMLElement>(null);
    const scroll = useRef<HTMLElement>(null);
    useEffect(()=>{
        if(!reviewEnabled)return;
        const refresh=()=>{try{setEdits(readExpressionEdits());setReviewError('');}catch(e){setReviewError(e instanceof Error?e.message:'校對草稿無法讀取');}};
        refresh();return subscribeExpressionEdits(refresh);
    },[reviewEnabled]);
    useEffect(() => {
        const refresh = () => { try { setState(readFishingMarketState().sarFamiliarity || freshFamiliarity()); setError(''); } catch (e) { setError(e instanceof Error ? e.message : '名冊暫時無法讀取'); } };
        const storage = (event: StorageEvent) => { if (!event.key || event.key === FISHING_MARKET_STORAGE_KEY) refresh(); };
        refresh(); window.addEventListener('vr-fishing-market-updated', refresh); window.addEventListener('storage', storage); window.addEventListener('focus', refresh);
        return () => { window.removeEventListener('vr-fishing-market-updated', refresh); window.removeEventListener('storage', storage); window.removeEventListener('focus', refresh); };
    }, []);
    useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [npc, tab]);
    const profile = PROFILES[npc], progress = state.npcs[npc], scenes = SCENES[npc];
    const completedCount = scenes.filter(scene => progress.completed[scene.id]).length;
    const events = scenes.filter(scene => scene.kind === 'event'), eggs = scenes.filter(scene => scene.kind === 'easter' || scene.kind === 'encounter');
    useEffect(() => {
        const target = window as Window & { render_game_to_text?: () => string };
        const render = () => JSON.stringify({ mode: 'sar-familiarity-roster', npc, tab, stars: progress.stars, completed: scenes.filter(scene => progress.completed[scene.id]).map(scene => scene.id), total: scenes.length, error });
        target.render_game_to_text = render;
        return () => { if (target.render_game_to_text === render) delete target.render_game_to_text; };
    }, [npc, tab, state, error]);
    const row = (scene: FamiliarityScene, index: number) => <MemoryRow key={scene.id} scene={scene} index={index} progress={progress} onOpen={() => { if (!error && (progress.completed[scene.id] || canPreviewFamiliarityEvent(scene))) onOpenScene(npc, scene.id); }}/>;
    return <section className="sar-familiarity-roster" ref={root}>
        <main className="sar-roster-scroll" ref={scroll}>
            <nav className="sar-roster-person-tabs" aria-label="選擇名冊角色">{(['caian', 'aiven'] as const).map(who => <button type="button" key={who} aria-pressed={npc === who} onClick={() => setNpc(who)}><small>{PROFILES[who].number}</small>{PROFILES[who].name}<span>{PROFILES[who].roman}</span></button>)}</nav>
            <div className={`sar-roster-hero is-${npc}`}>
                <div className="sar-roster-identity"><small>彼方常駐成員</small><h3>{profile.name}</h3><span className="sar-roster-roman">{profile.roman}</span><p>18 歲 · 大學一年級</p><p>{profile.role}<br/>{profile.occupation}</p></div>
                <div className="sar-roster-portrait"><SARPortrait who={npc} expression="normal"/></div>
                <div className="sar-roster-familiarity"><span>熟悉度</span><div className="sar-roster-stars" role="img" aria-label={`熟悉度 ${progress.stars} / 5 星`}>{[1, 2, 3, 4, 5].map(star => <Star key={star} size={19} weight={progress.stars >= star ? 'fill' : 'regular'} className={progress.stars >= star ? 'is-lit' : ''}/>)}</div><small>{completedCount} 段回憶</small></div>
            </div>
            <nav className="sar-roster-detail-tabs" aria-label="名冊內容"><button type="button" aria-pressed={tab === 'profile'} onClick={() => setTab('profile')}>人物檔案</button><button type="button" aria-pressed={tab === 'memories'} onClick={() => setTab('memories')}>回憶 <span>{completedCount}</span></button></nav>
            {error ? <p role="alert" className="sar-roster-error">{error}</p> : tab === 'profile' ? <article className="sar-roster-biography" key={npc}>
                {profile.description.map(text => <p key={text}>{text}</p>)}
                <blockquote>{profile.quote.map(text => <p key={text}>{text}</p>)}</blockquote>
            </article> : <div className="sar-roster-memories" key={npc}>
                {reviewEnabled?<div className="sar-roster-review-note"><p>臨時校對 · 兩人全部話題、事件和彩蛋已開放。進入回顧後點「表情校對」逐句調整。</p><SARExpressionExport edits={edits}/>{reviewError&&<p role="alert">{reviewError}</p>}</div>:<p className="sar-roster-hint">相遇過的話題會留在這裡，隨時可以再看一遍。</p>}
                <section><h4>星級事件 <span>{events.filter(scene => progress.completed[scene.id]).length} / 3</span></h4>{events.map(row)}<div className="sar-roster-coming"><LockKey size={13}/><span>四星、五星故事尚未開放</span></div></section>
                <section><h4>日常話題</h4>{ranks.map(rank => { const topics = scenes.filter(scene => scene.kind === 'topic' && scene.rank === rank); return <details className="sar-roster-topic-group" key={rank} open={rank === Math.min(3, progress.stars + 1)}><summary tabIndex={0}><span>{rankNames[rank - 1]}星篇章</span><small>{topics.filter(scene => progress.completed[scene.id]).length} / {topics.length}</small><CaretDown size={14}/></summary>{topics.map(row)}</details>; })}</section>
                <section><h4>彩蛋與偶遇 <span>{eggs.filter(scene => progress.completed[scene.id]).length} / {eggs.length}</span></h4>{eggs.length ? eggs.map(row) : <p className="sar-roster-hint">暫時沒有收錄條目。</p>}</section>
            </div>}
        </main>
    </section>;
}
