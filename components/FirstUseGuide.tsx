import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';
import { GUIDE_SULLY_ID, hasGuideApi, setGuideStep, setVectorGuideSkipped, useFirstUseGuideStep, useVectorGuideSkipped } from '../utils/firstUseGuide';

const titles = ['為了您的使用體驗，請先配置 API 和向量記憶！', '配置向量記憶', '開啟 Sully 的全自動記憶', '從神經鏈接進入聊天', '認識生成按鈕', '試著從桌面回到聊天', '記憶會自動整理'];
const descriptions = [
    '先填寫聊天服務商提供的地址、API Key 和聊天模型，並保存 API 配置。保存後點擊下一步。',
    '向量模型負責按含義找回記憶，與聊天模型不同。不熟悉的話，按下方硅基流動預設選擇模型、填寫 Key 並保存；熟悉 Embedding 的用戶也可以填寫其他兼容的向量模型。',
    '在 Sully 卡片上先開啟「記憶宮殿」，再開啟「全自動記憶」。之後達到整理條件時會自動歸檔和召回，無需每次手動操作。自動整理會使用 API，並按服務商規則計費。',
    '點擊 Sully，再點擊角色詳情右上角的「發消息」，就能進入 Sully 的聊天界面。神經鏈接也是日後查看和修改角色記憶的入口。',
    '圈出的閃電按鈕就是「生成」，默認在聊天頁右上角。先在底部輸入併發送文字，再用它讓 Sully 回覆；也可在輸入設置中改為發送按鈕代替生成。這裡只認識位置，不需要點擊：生成會調用 API，可能扣費。',
    '已經回到桌面，請點擊「聊天」App，再次進入對話。以後退出聊天后，也可以這樣回來；聊天頁左上角的返回按鈕可以回到桌面。',
    '配置向量記憶並開啟全自動後，日常只管聊天，無需再主動整理。查看和更改記憶可到「神經鏈接」→ Sully →「記憶」或「門牌」；向量節點在「記憶宮殿」查看。原始記憶檔案是文字記錄，記憶宮殿負責按含義檢索，兩者不需要重複手動維護。',
];

export default function FirstUseGuide() {
    const step = useFirstUseGuideStep();
    const skippedVector = useVectorGuideSkipped();
    const { apiConfig, memoryPalaceConfig, characters, activeApp, activeCharacterId, openApp, setActiveCharacterId } = useOS();
    const [collapsed, setCollapsed] = useState(false);
    const [targetReady, setTargetReady] = useState(false);
    const [targetHint, setTargetHint] = useState<{ text: string; left: number; top: number; below: boolean } | null>(null);
    const pendingPage = useRef<AppID | null>(null);
    const sully = characters.find(c => c.id === GUIDE_SULLY_ID);
    const navigate = (target: number) => {
        setActiveCharacterId(GUIDE_SULLY_ID);
        const app = target === 0 ? AppID.Settings : target <= 2 ? AppID.MemoryPalace : target === 3 ? AppID.Character : target === 5 ? AppID.Launcher : AppID.Chat;
        pendingPage.current = app;
        openApp(app);
        window.dispatchEvent(new Event('sully:guide-navigate'));
    };
    // Resume after refresh; do not pull the user back while they interact with a page.
    useEffect(() => { if (step !== null) navigate(step); }, [step]);
    useEffect(() => {
        // Navigation must render before accepting a click back into Chat.
        if (pendingPage.current !== null) {
            if (activeApp !== pendingPage.current) return;
            pendingPage.current = null;
        }
        if (step === 3 && activeApp === AppID.Chat && activeCharacterId === GUIDE_SULLY_ID) setGuideStep(4);
        if (step === 5 && activeApp === AppID.Chat) setGuideStep(6);
    }, [step, activeApp, activeCharacterId]);
    useEffect(() => {
        setTargetHint(null);
        if (step === null) return;
        setTargetReady(false);
        let current: Element | null = null;
        let hint = '';
        const placeHint = () => {
            if (!current) { setTargetHint(null); return; }
            const rect = current.getBoundingClientRect();
            const guideBottom = document.querySelector('[aria-label="首次使用引導"]')?.getBoundingClientRect().bottom || 0;
            if (!rect.width || !rect.height || rect.bottom <= guideBottom || rect.top >= window.innerHeight) {
                setTargetHint(null); return;
            }
            const below = rect.top - 42 < guideBottom;
            const top = below ? Math.min(rect.bottom + 10, window.innerHeight - 42) : rect.top - 42;
            setTargetHint({ text: hint, left: Math.max(104, Math.min(rect.left + rect.width / 2, window.innerWidth - 104)), top: Math.max(guideBottom + 4, top), below });
        };
        const highlight = () => {
            let selector = '';
            if (step === 0) { selector = '[data-guide="api"]'; hint = '在這裡填寫並保存 API'; }
            if (step === 1) {
                selector = hasGuideApi(memoryPalaceConfig.lightLLM) ? '[data-guide="embedding"]' : '[data-guide="use-main-api"]';
                hint = hasGuideApi(memoryPalaceConfig.lightLLM) ? '配置向量記憶，或選擇跳過' : '可點這裡，暫時沿用主 API';
            }
            if (step === 2) { selector = '[data-guide="sully-memory"]'; hint = '開啟這兩個記憶開關'; }
            if (step === 3) {
                selector = document.querySelector('[data-guide="sully-message"]') ? '[data-guide="sully-message"]' : '[data-guide="sully-card"]';
                hint = selector.includes('sully-message') ? '點擊「發消息」進入聊天' : '點擊 Sully，打開角色詳情';
            }
            if (step === 4) { selector = '[data-guide="generate"]'; hint = '生成按鈕 · 認識位置即可'; }
            if (step === 5) { selector = '[data-launcher-item="chat"]'; hint = '點擊「聊天」回到對話'; }
            let next = selector ? document.querySelector(selector) : null;
            if (step === 2 && next) {
                const toggle = next.querySelector<HTMLInputElement>('input:not(:checked):not(:disabled)');
                if (toggle) {
                    next = toggle.closest('label');
                    hint = sully?.memoryPalaceEnabled ? '點擊開啟「全自動記憶」' : '先點擊開啟「記憶宮殿」';
                }
            }
            if (next === current) { placeHint(); return; }
            current?.classList.remove('first-use-highlight');
            current = next;
            setTargetReady(!!next);
            current?.classList.add('first-use-highlight');
            current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            placeHint();
        };
        const observer = new MutationObserver(highlight);
        const pageRoot = document.getElementById('root') || document.body;
        observer.observe(pageRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-guide', 'checked', 'disabled'] });
        const resize = new ResizeObserver(placeHint);
        resize.observe(pageRoot);
        window.addEventListener('resize', placeHint);
        document.addEventListener('scroll', placeHint, true);
        highlight();
        return () => {
            observer.disconnect(); resize.disconnect(); current?.classList.remove('first-use-highlight');
            window.removeEventListener('resize', placeHint);
            document.removeEventListener('scroll', placeHint, true);
        };
    }, [step, activeApp, memoryPalaceConfig.lightLLM, sully?.memoryPalaceEnabled, sully?.autoArchiveEnabled, collapsed]);
    if (step === null) return null;
    const ready = step === 0 ? hasGuideApi(apiConfig) : step === 1 ? hasGuideApi(memoryPalaceConfig.embedding) && hasGuideApi(memoryPalaceConfig.lightLLM) : step === 2 ? !!(sully?.memoryPalaceEnabled && sully.autoArchiveEnabled) : step === 4 ? activeApp === AppID.Chat && targetReady : step !== 3 && step !== 5;
    return <aside aria-label="首次使用引導" className="relative z-[70] shrink-0 bg-white border-b border-violet-200 px-4 py-3 text-slate-700" style={{ maxHeight: '40%', overflowY: 'auto', paddingTop: 'max(12px, var(--safe-top, 0px))' }}>
        <style>{`
            .first-use-highlight { outline: 4px solid #7c3aed !important; outline-offset: 3px; border-radius: 16px; box-shadow: 0 0 0 9px #ede9fe, 0 0 26px 8px #8b5cf670; animation: first-use-beacon 1.8s ease-in-out infinite !important; }
            @keyframes first-use-beacon { 50% { outline-color: #c026d3; box-shadow: 0 0 0 12px #ede9fe, 0 0 32px 10px #a855f780; } }
            @media (prefers-reduced-motion: reduce) { .first-use-highlight { animation: none !important; } }
        `}</style>
        {targetHint && createPortal(<div aria-hidden="true" style={{ position: 'fixed', zIndex: 10000, pointerEvents: 'none', left: targetHint.left, top: targetHint.top, transform: 'translateX(-50%)', maxWidth: 208, padding: '7px 12px', borderRadius: 12, background: '#6d28d9', color: 'white', fontSize: 12, fontWeight: 700, textAlign: 'center', boxShadow: '0 4px 16px #4c1d9555' }}>
            {targetHint.below ? '↑ ' : '↓ '}{targetHint.text}
        </div>, document.body)}
        <div className="flex items-center justify-between gap-3">
            <strong className="text-sm">{skippedVector && step > 2 ? step : step + 1}/{skippedVector ? 6 : 7} · {step === 6 && skippedVector ? '先開始聊天，記憶稍後配置' : titles[step]}</strong>
            <button className="text-xs shrink-0 text-violet-700" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>{collapsed ? '展開引導' : '收起'}</button>
        </div>
        <div className="flex justify-end mt-2">
            <button type="button" onClick={() => setGuideStep('done')} className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600">直接跳過引導</button>
        </div>
        {!collapsed && <>
            <p className="text-xs leading-relaxed mt-2">{step === 6 && skippedVector ? '你已跳過向量記憶，本次引導沒有為你開啟全自動記憶。現在可以先聊天；之後到「記憶宮殿」配置 Embedding API，再開啟 Sully 的記憶宮殿和全自動記憶。查看和更改角色記憶可到「神經鏈接」。' : descriptions[step]}</p>
            {step === 1 && <>
                <p className="text-xs leading-relaxed mt-2 text-amber-800">全自動記憶需要副 API 整理文字、Embedding API 檢索記憶，兩者缺一不可。副 API 可選擇「我想暫時只用主 API」；向量記憶可暫時跳過。硅基流動需要先在<a className="underline" href="https://cloud.siliconflow.cn" target="_blank" rel="noreferrer">網頁版完成實名認證</a>才能使用。</p>
            </>}
            {step === 6 && <p className="text-xs leading-relaxed mt-2">聊天「＋」→ 設置裡的「一鍵存進記憶宮殿」等是進階手動工具。全自動用戶大部分時候不需要操作，只有明確知道用途和影響時才使用。</p>}
            <div className="flex items-center gap-3 mt-3 text-xs">
                {step > 0 && <button onClick={() => setGuideStep(step === 3 && skippedVector ? 1 : step - 1)}>上一步</button>}
                <button onClick={() => navigate(step)} className="text-violet-700">回到本步頁面</button>
                <button disabled={!ready} onClick={() => { if (step === 1) setVectorGuideSkipped(false); setGuideStep(step === 6 ? 'done' : step + 1); }} className="ml-auto rounded-xl px-4 py-2 bg-violet-600 text-white disabled:opacity-40">{step === 6 ? '完成引導' : step === 4 ? '知道了，回桌面' : '下一步'}</button>
            </div>
            {!ready && <p className="mt-2 text-[11px] text-slate-500">{step <= 1 ? '請填寫並保存完整配置後繼續（保存不代表已驗證連通性）。' : step === 2 ? '請開啟 Sully 的兩個記憶開關後繼續。' : step === 4 ? '等待聊天頁面顯示生成按鈕；離開後可點「回到本步頁面」。' : '按上面的說明點擊頁面入口，即可繼續引導。'}</p>}
        </>}
    </aside>;
}
