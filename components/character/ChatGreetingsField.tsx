import React from 'react';
import type { CharacterGreeting } from '../../types';
import ExpandableTextarea from '../common/ExpandableTextarea';
import { makeGreetingId } from '../../utils/greetings';

/**
 * 神經鏈接 · 角色編輯頁的「開場白」清單（utils/greetings.ts）：每段勾私聊／見面，可以都勾。
 * 私聊：一條線還沒有私聊訊息時角色先傳一段（utils/chatGreeting.ts）；見面：感知頁「用開場白」，見面劇情設定看到的是勾了見面的那幾段。
 * 編輯中允許空白的（剛按「新增」還沒填），用的時候只挑有字的；存在 formData，跟其它欄位一起自動存。
 */
const ChatGreetingsField: React.FC<{
    greetings: CharacterGreeting[];
    onChange: (next: CharacterGreeting[]) => void;
}> = ({ greetings: list, onChange }) => {
    const patch = (id: string, p: Partial<CharacterGreeting>) => onChange(list.map(x => (x.id === id ? { ...x, ...p } : x)));
    const add = () => onChange([...list, { id: makeGreetingId(), text: '', chat: true }]);
    const tick = (on: boolean) => `rounded-full px-3 py-1 text-[11px] font-bold transition ${on ? 'bg-primary text-white' : 'bg-slate-100 text-slate-400'}`;

    return (
        <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">開場白 (Greetings)</label>
            <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
                每段勾要給哪裡用，可以都勾。<b className="font-bold text-slate-500">私聊</b>：還沒有任何私聊訊息時，一打開聊天 TA 就先傳一段（不呼叫 AI）；<b className="font-bold text-slate-500">見面</b>：感知頁選「用開場白」時從這裡挑。好幾段就隨機挑。可以用 {'{{char}}'}、{'{{user}}'}，會換成 TA 的名字和你在這條線上的名字。
            </p>
            <div className="space-y-3">
                {list.map((g, i) => (
                    <div key={g.id} className="rounded-3xl bg-white p-3 shadow-sm">
                        <ExpandableTextarea
                            title={`開場白 ${i + 1}`}
                            value={g.text}
                            onChange={v => patch(g.id, { text: v })}
                            className="w-full h-28 bg-slate-50 rounded-2xl p-4 text-sm resize-none focus:ring-1 focus:ring-primary/20 transition-all vr-reader-scroll"
                            placeholder={'{{user}}，你終於來了。\n……我是{{char}}，以後請多指教。'}
                        />
                        <div className="mt-2 flex items-center gap-2 px-1">
                            <span className="text-[11px] text-slate-400">用在</span>
                            <button type="button" aria-pressed={!!g.chat} onClick={() => patch(g.id, { chat: !g.chat || undefined })} className={tick(!!g.chat)}>私聊</button>
                            <button type="button" aria-pressed={!!g.date} onClick={() => patch(g.id, { date: !g.date || undefined })} className={tick(!!g.date)}>見面</button>
                            {!g.chat && !g.date && <span className="text-[10px] text-amber-500">都沒勾就不會用到</span>}
                            <button type="button" onClick={() => onChange(list.filter(x => x.id !== g.id))} aria-label={`刪除開場白 ${i + 1}`} className="ml-auto text-[11px] text-slate-300 hover:text-red-400">刪除</button>
                        </div>
                    </div>
                ))}
            </div>
            <button type="button" onClick={add} className="mt-2 w-full rounded-2xl border border-dashed border-primary/40 py-2.5 text-[12px] font-bold text-primary active:scale-95">
                + 新增開場白
            </button>
        </div>
    );
};

export default ChatGreetingsField;
