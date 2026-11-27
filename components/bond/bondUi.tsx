/**
 * 羈絆 App 的共用外觀（plans/bond-batch1.md 3.6）：米白紙色、暖灰字、細線、扁平色塊、襯線字，
 * 灰粉／低彩度酒紅少量點綴。只套在 .bond-root 底下。
 */
import React from 'react';
import { CaretDown, CaretLeft } from '@phosphor-icons/react';
import TokenImg from '../os/TokenImg';
import { GIFTBOX_CSS } from './treasure/GiftBox';
import { ENVELOPE_CSS } from './treasure/Envelope';
import { CAPSULE_CSS } from './treasure/CapsuleBand';

export const BOND_CSS = `
.bond-root {
  --bond-paper: #f6f1e9;
  --bond-paper-2: #efe7dc;
  --bond-card: #fbf8f3;
  --bond-ink: #463f3a;
  --bond-ink-2: #6b5f57;
  --bond-muted: #a1958c;
  --bond-line: #e3d9cc;
  --bond-accent: #8c4a52;
  --bond-accent-soft: #ecdcd8;
  --bond-rose: #c9a5a2;
  background: var(--bond-paper);
  color: var(--bond-ink);
}
.bond-serif { font-family: 'Noto Serif TC', 'Songti TC', 'Shippori Mincho', 'PMingLiU', serif; }
.bond-hair { border-color: var(--bond-line); }
.bond-note { font-size: 10.5px; letter-spacing: 0.18em; color: var(--bond-muted); }
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
.bond-btn-primary { background: var(--bond-accent); border-color: var(--bond-accent); color: #fbf7f0; }
.bond-chip {
  display: inline-flex; align-items: center; border: 1px solid var(--bond-line); border-radius: 999px;
  padding: 3px 11px; font-size: 12px; color: var(--bond-ink-2); background: var(--bond-card);
}
.bond-chip[aria-pressed="true"] { border-color: var(--bond-accent); color: var(--bond-accent); background: var(--bond-accent-soft); }
`;

export const BondStyle: React.FC = () => <style>{BOND_CSS + GIFTBOX_CSS + ENVELOPE_CSS + CAPSULE_CSS}</style>;

/** 全螢幕頁的頂欄：返回、標題（襯線）、右邊放一顆動作 */
/**
 * 空間的首頁與各分頁：點頂端的名字開切換頁（plans/bond-open-spaces.md）。BondApp 只在空間那幾個根頁給值，
 * 子頁（讀一封信、改一個約定…）拿不到，標題照舊是字。
 */
export const BondSwitchContext = React.createContext<(() => void) | undefined>(undefined);

export const BondHeader: React.FC<{ title: string; onBack: () => void; right?: React.ReactNode; backLabel?: string }> = ({ title, onBack, right, backLabel = '返回' }) => {
    const onSwitch = React.useContext(BondSwitchContext);
    return (
        <div className="shrink-0 flex items-center gap-2 px-3 pb-2 border-b bond-hair" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 8px)' }}>
            <button type="button" onClick={onBack} aria-label={onSwitch ? '關閉' : backLabel} className="h-9 w-9 grid place-items-center rounded-full text-[var(--bond-ink-2)] active:bg-[var(--bond-paper-2)]">
                <CaretLeft size={18} />
            </button>
            {onSwitch ? (
                <button type="button" onClick={onSwitch} aria-label="切換空間" className="flex-1 min-w-0 flex items-center gap-1 text-left">
                    <h1 className="bond-serif min-w-0 truncate text-[17px] tracking-wide">{title}</h1>
                    <CaretDown size={13} className="shrink-0 text-[var(--bond-muted)]" />
                </button>
            ) : (
                <h1 className="bond-serif flex-1 min-w-0 truncate text-[17px] tracking-wide">{title}</h1>
            )}
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

/** 羈絆空間的分頁（我們／拾光／心意；之後的分頁做了才出現）。像書的章節標，細線底、選中的字變深 */
export type BondTab = 'us' | 'moments' | 'heart' | 'pact' | 'treasure';
export const BOND_TABS: Array<{ id: BondTab; label: string }> = [
    { id: 'us', label: '我們' },
    { id: 'moments', label: '拾光' },
    { id: 'heart', label: '心意' },
    { id: 'pact', label: '約定' },
    { id: 'treasure', label: '珍藏' },
];
/** 角色之間的空間沒有心意、約定、珍藏（第 6 批） */
/** 分頁：身份卡 × 角色和角色 × 角色一樣五個（角色之間的「我們」叫「他們」，plans/bond-batch6.md 第 3 節） */
export const bondTabsFor = (_kind: 'persona' | 'pair'): BondTab[] => ['us', 'moments', 'heart', 'pact', 'treasure'];
export const BondTabs: React.FC<{ value: BondTab; onChange: (t: BondTab) => void; tabs?: BondTab[]; dots?: Partial<Record<BondTab, boolean>>; labels?: Partial<Record<BondTab, string>> }> = ({ value, onChange, tabs, dots, labels }) => (
    <div className="shrink-0 flex gap-5 px-5 border-b bond-hair" role="tablist">
        {BOND_TABS.filter(t => !tabs || tabs.includes(t.id)).map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
                className={`bond-serif relative py-2.5 text-[14px] tracking-[0.2em] ${value === t.id ? 'text-[var(--bond-ink)]' : 'text-[var(--bond-muted)]'}`}>
                {labels?.[t.id] || t.label}
                {dots?.[t.id] && <span className="absolute -right-2 top-2 h-1.5 w-1.5 rounded-full bg-[var(--bond-accent)]" aria-label="有新的" />}
                {value === t.id && <span className="absolute left-0 right-0 -bottom-px h-[1.5px] bg-[var(--bond-accent)]" />}
            </button>
        ))}
    </div>
);
