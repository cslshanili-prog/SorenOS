import React from 'react';

/**
 * 設置頁卡片裡的分頁：同類設定收進一張卡，用分頁切換，免得設置頁攤得太長（照上游 8eef4b293 的做法）。
 * 分頁多的時候可以左右滑；左右方向鍵、Home／End 可以切換。
 */
export interface SettingsTab<T extends string> {
    id: T;
    label: string;
    /** 標籤後面的小圓點：這一頁有東西開著／接好了 */
    dot?: boolean;
}

export default function SettingsTabs<T extends string>({ prefix, label, tabs, selected, onSelect, children }: {
    prefix: string;
    label: string;
    tabs: SettingsTab<T>[];
    selected: T;
    onSelect: (id: T) => void;
    children: React.ReactNode;
}) {
    return (
        <>
            <div role="tablist" aria-label={label} className="mb-4 -mx-1 px-1 flex gap-5 overflow-x-auto no-scrollbar border-b border-slate-200/80">
                {tabs.map((tab, index) => {
                    const on = tab.id === selected;
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            id={`${prefix}-tab-${tab.id}`}
                            aria-controls={`${prefix}-panel-${tab.id}`}
                            aria-selected={on}
                            tabIndex={on ? 0 : -1}
                            onClick={() => onSelect(tab.id)}
                            onKeyDown={event => {
                                let next: number;
                                if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
                                else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
                                else if (event.key === 'Home') next = 0;
                                else if (event.key === 'End') next = tabs.length - 1;
                                else return;
                                event.preventDefault();
                                onSelect(tabs[next].id);
                                const button = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
                                button?.focus({ preventScroll: true });
                            }}
                            className={`relative shrink-0 pb-2.5 pt-1 text-[13px] whitespace-nowrap transition-colors ${on ? 'font-bold text-violet-700' : 'text-slate-400'}`}
                        >
                            {tab.label}
                            {tab.dot && <span aria-hidden="true" className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 align-middle" />}
                            {on && <span aria-hidden="true" className="absolute left-0 right-0 -bottom-px h-[3px] rounded-full bg-violet-500" />}
                        </button>
                    );
                })}
            </div>
            <div role="tabpanel" id={`${prefix}-panel-${selected}`} aria-labelledby={`${prefix}-tab-${selected}`}>{children}</div>
        </>
    );
}
