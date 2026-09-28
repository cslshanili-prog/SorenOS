
import React, { useRef, useState } from 'react';
import Modal from '../os/Modal';
import { referenceCropHints, REFERENCE_OUTPUT_SIZE } from '../../utils/imageGeneration';

export interface FaceBox {
    x: number;
    y: number;
    size: number;
}

interface FaceCropModalProps {
    isOpen: boolean;
    imageUrl: string;
    initialBox?: FaceBox;
    onCancel: () => void;
    onSave: (box: FaceBox) => void;
}

const DEFAULT_BOX: FaceBox = { x: 0.25, y: 0.25, size: 0.5 };
const MIN_SIZE = 0.2;
const MAX_SIZE = 0.9;

const clampBox = (box: FaceBox): FaceBox => {
    const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, box.size));
    const maxPos = 1 - size;
    return {
        size,
        x: Math.min(maxPos, Math.max(0, box.x)),
        y: Math.min(maxPos, Math.max(0, box.y)),
    };
};

/** 在正方形預覽框裡拖一個方框鎖定臉部區域；預覽圖用 object-fit: cover 裁成正方形，避免非方形照片的寬高換算。 */
const FaceCropModal: React.FC<FaceCropModalProps> = ({ isOpen, imageUrl, initialBox, onCancel, onSave }) => {
    const [box, setBox] = useState<FaceBox>(() => clampBox(initialBox || DEFAULT_BOX));
    const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startX: number; startY: number; boxX: number; boxY: number } | null>(null);

    if (!isOpen) return null;

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { startX: e.clientX, startY: e.clientY, boxX: box.x, boxY: box.y };
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!drag || !rect) return;
        const dx = (e.clientX - drag.startX) / rect.width;
        const dy = (e.clientY - drag.startY) / rect.height;
        setBox(prev => clampBox({ ...prev, x: drag.boxX + dx, y: drag.boxY + dy }));
    };

    const handlePointerUp = () => { dragRef.current = null; };
    const hints = natural ? referenceCropHints(natural.w, natural.h, box) : null;

    return (
        <Modal
            isOpen={isOpen}
            title="選取臉部鎖定區域"
            onClose={onCancel}
            footer={
                <>
                    <button onClick={onCancel} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">
                        取消
                    </button>
                    <button onClick={() => onSave(box)} className="flex-1 py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform">
                        保存選區
                    </button>
                </>
            }
        >
            <p className="text-xs text-slate-500 leading-relaxed mb-3">
                拖動方框覆蓋角色臉部；發送參考圖時只會截取這個區域，減少服裝和背景幹擾。
            </p>

            {hints && (hints.faceTooSmall || hints.tooWide) && (
                <div role="status" className="mb-3 space-y-1 rounded-2xl bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
                    {hints.faceTooSmall && <p>臉太小：放大後五官會糊，建議換一張臉更大、更清楚的近照（胸像以上最好）。</p>}
                    {hints.tooWide && <p>圖太寬（像三視圖）：會先居中裁成正方形，左右兩側被切掉。衣服、髮型改寫進「專屬人物特徵提示詞」。</p>}
                </div>
            )}

            <div
                ref={containerRef}
                className="relative w-full rounded-2xl overflow-hidden bg-slate-100 select-none touch-none"
                style={{ aspectRatio: '1 / 1' }}
            >
                <img
                    src={imageUrl}
                    alt="參考圖"
                    onLoad={e => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                    className="absolute inset-0 w-full h-full object-cover pointer-events-none"
                />
                <div
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    className="absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] rounded-lg cursor-move flex items-center justify-center"
                    style={{
                        left: `${box.x * 100}%`,
                        top: `${box.y * 100}%`,
                        width: `${box.size * 100}%`,
                        height: `${box.size * 100}%`,
                    }}
                >
                    <span className="text-[10px] text-white/90 bg-black/30 px-2 py-0.5 rounded-full pointer-events-none">拖到臉部</span>
                </div>
            </div>

            <div className="mt-4">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">選區大小</label>
                <input
                    type="range"
                    min={MIN_SIZE}
                    max={MAX_SIZE}
                    step={0.01}
                    value={box.size}
                    onChange={e => setBox(prev => clampBox({ ...prev, size: parseFloat(e.target.value) }))}
                    className="w-full accent-slate-700"
                />
                {hints && (
                    <p className={`mt-1 text-[11px] ${hints.faceTooSmall ? 'text-amber-600' : 'text-slate-400'}`}>
                        選區在原圖上約 {hints.facePx}×{hints.facePx} 像素，送出去會縮放成 {REFERENCE_OUTPUT_SIZE}×{REFERENCE_OUTPUT_SIZE}
                    </p>
                )}
            </div>
        </Modal>
    );
};

export default FaceCropModal;
