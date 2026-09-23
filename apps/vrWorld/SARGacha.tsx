import './sar-gacha.css';
import { SARPageNav } from './SARCharacterPicker';
import { useLocalDateKey } from '../../hooks/useLocalDateKey';
import { SARFacilityGuide } from './SARFacilityGuide';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretLeft, Check, Sparkle, X } from '@phosphor-icons/react';
import {
    getSARModules,
    isSARFreeDrawAvailable,
    readSARGachaState,
    type SARModuleAccent,
    type SARModuleDefinition,
    type SARModulePool,
    type SARGachaState,
} from '../../utils/vrWorld/sarGacha';
import { drawSARModuleWithPayment, ensureSARCommerce, newSARPurchaseId, readSARCommerce, SAR_EXTRA_DRAW_PRICE } from '../../utils/vrWorld/sarCommerce';
import { FISHING_MARKET_STORAGE_KEY } from '../../utils/vrWorld/fishingMarket';

const ACCENT_COLORS: Record<SARModuleAccent, string> = {
    blue: '#79b8ef',
    red: '#d66b64',
    olive: '#a7b96c',
    violet: '#a98ade',
    ivory: '#c9b58d',
    graphite: '#9aa7b3',
    rose: '#d38e9b',
    teal: '#71c5c6',
};

type GachaPhase = 'idle' | 'drawing' | 'capsule' | 'opening' | 'revealed';
type GachaView = 'machine' | 'collection';

const poolCopy = (pool: SARModulePool) => pool === 'variant'
    ? { cn: '異界異格', en: 'ISEKAI VARIANT', prompt: '這一次，TA 會成為誰？', hint: '抽取一枚可以裝載給任意角色的異世界身份', count: 25 }
    : { cn: '異界座標', en: 'WORLD COORDINATE', prompt: '從最危險的那一刻醒來', hint: '抽取一條從劇情中後段直接開場的高壓世界線', count: 24 };

const cssVars = (module: SARModuleDefinition): React.CSSProperties => ({
    '--sar-card-accent': ACCENT_COLORS[module.accent],
} as React.CSSProperties);

const SARRitualSigil: React.FC<{ module: SARModuleDefinition }> = ({ module }) => (
    <div className="sarg-sigil" data-sigil={module.sigil} aria-hidden="true">
        <i className="sarg-sigil__orbit sarg-sigil__orbit--outer" />
        <i className="sarg-sigil__orbit sarg-sigil__orbit--inner" />
        <i className="sarg-sigil__axis" />
        <i className="sarg-sigil__axis sarg-sigil__axis--cross" />
        <i className="sarg-sigil__core" />
    </div>
);

const SARModuleCard = React.memo(function SARModuleCard({ module, quantity = 1, compact = false, onSelect }: {
    module: SARModuleDefinition;
    quantity?: number;
    compact?: boolean;
    onSelect?: (module: SARModuleDefinition) => void;
}) {
    const Wrapper = onSelect ? 'button' : 'div';
    const copy = poolCopy(module.pool);
    return (
        <Wrapper type={onSelect ? 'button' : undefined} onClick={onSelect ? () => onSelect(module) : undefined}
            className={`sarg-card ${compact ? 'sarg-card--compact' : ''}`} style={cssVars(module)}>
            <span className="sarg-card__corner sarg-card__corner--tl" /><span className="sarg-card__corner sarg-card__corner--tr" />
            <span className="sarg-card__corner sarg-card__corner--bl" /><span className="sarg-card__corner sarg-card__corner--br" />
            <div className="sarg-card__head">
                <span>{copy.cn}</span><small>{copy.en}</small><b>No.{module.id.slice(-2)}</b>
            </div>
            <div className="sarg-card__group">{module.group}</div>
            <SARRitualSigil module={module} />
            <div className="sarg-card__body">
                <h3>{module.title}</h3>
                {!compact && <p>{module.summary}</p>}
            </div>
            <div className="sarg-card__foot">
                <span>{module.pool === 'variant' ? '異格收錄狀態' : '世界線收錄狀態'}</span>
                <i /><b>可裝載</b>
            </div>
            {quantity > 1 && <span className="sarg-card__quantity">×{quantity}</span>}
        </Wrapper>
    );
});

const PoolSwitch: React.FC<{
    pool: SARModulePool;
    state: SARGachaState;
    disabled?: boolean;
    onChange: (pool: SARModulePool) => void;
}> = ({ pool, state, disabled, onChange }) => (
    <div className="sarg-pool-switch" role="tablist" aria-label="選擇卡池">
        {(['variant', 'story'] as SARModulePool[]).map(item => {
            const available = isSARFreeDrawAvailable(item, state);
            return (
                <button key={item} type="button" role="tab" aria-selected={pool === item} disabled={disabled}
                    className={pool === item ? 'is-active' : ''} onClick={() => onChange(item)}>
                    <span>{poolCopy(item).cn}</span>
                    <small>{available ? '今日免費' : `${SAR_EXTRA_DRAW_PRICE} 鱗幣 / 次`}</small>
                </button>
            );
        })}
    </div>
);

const SARGachaMachine = React.memo(function SARGachaMachine({ pool, phase, result, onOpenCapsule }: {
    pool: SARModulePool;
    phase: GachaPhase;
    result: SARModuleDefinition | null;
    onOpenCapsule: () => void;
}) { return (
    <div className={`sarg-machine sarg-machine--${phase}`} aria-live="polite">
        <div className="sarg-machine__stars"><i /><i /><i /><i /><i /><i /></div>
        <div className="sarg-machine__halo" />
        <div className="sarg-machine__portal">
            <div className="sarg-machine__ticks" />
            <div className="sarg-machine__rings"><i /><i /><i /></div>
            <div className="sarg-machine__meridian"><i /><i /></div>
            <div className="sarg-machine__core">
                <i />
                <b>{pool === 'variant' ? '異格' : '世界'}</b>
                <small>{pool === 'variant' ? 'I · 25' : 'W · 24'}</small>
            </div>
        </div>
        <div className="sarg-machine__horizon"><i /></div>
        <div className="sarg-machine__caption">
            <span>{phase === 'idle' ? '等待啟動' : phase === 'drawing' ? '座標對齊中' : phase === 'capsule' ? '封裝完成' : '正在破封'}</span>
            <small>{pool === 'variant' ? 'PERSONA DIVERSION CHAMBER' : 'WORLDLINE INTERCEPTION CHAMBER'}</small>
        </div>
        {(phase === 'capsule' || phase === 'opening') && result && (
            <button type="button" className="sarg-capsule" onClick={onOpenCapsule} disabled={phase === 'opening'}
                aria-label={phase === 'capsule' ? '打開扭蛋' : '正在打開扭蛋'} style={cssVars(result)}>
                <span className="sarg-capsule__glow" />
                <span className="sarg-capsule__half sarg-capsule__half--top"><i /></span>
                <span className="sarg-capsule__half sarg-capsule__half--bottom"><i /></span>
                {phase === 'capsule' && <b>點擊開啟</b>}
            </button>
        )}
    </div>
); });

const SARCollection: React.FC<{
    state: SARGachaState;
    pool: SARModulePool;
    onPoolChange: (pool: SARModulePool) => void;
    onSelect: (module: SARModuleDefinition) => void;
}> = ({ state, pool, onPoolChange, onSelect }) => {
    const modules = useMemo(() => getSARModules(pool).filter(module => (state.collection[module.id] || 0) > 0), [pool, state]);
    const [page, setPage] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const pages = Math.max(1, Math.ceil(modules.length / 8));
    const shownPage = Math.min(page, pages - 1);
    const changePage = (next: number) => { setPage(next); scrollRef.current?.scrollTo({ top: 0 }); };
    const owned = modules.length;
    const totalCopies = modules.reduce((sum, module) => sum + (state.collection[module.id] || 0), 0);
    return (
        <div className="sarg-collection" ref={scrollRef}>
            <div className="sarg-collection__intro">
                <div><small>ISEKAI ARCHIVE</small><h2>異世界模塊陳列</h2></div>
                <div className="sarg-collection__count"><b>{owned}</b><span> / {poolCopy(pool).count}<br />共 {totalCopies} 枚</span></div>
            </div>
            <PoolSwitch pool={pool} state={state} onChange={next => { changePage(0); onPoolChange(next); }} />
            <SARPageNav page={shownPage} pages={pages} onChange={changePage} label="模塊"/>
            {modules.length ? (
                <div className="sarg-collection__grid">
                    {modules.slice(shownPage * 8, (shownPage + 1) * 8).map(module => <SARModuleCard key={module.id} module={module} compact quantity={state.collection[module.id]} onSelect={onSelect} />)}
                </div>
            ) : (
                <div className="sarg-empty">
                    <div className="sarg-empty__mark"><i /><i /></div>
                    <h3>陳列槽位為空</h3>
                    <p>從{poolCopy(pool).cn}池完成一次抽取，新的異世界模塊會被送到這裡。</p>
                </div>
            )}
        </div>
    );
};

const SARModuleDetail: React.FC<{
    module: SARModuleDefinition;
    quantity: number;
    onClose: () => void;
}> = ({ module, quantity, onClose }) => (
    <div className="sarg-detail-backdrop" role="dialog" aria-modal="true" aria-label={`${module.title}模塊詳情`} onClick={onClose}>
        <div className="sarg-detail" onClick={event => event.stopPropagation()}>
            <button type="button" className="sarg-detail__close" onClick={onClose} aria-label="關閉模塊詳情"><X size={16} /></button>
            <div className="sarg-detail__card"><SARModuleCard module={module} quantity={quantity} /></div>
            <div className="sarg-detail__copy">
                <small>{poolCopy(module.pool).en} · {module.group}</small>
                <h2>{module.title}</h2>
                <p>{module.summary}</p>
                <div className="sarg-detail__memory"><b>關係約束</b><span>{module.memory}</span></div>
                {module.routeTags && <div className="sarg-detail__tags">{module.routeTags.map(tag => <span key={tag}>{tag}</span>)}</div>}
                <button type="button" disabled className="sarg-detail__simulate">用於異世界鑄造 <span>前往陳列櫃裝載</span></button>
            </div>
        </div>
    </div>
);

export const SARGachaOverlay: React.FC<{
    onClose: () => void;
}> = ({ onClose }) => {
    // Free draws follow the device calendar even when all commerce data is unchanged.
    useLocalDateKey();
    const [helpOpen, setHelpOpen] = useState(false);
    const [pageVisible, setPageVisible] = useState(() => !document.hidden);
    const [view, setView] = useState<GachaView>('machine');
    const [pool, setPool] = useState<SARModulePool>('variant');
    const [phase, setPhase] = useState<GachaPhase>('idle');
    const [state, setState] = useState<SARGachaState>(() => readSARGachaState());
    const [balance, setBalance] = useState(0);
    const [ready, setReady] = useState(false);
    const [paying, setPaying] = useState(false);
    const [error, setError] = useState('');
    const payingRef = useRef(false);
    const lastSnapshot = useRef({ gacha: JSON.stringify(state), balance: 0 });
    const applySnapshot = useCallback((value: { gacha: SARGachaState; balance: number }) => {
        const key = JSON.stringify(value.gacha);
        // Market ticks often change other facilities only. Keep the existing render snapshot.
        if (lastSnapshot.current.gacha !== key) { lastSnapshot.current.gacha = key; setState(value.gacha); }
        if (lastSnapshot.current.balance !== value.balance) { lastSnapshot.current.balance = value.balance; setBalance(value.balance); }
    }, []);
    useEffect(() => {
        let live = true;
        const refresh = () => { try { const value = readSARCommerce(); if (live) { applySnapshot(value); } } catch (cause) { if(live)setError(cause instanceof Error ? cause.message : '餘額讀取失敗'); } };
        void ensureSARCommerce().then(value => { if(live){applySnapshot(value);setReady(true);} }).catch(cause=>{if(live)setError(cause.message);});
        const onStorage = (event: StorageEvent) => { if(event.key === FISHING_MARKET_STORAGE_KEY)refresh(); };
        window.addEventListener('vr-fishing-market-updated',refresh);window.addEventListener('storage',onStorage);window.addEventListener('focus',refresh);
        const onVisibility = () => { setPageVisible(!document.hidden); if (!document.hidden) refresh(); };
        document.addEventListener('visibilitychange', onVisibility);
        const timer = window.setInterval(() => { if (!document.hidden) refresh(); },30000);
        return()=>{live=false;document.removeEventListener('visibilitychange',onVisibility);window.clearInterval(timer);window.removeEventListener('vr-fishing-market-updated',refresh);window.removeEventListener('storage',onStorage);window.removeEventListener('focus',refresh);};
    },[applySnapshot]);
    const [result, setResult] = useState<SARModuleDefinition | null>(null);
    const [firstCopy, setFirstCopy] = useState(false);
    const [detail, setDetail] = useState<SARModuleDefinition | null>(null);
    const timer = useRef<number | null>(null);
    const reducedMotion = useRef(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

    useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

    useEffect(() => {
        const gameWindow = window as unknown as {
            render_game_to_text?: () => string;
            advanceTime?: (ms: number) => void;
        };
        const previousRender = gameWindow.render_game_to_text;
        const previousAdvance = gameWindow.advanceTime;
        gameWindow.render_game_to_text = () => JSON.stringify({
            screen: view,
            pool,
            phase,
            balance,
            price: isSARFreeDrawAvailable(pool, state) ? 0 : SAR_EXTRA_DRAW_PRICE,
            freeDrawAvailable: isSARFreeDrawAvailable(pool, state),
            collectedUnique: Object.keys(state.collection).filter(id => state.collection[id] > 0).length,
            result: result ? { id: result.id, title: result.title, group: result.group } : null,
        });
        gameWindow.advanceTime = () => {
            if (phase !== 'drawing' && phase !== 'opening') return;
            if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
            if (phase === 'drawing') setPhase('capsule');
            if (phase === 'opening') setPhase('revealed');
        };
        return () => {
            gameWindow.render_game_to_text = previousRender;
            gameWindow.advanceTime = previousAdvance;
        };
    }, [phase, pool, result, state, view, balance]);

    const schedule = useCallback((callback: () => void, normalDelay: number) => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(callback, reducedMotion.current ? 80 : normalDelay);
    }, []);

    const startDraw = async () => {
        if (phase !== 'idle' || payingRef.current || !ready) return;
        payingRef.current=true;setPaying(true);setError('');
        try {
            const draw = await drawSARModuleWithPayment(pool,{requestId:newSARPurchaseId(),maxCost:isSARFreeDrawAvailable(pool,state)?0:SAR_EXTRA_DRAW_PRICE});
            applySnapshot(draw);setResult(draw.module);setFirstCopy(draw.firstCopy);
            setPhase('drawing');schedule(() => setPhase('capsule'), 1550);
        } catch(cause) { setError(cause instanceof Error?cause.message:'抽取未完成，沒有扣款'); }
        finally { payingRef.current=false;setPaying(false); }
    };

    const openCapsule = useCallback(() => {
        if (phase !== 'capsule') return;
        setPhase('opening');
        schedule(() => setPhase('revealed'), 920);
    }, [phase, schedule]);

    const resetMachine = () => {
        setResult(null);
        setFirstCopy(false);
        setPhase('idle');
    };

    const changePool = (next: SARModulePool) => {
        if (phase !== 'idle') return;
        setPool(next);
        setResult(null);
    };

    const free = isSARFreeDrawAvailable(pool, state);
    const available = ready && (free || balance >= SAR_EXTRA_DRAW_PRICE);
    const collectedUnique = Object.keys(state.collection).filter(id => state.collection[id] > 0).length;
    const busy = paying || phase === 'drawing' || phase === 'capsule' || phase === 'opening';

    return (
        <div className={`sarg-root sarg-root--${pool} sarg-root--${phase}`} role="dialog" aria-modal="true" aria-label="SAR 異世界異格扭蛋機" data-motion-paused={!pageVisible || helpOpen}>
            <div className="sarg-noise" />
            <header className="sarg-header sar-facility-header">
                <button type="button" onClick={view === 'collection' ? () => setView('machine') : onClose} aria-label={view === 'collection' ? '返回扭蛋機' : '離開扭蛋機'}>
                    {view === 'collection' ? <CaretLeft size={19} /> : <X size={18} />}
                </button>
                <div><small>SAR ACTIVITY SPACE · 01</small><h1>異世界異格扭蛋</h1></div>
                <button type="button" className="sarg-header__archive" onClick={() => setView(view === 'collection' ? 'machine' : 'collection')} disabled={busy} aria-label="打開異世界模塊陳列">
                    <span>{collectedUnique}</span><i>藏品</i>
                </button>
                <SARFacilityGuide facility="gacha" onOpenChange={setHelpOpen}/>
            </header>

            {view === 'collection' ? (
                <SARCollection state={state} pool={pool} onPoolChange={setPool} onSelect={setDetail} />
            ) : (
                <main className="sarg-main">
                    <PoolSwitch pool={pool} state={state} disabled={busy || phase === 'revealed'} onChange={changePool} />
                    {phase === 'revealed' && result ? (
                        <div className="sarg-reveal" style={cssVars(result)}>
                            <div className="sarg-reveal__aura"><i /><i /><i /></div>
                            <div className="sarg-reveal__eyebrow"><Sparkle size={12} weight="fill" /> {firstCopy ? '首次顯現' : '世界線共振'}</div>
                            <div className="sarg-reveal__card"><SARModuleCard module={result} quantity={state.collection[result.id]} /></div>
                            <div className="sarg-reveal__name"><small>{result.group}</small><b>{result.title}</b></div>
                            <div className="sarg-reveal__actions">
                                <button type="button" className="sarg-primary" onClick={() => { setView('collection'); resetMachine(); }}><Check size={15} weight="bold" /> 收入陳列</button>
                                <button type="button" className="sarg-secondary" onClick={resetMachine}>再看看機器</button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="sarg-pool-copy">
                                <small>{poolCopy(pool).en} · {poolCopy(pool).count}</small>
                                <h2>{poolCopy(pool).prompt}</h2>
                                <p>{poolCopy(pool).hint}</p>
                            </div>
                            <SARGachaMachine pool={pool} phase={phase} result={result} onOpenCapsule={openCapsule} />
                            <div className="sarg-draw-panel">
                                {phase === 'capsule' ? (
                                    <p className="sarg-machine-status">異世界座標已封入 · 點擊扭蛋開啟</p>
                                ) : phase === 'opening' ? (
                                    <p className="sarg-machine-status">正在解除封裝……</p>
                                ) : phase === 'drawing' ? (
                                    <p className="sarg-machine-status">正在對齊分歧座標……</p>
                                ) : (
                                    <>
                                        <div className="sarg-draw-panel__meta"><span>我的鱗幣</span><b>{balance}</b></div>
                                        <button type="button" className="sarg-draw-button" disabled={!available||paying} onClick={()=>void startDraw()}>
                                            <span>{paying?'正在保存…':!ready?'正在讀取…':available?(free?'今日免費抽取':`支付 ${SAR_EXTRA_DRAW_PRICE} 鱗幣抽取`):'鱗幣不足'}</span><small>{poolCopy(pool).cn}</small>
                                        </button>
                                        <p>{available?`兩池每天各免費一次，其後每次 ${SAR_EXTRA_DRAW_PRICE} 鱗幣。`:'可以去釣魚、逛佈告板賺取鱗幣，也可以明天再免費抽取。'}</p>
                                        {error&&<p role="alert" style={{color:'#bd795e'}}>{error}</p>}
                                    </>
                                )}
                            </div>
                        </>
                    )}
                </main>
            )}

            {detail && <SARModuleDetail module={detail} quantity={state.collection[detail.id] || 1} onClose={() => setDetail(null)} />}
        </div>
    );
};
