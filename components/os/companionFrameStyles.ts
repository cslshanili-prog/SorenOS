export type CompanionFrameStyleId = 'tech' | 'otome' | 'cat' | 'magazine' | 'archive' | 'idol';

export type CompanionFrameStyleOption = {
  id: CompanionFrameStyleId;
  name: string;
  description: string;
  swatch: string;
};

export const COMPANION_FRAME_STYLE_KEY = 'companion_frame_style_v1';
export const COMPANION_FRAME_STYLE_EVENT = 'sullyos:companion-frame-style';

export const COMPANION_FRAME_STYLES: CompanionFrameStyleOption[] = [
  {
    id: 'tech',
    name: '星軌終端',
    description: '切角細線 · 菱形控制 · 低負擔渲染',
    swatch: 'linear-gradient(145deg,#111827 0%,#1f2940 55%,#8fa9d7 100%)',
  },
  {
    id: 'otome',
    name: '晴庭手帳',
    description: '淺色溫室 · 側邊書籤 · 四欄書脊',
    swatch: 'linear-gradient(145deg,#fffaf0 0%,#cddfd4 58%,#b95e78 100%)',
  },
  {
    id: 'cat',
    name: '夜巡小貓',
    description: '黑紫夜庭 · 貓耳頁籤 · 爪印中樞',
    swatch: 'radial-gradient(circle at 68% 28%,#b9f36a 0 5%,transparent 6%), linear-gradient(145deg,#08070d 0%,#24113d 58%,#7137a6 100%)',
  },
  {
    id: 'magazine',
    name: '夜刊封面',
    description: '通欄標題 · 直角網格 · 編輯標記',
    swatch: 'linear-gradient(145deg,#f1ede5 0%,#d9d3ca 62%,#e95b52 62%,#e95b52 100%)',
  },
  {
    id: 'archive',
    name: '星願卡冊',
    description: '奶油粉藍 · 封印線章 · 寶石卡籤',
    swatch: 'radial-gradient(circle at 48% 38%,#fffaf2 0 22%,transparent 23%),linear-gradient(145deg,#f8e8ef 0%,#fff9ed 58%,#83baca 100%)',
  },
  {
    id: 'idol',
    name: '偶像直播',
    description: '清透圓框 · 珊瑚強調 · 輕盈標籤',
    swatch: 'linear-gradient(145deg,#18233d 0%,#445c9b 56%,#ff8fa7 100%)',
  },
];

const isCompanionFrameStyle = (value: string | null): value is CompanionFrameStyleId =>
  COMPANION_FRAME_STYLES.some(style => style.id === value);

export const loadCompanionFrameStyle = (): CompanionFrameStyleId => {
  if (typeof window === 'undefined') return 'tech';
  try {
    const stored = window.localStorage.getItem(COMPANION_FRAME_STYLE_KEY);
    return isCompanionFrameStyle(stored) ? stored : 'tech';
  } catch {
    return 'tech';
  }
};

export const saveCompanionFrameStyle = (style: CompanionFrameStyleId): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COMPANION_FRAME_STYLE_KEY, style);
  } catch {
    // Storage can be unavailable in private WebViews; the live preview still works.
  }
  window.dispatchEvent(new CustomEvent<CompanionFrameStyleId>(COMPANION_FRAME_STYLE_EVENT, { detail: style }));
};
