/**
 * 「這一輪沒上雲，在本地生成」的提示條（輸入框正上方那一條）。
 *
 * 為什麼要有：即時對話的開關寫著「已開啟」，消息卻在本地生成——這中間的落差過去只留在
 * console 和觀察窗裡，用戶查不到。他能看到的只有本地直連失敗時那條讀不懂的網絡報錯，
 * 於是以為是自己網絡壞了。線上真實故障裡，有人就這麼卡了四個小時。
 *
 * 只報兩檔，都是「用戶想上雲、實際沒上」的情形：
 *   worker-outdated     問到了，那台 Worker 確實跑不動 → 指路去更新
 *   worker-unreachable  這一刻夠不著雲端 → 別叫人去更新，多半是網絡，會自己好
 *
 * 用戶自己關掉的（disabled / char-disabled）、點單流程那種本該留在本地的，一律不出聲——
 * 那些是正常行為，報了就成騷擾。
 */
import React, { useEffect, useState } from 'react';
import { AMSG_INSTANT_CHAT_ROUTE_EVENT, type InstantChatRouteDetail } from '../../utils/amsgInstantChat';

const NOTICES: Record<string, { title: string; hint: string }> = {
    'worker-outdated': {
        title: '這一輪在本地生成',
        hint: '雲端那台 Worker 跑不動這條路，去設置裡更新一下',
    },
    'worker-unreachable': {
        title: '這一輪在本地生成',
        hint: '一時連不上雲端，網絡恢復後會自己回去',
    },
};

const InstantChatRouteNotice: React.FC<{ charId: string }> = ({ charId }) => {
    const [reason, setReason] = useState<string | null>(null);

    useEffect(() => {
        // 換會話先清乾淨：上一個角色那輪的結論跟這個角色沒關係。
        setReason(null);
        const onRoute = (event: Event) => {
            const detail = (event as CustomEvent<InstantChatRouteDetail>).detail;
            if (!detail || detail.charId !== charId) return;
            // reason 為 null（這一輪走成了雲端）或不在名單裡的原因，都當「沒什麼好說的」收起來。
            setReason(detail.reason && NOTICES[detail.reason] ? detail.reason : null);
        };
        window.addEventListener(AMSG_INSTANT_CHAT_ROUTE_EVENT, onRoute);
        return () => window.removeEventListener(AMSG_INSTANT_CHAT_ROUTE_EVENT, onRoute);
    }, [charId]);

    const notice = reason ? NOTICES[reason] : null;
    if (!notice) return null;

    return (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-50 border-b border-amber-200/70 text-[11px] text-amber-800">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
            <span className="font-bold shrink-0">{notice.title}</span>
            <span className="opacity-70 truncate">· {notice.hint}</span>
        </div>
    );
};

export default InstantChatRouteNotice;
