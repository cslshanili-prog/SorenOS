import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { querySwVersion } from '../utils/swVersion';
import { BUILD_LABEL } from '../utils/buildInfo';

/**
 * 構建版本指示器：右下角階梯式堆三行
 *   sw@<SW_VERSION>
 *   <branch>@<shortHash>
 *   開發中內容，不代表最終效果
 *
 * - 右側貼齊成豎直線；左側每行根據實測寬度動態決定圓角（僅在"伸出鄰行"一側）。
 *   分支名長度可變，所以行寬順序不固定，需要 useLayoutEffect 在 paint 前測量。
 * - 僅當 vite.config 注入的 __BUILD_BADGE_VISIBLE__ 為 true 時掛載
 *   （VITE_HIDE_BUILD_BADGE=1 時構建會把它編譯成 false → 樹搖掉）
 * - SW 版本通過 utils/swVersion 的 GET_SW_VERSION 協議查詢；SW 未註冊 /
 *   不響應時顯示 sw@?
 * - pointer-events-none + select-none：不可點、不可選、不影響下層交互
 * - z-[2147483647]：保證蓋在所有 modal / 動畫 / 全屏覆蓋層之上
 * - safe-area-inset：iOS PWA 底部 home indicator 區域避讓
 *
 * 注：這是 dev / fork 專用的醒目角標。正式版（main/master）會被樹搖掉，
 * 但構建 / SW 版本仍通過 Settings 底部的 VersionInfo 低調展示，方便用戶報障。
 */
const BuildBadge: React.FC = () => {
    if (!__BUILD_BADGE_VISIBLE__) return null;

    const buildLabel = BUILD_LABEL;
    const [swVersion, setSwVersion] = useState<string>('…');
    const lineRefs = useRef<Array<HTMLSpanElement | null>>([]);
    const [widths, setWidths] = useState<number[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        querySwVersion().then((v) => { if (!cancelled) setSwVersion(v); });
        return () => { cancelled = true; };
    }, []);

    // 右側貼齊 (rounded-tr 僅頂行, rounded-br 僅末行)。
    // 左側逐行測寬: 僅當當前行嚴格寬於上 / 下鄰行時, 該側伸出, 才給圓角;
    // 等寬 / 更窄時, 鄰行會覆蓋到當前行外側, 圓角會形成凹縫, 所以給方角讓它們貼上。
    const lines: Array<{ text: string; cls: string }> = [
        { text: `sw@${swVersion}`, cls: 'text-[9px] tracking-wider' },
        { text: buildLabel, cls: 'text-[9px] tracking-wider' },
        { text: '開發中內容，不代表最終效果', cls: 'text-[8px] tracking-normal text-white/35' },
    ];
    const lastIdx = lines.length - 1;

    useLayoutEffect(() => {
        setWidths(lineRefs.current.map((r) => r?.offsetWidth ?? 0));
    }, [swVersion, buildLabel]);

    const cornerClass = (i: number): string => {
        const w = widths?.[i];
        const wPrev = i > 0 ? widths?.[i - 1] : undefined;
        const wNext = i < lastIdx ? widths?.[i + 1] : undefined;
        const topLeft = widths === null || (w !== undefined && (wPrev === undefined || w > wPrev));
        const bottomLeft = widths === null || (w !== undefined && (wNext === undefined || w > wNext));
        return [
            topLeft && 'rounded-tl-md',
            bottomLeft && 'rounded-bl-md',
            i === 0 && 'rounded-tr-md',
            i === lastIdx && 'rounded-br-md',
        ].filter(Boolean).join(' ');
    };

    return (
        <div
            aria-hidden
            className="fixed pointer-events-none select-none"
            style={{
                bottom: 'calc(var(--safe-bottom) + 4px)',
                right: 'calc(env(safe-area-inset-right, 0px) + 6px)',
                zIndex: 2147483647,
                touchAction: 'none',
            }}
        >
            <div
                className="font-mono text-white/45 flex flex-col items-end leading-[1.25]"
                style={{ letterSpacing: '0.05em' }}
            >
                {lines.map((line, i) => (
                    <span
                        key={i}
                        ref={(el) => { lineRefs.current[i] = el; }}
                        className={`${line.cls} px-1.5 py-[1px] bg-black/35 backdrop-blur-sm shadow-sm ${cornerClass(i)}`}
                    >
                        {line.text}
                    </span>
                ))}
            </div>
        </div>
    );
};

export default BuildBadge;
