import React, { useEffect, useRef, useState } from 'react';
import { Check, Crop, Gear, Play, Sparkle, Trash, TShirt, UploadSimple, X } from '@phosphor-icons/react';
import type { Live2DAction } from '../../utils/live2dModelStore';
import type { CompanionFrameStyleId } from './companionFrameStyles';
import { useBlobRefUrl } from '../../utils/blobRef';
import './CompanionWardrobeDrawer.css';

type StaticOutfit = {
  id: string;
  name: string;
  preview?: string;
  expressionCount: number;
};

const StaticOutfitPreview: React.FC<{ value?: string }> = ({ value }) => {
  const url = useBlobRefUrl(value);
  return url ? <img src={url} alt="" className="h-full w-full object-contain" /> : <TShirt weight="duotone" />;
};

type CompanionWardrobeDrawerProps = {
  open: boolean;
  styleId: CompanionFrameStyleId;
  characterName: string;
  wardrobeActions: Live2DAction[];
  activeActionId?: string;
  onSelect: (action: Live2DAction) => void;
  modelOutfits?: Array<{ assetId: string; fileName: string; format: 'vrm' | 'live2d'; builtIn?: true }>;
  activeModelAssetId?: string;
  onSelectModel?: (assetId: string) => void;
  staticOutfits?: StaticOutfit[];
  activeStaticOutfitId?: string;
  onSelectStaticOutfit?: (outfitId: string) => void;
  onDeleteModel?: (assetId: string) => void | Promise<void>;
  onDeleteStaticOutfit?: (outfitId: string) => void | Promise<void>;
  onDeleteWardrobeAction?: (actionId: string) => void | Promise<void>;
  staticMode?: boolean;
  staticSource?: 'upload' | 'date';
  discoveryHint?: boolean;
  onOpenComposition: () => void;
  onManageActions: () => void;
  onImportOutfit?: () => void;
  importBusy?: boolean;
  onClose: () => void;
};

type WardrobeItemButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  onLongPress?: () => void;
};

/** iOS/Capacitor-friendly long press that cancels as soon as a list scroll starts. */
const WardrobeItemButton: React.FC<WardrobeItemButtonProps> = ({ onLongPress, onClick, ...props }) => {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);
  const cancel = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    startRef.current = null;
  };
  useEffect(() => cancel, []);
  const begin = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!onLongPress || event.button > 0) return;
    cancel();
    firedRef.current = false;
    startRef.current = { x: event.clientX, y: event.clientY };
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      firedRef.current = true;
      navigator.vibrate?.(28);
      onLongPress();
    }, 560);
  };
  const move = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = startRef.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel();
  };
  return (
    <button
      {...props}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onContextMenu={event => {
        if (!onLongPress) return;
        event.preventDefault();
        cancel();
        firedRef.current = true;
        onLongPress();
      }}
      onClick={event => {
        if (firedRef.current) {
          firedRef.current = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClick?.(event);
      }}
    />
  );
};

type PendingDelete = {
  kind: 'model' | 'static' | 'action';
  id: string;
  name: string;
  detail: string;
};

const CompanionWardrobeDrawer: React.FC<CompanionWardrobeDrawerProps> = ({
  open,
  styleId,
  characterName,
  wardrobeActions,
  activeActionId,
  onSelect,
  modelOutfits = [],
  activeModelAssetId,
  onSelectModel,
  staticOutfits = [],
  activeStaticOutfitId,
  onSelectStaticOutfit,
  onDeleteModel,
  onDeleteStaticOutfit,
  onDeleteWardrobeAction,
  staticMode = false,
  staticSource,
  discoveryHint = false,
  onOpenComposition,
  onManageActions,
  onImportOutfit,
  importBusy = false,
  onClose,
}) => {
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  useEffect(() => {
    if (!open) {
      setPendingDelete(null);
      setDeleteBusy(false);
    }
  }, [open]);
  if (!open) return null;
  const confirmDelete = async () => {
    if (!pendingDelete || deleteBusy) return;
    setDeleteBusy(true);
    try {
      if (pendingDelete.kind === 'model') await onDeleteModel?.(pendingDelete.id);
      else if (pendingDelete.kind === 'static') await onDeleteStaticOutfit?.(pendingDelete.id);
      else await onDeleteWardrobeAction?.(pendingDelete.id);
      setPendingDelete(null);
    } finally {
      setDeleteBusy(false);
    }
  };
  return (
    <div className="companion-wardrobe-layer absolute inset-0 z-[70]" data-wardrobe-style={styleId} data-testid="companion-real-wardrobe">
      <button type="button" className="companion-wardrobe-scrim absolute inset-0" onClick={onClose} aria-label="關閉衣櫥" />
      <section className="companion-wardrobe-drawer absolute inset-y-0 right-0 flex w-[78%] max-w-[31rem] flex-col">
        <header className="companion-wardrobe-header">
          <div><small>MANUAL WARDROBE</small><h2><TShirt weight="fill" /> {characterName} 的衣櫥</h2></div>
          <button type="button" onClick={onClose} aria-label="關閉"><X weight="bold" /></button>
        </header>

        <div className="companion-wardrobe-tabs">
          <span className="is-active"><TShirt weight="fill" /> 服裝</span>
          <button type="button" onClick={onOpenComposition}><Crop weight="bold" /> 場景與構圖</button>
        </div>

        {discoveryHint && (
          <div className="companion-wardrobe-discovery" data-testid="companion-wardrobe-discovery-tip">
            <Sparkle weight="fill" />
            <p><strong>以後想換場景或衣服，就從這裡進。</strong><span>點「場景與構圖」可以更換桌面風格、背景和角色位置。</span></p>
          </div>
        )}

        <p className="companion-wardrobe-note">{staticSource === 'date' ? '衣服來自見面模式立繪。桌面擁有獨立選擇，AI 只負責按台詞情緒切換同一套衣服裡的表情。' : staticSource === 'upload' ? '可以繼續導入 PNG / GIF；衣櫥只接收相同類型，選中的圖片會在首頁與視頻通話中共用。' : '可收納同模型的換裝按鍵，也可導入更多同類型整模。當前選擇由你鎖定，AI 和點擊反饋都不能替換。'}</p>

        <div className="companion-wardrobe-list">
          {staticMode && staticOutfits.map(outfit => {
            const active = activeStaticOutfitId === outfit.id;
            return (
              <WardrobeItemButton
                key={outfit.id}
                type="button"
                className={active ? 'is-active' : ''}
                onClick={() => onSelectStaticOutfit?.(outfit.id)}
                onLongPress={staticSource === 'upload' && onDeleteStaticOutfit ? () => setPendingDelete({
                  kind: 'static', id: outfit.id, name: outfit.name, detail: '圖片文件也會從本地衣櫥移除。',
                }) : undefined}
                data-static-outfit={outfit.id}
              >
                <span className="companion-wardrobe-thumb"><StaticOutfitPreview value={outfit.preview} /></span>
                <span className="companion-wardrobe-copy"><strong>{outfit.name}</strong><small>{staticSource === 'upload' ? '靜態圖片' : `${outfit.expressionCount}/5 個基礎表情`}</small></span>
                <span className="companion-wardrobe-play">{active ? <Check weight="bold" /> : <Play weight="fill" />}</span>
              </WardrobeItemButton>
            );
          })}
          {!staticMode && modelOutfits.map((model, index) => {
            const active = activeModelAssetId === model.assetId;
            return (
              <WardrobeItemButton
                key={model.assetId}
                type="button"
                className={active ? 'is-active' : ''}
                onClick={() => onSelectModel?.(model.assetId)}
                onLongPress={!model.builtIn && onDeleteModel ? () => setPendingDelete({
                  kind: 'model', id: model.assetId, name: model.fileName,
                  detail: active ? '這是當前模型；刪除後會切到下一套可用模型。' : '模型包與運行緩存都會從本地刪除。',
                }) : undefined}
                data-model-outfit={model.assetId}
              >
                <span className="companion-wardrobe-index">M{String(index + 1).padStart(2, '0')}</span>
                <span className="companion-wardrobe-copy"><strong>{model.fileName}</strong><small>{model.format === 'live2d' ? 'Live2D 整模' : 'VRM 整模'}</small></span>
                <span className="companion-wardrobe-play">{active ? <Check weight="bold" /> : <Play weight="fill" />}</span>
              </WardrobeItemButton>
            );
          })}
          {!staticMode && wardrobeActions.map((action, index) => {
            const active = activeActionId === action.id;
            return (
              <WardrobeItemButton
                key={action.id}
                type="button"
                className={active ? 'is-active' : ''}
                onClick={() => onSelect(action)}
                onLongPress={onDeleteWardrobeAction ? () => setPendingDelete({
                  kind: 'action', id: action.id, name: action.name,
                  detail: '只從衣櫥移除；原動作仍保留在動作庫，並保持“僅手動”。',
                }) : undefined}
                data-wardrobe-action={action.id}
              >
                <span className="companion-wardrobe-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="companion-wardrobe-copy"><strong>{action.name}</strong><small>{action.hotkey ? `原按鍵 ${action.hotkey}` : action.kind === 'motion' ? '服裝動作' : action.kind === 'params' ? '服裝參數組' : '服裝表情'}</small></span>
                <span className="companion-wardrobe-play">{active ? <Check weight="bold" /> : <Play weight="fill" />}</span>
              </WardrobeItemButton>
            );
          })}
          {((staticMode && staticOutfits.length === 0) || (!staticMode && modelOutfits.length === 0 && wardrobeActions.length === 0)) && (
            <div className="companion-wardrobe-empty">
              <TShirt weight="duotone" />
              <strong>{staticSource === 'date' ? '還沒有見面衣服' : staticMode ? '單張圖片沒有額外衣服' : '還沒有標記服裝動作'}</strong>
              <span>{staticSource === 'date' ? '去見面模式添加默認立繪或新皮膚，每套衣服可以準備五種基礎表情。' : staticMode ? '你可以繼續使用當前圖片，或進入場景與構圖調整桌面。' : '去動作庫預覽模型按鍵，把會換裝的動作加入衣櫥。'}</span>
            </div>
          )}
        </div>

        <footer className="companion-wardrobe-footer">
          {staticSource !== 'date' && onImportOutfit && (
            <button type="button" onClick={onImportOutfit} disabled={importBusy}><UploadSimple weight="bold" /> {importBusy ? '正在導入…' : `導入更多${staticSource === 'upload' ? '圖片' : modelOutfits[0]?.format === 'vrm' ? ' VRM' : ' Live2D'}`}</button>
          )}
          <button type="button" onClick={onManageActions}><Gear weight="bold" /> {staticSource === 'date' ? '管理見面立繪' : staticMode ? '更換靜態圖片' : '管理服裝動作'}</button>
          <small>{staticSource === 'date' ? 'DATE SPRITES · 5 EXPRESSIONS' : staticMode ? 'STATIC IMAGE · PNG / GIF · 長按刪除' : 'WARDROBE ACTIONS · USER ONLY · 長按刪除'}</small>
        </footer>
      </section>

      {pendingDelete && (
        <div className="companion-wardrobe-confirm absolute inset-0 z-20 flex items-end justify-center p-4" data-testid="companion-wardrobe-delete-confirm">
          <button type="button" className="absolute inset-0 bg-black/55" onClick={() => { if (!deleteBusy) setPendingDelete(null); }} aria-label="取消刪除" />
          <div className="relative w-full max-w-[22rem] border p-4 shadow-2xl">
            <div className="flex items-center gap-2 text-[12px] font-semibold"><Trash size={16} weight="bold" /> 從衣櫥刪除？</div>
            <div className="mt-2 break-all text-[13px] font-medium">{pendingDelete.name}</div>
            <div className="mt-1 text-[9px] leading-relaxed opacity-60">{pendingDelete.detail}</div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" disabled={deleteBusy} onClick={() => setPendingDelete(null)} className="border px-3 py-2 text-[10px]">取消</button>
              <button type="button" disabled={deleteBusy} onClick={() => { void confirmDelete(); }} className="border border-rose-300/45 bg-rose-500/18 px-3 py-2 text-[10px] text-rose-100">{deleteBusy ? '正在刪除…' : '確認刪除'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CompanionWardrobeDrawer;
