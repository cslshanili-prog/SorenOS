import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CharacterProfile } from '../../types';
import { DB } from '../../utils/db';
import { resolveRefToDataUrl } from '../../utils/blobRef';
import { isChatPreviewMessage } from '../../utils/chatMessageVisibility';
import { buildWidgetSrcDoc, type CustomWidgetTemplate, type WidgetCharInfo } from '../../utils/customWidget';
import type { WidgetSize } from '../../utils/launcherLayout';

/**
 * 桌面自訂小組件的畫面（utils/customWidget.ts）。
 *
 * iframe 本身 pointer-events: none：手指落在小組件上，桌面照常滑頁、長按整理；
 * 不在整理中時，上面蓋一層透明的接住「點一下」，把座標轉進 iframe（裡面找到那個元素派 click、看 data-open）。
 * 裡面要打開 App 只認點完 1.5 秒內的，程式不能自己一載入就把人帶走。
 *
 * 圖片在沙盒裡讀不到 Soren 的 blob，一律先轉成 data URL 再填進去。
 */

// 令牌 → data URL 的快取：同一張圖（模板自帶、頭像）多份小組件共用，翻頁回來不用重讀
const dataUrlCache = new Map<string, Promise<string>>();
const CACHE_LIMIT = 60;
const toDataUrl = (value: string): Promise<string> => {
    if (!value) return Promise.resolve('');
    if (/^(data:|https?:)/i.test(value)) return Promise.resolve(value);
    let hit = dataUrlCache.get(value);
    if (!hit) {
        hit = resolveRefToDataUrl(value).catch(() => '');
        dataUrlCache.set(value, hit);
        if (dataUrlCache.size > CACHE_LIMIT) dataUrlCache.delete(dataUrlCache.keys().next().value as string);
    }
    return hit;
};

const cleanPreview = (content: string) => content.replace(/\[.*?\]/g, '').trim();

export const charMood = (char: CharacterProfile | null | undefined) => {
    const buff = char?.activeBuffs?.[0];
    return buff ? `${buff.emoji ? `${buff.emoji} ` : ''}${buff.label || buff.name}` : '';
};

export interface CustomWidgetFrameProps {
    template: CustomWidgetTemplate;
    size: WidgetSize;
    values?: Record<string, string>;
    /** 這一份換掉的圖（鍵 → 令牌） */
    images?: Record<string, string>;
    char?: CharacterProfile | null;
    unread?: number;
    /** 有新訊息就變，拿來重讀最後一則 */
    lastMsgTimestamp?: number;
    userName?: string;
    contentColor?: string;
    /** false：不接點擊（整理中、編輯器預覽） */
    interactive?: boolean;
    onOpen?: (target: string) => void;
}

const CustomWidgetFrame: React.FC<CustomWidgetFrameProps> = ({
    template, size, values, images, char, unread = 0, lastMsgTimestamp, userName, contentColor, interactive = true, onOpen,
}) => {
    const frameRef = useRef<HTMLIFrameElement>(null);
    const lastTapAt = useRef(0);
    const onOpenRef = useRef(onOpen);
    onOpenRef.current = onOpen;
    const [imageUrls, setImageUrls] = useState<Record<string, string> | null>(null);
    const [avatarUrl, setAvatarUrl] = useState('');
    const [lastMessage, setLastMessage] = useState('');
    const [backdrop, setBackdrop] = useState<{ filter: string; radius: string } | null>(null);

    const imageKey = template.imageKeys.map(k => `${k}=${images?.[k] || template.images[k] || ''}`).join('|');
    useEffect(() => {
        let alive = true;
        Promise.all(template.imageKeys.map(async key => [key, await toDataUrl(images?.[key] || template.images[key] || '')] as const))
            .then(entries => { if (alive) setImageUrls(Object.fromEntries(entries)); });
        return () => { alive = false; };
    }, [imageKey]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        let alive = true;
        toDataUrl(char?.avatar || '').then(url => { if (alive) setAvatarUrl(url); });
        return () => { alive = false; };
    }, [char?.avatar]);

    useEffect(() => {
        if (!char) { setLastMessage(''); return; }
        let alive = true;
        DB.getRecentMessagesWithCount(char.id, 1, isChatPreviewMessage)
            .then(recent => {
                if (!alive) return;
                const last = recent.messages[0];
                setLastMessage(last ? (cleanPreview(last.content) || (last.type === 'image' ? '[圖片]' : '[消息]')) : '');
            })
            .catch(() => {});
        return () => { alive = false; };
    }, [char?.id, lastMsgTimestamp]); // eslint-disable-line react-hooks/exhaustive-deps

    const charInfo: WidgetCharInfo | null = char ? { name: char.name, avatar: avatarUrl, lastMessage, unread, mood: charMood(char) } : null;
    const charKey = charInfo ? JSON.stringify(charInfo) : '';
    const srcDoc = useMemo(() => (imageUrls ? buildWidgetSrcDoc({
        template, values, imageUrls, userName, char: charInfo, size, contentColor,
    }) : ''), [template, values, imageUrls, userName, charKey, size.w, size.h, contentColor]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
            const data = event.data;
            if (!data || typeof data !== 'object') return;
            if (data.sorenWidget === 'backdrop') {
                const value = data.value;
                const filter = typeof value?.filter === 'string' ? value.filter.slice(0, 200) : '';
                // 只收 blur()/saturate() 這類濾鏡寫法，別讓裡面塞奇怪的字串
                setBackdrop(filter && /^[\w\s().,%-]+$/.test(filter)
                    ? { filter, radius: typeof value.radius === 'string' && /^[\d\s.%px]+$/.test(value.radius) ? value.radius : '0px' }
                    : null);
            } else if (data.sorenWidget === 'open') {
                if (Date.now() - lastTapAt.current > 1500) return;
                lastTapAt.current = 0;
                const target = typeof data.target === 'string' ? data.target.trim().slice(0, 60) : '';
                if (target) onOpenRef.current?.(target);
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, []);

    const handleTap = (event: React.MouseEvent<HTMLDivElement>) => {
        const frame = frameRef.current;
        if (!frame?.contentWindow) return;
        const rect = frame.getBoundingClientRect();
        lastTapAt.current = Date.now();
        frame.contentWindow.postMessage({ sorenWidget: 'tap', x: event.clientX - rect.left, y: event.clientY - rect.top }, '*');
    };

    return (
        <div
            className="relative h-full w-full overflow-hidden"
            style={backdrop ? { backdropFilter: backdrop.filter, WebkitBackdropFilter: backdrop.filter, borderRadius: backdrop.radius } : undefined}
        >
            {srcDoc && (
                <iframe
                    ref={frameRef}
                    title={template.name}
                    className="absolute inset-0 block h-full w-full border-0"
                    style={{ pointerEvents: 'none', background: 'transparent', colorScheme: 'normal' }}
                    sandbox="allow-scripts"
                    referrerPolicy="no-referrer"
                    srcDoc={srcDoc}
                    tabIndex={-1}
                />
            )}
            {interactive && <div className="absolute inset-0" onClick={handleTap} />}
        </div>
    );
};

export default React.memo(CustomWidgetFrame);
