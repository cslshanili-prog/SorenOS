import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Trash } from '@phosphor-icons/react';
import Modal from '../os/Modal';
import type { MallCategory, MallKind } from '../../types';
import { inputCls } from './MallParts';

interface Props {
    open: boolean;
    kind: MallKind;
    categories: MallCategory[];
    productCount: (categoryId: string) => number;
    onClose: () => void;
    onRename: (cat: MallCategory, name: string) => void;
    onMove: (cat: MallCategory, dir: -1 | 1) => void;
    onDelete: (cat: MallCategory) => void;
    onCreate: (name: string) => void;
}

/** 管理分類：改名（失焦存）、上下移、刪除（裡面有商品要再按一次確認，連商品一起刪）、新增。 */
const MallCategoryManager: React.FC<Props> = ({ open, kind, categories, productCount, onClose, onRename, onMove, onDelete, onCreate }) => {
    const [newName, setNewName] = useState('');
    const [confirmId, setConfirmId] = useState<string | null>(null);

    return (
        <Modal isOpen={open} title={`管理${kind === 'food' ? '外賣' : '購物'}分類`} onClose={() => { setConfirmId(null); onClose(); }}>
            <div className="space-y-2">
                {categories.length === 0 && <div className="text-center text-xs text-slate-400 py-3">還沒有分類</div>}
                {categories.map((c, i) => {
                    const count = productCount(c.id);
                    const confirming = confirmId === c.id;
                    return (
                        <div key={c.id} className="rounded-xl bg-slate-50 px-2 py-1.5">
                            <div className="flex items-center gap-1.5">
                                <input defaultValue={c.name} key={c.name}
                                    onBlur={e => { const v = e.target.value.trim(); if (v && v !== c.name) onRename(c, v); else e.target.value = c.name; }}
                                    className="flex-1 min-w-0 bg-transparent px-1.5 py-1 text-sm text-slate-800 focus:outline-none focus:bg-white rounded-lg" />
                                <span className="text-[10px] text-slate-400 tabular-nums w-6 text-right">{count}</span>
                                <button disabled={i === 0} onClick={() => onMove(c, -1)} className="w-7 h-7 flex items-center justify-center text-slate-400 disabled:opacity-25" aria-label="上移"><ArrowUp size={14} /></button>
                                <button disabled={i === categories.length - 1} onClick={() => onMove(c, 1)} className="w-7 h-7 flex items-center justify-center text-slate-400 disabled:opacity-25" aria-label="下移"><ArrowDown size={14} /></button>
                                <button onClick={() => { if (count > 0 && !confirming) setConfirmId(c.id); else { setConfirmId(null); onDelete(c); } }}
                                    className={`w-7 h-7 flex items-center justify-center ${confirming ? 'text-white bg-rose-500 rounded-lg' : 'text-rose-400'}`} aria-label="刪除分類">
                                    <Trash size={14} />
                                </button>
                            </div>
                            {confirming && <div className="text-[11px] text-rose-500 px-1.5 pb-1">裡面的 {count} 件商品會一起刪掉，再按一次垃圾桶確認</div>}
                        </div>
                    );
                })}
                <div className="flex gap-2 pt-2">
                    <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="新分類名稱" className={inputCls}
                        onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) { onCreate(newName); setNewName(''); } }} />
                    <button disabled={!newName.trim()} onClick={() => { onCreate(newName); setNewName(''); }}
                        className="shrink-0 px-4 rounded-xl bg-slate-900 text-white text-sm font-bold disabled:opacity-40">新增</button>
                </div>
            </div>
        </Modal>
    );
};

export default MallCategoryManager;
