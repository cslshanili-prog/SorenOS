import React, { useEffect, useRef, useState } from 'react';
import { querySwVersion } from '../../utils/swVersion';
import { APP_VERSION, BUILD_LABEL, BUILD_TIME_LABEL } from '../../utils/buildInfo';
import { isDevDebugAvailable, subscribeDevDebugAvailability, unlockDevDebug } from '../../utils/devDebug';
import { trackEvent } from '../../utils/analytics';
import AndroidUpdateControl from './AndroidUpdateControl';

/**
 * Settings 底部的版本信息腳註。
 *
 * 與右下角的 BuildBadge 不同：BuildBadge 只在 dev / fork 構建可見（正式版樹搖掉），
 * 這裡在**所有**構建（含正式版）裡都低調顯示，方便用戶截圖報障時附帶版本上下文：
 *   - APP_VERSION：手工維護的產品版本名，發版前改 utils/buildInfo.ts
 *   - build：vite.config 注入的 __BUILD_BRANCH__@__BUILD_COMMIT__
 *   - built：vite.config 注入的 UTC+8 構建時間
 *   - sw：運行時向 Service Worker 查詢的 SW_VERSION
 *
 * 構建全局（__BUILD_BRANCH__ 等）由 vite define 始終注入，prod 也有值，
 * 所以無需任何 dev 條件判斷。SW 未註冊 / 未響應時 sw 顯示 '?'。
 *
 * 彩蛋（dev 附加）：連點 APP_VERSION 5 下手動解鎖 DevDebug 面板——正式版默認隱藏，
 * 這是在正式版上臨時調出調試工具排障的入口（會話級，刷新即關；面板內有「關閉」按鈕可隨時強制關掉）。
 * 面板已可用時（非 prod / 已解鎖）再點不計數。
 */

const UNLOCK_TAP_COUNT = 5;
const TAP_RESET_MS = 2000;

// 「SW 有沒有應答」每次會話只報一次：設置頁反覆開關會重複查詢，重複上報會把
// 這項的分母沖淡。標記只存內存變量，標籤頁一關就沒了（跟 utils/analytics.ts 同口徑）。
let swVersionResultReported = false;

const VersionInfo: React.FC = () => {
    const [swVersion, setSwVersion] = useState<string>('…');
    // available = 面板當前是否可用（非 prod 默認 true；prod 解鎖後 true；強制關閉後 false）。
    const [available, setAvailable] = useState<boolean>(() => isDevDebugAvailable());
    const [hint, setHint] = useState<string | null>(null);
    const tapCountRef = useRef(0);
    const tapTimerRef = useRef<number | null>(null);
    const hintTimerRef = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        querySwVersion().then((v) => {
            if (!cancelled) setSwVersion(v);
            if (!swVersionResultReported) {
                swVersionResultReported = true;
                // 只報「SW 有沒有回話」。'?' = 沒註冊 / 被禁用 / 1.5 秒內沒回包，
                // 版本號字符串本身不上報。
                trackEvent('查询 Service Worker 版本', { 结果: v === '?' ? '无应答' : '已应答' });
            }
        });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => subscribeDevDebugAvailability(setAvailable), []);

    // 卸載時清掉計時器，避免內存洩漏 / 卸載後 setState。
    useEffect(() => () => {
        if (tapTimerRef.current) window.clearTimeout(tapTimerRef.current);
        if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    }, []);

    const showHint = (text: string, ms: number) => {
        setHint(text);
        if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
        hintTimerRef.current = window.setTimeout(() => setHint(null), ms);
    };

    const handleVersionTap = () => {
        if (available) return; // 面板已經開著（非 prod 或已解鎖），不用再數
        if (tapTimerRef.current) window.clearTimeout(tapTimerRef.current);
        tapCountRef.current += 1;
        const remaining = UNLOCK_TAP_COUNT - tapCountRef.current;

        if (remaining <= 0) {
            tapCountRef.current = 0;
            unlockDevDebug();
            trackEvent('连点版本号解锁调试面板');
            showHint('🔧 調試面板已解鎖（刷新即關閉）', 2600);
            return;
        }
        if (remaining <= 2) showHint(`還差 ${remaining} 下…`, TAP_RESET_MS);
        // 間隔超過 TAP_RESET_MS 沒繼續點就重置計數。
        tapTimerRef.current = window.setTimeout(() => { tapCountRef.current = 0; }, TAP_RESET_MS);
    };

    return (
        <div className="flex flex-col items-center gap-1.5 pt-2 pb-8 select-none">
            <button
                type="button"
                onClick={handleVersionTap}
                className="text-[10px] text-slate-300 font-mono tracking-widest uppercase"
            >
                {APP_VERSION}
            </button>
            <div className="flex flex-col items-center gap-1 text-[9px] font-mono text-slate-400/80">
                <div className="flex items-center gap-1.5">
                    <span className="px-1.5 py-0.5 rounded-md bg-slate-100 tracking-wide">
                        build&nbsp;<span className="text-slate-500">{BUILD_LABEL}</span>
                    </span>
                    <span className="px-1.5 py-0.5 rounded-md bg-slate-100 tracking-wide">
                        sw&nbsp;<span className="text-slate-500">{swVersion}</span>
                    </span>
                </div>
                <span className="max-w-full px-1.5 py-0.5 rounded-md bg-slate-100 text-center tracking-wide">
                    built&nbsp;<span className="text-slate-500">{BUILD_TIME_LABEL}</span>
                </span>
            </div>
            {hint && (
                <div className="text-[9px] font-mono text-amber-500/80 tracking-normal normal-case">
                    {hint}
                </div>
            )}
            <AndroidUpdateControl />
        </div>
    );
};

export default VersionInfo;
