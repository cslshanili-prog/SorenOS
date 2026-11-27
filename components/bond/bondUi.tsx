/**
 * 羈絆 App 的共用外觀（plans/bond-batch1.md 3.6、plans/bond-look.md）：紙色底、圓角色塊分區、襯線字，
 * 灰粉／低彩度酒紅點綴；淺色、深色兩套變數，深色掛在外層的 data-bond-theme="dark"。只套在 .bond-root 底下。
 */
import React from 'react';
import { BookmarkSimple, CaretLeft, ClockCounterClockwise, Gift, Layout, LinkSimple, NotePencil, type Icon } from '@phosphor-icons/react';
import TokenImg from '../os/TokenImg';
import { GIFTBOX_CSS } from './treasure/GiftBox';
import { ENVELOPE_CSS } from './treasure/Envelope';
import { CAPSULE_CSS } from './treasure/CapsuleBand';

export const BOND_CSS = `
.bond-root {
  --bond-paper: #f8f5f1;
  --bond-paper-2: #efe8e2;
  --bond-card: #fffdfa;
  --bond-ink: #352e30;
  --bond-ink-2: #62575b;
  --bond-muted: #9b9094;
  --bond-line: #e8dfd8;
  --bond-accent: #7d4c63;
  --bond-accent-soft: #f0e4ea;
  --bond-rose: #c49cad;
  --bond-on-accent: #fdf9f6;
  --bond-block-sand: #f0e8e0;
  --bond-block-blush: #f2e5eb;
  --bond-block-mist: #ece9f1;
  --bond-track: #e3d8dd;
  --bond-bar: #fffdfa;
  --bond-shadow: 0 1px 2px rgba(70, 45, 55, .04), 0 10px 24px -18px rgba(70, 45, 55, .2);
  color-scheme: light;
  background: var(--bond-paper);
  color: var(--bond-ink);
}
[data-bond-theme="dark"] .bond-root, .bond-root[data-bond-theme="dark"] {
  --bond-paper: #1c1b1e;
  --bond-paper-2: #2b292d;
  --bond-card: #262428;
  --bond-ink: #f0eaed;
  --bond-ink-2: #c4bac0;
  --bond-muted: #8e858b;
  --bond-line: #38343a;
  --bond-accent: #dcafc8;
  --bond-accent-soft: #3a2f38;
  --bond-rose: #a98196;
  --bond-on-accent: #2a1e25;
  --bond-block-sand: #2a282c;
  --bond-block-blush: #3a2f39;
  --bond-block-mist: #2c2a33;
  --bond-track: #48404a;
  --bond-bar: #232125;
  --bond-shadow: none;
  color-scheme: dark;
}
.bond-serif { font-family: 'Noto Serif TC', 'Songti TC', 'Shippori Mincho', 'PMingLiU', serif; }
.bond-hair { border-color: var(--bond-line); }
.bond-note { font-size: 10.5px; letter-spacing: 0.18em; color: var(--bond-muted); }
.bond-eyebrow { font-size: 11px; letter-spacing: 0.3em; color: var(--bond-ink-2); }
.bond-panel { border-radius: 20px; background: var(--bond-card); box-shadow: var(--bond-shadow); }
.bond-block { border-radius: 22px; }
.bond-input {
  width: 100%; background: var(--bond-card); border: 1px solid var(--bond-line); border-radius: 10px;
  padding: 9px 12px; font-size: 14px; color: var(--bond-ink); outline: none;
}
.bond-input:focus { border-color: var(--bond-rose); }
.bond-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border-radius: 10px; padding: 8px 14px; font-size: 13px; font-weight: 600;
  border: 1px solid var(--bond-line); background: var(--bond-card); color: var(--bond-ink-2);
}
.bond-btn:active { transform: scale(0.97); }
.bond-btn[disabled] { opacity: 0.45; }
.bond-btn-primary { background: var(--bond-accent); border-color: var(--bond-accent); color: var(--bond-on-accent); }
.bond-chip {
  display: inline-flex; align-items: center; border: 1px solid var(--bond-line); border-radius: 999px;
  padding: 3px 11px; font-size: 12px; color: var(--bond-ink-2); background: var(--bond-card);
}
.bond-chip[aria-pressed="true"] { border-color: var(--bond-accent); color: var(--bond-accent); background: var(--bond-accent-soft); }
.bond-tabbar { background: var(--bond-bar); border-top: 1px solid var(--bond-line); }
`;

export const BondStyle: React.FC = () => <style>{BOND_CSS + GIFTBOX_CSS + ENVELOPE_CSS + CAPSULE_CSS}</style>;

/**
 * 空間的首頁與各分頁（plans/bond-open-spaces.md、plans/bond-look.md）：頂欄換成大標題「你與 TA」＋右上「切換」。
 * BondApp 只在空間那幾個根頁給值，子頁（讀一封信、改一個約定…）拿不到，照舊是返回＋標題的細頂欄。
 */
export interface BondRootNav { title: string; onSwitch: () => void }
export const BondSwitchContext = React.createContext<BondRootNav | undefined>(undefined);

/** 全螢幕頁的頂欄：返回、標題（襯線）、右邊放一顆動作；在空間的根頁換成大標題那款 */
export const BondHeader: React.FC<{ title: string; onBack: () => void; right?: React.ReactNode; backLabel?: string }> = ({ title, onBack, right, backLabel = '返回' }) => {
    const root = React.useContext(BondSwitchContext);
    if (root) {
        return (
            <div className="shrink-0 px-5 pb-3" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 6px)' }}>
                <div className="flex items-center gap-1">
                    <button type="button" onClick={onBack} aria-label="關閉" className="-ml-2 h-8 w-8 grid place-items-center rounded-full text-[var(--bond-ink-2)] active:bg-[var(--bond-paper-2)]">
                        <CaretLeft size={16} />
                    </button>
                    <span className="bond-eyebrow">SOREN · 羈絆</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                    <h1 className="bond-serif flex-1 min-w-0 truncate text-[26px] leading-tight font-semibold tracking-wide">{root.title}</h1>
                    {right}
                    <button type="button" onClick={root.onSwitch} aria-label="切換空間"
                        className="shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[14px] text-[var(--bond-ink)] active:bg-[var(--bond-paper-2)]">
                        <Layout size={19} />切換
                    </button>
                </div>
            </div>
        );
    }
    return (
        <div className="shrink-0 flex items-center gap-2 px-3 pb-2 border-b bond-hair" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 8px)' }}>
            <button type="button" onClick={onBack} aria-label={backLabel} className="h-9 w-9 grid place-items-center rounded-full text-[var(--bond-ink-2)] active:bg-[var(--bond-paper-2)]">
                <CaretLeft size={18} />
            </button>
            <h1 className="bond-serif flex-1 min-w-0 truncate text-[17px] tracking-wide">{title}</h1>
            {right}
        </div>
    );
};

/** 一個頭像；沒設頭像時用名字的第一個字（不顯示破圖） */
export const BondAvatar: React.FC<{ value?: string; name?: string; size: number; className?: string; style?: React.CSSProperties }> = ({ value, name, size, className = '', style }) => {
    const base = `rounded-full bg-[var(--bond-paper-2)] ${className}`;
    if (!value) {
        return (
            <div className={`${base} grid place-items-center bond-serif text-[var(--bond-ink-2)]`} style={{ width: size, height: size, fontSize: Math.round(size * 0.4), ...style }} aria-hidden>
                {(name || '').trim().slice(0, 1)}
            </div>
        );
    }
    return <TokenImg value={value} alt="" className={`${base} object-cover`} style={{ width: size, height: size, ...style }} />;
};

/** 兩個頭像疊在一起（我們） */
export const AvatarPair: React.FC<{ a?: string; b?: string; aName?: string; bName?: string; size?: number }> = ({ a, b, aName, bName, size = 40 }) => (
    <div className="relative shrink-0" style={{ width: size * 1.6, height: size }}>
        <BondAvatar value={a} name={aName} size={size} className="absolute left-0 top-0 border-2 border-[var(--bond-paper)]" />
        <BondAvatar value={b} name={bName} size={size} className="absolute top-0 border-2 border-[var(--bond-paper)]" style={{ left: size * 0.6 }} />
    </div>
);

/** 區塊標題：細字、拉開字距，像書頁上的小標 */
export const SectionLabel: React.FC<{ children: React.ReactNode; right?: React.ReactNode }> = ({ children, right }) => (
    <div className="flex items-baseline justify-between mb-2">
        <div className="bond-note">{children}</div>
        {right}
    </div>
);

/** 羈絆空間的五個分頁，放在最底下（plans/bond-look.md）；選中的那格墊一塊淡色 */
export type BondTab = 'us' | 'moments' | 'heart' | 'pact' | 'treasure';
export const BOND_TABS: Array<{ id: BondTab; label: string; icon: Icon }> = [
    { id: 'us', label: '我們', icon: LinkSimple },
    { id: 'moments', label: '拾光', icon: ClockCounterClockwise },
    { id: 'heart', label: '心意', icon: NotePencil },
    { id: 'pact', label: '約定', icon: BookmarkSimple },
    { id: 'treasure', label: '珍藏', icon: Gift },
];
/** 分頁：身份卡 × 角色和角色 × 角色一樣五個（角色之間的「我們」叫「他們」，plans/bond-batch6.md 第 3 節） */
export const bondTabsFor = (_kind: 'persona' | 'pair'): BondTab[] => ['us', 'moments', 'heart', 'pact', 'treasure'];
/**
 * 各分頁把它放在頂欄後面，靠 order-last 排到整頁最底下（頁面都是 flex-col），不用每頁搬位置。
 */
export const BondTabs: React.FC<{ value: BondTab; onChange: (t: BondTab) => void; tabs?: BondTab[]; dots?: Partial<Record<BondTab, boolean>>; labels?: Partial<Record<BondTab, string>> }> = ({ value, onChange, tabs, dots, labels }) => (
    <nav className="bond-tabbar order-last shrink-0 px-3 pt-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 8px)' }} role="tablist" aria-label="羈絆分頁">
        <div className="grid grid-cols-5 gap-1.5">
            {BOND_TABS.filter(t => !tabs || tabs.includes(t.id)).map(t => {
                const on = value === t.id;
                const Ico = t.icon;
                return (
                    <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => onChange(t.id)}
                        className={`relative flex flex-col items-center gap-1 rounded-2xl py-2 transition-colors ${on ? 'bg-[var(--bond-accent-soft)] text-[var(--bond-accent)]' : 'text-[var(--bond-ink-2)] active:bg-[var(--bond-paper-2)]'}`}>
                        <Ico size={22} weight={on ? 'regular' : 'light'} />
                        <span className="text-[12.5px] tracking-[0.12em]">{labels?.[t.id] || t.label}</span>
                        {dots?.[t.id] && <span className="absolute top-1.5 right-[calc(50%-17px)] h-2 w-2 rounded-full bg-[var(--bond-accent)] ring-2 ring-[var(--bond-bar)]" aria-label="有新的" />}
                    </button>
                );
            })}
        </div>
    </nav>
);
