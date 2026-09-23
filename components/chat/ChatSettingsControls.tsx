import React from 'react';

/** 全螢幕聊天設定頁共用的開關與列（ChatSettingsPage、ReadNoReplySettings）。 */
export const Toggle: React.FC<{ on: boolean; onToggle: () => void; label: string }> = ({ on, onToggle, label }) => (
    <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onToggle}
        className={`relative w-12 h-7 rounded-full shrink-0 transition-colors ${on ? 'bg-slate-800' : 'bg-slate-200'}`}
    >
        <span className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
    </button>
);

export const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
    <div className="flex items-center gap-3 px-5 py-4">
        <div className="min-w-0 flex-1">
            <div className="text-[15px] font-bold text-slate-800">{label}</div>
            {hint && <div className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{hint}</div>}
        </div>
        {children}
    </div>
);
