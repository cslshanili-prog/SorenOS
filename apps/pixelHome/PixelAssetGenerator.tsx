/**
 * Pixel Home — 像素資產生成器
 *
 * 兩種模式：
 *   1. 生成模式：上傳圖片 → 實時預覽像素化效果 → 調參數實時刷新 → 確定後存入倉庫
 *   2. 直接導入：上傳已有像素資產 → 跳過轉換直接存入倉庫
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { PixelAsset } from './types';
import { PixelAssetDB } from './pixelHomeDb';
import { pixelizeImage, removeBackground } from '../../utils/pixelizer';
import { extractPalette } from '../../utils/paletteExtractor';
import { processImage } from '../../utils/file';
import { trackEvent } from '../../utils/analytics';

interface Props {
  onGenerated: () => void;
}

type GeneratorMode = 'generate' | 'import';

interface PendingImage {
  id: string;
  name: string;
  originalDataUri: string;
  // 預處理緩存（背景去除後）
  processedData?: ImageData;
  processedWidth?: number;
  processedHeight?: number;
  // 實時預覽結果
  previewUri?: string;
  previewPalette?: string[];
  previewW?: number;
  previewH?: number;
}

/** 直接導入模式的待導入項 */
interface ImportItem {
  id: string;
  name: string;
  dataUri: string;
  width: number;
  height: number;
  palette: string[];
  /** 每條單獨分類；導入時默認為全局"默認分類"，之後可在每張卡片上單獨改 */
  category: string;
  /** 每條單獨房間（可選，'none' 表示不指定） */
  room: string;
}

const PIXEL_SIZES = [24, 32, 48, 64];
const CATEGORY_OPTIONS = ['furniture', 'rug', 'decor', 'plant', 'food', 'character', 'other'];
const CATEGORY_LABELS: Record<string, string> = {
  furniture: '傢俱', rug: '地毯', decor: '裝飾', plant: '植物', food: '食物', character: '角色', other: '其他',
};

// 房間標籤選項（可選，用於倉庫裡"按房間"篩選）。中文 tag 直接打進 asset.tags，
// 和 AssetLibrary 的 ROOM_OPTIONS 保持一致；'none' 表示不綁定到任何房間。
const ROOM_TAG_OPTIONS = [
  { id: 'none',        label: '不指定' },
  { id: 'living_room', label: '客廳',   tag: '客廳' },
  { id: 'bedroom',     label: '臥室',   tag: '臥室' },
  { id: 'study',       label: '書房',   tag: '書房' },
  { id: 'attic',       label: '閣樓',   tag: '閣樓' },
  { id: 'self_room',   label: '自我房', tag: '自我房' },
  { id: 'user_room',   label: '用戶房', tag: '用戶房' },
  { id: 'windowsill',  label: '露台',   tag: '露台' },
] as const;

const PixelAssetGenerator: React.FC<Props> = ({ onGenerated }) => {
  const [mode, setMode] = useState<GeneratorMode>('generate');
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [pixelSize, setPixelSize] = useState(32);
  const [paletteCount, setPaletteCount] = useState(8);
  const [removeBg, setRemoveBg] = useState(true);
  const [defaultCategory, setDefaultCategory] = useState('furniture');
  const [defaultRoom, setDefaultRoom] = useState<string>('none');
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout>>();

  // ─── 直接導入模式 ─────────────────────────────────────
  const [importItems, setImportItems] = useState<ImportItem[]>([]);
  const [importCategory, setImportCategory] = useState('furniture');
  const [importRoom, setImportRoom] = useState<string>('none');

  /** 直接導入：讀取像素資產，提取調色板，不做像素化處理 */
  const handleImportFiles = useCallback(async (files: FileList) => {
    const newItems: ImportItem[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.match(/^image\/(png|jpeg|webp|gif)/)) continue;
      try {
        const dataUri = await readFileAsDataUri(file);
        const img = await loadImage(dataUri);
        // 提取調色板
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const palette = extractPalette(imageData, 8);

        newItems.push({
          id: `import_${Date.now()}_${i}`,
          name: file.name.replace(/\.[^.]+$/, ''),
          dataUri,
          width: img.width,
          height: img.height,
          palette,
          category: importCategory,
          room: importRoom,
        });
      } catch (err) {
        console.error('Import failed:', err);
      }
    }
    setImportItems(prev => [...prev, ...newItems]);
  }, [importCategory, importRoom]);

  const removeImportItem = useCallback((id: string) => {
    setImportItems(prev => prev.filter(p => p.id !== id));
  }, []);

  /** 修改某一條的分類 */
  const setItemCategory = useCallback((id: string, category: string) => {
    setImportItems(prev => prev.map(p => p.id === id ? { ...p, category } : p));
  }, []);

  /** 修改某一條的房間 */
  const setItemRoom = useCallback((id: string, room: string) => {
    setImportItems(prev => prev.map(p => p.id === id ? { ...p, room } : p));
  }, []);

  /** 一鍵把全部待導入項改成指定分類 */
  const applyCategoryToAll = useCallback((category: string) => {
    setImportItems(prev => prev.map(p => ({ ...p, category })));
  }, []);

  /** 一鍵把全部待導入項改成指定房間 */
  const applyRoomToAll = useCallback((room: string) => {
    setImportItems(prev => prev.map(p => ({ ...p, room })));
  }, []);

  /** 確認導入 → 直接存入倉庫 */
  const handleConfirmImport = useCallback(async () => {
    if (importItems.length === 0) return;
    setSaving(true);

    const assets: PixelAsset[] = importItems.map((item, i) => {
      const roomOpt = ROOM_TAG_OPTIONS.find(r => r.id === item.room);
      const roomTag = roomOpt && 'tag' in roomOpt ? roomOpt.tag : null;
      const tags = [item.category, 'imported', ...(roomTag ? [roomTag] : [])];
      return {
        id: `pa_${Date.now()}_${i}`,
        name: item.name,
        originalImage: item.dataUri,
        pixelImage: item.dataUri,  // 直接使用原圖，不做轉換
        pixelSize: Math.max(item.width, item.height),
        palette: item.palette,
        width: item.width,
        height: item.height,
        createdAt: Date.now(),
        tags,
      };
    });

    await PixelAssetDB.saveBatch(assets);
    onGenerated();
    setImportItems([]);
    setSaving(false);
    trackEvent('直接导入现成像素素材');
  }, [importItems, onGenerated]);

  // ─── 生成模式（原有邏輯）─────────────────────────────

  // 上傳文件 → 預處理（加載+可選去背景）→ 生成預覽
  const handleFiles = useCallback(async (files: FileList) => {
    const newItems: PendingImage[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.match(/^image\/(png|jpeg|webp)/)) continue;
      try {
        const dataUri = await processImage(file, { maxWidth: 512, skipCompression: true });
        const img = await loadImage(dataUri);
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (removeBg) imageData = removeBackground(imageData);

        newItems.push({
          id: `upload_${Date.now()}_${i}`,
          name: file.name.replace(/\.[^.]+$/, ''),
          originalDataUri: dataUri,
          processedData: imageData,
          processedWidth: canvas.width,
          processedHeight: canvas.height,
        });
      } catch (err) {
        console.error('Upload failed:', err);
      }
    }
    setPending(prev => [...prev, ...newItems]);
  }, [removeBg]);

  // 參數變化時，重新生成所有預覽（防抖 200ms）
  useEffect(() => {
    if (pending.length === 0) return;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      regeneratePreviews();
    }, 200);
  }, [pixelSize, paletteCount, pending.length]);

  // 新上傳的圖片也立即生成預覽
  useEffect(() => {
    const needsPreview = pending.filter(p => !p.previewUri && p.processedData);
    if (needsPreview.length > 0) regeneratePreviews();
  }, [pending]);

  // 重新生成所有預覽
  const regeneratePreviews = useCallback(() => {
    setPending(prev => prev.map(item => {
      if (!item.processedData) return item;
      try {
        const palette = extractPalette(item.processedData, paletteCount);
        const result = pixelizeImage(item.processedData, pixelSize, palette);
        const uri = renderScaled(result.imageData, result.width, result.height, 4);
        return { ...item, previewUri: uri, previewPalette: palette, previewW: result.width, previewH: result.height };
      } catch {
        return item;
      }
    }));
  }, [pixelSize, paletteCount]);

  // 背景去除開關變化時，重新預處理所有圖片
  const toggleRemoveBg = useCallback(async () => {
    const newVal = !removeBg;
    setRemoveBg(newVal);
    // 重新處理所有原始圖片
    setPending(prev => prev.map(item => ({ ...item, processedData: undefined, previewUri: undefined })));
    const updated: PendingImage[] = [];
    for (const item of pending) {
      try {
        const img = await loadImage(item.originalDataUri);
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (newVal) imageData = removeBackground(imageData);
        updated.push({ ...item, processedData: imageData, processedWidth: canvas.width, processedHeight: canvas.height, previewUri: undefined });
      } catch {
        updated.push(item);
      }
    }
    setPending(updated);
  }, [removeBg, pending]);

  // 刪除
  const removePending = useCallback((id: string) => {
    setPending(prev => prev.filter(p => p.id !== id));
  }, []);

  // 確定生成 → 存入倉庫
  const handleConfirm = useCallback(async () => {
    const ready = pending.filter(p => p.previewUri);
    if (ready.length === 0) return;
    setSaving(true);

    const roomOpt = ROOM_TAG_OPTIONS.find(r => r.id === defaultRoom);
    const roomTag = roomOpt && 'tag' in roomOpt ? roomOpt.tag : null;
    const assets: PixelAsset[] = ready.map((item, i) => ({
      id: `pa_${Date.now()}_${i}`,
      name: item.name,
      originalImage: item.originalDataUri,
      pixelImage: item.previewUri!,
      pixelSize,
      palette: item.previewPalette || [],
      width: item.previewW || pixelSize,
      height: item.previewH || pixelSize,
      createdAt: Date.now(),
      tags: [defaultCategory, ...(roomTag ? [roomTag] : [])],
    }));

    await PixelAssetDB.saveBatch(assets);
    onGenerated();
    setPending([]);
    setSaving(false);
    trackEvent('生成一批像素素材');
  }, [pending, pixelSize, defaultCategory, defaultRoom, onGenerated]);

  const readyCount = pending.filter(p => p.previewUri).length;

  return (
    <div className="h-full overflow-y-auto px-4 pt-4 space-y-4 no-scrollbar" style={{ paddingBottom: 'calc(1rem + var(--safe-bottom, 0px))', boxSizing: 'border-box' }}>
      {/* 模式切換 */}
      <div className="flex gap-1 bg-slate-800/60 rounded-xl p-1">
        <button onClick={() => setMode('generate')}
          className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${mode === 'generate' ? 'bg-amber-500 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
          圖片轉像素
        </button>
        <button onClick={() => setMode('import')}
          className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${mode === 'import' ? 'bg-amber-500 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
          直接導入像素資產
        </button>
      </div>

      {/* ─── 直接導入模式 ─── */}
      {mode === 'import' && (<>
        {/* 上傳區 */}
        <div onDrop={e => { e.preventDefault(); if (e.dataTransfer.files.length > 0) handleImportFiles(e.dataTransfer.files); }}
          onDragOver={e => e.preventDefault()}
          onClick={() => importInputRef.current?.click()}
          className="border-2 border-dashed border-emerald-600/60 rounded-2xl p-6 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-emerald-400/60 transition-colors min-h-[100px]">
          <span className="text-sm text-emerald-400 font-medium">導入已有像素資產</span>
          <span className="text-[10px] text-slate-500">直接導入，不做像素化轉換</span>
          <span className="text-[10px] text-slate-500">PNG / WebP / JPEG / GIF，可多選或分多次導入</span>
          <input ref={importInputRef} type="file" accept="image/png,image/webp,image/jpeg,image/gif" multiple className="hidden"
            onChange={e => { if (e.target.files) { handleImportFiles(e.target.files); e.target.value = ''; } }} />
        </div>

        {/* 默認分類 + 默認房間（應用給之後新拖進來的圖片）+ 一鍵批改 */}
        <div className="bg-slate-800/60 rounded-xl p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-300 w-16 shrink-0">默認分類</span>
            <div className="flex gap-1 flex-1 flex-wrap">
              {CATEGORY_OPTIONS.map(cat => (
                <button key={cat} onClick={() => setImportCategory(cat)}
                  className={`px-2 py-1 rounded text-[10px] font-bold transition-all ${importCategory === cat ? 'bg-emerald-500 text-white' : 'bg-slate-700 text-slate-300'}`}>
                  {CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-300 w-16 shrink-0">默認房間</span>
            <div className="flex gap-1 flex-1 flex-wrap">
              {ROOM_TAG_OPTIONS.map(r => (
                <button key={r.id} onClick={() => setImportRoom(r.id)}
                  className={`px-2 py-1 rounded text-[10px] font-bold transition-all ${importRoom === r.id ? 'bg-sky-500 text-white' : 'bg-slate-700 text-slate-300'}`}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div className="text-[9px] text-slate-500 leading-relaxed space-y-0.5">
            <div>新導入的圖片自動用這裡的默認值；每張下面可單獨改。</div>
            {importItems.length > 0 && (
              <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                <button onClick={() => applyCategoryToAll(importCategory)}
                  className="underline hover:text-emerald-400 transition-colors">
                  全部({importItems.length})改為「{CATEGORY_LABELS[importCategory]}」
                </button>
                <button onClick={() => applyRoomToAll(importRoom)}
                  className="underline hover:text-sky-400 transition-colors">
                  全部({importItems.length})歸到「{ROOM_TAG_OPTIONS.find(r => r.id === importRoom)?.label}」
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 預覽 */}
        {importItems.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                待導入 ({importItems.length})
              </h4>
              {/* 系統文件選擇器不支持多選時，可以多次點這裡累積添加 */}
              <button onClick={() => importInputRef.current?.click()}
                className="px-2 py-1 rounded-lg text-[10px] font-bold bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 active:scale-95 transition-all">
                + 繼續添加
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {importItems.map(item => (
                <div key={item.id} className="bg-slate-800 rounded-xl overflow-hidden">
                  <div className="aspect-square bg-slate-900/50 flex items-center justify-center p-2" style={{
                    backgroundImage: 'linear-gradient(45deg, #1e293b 25%, transparent 25%, transparent 75%, #1e293b 75%), linear-gradient(45deg, #1e293b 25%, transparent 25%, transparent 75%, #1e293b 75%)',
                    backgroundSize: '8px 8px', backgroundPosition: '0 0, 4px 4px',
                  }}>
                    <img src={item.dataUri} alt={item.name} className="max-w-full max-h-full object-contain" style={{ imageRendering: 'pixelated' }} draggable={false} />
                  </div>
                  <div className="px-2 py-1.5 flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <span className="text-[9px] text-slate-300 truncate block">{item.name}</span>
                      <span className="text-[8px] text-slate-500">{item.width}×{item.height}</span>
                    </div>
                    <button onClick={() => removeImportItem(item.id)}
                      className="text-[9px] text-slate-500 hover:text-red-400 ml-1 shrink-0">移除</button>
                  </div>
                  {/* 每張單獨分類 */}
                  <div className="px-2 pb-1 flex flex-wrap gap-0.5">
                    {CATEGORY_OPTIONS.map(cat => (
                      <button key={cat} onClick={() => setItemCategory(item.id, cat)}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-all ${
                          item.category === cat ? 'bg-emerald-500 text-white' : 'bg-slate-700/60 text-slate-400 hover:text-slate-200'
                        }`}>
                        {CATEGORY_LABELS[cat]}
                      </button>
                    ))}
                  </div>
                  {/* 每張單獨房間 */}
                  <div className="px-2 pb-1.5 flex flex-wrap gap-0.5">
                    {ROOM_TAG_OPTIONS.map(r => (
                      <button key={r.id} onClick={() => setItemRoom(item.id, r.id)}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-all ${
                          item.room === r.id ? 'bg-sky-500 text-white' : 'bg-slate-700/40 text-slate-500 hover:text-slate-200'
                        }`}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                  {item.palette.length > 0 && (
                    <div className="flex h-1.5">
                      {item.palette.map((c, i) => (
                        <div key={i} className="flex-1" style={{ backgroundColor: c }} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <button onClick={handleConfirmImport}
              disabled={saving}
              className={`w-full py-3 rounded-xl text-sm font-bold transition-all active:scale-95 ${
                saving ? 'bg-slate-700 text-slate-400 cursor-wait' : 'bg-emerald-500 text-white'
              }`}>
              {saving ? '導入中...' : `確認導入 (${importItems.length})`}
            </button>
          </div>
        )}
      </>)}

      {/* ─── 圖片轉像素模式（原有邏輯）─── */}
      {mode === 'generate' && (<>
      {/* 上傳區 */}
      <div onDrop={e => { e.preventDefault(); if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files); }}
        onDragOver={e => e.preventDefault()}
        onClick={() => fileInputRef.current?.click()}
        className="border-2 border-dashed border-slate-600 rounded-2xl p-6 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-amber-500/50 transition-colors min-h-[100px]">
        <span className="text-sm text-slate-400 font-medium">點擊或拖拽上傳圖片</span>
        <span className="text-[10px] text-slate-500">PNG / WebP / JPEG，可批量上傳</span>
        <input ref={fileInputRef} type="file" accept="image/png,image/webp,image/jpeg" multiple className="hidden"
          onChange={e => e.target.files && handleFiles(e.target.files)} />
      </div>

      {/* 參數（改參數實時刷新預覽） */}
      <div className="bg-slate-800/60 rounded-xl p-3 space-y-3">
        <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">生成參數</h4>

        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-300 w-16">像素尺寸</span>
          <div className="flex gap-1 flex-1">
            {PIXEL_SIZES.map(s => (
              <button key={s} onClick={() => setPixelSize(s)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${pixelSize === s ? 'bg-amber-500 text-white' : 'bg-slate-700 text-slate-300'}`}>
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-300 w-16">調色板</span>
          <input type="range" min={4} max={16} value={paletteCount}
            onChange={e => setPaletteCount(parseInt(e.target.value))}
            className="flex-1 h-1 accent-amber-500" />
          <span className="text-xs text-slate-400 w-6 text-right">{paletteCount}</span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-300">自動去除背景</span>
          <button onClick={toggleRemoveBg}
            className={`w-10 h-5 rounded-full transition-colors ${removeBg ? 'bg-amber-500' : 'bg-slate-600'}`}>
            <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${removeBg ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-300 w-16">分類</span>
          <div className="flex gap-1 flex-1 flex-wrap">
            {CATEGORY_OPTIONS.map(cat => (
              <button key={cat} onClick={() => setDefaultCategory(cat)}
                className={`px-2 py-1 rounded text-[10px] font-bold transition-all ${defaultCategory === cat ? 'bg-amber-500 text-white' : 'bg-slate-700 text-slate-300'}`}>
                {CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-300 w-16">房間</span>
          <div className="flex gap-1 flex-1 flex-wrap">
            {ROOM_TAG_OPTIONS.map(r => (
              <button key={r.id} onClick={() => setDefaultRoom(r.id)}
                className={`px-2 py-1 rounded text-[10px] font-bold transition-all ${defaultRoom === r.id ? 'bg-sky-500 text-white' : 'bg-slate-700 text-slate-300'}`}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 預覽列表 */}
      {pending.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
            預覽 ({pending.length})
            <span className="text-slate-500 font-normal ml-1">調整參數實時刷新</span>
          </h4>
          <div className="grid grid-cols-2 gap-2">
            {pending.map(item => (
              <div key={item.id} className="bg-slate-800 rounded-xl overflow-hidden">
                {/* 原圖 vs 像素化對比 */}
                <div className="flex">
                  <div className="w-1/2 aspect-square bg-slate-900 flex items-center justify-center p-1">
                    <img src={item.originalDataUri} alt="原圖" className="max-w-full max-h-full object-contain" draggable={false} />
                  </div>
                  <div className="w-1/2 aspect-square bg-slate-900/50 flex items-center justify-center p-1" style={{
                    backgroundImage: 'linear-gradient(45deg, #1e293b 25%, transparent 25%, transparent 75%, #1e293b 75%), linear-gradient(45deg, #1e293b 25%, transparent 25%, transparent 75%, #1e293b 75%)',
                    backgroundSize: '8px 8px', backgroundPosition: '0 0, 4px 4px',
                  }}>
                    {item.previewUri ? (
                      <img src={item.previewUri} alt="預覽" className="max-w-full max-h-full object-contain" style={{ imageRendering: 'pixelated' }} draggable={false} />
                    ) : (
                      <span className="text-[9px] text-slate-500">處理中...</span>
                    )}
                  </div>
                </div>
                {/* 信息欄 */}
                <div className="px-2 py-1.5 flex items-center justify-between">
                  <span className="text-[9px] text-slate-300 truncate flex-1">{item.name}</span>
                  <button onClick={() => removePending(item.id)}
                    className="text-[9px] text-slate-500 hover:text-red-400 ml-1 shrink-0">移除</button>
                </div>
                {/* 調色板 */}
                {item.previewPalette && (
                  <div className="flex h-1.5">
                    {item.previewPalette.map((c, i) => (
                      <div key={i} className="flex-1" style={{ backgroundColor: c }} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 確定按鈕 */}
          <button onClick={handleConfirm}
            disabled={saving || readyCount === 0}
            className={`w-full py-3 rounded-xl text-sm font-bold transition-all active:scale-95 ${
              saving ? 'bg-slate-700 text-slate-400 cursor-wait'
                : readyCount > 0 ? 'bg-amber-500 text-white' : 'bg-slate-700 text-slate-500'
            }`}>
            {saving ? '保存中...' : `確定生成 (${readyCount})`}
          </button>
        </div>
      )}
      </>)}
    </div>
  );
};

function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function renderScaled(imageData: ImageData, w: number, h: number, scale: number): string {
  const small = document.createElement('canvas');
  small.width = w; small.height = h;
  small.getContext('2d')!.putImageData(imageData, 0, 0);
  const big = document.createElement('canvas');
  big.width = w * scale; big.height = h * scale;
  const ctx = big.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, big.width, big.height);
  return big.toDataURL('image/png');
}

export default PixelAssetGenerator;
