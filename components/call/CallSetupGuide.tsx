import React, { useEffect, useRef } from 'react';
import { ArrowLeft, ArrowRight, Check, Cube, FileZip, FolderOpen, Gear, ImageSquare, X } from '@phosphor-icons/react';
import type { UserCameraMode } from './UserCameraModePicker';
import type { CompanionAvatarSource } from '../../utils/companionAvatar';

export type CallSetupGuideStep = 'model' | 'camera';

interface CallSetupGuideProps {
  step: CallSetupGuideStep;
  characterName: string;
  modelName?: string;
  modelFormat?: 'live2d' | 'vrm';
  avatarSource: CompanionAvatarSource;
  staticImageName?: string;
  hasDatePortraits: boolean;
  dateOutfitName?: string;
  cameraMode: UserCameraMode;
  hasFakeImage: boolean;
  accentColor: string;
  lightTheme?: boolean;
  onStepChange: (step: CallSetupGuideStep) => void;
  onChooseModelFile: () => void;
  onChooseLive2DFolder: () => void;
  onChooseAvatarSource: (source: CompanionAvatarSource) => void;
  onChooseStaticImage: () => void;
  onManageDatePortraits: () => void;
  onConfigureLive2D?: () => void;
  onCameraModeChange: (mode: UserCameraMode) => void;
  onChooseFakeImage: () => void;
  onStart: () => void;
  onClose: () => void;
}

const CAMERA_OPTIONS: Array<{
  id: UserCameraMode;
  index: string;
  title: string;
  detail: string;
  data: string;
}> = [
  { id: 'off', index: '0', title: '不打開', detail: '默認與最私密的選擇', data: '不採集 · 不注入' },
  { id: 'fake', index: '1', title: '靜態機位', detail: '放一張圖，只用於通話畫面和截圖', data: '圖片不發送' },
  { id: 'emotion', index: '2', title: '本地情緒', detail: '本機識別表情，用文字輕量矯正回覆', data: '僅注入情緒文字' },
  { id: 'snapshot', index: '3', title: '每輪快照', detail: '點擊發送時截一幀；本地記錄只保留最近 3 輪', data: '舊圖顯示 [圖片]' },
];

const CallSetupGuide: React.FC<CallSetupGuideProps> = ({
  step,
  characterName,
  modelName,
  modelFormat,
  avatarSource,
  staticImageName,
  hasDatePortraits,
  dateOutfitName,
  cameraMode,
  hasFakeImage,
  accentColor,
  lightTheme = false,
  onStepChange,
  onChooseModelFile,
  onChooseLive2DFolder,
  onChooseAvatarSource,
  onChooseStaticImage,
  onManageDatePortraits,
  onConfigureLive2D,
  onCameraModeChange,
  onChooseFakeImage,
  onStart,
  onClose,
}) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const ink = lightTheme ? '#292638' : '#f8f6ff';
  const muted = lightTheme ? 'rgba(41,38,56,.5)' : 'rgba(248,246,255,.48)';
  const line = lightTheme ? 'rgba(62,55,82,.13)' : 'rgba(255,255,255,.11)';
  const panel = lightTheme ? '#f7f4fb' : '#100b19';

  useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const fakeImageMissing = cameraMode === 'fake' && !hasFakeImage;
  const visualAvailable = avatarSource === 'model' ? Boolean(modelName) : avatarSource === 'upload' ? Boolean(staticImageName) : hasDatePortraits;
  const visualName = avatarSource === 'upload'
    ? staticImageName || '尚未導入靜態圖片'
    : avatarSource === 'date'
      ? dateOutfitName || '尚未準備見面立繪'
      : modelName || '尚未綁定動態模型';
  const visualDetail = avatarSource === 'upload'
    ? 'PNG / GIF · 單圖保持原樣'
    : avatarSource === 'date'
      ? '見面立繪 · 按通話情緒切換同套表情'
      : modelFormat === 'live2d'
        ? 'Live2D · 可校準構圖、動作與衣櫥'
        : modelFormat === 'vrm' ? 'VRM · 測試支持' : '支持 Live2D ZIP / 文件夾與 VRM';

  return (
    <div className="absolute inset-0 z-[80] flex items-end bg-[#08050f]/72 backdrop-blur-sm" data-testid="call-setup-guide">
      <button type="button" aria-label="關閉通話準備引導" className="absolute inset-0" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="call-setup-guide-title"
        tabIndex={-1}
        className="relative max-h-[88%] w-full overflow-hidden rounded-t-[2.25rem] border-t outline-none"
        style={{ color: ink, background: panel, borderColor: line, paddingBottom: 'max(1rem, var(--safe-bottom))' }}
        onClick={event => event.stopPropagation()}
      >
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-current opacity-15" />

        <header className="px-5 pb-4 pt-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[9px] font-semibold tracking-[0.28em]" style={{ color: muted }}>VIDEO LINK / PREPARATION</div>
              <h2 id="call-setup-guide-title" className="mt-1.5 text-[23px] font-semibold leading-none">
                {step === 'model' ? '選擇對方的視頻形象。' : '你要怎樣入鏡？'}
              </h2>
              <p className="mt-2 text-[11px] leading-5" style={{ color: muted }}>
                {step === 'model'
                  ? `動態模型、靜態圖片和見面立繪都在這裡切換，桌面與視頻通話共用同一選擇。`
                  : '選擇只對本次通話生效；下次打開仍從關閉開始。'}
              </p>
            </div>
            <button type="button" onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border active:scale-90" style={{ borderColor: line }} aria-label="關閉">
              <X size={15} weight="bold" />
            </button>
          </div>

          <div className="mt-5 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[9px] font-medium tracking-[0.12em]" style={{ color: muted }}>
            <button type="button" onClick={() => onStepChange('model')} className="flex items-center gap-2 text-left" style={{ color: step === 'model' ? accentColor : undefined }}>
              <span className="flex h-6 w-6 items-center justify-center rounded-full border" style={{ borderColor: step === 'model' ? accentColor : line }}>01</span> 對方形象
            </button>
            <span className="h-px w-10" style={{ background: line }} />
            <button type="button" onClick={() => onStepChange('camera')} className="flex items-center justify-end gap-2 text-right" style={{ color: step === 'camera' ? accentColor : undefined }}>
              <span className="flex h-6 w-6 items-center justify-center rounded-full border" style={{ borderColor: step === 'camera' ? accentColor : line }}>02</span> 我的鏡頭
            </button>
          </div>
        </header>

        <div className="max-h-[56vh] overflow-y-auto border-y no-scrollbar" style={{ borderColor: line }}>
          {step === 'model' ? (
            <>
              <section className="px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border" style={{ borderColor: `${accentColor}66`, color: accentColor, background: `${accentColor}12` }}>
                    <Cube size={20} weight="fill" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[9px] font-semibold tracking-[0.2em]" style={{ color: muted }}>CURRENT CAST</div>
                    <div className="mt-1 truncate text-[14px] font-medium">{visualName}</div>
                    <div className="mt-0.5 text-[10px]" style={{ color: muted }}>{visualDetail}</div>
                  </div>
                  {visualAvailable && <Check size={17} weight="bold" style={{ color: accentColor }} />}
                </div>
              </section>

              <section className="border-t" style={{ borderColor: line }}>
                <div className="grid grid-cols-3 gap-1.5 border-b p-2" style={{ borderColor: line }}>
                  {([
                    ['model', '動態模型'],
                    ['upload', '靜態圖片'],
                    ['date', '見面立繪'],
                  ] as const).map(([source, label]) => {
                    const active = avatarSource === source;
                    return (
                      <button
                        key={source}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChooseAvatarSource(source)}
                        className="rounded-xl border px-2 py-2 text-[10px] font-medium transition active:scale-[.98]"
                        style={{ borderColor: active ? `${accentColor}88` : line, color: active ? accentColor : muted, background: active ? `${accentColor}12` : undefined }}
                      >
                        {active && <Check size={10} weight="bold" className="mr-1 inline" />}{label}
                      </button>
                    );
                  })}
                </div>

                {avatarSource === 'model' ? (
                  <>
                    <button type="button" onClick={onChooseModelFile} className="grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 border-b px-5 py-3.5 text-left active:bg-current/[.035]" style={{ borderColor: line }}>
                      <FileZip size={18} style={{ color: accentColor }} />
                      <span><span className="block text-[13px] font-medium">模型文件</span><span className="mt-0.5 block text-[10px]" style={{ color: muted }}>Live2D ZIP 或 VRM；.vroid 會提示先導出</span></span>
                      <ArrowRight size={14} style={{ color: muted }} />
                    </button>
                    <button type="button" onClick={onChooseLive2DFolder} className="grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 border-b px-5 py-3.5 text-left active:bg-current/[.035]" style={{ borderColor: line }}>
                      <FolderOpen size={18} style={{ color: accentColor }} />
                      <span><span className="block text-[13px] font-medium">Live2D 完整文件夾</span><span className="mt-0.5 block text-[10px]" style={{ color: muted }}>選擇包含 model3.json 的整個目錄</span></span>
                      <ArrowRight size={14} style={{ color: muted }} />
                    </button>
                    {modelFormat === 'live2d' && onConfigureLive2D && (
                      <button type="button" onClick={onConfigureLive2D} className="grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 px-5 py-3.5 text-left active:bg-current/[.035]">
                        <Gear size={18} style={{ color: accentColor }} />
                        <span><span className="block text-[13px] font-medium">校準構圖、動作與真·衣櫥</span><span className="mt-0.5 block text-[10px]" style={{ color: muted }}>預覽保持常駐，動作與參數在懸浮設置窗裡調整</span></span>
                        <ArrowRight size={14} style={{ color: muted }} />
                      </button>
                    )}
                  </>
                ) : avatarSource === 'upload' ? (
                  <button type="button" onClick={onChooseStaticImage} className="grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 px-5 py-4 text-left active:bg-current/[.035]">
                    <ImageSquare size={18} style={{ color: accentColor }} />
                    <span><span className="block text-[13px] font-medium">{staticImageName ? '更換 PNG / GIF' : '導入 PNG / GIF'}</span><span className="mt-0.5 block text-[10px]" style={{ color: muted }}>同一張圖會同時用於陪伴桌面與視頻通話</span></span>
                    <ArrowRight size={14} style={{ color: muted }} />
                  </button>
                ) : (
                  <button type="button" onClick={onManageDatePortraits} className="grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 px-5 py-4 text-left active:bg-current/[.035]">
                    <ImageSquare size={18} style={{ color: accentColor }} />
                    <span><span className="block text-[13px] font-medium">{hasDatePortraits ? '管理見面立繪表情' : '添加見面立繪'}</span><span className="mt-0.5 block text-[10px]" style={{ color: muted }}>沿用見面模式的服裝與表情；AI 只按通話情緒切同套表情</span></span>
                    <ArrowRight size={14} style={{ color: muted }} />
                  </button>
                )}
              </section>

              <p className="border-t px-5 py-3 text-[10px] leading-5" style={{ borderColor: line, color: muted }}>
                {avatarSource === 'model'
                  ? '導入 Live2D 後會自動進入動作與衣櫥設置。衣櫥動作強制僅手動；VRM 目前仍是測試功能。'
                  : avatarSource === 'date'
                    ? '見面立繪使用靜態表情管線，不會調用 Live2D 動作；服裝仍由你手動選擇。'
                    : '單張 PNG / GIF 不切換表情；需要情緒表情時可選擇見面立繪。'}
              </p>
            </>
          ) : (
            <section>
              {CAMERA_OPTIONS.map(option => {
                const active = cameraMode === option.id;
                const needsImage = option.id === 'fake' && !hasFakeImage;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      onCameraModeChange(option.id);
                      if (needsImage) onChooseFakeImage();
                    }}
                    className="grid w-full grid-cols-[2.7rem_1fr_auto] items-center gap-3 border-b px-5 py-3.5 text-left transition last:border-b-0 active:bg-current/[.035]"
                    style={{ borderColor: line, background: active ? `${accentColor}0e` : undefined }}
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-full border text-[12px] font-semibold" style={{ borderColor: active ? accentColor : line, color: active ? accentColor : muted }}>{option.index}</span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium">{option.title}</span>
                      <span className="mt-0.5 block text-[10px] leading-4" style={{ color: muted }}>{option.detail}</span>
                    </span>
                    <span className="text-right text-[9px] font-medium tracking-[.08em]" style={{ color: active ? accentColor : muted }}>{needsImage ? '選圖片' : option.data}</span>
                  </button>
                );
              })}
              <p className="border-t px-5 py-3 text-[10px] leading-5" style={{ borderColor: line, color: muted }}>
                本地情緒只注入“識別到的情緒”文字，不上傳攝像頭畫面；每輪快照會在點擊發送時截取一幀，並僅在本機記錄保留最近 3 輪。靜態機位永遠不隨消息發送。
              </p>
            </section>
          )}
        </div>

        <footer className="grid grid-cols-[auto_1fr] gap-2.5 px-5 pt-4">
          {step === 'camera' ? (
            <button type="button" onClick={() => onStepChange('model')} className="flex min-h-12 items-center justify-center gap-1.5 rounded-2xl border px-4 text-[12px] font-medium active:scale-[.98]" style={{ borderColor: line, color: muted }}>
              <ArrowLeft size={14} /> 模型
            </button>
          ) : (
            <button type="button" onClick={onClose} className="min-h-12 rounded-2xl border px-4 text-[12px] font-medium active:scale-[.98]" style={{ borderColor: line, color: muted }}>稍後</button>
          )}
          <button
            type="button"
            disabled={fakeImageMissing}
            onClick={() => step === 'model' ? onStepChange('camera') : onStart()}
            className="flex min-h-12 items-center justify-center gap-2 rounded-2xl px-4 text-[13px] font-semibold text-white transition active:scale-[.98] disabled:opacity-40"
            style={{ background: `linear-gradient(100deg, ${accentColor}c8, ${accentColor})`, boxShadow: `0 10px 28px ${accentColor}2f` }}
          >
            {step === 'model' ? '下一步：設置我的鏡頭' : fakeImageMissing ? '先選擇靜態圖片' : '按這個方案接通'} <ArrowRight size={15} weight="bold" />
          </button>
        </footer>
      </div>
    </div>
  );
};

export default CallSetupGuide;
