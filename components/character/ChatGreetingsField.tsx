import React from 'react';
import type { CharacterProfile } from '../../types';
import ExpandableTextarea from '../common/ExpandableTextarea';

type Greeting = NonNullable<CharacterProfile['chatGreetings']>[number];

/**
 * 神經鏈接 · 角色編輯頁的「開場白」（私聊；utils/chatGreeting.ts）。
 * 編輯中允許空白的（剛按「新增」還沒填），送的時候只挑有字的；存在 formData，跟其它欄位一起按保存。
 */
const ChatGreetingsField: React.FC<{
    greetings: Greeting[] | undefined;
    onChange: (next: Greeting[] | undefined) => void;
}> = ({ greetings, onChange }) => {
    const list = greetings || [];
    const set = (next: Greeting[]) => onChange(next.length ? next : undefined);
    const add = () => set([...list, { id: `cg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text: '' }]);

    return (
        <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">開場白 (Greeting)</label>
            <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
                私聊還沒有任何訊息時，一打開聊天 TA 就先傳這段過來（寫好幾段就隨機挑一段，不呼叫 AI）。可以用 {'{{char}}'}、{'{{user}}'}，會換成 TA 的名字和你在這條線上的名字。見面的開場白在見面的劇情設定裡另外寫。
            </p>
            <div className="space-y-3">
                {list.map((g, i) => (
                    <div key={g.id}>
                        {list.length > 1 && (
                            <div className="mb-1 flex items-center justify-between px-2">
                                <span className="text-[11px] font-bold text-slate-500">開場白 {i + 1}</span>
                                <button type="button" onClick={() => set(list.filter(x => x.id !== g.id))} aria-label={`刪除開場白 ${i + 1}`} className="text-[11px] text-slate-300 hover:text-red-400">刪除</button>
                            </div>
                        )}
                        <ExpandableTextarea
                            title={`開場白${list.length > 1 ? ` ${i + 1}` : ''}`}
                            value={g.text}
                            onChange={v => set(list.map(x => (x.id === g.id ? { ...x, text: v } : x)))}
                            className="w-full h-28 bg-white rounded-3xl p-5 text-sm shadow-sm resize-none focus:ring-1 focus:ring-primary/20 transition-all vr-reader-scroll"
                            placeholder={'{{user}}，你終於來了。\n……我是{{char}}，以後請多指教。'}
                        />
                        {list.length === 1 && (
                            <div className="mt-1 flex justify-end px-2">
                                <button type="button" onClick={() => set([])} className="text-[11px] text-slate-300 hover:text-red-400">清除</button>
                            </div>
                        )}
                    </div>
                ))}
            </div>
            <button type="button" onClick={add} className="mt-2 w-full rounded-2xl border border-dashed border-primary/40 py-2.5 text-[12px] font-bold text-primary active:scale-95">
                + {list.length ? '再加一段（隨機挑）' : '新增開場白'}
            </button>
        </div>
    );
};

export default ChatGreetingsField;
