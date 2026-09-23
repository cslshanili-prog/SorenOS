import type { PhoneEvidence } from '../types';

const renderPhoneField = (input: unknown, seen: Set<object>): string => {
    if (input == null) return '';
    const valueType = typeof input;
    if (valueType === 'string') return input as string;
    if (valueType === 'number' || valueType === 'boolean' || valueType === 'bigint') return String(input);
    if (valueType === 'symbol' || valueType === 'function') return String(input);

    if (valueType === 'object') {
        const objectValue = input as object;
        if (seen.has(objectValue)) return '[循環引用]';
        seen.add(objectValue);
        let text: string;
        if (Array.isArray(input)) {
            text = input.map(item => renderPhoneField(item, seen)).filter(Boolean).join('\n');
        } else {
            const entries = Object.entries(input as Record<string, unknown>);
            text = entries.length
                ? entries.map(([key, value]) => `${key}: ${renderPhoneField(value, seen)}`).join('\n')
                : '';
        }
        seen.delete(objectValue);
        return text;
    }

    return String(input);
};

/**
 * LLM 自定義 App 偶爾會把本應為字符串的字段返回成對象。
 * React 不能直接渲染對象；這裡在生成邊界和歷史數據展示邊界統一降級成可讀文本。
 */
export function phoneFieldToText(input: unknown, fallback: string = ''): string {
    const text = renderPhoneField(input, new Set()).trim();
    return text || fallback;
}

export function normalizePhoneEvidence(record: PhoneEvidence): PhoneEvidence {
    const raw = record as unknown as Record<string, unknown>;
    const value = phoneFieldToText(raw.value);
    const html = phoneFieldToText(raw.html);
    return {
        ...record,
        title: phoneFieldToText(raw.title, 'Unknown'),
        detail: phoneFieldToText(raw.detail, '...'),
        value: value || undefined,
        html: html || undefined,
    };
}

/**
 * 生成首次同步與事後補同步共用的私聊卡片載荷。
 * 故意只讀 title/detail/value：record.html（自定義 App 的卡片渲染，見 PhoneEvidence 類型註釋）
 * 是 App 界面專用的展示層，絕不能進這裡——否則 HTML/CSS 代碼會被當成正文塞進角色的聊天上下文。
 */
export function buildPhoneEvidenceChatCard(record: PhoneEvidence, appName: string): {
    content: string;
    metadata: { phoneCard: { app: string; kind: string; title: string; detail: string; value?: string } };
} {
    const normalized = normalizePhoneEvidence(record);
    const app = phoneFieldToText(appName, '手機');
    const content = normalized.type === 'chat'
        ? `[你手機的聊天軟件] 你和「${normalized.title}」的對話：${normalized.detail.replace(/\n/g, ' ')}`
        : `[你手機的${app}] ${normalized.title}${normalized.value ? ` · ${normalized.value}` : ''} — ${normalized.detail}`;
    return {
        content,
        metadata: {
            phoneCard: {
                app,
                kind: normalized.type,
                title: normalized.title,
                detail: normalized.detail,
                value: normalized.value || undefined,
            },
        },
    };
}
