import React from 'react';
import { SmileyWink } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { AppID } from '../../types';
import { trackEvent } from '../../utils/analytics';
import { setSoreHandoff, type SoreHandoff } from '../../utils/assistant/handoff';

/**
 * 各處美化編輯頁的「請 Sore 幫忙」（plans/ai-assistant.md 第 3 節）。
 * 點了打開 Sore、開一段新對話，Sore 第一句就知道要改哪裡；Sore 的返回鍵回到這個 App。
 */
// 埋點屬性是固定枚舉（docs/analytics.md），用簡體
const LOCATION_EVENT_LABEL: Record<SoreHandoff['location'], string> = {
    chat_chrome_global: '白框全域', chat_chrome_char: '白框角色', chat_chrome_group: '白框群',
    bubble_theme: '气泡', date: '见面', thinking_chain: '心象卡', journal: '交换日记', schedule: '日程',
};

const AskSoreButton: React.FC<Omit<SoreHandoff, 'from'> & { className?: string; compact?: boolean }> = ({ className, compact, ...handoff }) => {
    const { openApp, activeApp } = useOS();
    return (
        <button
            type="button"
            data-ask-sore={handoff.location}
            onClick={() => {
                setSoreHandoff({ ...handoff, from: activeApp });
                trackEvent('从捷径找Sore', { 位置: LOCATION_EVENT_LABEL[handoff.location] });
                openApp(AppID.Assistant);
            }}
            className={className || `inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 ${compact ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-[12px]'} font-bold text-amber-700 active:scale-95 transition`}
        >
            <SmileyWink size={compact ? 12 : 14} weight="fill" /> 請 Sore 幫忙
        </button>
    );
};

export default AskSoreButton;
