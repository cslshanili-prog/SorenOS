/**
 * 程序化 roll 一個 NPC 立繪 —— 複用捏臉器（character_creator.html）的隨機+導出能力。
 *
 * 做法：掛一個屏幕外的隱藏 iframe 載入捏臉器，等它 `like520_ready` 後發 `like520_init`
 * + `like520_roll`（headless 消息，見 html 裡 rollAndExport），它會隨機一套並用
 * html2canvas 導出透明立繪，回傳 `like520_result`。超時/出錯返回 null，調用方降級用
 * emoji 頭像。彼方·劇院給缺演員的劇本角色補 NPC 用。
 */

const CHAR_CREATOR_URL = (((import.meta as any).env?.BASE_URL ?? '/') + 'like520/character_creator.html').replace(/\/+/g, '/');

export interface RolledNpc { img: string; state: any; }

export function rollNpcChibi(timeoutMs = 18000): Promise<RolledNpc | null> {
    return new Promise((resolve) => {
        if (typeof document === 'undefined' || typeof window === 'undefined') { resolve(null); return; }
        let done = false;
        const iframe = document.createElement('iframe');
        // 屏幕外但保持可見（html2canvas 不渲染 visibility:hidden 的內容），給足佈局尺寸
        iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:1200px;border:0;opacity:1;pointer-events:none;z-index:-1;';
        iframe.setAttribute('aria-hidden', 'true');

        const cleanup = () => {
            window.removeEventListener('message', onMsg);
            try { iframe.remove(); } catch { /* ignore */ }
        };
        const finish = (v: RolledNpc | null) => { if (done) return; done = true; cleanup(); resolve(v); };

        const onMsg = (e: MessageEvent) => {
            if (e.source !== iframe.contentWindow || !e.data || typeof e.data !== 'object') return;
            if (e.data.type === 'like520_ready') {
                iframe.contentWindow?.postMessage({ type: 'like520_init', payload: { mode: 'char', charName: 'NPC', isSully: false } }, '*');
                setTimeout(() => iframe.contentWindow?.postMessage({ type: 'like520_roll' }, '*'), 150);
            } else if (e.data.type === 'like520_result' && e.data.payload) {
                const img = e.data.payload.transparentDataUrl || e.data.payload.dataUrl;
                finish(img ? { img, state: e.data.payload.state } : null);
            } else if (e.data.type === 'like520_roll_error') {
                finish(null);
            }
        };

        window.addEventListener('message', onMsg);
        iframe.src = CHAR_CREATOR_URL;
        document.body.appendChild(iframe);
        setTimeout(() => finish(null), timeoutMs);
    });
}

/** 給 NPC 隨機起個名字（劇本缺角時用）。 */
const NPC_NAMES = ['路人甲', '路人乙', '路人丙', '阿島', '小汀', '客串者', '無名氏', '替補演員', '幕後人', '群演 A', '群演 B'];
export function randomNpcName(used: string[]): string {
    const pool = NPC_NAMES.filter(n => !used.includes(n));
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];
    return `NPC-${Math.random().toString(36).slice(2, 5)}`;
}
