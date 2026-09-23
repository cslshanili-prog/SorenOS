import { useEffect, useRef, useState } from 'react';

/**
 * 大列表增量渲染：先渲染前 step 個，滾動到 sentinel 附近時自動追加。
 * 用於表情包網格這類「幾百張 base64 圖一次性掛載會卡爆」的場景。
 * resetKey 變化（如切換分組）時回到初始數量。
 */
export function useIncrementalReveal(total: number, step = 48, resetKey?: unknown) {
    const [count, setCount] = useState(step);
    const sentinelRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        setCount(step);
    }, [resetKey, step]);

    useEffect(() => {
        const el = sentinelRef.current;
        if (!el || count >= total) return;
        const observer = new IntersectionObserver(
            entries => {
                if (entries.some(entry => entry.isIntersecting)) {
                    setCount(current => Math.min(current + step, total));
                }
            },
            { rootMargin: '200px' }
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [count, total, step]);

    return {
        count: Math.min(count, total),
        hasMore: count < total,
        sentinelRef,
    };
}
