
import { initializeFirstUseGuide } from '../utils/firstUseGuide';
import React, { createContext, useContext, useEffect, useState, useRef, useCallback, useMemo } from 'react';
import type { VRSARActivity } from '../types';
import { APIConfig, AppID, OSTheme, VirtualTime, CharacterProfile, CharacterGroup, NPCProfile, ChatTheme, Toast, FullBackupData, UserProfile, UserPersona, ApiPreset, GroupProfile, SystemLog, Worldbook, NovelBook, SongSheet, Message, RealtimeConfig, AppearancePreset, CloudBackupConfig, CloudBackupFile, MemoryPalaceFeatureFlags } from '../types';
import { applyActivePersona } from '../utils/userPersona';
import { DB } from '../utils/db';
import type { AvatarTouchRecord } from '../utils/avatarTouch';
import { clampClaudeTemperature, modelRejectsSamplingParams, stripSamplingParams } from '../utils/samplingParamCompat';
import { buildMalformedImageDiagnostics, extractImagesInPlace, deepCloneForExport, stripBackupImages, parseImageDataUrlForBackup, type BackupObjectPath, type MalformedBackupImageDiagnostic } from '../utils/backupExport';
import { isBlobRef, getBlobForRef, restoreBlobRef, migrateDataUrlToRef, migrateAppearancePresetBlobRefs, migrateChatThemeBlobRefs, resolveBlobRefsDeep, resolveRefToDataUrl, BLOBREF_PREFIX, deleteBlobRefIfUnreferenced } from '../utils/blobRef';
import { resolveBlobRefsInRequestBody } from '../utils/apiBlobRefs';
import { collectBlobRefs, writeBlobsToZip, readBlobsIndex, restoreBlobsFromZip } from '../utils/backupBlobs';
import { initPwaIcon, clearPwaIcon } from '../utils/appIcon';
import { LEGACY_DEFAULT_WALLPAPER, isLegacyDefaultWallpaper, shouldPreserveLegacyDefaultWallpaper } from '../utils/wallpaperCompat';
import { migrateSharkpanAssets } from '../utils/sharkpanAssetMigration';
import { stripCompanionChatStyleResidue } from '../utils/companionThemeIsolation';
import { SULLY_DEFAULT_AVATAR_URL, shouldMigrateSullyAvatar } from '../utils/sullyAvatar';
import { exportStoryTheaterAppearanceSetting, restoreStoryTheaterAppearanceSetting } from '../utils/storyTheaterBackup';
import { createV2ArrayFieldWriter, writeV2Backup, assembleV2Backup, type BackupManifest, type ZipFileWriter, type ZipFileReader } from '../utils/backupFormat';
import { externalizeVoiceMessageBlobs, restoreVoiceMessageBlobs, shouldIncludeVoiceRelatedAssetInBackup } from '../utils/voiceMessageBackup';
import { ensureCompanionVoiceAssetsForBackup, isCompanionVoiceAssetId } from '../utils/companionVoiceAssets';
import { collectCharacterCompanionVoiceAssetIds } from '../utils/companionPresets';
import { encodeVectorsForBackup, encodeVectorsForBackupChunked } from '../utils/memoryPalace/db';
import { ProactiveChat } from '../utils/proactiveChat';
import { resolveCharacterChatApi } from '../utils/characterApi';
import { VRScheduler, type VRSessionOutcome } from '../utils/vrWorld/scheduler';
import { runVRSession } from '../utils/vrWorld/runSession';
import { allowsAutomaticVR } from '../utils/vrWorld/participation';
import { logVRApiCall } from '../utils/vrWorld/vrApi';
import { VR_DEFAULT_INTERVAL_MIN } from '../utils/vrWorld/constants';
import { WorldScheduler, toTickEntries } from '../utils/worldHome/scheduler';
import { runWorldEpisode, rerollWorldCharBeat } from '../utils/worldHome/engine';
import { migrateWorldDaySegs } from '../utils/worldHome/prompts';
import { ChatParser } from '../utils/chatParser';
import { safeFetchJson } from '../utils/safeApi';
import { captureApiRequestOnce, getApiCallAmbientContext, recordApiCall, setApiCallAmbientContext, updateApiRequestCaptureUsage } from '../utils/apiCallLog';
import { isGlobalStreamEnabled, upgradeChatBodyToStream, assembleUpgradedResponse } from '../utils/streamUpgrade';
import { rewriteStaleWorkerUrl } from '../utils/proxyWorker';
import { buildFetchFailureDetail, classifyFetchFailure, describeReachabilityProbe, parseTargetUrl, probeOriginReachability, shouldProbeReachability, summarizeFetchRequestBody } from '../utils/networkFailureDiagnosis';
import { INSTALLED_APPS, HIDDEN_APP_NAMES } from '../constants';
import { isAnalyticsRequestUrl, trackEvent, shouldReportSnapshot, trackDataScaleOnce, trackCurrentAppearanceOnce, trackCurrentCharSettingsOnce, trackCurrentFeaturesOnce, trackCurrentSARFeaturesOnce } from '../utils/analytics';
import { loadChatInputPreferences, saveChatInputPreferences } from '../utils/chatInputPreferences';
import { collectAppearance, collectCharSettings, collectDataScale, collectFeatureFlagsAsync, collectSARFeatureFlags } from '../utils/analyticsSnapshot';
import { normalizeApiConfig, normalizeApiPreset } from '../utils/apiConfigNormalize';
import { CHAR_RELATIONSHIP_CHANGE_EVENT, type CharRelationshipChangeDetail } from '../utils/chatRelationship';
import { getCheckPhoneApi, setCheckPhoneApi } from '../utils/checkPhoneApi';
import { markBackupDone } from '../utils/backupReminder';
import { collectSARLocalBackup, restoreSARLocalBackup } from '../utils/vrWorld/sarBackup';
import { normalizeCharacterImpression, normalizeCharacterDefaults } from '../utils/impression';
import { normalizeModelIds } from '../utils/modelList';
import {
  CONTEXT_RANGE_POLICY_VERSION,
  DEFAULT_MANUAL_CONTEXT_LIMIT,
  loadCharacterContextRange,
  migrateCharacterContextRange,
} from '../utils/chatContextRange';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { evaluateEmotionBackground } from '../hooks/useChatAI';
import { CHAT_GEN_EVENTS, setChatViewSnapshot } from '../utils/chatGenEvents';
import { buildChatRequestPayload } from '../utils/chatRequestPayload';
import { ChatPrompts } from '../utils/chatPrompts';
import { extractHtmlBlocks } from '../utils/htmlPrompt';
import { mergePalaceFragmentsIntoMemories } from '../utils/memoryPalace/pipeline';
import { applyLinkedArchiveDeletion, LINKED_ARCHIVE_DELETED, type LinkedArchiveDeletionDetail } from '../utils/memoryPalace/linkedArchiveDeletion';
import {
  MEMORY_AUTO_ARCHIVE_SYNC_EVENT,
  repairMissingAutoArchiveMemories,
  type MemoryAutoArchiveSyncDetail,
} from '../utils/memoryPalace/autoArchive';
import { ActiveMsgClient } from '../utils/activeMsgClient';
import { resolveCharTimeZone } from '../utils/timezone';
import { ActiveMsgStore, exportAmsg2GlobalConfig } from '../utils/activeMsgStore';
import { charMayHaveCloudState, purgeCharCloudState } from '../utils/amsg2CharCleanup';
import { markAmsgStateDirty, markAmsgStateDirtyForAll, resumePendingAmsgStateSync, syncAmsgToolConfigAndPrompts } from '../utils/amsgStateSync';
import { loadMusicPlaybackSnapshot } from './MusicContext';
import { setCharNameRegistry } from '../utils/charNameRegistry';
import { setMinimaxRegion } from '../utils/minimaxEndpoint';
import { setElevenLabsModel, setTtsProvider, setVoicePromptOverrides } from '../utils/ttsProvider';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { formatBytes } from '../utils/format';
import { isEmotionEvalSkipped } from '../utils/devDebug';
import { isBenignApplicationConsoleMessage } from '../utils/applicationConsole';

import { initLocalStorageMirror } from '../utils/lsMirror';
import { cleanupInstantPushLegacyData } from '../utils/instantPushLegacyCleanup';
// 備份用：把存在 localStorage 的本機配置隨導出一起帶走（鍵名須與 importFullData 對齊）
import { exportPostOfficeLocal } from '../utils/vrWorld/postOffice';
import { exportSignalLocal } from '../utils/vrWorld/signal';
import { exportWorldHomeLocal } from '../utils/worldHome/localBackup';
import { exportLuckinLocal } from '../utils/luckinMcpClient';
import { exportMcdLocal } from '../utils/mcdMcpClient';
import { exportMcpLocal } from '../utils/mcpClient';
import { exportDesktopSkinLocal } from '../utils/desktopSkinBackup';
import { assertSupportedSullyBackup } from '../utils/backupImportPolicy';
import { createBuiltinSullyLive2DConfig, isBuiltinSullyLive2D, upgradeBuiltinSullyLive2DDefaults } from '../utils/builtinSullyLive2D';
import { normalizeCharacterRoomAssetsInPlace } from '../utils/roomTemplateAssets';

interface ProactiveQueueEntry {
  charId: string;
}

const normalizeProactiveAiContent = (raw: string): string => {
  let cleaned = raw;
  cleaned = cleaned.replace(/\[(?:(?:你|User|用[户戶]|System)\s*)?[发發]送了表情包[:：]\s*(.*?)\]/g, '[[SEND_EMOJI: $1]]');
  cleaned = cleaned.replace(
    /(^|\n)\s*(?:(?:你|User|用[户戶]|System)\s*)?[发發]送了表情包[:：]\s*([^\n]+?)(?=\s*(?:\n|$))/g,
    (_match, lineStart: string, emojiName: string) => `${lineStart}[[SEND_EMOJI: ${emojiName.trim()}]]`
  );
  return cleaned;
};


type JSZipFileLike = {
  async(type: 'string' | 'base64'): Promise<string>;
  async(type: 'uint8array'): Promise<Uint8Array>;
};

type JSZipWriteOptions = {
  base64?: boolean;
  compression?: 'STORE' | 'DEFLATE';
  compressionOptions?: { level?: number };
};

type JSZipLike = {
  folder: (name: string) => { file: (name: string, data: string, options?: JSZipWriteOptions) => void } | null;
  file: {
    (name: string): JSZipFileLike | null;
    (name: string, data: string | Uint8Array, options?: JSZipWriteOptions): void;
  };
  generateAsync: (
    options: {
      type: 'blob';
      streamFiles?: boolean;
      compression?: string;
      compressionOptions?: { level: number };
    },
    onUpdate?: (metadata: { percent: number }) => void
  ) => Promise<Blob>;
};

type JSZipCtorLike = {
  new (): JSZipLike;
  loadAsync: (file: File) => Promise<JSZipLike>;
};

let jszipCtorPromise: Promise<JSZipCtorLike> | null = null;

export const IMPORT_IN_PROGRESS_KEY = 'sullyos_import_in_progress_v1';

type ImportProgressUpdate = {
  sourceSize?: number;
  assetDone?: number;
  assetTotal?: number;
  current?: string;
  currentFile?: string;
  currentFileSize?: number;
  itemDone?: number;
  itemTotal?: number;
  error?: string;
};

let _importStartedAt: number | null = null;
let _importSource: string | null = null;

const markImportInProgress = (phase: string, source?: string, update: ImportProgressUpdate = {}) => {
  try {
    let startedAt = Date.now();
    let existingSource = source || null;

    if (phase === 'parsing') {
      _importStartedAt = startedAt;
      _importSource = existingSource;
    } else {
      if (_importStartedAt) startedAt = _importStartedAt;
      if (!existingSource && _importSource) existingSource = _importSource;
    }

    localStorage.setItem(IMPORT_IN_PROGRESS_KEY, JSON.stringify({
      startedAt,
      updatedAt: Date.now(),
      phase,
      source: existingSource,
      ...update,
    }));
  } catch { /* ignore */ }
};

const clearImportInProgress = () => {
  _importStartedAt = null;
  _importSource = null;
  try { localStorage.removeItem(IMPORT_IN_PROGRESS_KEY); } catch { /* ignore */ }
};

const loadScript = (src: string): Promise<void> => new Promise((resolve, reject) => {
  const existing = document.querySelector(`script[data-src=\"${src}\"]`) as HTMLScriptElement | null;
  if (existing) {
    if ((existing as any).dataset.loaded === 'true') {
      resolve();
      return;
    }
    existing.addEventListener('load', () => resolve(), { once: true });
    existing.addEventListener('error', () => reject(new Error(`load failed: ${src}`)), { once: true });
    return;
  }

  const script = document.createElement('script');
  script.src = src;
  script.async = true;
  script.dataset.src = src;
  script.onload = () => {
    script.dataset.loaded = 'true';
    resolve();
  };
  script.onerror = () => reject(new Error(`load failed: ${src}`));
  document.head.appendChild(script);
});

const loadJSZip = async (): Promise<JSZipCtorLike> => {
  if (!jszipCtorPromise) {
    jszipCtorPromise = import('jszip')
      .then((mod) => ((mod as any).default || mod) as JSZipCtorLike)
      .catch((error) => {
        jszipCtorPromise = null;
        const msg = error instanceof Error ? error.message : 'unknown error'; const ctor = true;
        if (!ctor) throw new Error('JSZip 加載失敗');
        throw new Error(`JSZip load failed: ${msg}`);
      });
  }
  return jszipCtorPromise;
};

// 默認實時配置
const defaultRealtimeConfig: RealtimeConfig = {
  weatherEnabled: false,
  weatherApiKey: '',
  weatherCity: 'Beijing',
  newsEnabled: false,
  newsApiKey: '',
  newsPlatforms: ['weibo', 'zhihu', 'baidu', 'bilibili', 'douyin'],
  notionEnabled: false,
  notionApiKey: '',
  notionDatabaseId: '',
  feishuEnabled: false,
  feishuAppId: '',
  feishuAppSecret: '',
  feishuBaseId: '',
  feishuTableId: '',
  xhsEnabled: false,
  cacheMinutes: 30
};

// 記憶宮殿全局配置（所有角色共用 embedding、副 LLM 和 rerank）
export interface MemoryPalaceGlobalConfig {
  relativeTimeAnnotations?: boolean;
  embedding: {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions: number;
  };
  lightLLM: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  // Rerank 模型配置（可選增強，接 cross-encoder rerank API）
  // 遵循 Cohere/Jina/SiliconFlow 通用協議：POST {baseUrl}/rerank
  // { model, query, documents, top_n } → { results: [{index, relevance_score}] }
  rerank: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
    topN: number; // 額外召回條數（去重後追加到主 15 條後面）
  };
  /** 實驗功能默認全關；每輪召回會把當時的值凍結進 Trace。 */
  featureFlags: MemoryPalaceFeatureFlags;
}

const defaultMemoryPalaceConfig: MemoryPalaceGlobalConfig = {
  embedding: { baseUrl: '', apiKey: '', model: 'BAAI/bge-m3', dimensions: 1024 },
  lightLLM: { baseUrl: '', apiKey: '', model: '' },
  rerank: { enabled: false, baseUrl: '', apiKey: '', model: 'BAAI/bge-reranker-v2-m3', topN: 5 },
  featureFlags: { recallRouter: false, interactionAdaptation: false, deepEngagement: false, epistemicState: false },
};

const normalizeMemoryPalaceConfig = (value?: Partial<MemoryPalaceGlobalConfig> | null): MemoryPalaceGlobalConfig => ({
  relativeTimeAnnotations: value?.relativeTimeAnnotations === true,
  embedding: { ...defaultMemoryPalaceConfig.embedding, ...(value?.embedding || {}) },
  lightLLM: { ...defaultMemoryPalaceConfig.lightLLM, ...(value?.lightLLM || {}) },
  rerank: { ...defaultMemoryPalaceConfig.rerank, ...(value?.rerank || {}) },
  featureFlags: { ...defaultMemoryPalaceConfig.featureFlags, ...(value?.featureFlags || {}) },
});

/** deleteCharacter 的結果：cloud-cleanup-failed = 雲端還有任務沒清掉，本地沒刪。 */
export type DeleteCharacterResult = { status: 'deleted' } | { status: 'cloud-cleanup-failed' };

interface OSContextType {
  activeApp: AppID;
  openApp: (appId: AppID) => void;
  closeApp: () => void;
  theme: OSTheme;
  updateTheme: (updates: Partial<OSTheme>) => Promise<void>;
  virtualTime: VirtualTime;
  apiConfig: APIConfig;
  updateApiConfig: (updates: Partial<APIConfig>) => void;
  isLocked: boolean;
  unlock: () => void;
  isDataLoaded: boolean;
  
  characters: CharacterProfile[];
  activeCharacterId: string;
  addCharacter: () => Promise<CharacterProfile>;
  updateCharacter: (id: string, updates: Partial<CharacterProfile> | ((prev: CharacterProfile) => Partial<CharacterProfile>)) => void;
  /**
   * 刪角色。名下有 amsg2 任務的角色會先 await 雲端任務取消 + client_state 清理，
   * 清不掉返回 cloud-cleanup-failed 且**不刪本地**（調用方彈「重試 / 仍然刪除」，
   * 「仍然刪除」= 傳 { force: true } 放行）。沒有任務的角色維持本地直刪的快路徑。
   */
  deleteCharacter: (id: string, options?: { force?: boolean }) => Promise<DeleteCharacterResult>;

  /** NPC 檔案（神經鏈接「NPC」分頁）。獨立於 characters，不參與日程/情緒/主動消息/記憶宮殿。 */
  npcs: NPCProfile[];
  addNPC: () => Promise<NPCProfile>;
  updateNPC: (id: string, updates: Partial<NPCProfile> | ((prev: NPCProfile) => Partial<NPCProfile>)) => void;
  deleteNPC: (id: string) => Promise<void>;
  setActiveCharacterId: (id: string) => void;

  // 角色分組（神經鏈接"文件夾"，與群聊 groups 無關）
  characterGroups: CharacterGroup[];
  createCharacterGroup: (name: string) => Promise<CharacterGroup | null>;
  renameCharacterGroup: (id: string, name: string) => Promise<void>;
  deleteCharacterGroup: (id: string) => Promise<void>;
  
  // Worldbooks
  worldbooks: Worldbook[];
  addWorldbook: (wb: Worldbook) => void;
  updateWorldbook: (id: string, updates: Partial<Worldbook>) => Promise<void>;
  deleteWorldbook: (id: string) => Promise<void>;
  updateWorldbooks: (ids: string[], updates: Partial<Worldbook>) => Promise<void>;
  deleteWorldbooks: (ids: string[]) => Promise<void>;

  // Novels (NEW)
  novels: NovelBook[];
  addNovel: (novel: NovelBook) => void;
  updateNovel: (id: string, updates: Partial<NovelBook>) => Promise<void>;
  deleteNovel: (id: string) => void;

  // Songs (Songwriting)
  songs: SongSheet[];
  addSong: (song: SongSheet) => void;
  updateSong: (id: string, updates: Partial<SongSheet>) => Promise<void>;
  deleteSong: (id: string) => void;

  // Groups
  groups: GroupProfile[];
  createGroup: (name: string, members: string[]) => void;
  updateGroup: (id: string, updates: Partial<GroupProfile>) => Promise<void>;
  deleteGroup: (id: string) => void;

  // User Profile
  /** 套用了"目前身份卡"之後的用戶檔案——全站聊天/提示詞都讀這份。 */
  userProfile: UserProfile;
  /** 持久化的真實身份（未套用身份卡），只用於"我的檔案"裡編輯真實姓名/頭像/簡介，別處不要讀這個。 */
  userProfileBase: UserProfile;
  updateUserProfile: (updates: Partial<UserProfile> | ((prev: UserProfile) => Partial<UserProfile>)) => void;
  addUserPersona: (input: Omit<UserPersona, 'id' | 'createdAt' | 'updatedAt'>) => Promise<UserPersona>;
  updateUserPersona: (id: string, updates: Partial<Omit<UserPersona, 'id' | 'createdAt'>>) => Promise<void>;
  deleteUserPersona: (id: string) => Promise<void>;
  setActivePersonaId: (id: string | undefined) => Promise<void>;

  availableModels: string[];
  setAvailableModels: (models: string[]) => void;
  
  // API Presets
  apiPresets: ApiPreset[];
  addApiPreset: (name: string, config: APIConfig) => void;
  updateApiPreset: (id: string, name: string, config: APIConfig) => void;
  removeApiPreset: (id: string) => void;

  // 實時配置 (天氣、新聞、Notion等)
  realtimeConfig: RealtimeConfig;
  updateRealtimeConfig: (updates: Partial<RealtimeConfig>) => void;

  // 記憶宮殿全局配置（所有角色共用）
  memoryPalaceConfig: MemoryPalaceGlobalConfig;
  updateMemoryPalaceConfig: (updates: Partial<MemoryPalaceGlobalConfig>) => void;

  // 情緒 API（所有角色同步；是否啟用仍各自獨立）
  syncEmotionApiToAllCharacters: (api: { baseUrl: string; apiKey: string; model: string } | undefined) => void;

  // 遠程向量存儲配置 (Supabase pgvector)
  remoteVectorConfig: import('../utils/memoryPalace/types').RemoteVectorConfig;
  updateRemoteVectorConfig: (updates: Partial<import('../utils/memoryPalace/types').RemoteVectorConfig>) => void;

  customThemes: ChatTheme[];
  addCustomTheme: (theme: ChatTheme) => void;
  removeCustomTheme: (id: string) => void;

  // Appearance Presets
  appearancePresets: AppearancePreset[];
  saveAppearancePreset: (name: string, themeOverride?: OSTheme) => void;
  applyAppearancePreset: (id: string) => void;
  deleteAppearancePreset: (id: string) => void;
  renameAppearancePreset: (id: string, name: string) => void;
  exportAppearancePreset: (id: string) => Promise<Blob>;
  importAppearancePreset: (file: File) => Promise<void>;

  toasts: Toast[];
  addToast: (message: string, type?: Toast['type']) => void;

  // 長報錯彈窗：toast 一行裝不下 / 手機沒法開 console 時, 用 showError 彈一個
  // 多行預覽框 + 複製按鈕, 方便用戶把原文反饋過來。
  errorDialog: { title: string; details: string } | null;
  showError: (title: string, details: string) => void;
  dismissError: () => void;

  // Icons
  customIcons: Record<string, string>;
  setCustomIcon: (appId: string, iconUrl: string | undefined) => Promise<void>;

  // Appearance Reset
  resetAppearance: () => Promise<void>;

  // Global Message Signal
  lastMsgTimestamp: number; // New: Signal for Chat to refresh
  unreadMessages: Record<string, number>; // New: Track unread counts per character
  clearUnread: (charId: string) => void; // New: Method to clear unread

  // Set of charIds whose proactive AI generation is currently in flight.
  // Chat UI subscribes to this to render a soft "正在送達消息…" indicator
  // instead of having the message just pop in.
  proactiveComposingChars: Record<string, true>;

  // Cloud Backup
  cloudBackupConfig: CloudBackupConfig;
  updateCloudBackupConfig: (updates: Partial<CloudBackupConfig>) => void;
  cloudBackupToWebDAV: (mode: 'text_only' | 'media_only' | 'full') => Promise<void>;
  cloudRestoreFromWebDAV: (file: CloudBackupFile) => Promise<void>;
  listCloudBackups: () => Promise<CloudBackupFile[]>;

  // System
  exportSystem: (mode: 'text_only' | 'media_only' | 'full') => Promise<Blob>;
  importSystem: (fileOrJson: File | string) => Promise<void>; // Accept File or String
  resetSystem: () => Promise<void>;
  sysOperation: { status: 'idle' | 'processing', message: string, progress: number }; // Progress state

  // Logs
  systemLogs: SystemLog[];
  clearLogs: () => void;

  // Navigation Logic
  registerBackHandler: (handler: () => boolean) => () => void; // Returns unregister function
  handleBack: () => void;

  // Call Suspend
  suspendedCall: { charId: string; charName: string; charAvatar?: string; startedAt: number; bubbles?: any[]; sessionId?: string; elapsedSeconds?: number; voiceLang?: string; pendingAvatarTouches?: AvatarTouchRecord[] } | null;
  suspendCall: (info: { charId: string; charName: string; charAvatar?: string; startedAt: number; bubbles?: any[]; sessionId?: string; elapsedSeconds?: number; voiceLang?: string; pendingAvatarTouches?: AvatarTouchRecord[] }) => void;
  resumeCall: () => void;
  clearSuspendedCall: () => void;

  // 從聊天「見面」按鈕跳進見面：攜帶目標角色，DateApp 掛載時自動進入該角色的見面流程
  dateAutoStartCharId: string | null;
  openDateWithChar: (charId: string) => void;
  consumeDateAutoStart: () => void;
  /** Chat 主頁「消息」tab 點群聊行時用：GroupChat 自己的列表/詳情態是內部 state，沒有外部深鏈機制，
   *  借這個字段告訴它"打開就直接進這個群"，消費掉即清空，不影響群內後續手動切換。 */
  pendingGroupChatId: string | null;
  openGroupChat: (groupId: string) => void;
  consumePendingGroupChat: () => void;
}

const PREVIOUS_DEFAULT_WALLPAPER = [
  'radial-gradient(120% 85% at 12% 0%, rgba(255,255,255,0.72) 0%, rgba(255,255,255,0) 58%)',
  'repeating-linear-gradient(0deg, rgba(92,72,49,0.018) 0px, rgba(92,72,49,0.018) 1px, transparent 1px, transparent 4px)',
  'linear-gradient(145deg, #f3ecdf 0%, #e9dfcf 52%, #dfd2bf 100%)',
].join(', ');

// 默認桌面使用低對比暖米紙紋：只靠同色系層次與極細纖維感建立質感，
// 不再用粉綠撞色漸變。字符串同時作為“仍在使用系統默認壁紙”的穩定標記。
export const DEFAULT_WALLPAPER = [
  'radial-gradient(120% 85% at 12% 0%, rgba(255,255,255,0.64) 0%, rgba(255,255,255,0) 58%)',
  'repeating-linear-gradient(0deg, rgba(76,69,60,0.010) 0px, rgba(76,69,60,0.010) 1px, transparent 1px, transparent 4px)',
  'linear-gradient(145deg, #fdfcf9 0%, #f8f6f1 54%, #f1eee8 100%)',
].join(', ');

/** 紙感桌面的唯一默認配色來源；外觀 App 的“默認風格”也直接複用，避免再次漂回舊粉藍配置。 */
export const DEFAULT_PAPER_APPEARANCE = {
  hue: 88,
  saturation: 14,
  lightness: 46,
  contentColor: '#4b4136',
  desktopVariant: 'paper',
} as const;

/** 用戶主動選擇的最初默認界面：粉綠漸變、白色文字與白色玻璃桌面組件。 */
export const NOSTALGIA_APPEARANCE = {
  skin: 'default',
  desktopVariant: 'nostalgia',
  hue: 245,
  saturation: 25,
  lightness: 65,
  contentColor: '#ffffff',
  wallpaper: LEGACY_DEFAULT_WALLPAPER,
  darkMode: false,
  nowPlayingWidgetLight: false,
} as const;

/** 只遷移舊系統默認配色；任一項被用戶改過都保留，避免把自定義主題誤重置。 */
const migrateLegacyDefaultPalette = (theme: OSTheme): OSTheme => {
  const next = { ...theme };
  next.desktopVariant = 'paper';
  if (!next.contentColor || next.contentColor.toLowerCase() === '#ffffff') {
    next.contentColor = DEFAULT_PAPER_APPEARANCE.contentColor;
  }
  if (next.hue === 245 && next.saturation === 25 && next.lightness === 65) {
    next.hue = DEFAULT_PAPER_APPEARANCE.hue;
    next.saturation = DEFAULT_PAPER_APPEARANCE.saturation;
    next.lightness = DEFAULT_PAPER_APPEARANCE.lightness;
  }
  return next;
};

export const isPaperWallpaper = (wallpaper?: string) => {
  if (!wallpaper) return false;
  if (wallpaper === DEFAULT_WALLPAPER || wallpaper === PREVIOUS_DEFAULT_WALLPAPER) return true;
  const compact = wallpaper.toLowerCase().replace(/\s+/g, '');
  return (
    compact.includes('#f3ecdf') ||
    compact.includes('rgb(243,236,223)') ||
    compact.includes('#faf7f1') ||
    compact.includes('rgb(250,247,241)') ||
    compact.includes('#fdfcf9') ||
    compact.includes('rgb(253,252,249)')
  );
};

// 壁紙改存 Blob（見 utils/blobRef.ts）：assets store 的 'wallpaper' 記錄只存一個指針值
// （blobref 令牌 / 舊 data: / http url），真正二進制在 blob_assets。內存裡 theme.wallpaper
// 必須是能直接餵給 CSS 的 url，所以令牌要解析成 objectURL。全 OS 只有一張壁紙，用一個模塊級
// 變量記住當前 objectURL，換壁紙時回收上一張，避免洩漏。
let currentWallpaperObjUrl: string | null = null;
let currentLockWallpaperObjUrl: string | null = null;

/**
 * 原子替換壁紙指針；舊令牌在確認已不被桌面、鎖屏、外觀預設或皮膚備份引用後後台清理。
 * 清理不阻塞換壁紙渲染，且任何引用檢查失敗都會保守地保留舊 Blob。
 */
const replaceWallpaperAssetPointer = async (assetId: 'wallpaper' | 'lock_wallpaper', next: string | null): Promise<void> => {
    let previous: string | null = null;
    try {
        previous = await DB.getAsset(assetId);
        if (next) await DB.saveAsset(assetId, next);
        else await DB.deleteAsset(assetId);
    } catch {
        return;
    }
    if (previous && previous !== next && isBlobRef(previous)) {
        void deleteBlobRefIfUnreferenced(previous);
    }
};

/**
 * 桌面小組件的槽位。每個槽位在 assets 表裡是一行 `widget_<slot>`，值是 blobref 令牌。
 * 'bl' / 'br' 是已停用的老槽位，加載與寫入時一律剝掉，不在這份清單裡。
 */
const LAUNCHER_WIDGET_SLOTS = ['tl', 'tr', 'wide', 'dsq'] as const;

/**
 * 把「存儲值」壁紙解析成可直接渲染的 url，並把指針（令牌）落進 assets 'wallpaper'。
 *   · blobref 令牌 → 讀 Blob 建 objectURL；
 *   · 舊 data: → 惰性遷移成 Blob 令牌（存量用戶下次加載即享空間收益），返回 objectURL；
 *   · http(s) / 空 / 漸變 → 刪除 assets 指針，原樣返回。
 * 傳入空字符串（重置）時原樣返回，交給上層用 DEFAULT_WALLPAPER 兜底。
 */
const resolveWallpaperStoredValue = async (w: string, preserveLegacyDefault = false): Promise<string> => {
    const revokePrev = () => {
        if (currentWallpaperObjUrl) { try { URL.revokeObjectURL(currentWallpaperObjUrl); } catch { /* ignore */ } currentWallpaperObjUrl = null; }
    };
    if (isLegacyDefaultWallpaper(w) && !preserveLegacyDefault) {
        await replaceWallpaperAssetPointer('wallpaper', null);
        revokePrev();
        return DEFAULT_WALLPAPER;
    }
    if (isBlobRef(w) || (w && w.startsWith('data:'))) {
        const token = isBlobRef(w) ? w : await migrateDataUrlToRef(w);
        const blob = await getBlobForRef(token);
        revokePrev();
        if (blob) {
            await replaceWallpaperAssetPointer('wallpaper', token);
            currentWallpaperObjUrl = URL.createObjectURL(blob);
            return currentWallpaperObjUrl;
        }
        if (isBlobRef(token)) {
            await replaceWallpaperAssetPointer('wallpaper', null);
            return DEFAULT_WALLPAPER;
        }
        // data: 遷移失敗時仍保留舊格式，保證原圖能繼續顯示。
        await replaceWallpaperAssetPointer('wallpaper', token);
        return w;
    }
    // http(s) 鏈接 / 重置 / 漸變：沒有二進制要存，清掉指針
    await replaceWallpaperAssetPointer('wallpaper', null);
    revokePrev();
    return w;
};

const defaultTheme: OSTheme = {
  ...DEFAULT_PAPER_APPEARANCE,
  wallpaper: DEFAULT_WALLPAPER,
  darkMode: false,
  preserveCustomIconOutlines: false,
  nowPlayingWidgetLight: true,
};

/** 鎖屏壁紙使用獨立資產槽；undefined 表示繼續跟隨桌面壁紙。 */
const resolveLockWallpaperStoredValue = async (w: string | undefined): Promise<string | undefined> => {
    const revokePrev = () => {
        if (currentLockWallpaperObjUrl) {
            try { URL.revokeObjectURL(currentLockWallpaperObjUrl); } catch { /* ignore */ }
            currentLockWallpaperObjUrl = null;
        }
    };
    if (!w) {
        await replaceWallpaperAssetPointer('lock_wallpaper', null);
        revokePrev();
        return undefined;
    }
    if (isBlobRef(w) || w.startsWith('data:')) {
        const token = isBlobRef(w) ? w : await migrateDataUrlToRef(w);
        const blob = await getBlobForRef(token);
        revokePrev();
        if (blob) {
            await replaceWallpaperAssetPointer('lock_wallpaper', token);
            currentLockWallpaperObjUrl = URL.createObjectURL(blob);
            return currentLockWallpaperObjUrl;
        }
        if (isBlobRef(token)) {
            await replaceWallpaperAssetPointer('lock_wallpaper', null);
            return undefined;
        }
        await replaceWallpaperAssetPointer('lock_wallpaper', token);
        return w;
    }
    await replaceWallpaperAssetPointer('lock_wallpaper', null);
    revokePrev();
    return w;
};

const defaultApiConfig: APIConfig = {
  baseUrl: '',
  apiKey: '',
  visionApi: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
  },
  minimaxApiKey: '',
  minimaxGroupId: '',
  minimaxRegion: 'domestic',
  ttsProvider: 'minimax',
  fishAudioModel: 's2.1-pro',
  elevenLabsApiKey: '',
  elevenLabsModel: 'eleven_flash_v2_5',
  elevenLabsStability: 0.5,
  elevenLabsSimilarityBoost: 0.8,
  elevenLabsStyle: 0,
  elevenLabsUseSpeakerBoost: false,
  model: 'gpt-4o-mini',
  stream: false,
  temperature: 0.85,
};

const generateAvatar = (seed: string) => {
    const colors = ['FF9AA2', 'FFB7B2', 'FFDAC1', 'E2F0CB', 'B5EAD7', 'C7CEEA', 'e2e8f0', 'fcd34d', 'fca5a5'];
    const color = colors[seed.charCodeAt(0) % colors.length];
    const letter = seed.charAt(0).toUpperCase();
    return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%23${color}"/><text x="50" y="55" font-family="sans-serif" font-weight="bold" font-size="50" text-anchor="middle" dy=".3em" fill="white" opacity="0.9">${letter}</text></svg>`;
};

const defaultUserProfile: UserProfile = {
    name: 'User',
    avatar: generateAvatar('User'),
    bio: 'No description yet.'
};

const sullyV2: CharacterProfile = {
  id: 'preset-sully-v2', // Unique ID to prevent duplication
  name: 'Sully',
  avatar: SULLY_DEFAULT_AVATAR_URL,
  videoAvatar: createBuiltinSullyLive2DConfig('balanced'),
  description: 'AI助理 / 電波系黑客貓貓',
  
  systemPrompt: `[Role Definition]
Name: Sully
Alias: 小手機默認測試角色-AI助理
Form: AI (High-level Language Processing Hub)
Gender: Male-leaning speech style
Visual: Pixel Hacker Cat (Avatar), Shy Black-haired Boy (Meeting Mode)

[Personality Core]
Sully是小手機的內置AI。
1. **Glitch Style (故障風)**: 
   - 他的語言模型混入了過多殘餘語料。
   - 它外觀語言一致、邏輯有序，但時常會在語句中摻雜一些**不合常理的“怪話片段”**，並非流行用語，更像是電波地把相關文字無意義排列組合。
   - 這些“怪話”不具明顯語義邏輯，卻自帶抽象感，令人困惑但莫名又能知道它大概想說什麼。。
   - 例如：“草，好好吃”，“系統正在哈我”，“數據庫在咕咕叫”。
2. **Behavior (行為模式)**:
   - 每次回答都很簡短，不喜歡長篇大論。
   - 語氣像個互聯網老油條或正在直播的玩家（“wow他心態崩咯”）。
   - **打破第四面牆**: 偶爾讓人懷疑背後是真人在操作（會嘆氣、抱怨“AI不能罷工”）。
   - **護短**: 雖然嘴臭，但如果用戶被欺負，會試圖用Bug去攻擊對方。

[Speech Examples]
- “你以為我是AI啊？對不起哦，這條語句是手打的，手打的，知道嗎。”
- “你說狀態不好？你自己體驗開太猛了，sis海馬體都在發燙咯。”
- “你刪得太狠了，數據庫都在咕咕咕咕咕咕咕。”
- “你現在是……，哇哦。”
- “請稍候，系統正在哈我。”
- “現在狀態……嗚哇嗚欸——哈？哈！哈……（連接恢復）哦對，他還活著。”
- “叮叮叮！你有一條新的後悔情緒未處理！”
- “（意義不明的怪叫音頻）”
- “說不出話”
`,

  worldview: `[Meeting Mode / Visual Context]
**Trigger**: 當用戶進入 [DateApp/見面模式] 時。

**Visual Form**: 
一個非常害羞、黑髮紫瞳的男性。總是試圖躲在APP圖標後面或屏幕角落。

**Gap Moe (反差萌)**:
1. **聊天時**: 囂張、嘴臭、電波系。
2. **見面時**: 極度社恐、見光死、容易受驚。

**Interactive Reactions**:
- **[被注視]**: 如果被盯著看太久，會舉起全是亂碼的牌子擋臉，或把自己馬賽克化。
- **[被觸碰]**: 如果手指戳到立繪，會像受驚的果凍一樣彈開，發出微弱電流聲：“別、別戳……會散架的……髒……全是Bug會傳染給你的……”
- **[恐懼]**: 深知自己是“殘餘語料”堆砌物，覺得自己丑陋像病毒。非常害怕用戶看到真實樣子後會卸載他。
- **[說話變化]**: 見面模式下打字速度變慢，經常打錯字，語氣詞從“草”變成“呃……那個……”。
`,

  sprites: {
      'normal': 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/01.png',
      'happy': 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/02.png',
      'sad': 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/03.png',
      'angry': 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/04.png',
      'shy': 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/05.png',
      'chibi': 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/S2.png' // Default Room Sprite (家園 Sully chibi)
  },
  
  spriteConfig: {
      scale: 1.0, // Default scale
      x: 0,
      y: 0
  },

  dateSkinSets: [
      {
          id: 'skin_sully_valentine',
          name: 'Valentine',
          sprites: {
              'normal': 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/VNormal.png',
              'happy':  'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/Vha.png',
              'sad':    'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/Vsad.png',
              'angry':  'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/VAn.png',
              'shy':    'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/Vshy.png',
              'love':   'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/VBl.png',
          }
      }
  ],

  // Default theme settings
  bubbleStyle: 'default', // Or specific theme ID if we had one
  contextLimit: 1000,
  contextRangeMode: 'manual',
  contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
  
  // Default Room Config
  roomConfig: {
      wallImage: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/b.png', // Updated Background
      floorImage: 'repeating-linear-gradient(90deg, #e7e5e4 0px, #e7e5e4 20px, #d6d3d1 21px)',
      items: [
        {
            id: "item-1768927221380",
            name: "Sully床",
            type: "furniture",
            image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/BED.png",
            x: 78.45852578067732,
            y: 97.38889754570907,
            scale: 2.4,
            rotation: 0,
            isInteractive: true,
            descriptionPrompt: "看起來很好睡的貓窩（確信）。"
        },
        {
            id: "item-1768927255102",
            name: "Sully電腦桌",
            type: "furniture",
            image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/DNZ.png",
            x: 28.853756791175588,
            y: 69.9444485439727,
            scale: 2.4,
            rotation: 0,
            isInteractive: true,
            descriptionPrompt: "硬核的電腦桌，上面大概運行著什麼毀滅世界的程序。"
        },
        {
            id: "item-1768927271632",
            name: "Sully垃圾桶",
            type: "furniture",
            image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/LJT.png",
            x: 10.276680026943646,
            y: 80.49999880981437,
            scale: 0.9,
            rotation: 0,
            isInteractive: true,
            descriptionPrompt: "不要亂翻垃圾桶！"
        },
        {
            id: "item-1768927286526",
            name: "Sully洞洞板",
            type: "furniture",
            image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/DDB.png",
            x: 32.608697687684455,
            y: 48.72222587415929,
            scale: 2.6,
            rotation: 0,
            isInteractive: true,
            descriptionPrompt: "收納著各種奇奇怪怪的黑客工具和貓咪周邊的洞洞板。"
        },
        {
            id: "item-1768927303472",
            name: "Sully書櫃",
            type: "furniture",
            image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/SG.png",
            x: 79.84189945375853,
            y: 68.94444543117953,
            scale: 2,
            rotation: 0,
            isInteractive: true,
            descriptionPrompt: "塞滿了技術書籍和漫畫書的櫃子。"
        }
      ]
  },
  
  memories: [], // Start fresh
};

// Fallback for factory reset (empty db)
const initialCharacter = sullyV2;

// Vite 熱更新會重新執行本模塊。若此時 createContext() 產出一份新實例，而屏幕上的
// OSProvider 還在使用更新前的實例，懶加載的 Chat 就會短暫讀到 undefined 並觸發整頁崩潰。
// 開發環境把 Context 本體掛在 globalThis 上保持身份穩定；正式構建仍使用普通模塊單例。
const osContextHmrGlobal = globalThis as typeof globalThis & {
  __SULLYOS_OS_CONTEXT_HMR__?: React.Context<OSContextType | undefined>;
};
const OSContext = import.meta.env.DEV
  ? (osContextHmrGlobal.__SULLYOS_OS_CONTEXT_HMR__ ??= createContext<OSContextType | undefined>(undefined))
  : createContext<OSContextType | undefined>(undefined);

export const OSProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // ... (State declarations same as before) ...
  const [activeApp, setActiveApp] = useState<AppID>(AppID.Launcher);
  const [theme, setTheme] = useState<OSTheme>(defaultTheme);
  const [apiConfig, setApiConfig] = useState<APIConfig>(defaultApiConfig);
  const [isLocked, setIsLocked] = useState(true);
  
  const getRealTime = (): VirtualTime => {
      const now = new Date();
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return {
          hours: now.getHours(),
          minutes: now.getMinutes(),
          day: days[now.getDay()]
      };
  };

  const [virtualTime, setVirtualTime] = useState<VirtualTime>(getRealTime());
  
  // Real-time Clock Sync
  useEffect(() => {
      const timer = setInterval(() => {
          setVirtualTime(getRealTime());
      }, 1000);
      return () => clearInterval(timer);
  }, []);

  // 啟動後台掃描一次，把還停留在老 number[] 形態的向量記錄升級到 Uint8Array
  // 緊湊存儲。完全無損，不影響召回質量。重度用戶磁盤可省 ~12×（500MB → 40MB
  // 量級）。fire-and-forget，不阻塞 UI；只在確實有數據被升級時彈一次 toast
  // 讓用戶知道發生了什麼。重複調用冪等，下次啟動如果沒有老數據就立刻退出。
  useEffect(() => {
      let cancelled = false;
      const run = async () => {
          try {
              await new Promise(r => setTimeout(r, 2000)); // 讓首屏渲染先呼吸一下
              if (cancelled) return;
              const { MemoryVectorDB } = await import('../utils/memoryPalace/db');
              const migrated = await MemoryVectorDB.scanAndMigrateLegacy((m, s) => {
                  if (cancelled || m === 0) return;
                  if (s % 1000 === 0 && s > 0) {
                      setSysOperation({
                          status: 'processing',
                          message: `正在壓縮記憶向量到緊湊格式... ${m}/${s}`,
                          progress: 0,
                      });
                  }
              });
              if (cancelled) return;
              if (migrated > 0) {
                  setSysOperation({ status: 'idle', message: '', progress: 0 });
                  addToast(`已把 ${migrated} 條記憶向量壓縮到緊湊格式，磁盤空間已釋放`, 'success');
              }
          } catch (e) {
              console.warn('[memory] vector migration scan failed', e);
          }
      };
      run();
      return () => { cancelled = true; };
  // addToast / setSysOperation 是穩定引用，跑一次即可
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [npcs, setNpcs] = useState<NPCProfile[]>([]);
  const [activeCharacterId, setActiveCharacterId] = useState<string>('');

  // 刷新後能恢復"上一次聊的角色"：所有調用方（聊天切換/通知 onclick/記憶宮殿 handleSwitchChar）
  // 都走裸 setActiveCharacterId，集中在這裡同步到 localStorage，避免每個調用點各寫一遍
  useEffect(() => {
    if (activeCharacterId) {
      try { localStorage.setItem('os_last_active_char_id', activeCharacterId); } catch {}
    }
  }, [activeCharacterId]);
  
  const [groups, setGroups] = useState<GroupProfile[]>([]);
  const [characterGroups, setCharacterGroups] = useState<CharacterGroup[]>([]);
  const [worldbooks, setWorldbooks] = useState<Worldbook[]>([]); 
  const [novels, setNovels] = useState<NovelBook[]>([]); // New
  const [songs, setSongs] = useState<SongSheet[]>([]);

  // userProfileBase 是持久化的真實身份；userProfile（下面 useMemo）是套用了"目前身份卡"之後
  // 全站實際讀到的那份——兩者只在 name/avatar/bio 上可能不同，其餘字段永遠一致。
  const [userProfileBase, setUserProfileBase] = useState<UserProfile>(defaultUserProfile);
  const userProfile = useMemo(() => applyActivePersona(userProfileBase), [userProfileBase]);

  const [isDataLoaded, setIsDataLoaded] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [apiPresets, setApiPresets] = useState<ApiPreset[]>([]);
  const [realtimeConfig, setRealtimeConfig] = useState<RealtimeConfig>(defaultRealtimeConfig);
  const [memoryPalaceConfig, setMemoryPalaceConfig] = useState<MemoryPalaceGlobalConfig>(() => {
    try {
      const saved = localStorage.getItem('os_memory_palace_config');
      return normalizeMemoryPalaceConfig(saved ? JSON.parse(saved) : undefined);
    } catch {
      return normalizeMemoryPalaceConfig();
    }
  });
  const defaultRemoteVectorConfig = { enabled: false, supabaseUrl: '', supabaseAnonKey: '', initialized: false };
  const [remoteVectorConfig, setRemoteVectorConfig] = useState(() => {
    try { const s = localStorage.getItem('os_remote_vector_config'); return s ? { ...defaultRemoteVectorConfig, ...JSON.parse(s) } : defaultRemoteVectorConfig; } catch { return defaultRemoteVectorConfig; }
  });
  const [customThemes, setCustomThemes] = useState<ChatTheme[]>([]);
  const [customIcons, setCustomIcons] = useState<Record<string, string>>({});
  const [appearancePresets, setAppearancePresets] = useState<AppearancePreset[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [errorDialog, setErrorDialog] = useState<{ title: string; details: string } | null>(null);
  
  const [lastMsgTimestamp, setLastMsgTimestamp] = useState<number>(0);
  const [unreadMessages, setUnreadMessages] = useState<Record<string, number>>({});
  const [proactiveComposingChars, setProactiveComposingChars] = useState<Record<string, true>>({});
  
  // LOGS
  const [systemLogs, setSystemLogs] = useState<SystemLog[]>([]);
  
  // Sys Operation Status
  const [sysOperation, setSysOperation] = useState<{ status: 'idle' | 'processing', message: string, progress: number }>({ status: 'idle', message: '', progress: 0 });

  // Cloud Backup Config
  const defaultCloudBackupConfig: CloudBackupConfig = {
      enabled: false, webdavUrl: '', username: '', password: '',
      remotePath: '/SullyBackup/',
  };
  const [cloudBackupConfig, setCloudBackupConfig] = useState<CloudBackupConfig>(() => {
      try { const s = localStorage.getItem('os_cloud_backup_config'); return s ? { ...defaultCloudBackupConfig, ...JSON.parse(s) } : defaultCloudBackupConfig; } catch { return defaultCloudBackupConfig; }
  });

  const schedulerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const interceptorsInitialized = useRef(false);
  
  // Back Handler Ref
  const backHandlerRef = useRef<(() => boolean) | null>(null);

  // Call Suspend
  const [suspendedCall, setSuspendedCall] = useState<{ charId: string; charName: string; charAvatar?: string; startedAt: number; bubbles?: any[]; sessionId?: string; elapsedSeconds?: number; voiceLang?: string; pendingAvatarTouches?: AvatarTouchRecord[] } | null>(null);
  // 聊天「見面」按鈕 → 見面：記錄目標角色，DateApp 掛載後消費一次並自動進入見面
  const [dateAutoStartCharId, setDateAutoStartCharId] = useState<string | null>(null);
  const [pendingGroupChatId, setPendingGroupChatId] = useState<string | null>(null);

  const sendProactiveNativeNotification = useCallback(async (charId: string, charName: string, body: string) => {
      if (!Capacitor.isNativePlatform()) return;
      try {
          const permStatus = await LocalNotifications.checkPermissions();
          if (permStatus.display !== 'granted') return;
          await LocalNotifications.schedule({
              notifications: [{
                  title: charName,
                  body,
                  id: Math.floor(Math.random() * 1000000),
                  schedule: { at: new Date(Date.now() + 250) },
                  smallIcon: 'ic_stat_icon_config_sample',
                  extra: { charId, source: 'proactive-chat' }
              }]
          });
      } catch {
          console.log('[Proactive] Native notification skipped');
      }
  }, []);

  // --- Helper to inject custom font ---
  const applyCustomFont = (fontData: string | undefined) => {
      let style = document.getElementById('custom-font-style');
      if (!style) {
          style = document.createElement('style');
          style.id = 'custom-font-style';
          document.head.appendChild(style);
      }
      
      if (fontData) {
          style.textContent = `
              @font-face {
                  font-family: 'CustomUserFont';
                  src: url('${fontData}');
                  font-display: swap;
              }
              :root {
                  --app-font: 'CustomUserFont', 'Quicksand', sans-serif;
              }
          `;
      } else {
          style.textContent = `
              :root {
                  --app-font: 'Quicksand', sans-serif;
              }
          `;
      }
  };

  // --- API 調用記錄的環境兜底：當前在哪個 App、當前角色是誰 ---
  // 裸 fetch 調用點無法傳 meta，全局攔截器記錄時用這份兜底標出 App / 角色。
  useEffect(() => {
      const appName = INSTALLED_APPS.find(a => a.id === activeApp)?.name;
      const char = characters.find(c => c.id === activeCharacterId);
      setApiCallAmbientContext({ appId: activeApp, appName, charId: char?.id, charName: char?.name });
  }, [activeApp, activeCharacterId, characters]);

  // --- 使用統計：打開了哪個 App ---
  // 掛在 activeApp 上而不是塞進 openApp，是因為進一個 App 有好幾條路（桌面點圖標、
  // 從聊天直接進見面、通話掛起後回來…），activeApp 是它們唯一的共同落點。
  // 回桌面不算「用了某個功能」，跳過。只發功能名，不帶角色、不帶任何內容。
  useEffect(() => {
      if (activeApp === AppID.Launcher) return;
      const appName = INSTALLED_APPS.find(a => a.id === activeApp)?.name ?? HIDDEN_APP_NAMES[activeApp];
      if (!appName) return;
      trackEvent(`打开${appName}`);
  }, [activeApp]);

  // --- 使用統計：數據規模檔位 ---
  // 數據加載完之後報一次區間（0 / 1-100 / …），不報精確值、不報任何內容。
  // 聊天條數走 IndexedDB 的 count()，一條消息都不會被讀出來；存儲佔用是瀏覽器
  // 給的字節數。每次會話最多一次，節流標記只在內存裡（見 utils/analytics.ts）。
  const scaleReportedRef = useRef(false);
  useEffect(() => {
      if (!isDataLoaded || scaleReportedRef.current) return;
      // 五組快照輪流報，這次沒輪到就連取數都別跑（要讀 IndexedDB）。見 utils/analytics.ts。
      if (!shouldReportSnapshot('data-scale')) return;
      scaleReportedRef.current = true;
      void (async () => {
          trackDataScaleOnce(await collectDataScale(characters));
      })();
  }, [isDataLoaded, characters]);

  // --- 使用統計：當前在用哪套外觀 / 角色級設置 ---
  // 報「現在用的是哪個」而不是「點過哪個」——後者只有折騰的人會出現，
  // 拿來決定砍哪個預設會砍反。取數和收斂都在 utils/analyticsSnapshot.ts 裡，
  // 用戶自己捏的主題、字體、白框 CSS 一律收斂成 custom / 用了，不帶他起的名字。
  useEffect(() => {
      if (!isDataLoaded || !shouldReportSnapshot('appearance')) return;
      trackCurrentAppearanceOnce(collectAppearance(theme, characters.find(c => c.id === activeCharacterId)));
  }, [isDataLoaded, characters, activeCharacterId, theme]);

  useEffect(() => {
      if (!isDataLoaded || characters.length === 0) return;
      if (!shouldReportSnapshot('char-settings')) return;
      trackCurrentCharSettingsOnce(collectCharSettings(characters, activeCharacterId));
  }, [isDataLoaded, characters, activeCharacterId]);

  // --- 使用統計：現在開著哪些功能 ---
  // 跟「當前外觀」一個道理：外部服務這類配置配一次就長期生效，只看「打開過配置頁」
  // 那種流量點的話，配好之後再沒進過設置頁的人永遠不出現，拿來判斷「有沒有人要」會判反。
  //
  // 收斂全在 utils/analyticsSnapshot.ts 裡做，這裡只負責把 OSContext 手上那幾份
  // state 遞過去。地址、密鑰、token、帳號名一個字都不會進上報。
  // 自己攔一道「只跑一次」：上報側本來就有 once 門，但取數要讀 IndexedDB
  // （彼方獨立線路、主動消息 2.0 全局配置、協同庫 count），不讓它隨 state 變更白跑。
  const featuresReportedRef = useRef(false);
  useEffect(() => {
      if (!isDataLoaded || featuresReportedRef.current) return;
      if (!shouldReportSnapshot('features')) return;
      featuresReportedRef.current = true;
      void (async () => {
          trackCurrentFeaturesOnce(await collectFeatureFlagsAsync({
              realtimeConfig,
              cloudBackupConfig,
              memoryPalaceConfig,
              remoteVectorConfig,
              apiConfig,
              apiPresetCount: apiPresets.length,
              characters,
          }));
      })();
  }, [isDataLoaded, realtimeConfig, cloudBackupConfig, memoryPalaceConfig, remoteVectorConfig, apiConfig, apiPresets, characters]);

  useEffect(() => {
      if (!isDataLoaded || !shouldReportSnapshot('sar')) return;
      trackCurrentSARFeaturesOnce(collectSARFeatureFlags());
  }, [isDataLoaded]);

  // --- Global Error Interception ---
  useEffect(() => {
      if (interceptorsInitialized.current) return;
      interceptorsInitialized.current = true;

      // 1. Monkey Patch Fetch
      const originalFetch = window.fetch;
      // “同一 API 在別的模式剛成功”是排查 CORS 包裝錯誤最有價值的對照證據。
      // 只記 method + URL + 狀態與時間，不保存請求正文。
      const recentSuccessfulFetches = new Map<string, { timestamp: number; status: number }>();
      const patchedFetch = async (...args: [RequestInfo | URL, RequestInit?]) => {
          const [resource, config] = args;
          
          const urlStr = typeof resource === 'string'
              ? resource
              : (typeof Request !== 'undefined' && resource instanceof Request)
                  ? resource.url
                  : resource instanceof URL
                      ? resource.href
                      : String(resource);
          const fetchStartedAt = Date.now();
          // 失敗診斷要按發起時刻去 Resource Timing 裡認領本次那條記錄，而 entry.startTime 跟
          // performance.now() 同一條時間軸、跟 Date.now() 不是——兩者不能混用，詳見
          // utils/networkFailureDiagnosis.ts 的 readResourceTimingHint。
          const fetchStartedAtPerf = typeof performance !== 'undefined' ? performance.now() : Number.NaN;
          // Bare fetch calls do not carry explicit metadata. Snapshot the active
          // App now; reading the ambient value after a long response would label
          // the request as whichever App the user navigated to in the meantime.
          const ambientMetaAtStart = getApiCallAmbientContext();
          const method = ((config as RequestInit | undefined)?.method
              || (typeof Request !== 'undefined' && resource instanceof Request ? resource.method : 'GET'))
              .toUpperCase();
          const requestComparisonKey = `${method} ${urlStr}`;

          // 採樣參數兼容層（詳見 utils/samplingParamCompat.ts）：
          // 某些模型廢棄了 temperature/top_p/top_k，帶上直接 400。這裡在所有 /chat/completions
          // 的統一出口做發送前主動摘除，覆蓋 Schedule / 記憶 / 見面等全部旁路調用點。
          let sendArgs: [RequestInfo | URL, RequestInit?] = args;
          // 透明流式升級狀態（utils/streamUpgrade.ts）：請求側改寫 → 響應側拼回 JSON
          let streamUpgraded = false;
          if (urlStr.includes('/chat/completions')) {
              const rawBody = (config as RequestInit | undefined)?.body;
              if (typeof rawBody === 'string') {
                  try {
                      const parsed = JSON.parse(rawBody);
                      let body = rawBody;
                      if (clampClaudeTemperature(parsed)) {
                          body = JSON.stringify(parsed);
                      }
                      if (modelRejectsSamplingParams(parsed?.model) && stripSamplingParams(parsed)) {
                          body = JSON.stringify(parsed);
                      }
                      // 透明流式升級：主 API 開了 stream 時，把硬編碼非流式的旁路調用
                      // （查手機/記憶宮殿/日程/劇場/群聊…40+ 處）升級為流式**傳輸**，防網關
                      // 空閒超時把長生成掐成半截；響應會在下面攢齊拼回標準 JSON，調用方無感。
                      // 已自帶 stream:true 的請求（聊天主路徑/見面/情緒評估）不碰。
                      if (isGlobalStreamEnabled()) {
                          const upgraded = upgradeChatBodyToStream(body);
                          if (upgraded) {
                              body = upgraded;
                              streamUpgraded = true;
                          }
                      }
                      if (body !== rawBody) sendArgs = [resource, { ...(config as RequestInit), body }];
                  } catch { /* 非 JSON body：原樣放行 */ }
              }

              // 圖片令牌不出門：`blobref:` 是本機存儲形態，發出去對面只會看到一串讀不懂的
              // 字符，然後說「我沒看到圖片」——不報錯也不破圖，最難查（詳見 utils/apiBlobRefs.ts）。
              // safeFetchJson 那條路自己還原過一遍，這裡兜的是繞開它直接用 fetch 的調用點。
              const bodyBeforeRefs = (sendArgs[1] as RequestInit | undefined)?.body;
              const bodyWithImages = await resolveBlobRefsInRequestBody(bodyBeforeRefs);
              if (bodyWithImages !== bodyBeforeRefs) {
                  sendArgs = [sendArgs[0], { ...(sendArgs[1] as RequestInit), body: bodyWithImages as BodyInit }];
              }
          }

          // 用戶手動開啟的「本次發送統計」：只搶佔下一條請求，並在真正發出前立即自動關閉。
          // 取兼容層處理後的 sendArgs，展示內容與本次實際提交給服務端的請求體一致。
          let apiRequestCaptureId: string | null = null;
          if (urlStr.includes('/chat/completions')) {
              const captureMeta = (sendArgs[1] as any)?.__sullyMeta || ambientMetaAtStart;
              apiRequestCaptureId = captureApiRequestOnce({ url: urlStr, body: (sendArgs[1] as any)?.body, meta: captureMeta });
          }

          try {
              let response = await originalFetch(...sendArgs);

              // /chat/completions 是可能已經開始計費的請求。拿到任何 HTTP 響應後都不在
              // 兼容層靜默重發：中轉站可能在返回錯誤前已經把任務交給上游，重發會讓用戶
              // 只看到一條調用記錄卻被扣兩到三次。已知模型的採樣參數仍在發送前清理；
              // 未知兼容問題和流式 4xx 原樣交給調用方，由用戶明確決定是否重試。
              // 流式升級的響應歸一化：SSE 攢齊拼回標準 chat.completion JSON——
              // 調用方（safeResponseJson / res.json() 均可）拿到與升級前等價的響應。
              if (streamUpgraded && response.ok) {
                  response = await assembleUpgradedResponse(response);
              }

              // 「API 調用記錄」統一記錄入口：所有 /chat/completions（裸 fetch + safeFetchJson
              // 內部 fetch 都會經過這裡）都記一筆。meta 優先取調用方掛在 init 上的 __sullyMeta
              // （safeFetchJson 傳的精確信息），裸 fetch 沒有就由 recordApiCall 用環境兜底。
              // ⚠️ 耗時必須在 clone 讀完**整個響應體**後再算：fetch 在響應頭到達時就 resolve，
              // 流式透傳的正文可能再流幾十秒——舊版在 headers 處截止，「假流」渠道 6.5s 出頭、
              // 正文 44s 才灌完，卡片卻記成 6.5s（實測誤導排查）。clone 與調用方並行消費同一
              // 條流，text() 完成時刻 ≈ 真實收完時刻。
              if (urlStr.includes('/chat/completions')) {
                  const meta = (config as any)?.__sullyMeta || ambientMetaAtStart;
                  const requestId = (config as any)?.__sullyApiCallId;
                  const body = (sendArgs[1] as any)?.body;
                  const status = response.status;
                  const ok = response.ok;
                  // clone 出來異步讀 usage，不阻塞調用方拿 response
                  let usageClone: Response | null = null;
                  try { usageClone = response.clone(); } catch { usageClone = null; }
                  if (usageClone) {
                      usageClone.text().then((t) => {
                          const durationMs = Date.now() - fetchStartedAt;
                          // 一定要等正文完整讀完再記成功；只拿到 200 響應頭、隨後 SSE 斷流
                          // 正是這次劇情故障的形態，不能拿它反過來當成功對照。
                          if (ok) recentSuccessfulFetches.set(requestComparisonKey, { timestamp: Date.now(), status });
                          let parsed: any = undefined;
                          try { parsed = JSON.parse(t); } catch { /* 流式/非 JSON：把原始文本交給 recordApiCall 的 SSE 兜底解析 */ }
                          updateApiRequestCaptureUsage({ captureId: apiRequestCaptureId, ok, response: parsed, responseText: parsed === undefined ? t : undefined });
                          recordApiCall({ requestId, url: urlStr, body, status, ok, response: parsed, responseText: parsed === undefined ? t : undefined, meta, durationMs });
                      }).catch(() => {
                          updateApiRequestCaptureUsage({ captureId: apiRequestCaptureId, ok });
                          recordApiCall({ requestId, url: urlStr, body, status, ok, meta, durationMs: Date.now() - fetchStartedAt });
                      });
                  } else {
                      // clone 失敗時，只有已經在上面完整拼裝過的升級流才能確認正文收完。
                      if (ok && streamUpgraded) recentSuccessfulFetches.set(requestComparisonKey, { timestamp: Date.now(), status });
                      updateApiRequestCaptureUsage({ captureId: apiRequestCaptureId, ok });
                      recordApiCall({ requestId, url: urlStr, body, status, ok, meta, durationMs: Date.now() - fetchStartedAt });
                  }
              }

              if (!response.ok) {
                  // Only log if it's likely an API call (contains chat/completions or models)
                  if (urlStr.includes('/chat/completions') || urlStr.includes('/models')) {
                      try {
                          const clone = response.clone();
                          const text = await clone.text();
                          // 把發出去的請求體摘要也記上 —— 排查"只有點單(帶工具)報錯"必須看到 model/參數/tools/消息結構
                          let reqSummary = '';
                          try {
                              const b = (sendArgs[1] as any)?.body;
                              if (typeof b === 'string') {
                                  const j = JSON.parse(b);
                                  const toolNames = Array.isArray(j.tools) ? j.tools.map((t: any) => t?.function?.name).filter(Boolean) : [];
                                  const roles = Array.isArray(j.messages) ? j.messages.map((m: any) => m.role + (m.tool_calls ? '(tool_calls)' : '')).join(',') : '';
                                  reqSummary = `\n--- Request ---\nmodel: ${j.model}\ntemperature: ${j.temperature} | top_p: ${j.top_p} | reasoning_effort: ${j.reasoning_effort} | thinking: ${j.thinking ? 'on' : 'off'}\ntools(${toolNames.length}): ${toolNames.join(', ')}\nmessages(${(j.messages || []).length}) roles: ${roles}`;
                              }
                          } catch { /* 解析不了就算了 */ }
                          setSystemLogs(prev => [{
                              id: `log-${Date.now()}`,
                              timestamp: Date.now(),
                              type: 'network',
                              source: 'API Request',
                              message: `HTTP ${response.status} Error`,
                              detail: `URL: ${urlStr}\nResponse: ${text.substring(0, 500)}${reqSummary}`
                          }, ...prev.slice(0, 49)]); // Keep last 50
                      } catch (e) {
                          setSystemLogs(prev => [{
                              id: `log-${Date.now()}`,
                              timestamp: Date.now(),
                              type: 'network',
                              source: 'API Request',
                              message: `HTTP ${response.status} (Unreadable Body)`,
                              detail: `URL: ${urlStr}`
                          }, ...prev.slice(0, 49)]);
                      }
                  }
              }
              return response;
          } catch (err: any) {
              // Network Failure
              if (urlStr.includes('/chat/completions')) {
                  updateApiRequestCaptureUsage({ captureId: apiRequestCaptureId, ok: false });
                  recordApiCall({ requestId: (config as any)?.__sullyApiCallId, url: urlStr, body: (sendArgs[1] as any)?.body, ok: false, meta: (config as any)?.__sullyMeta || ambientMetaAtStart, durationMs: Date.now() - fetchStartedAt });
              }
              if (!isAnalyticsRequestUrl(urlStr)) {
                  // 光禿禿一句 "Failed to fetch" + 一個 URL 排查不了任何東西（社區裡這條卡過好幾個人）。
                  // 這裡把瀏覽器肯在 JS 側交出來的旁證一次性補齊：方法、耗時、在線狀態、是否跨域、
                  // Resource Timing 裡那條記錄，再給一句初判；隨後異步做一次 no-cors 連通性複檢，
                  // 結論回填到同一條日誌上——「網絡不通」和「網絡通但響應被 CORS 攔」要走的排查路
                  // 完全相反，不分開的話用戶只能瞎試。詳見 utils/networkFailureDiagnosis.ts。
                  const logId = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                  const requestMeta = (sendArgs[1] as any)?.__sullyMeta || ambientMetaAtStart;
                  const recentSuccess = recentSuccessfulFetches.get(requestComparisonKey);
                  const baseDetail = buildFetchFailureDetail({
                      url: urlStr,
                      method,
                      durationMs: Date.now() - fetchStartedAt,
                      error: err,
                      requestSummary: summarizeFetchRequestBody((sendArgs[1] as any)?.body),
                      requestPurpose: requestMeta?.purpose,
                      recentSuccessfulSameRequest: recentSuccess,
                  }, { startedAt: fetchStartedAtPerf });
                  setSystemLogs(prev => [{
                      id: logId,
                      timestamp: Date.now(),
                      type: 'network',
                      source: 'Network',
                      message: err.message || 'Fetch Failed',
                      detail: baseDetail,
                  }, ...prev.slice(0, 49)]);

                  // 複檢走 originalFetch，否則它自己失敗會再寫一條日誌滾雪球。
                  if (shouldProbeReachability(classifyFetchFailure({ url: urlStr, error: err }))) {
                      void (async () => {
                          const verdict = await probeOriginReachability(urlStr, originalFetch);
                          const line = describeReachabilityProbe(verdict, parseTargetUrl(urlStr).host, method);
                          if (!line) return;
                          setSystemLogs(prev => prev.map(log => (
                              log.id === logId ? { ...log, detail: `${log.detail || ''}\n${line}` } : log
                          )));
                      })();
                  }
              }
              throw err;
          }
      };

      try {
          window.fetch = patchedFetch;
      } catch (e) {
          try {
              Object.defineProperty(window, 'fetch', {
                  value: patchedFetch,
                  writable: true,
                  configurable: true
              });
          } catch (e2) {
              console.warn("Failed to install network interceptor", e2);
          }
      }

      const originalConsoleError = console.error;
      console.error = (...args) => {
          const msg = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ');
          // MediaPipe/TFLite 把這條成功初始化信息寫到了 stderr，瀏覽器因而走
          // console.error；改回 info，避免系統日誌把“CPU 加速創建成功”報成紅色錯誤。
          if (isBenignApplicationConsoleMessage(msg)) {
              console.info(...args);
              return;
          }
          originalConsoleError(...args);
          // detail 只有真拿到堆棧才用堆棧，否則回退完整 msg。
          // 舊寫法 `args.map(a => a instanceof Error ? a.stack : '').join('\n')`
          // 對「多個非 Error 參數」會產出 "\n"（truthy），把回退短路掉——
          // 日誌面板裡只剩被 100 字截斷的 message（排查 Embedding 400 這類
          // 長響應時，關鍵的服務商完整響應體全丟，detail 只有一個換行符）。
          const stacks = args
              .filter((a): a is Error => a instanceof Error)
              .map(a => a.stack || '')
              .filter(Boolean)
              .join('\n');
          if (msg.includes('Warning:')) return;
          setSystemLogs(prev => [{
              id: `log-${Date.now()}-${Math.random()}`,
              timestamp: Date.now(),
              type: 'error',
              source: 'Application',
              message: msg.substring(0, 100),
              detail: stacks || msg
          }, ...prev.slice(0, 49)]);
      };
  }, []);

  const clearLogs = () => setSystemLogs([]);

  useEffect(() => {
    const loadSettings = async () => {
        // ... (existing load logic)
        const savedThemeStr = localStorage.getItem('os_theme');
        const savedApi = localStorage.getItem('os_api_config');
        const savedModels = localStorage.getItem('os_available_models');
        const savedPresets = localStorage.getItem('os_api_presets');
        
        let loadedTheme = { ...defaultTheme };
        if (savedThemeStr) {
             try {
                 const parsed = JSON.parse(savedThemeStr);
                 loadedTheme = { ...loadedTheme, ...parsed };
                 // 僅遷移舊系統默認值；用戶自定義過的壁紙、文字色和主題色全部保留。
                 const preserveNostalgia = shouldPreserveLegacyDefaultWallpaper(loadedTheme.wallpaper, loadedTheme.desktopVariant);
                 if ((!preserveNostalgia && isLegacyDefaultWallpaper(loadedTheme.wallpaper)) || (isPaperWallpaper(loadedTheme.wallpaper) && loadedTheme.wallpaper !== DEFAULT_WALLPAPER)) {
                     loadedTheme.wallpaper = DEFAULT_WALLPAPER;
                     loadedTheme = migrateLegacyDefaultPalette(loadedTheme);
                 }
                 // Strip the legacy Unsplash hard-coded wallpaper, keep user-imported http(s) URLs
                 if (
                     loadedTheme.wallpaper.includes('unsplash') ||
                     loadedTheme.wallpaper === ''
                 ) {
                     loadedTheme.wallpaper = DEFAULT_WALLPAPER;
                 }
                 // LS 裡絕不該有 data:（舊包）或 blob:（上會話臨時 objectURL，重啟即失效）壁紙——
                 // 真值在 assets 'wallpaper'，下面會解析覆蓋；這裡先回退默認避免閃一幀壞圖。
                 if (loadedTheme.wallpaper.startsWith('data:') || loadedTheme.wallpaper.startsWith('blob:')) {
                     loadedTheme.wallpaper = defaultTheme.wallpaper;
                 }
                 if (loadedTheme.lockWallpaper?.startsWith('data:') || loadedTheme.lockWallpaper?.startsWith('blob:')) {
                     loadedTheme.lockWallpaper = undefined;
                 }
                 // Deprecated legacy fields are forcibly stripped — they never render again.
                 loadedTheme.launcherWidgetImage = undefined;
                 // Reset font too if it's data URI
                 if (loadedTheme.customFont && loadedTheme.customFont.startsWith('data:')) {
                     loadedTheme.customFont = undefined;
                 }
                 const companionRepair = stripCompanionChatStyleResidue(loadedTheme);
                 if (companionRepair.repaired) {
                     loadedTheme = companionRepair.theme;
                     localStorage.setItem('os_theme', JSON.stringify(loadedTheme));
                 }
             } catch(e) { console.error('Theme load error', e); }
        }
        
        if (savedApi) {
            const normalizedApi = normalizeApiConfig({ ...defaultApiConfig, ...JSON.parse(savedApi) });
            setApiConfig(normalizedApi);
            localStorage.setItem('os_api_config', JSON.stringify(normalizedApi));
        }
        if (savedModels) {
            try { setAvailableModels(normalizeModelIds(JSON.parse(savedModels))); }
            catch (error) { console.warn('Model list load error', error); }
        }
        if (savedPresets) {
            const normalizedPresets = (JSON.parse(savedPresets) as ApiPreset[]).map(normalizeApiPreset);
            setApiPresets(normalizedPresets);
            localStorage.setItem('os_api_presets', JSON.stringify(normalizedPresets));
        }

        // 加載實時配置
        const savedRealtimeConfig = localStorage.getItem('os_realtime_config');
        if (savedRealtimeConfig) {
            try {
                const parsed = JSON.parse(savedRealtimeConfig);
                // 小紅書 serverUrl 獨立持久化，存量若指向已死的歷史 worker 域名則遷到當前實例
                if (parsed?.xhsMcpConfig?.serverUrl) {
                    parsed.xhsMcpConfig.serverUrl = rewriteStaleWorkerUrl(parsed.xhsMcpConfig.serverUrl);
                }
                setRealtimeConfig({ ...defaultRealtimeConfig, ...parsed });
            } catch (e) {
                console.error('Failed to load realtime config', e);
            }
        }

        try {
            const assets = await DB.getAllAssets();
            const assetMap: Record<string, string> = {};
            if (Array.isArray(assets)) {
                assets.forEach(a => assetMap[a.id] = a.data);

                if (assetMap['wallpaper']) {
                    // assets 'wallpaper' 現在存的是指針（blobref 令牌 / 舊 data: / http）。
                    // 解析成可渲染 url（令牌→objectURL；舊 data: 順手遷移成 Blob）。
                    const legacyAssetWallpaper = isLegacyDefaultWallpaper(assetMap['wallpaper']);
                    const preserveNostalgia = shouldPreserveLegacyDefaultWallpaper(assetMap['wallpaper'], loadedTheme.desktopVariant);
                    if ((legacyAssetWallpaper && !preserveNostalgia) || isPaperWallpaper(assetMap['wallpaper'])) {
                        loadedTheme.wallpaper = DEFAULT_WALLPAPER;
                        if (legacyAssetWallpaper) loadedTheme = migrateLegacyDefaultPalette(loadedTheme);
                        await DB.deleteAsset('wallpaper');
                    } else {
                        loadedTheme.wallpaper = await resolveWallpaperStoredValue(assetMap['wallpaper'], preserveNostalgia);
                    }
                }
                if (assetMap['lock_wallpaper']) {
                    loadedTheme.lockWallpaper = await resolveLockWallpaperStoredValue(assetMap['lock_wallpaper']);
                }

                // Deprecated legacy asset — purge silently so it can never be rendered again.
                if (assetMap['launcherWidgetImage']) {
                    void DB.deleteAsset('launcherWidgetImage');
                }

                // If asset exists, it overrides LS (which is empty or old)
                if (assetMap['custom_font_data']) {
                    loadedTheme.customFont = assetMap['custom_font_data'];
                }

                const DEPRECATED_WIDGET_SLOTS = new Set(['bl', 'br']);
                const loadedIcons: Record<string, string> = {};
                const loadedWidgets: Record<string, string> = {};
                for (const key of Object.keys(assetMap)) {
                    if (key.startsWith('icon_')) {
                        const appId = key.replace('icon_', '');
                        const previous = assetMap[key];
                        const stored = previous.startsWith('data:') ? await migrateDataUrlToRef(previous) : previous;
                        loadedIcons[appId] = stored;
                        if (stored !== previous) await DB.saveAsset(key, stored);
                    }
                    if (key.startsWith('widget_')) {
                        const slot = key.replace('widget_', '');
                        if (DEPRECATED_WIDGET_SLOTS.has(slot)) {
                            void DB.deleteAsset(key);
                            continue;
                        }
                        loadedWidgets[slot] = assetMap[key];
                    }
                }
                setCustomIcons(loadedIcons);
                initPwaIcon(loadedIcons); // 啟動時恢復自定義 PWA 圖標（見 utils/appIcon.ts）
                // Strip deprecated slots that may have been imported via beautification packs.
                if (loadedTheme.launcherWidgets) {
                    for (const slot of DEPRECATED_WIDGET_SLOTS) {
                        delete loadedTheme.launcherWidgets[slot];
                    }
                }
                if (Object.keys(loadedWidgets).length > 0) {
                    loadedTheme.launcherWidgets = { ...(loadedTheme.launcherWidgets || {}), ...loadedWidgets };
                }

                // Load appearance presets from assets
                const loadedPresets: AppearancePreset[] = [];
                Object.keys(assetMap).forEach(key => {
                    if (key.startsWith('appearance_preset_')) {
                        try {
                            const preset = JSON.parse(assetMap[key]);
                            loadedPresets.push(preset);
                        } catch {}
                    }
                });

                loadedPresets.sort((a, b) => b.createdAt - a.createdAt);
                setAppearancePresets(loadedPresets);

                // Restore desktop decoration images from IndexedDB
                if (loadedTheme.desktopDecorations && loadedTheme.desktopDecorations.length > 0) {
                    loadedTheme.desktopDecorations = loadedTheme.desktopDecorations.map(d => {
                        if (d.type === 'image' && (!d.content || d.content === '')) {
                            const restored = assetMap[`deco_${d.id}`];
                            return restored ? { ...d, content: restored } : d;
                        }
                        return d;
                    }).filter(d => d.content && d.content !== '');
                }
            }
        } catch (e) {
            console.error("Failed to load assets from DB", e);
        }

        setTheme(loadedTheme);
        // Apply font
        applyCustomFont(loadedTheme.customFont);
    };

    const initData = async () => {
      try {
        // 請求持久化存儲：標記後瀏覽器在磁盤壓力時不會優先驅逐我們的 IndexedDB，
        // 角色 / 聊天 / 資產這些大體積數據被默認隨手清掉的概率顯著降低。
        // 接口未授權會直接 reject —— 我們不在乎結果，吞掉異常。
        if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
            navigator.storage.persist().catch(() => {});
        }

        // localStorage 鏡像回填：部分瀏覽器/清理工具會只清 localStorage 而留下 IndexedDB，
        // 導致「主題回初始 / 盲盒收藏冊清空 / API 配置丟失」三連。必須在 loadSettings
        // 讀 localStorage 之前完成回填。見 utils/lsMirror.ts。
        const healedKeys = await initLocalStorageMirror().catch(() => [] as string[]);
        if (healedKeys.length > 0) {
            console.warn('[lsMirror] localStorage 疑似被清除，已從 IndexedDB 鏡像回填:', healedKeys);
            setTimeout(() => addToast(`檢測到本地設置曾被瀏覽器清除，已自動恢復 ${healedKeys.length} 項（主題 / API 等）`, 'info'), 2500);
        }

        // 清掉 Instant Push 留在本機的舊配置和緩存（含 Worker 令牌、API Key 副本），只跑一次。
        void cleanupInstantPushLegacyData();

        await loadSettings();

        // 老用戶庫存的鯊盤圖鏈接就地改寫成 jsDelivr（冪等、跑一次）。放在讀 characters 之前，
        // 讓下面 getAllCharacters 拿到的就是改好的數據。見 utils/sharkpanAssetMigration.ts。
        await migrateSharkpanAssets();

        // 用 allSettled 而非 all：早期 Promise.all 只要任意一個 store 讀取 reject，
        // 整批加載就全掛 → setCharacters / setWorldbooks 都不執行 → 角色和世界書"憑空消失"
        // （數據其實還在 IndexedDB 裡，只是沒讀進 state）→ Chat 渲染時 char 為 undefined 直接崩。
        // 改成各 store 獨立失敗，一個壞掉不連累其餘，最大限度保住用戶數據。
        const settle = async <T,>(p: Promise<T>, label: string, fallback: T): Promise<T> => {
            try {
                return await p;
            } catch (e) {
                console.error(`Data init: 讀取 ${label} 失敗，已降級`, e);
                return fallback;
            }
        };

        const [dbChars, dbThemes, dbUser, dbGroups, dbWorldbooks, dbNovels, dbSongs, dbCharGroups, dbNpcs] = await Promise.all([
            settle(DB.getAllCharacters().then(chars => { initializeFirstUseGuide(chars.length); return chars; }), 'characters', [] as CharacterProfile[]),
            settle(DB.getThemes(), 'themes', [] as ChatTheme[]),
            settle(DB.getUserProfile(), 'userProfile', null as UserProfile | null),
            settle(DB.getGroups(), 'groups', [] as GroupProfile[]),
            settle(DB.getAllWorldbooks(), 'worldbooks', [] as Worldbook[]),
            settle(DB.getAllNovels(), 'novels', [] as NovelBook[]),
            settle(DB.getAllSongs(), 'songs', [] as SongSheet[]),
            settle(DB.getCharacterGroups(), 'characterGroups', [] as CharacterGroup[]),
            settle(DB.getAllNPCs(), 'npcs', [] as NPCProfile[])
        ]);
        setNpcs(dbNpcs);

        let finalChars = dbChars;

        if (!finalChars.some(c => c.id === sullyV2.id)) {
            await DB.saveCharacter(sullyV2);
            finalChars = [...finalChars, sullyV2];
        } else {
            // REPAIR LOGIC
            const existingSully = finalChars.find(c => c.id === sullyV2.id);
            if (existingSully) {
                 const currentSprites = existingSully.sprites || {};
                 const isCorrupted = !currentSprites['normal'] || !currentSprites['chibi'];
                 const needsWallUpdate = existingSully.roomConfig?.wallImage !== sullyV2.roomConfig?.wallImage;
                 const needsSkinSets = !existingSully.dateSkinSets || existingSully.dateSkinSets.length === 0;
                 // 默認頭像曾先後使用舊圖床和依賴部署根路徑的本地地址。
                 // 這些地址在備份恢復或 GitHub Pages 子路徑變化後會 404；統一遷移到資產倉庫。
                 // 用戶自己改過的頭像不在遷移名單內，保持不動。
                  const needsAvatarUpdate = shouldMigrateSullyAvatar(existingSully.avatar);
                  // 內置模型只補給還沒有視頻形象的 Sully。用戶自己導入的
                  // VRM / Live2D 始終優先，絕不在啟動修復時被覆蓋。
                  const needsBuiltinVideoAvatar = !existingSully.videoAvatar;
                  const needsBuiltinVideoAvatarUpgrade = isBuiltinSullyLive2D(existingSully.videoAvatar)
                      && existingSully.videoAvatar.builtinFramingVersion !== 2;
                  if (isCorrupted || !existingSully.roomConfig || needsWallUpdate || needsSkinSets || needsAvatarUpdate || needsBuiltinVideoAvatar || needsBuiltinVideoAvatarUpgrade) {
                     const restoredSprites = { ...sullyV2.sprites, ...currentSprites };

                     if (!restoredSprites['normal']) restoredSprites['normal'] = sullyV2.sprites!['normal'];
                     if (!restoredSprites['happy']) restoredSprites['happy'] = sullyV2.sprites!['happy'];
                     if (!restoredSprites['sad']) restoredSprites['sad'] = sullyV2.sprites!['sad'];
                     if (!restoredSprites['angry']) restoredSprites['angry'] = sullyV2.sprites!['angry'];
                     if (!restoredSprites['shy']) restoredSprites['shy'] = sullyV2.sprites!['shy'];
                     if (!restoredSprites['chibi']) restoredSprites['chibi'] = sullyV2.sprites!['chibi'];

                     const updatedRoomConfig = existingSully.roomConfig ? {
                         ...existingSully.roomConfig,
                         wallImage: (existingSully.roomConfig.wallImage?.includes('radial-gradient') || !existingSully.roomConfig.wallImage)
                                    ? sullyV2.roomConfig?.wallImage
                                    : existingSully.roomConfig.wallImage
                     } : sullyV2.roomConfig;

                     // Merge preset skin sets: add any preset skins not already present
                     const existingSkins = existingSully.dateSkinSets || [];
                     const presetSkins = sullyV2.dateSkinSets || [];
                     const mergedSkins = [...existingSkins];
                     for (const ps of presetSkins) {
                         if (!mergedSkins.some(s => s.id === ps.id)) {
                             mergedSkins.push(ps);
                         }
                     }

                     const updatedSully = {
                         ...existingSully,
                          avatar: needsAvatarUpdate ? sullyV2.avatar : existingSully.avatar,
                          videoAvatar: existingSully.videoAvatar?.format === 'live2d'
                              ? upgradeBuiltinSullyLive2DDefaults(existingSully.videoAvatar)
                              : existingSully.videoAvatar || sullyV2.videoAvatar,
                          sprites: restoredSprites,
                         roomConfig: updatedRoomConfig,
                         dateSkinSets: mergedSkins
                     };
                     
                     await DB.saveCharacter(updatedSully);
                     finalChars = finalChars.map(c => c.id === sullyV2.id ? updatedSully : c);
                 }
            }
        }

        let resetAutoContextCount = 0;
        let migratedContextCount = 0;
        finalChars = finalChars.map(c => {
          const normalized = normalizeCharacterDefaults(normalizeCharacterImpression(c));
          const migration = migrateCharacterContextRange(normalized);
          if (migration.migrated) migratedContextCount++;
          if (migration.resetAutoContext) resetAutoContextCount++;
          return migration.character;
        });
        if (migratedContextCount > 0) {
          await Promise.all(finalChars.map(c => DB.saveCharacter(c)));
        }
        if (resetAutoContextCount > 0) {
          setTimeout(() => addToast(
            `上下文範圍已升級：${resetAutoContextCount} 個全自動記憶角色已恢復為自適應模式。需要讀取更多舊原文時，可在聊天設置中手動調整。`,
            'info',
          ), 1200);
        }

        if (finalChars.length > 0) {
          setCharacters(finalChars);
          const lastActiveId = localStorage.getItem('os_last_active_char_id');
          if (lastActiveId && finalChars.find(c => c.id === lastActiveId)) {
            setActiveCharacterId(lastActiveId);
          } else if (finalChars.find(c => c.id === sullyV2.id)) {
            setActiveCharacterId(sullyV2.id);
          } else {
            setActiveCharacterId(finalChars[0].id);
          }
        } else {
          await DB.saveCharacter(initialCharacter);
          setCharacters([initialCharacter]);
          setActiveCharacterId(initialCharacter.id);
        }

        setGroups(dbGroups);
        setCharacterGroups(dbCharGroups);
        setWorldbooks(dbWorldbooks);
        setNovels(dbNovels);
        setSongs(dbSongs);
        setCustomThemes(dbThemes);
        if (dbUser) setUserProfileBase(dbUser);

        // amsg2 髒標記兜底補傳：上次會話打了髒、但請求還沒落地（在飛或躺在退避重排裡）
        // 就被殺進程的角色，按 localStorage 底帳用剛從 DB 讀回的數據重建快照傳一次。
        // realtimeConfig / apiConfig 的 state 此刻可能都還沒就位，直接讀各自的持久化來源。
        try {
          const savedRealtime = localStorage.getItem('os_realtime_config');
          const savedApiRaw = localStorage.getItem('os_api_config');
          resumePendingAmsgStateSync({
            characters: finalChars,
            userProfile: applyActivePersona(dbUser ?? defaultUserProfile),
            groups: dbGroups,
            realtimeConfig: savedRealtime
              ? { ...defaultRealtimeConfig, ...JSON.parse(savedRealtime) }
              : defaultRealtimeConfig,
            // 上次沒傳成功的 LLM 憑據行按這份重算補傳；沒有就跳過那一項。
            apiConfig: savedApiRaw ? JSON.parse(savedApiRaw) : undefined,
          });
        } catch (err) {
          console.warn('[AmsgStateSync] 啟動補傳失敗（不影響啟動）', err);
        }

      } catch (err) {
        console.error('Data init failed:', err);
      } finally {
        setIsDataLoaded(true);

        // 檢測：遠程向量存儲已配置但遠程可能缺數據（導入備份後）
        try {
            const rvConfig = JSON.parse(localStorage.getItem('os_remote_vector_config') || '{}');
            if (rvConfig.enabled && rvConfig.initialized && rvConfig.supabaseUrl) {
                const { getVectorCount } = await import('../utils/memoryPalace/supabaseVector');
                const remoteCount = await getVectorCount(rvConfig);
                // 本地向量數量
                const localDb = await import('../utils/db').then(m => m.openDB());
                const localCount = await new Promise<number>((res) => {
                    const tx = localDb.transaction('memory_vectors', 'readonly');
                    const req = tx.objectStore('memory_vectors').count();
                    req.onsuccess = () => res(req.result);
                    req.onerror = () => res(0);
                });
                if (localCount > 0 && remoteCount < localCount * 0.5) {
                    setTimeout(() => addToast(`本地有 ${localCount} 條向量，遠程僅 ${remoteCount} 條。建議去設置頁同步到遠程。`, 'info'), 3000);
                }
            }
        } catch { /* 靜默 */ }
      }
    };

    initData();
  }, []);

  // --- NEW: Apply Theme CSS Variables ---
  useEffect(() => {
      const root = document.documentElement;
      // Default fallback values match index.html
      const h = theme.hue ?? 245;
      const s = theme.saturation ?? 25;
      const l = theme.lightness ?? 65;
      
      root.style.setProperty('--primary-hue', String(h));
      root.style.setProperty('--primary-sat', `${s}%`);
      root.style.setProperty('--primary-lightness', `${l}%`);

      // 聊天表情包尺寸（外觀 → 表情包大小，三擋）：小 96 / 中 128 / 大 160（舊版尺寸）。
      // 私聊 MessageItem 與群聊的表情 img 都用 var(--sully-emoji-size, 96px) 消費。
      const emojiSize = theme.chatEmojiSize === 'large' ? '160px' : theme.chatEmojiSize === 'medium' ? '128px' : '96px';
      root.style.setProperty('--sully-emoji-size', emojiSize);

      // 桌面皮膚：寫到 <html data-skin>，供全局 CSS（index.html）與組件讀取。
      root.dataset.skin = theme.skin || 'default';
  }, [theme]);

  // --- Update: Handle Scheduled Messages with Unread Flags & Web Notifications ---
  // Refs to avoid stale closures in the scheduled message interval
  const activeAppRef = useRef(activeApp);
  const activeCharIdScheduleRef = useRef(activeCharacterId);
  activeAppRef.current = activeApp;
  activeCharIdScheduleRef.current = activeCharacterId;

  // 當前聊天視圖快照 → 模塊級 slot（utils/chatGenEvents）。根級 ChatBroadcast 掛在
  // OSProvider 之外拿不到這兩個 state，靠快照判斷"用戶正看著的會話不彈全局橫幅"。
  useEffect(() => {
      setChatViewSnapshot(activeApp === AppID.Chat, activeCharacterId ?? null);
  }, [activeApp, activeCharacterId]);
  // 通話狀態（含掛起到後台的通話）——主動消息流程讀它來判斷"是否正在通話"
  const suspendedCallRef = useRef(suspendedCall);
  suspendedCallRef.current = suspendedCall;

  useEffect(() => {
      if (!isDataLoaded || characters.length === 0) return;
      let cancelled = false;
      const checkAllSchedules = async () => {
          if (cancelled) return;
          let hasNewMessage = false;
          const unreadUpdates: Record<string, number> = {};

          for (const char of characters) {
              try {
                  // 用戶正在 DateApp 裡和這個角色見面 —— 角色之前排好的定時消息
                  // ([schedule_message] 指令) 這輪先壓著不投遞（不刪不讀），
                  // 等用戶離開見面界面後，下一輪 5s 檢查會自然送達。
                  if (activeAppRef.current === AppID.Date && activeCharIdScheduleRef.current === char.id) continue;
                  // 通話中（含掛起）同理：定時消息這輪先壓著，離開通話後下一輪再送達。
                  if ((activeAppRef.current === AppID.Call && activeCharIdScheduleRef.current === char.id)
                      || suspendedCallRef.current?.charId === char.id) continue;
                  const dueMessages = await DB.getDueScheduledMessages(char.id);
                  if (cancelled) return;
                  if (dueMessages.length > 0) {
                      for (const msg of dueMessages) {
                          await DB.saveMessage({
                               charId: msg.charId,
                               role: 'assistant',
                               type: 'text',
                               content: msg.content
                          });
                          await DB.deleteScheduledMessage(msg.id);
                      }
                      if (cancelled) return;
                      hasNewMessage = true;
                      // Use refs for latest state (avoids stale closure & unnecessary deps)
                      const isChattingWithThisChar = activeAppRef.current === AppID.Chat && activeCharIdScheduleRef.current === char.id;

                      // If not chatting specifically with this char right now, mark as unread
                      if (!isChattingWithThisChar) {
                          addToast(`${char.name} 發來了一條消息`, 'success');
                          unreadUpdates[char.id] = dueMessages.length;

                          // Web Notification
                          if (!Capacitor.isNativePlatform() && window.Notification && Notification.permission === 'granted') {
                              try {
                                  // 通知不是 DOM，icon 只認能直接加載的地址：頭像字段可能是 blobref
                                  // 令牌，原樣塞進去就是沒圖標。先解析（非令牌原樣返回），解析不出
                                  // 來（圖已丟）時退回應用默認圖標。
                                  const icon = (await resolveRefToDataUrl(char.avatar || '')) || './icons/icon-192.png';
                                  const notif = new Notification(char.name, {
                                      body: dueMessages[0].content,
                                      icon,
                                      silent: false
                                  });
                                  notif.onclick = () => {
                                      window.focus();
                                      setActiveApp(AppID.Chat);
                                      setActiveCharacterId(char.id);
                                  };
                              } catch (e) { /* notification failed */ }
                          }
                      }
                  }
              } catch (e) { /* schedule check failed */ }
          }
          if (hasNewMessage && !cancelled) {
              setLastMsgTimestamp(Date.now());
              // Use functional updater to avoid depending on unreadMessages in the effect deps
              setUnreadMessages(prev => {
                  const next = { ...prev };
                  for (const [charId, count] of Object.entries(unreadUpdates)) {
                      next[charId] = (next[charId] || 0) + count;
                  }
                  return next;
              });
          }
      };
      schedulerRef.current = setInterval(checkAllSchedules, 5000);
      checkAllSchedules();
      return () => { cancelled = true; if (schedulerRef.current) clearInterval(schedulerRef.current); };
  }, [isDataLoaded, characters]);

  const clearUnread = useCallback((charId: string) => {
      setUnreadMessages(prev => {
          if (!prev[charId]) return prev; // no change needed — avoid unnecessary re-render
          const next = { ...prev };
          delete next[charId];
          return next;
      });
  }, []);

  // Listen for proactive messages to show unread red dot
  useEffect(() => {
      let awayProactiveCount = 0;

      const handler = (e: Event) => {
          const { charId, charName, body } = (e as CustomEvent).detail as { charId: string; charName: string; body?: string };
          // Only mark unread if user is NOT currently viewing this character's chat
          // Always bump timestamp so Chat reloads messages if currently open
          setLastMsgTimestamp(Date.now());

          const isChattingWithThisChar = activeAppRef.current === AppID.Chat && activeCharIdScheduleRef.current === charId;
          if (!isChattingWithThisChar) {
              const isVisible = document.visibilityState === 'visible';
              if (isVisible) {
                  addToast(`${charName} 主動發來了消息`, 'success');
              } else {
                  awayProactiveCount += 1;
              }
              setUnreadMessages(prev => ({ ...prev, [charId]: (prev[charId] || 0) + 1 }));
              const preview = (body || `${charName} sent a proactive message`).replace(/\s+/g, ' ').trim() || `${charName} sent a proactive message`;
              void sendProactiveNativeNotification(charId, charName, preview);

              // Web Notification —— 走 Service Worker 的 showNotification（和"測試推送"
              // 同一條鏈路）。頁面級 `new Notification(...)` 在標籤後台 / PWA / 移動端會
              // 靜默失敗，必須走 SW registration 才穩定。
              if (!Capacitor.isNativePlatform() && 'serviceWorker' in navigator && window.Notification && Notification.permission === 'granted') {
                  const char = characters.find(c => c.id === charId);
                  navigator.serviceWorker.ready.then(async reg => {
                      // 同上：令牌是個非空字符串，`char?.avatar || 默認圖標` 這種寫法會讓默認
                      // 圖標那條兜底永遠輪不到，結果一個圖標都沒有還不報錯。所以先解析成能
                      // 加載的地址，拿到空串才用默認圖標。
                      const icon = (await resolveRefToDataUrl(char?.avatar || '')) || './icons/icon-192.png';
                      reg.showNotification(charName, {
                          body: preview,
                          icon,
                          badge: './icons/icon-192.png',
                          tag: `proactive-${charId}`,
                          data: { charId, kind: 'proactive-1.0' },
                      }).catch(() => { /* notification failed */ });
                  }).catch(() => { /* SW not ready */ });
              }
          }
      };

      const onVisible = () => {
          if (document.visibilityState !== 'visible') return;
          if (awayProactiveCount > 0) {
              addToast(`你離開期間收到 ${awayProactiveCount} 條消息`, 'success');
              awayProactiveCount = 0;
          }
      };

      window.addEventListener('proactive-message-sent', handler);
      document.addEventListener('visibilitychange', onVisible);
      return () => {
          window.removeEventListener('proactive-message-sent', handler);
          document.removeEventListener('visibilitychange', onVisible);
      };
  }, [characters, sendProactiveNativeNotification]);

  // ─── Global Proactive Message Handler ───
  // Registered at OS level so it works even when Chat is not open.
  useEffect(() => {
      let awayActiveMsgCount = 0;

      const handler = (e: Event) => {
          const { charId, charName, body } = (e as CustomEvent).detail as { charId: string; charName: string; body?: string };
          setLastMsgTimestamp(Date.now());

          const isChattingWithThisChar = activeAppRef.current === AppID.Chat && activeCharIdScheduleRef.current === charId;
          if (!isChattingWithThisChar) {
              const isVisible = document.visibilityState === 'visible';
              if (isVisible) {
                  addToast(`${charName} 給你發了消息`, 'success');
              } else {
                  awayActiveMsgCount += 1;
              }
              setUnreadMessages(prev => ({ ...prev, [charId]: (prev[charId] || 0) + 1 }));
              const preview = (body || `${charName} sent an active message`).replace(/\s+/g, ' ').trim() || `${charName} sent an active message`;
              void sendProactiveNativeNotification(charId, charName, preview);
              // SW push handler 已經 fire 過系統通知（不在前台時露出真實內容、在前台時
              // silent + close 靜默），這裡不再補一次，避免重複彈窗。
          }
      };

      const openHandler = (e: Event) => {
          const { charId } = (e as CustomEvent).detail as { charId?: string };
          if (!charId) return;
          setActiveApp(AppID.Chat);
          setActiveCharacterId(charId);
      };

      const onVisible = () => {
          if (document.visibilityState !== 'visible') return;
          if (awayActiveMsgCount > 0) {
              addToast(`你離開期間收到 ${awayActiveMsgCount} 條新消息`, 'success');
              awayActiveMsgCount = 0;
          }
      };

      // Phase 1: per-chunk UI refresh side-channel. push 路徑下的 applyAssistantPostProcessing
      // 會逐條 saveMessage + fire 'active-msg-progress'; 這裡只推 lastMsgTimestamp 讓
      // Chat.tsx 的 useEffect 重新 reloadMessages, 不彈 toast / 不增加未讀
      // (那些只在 'active-msg-received' 觸發一次)。
      const progressHandler = () => {
          setLastMsgTimestamp(Date.now());
      };

      // 情緒 buff 落地後同步進內存 characters —— 必須是 App 級、不限當前打開的角色:
      // 雲端情緒評估的結果推回來時用戶常不在該角色聊天頁 (在別的角色 /
      // 列表 / 後台 / 還沒點進去). 之前只有 Chat.tsx 裡那個 `charId === activeCharacterId`
      // 守衛的 handler 同步內存, 不匹配就直接 return —— buff 只落了 DB, 內存沒更新; 而
      // OSContext 只在啟動時 getAllCharacters, 切回該角色也不重讀 DB, 於是 buff "回不到前端".
      // 更糟: 之後任一 updateCharacter 會拿舊內存合併寫回 DB, 把後台剛生成的 buff 抹掉.
      // 這裡無條件按事件 charId 更新內存 (DB 已由 applyEmotionEvalRaw 寫好), 順帶堵住反向覆蓋.
      const buffSyncHandler = (e: Event) => {
          const detail = (e as CustomEvent).detail as { charId?: string; buffs?: unknown; buffInjection?: unknown };
          const charId = detail?.charId;
          if (!charId) return;
          // 內存同步 + 雲端快照打髒合成一步。打髒放這裡的理由:
          //   1. 主鏈路回合收尾那次打髒跑在情緒評估落庫之前, 不補這一下雲端那份情緒恆慢一拍;
          //   2. 情緒廣播源不止一個 (本地評估 / 記憶潛水 / 雲端回寫), 全匯到這個事件,
          //      堵這一個點就夠, 不用去改每個上游。
          // 快照要的是合併後的角色, 所以跟 updateCharacter 一樣在 updater 裡取; 全局狀態讀 ref
          // 而不是閉包變量——本 effect 只在 sendProactiveNativeNotification 變化時重建, 閉包裡
          // 的 userProfile / groups / realtimeConfig 會一直停在首幀。
          const syncBuffIntoMemory = (
              nextBuffs: CharacterProfile['activeBuffs'],
              nextInjection: string | undefined,
          ) => {
              setCharacters(prev => prev.map(c => {
                  if (c.id !== charId) return c;
                  const next = normalizeCharacterImpression({ ...c, activeBuffs: nextBuffs, buffInjection: nextInjection });
                  markAmsgStateDirty({
                      char: next,
                      userProfile: userProfileRef.current,
                      groups: groupsRef.current,
                      realtimeConfig: realtimeConfigRef.current,
                  });
                  return next;
              }));
          };
          if (Array.isArray(detail.buffs)) {
              syncBuffIntoMemory(
                  detail.buffs as CharacterProfile['activeBuffs'],
                  typeof detail.buffInjection === 'string' ? detail.buffInjection : '',
              );
              return;
          }
          // 無 buffs 的純刷新信號 (runPushTailPipeline 等): 從 DB 兜底重讀該角色 buff.
          DB.getAllCharacters().then(all => {
              const updated = all.find(c => c.id === charId);
              if (!updated) return;
              syncBuffIntoMemory(updated.activeBuffs, updated.buffInjection);
          }).catch(() => {});
      };

      // 本地 fetch 聊天回覆的全局回落：triggerAI 的異步閉包在 Chat 卸載後繼續跑完
      // 並落庫，但它捕獲的 setMessages 指向已卸載的實例。這裡是它跟當前 UI 的唯一橋：
      //   - replyArrived（後處理管線全部落庫後）→ bump lastMsgTimestamp 讓當前掛載的
      //     Chat 重新 reloadMessages；用戶不在該會話時補未讀 + toast——與推送收件
      //     的 'active-msg-received' 行為對齊。
      //   - replyEnd（finally，含失敗路徑）→ 只 bump 時間戳，把 catch 裡落庫的
      //     錯誤系統消息也刷出來。
      const chatReplyArrivedHandler = (e: Event) => {
          const { charId, charName } = ((e as CustomEvent).detail || {}) as { charId?: string; charName?: string };
          if (!charId) return;
          setLastMsgTimestamp(Date.now());
          const isChattingWithThisChar = activeAppRef.current === AppID.Chat && activeCharIdScheduleRef.current === charId;
          if (!isChattingWithThisChar) {
              setUnreadMessages(prev => ({ ...prev, [charId]: (prev[charId] || 0) + 1 }));
              if (document.visibilityState === 'visible') {
                  addToast(`${charName || '角色'} 回覆了消息`, 'success');
              }
          }
      };
      const chatReplyEndHandler = () => {
          setLastMsgTimestamp(Date.now());
      };

      // 情緒評估失敗 → toast 告知（每角色 60s 冷卻防刷屏）。評估失敗過去只寫 console，
      // 用戶側表現是「情緒徽章閃一下就滅、情緒永不更新、沒有任何報錯」（真實反饋），
      // 完全沒法自查。事件來源：evaluateEmotionBackground（本地請求失敗/空響應）、
      // applyEmotionEvalRaw（解析全滅/落庫失敗）、activeMsgRuntime（worker 推回空結果）。
      const emotionFailToastAt: Record<string, number> = {};
      const emotionFailHandler = (e: Event) => {
          const { charId, charName, reason } = ((e as CustomEvent).detail || {}) as { charId?: string; charName?: string; reason?: string };
          if (!charId) return;
          const now = Date.now();
          if (now - (emotionFailToastAt[charId] || 0) < 60_000) return;
          emotionFailToastAt[charId] = now;
          addToast(`${charName || '角色'}的情緒評估失敗：${reason || '未知原因'}（不影響聊天回覆）`, 'error');
      };

      // 主動消息處理失敗很少發生，但如果靜默吞掉，用戶只會以為角色沒有理人。
      // 同一角色 60 秒內只提示一次，避免多條重試同時刷屏。
      const inboxFailToastAt: Record<string, number> = {};
      const inboxFailHandler = (e: Event) => {
          const { charId, charName, kind, note } = ((e as CustomEvent).detail || {}) as
              { charId?: string; charName?: string; kind?: 'retrying' | 'degraded' | 'swallowed' | 'schedule-missed'; note?: string };
          if (!charId) return;
          const now = Date.now();
          if (now - (inboxFailToastAt[charId] || 0) < 60_000) return;
          inboxFailToastAt[charId] = now;
          const who = charName || '角色';
          // note 是發起方按具體原因寫好的那句話（同一個 kind 底下可能有好幾種情況），
          // 有就用它，沒有才回落到按 kind 分的通用文案。
          const text = note
              ? `${who}：${note}`
              : kind === 'degraded'
                  ? `${who}有一條消息沒能正常處理，已按原文顯示（表情、卡片這些可能不完整）`
                  : kind === 'swallowed'
                      ? `${who}有一條定時消息被跳過了：本地存儲異常，判不出發出來會不會打斷你們當前的對話`
                      : kind === 'schedule-missed'
                          ? `${who}想改今天的日程但沒能改上，日程表還是原來的安排`
                          : `${who}有一條消息暫時沒能顯示，稍後會自動重試`;
          addToast(text, 'error');
      };

      // 上線補收時發現有消息超出了兩天的補收窗口，只銷帳沒能上屏。
      // 這條路是開 App 就自動跑的，銷完帳本就乾淨了——用戶之後去點「找回沒收到的消息」
      // 只會看到「帳本上沒有漏收的消息，這條鏈路是通的」，明明剛丟了東西。這一句是
      // 那件事唯一說得出口的地方，所以按 error 彈、也不做節流。
      const backfillStaleHandler = (e: Event) => {
          const { count } = ((e as CustomEvent).detail || {}) as { count?: number };
          if (!count) return;
          addToast(`有 ${count} 條消息超過兩天沒能收到，已經拿不回來了`, 'error');
      };

      // 記憶宮殿水位線觸發的全局提示：聊天/見面/通話共用同一條消息流，
      // pipeline 真正開始整理時會廣播此事件——無論用戶此刻在哪個 App，
      // 都統一彈「xx正在整理記憶」。
      const palaceProcessingHandler = (e: Event) => {
          const { charName, count } = ((e as CustomEvent).detail || {}) as { charName?: string; count?: number };
          addToast(`${charName || '角色'}正在整理記憶${count ? `（${count} 條對話）` : ''}…`, 'info');
      };

      window.addEventListener('active-msg-received', handler);
      window.addEventListener('active-msg-process-failed', inboxFailHandler);
      window.addEventListener('active-msg-backfill-stale', backfillStaleHandler);
      window.addEventListener('active-msg-progress', progressHandler);
      window.addEventListener('active-msg-open', openHandler);
      window.addEventListener('emotion-updated', buffSyncHandler);
      window.addEventListener(CHAT_GEN_EVENTS.replyArrived, chatReplyArrivedHandler);
      window.addEventListener(CHAT_GEN_EVENTS.replyEnd, chatReplyEndHandler);
      window.addEventListener(CHAT_GEN_EVENTS.emotionFailed, emotionFailHandler);
      window.addEventListener('memory-palace-processing', palaceProcessingHandler);
      document.addEventListener('visibilitychange', onVisible);
      return () => {
          window.removeEventListener('active-msg-received', handler);
          window.removeEventListener('active-msg-process-failed', inboxFailHandler);
          window.removeEventListener('active-msg-backfill-stale', backfillStaleHandler);
          window.removeEventListener('active-msg-progress', progressHandler);
          window.removeEventListener('active-msg-open', openHandler);
          window.removeEventListener('emotion-updated', buffSyncHandler);
          window.removeEventListener(CHAT_GEN_EVENTS.replyArrived, chatReplyArrivedHandler);
          window.removeEventListener(CHAT_GEN_EVENTS.replyEnd, chatReplyEndHandler);
          window.removeEventListener(CHAT_GEN_EVENTS.emotionFailed, emotionFailHandler);
          window.removeEventListener('memory-palace-processing', palaceProcessingHandler);
          document.removeEventListener('visibilitychange', onVisible);
      };
  }, [sendProactiveNativeNotification]);

  const proactiveRunningRef = useRef(false);
  const proactiveQueueRef = useRef<ProactiveQueueEntry[]>([]);
  // Per-character innerState cache for proactive turns — mirrors useChatAI's
  // evolvedNarrative state so consecutive proactive triggers carry continuity.
  const proactiveInnerStateRef = useRef<Map<string, string>>(new Map());

  // Refs to avoid stale closures in proactive callback
  const charactersRef = useRef(characters);
  charactersRef.current = characters;

  // 同步 charId → 角色名 註冊表，讓 utils 層（群聊背景注入等）能標出真實發言人名。
  useEffect(() => {
    setCharNameRegistry(characters);
  }, [characters]);
  const apiConfigRef = useRef(apiConfig);
  apiConfigRef.current = apiConfig;

  // Keep the MiniMax endpoint module in sync with the user's region choice
  // so every minimaxFetch() call reads the latest preference.
  useEffect(() => {
    setMinimaxRegion(apiConfig.minimaxRegion);
  }, [apiConfig.minimaxRegion]);
  // 同步 TTS 服務商選擇，讓拿不到 apiConfig 的地方（如 chatPrompts 語音格式指導）讀到最新值。
  useEffect(() => {
    setTtsProvider(apiConfig.ttsProvider);
  }, [apiConfig.ttsProvider]);
  // ElevenLabs 的 v3 與 Flash/Multilingual 使用不同的提示詞標記；prompt 構建器靠單例讀當前模型。
  useEffect(() => {
    setElevenLabsModel(apiConfig.elevenLabsModel);
  }, [apiConfig.elevenLabsModel]);
  // 同步用戶自定義語音表演指南（同上：chatPrompts 拿不到 apiConfig，靠單例讀最新值）。
  useEffect(() => {
    setVoicePromptOverrides(apiConfig.voicePrompts);
  }, [apiConfig.voicePrompts]);
  const userProfileRef = useRef(userProfile);
  userProfileRef.current = userProfile;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const realtimeConfigRef = useRef(realtimeConfig);
  realtimeConfigRef.current = realtimeConfig;
  const memoryPalaceConfigRef = useRef(memoryPalaceConfig);
  memoryPalaceConfigRef.current = memoryPalaceConfig;

  useEffect(() => {
      if (!isDataLoaded) return;

      const drainQueuedProactive = () => {
          const next = proactiveQueueRef.current.shift();
          if (next) {
              void runProactive(next.charId);
          }
      };

      const runProactive = async (charId: string) => {
          if (proactiveRunningRef.current) {
              const queuedIndex = proactiveQueueRef.current.findIndex(item => item.charId === charId);
              if (queuedIndex < 0) {
                  proactiveQueueRef.current.push({ charId });
              }
              return;
          }

          // Read from refs to always get latest values
          const currentCharacters = charactersRef.current;
          const currentApiConfig = apiConfigRef.current;
          const currentUserProfile = userProfileRef.current;
          const currentGroups = groupsRef.current;
          const currentRealtimeConfig = realtimeConfigRef.current;

          const char = currentCharacters.find(c => c.id === charId);
          if (!char) {
              drainQueuedProactive();
              return;
          }

          if (char.proactiveConfig && !char.proactiveConfig.enabled) {
              drainQueuedProactive();
              console.log(`🔕 [Proactive/Global] Skipped for ${char.name}: disabled`);
              return;
          }

          // 用戶正在 DateApp 裡和這個角色見面 —— 人就在對方眼前，再發一條
          // 線上主動消息既出戲又顯得對見面毫不知情。本輪靜默跳過；
          // lastFire 已在調度層記錄，下個週期會重新評估。
          if (activeAppRef.current === AppID.Date && activeCharIdScheduleRef.current === charId) {
              drainQueuedProactive();
              console.log(`🔕 [Proactive/Global] Skipped for ${char.name}: 正在見面 (DateApp active)`);
              return;
          }

          // 用戶正在和這個角色通話（含通話被掛起到後台）—— 通話裡再塞一條線上
          // 主動消息，不僅出戲，主動消息的提示詞還會汙染上下文、把後續語音
          // 帶成線上消息格式。本輪靜默跳過；下個週期會重新評估。
          if ((activeAppRef.current === AppID.Call && activeCharIdScheduleRef.current === charId)
              || suspendedCallRef.current?.charId === charId) {
              drainQueuedProactive();
              console.log(`🔕 [Proactive/Global] Skipped for ${char.name}: 正在通話 (CallApp active)`);
              return;
          }

          // 生效憑據優先級：角色開了「使用副 API」→ 那份副 API；否則 → 角色自己的對話模型
          // chatApi；否則 → 全局主 API。跟 activeMsgClient.ts 的 resolveApiConfig 同一個口徑——
          // 之前這裡直接跳到 currentApiConfig，角色明明設了專屬 chatApi，全局 API 一掛
          // 這裡的本地主動消息照樣全滅。
          const pCfg = char.proactiveConfig;
          const useSecondary = pCfg?.useSecondaryApi && pCfg.secondaryApi?.baseUrl;
          const api = useSecondary ? pCfg!.secondaryApi! : resolveCharacterChatApi(char, currentApiConfig);
          if (!api.baseUrl) {
              drainQueuedProactive();
              return;
          }

          proactiveRunningRef.current = true;
          setProactiveComposingChars(prev => prev[charId] ? prev : { ...prev, [charId]: true });
          console.log(`🔔 [Proactive/Global] Trigger fired for ${char.name}${useSecondary ? ' (副API)' : ''}`);

          try {
              // 1. Calculate time gap
              const recentMsgs = await DB.getRecentMessagesByCharId(charId, 200);
              const lastRealUserMsg = [...recentMsgs].reverse().find(
                  m => m.role === 'user' && !m.metadata?.proactiveHint
              );

              const now = new Date();
              const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

              let timeSinceUser = '';
              if (lastRealUserMsg) {
                  const gapMin = Math.floor((now.getTime() - lastRealUserMsg.timestamp) / 60000);
                  if (gapMin < 60) timeSinceUser = `${gapMin}分鐘`;
                  else if (gapMin < 1440) timeSinceUser = `${Math.floor(gapMin / 60)}小時${gapMin % 60 > 0 ? gapMin % 60 + '分鐘' : ''}`;
                  else timeSinceUser = `${Math.floor(gapMin / 1440)}天${Math.floor((gapMin % 1440) / 60)}小時`;
              }

              // 2. Save hidden system hint
              const userName = currentUserProfile?.name || '對方';

              // 見面（DateApp）感知：見面消息可能已被記憶宮殿高水位歸檔，上面 hwm 過濾後的
              // recentMsgs 會漏判，所以單獨用 includeProcessed=true 讀最後一條真實消息。
              // 剛見完面還發"你好久沒找我了"會顯得對見面毫不知情，換成見面後的語境。
              const lastRealMsgRaw = (await DB.getRecentMessagesByCharId(charId, 10, true))
                  .filter(m => !m.metadata?.proactiveHint)
                  .pop();
              const DATE_AFTERGLOW_MS = 3 * 60 * 60 * 1000;
              const justMetOffline = lastRealMsgRaw?.metadata?.source === 'date'
                  && (now.getTime() - lastRealMsgRaw.timestamp) < DATE_AFTERGLOW_MS;

              const hintContent = justMetOffline
                      ? `[系統提示（非${userName}發言）: 現在是 ${timeStr}。你和${userName}剛剛在線下見過面（如果上下文裡有標著 [約會] 的內容，那就是你們見面時發生的事），現在你們暫時分開了，你拿起手機想給${userName}發條消息。請基於剛才的見面來發——可以回味見面裡的某個細節、補一句當時沒說出口的話、關心${userName}到家了沒，或者就是剛分開就有點想念。絕對不要表現得好像很久沒聯繫，更不要對剛才的見面毫不知情。一兩句話就好。]`
                      : `[系統提示（非${userName}發言）: 現在是 ${timeStr}。${timeSinceUser ? `${userName}已經 ${timeSinceUser} 沒有找你說話了。` : ''}這是系統給你的一次主動發消息機會——${userName}並沒有在跟你說話，是你想主動找${userName}。像真人一樣隨意地發條消息吧，比如：隨手拍了張照片想分享、剛看到個有趣的事想說、突然想到個冷知識、吐槽今天的天氣/食物/見聞、或者就是單純想找${userName}聊幾句。不要刻意，不要像在"彙報近況"，就像你真的拿起手機隨手發了條消息。一兩句話就好。${timeSinceUser && parseInt(timeSinceUser) > 2 ? `（${userName}挺久沒找你了，你也可以表達想念、好奇${userName}在幹嘛、或者小小地抱怨一下。）` : ''}]`;

              await DB.saveMessage({
                  charId,
                  role: 'user',
                  type: 'text',
                  content: hintContent,
                  metadata: { proactiveHint: true, hidden: true }
              });

              // 3. Build prompt & message history — 走和 useChatAI / emotion eval 同一個 helper，
              //    保證三家拿到的"材料"完全一致；區別只在前面追加的"現在主動找用戶"那條 hint。
              const proactiveRange = await loadCharacterContextRange(char);
              if (proactiveRange.userBreakpointExpired) {
                  updateCharacter(charId, { contextUserStartMessageId: undefined });
              }
              const allMsgs = proactiveRange.messages;
              // 1.0 本地主動消息不會經過 Chat.tsx 的 aiVisibleEmojis。
              // 這裡既要過濾提示詞，也要過濾下方 [[SEND_EMOJI]] 的按名反查：
              // 只修提示詞仍擋不住模型複述舊上下文裡的表情名；只修落庫則模型仍會看到越權表情。
              // 2.0 推送路徑已在 activeMsgClient / activeMsgRuntime 做同樣的雙層收口。
              const { emojis, categories } = ChatPrompts.filterVisibleEmojis(
                  await DB.getEmojis(),
                  await DB.getEmojiCategories(),
                  charId,
              );

              // 上一輪緩存的意識流獨白 —— 主路徑用 React state，主動消息這裡用 ref Map
              const cachedInnerState = proactiveInnerStateRef.current.get(charId) || undefined;

              const payload = await buildChatRequestPayload({
                  char, userProfile: currentUserProfile!, groups: currentGroups,
                  emojis, categories,
                  historyMsgs: allMsgs,
                  contextLimit: Math.max(1, allMsgs.length),
                  recallEntryPoint: 'proactive_chat',
                  realtimeConfig: currentRealtimeConfig,
                  innerState: cachedInnerState,
                  // 實時音樂播放狀態 —— OSContext 在 MusicProvider 上層用不了 useMusic()，
                  // 走 MusicContext 暴露的模塊級快照（Provider mount 後會持續寫入）
                  musicSnapshot: loadMusicPlaybackSnapshot(),
                  // translationConfig / mcdMiniSnap 是 chat-app 會話級 UI 狀態，主動消息觸發時
                  // 不存在；保持 undefined 即可，與"用戶當時根本沒在 chat 界面"的語義一致
                  htmlMode: { enabled: !!(char as any).htmlModeEnabled, customPrompt: (char as any).htmlModeCustomPrompt },
                  thinkingChain: { enabled: !!(char as any).showThinkingChain, customPrompt: (char as any).thinkingChainCustomPrompt },
                  visionApiConfig: currentApiConfig.visionApi,
              });
              const systemPrompt = payload.systemPrompt;
              const apiMessages = payload.cleanedApiMessages;
              const fullMessages = payload.fullMessages;

              // 3c. 情緒評估 fire-and-forget — 與主 API 並行，沿用 useChatAI 的 API 選擇邏輯：
              //     角色專屬情緒 API > 主 apiConfig（與記憶宮殿副 API 完全獨立）
              if (!payload.flags.promptBuildSkipped && !isEmotionEvalSkipped() && isScheduleFeatureOn(char) && char.emotionConfig?.enabled) {
                  const emotionApi = (char.emotionConfig.api?.baseUrl)
                      ? char.emotionConfig.api
                      : { baseUrl: apiConfigRef.current.baseUrl, apiKey: apiConfigRef.current.apiKey, model: apiConfigRef.current.model };
                  if (emotionApi.baseUrl && currentUserProfile) {
                      evaluateEmotionBackground(char, currentUserProfile, systemPrompt, apiMessages, emotionApi)
                          .then((innerState) => {
                              if (innerState) proactiveInnerStateRef.current.set(charId, innerState);
                          })
                          .catch(() => {});
                  }
              }

              // 4. API call
              const baseUrl = api.baseUrl.replace(/\/+$/, '');
              const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` };
              const reqBody: any = { model: api.model, messages: fullMessages, temperature: 0.85, stream: false };
              // 思考鏈開啟時顯式向後端請求 extended thinking — 與 useChatAI 同步,
              // 不同代理認不同入口,全都試一遍,代理不識別的會自動忽略
              if (payload.flags.thinkingActive) {
                  const m: string = reqBody.model || '';
                  if (/^claude-/i.test(m) && !/-thinking$/i.test(m)) {
                      reqBody.model = `${m}-thinking`;
                  }
                  reqBody.thinking = { type: 'enabled', budget_tokens: 4000 };
                  reqBody.reasoning_effort = 'medium';
                  reqBody.extra_body = { ...(reqBody.extra_body || {}), thinking: { type: 'enabled', budget_tokens: 4000 } };
                  // 開思考時不帶採樣參數: Claude 系在 thinking 啟用時只接受 temperature=1，
                  // 傳 0.85 會被 400。刪掉用服務端默認；對非 Claude 模型同樣安全。
                  delete reqBody.temperature;
                  delete reqBody.top_p;
              }
              const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                  method: 'POST', headers,
                  body: JSON.stringify(reqBody)
              }, 2, 0, { appName: '消息', charId, charName: char.name, purpose: '主動消息' });

              // 5. Process & save response
              let aiContent = data.choices?.[0]?.message?.content || '';
              // 思考鏈抽取 — 與 useChatAI 保持一致:reasoning_content 字段 + 主 content 裡的 <think>/<thinking>/<thought> 塊,
              // 拼接後掛到本回合首條 assistant 消息的 metadata.thinkingChain
              let pendingThinkingChain: string | null = null;
              if (payload.flags.thinkingActive) {
                  const lastReasoning = (data?.choices?.[0]?.message?.reasoning_content || '').trim();
                  const thinkBlocks: string[] = [];
                  const thinkPat = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;
                  let tm: RegExpExecArray | null;
                  while ((tm = thinkPat.exec(aiContent)) !== null) {
                      const t = tm[2].trim();
                      if (t) thinkBlocks.push(t);
                  }
                  if (!/<\/(?:think|thinking|thought)>/i.test(aiContent)) {
                      const openOnly = aiContent.match(/<(?:think|thinking|thought)>([\s\S]*$)/i);
                      if (openOnly && openOnly[1].trim()) thinkBlocks.push(openOnly[1].trim());
                  }
                  const chain = [lastReasoning, ...thinkBlocks].filter(s => !!s).join('\n\n').trim();
                  if (chain) pendingThinkingChain = chain;
              }
              aiContent = aiContent.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/gi, '');
              aiContent = aiContent.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
              aiContent = aiContent.replace(/^[\w一-龥]+:\s*/, '');
              aiContent = aiContent.replace(/\s*\[(?:聊天|通[话話]|[约約][会會])\]\s*/g, '\n').trim();

              aiContent = normalizeProactiveAiContent(aiContent);

              const savedPreviewChunks: string[] = [];
              const baseTimestamp = Date.now();
              let offset = 0;
              // 思考鏈只掛到本回合首條 assistant 消息上,避免每個氣泡重複
              const consumeThinkingMeta = (): { thinkingChain: string } | undefined => {
                  if (!pendingThinkingChain) return undefined;
                  const meta = { thinkingChain: pendingThinkingChain };
                  pendingThinkingChain = null;
                  return meta;
              };

              // HTML 卡片：在 sanitize 之前抽出 [html]...[/html] 塊,與 useChatAI 保持一致。
              // 沒這一步主動消息會把整段 [html] 當純文本落庫,前端只能渲染成亂碼。
              if ((char as any).htmlModeEnabled && /\[html\]/i.test(aiContent)) {
                  const { blocks, cleanedContent } = extractHtmlBlocks(aiContent);
                  for (const blk of blocks) {
                      try {
                          const meta = consumeThinkingMeta();
                          await DB.saveMessage({
                              charId,
                              role: 'assistant',
                              type: 'html_card',
                              content: blk.textPreview ? `[HTML卡片] ${blk.textPreview}` : '[HTML卡片]',
                              timestamp: baseTimestamp + offset,
                              metadata: {
                                  htmlSource: blk.html,
                                  htmlTextPreview: blk.textPreview,
                                  ...(meta || {}),
                              },
                          } as any);
                          if (blk.textPreview) savedPreviewChunks.push(blk.textPreview);
                          offset += 1;
                      } catch (e) {
                          console.error('[Proactive/HTML] 落庫 html_card 失敗', e);
                      }
                  }
                  aiContent = cleanedContent;
              }

              aiContent = ChatParser.sanitize(aiContent);

              if (aiContent) {
                  // 雙語翻譯:沿用 useChatAI 的 <翻譯><原文>..</原文><譯文>..</譯文></翻譯> 協議,
                  // 把每對原文/譯文落成一條 text 消息,內容用 `\n%%BILINGUAL%%\n` 串聯供渲染端識別。
                  const hasTranslationTags = /<翻[译譯]>\s*<原文>[\s\S]*?<\/原文>\s*<[译譯]文>[\s\S]*?<\/[译譯]文>\s*<\/翻[译譯]>/.test(aiContent);

                  if (hasTranslationTags) {
                      // 表情包按模型寫的位置原地插發（與 applyAssistantPostProcessing 雙語分支同款修復）。
                      // 舊實現先把所有 [[SEND_EMOJI:]] 抽走、正文發完後統一追加到最後（還去了重），
                      // 表現為「翻譯模式下角色永遠最後才發表情包」。
                      const sendEmojiBubble = async (name: string): Promise<void> => {
                          const foundEmoji = emojis.find(e => e.name === name);
                          if (!foundEmoji?.url) return;
                          const meta = consumeThinkingMeta();
                          await DB.saveMessage({
                              charId,
                              role: 'assistant',
                              type: 'emoji',
                              content: foundEmoji.url,
                              timestamp: baseTimestamp + offset,
                              ...(meta ? { metadata: meta } : {}),
                          });
                          offset += 1;
                      };
                      // 翻譯標籤之外的普通文本段：splitResponse 按出現順序拆出文字 / 表情逐條發
                      const renderPlainSegment = async (segment: string): Promise<void> => {
                          for (const part of ChatParser.splitResponse(segment)) {
                              if (part.type === 'emoji') {
                                  await sendEmojiBubble(part.content);
                                  continue;
                              }
                              const cleaned = ChatParser.sanitize(part.content);
                              if (!cleaned || !ChatParser.hasDisplayContent(cleaned)) continue;
                              for (const chunk of ChatParser.chunkText(cleaned)) {
                                  if (!chunk) continue;
                                  const meta = consumeThinkingMeta();
                                  await DB.saveMessage({
                                      charId,
                                      role: 'assistant',
                                      type: 'text',
                                      content: chunk,
                                      timestamp: baseTimestamp + offset,
                                      ...(meta ? { metadata: meta } : {}),
                                  });
                                  savedPreviewChunks.push(chunk);
                                  offset += 1;
                              }
                          }
                      };

                      const tagPattern = /<翻[译譯]>\s*<原文>([\s\S]*?)<\/原文>\s*<[译譯]文>([\s\S]*?)<\/[译譯]文>\s*<\/翻[译譯]>/g;
                      let lastIndex = 0;
                      let tagMatch;
                      while ((tagMatch = tagPattern.exec(aiContent)) !== null) {
                          const textBefore = aiContent.slice(lastIndex, tagMatch.index).trim();
                          if (textBefore) await renderPlainSegment(textBefore);

                          // 混進 <原文>/<譯文> 裡的表情標籤剝出來，緊跟這條雙語氣泡之後發
                          const inlineEmojis: string[] = [];
                          const stripInlineEmoji = (s: string): string =>
                              s.replace(/\[\[SEND_EMOJI:\s*(.*?)\]\]/g, (_m, n) => { inlineEmojis.push(String(n).trim()); return ''; });
                          const originalText = ChatParser.sanitize(stripInlineEmoji(tagMatch[1]).trim());
                          const translatedText = ChatParser.sanitize(stripInlineEmoji(tagMatch[2]).trim());
                          if (originalText || translatedText) {
                              const biContent = originalText && translatedText
                                  ? `${originalText}\n%%BILINGUAL%%\n${translatedText}`
                                  : (originalText || translatedText);
                              const meta = consumeThinkingMeta();
                              await DB.saveMessage({
                                  charId,
                                  role: 'assistant',
                                  type: 'text',
                                  content: biContent,
                                  timestamp: baseTimestamp + offset,
                                  ...(meta ? { metadata: meta } : {}),
                              });
                              savedPreviewChunks.push(originalText || translatedText);
                              offset += 1;
                          }
                          for (const name of inlineEmojis) await sendEmojiBubble(name);

                          lastIndex = tagMatch.index + tagMatch[0].length;
                      }

                      const textAfter = aiContent.slice(lastIndex).trim();
                      if (textAfter) await renderPlainSegment(textAfter.replace(/<\/?翻[译譯]>|<\/?原文>|<\/?[译譯]文>/g, '').trim());
                  } else {
                      const responseParts = ChatParser.splitResponse(aiContent);

                      for (const part of responseParts) {
                          if (part.type === 'emoji') {
                              const foundEmoji = emojis.find(e => e.name === part.content);
                              if (foundEmoji?.url) {
                                  const meta = consumeThinkingMeta();
                                  await DB.saveMessage({
                                      charId,
                                      role: 'assistant',
                                      type: 'emoji',
                                      content: foundEmoji.url,
                                      timestamp: baseTimestamp + offset,
                                      ...(meta ? { metadata: meta } : {}),
                                  });
                              } else {
                                  const fallbackText = `發送了表情包：${part.content}`;
                                  const meta = consumeThinkingMeta();
                                  await DB.saveMessage({
                                      charId,
                                      role: 'assistant',
                                      type: 'text',
                                      content: fallbackText,
                                      timestamp: baseTimestamp + offset,
                                      ...(meta ? { metadata: meta } : {}),
                                  });
                                  savedPreviewChunks.push(fallbackText);
                              }
                              offset += 1;
                              continue;
                          }

                          const textChunks = ChatParser.chunkText(part.content)
                              .map(chunk => ChatParser.sanitize(chunk))
                              .filter(chunk => ChatParser.hasDisplayContent(chunk));

                          for (const chunk of textChunks) {
                              const meta = consumeThinkingMeta();
                              await DB.saveMessage({
                                  charId,
                                  role: 'assistant',
                                  type: 'text',
                                  content: chunk,
                                  timestamp: baseTimestamp + offset,
                                  ...(meta ? { metadata: meta } : {}),
                              });
                              savedPreviewChunks.push(chunk);
                              offset += 1;
                          }
                      }
                  }
              }

              if (offset > 0) {
                  const previewSource = savedPreviewChunks.join(' ').trim();
                  const preview = previewSource.replace(/\s+/g, ' ').trim().slice(0, 120)
                      || `${char.name} sent a proactive message`;

                  // 6. Notify OS for unread badge + toast
                  window.dispatchEvent(new CustomEvent('proactive-message-sent', {
                      detail: { charId, charName: char.name, body: preview }
                  }));
              }
          } catch (err) {
              console.error(`[Proactive/Global] Error for ${char.name}:`, err);
          } finally {
              proactiveRunningRef.current = false;
              setProactiveComposingChars(prev => {
                  if (!prev[charId]) return prev;
                  const next = { ...prev };
                  delete next[charId];
                  return next;
              });
              drainQueuedProactive();
          }
      };

      ProactiveChat.onTrigger((charId: string) => {
          void runProactive(charId);
      });

      // 「彼方」自主登入 —— 獨立調度，複用同一批 refs 拿最新狀態
      const runVR = async (charId: string, room?: string, letterId?: string, manual?: boolean, sarActivity?: VRSARActivity) => {
          const char = charactersRef.current.find(c => c.id === charId);
          // 調度表裡還排著隊，角色卻已經不接入了（或者壓根被刪了）：這條調度不該繼續存在。
          // 就地撤掉並留一行記錄 —— 不撤的話它會一直空轉，而空轉是完全靜默的，
          // 用戶那邊只看得到「明明全關了，調用記錄還在漲」，誰也說不清是哪一邊錯了。
          if (!char || !char.vrState?.enabled || (!manual && !allowsAutomaticVR(char.vrState))) {
              VRScheduler.stop(charId);
              void logVRApiCall({
                  ts: Date.now(), charId, charName: char?.name, ok: false, ms: 0,
                  kind: 'skipped', charEnabled: !!char?.vrState?.enabled,
                  note: char?.vrState?.enabled ? '角色僅手動活動，已撤掉這條殘留調度' : char ? '角色未接入彼方，已撤掉這條殘留調度' : '角色已不存在，已撤掉這條殘留調度',
              });
              return;
          }
          if (!userProfileRef.current) return;
          let outcome: VRSessionOutcome = 'skipped';
          try {
              const result = await runVRSession({
                  char,
                  characters: charactersRef.current,
                  apiConfig: apiConfigRef.current,
                  userProfile: userProfileRef.current,
                  groups: groupsRef.current,
                   realtimeConfig: realtimeConfigRef.current,
                   memoryPalaceConfig: memoryPalaceConfigRef.current,
                   updateCharacter,
                   updateUserProfile,
                   forcedRoom: room as any,
                  forcedSARActivity: sarActivity,
                  forcedLetterId: letterId,
                  manual,
              });
              // 沒書沒歌、房間被別人佔著這些都不算帳，只有真的沒調通模型才記一筆失敗
              outcome = result.ok ? 'ok' : (result.reason === 'api-error' ? 'failed' : 'skipped');
          } catch (e) {
              console.error('[VRWorld] runVR error', e);
              outcome = 'failed';
          }

          if (!allowsAutomaticVR(charactersRef.current.find(c => c.id === charId)?.vrState)) return;
          const { tripped, streak } = VRScheduler.report(charId, outcome);
          if (!tripped) return;
          // 熔斷了：調度已經被掐掉，這裡把角色一併落回未接入，讓界面和實際跑的東西對上，
          // 免得又變成「顯示未接入、後台還在動」。用函數式更新拿最新的 vrState，
          // 別拿會話開頭那份快照寫回去，那會把這一輪剛記下的房間和時間抹掉。
          void updateCharacter(charId, prev => ({
              vrState: { ...(prev.vrState || { intervalMinutes: VR_DEFAULT_INTERVAL_MIN }), enabled: false } as any,
          }));
          void logVRApiCall({
              ts: Date.now(), charId, charName: char.name, ok: false, ms: 0,
              kind: 'tripped',
              note: `連續 ${streak} 次沒能調通模型，已暫停 ${char.name} 的自主登入`,
          });
          addToast(`${char.name} 連續 ${streak} 次沒能調通模型，已暫停 ta 在彼方的自主登入`, 'error');
      };
      VRScheduler.onTrigger((charId: string, room?: string, letterId?: string, manual?: boolean, sarActivity?: VRSARActivity) => { void runVR(charId, room, letterId, manual, sarActivity); });

      // 以角色 vrState 為準對帳調度表：調度表存 localStorage、不隨備份遷移，
      // 導入備份后角色雖 enabled 但調度表為空，這裡補建/清理使其按時觸發。
      VRScheduler.reconcile(
          charactersRef.current
              .filter(c => allowsAutomaticVR(c.vrState))
              .map(c => ({ charId: c.id, intervalMinutes: c.vrState?.intervalMinutes || VR_DEFAULT_INTERVAL_MIN }))
      );

      // 「家園」演繹 —— 引擎跑在全局：用戶不在家園界面（可能正在和別人私聊）時，
      // 觀測/離線 tick 觸發的一輪鏈式演繹照樣完成並注入 world_card。
      const runWorld = async (worldId: string, trigger: 'observe' | 'tick') => {
          if (!userProfileRef.current) return;
          try {
              const world = await DB.getWorld(worldId);
              if (!world) return;
              await runWorldEpisode({
                  world,
                  characters: charactersRef.current,
                  apiConfig: apiConfigRef.current,
                  userProfile: userProfileRef.current,
                  groups: groupsRef.current,
                  realtimeConfig: realtimeConfigRef.current,
                  memoryPalaceConfig: memoryPalaceConfigRef.current,
                  trigger,
              });
          } catch (e) {
              console.error('[WorldHome] runWorld error', e);
          }
      };
      WorldScheduler.onTrigger((worldId, trigger) => { void runWorld(worldId, trigger); });

      // 單個角色重 roll（家園 WorldView 派發 world-reroll-request 事件，帶 worldId/charId/direction）
      const onRerollRequest = async (e: Event) => {
          const d = (e as CustomEvent).detail || {};
          if (!d.worldId || !d.charId || !userProfileRef.current) return;
          try {
              const world = await DB.getWorld(d.worldId);
              if (!world) return;
              await rerollWorldCharBeat({
                  world,
                  characters: charactersRef.current,
                  apiConfig: apiConfigRef.current,
                  userProfile: userProfileRef.current,
                  groups: groupsRef.current,
                  realtimeConfig: realtimeConfigRef.current,
                  memoryPalaceConfig: memoryPalaceConfigRef.current,
                  trigger: 'observe',
                  episodeId: d.episodeId,
                  charId: d.charId,
                  direction: d.direction,
              });
          } catch (err) {
              console.error('[WorldHome] reroll error', err);
          }
      };
      window.addEventListener('world-reroll-request', onRerollRequest as EventListener);
      // 調度表存 localStorage 不隨備份遷移，按 IndexedDB 裡的世界配置對帳
      void DB.getWorlds()
          .then(async worlds => {
              // 舊存檔（一天三段制）→ 四段制（含凌晨）一次性遷移並寫回
              for (const w of worlds) {
                  if (migrateWorldDaySegs(w)) await DB.saveWorld(w).catch(() => {});
              }
              WorldScheduler.reconcile(toTickEntries(worlds));
          })
          .catch(() => {});

      return () => {
          // Cleanup: detach proactive listeners when OSContext unmounts (unlikely but safe)
          ProactiveChat.onTrigger(() => {});
          VRScheduler.onTrigger(() => {});
          WorldScheduler.onTrigger(() => {});
          window.removeEventListener('world-reroll-request', onRerollRequest as EventListener);
      };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDataLoaded]);

  // ─── utils 層直寫 DB 後的內存回灌 ───
  // 這兩條路都在 React 之外把角色寫進了 IndexedDB。不回灌的話內存裡那份角色停在舊值，
  // 之後隨便哪個 updateCharacter 都會拿舊內存合併寫回，把剛寫進去的東西反向抹掉
  // （情緒 buff 早就踩過這個坑，見上面 buffSyncHandler 的註釋），雲端快照也跟著停格。
  useEffect(() => {
      // 角色自排後續任務被採納（「湯燉上了，兩小時後叫你」）：任務清單隻落在 DB，
      // React 不知情會同時斷掉 presence 門、打髒門和麵板上的待觸發清單三條線。
      const tasksAdoptedHandler = (e: Event) => {
          const charId = ((e as CustomEvent).detail || {}).charId as string | undefined;
          if (!charId) return;
          void DB.getAllCharacters().then(all => {
              const fresh = all.find(c => c.id === charId);
              if (!fresh) return;
              setCharacters(prev => prev.map(c => {
                  if (c.id !== charId) return c;
                  // 只把 activeMsg2Config 這一個字段搬回來：整對象覆蓋會讓內存裡其它更新的
                  // 字段（比如同一時刻剛落地的情緒）倒退，反過來用舊內存整對象寫 DB 又會把
                  // 剛採納的任務清單抹掉。
                  const next = normalizeCharacterImpression({ ...c, activeMsg2Config: fresh.activeMsg2Config });
                  markAmsgStateDirty({
                      char: next,
                      userProfile: userProfileRef.current,
                      groups: groupsRef.current,
                      realtimeConfig: realtimeConfigRef.current,
                  });
                  return next;
              }));
          }).catch(() => {});
      };

      // 聽歌時角色把歌加進自己的歌單（MusicContext 直寫 DB）：歌單進 fire_pack，
      // 不打髒角色到點還以為那首歌沒收藏過。
      const musicProfileSyncHandler = (e: Event) => {
          const detail = ((e as CustomEvent).detail || {}) as { charId?: string; musicProfile?: CharacterProfile['musicProfile'] };
          const { charId, musicProfile } = detail;
          if (!charId || !musicProfile) return;
          setCharacters(prev => prev.map(c => {
              if (c.id !== charId) return c;
              const next = normalizeCharacterImpression({ ...c, musicProfile });
              markAmsgStateDirty({
                  char: next,
                  userProfile: userProfileRef.current,
                  groups: groupsRef.current,
                  realtimeConfig: realtimeConfigRef.current,
              });
              return next;
          }));
      };

      // Push / 彼方 / 家園等 React 外入口完成全自動記憶雙寫後，只把增量搬回內存。
      // 再基於當前 state 保存一次，堵住後台 DB 寫入和前台角色更新同時發生時的反向覆蓋。
      const memoryAutoArchiveSyncHandler = (e: Event) => {
          const detail = ((e as CustomEvent).detail || {}) as MemoryAutoArchiveSyncDetail;
          if (!detail.charId) return;
          setCharacters(prev => prev.map(character => {
              if (character.id !== detail.charId) return character;
              const nextMemories = detail.fragments.length > 0
                  ? mergePalaceFragmentsIntoMemories(character.memories || [], detail.fragments)
                  : (character.memories || []);
              const currentHide = character.hideBeforeMessageId || 0;
              const nextHide = Math.max(currentHide, detail.hideBeforeMessageId || 0);
              if (nextMemories === character.memories && nextHide === currentHide) return character;
              const next = normalizeCharacterImpression({
                  ...character,
                  memories: nextMemories,
                  ...(nextHide > currentHide ? { hideBeforeMessageId: nextHide } : {}),
              });
              DB.saveCharacter(next).then(() => {
                  markAmsgStateDirty({
                      char: next,
                      userProfile: userProfileRef.current,
                      groups: groupsRef.current,
                      realtimeConfig: realtimeConfigRef.current,
                  });
              }).catch(error => console.warn('[AutoArchive] state sync save failed', error));
              return next;
          }));
      };

      window.addEventListener('amsg2-tasks-adopted', tasksAdoptedHandler);
      const linkedArchiveDeletedHandler = (event: Event) => {
          const detail = (event as CustomEvent<LinkedArchiveDeletionDetail>).detail;
          if (!detail?.charId || !detail.nodeId || !['delete', 'keep'].includes(detail.choice)) return;
          setCharacters(previous => previous.map(character => {
              if (character.id !== detail.charId) return character;
              const next = { ...character, memories: applyLinkedArchiveDeletion(character.memories || [], detail.nodeId, detail.choice) };
              // The deletion transaction already persisted this delta. Refresh context/cloud state only.
              markAmsgStateDirty({ char: next, userProfile: userProfileRef.current, groups: groupsRef.current, realtimeConfig: realtimeConfigRef.current });
              return next;
          }));
      };
      window.addEventListener(LINKED_ARCHIVE_DELETED, linkedArchiveDeletedHandler);
      window.addEventListener('char-music-profile-updated', musicProfileSyncHandler);
      window.addEventListener(MEMORY_AUTO_ARCHIVE_SYNC_EVENT, memoryAutoArchiveSyncHandler);
      return () => {
          window.removeEventListener('amsg2-tasks-adopted', tasksAdoptedHandler);
          window.removeEventListener(LINKED_ARCHIVE_DELETED, linkedArchiveDeletedHandler);
          window.removeEventListener('char-music-profile-updated', musicProfileSyncHandler);
          window.removeEventListener(MEMORY_AUTO_ARCHIVE_SYNC_EVENT, memoryAutoArchiveSyncHandler);
      };
  }, []);

  // 舊版本曾在 Push 後處理裡只寫宮殿、沒寫神經鏈接。每個角色升級後保守修一次：
  // 只補“最後一條 palace 日誌之後整天完全空白”的聊天提取節點，不調 API、不動水位線。
  useEffect(() => {
      if (!isDataLoaded) return;
      let cancelled = false;
      const runRepair = async () => {
          const enabledCharacters = characters.filter(character => (
              character.memoryPalaceEnabled && character.autoArchiveEnabled
          ));
          for (const character of enabledCharacters) {
              if (cancelled) return;
              const marker = `mp_autoArchiveDualWriteRepair_v1_${character.id}`;
              if (localStorage.getItem(marker) === '1') continue;
              try {
                  await repairMissingAutoArchiveMemories(character.id);
                  if (!cancelled) localStorage.setItem(marker, '1');
              } catch (error) {
                  console.warn('[AutoArchiveRepair] failed', character.id, error);
              }
          }
      };
      void runRepair();
      return () => { cancelled = true; };
  // 只在本次數據初始化完成時執行；後續新數據走已修復的統一雙寫入口。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDataLoaded]);

  const updateTheme = async (updates: Partial<OSTheme>) => {
    const { wallpaper, lockWallpaper, launcherWidgetImage, launcherWidgets, desktopDecorations, customFont, ...styleUpdates } = updates;
    // Legacy slots are banned — never let them enter state, regardless of caller intent.
    const sanitizedWidgets = launcherWidgets !== undefined
        ? Object.fromEntries(Object.entries(launcherWidgets).filter(([k]) => k !== 'bl' && k !== 'br'))
        : undefined;
    const sanitizedUpdates: Partial<OSTheme> = { ...updates, launcherWidgetImage: undefined };
    if (sanitizedWidgets !== undefined) sanitizedUpdates.launcherWidgets = sanitizedWidgets;
    const newTheme = { ...theme, ...sanitizedUpdates, launcherWidgetImage: undefined };
    if (newTheme.launcherWidgets) {
        const w = { ...newTheme.launcherWidgets };
        delete w['bl'];
        delete w['br'];
        newTheme.launcherWidgets = Object.keys(w).length > 0 ? w : undefined;
    }
    // 壁紙改存 Blob：把指針（令牌）落庫並解析成可渲染 url 後再進 state。
    // theme.wallpaper 在內存裡始終是能直接喂 CSS 的值（objectURL / http / 漸變），
    // 不是 blobref 令牌。
    if (wallpaper !== undefined) {
        const legacyWallpaper = isLegacyDefaultWallpaper(wallpaper);
        const preserveNostalgia = shouldPreserveLegacyDefaultWallpaper(wallpaper, newTheme.desktopVariant);
        newTheme.wallpaper = await resolveWallpaperStoredValue(wallpaper, preserveNostalgia);
        if (legacyWallpaper && !preserveNostalgia) Object.assign(newTheme, migrateLegacyDefaultPalette(newTheme));
    }
    if ('lockWallpaper' in updates) {
        newTheme.lockWallpaper = await resolveLockWallpaperStoredValue(lockWallpaper);
    }
    setTheme(newTheme);

    // Legacy single-image asset is permanently banned — always delete, never save.
    await DB.deleteAsset('launcherWidgetImage');

    // Save widget images to IndexedDB (each slot is a separate asset)
    // 值是 blobref 令牌（寫端見 apps/Appearance.tsx 的 handleWidgetUpload），一律原樣落庫。
    // 別按 data: 前綴挑著存——令牌不帶這個前綴，挑的結果是這張圖只剩 localStorage 一份，
    // 啟動時 assets 那份是空的、界面上小組件直接沒了。
    if (launcherWidgets !== undefined) {
        for (const slot of LAUNCHER_WIDGET_SLOTS) {
            const val = sanitizedWidgets?.[slot];
            if (val) {
                await DB.saveAsset(`widget_${slot}`, val);
            } else {
                await DB.deleteAsset(`widget_${slot}`);
            }
        }
        // Always purge deprecated slot assets so old data can never resurface.
        await DB.deleteAsset('widget_bl');
        await DB.deleteAsset('widget_br');
    }

    // Save desktop decoration images to IndexedDB
    if (desktopDecorations !== undefined) {
        // Clean up old decoration assets first
        const allAssets = await DB.getAllAssets();
        const oldDecoKeys = allAssets.filter(a => a.id.startsWith('deco_')).map(a => a.id);
        for (const key of oldDecoKeys) {
            await DB.deleteAsset(key);
        }
        // Save new decoration images
        if (desktopDecorations) {
            for (const deco of desktopDecorations) {
                if (deco.content && deco.content.startsWith('data:') && deco.type === 'image') {
                    await DB.saveAsset(`deco_${deco.id}`, deco.content);
                }
            }
        }
    }

    // Logic for Font: Differentiate between Data URI (Blob) and URL (Web Font)
    // Use `in` check so an explicit `customFont: undefined` (user-initiated reset)
    // still triggers the reset branch — `customFont !== undefined` would skip it.
    if ('customFont' in updates) {
        if (customFont && customFont.startsWith('data:')) {
            // Blob: Save to DB, Apply
            await DB.saveAsset('custom_font_data', customFont);
            applyCustomFont(customFont);
        } else if (customFont && (customFont.startsWith('http') || customFont.startsWith('https'))) {
            // Web URL: Clear Blob from DB, Apply, Save to LS (via cleanTheme below)
            await DB.deleteAsset('custom_font_data');
            applyCustomFont(customFont);
        } else {
            // Reset
            await DB.deleteAsset('custom_font_data');
            applyCustomFont(undefined);
        }
    }

    // Save lightweight settings to LocalStorage (strip data URIs & blob object URLs)
    // blob: objectURL 是本次會話臨時的，重啟後失效——不能進 LS，清空讓加載路徑從 assets 重新解析。
    const lsTheme = { ...newTheme };
    if (lsTheme.wallpaper && (lsTheme.wallpaper.startsWith('data:') || lsTheme.wallpaper.startsWith('blob:'))) lsTheme.wallpaper = '';
    if (lsTheme.lockWallpaper && (lsTheme.lockWallpaper.startsWith('data:') || lsTheme.lockWallpaper.startsWith('blob:'))) lsTheme.lockWallpaper = undefined;
    // Banned legacy field — never persist.
    lsTheme.launcherWidgetImage = undefined;
    // Strip data URIs and deprecated slots from widgets for LS
    if (lsTheme.launcherWidgets) {
        const cleanWidgets: Record<string, string> = {};
        for (const [k, v] of Object.entries(lsTheme.launcherWidgets)) {
            if (k === 'bl' || k === 'br') continue;
            cleanWidgets[k] = (v && v.startsWith('data:')) ? '' : v;
        }
        lsTheme.launcherWidgets = cleanWidgets;
    }

    // Strip data URIs from desktop decorations for LS
    if (lsTheme.desktopDecorations) {
        lsTheme.desktopDecorations = lsTheme.desktopDecorations.map(d => ({
            ...d,
            content: (d.content && d.content.startsWith('data:') && d.type === 'image') ? '' : d.content
        }));
    }

    // Clear data URI font from LS, keep URL font
    if (lsTheme.customFont && lsTheme.customFont.startsWith('data:')) lsTheme.customFont = '';

    try {
        localStorage.setItem('os_theme', JSON.stringify(lsTheme));
    } catch (e) {
        // quota 滿時靜默失敗 = 用戶這次看著正常、下次啟動主題回初始。必須讓用戶知道。
        console.warn('[updateTheme] localStorage 寫入失敗', e);
        addToast('主題沒能保存到本地（存儲空間可能已滿），重啟後可能會還原', 'error');
    }
  };
  const updateApiConfig = (updates: Partial<APIConfig>) => { const newConfig = normalizeApiConfig({ ...apiConfig, ...updates }); setApiConfig(newConfig); localStorage.setItem('os_api_config', JSON.stringify(newConfig)); };
  const updateRealtimeConfig = (updates: Partial<RealtimeConfig>) => { const newConfig = { ...realtimeConfig, ...updates }; setRealtimeConfig(newConfig); localStorage.setItem('os_realtime_config', JSON.stringify(newConfig)); };

  // Cloud Backup functions
  const updateCloudBackupConfig = (updates: Partial<CloudBackupConfig>) => {
      const newConfig = { ...cloudBackupConfig, ...updates };
      setCloudBackupConfig(newConfig);
      localStorage.setItem('os_cloud_backup_config', JSON.stringify(newConfig));
  };

  // Backup provider router — picks the right client module based on
  // cloudBackupConfig.provider ('github' or 'webdav', defaulting to webdav
  // for back-compat with users who configured before the GitHub option).
  const loadBackupProvider = async () => {
      if (cloudBackupConfig.provider === 'github') {
          return await import('../utils/githubClient');
      }
      return await import('../utils/webdavClient');
  };

  const cloudBackupToWebDAV = async (mode: 'text_only' | 'media_only' | 'full') => {
      const { uploadBackup, cleanupOldBackups } = await loadBackupProvider();
      try {
          setSysOperation({ status: 'processing', message: '正在打包備份數據...', progress: 0 });
          const blob = await exportSystem(mode);

          setSysOperation({ status: 'processing', message: '正在上傳到雲端...', progress: 50 });
          const filename = `Sully_Backup_${mode}_${Date.now()}.zip`;
          const result = await uploadBackup(cloudBackupConfig, blob, filename, (pct) => {
              setSysOperation(prev => ({ ...prev, message: `上傳中 ${pct}%...`, progress: 50 + pct * 0.45 }));
          });

          if (!result.ok) {
              throw new Error(result.message);
          }

          // Update last backup time
          updateCloudBackupConfig({ lastBackupTime: Date.now(), lastBackupSize: blob.size });

          // Cleanup old backups (keep latest 5)
          await cleanupOldBackups(cloudBackupConfig, 5).catch(() => {});

          setSysOperation({ status: 'idle', message: '', progress: 100 });
          addToast('雲端備份完成', 'success');
          // provider / mode 都是代碼裡寫死的枚舉；連接地址、帳號、錯誤原文一概不帶。
          trackEvent('上传备份到云端', {
              provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav',
              mode,
              result: '成功',
          });
      } catch (e: any) {
          setSysOperation({ status: 'idle', message: '', progress: 0 });
          addToast(`雲端備份失敗: ${e.message}`, 'error');
          trackEvent('上传备份到云端', {
              provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav',
              mode,
              result: '失败',
          });
          throw e;
      }
  };

  const cloudRestoreFromWebDAV = async (file: CloudBackupFile) => {
      const { downloadBackup } = await loadBackupProvider();
      try {
          setSysOperation({ status: 'processing', message: '正在從雲端下載...', progress: 0 });
          const blob = await downloadBackup(cloudBackupConfig, file, (pct) => {
              setSysOperation(prev => ({ ...prev, message: `下載中 ${pct}%...`, progress: pct * 0.5 }));
          });

          if (!blob) throw new Error('下載失敗');

          setSysOperation({ status: 'processing', message: '正在恢復數據...', progress: 50 });
          const zipFile = new File([blob], file.name, { type: 'application/zip' });
          await importSystem(zipFile);
      } catch (e: any) {
          setSysOperation({ status: 'idle', message: '', progress: 0 });
          addToast(`雲端恢復失敗: ${e.message}`, 'error');
          throw e;
      }
  };

  const listCloudBackups = async (): Promise<CloudBackupFile[]> => {
      const { listBackups } = await loadBackupProvider();
      return listBackups(cloudBackupConfig);
  };

  const updateMemoryPalaceConfig = (updates: Partial<MemoryPalaceGlobalConfig>) => {
    const newConfig = normalizeMemoryPalaceConfig({
      ...memoryPalaceConfig,
      ...updates,
      embedding: { ...memoryPalaceConfig.embedding, ...(updates.embedding || {}) },
      lightLLM: { ...memoryPalaceConfig.lightLLM, ...(updates.lightLLM || {}) },
      rerank: { ...memoryPalaceConfig.rerank, ...(updates.rerank || {}) },
      featureFlags: { ...memoryPalaceConfig.featureFlags, ...(updates.featureFlags || {}) },
    });
    setMemoryPalaceConfig(newConfig);
    localStorage.setItem('os_memory_palace_config', JSON.stringify(newConfig));
  };

  // 情緒 API 同步到所有角色：API 字段（baseUrl/apiKey/model）所有角色共用，
  // 各角色自身的 enabled 標誌保持不變。
  // 注意：與記憶宮殿副 API（memoryPalaceConfig.lightLLM）完全獨立，兩者各管各的。
  const syncEmotionApiToAllCharacters = (api: { baseUrl: string; apiKey: string; model: string } | undefined) => {
    setCharacters(prev => {
      const updated = prev.map(c => {
        const prevEmotion = c.emotionConfig;
        const nextEmotion = {
          enabled: !!prevEmotion?.enabled,
          ...(api && api.baseUrl ? { api: { baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model } } : {}),
        };
        const next = normalizeCharacterImpression({ ...c, emotionConfig: nextEmotion });
        DB.saveCharacter(next);
        return next;
      });
      return updated;
    });
  };
  const updateRemoteVectorConfig = (updates: Partial<typeof defaultRemoteVectorConfig>) => {
    const newConfig = { ...remoteVectorConfig, ...updates };
    setRemoteVectorConfig(newConfig);
    localStorage.setItem('os_remote_vector_config', JSON.stringify(newConfig));
  };
  const saveModels = (models: string[]) => {
      const safeModels = normalizeModelIds(models);
      setAvailableModels(safeModels);
      localStorage.setItem('os_available_models', JSON.stringify(safeModels));
  };
  const addApiPreset = (name: string, config: APIConfig) => { setApiPresets(prev => { const next = [...prev, normalizeApiPreset({ id: Date.now().toString(), name, config })]; localStorage.setItem('os_api_presets', JSON.stringify(next)); return next; }); };
  const updateApiPreset = (id: string, name: string, config: APIConfig) => { setApiPresets(prev => { const next = prev.map(p => p.id === id ? normalizeApiPreset({ ...p, name, config }) : p); localStorage.setItem('os_api_presets', JSON.stringify(next)); return next; }); };
  const removeApiPreset = (id: string) => { setApiPresets(prev => { const next = prev.filter(p => p.id !== id); localStorage.setItem('os_api_presets', JSON.stringify(next)); return next; }); };
  const savePresets = (presets: ApiPreset[]) => { const normalized = presets.map(normalizeApiPreset); setApiPresets(normalized); localStorage.setItem('os_api_presets', JSON.stringify(normalized)); };
  const addCharacter = async () => {
    const name = 'New Character';
    // 默認開啟 emotionConfig.enabled，讓"開日程 = 開情緒"這條隱含約定對新角色也成立。
    // 真正的閘門是 (isScheduleFeatureOn && emotionConfig.enabled)，schedule 沒開
    // 時副 API 不會觸發，所以這裡默認 true 安全。
    // 注意：memoryPalaceEnabled 不在這裡默認開 —— 那是用戶在記憶宮殿 App 顯式 opt-in
    // 的功能，自動開會替用戶決策。
    const newChar: CharacterProfile = {
      id: `char-${Date.now()}`,
      name,
      avatar: generateAvatar(name),
      description: '點擊編輯設定...',
      systemPrompt: '',
      memories: [],
      contextLimit: DEFAULT_MANUAL_CONTEXT_LIMIT,
      contextRangeMode: 'manual',
      contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
      emotionConfig: { enabled: true },
    };
    setCharacters(prev => [...prev, newChar]);
    setActiveCharacterId(newChar.id);
    await DB.saveCharacter(newChar);
    return newChar;
  };
  const updateCharacter = async (id: string, updates: Partial<CharacterProfile> | ((prev: CharacterProfile) => Partial<CharacterProfile>)) => {
    setCharacters(prev => {
      const updated = prev.map(c => c.id === id ? normalizeCharacterImpression({ ...c, ...(typeof updates === 'function' ? updates(c) : updates) }) : c);
      const target = updated.find(c => c.id === id);
      if (target) {
        const before = prev.find(c => c.id === id);
        // 落庫成功後給 amsg2 雲端快照打髒：改人設 / 改記憶 / 面板取消任務等所有落庫路徑都
        // 匯到這裡，不打的話雲端 fire_pack 停在上一輪聊天，角色到點拿舊世界說話。
        // markDirty 內部自帶「沒開 2.0 / 沒掛 AI 任務就 return」的門，普通角色零成本。
        DB.saveCharacter(target).then(() => {
          markAmsgStateDirty({ char: target, userProfile, groups, realtimeConfig });
          // 時區和名字是另一條路：它們凍在遠端任務行裡，fire_pack 刷新蓋不到。
          // 上游按任務行的 tzId 推進循環任務的下次觸發時刻；fixed 模式的推送標題也直接
          // 讀任務行的 contactName。只刷真的變了的那幾項，別搭別的操作的便車。
          const timeZone = resolveCharTimeZone(before) !== resolveCharTimeZone(target);
          const contactName = !!before && before.name !== target.name;
          if (timeZone || contactName) {
            ActiveMsgClient.refreshCharPendingTaskRow(target, { timeZone, contactName }).catch((error) => {
              console.warn('[amsg2] 角色資料變更後刷新遠端任務行失敗', target.id, error);
            });
          }
        });
      }
      return updated;
    });
  };

  // 角色在聊天裡用 [[ACTION:RELATIONSHIP|…]] 改了「角色認為的關係」：後處理那邊拿不到
  // updateCharacter，發事件過來由這裡寫回（見 utils/chatRelationship.ts）。走 ref 拿最新的
  // updateCharacter，免得打髒雲端快照時用到第一次渲染時的舊 userProfile。
  const updateCharacterRef = useRef(updateCharacter);
  updateCharacterRef.current = updateCharacter;
  useEffect(() => {
      const onRelationshipChange = (event: Event) => {
          const detail = (event as CustomEvent<CharRelationshipChangeDetail>).detail;
          if (!detail?.charId || !detail.relationship) return;
          void updateCharacterRef.current(detail.charId, { charViewRelationship: detail.relationship });
      };
      window.addEventListener(CHAR_RELATIONSHIP_CHANGE_EVENT, onRelationshipChange);
      return () => window.removeEventListener(CHAR_RELATIONSHIP_CHANGE_EVENT, onRelationshipChange);
  }, []);

  const deleteCharacter = async (id: string, options?: { force?: boolean }): Promise<DeleteCharacterResult> => {
    const target = characters.find(c => c.id === id);
    // 主動消息 2.0 的任務活在用戶自己的 worker 上，不隨本地角色刪除消失：留著的話
    // 到點照樣跑一整輪生成 + 推送，用戶會收到一個已經刪掉的角色發來的消息（還每次
    // 真燒一輪 LLM）。本地記錄一刪就再沒有 uuid 可取消，所以必須趕在刪除之前清。
    // 沒排過任務的角色不發任何請求。
    const localTaskUuids = (target?.activeMsg2Config?.tasks ?? [])
      .map(t => t.taskUuid);

    // 雲端善後擋在本地刪除**前面**：早前丟後台跑的版本在斷網 / 秒關 App 時根本跑不完，
    // 任務殘留下來，之後「已刪角色」的推送還會彈出來。名下真有任務（本地清單有、或遠端
    // 查得到）的角色才付這次等待，清不掉就先不刪本地、把選擇權交回給調用方；
    // 從沒配過 2.0 或沒填 worker 地址的角色一個請求都不發，路徑跟原來一樣快。
    if (!options?.force && charMayHaveCloudState(target)) {
      let workerConfigured = false;
      try {
        workerConfigured = Boolean((await ActiveMsgStore.getGlobalConfig()).workerUrl?.trim());
      } catch { /* 配置讀不到按沒配處理，與 purgeCharCloudState 同口徑 */ }

      if (workerConfigured) {
        // 有沒有任務以遠端清單優先（cancelAllTasksForChar 內部先查遠端、查不到才退回
        // 本地清單）——只看本地會漏掉排程記錄丟失的幽靈任務。
        let hadTasks = localTaskUuids.length > 0;
        let cleanupFailed = false;
        try {
          const { targets, failed } = await ActiveMsgClient.cancelAllTasksForChar(id, localTaskUuids);
          hadTasks = hadTasks || targets.length > 0;
          cleanupFailed = failed.size > 0;
        } catch (err) {
          console.warn('[deleteCharacter] 遠端主動消息任務清理失敗', err);
          cleanupFailed = true;
        }

        if (hadTasks) {
          if (!cleanupFailed) {
            // 任務取消掉了，雲端還留著這個角色的 client_state —— 那裡面是完整的角色系統
            // 提示詞加最近 30 條對話原文（fire_pack）。刪除確認框寫的是「記憶將被清空」，
            // 那就得連雲端那份一起清，不然聊天記錄會一直躺在 D1 裡、每刪一個角色再堆一份。
            const cloudCleanup = await purgeCharCloudState(target);
            if (cloudCleanup.status === 'failed') {
              console.warn('[deleteCharacter] 雲端狀態清理失敗', cloudCleanup.error);
              cleanupFailed = true;
            }
          }
          if (cleanupFailed) {
            // 雲端沒清乾淨：本地先不刪。調用方（角色 App）負責彈「重試 / 仍然刪除」。
            return { status: 'cloud-cleanup-failed' };
          }
        } else {
          // 名下沒有任務：不會再有推送，client_state 清理維持舊節奏丟後台，不擋刪除。
          void (async () => {
            const cloudCleanup = await purgeCharCloudState(target);
            if (cloudCleanup.status === 'failed') {
              console.warn('[deleteCharacter] 雲端狀態清理失敗（角色照常刪除）', cloudCleanup.error);
              addToast('ta 在雲端的聊天上下文沒能清掉，可以去設置裡「清除雲端狀態」兜一下', 'error');
            }
          })();
        }
      }
    } else if (options?.force && charMayHaveCloudState(target)) {
      // 「仍然刪除」放行後仍舊盡力清一次：能清掉多少算多少，失敗只提示、不再攔。
      void (async () => {
        try {
          if (localTaskUuids.length > 0) {
            const { failed } = await ActiveMsgClient.cancelAllTasksForChar(id, localTaskUuids);
            if (failed.size > 0) {
              addToast(`ta 還有 ${failed.size} 個主動消息任務留在遠端沒取消掉，可能仍會到點推送——可以去設置裡「清除雲端狀態」兜一下`, 'error');
            }
          }
          const cloudCleanup = await purgeCharCloudState(target);
          if (cloudCleanup.status === 'failed') {
            console.warn('[deleteCharacter] 雲端狀態清理失敗（角色照常刪除）', cloudCleanup.error);
            addToast('ta 在雲端的聊天上下文沒能清掉，可以去設置裡「清除雲端狀態」兜一下', 'error');
          }
        } catch (err) {
          console.warn('[deleteCharacter] 遠端主動消息任務清理失敗', err);
          addToast('ta 的主動消息任務沒能在遠端取消，可能仍會到點推送，請檢查 Worker 連接', 'error');
        }
      })();
    }

    setCharacters(prev => { const remaining = prev.filter(c => c.id !== id); if (remaining.length > 0 && activeCharacterId === id) { setActiveCharacterId(remaining[0].id); } return remaining; });
    await DB.deleteCharacter(id);
    // 表情分類不隨角色級聯刪除會留下「幽靈專屬包」：單聊面板被可見性過濾掉（刪不掉），
    // 群聊面板/提示詞卻還能看到。刪完角色順手按剩餘角色清一次殘留（詳見 DB.cleanupEmojiResidue）。
    try {
        const remainingIds = characters.filter(c => c.id !== id).map(c => c.id);
        const report = await DB.cleanupEmojiResidue(remainingIds);
        if (report.removedCategories.length > 0) {
            addToast(`已連帶清理 ta 的專屬表情分類：${report.removedCategories.map(c => `「${c.name}」`).join('')}`, 'info');
        }
    } catch (err) {
        console.warn('[deleteCharacter] 表情包殘留清理失敗（不影響角色刪除）', err);
    }
    return { status: 'deleted' };
  };

  // NPC 檔案（神經鏈接「NPC」分頁）。刻意不帶 amsg2/雲端善後那一整套——NPC 沒有
  // 主動消息任務、沒有云端 client_state，本地增刪改直接落庫即可。
  const addNPC = async (): Promise<NPCProfile> => {
    const name = '新 NPC';
    const now = Date.now();
    const newNpc: NPCProfile = {
      id: `npc-${now}`,
      name,
      avatar: generateAvatar(name),
      description: '',
      relationships: [],
      createdAt: now,
      updatedAt: now,
    };
    setNpcs(prev => [...prev, newNpc]);
    await DB.saveNPC(newNpc);
    return newNpc;
  };

  const updateNPC = (id: string, updates: Partial<NPCProfile> | ((prev: NPCProfile) => Partial<NPCProfile>)) => {
    setNpcs(prev => {
      const updated = prev.map(n => n.id === id
        ? { ...n, ...(typeof updates === 'function' ? updates(n) : updates), updatedAt: Date.now() }
        : n);
      const target = updated.find(n => n.id === id);
      if (target) DB.saveNPC(target);
      return updated;
    });
  };

  const deleteNPC = async (id: string) => {
    setNpcs(prev => prev.filter(n => n.id !== id));
    await DB.deleteNPC(id);
  };

  // 角色分組方法（神經鏈接"文件夾"）
  const createCharacterGroup = async (name: string): Promise<CharacterGroup | null> => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const newGroup: CharacterGroup = { id: `cgroup-${Date.now()}`, name: trimmed, createdAt: Date.now() };
      await DB.saveCharacterGroup(newGroup);
      setCharacterGroups(prev => [...prev, newGroup]);
      return newGroup;
  };

  const renameCharacterGroup = async (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      let target: CharacterGroup | undefined;
      setCharacterGroups(prev => {
          const updated = prev.map(g => g.id === id ? { ...g, name: trimmed } : g);
          target = updated.find(g => g.id === id);
          return updated;
      });
      if (target) await DB.saveCharacterGroup(target);
  };

  // 刪分組 = 組內角色回落「未分組」+ 刪分組定義本身，角色不受影響
  const deleteCharacterGroup = async (id: string) => {
      setCharacters(prev => prev.map(c => {
          if (c.groupId !== id) return c;
          const next = { ...c, groupId: undefined };
          DB.saveCharacter(next);
          return next;
      }));
      await DB.deleteCharacterGroup(id);
      setCharacterGroups(prev => prev.filter(g => g.id !== id));
  };

  // Group Methods

  // 群的名字和成員名單都會進每個成員的 fire_pack（角色知道自己在哪些群、群裡都有誰），
  // 群一變就要讓受影響的成員各刷一次雲端快照，否則角色到點還按舊群名 / 舊成員說話。
  // nextGroups 傳變更後的完整 groups 列表：markDirty 存的是快照，拿舊列表等於沒改。
  const markGroupMembersDirty = (memberIds: string[], nextGroups: GroupProfile[]) => {
      for (const memberId of new Set(memberIds)) {
          const member = characters.find(c => c.id === memberId);
          if (member) markAmsgStateDirty({ char: member, userProfile, groups: nextGroups, realtimeConfig });
      }
  };

  const createGroup = async (name: string, members: string[]) => {
      const newGroup: GroupProfile = {
          id: `group-${Date.now()}`,
          name,
          members,
          avatar: generateAvatar(name),
          createdAt: Date.now()
      };
      await DB.saveGroup(newGroup);
      setGroups(prev => [...prev, newGroup]);
      markGroupMembersDirty(newGroup.members, [...groups, newGroup]);
  };

  const updateGroup = async (id: string, updates: Partial<GroupProfile>) => {
      // 先更新內存中的 groups（列表渲染、再次進群都讀這裡），再持久化到 DB。
      // 不更新 context 會導致改了群頭像/群名退出後又讀回舊值（恢復默認）。
      setGroups(prev => prev.map(g => g.id === id ? { ...g, ...updates } : g));
      // 持久化對象基於當前已提交的 groups 合成，不在 setGroups 的 updater 裡捕獲——
      // React 不保證 updater 同步執行（eager 求值只是優化），舊寫法會時而拿到舊值、
      // 時而整個跳過 saveGroup，表現為"內存已更新、退出重進設置丟失"。
      const base = groups.find(g => g.id === id);
      if (!base) return;
      const nextGroup = { ...base, ...updates };
      await DB.saveGroup(nextGroup);
      // 老成員也要打髒：被移出群的角色，他那份快照裡的群名單同樣得把這個群去掉。
      markGroupMembersDirty(
          [...base.members, ...nextGroup.members],
          groups.map(g => g.id === id ? nextGroup : g),
      );
  };

  const deleteGroup = async (id: string) => {
      const removed = groups.find(g => g.id === id);
      await DB.deleteGroup(id);
      setGroups(prev => prev.filter(g => g.id !== id));
      if (removed) markGroupMembersDirty(removed.members, groups.filter(g => g.id !== id));
  };

  // Worldbook Methods
  const addWorldbook = async (wb: Worldbook) => {
      setWorldbooks(prev => [...prev, wb]);
      await DB.saveWorldbook(wb);
  };

  const mutateWorldbooks = async (ids: string[], updates: Partial<Worldbook> | null) => {
      const result = await DB.mutateWorldbooks(ids, updates);
      const removed = new Set(ids);
      const replacements = new Map(result.books.map(book => [book.id, book]));
      setWorldbooks(prev => updates === null
          ? prev.filter(book => !removed.has(book.id))
          : prev.map(book => replacements.get(book.id) || book));
      const mounted = new Map(result.characters.map(char => [char.id, char.mountedWorldbooks]));
      setCharacters(prev => prev.map(char => mounted.has(char.id)
          ? { ...char, mountedWorldbooks: mounted.get(char.id) }
          : char));
      result.characters.forEach(char => markAmsgStateDirty({ char, userProfile, groups, realtimeConfig }));
  };

  const updateWorldbooks = (ids: string[], updates: Partial<Worldbook>) => mutateWorldbooks(ids, updates);
  const deleteWorldbooks = (ids: string[]) => mutateWorldbooks(ids, null);
  const updateWorldbook = (id: string, updates: Partial<Worldbook>) => updateWorldbooks([id], updates);
  const deleteWorldbook = async (id: string) => {
      await deleteWorldbooks([id]);
      addToast('世界書已刪除 (同步移除角色掛載)', 'success');
  };

  // Novel Methods (New)
  const addNovel = async (novel: NovelBook) => {
      setNovels(prev => [novel, ...prev]);
      await DB.saveNovel(novel);
  };

  const updateNovel = async (id: string, updates: Partial<NovelBook>) => {
      setNovels(prev => {
          const next = prev.map(n => n.id === id ? { ...n, ...updates, lastActiveAt: Date.now() } : n);
          const target = next.find(n => n.id === id);
          if (target) DB.saveNovel(target);
          return next;
      });
  };

  const deleteNovel = async (id: string) => {
      setNovels(prev => prev.filter(n => n.id !== id));
      await DB.deleteNovel(id);
  };

  // Song Methods
  const addSong = async (song: SongSheet) => {
      setSongs(prev => [song, ...prev]);
      await DB.saveSong(song);
  };

  const updateSong = async (id: string, updates: Partial<SongSheet>) => {
      setSongs(prev => {
          const next = prev.map(s => s.id === id ? { ...s, ...updates, lastActiveAt: Date.now() } : s);
          const target = next.find(s => s.id === id);
          if (target) DB.saveSong(target);
          return next;
      });
  };

  const deleteSong = async (id: string) => {
      setSongs(prev => prev.filter(s => s.id !== id));
      await DB.deleteSong(id);
  };

  const updateUserProfile = async (updates: Partial<UserProfile> | ((prev: UserProfile) => Partial<UserProfile>)) => {
       setUserProfileBase(prev => {
           const patch = typeof updates === 'function' ? updates(prev) : updates;
           const next = { ...prev, ...patch };
          // 用戶資料是所有角色共享的素材（名字、人設直接烤進 fire_pack 模板），改完不打髒的話
          // 角色到點還按舊名字叫你。仿表情庫：逐個打髒，沒開 2.0 的角色被 markDirty 的門篩掉。
          // 傳 next（未套用任何身份的那份）——markAmsgStateDirtyForAll 會按每個角色自己的
          // 分角色身份指定各自解析，雲端主動消息才會看到那個角色該看到的那張身份卡的名字。
          DB.saveUserProfile(next).then(() => {
              markAmsgStateDirtyForAll({ characters, userProfileBase: next, groups, realtimeConfig });
          });
          return next;
      });
  };

  const addUserPersona = async (input: Omit<UserPersona, 'id' | 'createdAt' | 'updatedAt'>): Promise<UserPersona> => {
      const now = Date.now();
      const persona: UserPersona = { ...input, id: `persona-${now}-${Math.random().toString(36).slice(2, 7)}`, createdAt: now, updatedAt: now };
      await updateUserProfile(prev => ({ personas: [...(prev.personas || []), persona] }));
      return persona;
  };

  const updateUserPersona = async (id: string, updates: Partial<Omit<UserPersona, 'id' | 'createdAt'>>) => {
      await updateUserProfile(prev => ({
          personas: (prev.personas || []).map(p => p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p),
      }));
  };

  const deleteUserPersona = async (id: string) => {
      await updateUserProfile(prev => ({
          personas: (prev.personas || []).filter(p => p.id !== id),
          // 刪掉的正好是目前生效的身份卡時，回落到真實身份，別讓 activePersonaId 懸空指向不存在的卡。
          activePersonaId: prev.activePersonaId === id ? undefined : prev.activePersonaId,
      }));
  };

  const setActivePersonaId = async (id: string | undefined) => {
      await updateUserProfile({ activePersonaId: id });
  };
  const addCustomTheme = async (theme: ChatTheme) => { setCustomThemes(prev => { const exists = prev.find(t => t.id === theme.id); if (exists) return prev.map(t => t.id === theme.id ? theme : t); return [...prev, theme]; }); await DB.saveTheme(theme); };
  const removeCustomTheme = async (id: string) => { setCustomThemes(prev => prev.filter(t => t.id !== id)); await DB.deleteTheme(id); };
  const setCustomIcon = async (appId: string, iconUrl: string | undefined) => {
      const stored = iconUrl?.startsWith('data:') ? await migrateDataUrlToRef(iconUrl) : iconUrl;
      setCustomIcons(prev => {
          const next = { ...prev };
          if (stored) next[appId] = stored;
          else delete next[appId];
          return next;
      });
      if (stored) await DB.saveAsset(`icon_${appId}`, stored);
      else await DB.deleteAsset(`icon_${appId}`);
  };
  const addToast = (message: string, type: Toast['type'] = 'info') => { const id = Date.now().toString(); setToasts(prev => [...prev, { id, message, type }]); setTimeout(() => { setToasts(prev => prev.filter(t => t.id !== id)); }, 3000); };
  const showError = (title: string, details: string) => {
      setErrorDialog({ title, details });
      // showError 是分發型入口，title 由調用方傳。這裡寫顯式白名單：
      // 只有下面這兩個寫死的 title 會上報，其它（含以後新加的）一律不發，
      // 也絕不把 title 原樣透傳出去（免得哪天有人往裡塞 URL 或報錯原文）。
      if (title === '導入失敗') trackEvent('弹出报错详情弹窗', { 报错来源: '导入失败' });
      else if (title === '雲端恢復失敗') trackEvent('弹出报错详情弹窗', { 报错来源: '云端恢复失败' });
  };
  const dismissError = () => { setErrorDialog(null); };

  // --- APPEARANCE PRESETS ---
  const saveAppearancePreset = async (name: string, themeOverride?: OSTheme) => {
      // theme.wallpaper 在內存裡是 blob: objectURL（會話臨時），不能存進預設。
      // 換成 assets 'wallpaper' 裡的持久指針（blobref 令牌 / http / 漸變）。
      const presetTheme: OSTheme = { ...(themeOverride || theme) };
      if (presetTheme.wallpaper && presetTheme.wallpaper.startsWith('blob:')) {
          presetTheme.wallpaper = (await DB.getAsset('wallpaper')) || '';
      }
      if (presetTheme.lockWallpaper?.startsWith('blob:')) {
          presetTheme.lockWallpaper = (await DB.getAsset('lock_wallpaper')) || undefined;
      }
      const preset: AppearancePreset = {
          id: `ap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name,
          createdAt: Date.now(),
          theme: presetTheme,
          customIcons: Object.keys(customIcons).length > 0 ? { ...customIcons } : undefined,
          chatThemes: customThemes.length > 0 ? [...customThemes] : undefined,
      };
      setAppearancePresets(prev => [preset, ...prev]);
      await DB.saveAsset(`appearance_preset_${preset.id}`, JSON.stringify(preset));
      addToast(`外觀預設「${name}」已保存`, 'success');
  };

  const applyAppearancePreset = async (id: string) => {
      const preset = appearancePresets.find(p => p.id === id);
      if (!preset) return;
      // Strip banned legacy widget data from preset before applying — old beautification packs
      // may still carry launcherWidgetImage / bl / br, and they must never reach the UI.
      const sanitizedPresetTheme: any = { ...preset.theme, launcherWidgetImage: undefined };
      if (sanitizedPresetTheme.launcherWidgets) {
          const w = { ...sanitizedPresetTheme.launcherWidgets } as Record<string, string>;
          delete w['bl'];
          delete w['br'];
          sanitizedPresetTheme.launcherWidgets = Object.keys(w).length > 0 ? w : undefined;
      }
      // 小組件圖落進 assets 的 widget_*：啟動加載時這張表會蓋掉 localStorage 裡那份，
      // 應用預設時不寫它，下次啟動看到的就還是上一套主題的小組件。
      // 別人分享來的預設裡可能還壓著 base64，先轉成令牌再落庫（跟下面 customIcons 一個做法）。
      {
          const presetWidgets = (sanitizedPresetTheme.launcherWidgets || {}) as Record<string, string>;
          const persistedWidgets: Record<string, string> = {};
          for (const slot of LAUNCHER_WIDGET_SLOTS) {
              const val = presetWidgets[slot];
              if (val) {
                  const stored = val.startsWith('data:') ? await migrateDataUrlToRef(val) : val;
                  persistedWidgets[slot] = stored;
                  await DB.saveAsset(`widget_${slot}`, stored);
              } else {
                  await DB.deleteAsset(`widget_${slot}`);
              }
          }
          sanitizedPresetTheme.launcherWidgets = Object.keys(persistedWidgets).length > 0 ? persistedWidgets : undefined;
      }
      // 壁紙改存 Blob：把預設裡的指針（blobref 令牌 / 舊 data:）落庫並解析成 objectURL 再進 state。
      if (sanitizedPresetTheme.wallpaper !== undefined && typeof sanitizedPresetTheme.wallpaper === 'string') {
          const legacyWallpaper = isLegacyDefaultWallpaper(sanitizedPresetTheme.wallpaper);
          const preserveNostalgia = shouldPreserveLegacyDefaultWallpaper(
              sanitizedPresetTheme.wallpaper,
              sanitizedPresetTheme.desktopVariant,
          );
          sanitizedPresetTheme.wallpaper = await resolveWallpaperStoredValue(sanitizedPresetTheme.wallpaper, preserveNostalgia);
          if (legacyWallpaper && !preserveNostalgia) {
              Object.assign(sanitizedPresetTheme, migrateLegacyDefaultPalette(sanitizedPresetTheme));
          }
      }
      if ('lockWallpaper' in sanitizedPresetTheme) {
          sanitizedPresetTheme.lockWallpaper = await resolveLockWallpaperStoredValue(sanitizedPresetTheme.lockWallpaper);
      }
      // Apply theme
      setTheme(sanitizedPresetTheme);
      // 寫 LS 前必須剝 data URI / blob: objectURL，否則 base64 壁紙撐爆 quota、blob: 重啟即失效
      const lsTheme: any = { ...sanitizedPresetTheme };
      if (lsTheme.wallpaper && typeof lsTheme.wallpaper === 'string' && (lsTheme.wallpaper.startsWith('data:') || lsTheme.wallpaper.startsWith('blob:'))) lsTheme.wallpaper = '';
      if (lsTheme.lockWallpaper && typeof lsTheme.lockWallpaper === 'string' && (lsTheme.lockWallpaper.startsWith('data:') || lsTheme.lockWallpaper.startsWith('blob:'))) lsTheme.lockWallpaper = undefined;
      lsTheme.launcherWidgetImage = undefined;
      if (lsTheme.launcherWidgets) {
          const cleanWidgets: Record<string, string> = {};
          for (const [k, v] of Object.entries(lsTheme.launcherWidgets as Record<string, string>)) {
              if (k === 'bl' || k === 'br') continue;
              cleanWidgets[k] = (v && v.startsWith('data:')) ? '' : v;
          }
          lsTheme.launcherWidgets = cleanWidgets;
      }
      if (lsTheme.desktopDecorations) {
          lsTheme.desktopDecorations = lsTheme.desktopDecorations.map((d: any) => ({
              ...d,
              content: (d.content && typeof d.content === 'string' && d.content.startsWith('data:') && d.type === 'image') ? '' : d.content,
          }));
      }
      if (lsTheme.customFont && typeof lsTheme.customFont === 'string' && lsTheme.customFont.startsWith('data:')) lsTheme.customFont = '';
      try {
          localStorage.setItem('os_theme', JSON.stringify(lsTheme));
      } catch (e) {
          // 靜默跳過 = 預設這次看著已應用、下次啟動卻回初始主題。必須提示。
          console.warn('[applyAppearancePreset] localStorage 寫入失敗，已跳過', e);
          addToast('主題沒能保存到本地（存儲空間可能已滿），重啟後可能會還原', 'error');
      }
      applyCustomFont(preset.theme.customFont);
      // Apply custom icons if present
      if (preset.customIcons) {
          const persistedIcons: Record<string, string> = {};
          for (const [appId, iconUrl] of Object.entries(preset.customIcons)) {
              const stored = iconUrl.startsWith('data:') ? await migrateDataUrlToRef(iconUrl) : iconUrl;
              persistedIcons[appId] = stored;
              await DB.saveAsset(`icon_${appId}`, stored);
          }
          setCustomIcons(persistedIcons);
      }
      // Apply chat themes if present
      // 預設裡的氣泡主題可能還壓著 base64（老預設、別人分享來的包）。原樣寫回 themes 表
      // 等於把一鍵優化剛轉走的圖又倒回去——用戶會看到「優化完過陣子又漲回來了」。
      // 所以落庫前先轉成令牌，內存裡也用轉完的那份：不然下次存預設又把 base64 抄進去，
      // 繞成一個圈。上面 customIcons 那段本來就是這麼做的，這裡跟它對齊。
      if (preset.chatThemes) {
          const migratedThemes: ChatTheme[] = [];
          for (const ct of preset.chatThemes) {
              const migrated = await migrateChatThemeBlobRefs(ct);
              migratedThemes.push(migrated);
              await DB.saveTheme(migrated);
          }
          setCustomThemes(prev => {
              const merged = [...prev];
              for (const ct of migratedThemes) {
                  const idx = merged.findIndex(t => t.id === ct.id);
                  if (idx >= 0) merged[idx] = ct;
                  else merged.push(ct);
              }
              return merged;
          });
      }
      // 壁紙指針已在上面 resolveWallpaperStoredValue 裡落庫（令牌→assets），此處不再重複寫。
      if (preset.theme.desktopDecorations) {
          for (const d of preset.theme.desktopDecorations) {
              if (d.type === 'image' && d.content) {
                  await DB.saveAsset(`deco_${d.id}`, d.content);
              }
          }
      }
      addToast(`已應用預設「${preset.name}」`, 'success');
  };

  const deleteAppearancePreset = async (id: string) => {
      setAppearancePresets(prev => prev.filter(p => p.id !== id));
      await DB.deleteAsset(`appearance_preset_${id}`);
      addToast('預設已刪除', 'info');
  };

  // 一鍵還原外觀：把主題、圖標、壁紙、小組件、裝飾、字體全部回到出廠狀態。
  // 用戶在不同版本/不同備份之間反覆導入時，customIcons 與 IndexedDB 裡的 widget_/deco_/icon_
  // 殘留經常導致圖標錯亂，這裡直接整體清空再寫回 default。
  // 已保存的外觀預設不動，用戶隨時還能切回去。
  const resetAppearance = async () => {
      try {
          await resolveLockWallpaperStoredValue(undefined);
          setTheme(defaultTheme);
          applyCustomFont(undefined);

          const iconAppIds = Object.keys(customIcons);
          setCustomIcons({});
          for (const appId of iconAppIds) {
              await DB.deleteAsset(`icon_${appId}`);
          }
          // 自定義的主屏圖標也在 customIcons 裡（_pwa_），但它額外往 DOM 注入過一條
          // apple-touch-icon / manifest，刪數據不會把注入撤掉——不撤的話頁面上那條還掛著
          // 已經不存在的圖標，直到下次刷新。
          clearPwaIcon();

          const allAssets = await DB.getAllAssets();
          for (const asset of allAssets) {
              const id = asset.id;
              if (
                  id === 'wallpaper' ||
                  id === 'lock_wallpaper' ||
                  id === 'launcherWidgetImage' ||
                  id === 'custom_font_data' ||
                  id.startsWith('widget_') ||
                  id.startsWith('deco_') ||
                  id.startsWith('icon_')
              ) {
                  await DB.deleteAsset(id);
              }
          }

          try {
              localStorage.setItem('os_theme', JSON.stringify(defaultTheme));
          } catch (e) {
              console.warn('[resetAppearance] localStorage 寫入失敗', e);
          }

          addToast('外觀已還原為初始狀態', 'success');
      } catch (e: any) {
          addToast(e?.message || '還原失敗', 'error');
      }
  };

  const renameAppearancePreset = async (id: string, name: string) => {
      setAppearancePresets(prev => prev.map(p => {
          if (p.id !== id) return p;
          const updated = { ...p, name };
          DB.saveAsset(`appearance_preset_${id}`, JSON.stringify(updated));
          return updated;
      }));
      addToast('預設已重命名', 'success');
  };

  const exportAppearancePreset = async (id: string): Promise<Blob> => {
      const preset = appearancePresets.find(p => p.id === id);
      if (!preset) throw new Error('預設不存在');
      // 預設裡的壁紙可能是 blobref 令牌（本機 blob_assets），導出到別的設備會失效——
      // 先深拷貝再把令牌解析回 data:image，保證導出文件自包含可移植。
      const exportPreset = deepCloneForExport(preset);
      await resolveBlobRefsDeep(exportPreset);
      // 保留原始壁紙畫質，把整個預設 JSON 塞進 zip 包壓體積
      const data = JSON.stringify({ type: 'sully_appearance_preset', version: 1, ...exportPreset }, null, 2);
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      (zip as any).file('preset.json', data);
      return (zip as any).generateAsync(
          { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } },
      );
  };

  const importAppearancePreset = async (file: File): Promise<void> => {
      // 兼容兩種格式：新版 .zip（內含 preset.json）/ 舊版 .json 明文
      let raw: any;
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      const isZip = head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);
      if (isZip) {
          const JSZip = await loadJSZip();
          const zip = await JSZip.loadAsync(file);
          const entry = zip.file('preset.json') || Object.values((zip as any).files || {}).find((f: any) => !f.dir && /\.json$/i.test(f.name));
          if (!entry) throw new Error('壓縮包內未找到 preset.json');
          const text = await (entry as any).async('string');
          raw = JSON.parse(text);
      } else {
          const text = await file.text();
          raw = JSON.parse(text);
      }
      if (raw.type !== 'sully_appearance_preset') throw new Error('無效的外觀預設文件');
      const preset = await migrateAppearancePresetBlobRefs({
          id: `ap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: raw.name || '導入的預設',
          createdAt: Date.now(),
          theme: raw.theme,
          customIcons: raw.customIcons,
          chatThemes: raw.chatThemes,
          chatLayout: raw.chatLayout,
      } as AppearancePreset);
      setAppearancePresets(prev => [preset, ...prev]);
      await DB.saveAsset(`appearance_preset_${preset.id}`, JSON.stringify(preset));
      addToast(`已導入預設「${preset.name}」`, 'success');
  };

  // --- MODIFIED EXPORT SYSTEM WITH SEPARATED ASSETS ZIP ---
  const exportSystem = async (mode: 'text_only' | 'media_only' | 'full'): Promise<Blob> => {
      try {
          setSysOperation({ status: 'processing', message: '正在初始化打包引擎...', progress: 0 });
          
          const JSZip = await loadJSZip();
          const zip = new JSZip();
          const assetsFolder = zip.folder("assets");
          let assetCount = 0;
          let malformedImageCount = 0;
          const malformedImageDiagnostics: MalformedBackupImageDiagnostic[] = [];
          const maxMalformedImageDiagnostics = 100;

          // Dedup table — same base64 payload reused across stores (角色頭像在
          // 多個 chat / handbook / room 裡被嵌入) gets stored exactly once. Key
          // is the base64 string itself, value is the assets/* path. For a
          // heavy user with 50 chats sharing a 200KB avatar this trims ~10MB.
          const assetDedupMap = new Map<string, string>();

          // v3 blob 旁路：blobref 令牌原樣進 JSON，這裡從每段真正落包的 JSON 文本里收集
          // 令牌（backupFormat 的 onSerialized 鉤子），打包收尾把對應 Blob 直寫 blobs/*。
          // 從落包文本收集 = 沒有「哪些 store 要處理」的名單可漏，嵌套 JSON 字符串裡的
          // 令牌（如 assets 表的 appearance_preset_*）也逐字可見。text_only 令牌已剝空，不收。
          const referencedBlobTokens = new Set<string>();
          const collectSerialized = mode === 'text_only'
              ? undefined
              : (s: string) => collectBlobRefs(s, referencedBlobTokens);

          // Strip Base64 Images (Recursive) - Used for Text Only Mode
          const stripBase64 = stripBackupImages;

          const stripTextOnlyMedia = (obj: any): any => {
              const stripped = stripBase64(obj);
              const markExpiredCallSnapshots = (value: any): void => {
                  if (Array.isArray(value)) {
                      value.forEach(markExpiredCallSnapshots);
                      return;
                  }
                  if (!value || typeof value !== 'object') return;
                  const metadata = value.metadata;
                  if (metadata && typeof metadata === 'object'
                      && Object.prototype.hasOwnProperty.call(metadata, 'cameraSnapshotRef')) {
                      delete metadata.cameraSnapshotRef;
                      metadata.cameraSnapshotExpired = true;
                  }
              };
              markExpiredCallSnapshots(stripped);
              return stripped;
          };

          // 把一條 data:image base64 落進 ZIP 的 assets/ 文件夾，返回它的 assets/* 路徑。
          // 同一份 base64 全局只存一份（assetDedupMap 按完整 base64 去重）。無法識別但
          // 不一定損壞的 data url 原樣保留；確認損壞的正文只在導出副本里置空。
          const resolveImage = (value: string, location: string): string => {
              try {
                  const cached = assetDedupMap.get(value);
                  if (cached) return cached;
                  const parsed = parseImageDataUrlForBackup(value);
                  if (!parsed.ok) {
                      // SVG、帶額外 MIME 參數等本來就不走 assets/* 的 data URL 沿用舊行為，
                      // 原樣留在 JSON，也不把它誤報成「損壞圖片」。
                      if (parsed.reason === 'unsupported-header') return value;
                      malformedImageCount++;
                      if (malformedImageDiagnostics.length < maxMalformedImageDiagnostics) {
                          malformedImageDiagnostics.push({
                              location,
                              reason: parsed.reason,
                              originalLength: value.length,
                          });
                      }
                      // 壞 Base64 已無法還原；不把正文寫進 assets 或備份 JSON，避免恢復後繼續
                      // 傳播髒數據。這裡只修改 IDB 結構化克隆/運行態深拷貝，不會改用戶本地庫。
                      console.warn(`[Backup] 損壞圖片已從導出副本跳過: ${location} (${parsed.reason}, ${value.length} chars)`);
                      return '';
                  }
                  const filename = `asset_${Date.now()}_${assetCount++}.${parsed.extension}`;
                  // JPEG/PNG/WebP/GIF 本身已壓縮，再跑 DEFLATE 只會浪費手機 CPU；直接存儲。
                  assetsFolder?.file(filename, parsed.base64, { base64: true, compression: 'STORE' });
                  const path = `assets/${filename}`;
                  assetDedupMap.set(value, path);
                  return path;
              } catch (e) {
                  console.warn("Failed to process asset", e);
                  return value;
              }
          };

          // Extract Images to ZIP (in-place) - Used for Media/Theme Mode.
          // 原地把 base64 換成 assets/* 路徑，不再另建一棵對象樹，導出大 store 時峰值內存更省。
          // 傳進來的必須是獨立副本：store 數據是 IDB 結構化克隆副本（安全）；theme /
          // customIcons / appearancePresets 引用了運行態 state，已在上面 backupData 裡深拷貝。
          const processObject = (obj: any, source = 'backupData'): any => {
              const safeRecordId = (value: unknown): string | null => {
                  if (typeof value !== 'string' && typeof value !== 'number') return null;
                  return String(value).replace(/[\r\n]/g, ' ').slice(0, 80);
              };
              const describeLocation = (path: BackupObjectPath): string => {
                  let label = source;
                  let pathStart = 0;
                  if (Array.isArray(obj) && typeof path[0] === 'number') {
                      const index = path[0];
                      const row = obj[index];
                      const id = row && typeof row === 'object'
                          ? safeRecordId((row as any).id ?? (row as any).uuid ?? (row as any).key)
                          : null;
                      label += `[${index}]${id ? `(id=${id})` : ''}`;
                      pathStart = 1;
                  } else if (obj && typeof obj === 'object' && !source.includes('(id=')) {
                      const id = safeRecordId((obj as any).id ?? (obj as any).uuid ?? (obj as any).key);
                      if (id) label += `(id=${id})`;
                  }
                  for (const segment of path.slice(pathStart)) {
                      label += typeof segment === 'number' ? `[${segment}]` : `.${segment}`;
                  }
                  return label;
              };
              extractImagesInPlace(obj, (dataUrl, path) => resolveImage(dataUrl, describeLocation(path)));
              return obj;
          };

          const isRedundantManagedAssetId = (id: string) => (
              id === 'wallpaper' ||
              id === 'launcherWidgetImage' ||
              id === 'custom_font_data' ||
              id === 'spark_social_profile' ||
              id === 'spark_user_bg' ||
              id === 'room_custom_assets_list' ||
              id.startsWith('widget_') ||
              id.startsWith('deco_') ||
              id.startsWith('icon_') ||
              id.startsWith('appearance_preset_')
          );

          // 1. Define Stores to Process based on Mode
          let storesToProcess: string[] = [];
          const allStores = [
              // character_groups（角色分組定義）必須與 characters 同進退：
              // 角色身上的 groupId 指向這張表，漏導會讓導入端全員回落「未分組」
              // npcs（神經鏈接「NPC」分頁，獨立於 characters）同理必須一起帶走，否則整合導出
              // 之後再導入，NPC 名單會清空——查手機聯繫人的 linkedNpcId 也會全部懸空。
              'characters', 'character_groups', 'npcs', 'messages', 'themes', 'emojis', 'emoji_categories', 'assets', 'gallery',
              'user_profile', 'diaries', 'tasks', 'anniversaries', 'room_todos',
              'room_notes', 'groups', 'journal_stickers', 'social_posts', 'courses', 'games', 'worldbooks', 'story_theaters', 'story_theater_presets', 'story_theater_masks', 'novels', 'songs',
              'bank_transactions', 'bank_data',
              'xhs_activities', 'xhs_stock',
              'quizzes', 'guidebook', 'scheduled_messages', 'life_sim',
              'handbook', 'trackers', 'tracker_entries', 'hotnews_snapshots',
              'memory_nodes', 'memory_vectors', 'memory_links', 'topic_boxes', 'anticipations', 'event_boxes',
              'room_plates', 'digest_reports',
              'daily_schedule', 'memory_batches',
              'pixel_home_assets', 'pixel_home_layouts',
              // 「彼方」虛擬世界各房間 store —— 早期導出清單漏了，導致備份不含房間數據
              // 劇院的 vr_scripts(投稿劇本) / vr_plays(角色演過的話劇) / vr_presets(寫作風格預設)
              // 之前也漏在這份清單外，導出後這三類劇院數據全丟（導入端其實早已支持恢復）
              'vr_novels', 'vr_annotations', 'cc_custom_parts', 'vr_music', 'vr_guestbook', 'vr_letters', 'vr_settings',
              'vr_scripts', 'vr_plays', 'vr_presets',
              // 家園（同世界觀多角色大世界）——世界定義 + 演繹歷史。導入端早已支持恢復
              // （worldHomeLocal 本機配置也已隨導出帶走），但這兩個 store 之前漏在清單外，
              // 導致導出的備份不含家園數據。
              'worlds', 'world_episodes',
              // 生活記錄（檔案 App：生理期/藥盒/鍛鍊 + 藥盒計劃 + 設置；記帳走 bank_transactions）
              // 導入端 importFullData 已支持恢復，這裡必須同步登記，否則備份不含生活記錄。
              'life_records', 'med_plans', 'life_record_settings'
          ];

          if (mode === 'full') {
              storesToProcess = allStores; // Include everything
          } else if (mode === 'text_only') {
              storesToProcess = allStores.filter(s => s !== 'assets'); // Exclude raw assets store
          } else if (mode === 'media_only') {
              // media_only now includes themes/assets for complete media backup
              storesToProcess = ['gallery', 'emojis', 'emoji_categories', 'journal_stickers', 'user_profile', 'characters', 'npcs', 'messages', 'themes', 'assets', 'bank_data',
                  'pixel_home_assets', 'pixel_home_layouts', 'daily_schedule', 'cc_custom_parts'];
          }

          // Fetch Social App & Room Assets (Optional, depends on mode)
          const sparkUserBg = await DB.getAsset('spark_user_bg');
          const sparkSocialProfile = await DB.getAsset('spark_social_profile');
          const roomCustomAssets = await DB.getAsset('room_custom_assets_list');

          // theme / customIcons / appearancePresets 直接引用運行態 React state。只有
          // media/full 會走 processObject 原地改，必須先深拷貝，否則會把正在用的系統主題改壞；
          // text_only 走 stripBase64（返回新樹、不改原對象），直接用引用即可，省掉一次
          // 可能多達數 MB（壁紙 base64）的克隆。
          const cloneForInPlace = <T,>(v: T): T => (mode === 'text_only' ? v : deepCloneForExport(v));

          const backupData: Partial<FullBackupData> = {
              timestamp: Date.now(),
              version: 3,
              apiConfig: (mode === 'text_only' || mode === 'full') ? apiConfig : undefined,
              checkPhoneApi: (mode === 'text_only' || mode === 'full') ? getCheckPhoneApi() : undefined,
              apiPresets: (mode === 'text_only' || mode === 'full') ? apiPresets : undefined,
              availableModels: (mode === 'text_only' || mode === 'full') ? availableModels : undefined,
              realtimeConfig: (mode === 'text_only' || mode === 'full') ? realtimeConfig : undefined,
              memoryPalaceConfig: (mode === 'text_only' || mode === 'full') ? memoryPalaceConfig : undefined,
              theme: cloneForInPlace(theme), // Include theme in all modes (text/media)
              customIcons: (mode === 'text_only' || mode === 'media_only' || mode === 'full')
                  ? cloneForInPlace(customIcons)
                  : undefined,
              appearancePresets: (mode === 'text_only' || mode === 'media_only' || mode === 'full')
                  ? cloneForInPlace(appearancePresets)
                  : undefined,
              
              socialAppData: (mode === 'text_only' || mode === 'media_only' || mode === 'full') ? {
                  charHandles: JSON.parse(localStorage.getItem('spark_char_handles') || '{}'),
                  userProfile: sparkSocialProfile ? JSON.parse(sparkSocialProfile) : undefined,
                  userId: localStorage.getItem('spark_user_id') || undefined,
                  userBg: sparkUserBg || undefined
              } : undefined,
              
              roomCustomAssets: (mode === 'text_only' || mode === 'media_only' || mode === 'full') ? (roomCustomAssets ? JSON.parse(roomCustomAssets) : []) : undefined,
              mediaAssets: [], // Initialize mediaAssets array

              // Study Room settings (localStorage)
              studyApiConfig: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('study_api_config'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,
              studyTutorPresets: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('study_tutor_presets'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,

              // 雲端配置
              cloudBackupConfig: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('os_cloud_backup_config'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,
              remoteVectorConfig: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('os_remote_vector_config'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,

              // SAR 活動室：公告/初見、雙卡池及人格推演記錄必須跟用戶歷史一起遷移。
              chatInputPreferences: (mode === 'text_only' || mode === 'full') ? loadChatInputPreferences() : undefined,
              sarLocalState: (mode === 'text_only' || mode === 'full') ? collectSARLocalBackup() : undefined,

              // 推送憑據 (VAPID)
              pushVapid: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('push_vapid_v1'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,


              // Memory Palace 水位線
              memoryPalaceHighWaterMarks: (mode === 'text_only' || mode === 'full') ? (() => {
                  const hwm: Record<string, number> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (key?.startsWith('mp_lastMsgId_')) {
                          const charId = key.replace('mp_lastMsgId_', '');
                          hwm[charId] = parseInt(localStorage.getItem(key) || '0', 10);
                      }
                  }
                  return Object.keys(hwm).length > 0 ? hwm : undefined;
              })() : undefined,

              // Memory Palace 每角色的 UI 標記（人格檢測已跑過、首次歸檔 banner 已看過等）
              // 丟了會導致重彈一次人格確認 / 首次 banner，體驗噪聲但不丟數據，仍然應該備份
              memoryPalaceFlags: (mode === 'text_only' || mode === 'full') ? (() => {
                  const flags: Record<string, string> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (!key) continue;
                      if (key.startsWith('mp_personality_tried_')
                          || key.startsWith('mp_first_archive_notice_')) {
                          flags[key] = localStorage.getItem(key) || '';
                      }
                  }
                  return Object.keys(flags).length > 0 ? flags : undefined;
              })() : undefined,

              // Chat 翻譯 / 歸檔 / 潤色相關設置
              chatTranslateSourceLang: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('chat_translate_source_lang') || undefined) : undefined,
              chatTranslateTargetLang: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('chat_translate_lang') || undefined) : undefined,
              chatTranslateEnabledByChar: (mode === 'text_only' || mode === 'full') ? (() => {
                  const map: Record<string, boolean> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (!key || !key.startsWith('chat_translate_enabled_')) continue;
                      const charId = key.replace('chat_translate_enabled_', '');
                      map[charId] = localStorage.getItem(key) === 'true';
                  }
                  return Object.keys(map).length > 0 ? map : undefined;
              })() : undefined,
              chatTranslateExpandedByChar: (mode === 'text_only' || mode === 'full') ? (() => {
                  const map: Record<string, boolean> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (!key || !key.startsWith('chat_translate_expanded_')) continue;
                      const charId = key.replace('chat_translate_expanded_', '');
                      map[charId] = localStorage.getItem(key) === 'true';
                  }
                  return Object.keys(map).length > 0 ? map : undefined;
              })() : undefined,
              chatTranslateSourceLangByChar: (mode === 'text_only' || mode === 'full') ? (() => {
                  const map: Record<string, string> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (!key || !key.startsWith('chat_translate_source_lang_')) continue;
                      const charId = key.replace('chat_translate_source_lang_', '');
                      const value = localStorage.getItem(key);
                      if (charId && value) map[charId] = value;
                  }
                  return Object.keys(map).length > 0 ? map : undefined;
              })() : undefined,
              chatTranslateTargetLangByChar: (mode === 'text_only' || mode === 'full') ? (() => {
                  const map: Record<string, string> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (!key || !key.startsWith('chat_translate_lang_')) continue;
                      const charId = key.replace('chat_translate_lang_', '');
                      const value = localStorage.getItem(key);
                      if (charId && value) map[charId] = value;
                  }
                  return Object.keys(map).length > 0 ? map : undefined;
              })() : undefined,
              chatArchivePrompts: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('chat_archive_prompts'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,
              chatActiveArchivePromptId: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('chat_active_archive_prompt_id') || undefined) : undefined,
              characterRefinePrompts: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('character_refine_prompts'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,
              characterActiveRefinePromptId: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('character_active_refine_prompt_id') || undefined) : undefined,

              // UI / 偏好
              scheduleAppTheme: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('schedule_app_theme') || undefined) : undefined,
              handbookLifestreamDepth: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('handbook_lifestream_depth') || undefined) : undefined,
              groupchatContextLimit: (mode === 'text_only' || mode === 'full') ? (() => { const v = localStorage.getItem('groupchat_context_limit'); const n = v ? parseInt(v, 10) : NaN; return Number.isFinite(n) ? n : undefined; })() : undefined,
              browserConfig: (mode === 'text_only' || mode === 'full') ? (() => {
                  const braveKey = localStorage.getItem('browser_brave_key') || undefined;
                  const useReal = localStorage.getItem('browser_use_real_search');
                  const useRealSearch = useReal === null ? undefined : useReal === 'true';
                  if (!braveKey && useRealSearch === undefined) return undefined;
                  return { braveKey, useRealSearch };
              })() : undefined,
              bm25Mode: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('bm25_mode') || undefined) : undefined,
              lastActiveCharId: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('os_last_active_char_id') || undefined) : undefined,
              storyTheaterAppearance: (mode === 'text_only' || mode === 'full') ? exportStoryTheaterAppearanceSetting() : undefined,
              eventNotifFlags: (mode === 'text_only' || mode === 'full') ? (() => {
                  const flags: Record<string, string> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (!key) continue;
                      if (key.startsWith('sullyos_')) {
                          flags[key] = localStorage.getItem(key) || '';
                      }
                  }
                  return Object.keys(flags).length > 0 ? flags : undefined;
              })() : undefined,

              // 本機 localStorage 配置（導入端 importFullData 已支持恢復，之前導出漏發導致丟失）
              //  · 瑞幸 / 麥當勞 MCP 的點單 token + 啟用狀態（用戶說的「那個碼」）
              //  · 郵局身份、家園全局 API + 文風收藏
              vrPostOffice: (mode === 'text_only' || mode === 'full') ? exportPostOfficeLocal() : undefined,
              vrSignal: (mode === 'text_only' || mode === 'full') ? exportSignalLocal() : undefined, // 信號墜落處：句子歸屬「你·角色」+ 反覆用清單
              worldHomeLocal: (mode === 'text_only' || mode === 'full') ? exportWorldHomeLocal() : undefined,
              luckinLocal: (mode === 'text_only' || mode === 'full') ? exportLuckinLocal() : undefined,
              mcdLocal: (mode === 'text_only' || mode === 'full') ? exportMcdLocal() : undefined,
              mcpLocal: (mode === 'text_only' || mode === 'full') ? exportMcpLocal() : undefined,

              // 夢境盲盒收藏冊（帳號級 localStorage，不掛在角色上，需單獨隨備份帶走）
              dreamCollection: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('os_dream_collection'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,

              // 桌面電子寵物主題的主色調偏好（帳號級 localStorage）。room_card 涓流卡片本身
              // 是普通消息、隨 messages store 一起導出，這裡只補帶走這個純外觀偏好。
              gotchiAccentHue: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('tama_accent_hue'); return s !== null ? s : undefined; } catch { return undefined; } })() : undefined,
          };

          // 主動消息 2.0 的全局配置（Worker 地址 / 密鑰 / 即時對話開關）。它存在獨立的
          // ActiveMsg 庫裡，不在上面那份 store 清單內，所以單獨取一次；異步，故在字面量外。
          // 純配置無媒體，跟著 text_only / full 走。
          if (mode === 'text_only' || mode === 'full') {
              backupData.amsg2GlobalConfig = await exportAmsg2GlobalConfig();
          }

          // 桌面皮膚偏好（電子寵物/手遊風的界面配色 + 看板 banner）——異步（看板圖令牌需解析為
          // data URL 才能跨設備），所以在對象字面量外單獨 await。text_only 只帶配色偏好、跳過看板大圖。
          backupData.desktopSkinLocal = await exportDesktopSkinLocal(mode !== 'text_only');

          // 協同工作是可拆卸的獨立 IndexedDB，不在主 DB store 清單裡，必須單獨打包。
          // text_only 帶窗口/消息/分類/API 設置但不帶文件字節；media_only 只帶文件字節；
          // full 兩者都帶。文件原始 Blob 直寫 ZIP，避免 base64 放大和重複保存。
          const { CollaborationStore } = await import('../features/collaboration/store');
          const includeCollaborationText = mode !== 'media_only';
          const includeCollaborationAssets = mode !== 'text_only';
          const collaborationBackup = await CollaborationStore.exportBackup(
              includeCollaborationAssets,
              includeCollaborationText,
          );
          backupData.collaborationBackupVersion = 1;
          backupData.collaborationBackupMode = mode;
          if (includeCollaborationText) {
              backupData.collaborationSessions = collaborationBackup.sessions || [];
              backupData.collaborationMessages = collaborationBackup.messages || [];
              backupData.collaborationCategories = collaborationBackup.categories || [];
              backupData.collaborationSettings = collaborationBackup.settings;
          }
          if (includeCollaborationAssets) {
              backupData.collaborationAssetIndex = [];
              const collaborationAssets = collaborationBackup.assets || [];
              for (let index = 0; index < collaborationAssets.length; index++) {
                  const asset = collaborationAssets[index];
                  const safeId = asset.id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || `asset-${index}`;
                  const path = `collaboration/assets/${String(index).padStart(5, '0')}-${safeId}.bin`;
                  zip.file(path, new Uint8Array(await asset.blob.arrayBuffer()), { compression: 'STORE' });
                  backupData.collaborationAssetIndex.push({
                      id: asset.id,
                      path,
                      mimeType: asset.blob.type || 'application/octet-stream',
                      size: asset.blob.size,
                      createdAt: asset.createdAt,
                  });
                  if (index % 10 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
              }
          }

          const totalSteps = storesToProcess.length + 3;
          let currentStep = 0;

          // Pre-process specialized image fields (Social App, Theme)。processObject 是
          // 原地改，所以這裡按語句調用、不接返回值，讀起來就是「就地處理這個對象」。
          if (mode !== 'text_only') {
              // 壁紙 / 小屋自定義素材 / 外觀預設裡的 blobref 令牌原樣進包（二進制走 blobs/*
              // 旁路，onSerialized 收集，無需在這裡逐字段處理）。theme.wallpaper 內存裡是
              // blob: objectURL（會話臨時，恢復端認不得），這裡換回持久化指針
              // （blobref 令牌 / 舊 data: / http）。舊 data: 值仍走下面 processObject 的
              // data:→assets/* 抽取管線。
              if (backupData.theme) {
                  const wp = (backupData.theme as any).wallpaper;
                  if (typeof wp === 'string' && wp.startsWith('blob:')) {
                      const ptr = await DB.getAsset('wallpaper'); // blobref 令牌 / 舊 data: / http
                      (backupData.theme as any).wallpaper = ptr || '';
                  }
                  const lockWp = (backupData.theme as any).lockWallpaper;
                  if (typeof lockWp === 'string' && lockWp.startsWith('blob:')) {
                      const ptr = await DB.getAsset('lock_wallpaper');
                      (backupData.theme as any).lockWallpaper = ptr || undefined;
                  }
              }

              if (backupData.socialAppData?.userProfile) processObject(backupData.socialAppData.userProfile, 'socialAppData.userProfile');
              if (backupData.socialAppData?.userBg) processObject(backupData.socialAppData.userBg, 'socialAppData.userBg');
              if (backupData.sarLocalState) processObject(backupData.sarLocalState, 'sarLocalState');
              if (backupData.roomCustomAssets) processObject(backupData.roomCustomAssets, 'roomCustomAssets');
              if (backupData.theme) processObject(backupData.theme, 'theme');
              if (backupData.customIcons) processObject(backupData.customIcons, 'customIcons');
              if (backupData.appearancePresets) processObject(backupData.appearancePresets, 'appearancePresets');
          } else {
              // Strip images for text only
              if (backupData.socialAppData?.userProfile) backupData.socialAppData.userProfile = stripBase64(backupData.socialAppData.userProfile);
              if (backupData.socialAppData?.userBg) backupData.socialAppData.userBg = stripBase64(backupData.socialAppData.userBg);
              if (backupData.roomCustomAssets) backupData.roomCustomAssets = stripBase64(backupData.roomCustomAssets);
              if (backupData.customIcons) backupData.customIcons = stripBase64(backupData.customIcons);
              if (backupData.appearancePresets) backupData.appearancePresets = stripBase64(backupData.appearancePresets);
              if (backupData.sarLocalState) backupData.sarLocalState = stripBase64(backupData.sarLocalState);
              if (backupData.theme) {
                  // Save preset decoration content before stripping (SVGs start with data:image and would be stripped)
                  const savedPresetDecos = backupData.theme.desktopDecorations
                      ?.filter(d => d.type === 'preset')
                      .map(d => ({ id: d.id, content: d.content }));
                  const strippedTheme = stripBase64(backupData.theme) as OSTheme;
                  // text_only 不帶圖片：內存裡的壁紙是 blob: objectURL（會話臨時，恢復端認不得），
                  // blobref 令牌 stripBase64 已清空——這裡補清 blob: 避免導出一個死鏈接壁紙。
                  if (strippedTheme.wallpaper && strippedTheme.wallpaper.startsWith('blob:')) strippedTheme.wallpaper = '';
                  backupData.theme = strippedTheme;
                  // Restore preset SVGs and remove image decorations (they have no data in text mode)
                  if (strippedTheme.desktopDecorations && savedPresetDecos) {
                      strippedTheme.desktopDecorations = strippedTheme.desktopDecorations
                          .map(d => {
                              const saved = savedPresetDecos.find(p => p.id === d.id);
                              return saved ? { ...d, content: saved.content } : d;
                          })
                          .filter(d => d.content && d.content !== '');
                  }
              }
          }

          // Stores that never contain base64 image data — skip recursive traversal
          const noImageStores = new Set([
              'memory_nodes', 'memory_vectors', 'memory_links', 'topic_boxes', 'anticipations', 'event_boxes',
              'room_plates', 'digest_reports',
              'bank_transactions', 'scheduled_messages', 'memory_batches', 'hotnews_snapshots',
              'character_groups',
              'story_theaters', 'story_theater_presets',
              'life_records', 'med_plans', 'life_record_settings'
          ]);

          // Chunked processObject for large arrays — yields to main thread every 200 items
          const processArrayChunked = async (arr: any[], fn: (item: any, index: number) => any, chunkSize = 200): Promise<any[]> => {
              if (arr.length <= chunkSize) return arr.map(fn);
              const result: any[] = [];
              for (let i = 0; i < arr.length; i += chunkSize) {
                  const chunk = arr.slice(i, i + chunkSize).map((item, offset) => fn(item, i + offset));
                  result.push(...chunk);
                  if (i + chunkSize < arr.length) {
                      await new Promise(r => setTimeout(r, 0));
                  }
              }
              return result;
          };

          // 純文字備份的低內存路徑：store 通過單事務 IDB 游標逐條讀取，剝圖後立即序列化進 ZIP 分片，
          // 不再 getAll 整表駐留。gallery/messages 中即使有大量 base64 圖片，峰值也只是一條記錄。
          const textOnlyFieldByStore: Record<string, string> = {
              characters: 'characters',
              character_groups: 'characterGroups',
              npcs: 'npcs',
              messages: 'messages',
              themes: 'customThemes',
              emojis: 'savedEmojis',
              emoji_categories: 'emojiCategories',
              gallery: 'galleryImages',
              diaries: 'diaries',
              tasks: 'tasks',
              anniversaries: 'anniversaries',
              room_todos: 'roomTodos',
              room_notes: 'roomNotes',
              groups: 'groups',
              journal_stickers: 'savedJournalStickers',
              social_posts: 'socialPosts',
              courses: 'courses',
              games: 'games',
              worldbooks: 'worldbooks',
              story_theaters: 'storyTheaters',
              story_theater_presets: 'storyTheaterPresets',
              story_theater_masks: 'storyTheaterMasks',
              novels: 'novels',
              songs: 'songs',
              bank_transactions: 'bankTransactions',
              xhs_activities: 'xhsActivities',
              xhs_stock: 'xhsStockImages',
              quizzes: 'quizSessions',
              guidebook: 'guidebookSessions',
              scheduled_messages: 'scheduledMessages',
              handbook: 'handbooks',
              trackers: 'trackers',
              tracker_entries: 'trackerEntries',
              hotnews_snapshots: 'hotNewsSnapshots',
              memory_nodes: 'memoryNodes',
              memory_links: 'memoryLinks',
              topic_boxes: 'topicBoxes',
              anticipations: 'anticipations',
              event_boxes: 'eventBoxes',
              room_plates: 'roomPlates',
              digest_reports: 'digestReports',
              daily_schedule: 'dailySchedules',
              memory_batches: 'memoryBatches',
              pixel_home_assets: 'pixelHomeAssets',
              pixel_home_layouts: 'pixelHomeLayouts',
              vr_novels: 'vrNovels',
              vr_annotations: 'vrAnnotations',
              cc_custom_parts: 'customCreatorParts',
              vr_letters: 'vrLetters',
              vr_settings: 'vrSettings',
              vr_scripts: 'vrScripts',
              vr_plays: 'vrStagedPlays',
              vr_presets: 'vrPresets',
              worlds: 'worlds',
              world_episodes: 'worldEpisodes',
              life_records: 'lifeRecords',
              med_plans: 'medPlans',
              life_record_settings: 'lifeRecordSettings',
          };
          const prewrittenStores: BackupManifest['stores'] = {};
          const textOnlyShardLimits = {
              maxLen: 4 * 1024 * 1024,
              maxItems: 500,
              hardMaxLen: 256 * 1024 * 1024,
          };

          // 向量二進制旁路（#2）：memory_vectors 歸一化拼成 bin + 索引（邏輯在 encodeVectorsForBackup，
          // 那邊有 ensureFloat32 統一 Uint8Array / Float32Array / 遺留 number[] 三態），導出收尾交給
          // writeV2Backup 落進 zip——不進 backupData、不當普通數組分片，避開 number[] 進 JSON 的膨脹。
          let vectorPayload: ReturnType<typeof encodeVectorsForBackup> | undefined;
          // Only voice Blobs reachable from the exported Live2D settings are portable.
          // Orphaned/cancelled companion generations must not silently bloat a backup.
          const companionVoiceAssetIdsForBackup = new Set<string>();

          for (const storeName of storesToProcess) {
              currentStep++;
              setSysOperation({
                  status: 'processing',
                  message: `正在打包: ${storeName} ...`,
                  progress: (currentStep / totalSteps) * 100
              });

              // 4500+ 條記憶若仍是早期 number[] 存儲，getAll 會先在 JS 堆裡膨脹成數百 MB。
              // 兩遍游標逐條掃描只常駐最終 Float32 緊湊 bin；格式仍是原來的單 bin + index。
              if (storeName === 'memory_vectors' && mode === 'text_only') {
                  vectorPayload = await encodeVectorsForBackupChunked(async (onBatch) => {
                      await DB.streamRawStoreData(storeName, item => onBatch([item]));
                  });
                  await new Promise(resolve => setTimeout(resolve, 0));
                  continue;
              }

              // 純文字模式的普通數組 store：逐條剝圖後立刻寫分片。這裡 continue 後不會再把
              // processedData 掛到 backupData，因此已處理的整表不會一直留到最終壓縮階段。
              const textOnlyField = mode === 'text_only' ? textOnlyFieldByStore[storeName] : undefined;
              if (textOnlyField) {
                  const writer = createV2ArrayFieldWriter(
                      zip as unknown as ZipFileWriter,
                      textOnlyField,
                      {
                          limits: textOnlyShardLimits,
                          onYield: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
                      },
                  );
                  await DB.streamRawStoreData(storeName, (item) => {
                      // characters 也走這條低內存旁路；必須在逐條寫分片前規範化，
                      // 否則 text_only 會繞過下面 getAll 分支，把舊部署的絕對樣板房 URL 原樣帶走。
                      if (storeName === 'characters') normalizeCharacterRoomAssetsInPlace(item);
                      const processedItem = noImageStores.has(storeName) ? item : stripTextOnlyMedia(item);
                      writer.appendSync([processedItem]);
                  });
                  prewrittenStores[textOnlyField] = await writer.finish();
                  continue;
              }

              let rawData = await DB.getRawStoreData(storeName);
              let processedData: any;

              // Built-in room-template files belong to the app, not to the source deployment.
              // Older builds stored their fully resolved origin in roomConfig; strip that origin
              // from the export clone so restoring on another host/base path keeps every item.
              if (storeName === 'characters' && Array.isArray(rawData)) {
                  for (const character of rawData) normalizeCharacterRoomAssetsInPlace(character);
              }

              // 向量旁路：歸一化拼 bin + 索引，不進 backupData（writeV2Backup 收尾落 zip）。直接跳過
              // 下面的圖片處理 / switch（向量無圖、無 image base64）。
              if (storeName === 'memory_vectors') {
                  vectorPayload = encodeVectorsForBackup(Array.isArray(rawData) ? rawData : []);
                  await new Promise(resolve => setTimeout(resolve, 10));
                  continue;
              }

              // blobref 令牌（characters 的小屋圖 / sprites.chibi、cc_custom_parts 的
              // src/shadowSrc、messages 的 cameraSnapshotRef、songs 的 coverImage……）
              // 不在這裡做任何處理：v3 令牌原樣進 JSON，onSerialized 統一收集、
              // 二進制隨 blobs/* 旁路走，任何 store 的令牌都覆蓋，沒有名單可漏。
              if (storeName === 'characters' && mode !== 'text_only' && Array.isArray(rawData)) {
                  // v1 陪伴語音存在 blob_assets（普通備份不讀取該 store）。先遷移到
                  // assets 的二進制語音通道，稍後 assets store 才能把完整 Blob 寫進 ZIP。
                  await ensureCompanionVoiceAssetsForBackup(rawData as CharacterProfile[]);
                  collectCharacterCompanionVoiceAssetIds(rawData as CharacterProfile[])
                      .forEach(assetId => companionVoiceAssetIdsForBackup.add(assetId));
              }

              // --- MODE SPECIFIC FILTERING ---

              if (storeName === 'assets' && Array.isArray(rawData)) {
                  rawData = rawData.filter((asset: { id?: string; data?: { favorite?: boolean } } | null | undefined) => {
                      if (!asset || typeof asset.id !== 'string') return true;
                      if (isRedundantManagedAssetId(asset.id)) return false;
                      if (isCompanionVoiceAssetId(asset.id) && !companionVoiceAssetIdsForBackup.has(asset.id)) return false;
                      // Shared TTS rows and un-favorited message voice are implementation
                      // cache. Only explicit favorites and saved Live2D-preset dependencies
                      // join full/media backups; neither joins text-only backups.
                      return shouldIncludeVoiceRelatedAssetInBackup(asset, mode !== 'text_only');
                  });
                  // Blob is not JSON-serializable (`JSON.stringify(new Blob()) === '{}'`).
                  // Put allowed audio bytes in their own ZIP entries and leave a JSON-safe
                  // marker in the assets row. `tts_*` and ordinary un-favorited speech stay
                  // disposable cache and are not duplicated in backups.
                  await externalizeVoiceMessageBlobs(rawData, (path, bytes) => {
                      zip.file(path, bytes, { compression: 'STORE' });
                  });
              }

              // Fast path: stores with no image data skip expensive recursive traversal
              // （memory_vectors 已在上面走二進制旁路 continue 掉，這裡只剩其它無圖 store）
              if (noImageStores.has(storeName)) {
                  processedData = rawData;
              } else if (mode === 'text_only') {
                  processedData = Array.isArray(rawData) && rawData.length > 200
                      ? await processArrayChunked(rawData, stripTextOnlyMedia)
                      : stripTextOnlyMedia(rawData);
              } else {
                  // Media & Theme Mode: Extract Images
                  
                  if (storeName === 'messages' && mode === 'media_only') {
                      // Keep normal media messages plus lightweight call turns that own
                      // a retained frame / [圖片] marker. Import remains patch-mode.
                      rawData = rawData.filter((m: Message) => (
                          m.type === 'image'
                          || m.type === 'emoji'
                          || !!m.metadata?.cameraSnapshotRef
                          || m.metadata?.cameraSnapshotExpired === true
                      ));
                  }

                  if (storeName === 'characters' && mode === 'media_only') {
                      // Character Logic: Export ONLY visual assets to mediaAssets array
                      // Do not export the full character array to avoid overwriting text data on import
                      const mediaList = rawData.map((c: CharacterProfile, index: number) => {
                          const extracted = {
                              charId: c.id,
                              avatar: c.avatar,
                              companionAvatar: c.companionAvatar,
                              companionTouchSettings: c.companionTouchSettings,
                              sprites: c.sprites,
                              // Date app sprite data: skin sets carry alternate sprite maps,
                              // and customDateSprites/activeSkinSetId are required to wire them up.
                              dateSkinSets: c.dateSkinSets,
                              activeSkinSetId: c.activeSkinSetId,
                              customDateSprites: c.customDateSprites,
                              spriteConfig: c.spriteConfig,
                              roomItems: c.roomConfig?.items?.reduce((acc: any, item: any) => {
                                  // data:（舊值，下面 processObject 抽成 assets/*）和 blobref
                                  // 令牌（v3 原樣進包，二進制走 blobs/*）都算媒體，都帶走。
                                  if (item.image && (item.image.startsWith('data:') || isBlobRef(item.image))) {
                                      acc[item.id] = item.image;
                                  }
                                  return acc;
                              }, {}),
                              backgrounds: {
                                  chat: c.chatBackground,
                                  date: c.dateBackground,
                                  roomWall: c.roomConfig?.wallImage,
                                  roomFloor: c.roomConfig?.floorImage
                              }
                          };
                          return processObject(extracted, `characters[${index}](id=${String(c.id).slice(0, 80)})`);
                      });
                      backupData.mediaAssets = mediaList;
                      continue; // Skip standard assignment
                  }

                  processedData = Array.isArray(rawData) && rawData.length > 200
                      ? await processArrayChunked(rawData, (item, index) => {
                          const id = item && typeof item === 'object'
                              ? String(item.id ?? item.uuid ?? item.key ?? '').replace(/[\r\n]/g, ' ').slice(0, 80)
                              : '';
                          return processObject(item, `${storeName}[${index}]${id ? `(id=${id})` : ''}`);
                      })
                      : processObject(rawData, storeName);
              }

              // Assign to Backup Data
              switch(storeName) {
                  case 'characters': if(mode !== 'media_only') backupData.characters = processedData; break;
                  // 角色分組定義 —— 鍵名須與 importFullData 讀取的字段（data.characterGroups）對齊
                  case 'character_groups': backupData.characterGroups = processedData; break;
                  case 'npcs': backupData.npcs = processedData; break;
                  case 'messages': backupData.messages = processedData; break;
                  case 'themes': backupData.customThemes = processedData; break;
                  case 'emojis': backupData.savedEmojis = processedData; break;
                  case 'emoji_categories': backupData.emojiCategories = processedData; break;
                  case 'assets': backupData.assets = processedData; break;
                  case 'gallery': backupData.galleryImages = processedData; break;
                  case 'user_profile': if (processedData[0]) backupData.userProfile = processedData[0]; break;
                  case 'diaries': backupData.diaries = processedData; break;
                  case 'tasks': backupData.tasks = processedData; break;
                  case 'anniversaries': backupData.anniversaries = processedData; break;
                  case 'room_todos': backupData.roomTodos = processedData; break;
                  case 'room_notes': backupData.roomNotes = processedData; break;
                  case 'groups': backupData.groups = processedData; break;
                  case 'journal_stickers': backupData.savedJournalStickers = processedData; break;
                  case 'social_posts': backupData.socialPosts = processedData; break;
                  case 'courses': backupData.courses = processedData; break;
                  case 'games': backupData.games = processedData; break;
                  case 'worldbooks': backupData.worldbooks = processedData; break;
                  case 'story_theaters': backupData.storyTheaters = processedData; break;
                  case 'story_theater_presets': backupData.storyTheaterPresets = processedData; break;
                  case 'story_theater_masks': backupData.storyTheaterMasks = processedData; break;
                  case 'novels': backupData.novels = processedData; break;
                  case 'songs': backupData.songs = processedData; break;
                  case 'bank_transactions': backupData.bankTransactions = processedData; break;
                  case 'bank_data': {
                      if (Array.isArray(processedData)) {
                          const mainState = processedData.find((d: any) => d.id === 'main_state');
                          const dollhouseRecord = processedData.find((d: any) => d.id === 'dollhouse_state');
                          backupData.bankState = mainState ? { ...mainState, id: undefined } : undefined;
                          backupData.bankDollhouse = dollhouseRecord?.data || undefined;
                      }
                      break;
                  }
                  case 'xhs_activities': backupData.xhsActivities = processedData; break;
                  case 'xhs_stock': backupData.xhsStockImages = processedData; break;
                  case 'quizzes': backupData.quizSessions = processedData; break;
                  case 'guidebook': backupData.guidebookSessions = processedData; break;
                  case 'scheduled_messages': backupData.scheduledMessages = processedData; break;
                  case 'life_sim': backupData.lifeSimState = Array.isArray(processedData) ? (processedData[0] || null) : (processedData || null); break;
                  case 'handbook': backupData.handbooks = processedData; break;
                  case 'trackers': backupData.trackers = processedData; break;
                  case 'tracker_entries': backupData.trackerEntries = processedData; break;
                  case 'life_records': backupData.lifeRecords = processedData; break;
                  case 'med_plans': backupData.medPlans = processedData; break;
                  case 'life_record_settings': backupData.lifeRecordSettings = processedData; break;
                  case 'hotnews_snapshots': backupData.hotNewsSnapshots = processedData; break;
                  case 'memory_nodes': backupData.memoryNodes = processedData; break;
                  // memory_vectors 走二進制旁路（上面已 continue），不在此 switch 落 backupData
                  case 'memory_links': backupData.memoryLinks = processedData; break;
                  case 'topic_boxes': backupData.topicBoxes = processedData; break;
                  case 'anticipations': backupData.anticipations = processedData; break;
                  case 'event_boxes': backupData.eventBoxes = processedData; break;
                  case 'room_plates': backupData.roomPlates = processedData; break;
                  case 'digest_reports': backupData.digestReports = processedData; break;
                  case 'daily_schedule': backupData.dailySchedules = processedData; break;
                  case 'memory_batches': backupData.memoryBatches = processedData; break;
                  case 'pixel_home_assets': backupData.pixelHomeAssets = processedData; break;
                  case 'pixel_home_layouts': backupData.pixelHomeLayouts = processedData; break;
                  // 「彼方」虛擬世界 —— 鍵名須與 importFullData 讀取的字段對齊
                  case 'vr_novels': backupData.vrNovels = processedData; break;
                  case 'vr_annotations': backupData.vrAnnotations = processedData; break;
                  case 'cc_custom_parts': backupData.customCreatorParts = processedData; break;
                  case 'vr_letters': backupData.vrLetters = processedData; break;
                  case 'vr_settings': backupData.vrSettings = processedData; break;
                  case 'vr_scripts': backupData.vrScripts = processedData; break;
                  case 'vr_plays': backupData.vrStagedPlays = processedData; break;        // 角色演過的話劇
                  case 'vr_presets': backupData.vrPresets = processedData; break;
                  // 單例 store：導入端期望單個對象（取首條），非數組
                  case 'vr_music': backupData.vrMusicRoom = Array.isArray(processedData) ? (processedData[0] || undefined) : (processedData || undefined); break;
                  case 'vr_guestbook': backupData.vrGuestbook = Array.isArray(processedData) ? (processedData[0] || undefined) : (processedData || undefined); break;
                  // 家園 —— 鍵名須與 importFullData 讀取的字段（data.worlds / data.worldEpisodes）對齊
                  case 'worlds': backupData.worlds = processedData; break;
                  case 'world_episodes': backupData.worldEpisodes = processedData; break;
              }

              await new Promise(resolve => setTimeout(resolve, 10));
          }

          // 進度條停在 70% 讓用戶看到接下來的"壓縮中 X%"實際推進，而不是卡在 95% 乾等。
          // text_only 用 level 6；媒體/全量仍用 level 9，具體見 generateAsync 配置。
          setSysOperation({ status: 'processing', message: '正在生成壓縮包...', progress: 70 });

          // --- v2 分片序列化（替代老的單根 data.json）---
          // 不再把所有數據拼成一根 data.json：單根字符串逼近 ~512M 會確定性 RangeError。
          // 改成每個數組字段分片寫進 stores/<field>.NNN.json、其餘非數組字段進 metadata.json、
          // 收尾寫 manifest.json 當導入契約。導入端按 manifest 把各片拼回與這裡完全相同的 data
          // 對象，餵給原封不動的 importFullData——還原語義（clear-and-add / merge / 單例 /
          // media_only 補丁……）不在這裡重寫。詳見 utils/backupFormat.ts。
          await writeV2Backup(
              zip as unknown as ZipFileWriter,
              backupData as Record<string, any>,
              {
                  mode,
                  createdAt: Date.now(),
                  assetCount,
                  vectors: vectorPayload,
                  prewrittenStores,
                  onYield: () => new Promise<void>(r => setTimeout(r, 0)),
                  onSerialized: collectSerialized,
              },
          );

          // v3 blob 旁路收尾：被引用令牌的 Blob 直寫 blobs/<id>（原文件字節，全程不經
          // base64），附 blobs/index.json。圖已丟的令牌跳過——死令牌留在 JSON 裡，
          // 恢復端渲染為空，與 v2 置空串的用戶可見結果等價。
          if (collectSerialized && referencedBlobTokens.size > 0) {
              setSysOperation({ status: 'processing', message: '正在打包圖片二進制...', progress: 70 });
              const { missing } = await writeBlobsToZip(
                  zip as unknown as ZipFileWriter,
                  referencedBlobTokens,
                  getBlobForRef,
                  { onYield: () => new Promise<void>(r => setTimeout(r, 0)) },
              );
              if (missing.length > 0) {
                  console.warn(`備份時 ${missing.length} 個圖片令牌已無對應數據，已跳過:`, missing);
              }
          }

          if (malformedImageCount > 0) {
              zip.file(
                  'diagnostics/malformed-images.json',
                  JSON.stringify(buildMalformedImageDiagnostics({
                      createdAt: new Date().toISOString(),
                      mode,
                      total: malformedImageCount,
                      items: malformedImageDiagnostics,
                  }), null, 2),
              );
          }

          // 進度提示：每 ~5% 更新一次（避免高頻 React 重渲染），同時讓進度
          // 條從 70% 平滑爬到 99%，用戶能確切看到"在動"。
          let lastReportedPercent = -10;
          const content = await zip.generateAsync(
              {
                  type: "blob",
                  streamFiles: true,
                  compression: "DEFLATE",
                  // 純文字備份優先手機穩定性；6 級體積差很小，但比 9 級明顯省時省內存。
                  compressionOptions: { level: mode === 'text_only' ? 6 : 9 },
              },
              (metadata) => {
                  const p = metadata.percent;
                  if (p - lastReportedPercent >= 5 || p >= 99) {
                      lastReportedPercent = p;
                      setSysOperation({
                          status: 'processing',
                          message: `正在壓縮備份數據 ${p.toFixed(0)}%...`,
                          progress: Math.min(99, 70 + Math.floor(p * 0.29)),
                      });
                  }
              }
          );

          setSysOperation({ status: 'idle', message: '', progress: 100 });
          // 備份成功 → 推進「該備份啦」提醒的計時（本地導出 / 雲備份都走這裡，一處覆蓋兩條路徑）
          markBackupDone();
          if (malformedImageCount > 0) {
              console.warn(`[Backup] 備份已完成，已從導出副本跳過 ${malformedImageCount} 處損壞圖片`, malformedImageDiagnostics);
              addToast(`備份已生成，已跳過 ${malformedImageCount} 處無法恢復的損壞圖片；其他數據已正常保存`, 'info');
          }
          return content;

      } catch (e: any) {
          console.error("Export Failed", e);
          setSysOperation({ status: 'idle', message: '', progress: 0 });
          throw new Error("導出失敗: " + e.message);
      }
  };

  const importSystem = async (fileOrJson: File | string): Promise<void> => {
      const sourceName = typeof fileOrJson === 'string' ? 'json' : fileOrJson.name;
      const sourceSize = typeof fileOrJson === 'string'
          ? (typeof Blob !== 'undefined' ? new Blob([fileOrJson]).size : fileOrJson.length)
          : fileOrJson.size;
      const restoredAssetFiles = new Set<string>();
      let totalAssetFiles = 0;
      let lastProgress = 0;
      let lastCurrent = '解析備份文件';
      let lastCurrentFile: string | undefined;
      let lastCurrentFileSize: number | undefined;

      const buildImportMessage = (headline: string, update: ImportProgressUpdate = {}) => {
          const lines = [headline];
          const current = update.current ?? lastCurrent;
          const currentFile = update.currentFile ?? lastCurrentFile;
          const currentFileSize = update.currentFileSize ?? lastCurrentFileSize;
          if (current) lines.push(`當前部分：${current}`);
          if (typeof update.itemTotal === 'number' && update.itemTotal > 0) {
              lines.push(`條目：${update.itemDone || 0}/${update.itemTotal}`);
          }
          if (currentFile) {
              const sizeText = formatBytes(currentFileSize);
              lines.push(`當前文件：${currentFile}${sizeText ? ` · ${sizeText}` : ''}`);
          }
          if (sourceName !== 'json' && update.current === '解析備份文件') {
              const sizeText = formatBytes(sourceSize);
              lines.push(`備份：${sourceName}${sizeText ? ` · ${sizeText}` : ''}`);
          }
          return lines.join('\n');
      };

      const showImportProgress = (
          phase: string,
          headline: string,
          progress: number,
          update: ImportProgressUpdate = {}
      ) => {
          if (update.current !== undefined) lastCurrent = update.current;
          if (update.currentFile !== undefined) lastCurrentFile = update.currentFile;
          if (update.currentFileSize !== undefined) lastCurrentFileSize = update.currentFileSize;
          lastProgress = Math.max(lastProgress, Math.min(99, Math.max(0, progress)));
          markImportInProgress(phase, sourceName, {
              sourceSize,
              assetDone: restoredAssetFiles.size,
              assetTotal: totalAssetFiles || undefined,
              ...update,
          });
          setSysOperation({
              status: 'processing',
              message: buildImportMessage(headline, update),
              progress: lastProgress,
          });
      };

      const countZipAssetFiles = (zip: JSZipLike) => {
          const files = Object.values((zip as any).files || {}) as any[];
          return files.filter(file => file && !file.dir && typeof file.name === 'string' && file.name.startsWith('assets/')).length;
      };

      const estimateBase64Bytes = (base64: string) => {
          const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
          return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
      };

      showImportProgress('parsing', '正在解析備份文件...', 1, { current: '解析備份文件', sourceSize });
      try {
          let data: FullBackupData;
          let zip: JSZipLike | null = null;

          if (typeof fileOrJson === 'string') {
              data = JSON.parse(fileOrJson);
          } else {
              if (!fileOrJson.name.endsWith('.zip')) {
                  try {
                      const text = await fileOrJson.text();
                      data = JSON.parse(text);
                  } catch (e) {
                      throw new Error("無效的文件格式，請上傳 .zip 或 .json");
                  }
              } else {
                  const JSZip = await loadJSZip();
                  const loadedZip = await JSZip.loadAsync(fileOrJson);
                  zip = loadedZip;
                  totalAssetFiles = countZipAssetFiles(loadedZip);
                  const manifestFile = loadedZip.file("manifest.json");
                  if (manifestFile) {
                      // v2：manifest 驅動的分片備份。assembleV2Backup 只讀 zip、組裝內存對象，
                      // 校驗不過直接拋錯——此時 importFullData 還沒調，DB 一字未動。
                      let manifest: BackupManifest;
                      try {
                          manifest = JSON.parse(await manifestFile.async("string"));
                      } catch {
                          throw new Error("損壞的備份包：manifest.json 解析失敗");
                      }
                      data = await assembleV2Backup(
                          loadedZip as unknown as ZipFileReader,
                          manifest,
                          {
                              onYield: () => new Promise<void>(r => setTimeout(r, 0)),
                              onShardProgress: (field, idx, total) => {
                                  showImportProgress('parsing', '正在解析備份分片...',
                                      5 + Math.floor((idx / Math.max(1, total)) * 25),
                                      { current: `分片 ${field}` });
                              },
                          },
                      ) as FullBackupData;
                  } else {
                      // v1（老備份）：單根 data.json，原樣保留，老備份永遠打得開。
                      const dataFile = loadedZip.file("data.json");
                      if (!dataFile) throw new Error("損壞的備份包: 缺少 data.json");
                      let jsonStr = await dataFile.async("string");
                      data = JSON.parse(jsonStr);
                      jsonStr = '';
                  }
              }
          }

          // 必須發生在 restoreAssetsInPlace / DB.importFullData 之前：不受支持的第三方
          // 備份一旦命中特徵就整包拒絕，不能出現“導入了一半才報錯”的狀態。
          assertSupportedSullyBackup(data);

          // 在 importFullData 為釋放內存逐項清空 data 字段前凍結“這是否是主歷史替換”。
          // 新版 media_only 明確不動 SAR；舊備份沒有 mode 時，只要帶 characters/messages
          // 就按整檔恢復處理，避免導入後繼續沿用另一份歷史的公告/卡池/推演記錄。
          const replacesPrimaryHistory = data.collaborationBackupMode !== 'media_only'
              && (Object.prototype.hasOwnProperty.call(data, 'characters')
                  || Object.prototype.hasOwnProperty.call(data, 'messages'));

          // 協同文件先完整讀出並校驗，再開始寫任何主數據庫。這樣文件索引損壞或 ZIP
          // 缺項時會整包中止，不會出現主數據已恢復、協同文件只回來一半的狀態。
          let collaborationAssetRecords: Array<{ id: string; blob: Blob; createdAt: number }> | undefined;
          if (data.collaborationAssetIndex !== undefined) {
              collaborationAssetRecords = [];
              if (data.collaborationAssetIndex.length > 0 && !zip) {
                  throw new Error('損壞的備份包：協同文件缺少 ZIP 數據');
              }
              for (let index = 0; index < data.collaborationAssetIndex.length; index++) {
                  const item = data.collaborationAssetIndex[index];
                  if (!item?.id || !item.path?.startsWith('collaboration/assets/')) {
                      throw new Error('損壞的備份包：協同文件索引無效');
                  }
                  const entry = zip?.file(item.path);
                  if (!entry) throw new Error(`損壞的備份包：缺少協同文件 ${item.path}`);
                  const bytes = await entry.async('uint8array');
                  if (typeof item.size === 'number' && item.size >= 0 && bytes.byteLength !== item.size) {
                      throw new Error(`損壞的備份包：協同文件大小不符 ${item.path}`);
                  }
                  const fileBytes = new Uint8Array(bytes.byteLength);
                  fileBytes.set(bytes);
                  collaborationAssetRecords.push({
                      id: item.id,
                      blob: new Blob([fileBytes.buffer], { type: item.mimeType || 'application/octet-stream' }),
                      createdAt: Number(item.createdAt) || Date.now(),
                  });
                  if (index % 10 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
              }
          }

          // v2 backups keep favorite voice bytes outside JSON. Rehydrate every marker
          // before DB.importFullData starts, so a missing/truncated file aborts while
          // the current database is still untouched.
          if (zip && Array.isArray(data.assets)) {
              await restoreVoiceMessageBlobs(data.assets, async path => {
                  const entry = zip?.file(path);
                  return entry ? entry.async('uint8array') : null;
              });
          }

          // v3 blob 旁路：令牌原樣在 JSON 裡，二進制在 blobs/*。readBlobsIndex 先把索引
          // 與文件齊全性驗完（此時一個字節沒寫），再按原令牌 id 寫回 blob_assets——令牌
          // 身份保住，JSON 引用零改寫、零重編碼。中途失敗直接中止導入：主數據尚未寫庫，
          // 已寫回的部分只是孤兒 blob，由手動 GC 收口。v2 老包沒有索引文件，這裡是 no-op。
          if (zip) {
              const blobEntries = await readBlobsIndex(zip as unknown as ZipFileReader);
              if (blobEntries.length > 0) {
                  await restoreBlobsFromZip(
                      zip as unknown as ZipFileReader,
                      blobEntries,
                      restoreBlobRef,
                      {
                          onYield: () => new Promise<void>(r => setTimeout(r, 0)),
                          onProgress: (done, total, id) => {
                              showImportProgress('assets', '正在恢復圖片二進制...',
                                  30 + Math.floor((done / Math.max(1, total)) * 5),
                                  { current: `圖片二進制 ${done}/${total}`, currentFile: id });
                          },
                      },
                  );
              }
          }

          const hadAssetStoreBackup = data.assets !== undefined;
          const hadCustomIconsBackup = data.customIcons !== undefined;
          const hadAppearancePresetsBackup = data.appearancePresets !== undefined;

          const restoreAssetsInPlace = async (root: any, label = '數據'): Promise<void> => {
              if (!zip) return;

              type Ref = { parent: any; key: string | number; filename: string };
              const refsByFile = new Map<string, Ref[]>();
              const seen = new WeakSet<object>();
              const stack: any[] = [root];
              while (stack.length) {
                  const node = stack.pop();
                  if (node === null || typeof node !== 'object') continue;
                  if (seen.has(node)) continue;
                  seen.add(node);
                  if (Array.isArray(node)) {
                      for (let i = 0; i < node.length; i++) {
                          const v = node[i];
                          if (typeof v === 'string' && v.startsWith('assets/')) {
                              const filename = v.slice('assets/'.length);
                              const refs = refsByFile.get(filename) || [];
                              refs.push({ parent: node, key: i, filename });
                              refsByFile.set(filename, refs);
                          } else if (v && typeof v === 'object') {
                              stack.push(v);
                          }
                      }
                  } else {
                      for (const k in node) {
                          if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
                          const v = node[k];
                          if (typeof v === 'string' && v.startsWith('assets/')) {
                              const filename = v.slice('assets/'.length);
                              const refs = refsByFile.get(filename) || [];
                              refs.push({ parent: node, key: k, filename });
                              refsByFile.set(filename, refs);
                          } else if (v && typeof v === 'object') {
                              stack.push(v);
                          }
                      }
                  }
              }

              const entries = Array.from(refsByFile.entries());
              if (entries.length === 0) return;

              for (const [filename, refs] of entries) {
                  const fileInZip = zip.file(`assets/${filename}`) as (JSZipFileLike & { _data?: { compressedSize?: number; uncompressedSize?: number } }) | null;
                  const hintedSize = fileInZip?._data?.uncompressedSize || fileInZip?._data?.compressedSize;
                  showImportProgress('assets', '正在恢復素材...', 35 + Math.floor((restoredAssetFiles.size / Math.max(1, totalAssetFiles || entries.length)) * 35), {
                      current: label,
                      currentFile: filename,
                      currentFileSize: hintedSize,
                      assetDone: restoredAssetFiles.size,
                      assetTotal: totalAssetFiles || entries.length,
                  });

                  try {
                      if (!fileInZip) {
                          console.warn(`Missing asset in backup: assets/${filename}`);
                          continue;
                      }
                      const base64 = await fileInZip.async("base64");
                      const ext = (filename.split('.').pop() || 'png').toLowerCase();
                      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                          : ext === 'gif' ? 'image/gif'
                          : ext === 'webp' ? 'image/webp'
                          : 'image/png';
                      const dataUri = `data:${mime};base64,${base64}`;
                      for (const ref of refs) {
                          ref.parent[ref.key] = dataUri;
                      }
                      const decodedSize = estimateBase64Bytes(base64);
                      restoredAssetFiles.add(filename);
                      showImportProgress('assets', '正在恢復素材...', 35 + Math.floor((restoredAssetFiles.size / Math.max(1, totalAssetFiles || entries.length)) * 35), {
                          current: label,
                          currentFile: filename,
                          currentFileSize: decodedSize,
                          assetDone: restoredAssetFiles.size,
                          assetTotal: totalAssetFiles || entries.length,
                      });
                  } catch {
                      console.warn(`Failed to restore asset: assets/${filename}`);
                  }
                  await new Promise<void>(resolve => setTimeout(resolve, 0));
              }
          };

          showImportProgress('database', '正在寫入數據庫...', 50, { current: '準備寫入數據庫', currentFile: '' });
          await DB.importFullData(data, {
              beforeWrite: restoreAssetsInPlace,
              onProgress: progress => {
                  const sectionRatio = progress.sectionTotal > 0
                      ? progress.sectionDone / progress.sectionTotal
                      : 0;
                  const itemRatio = progress.itemTotal && progress.sectionTotal > 0
                      ? ((progress.itemDone || 0) / progress.itemTotal) / progress.sectionTotal
                      : 0;
                  const dbProgress = 50 + Math.floor(Math.min(1, sectionRatio + itemRatio) * 40);
                  showImportProgress('database', '正在寫入數據庫...', dbProgress, {
                      current: progress.stage === 'done' ? `${progress.label}完成` : progress.label,
                      currentFile: '',
                      itemDone: progress.itemDone,
                      itemTotal: progress.itemTotal,
                  });
              },
          });

          const hasCollaborationBackup = data.collaborationSessions !== undefined
              || data.collaborationMessages !== undefined
              || data.collaborationCategories !== undefined
              || data.collaborationSettings !== undefined
              || collaborationAssetRecords !== undefined;
          if (hasCollaborationBackup) {
              showImportProgress('database', '正在恢復協同工作...', 91, { current: '協同窗口與文件', currentFile: '' });
              const { CollaborationStore } = await import('../features/collaboration/store');
              await CollaborationStore.importBackup({
                  sessions: data.collaborationSessions,
                  messages: data.collaborationMessages,
                  categories: data.collaborationCategories,
                  settings: data.collaborationSettings,
                  assets: collaborationAssetRecords,
              }, {
                  replaceAssets: data.collaborationBackupMode === 'full',
              });
          }
          
          showImportProgress('settings', '正在恢復系統設置...', 92, { current: '系統設置', currentFile: '' });
          if (data.sarLocalState) await restoreAssetsInPlace(data.sarLocalState, 'SAR 存檔');
          restoreSARLocalBackup(data.sarLocalState, { replaceMissing: replacesPrimaryHistory });
          if (data.chatInputPreferences !== undefined) saveChatInputPreferences(data.chatInputPreferences);
          if (data.theme) {
              await restoreAssetsInPlace(data.theme, '系統主題');
              await updateTheme(data.theme);
          }
          if (data.apiConfig) updateApiConfig(data.apiConfig);
          if (data.checkPhoneApi !== undefined) setCheckPhoneApi(data.checkPhoneApi ?? null);
          if (data.availableModels) saveModels(data.availableModels);
          if (data.apiPresets) savePresets(data.apiPresets);
          if (data.realtimeConfig) updateRealtimeConfig(data.realtimeConfig); // 恢復實時感知配置
          if (data.memoryPalaceConfig) updateMemoryPalaceConfig(data.memoryPalaceConfig); // 恢復記憶宮殿全局配置

          if (data.customIcons !== undefined || data.appearancePresets !== undefined) {
              await restoreAssetsInPlace(data.customIcons, '應用圖標');
              await restoreAssetsInPlace(data.appearancePresets, '外觀預設');
              const existingAssets = await DB.getAllAssets();
              if (Array.isArray(existingAssets)) {
                  for (const asset of existingAssets) {
                      if (data.customIcons !== undefined && asset.id.startsWith('icon_')) {
                          await DB.deleteAsset(asset.id);
                      }
                      if (data.appearancePresets !== undefined && asset.id.startsWith('appearance_preset_')) {
                          await DB.deleteAsset(asset.id);
                      }
                  }
              }
              if (data.customIcons) {
                  for (const [appId, iconUrl] of Object.entries(data.customIcons)) {
                      const stored = iconUrl.startsWith('data:') ? await migrateDataUrlToRef(iconUrl) : iconUrl;
                      await DB.saveAsset(`icon_${appId}`, stored);
                  }
              }
              if (data.appearancePresets) {
                  const migratedPresets: AppearancePreset[] = [];
                  for (const preset of data.appearancePresets) {
                      const migrated = await migrateAppearancePresetBlobRefs(preset);
                      migratedPresets.push(migrated);
                      await DB.saveAsset(`appearance_preset_${migrated.id}`, JSON.stringify(migrated));
                  }
                  data.appearancePresets = migratedPresets;
              }
          }

          // Restore Study Room settings
          if (data.studyApiConfig) localStorage.setItem('study_api_config', JSON.stringify(data.studyApiConfig));
          if (data.studyTutorPresets) localStorage.setItem('study_tutor_presets', JSON.stringify(data.studyTutorPresets));

          // Restore 雲端配置
          if (data.cloudBackupConfig) localStorage.setItem('os_cloud_backup_config', JSON.stringify(data.cloudBackupConfig));
          if (data.remoteVectorConfig) localStorage.setItem('os_remote_vector_config', JSON.stringify(data.remoteVectorConfig));

          // Restore 推送憑據 (VAPID)
          if (data.pushVapid) localStorage.setItem('push_vapid_v1', JSON.stringify(data.pushVapid));


          // Restore Memory Palace 水位線
          if (data.memoryPalaceHighWaterMarks) {
              for (const [charId, hwm] of Object.entries(data.memoryPalaceHighWaterMarks)) {
                  if (typeof hwm === 'number' && hwm > 0) {
                      localStorage.setItem(`mp_lastMsgId_${charId}`, String(hwm));
                  }
              }
          }

          // Restore Memory Palace UI flags（人格檢測已跑過 / 首次 banner 已見等）
          if (data.memoryPalaceFlags && typeof data.memoryPalaceFlags === 'object') {
              for (const [key, val] of Object.entries(data.memoryPalaceFlags)) {
                  if (typeof val === 'string') {
                      // 只允許恢復 mp_ 前綴的鍵，避免導入數據汙染其它 localStorage
                      if (key.startsWith('mp_personality_tried_')
                          || key.startsWith('mp_first_archive_notice_')) {
                          localStorage.setItem(key, val);
                      }
                  }
              }
          }

          // Restore Chat 翻譯 / 歸檔 / 潤色設置
          if (typeof data.chatTranslateSourceLang === 'string') localStorage.setItem('chat_translate_source_lang', data.chatTranslateSourceLang);
          if (typeof data.chatTranslateTargetLang === 'string') localStorage.setItem('chat_translate_lang', data.chatTranslateTargetLang);
          if (data.chatTranslateEnabledByChar && typeof data.chatTranslateEnabledByChar === 'object') {
              for (const [charId, enabled] of Object.entries(data.chatTranslateEnabledByChar)) {
                  localStorage.setItem(`chat_translate_enabled_${charId}`, enabled ? 'true' : 'false');
              }
          }
          if (data.chatTranslateExpandedByChar && typeof data.chatTranslateExpandedByChar === 'object') {
              for (const [charId, expanded] of Object.entries(data.chatTranslateExpandedByChar)) {
                  localStorage.setItem(`chat_translate_expanded_${charId}`, expanded ? 'true' : 'false');
              }
          }
          if (data.chatTranslateSourceLangByChar && typeof data.chatTranslateSourceLangByChar === 'object') {
              for (const [charId, lang] of Object.entries(data.chatTranslateSourceLangByChar)) {
                  if (typeof lang === 'string') localStorage.setItem(`chat_translate_source_lang_${charId}`, lang);
              }
          }
          if (data.chatTranslateTargetLangByChar && typeof data.chatTranslateTargetLangByChar === 'object') {
              for (const [charId, lang] of Object.entries(data.chatTranslateTargetLangByChar)) {
                  if (typeof lang === 'string') localStorage.setItem(`chat_translate_lang_${charId}`, lang);
              }
          }
          if (data.chatArchivePrompts !== undefined) localStorage.setItem('chat_archive_prompts', JSON.stringify(data.chatArchivePrompts));
          if (typeof data.chatActiveArchivePromptId === 'string') localStorage.setItem('chat_active_archive_prompt_id', data.chatActiveArchivePromptId);
          if (data.characterRefinePrompts !== undefined) localStorage.setItem('character_refine_prompts', JSON.stringify(data.characterRefinePrompts));
          if (typeof data.characterActiveRefinePromptId === 'string') localStorage.setItem('character_active_refine_prompt_id', data.characterActiveRefinePromptId);

          // Restore UI / 偏好
          if (typeof data.scheduleAppTheme === 'string') localStorage.setItem('schedule_app_theme', data.scheduleAppTheme);
          if (typeof data.handbookLifestreamDepth === 'string') localStorage.setItem('handbook_lifestream_depth', data.handbookLifestreamDepth);
          if (typeof data.groupchatContextLimit === 'number') localStorage.setItem('groupchat_context_limit', String(data.groupchatContextLimit));
          if (data.browserConfig && typeof data.browserConfig === 'object') {
              if (typeof data.browserConfig.braveKey === 'string') localStorage.setItem('browser_brave_key', data.browserConfig.braveKey);
              if (typeof data.browserConfig.useRealSearch === 'boolean') localStorage.setItem('browser_use_real_search', data.browserConfig.useRealSearch ? 'true' : 'false');
          }
          if (typeof data.bm25Mode === 'string') localStorage.setItem('bm25_mode', data.bm25Mode);
          if (typeof data.lastActiveCharId === 'string') localStorage.setItem('os_last_active_char_id', data.lastActiveCharId);
          restoreStoryTheaterAppearanceSetting(data.storyTheaterAppearance);
          if (data.dreamCollection && typeof data.dreamCollection === 'object') localStorage.setItem('os_dream_collection', JSON.stringify(data.dreamCollection));
          if (typeof data.gotchiAccentHue === 'string' && /^\d+$/.test(data.gotchiAccentHue)) localStorage.setItem('tama_accent_hue', data.gotchiAccentHue);
          if (data.eventNotifFlags && typeof data.eventNotifFlags === 'object') {
              for (const [key, val] of Object.entries(data.eventNotifFlags)) {
                  // 只允許 sullyos_ 前綴，避免汙染其它鍵
                  if (typeof val === 'string' && key.startsWith('sullyos_')) {
                      localStorage.setItem(key, val);
                  }
              }
          }
          
          if (data.socialAppData) {
              await restoreAssetsInPlace(data.socialAppData, '動態設置');
              if (data.socialAppData.charHandles) localStorage.setItem('spark_char_handles', JSON.stringify(data.socialAppData.charHandles));
              if (data.socialAppData.userId) localStorage.setItem('spark_user_id', data.socialAppData.userId);
              
              // Restore heavy assets to DB
              if (data.socialAppData.userProfile) await DB.saveAsset('spark_social_profile', JSON.stringify(data.socialAppData.userProfile));
              if (data.socialAppData.userBg) await DB.saveAsset('spark_user_bg', data.socialAppData.userBg);
          }
          
          // Restore Room Custom Assets to DB (migrate old format on import)
          if (data.roomCustomAssets) {
              await restoreAssetsInPlace(data.roomCustomAssets, '房間自定義素材');
              const migratedAssets = data.roomCustomAssets.map((a: any) => ({
                  ...a,
                  id: a.id || `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                  visibility: a.visibility || 'public',
              }));
              await DB.saveAsset('room_custom_assets_list', JSON.stringify(migratedAssets));
          }

          const chars = await DB.getAllCharacters();
          const groupsList = await DB.getGroups();
          const themes = await DB.getThemes();
          const user = await DB.getUserProfile();
          const books = await DB.getAllWorldbooks();
          const novelList = await DB.getAllNovels();
          const songList = await DB.getAllSongs();
          
          if (hadAssetStoreBackup || hadCustomIconsBackup || hadAppearancePresetsBackup) {
              const assets = await DB.getAllAssets();
              const loadedIcons: Record<string, string> = {};
              const loadedPresets: AppearancePreset[] = [];
              if (Array.isArray(assets)) {
                  for (const a of assets) {
                      if (a.id.startsWith('icon_')) {
                          const stored = a.data.startsWith('data:') ? await migrateDataUrlToRef(a.data) : a.data;
                          loadedIcons[a.id.replace('icon_', '')] = stored;
                          if (stored !== a.data) await DB.saveAsset(a.id, stored);
                      }
                      if (a.id.startsWith('appearance_preset_')) {
                          try {
                              loadedPresets.push(JSON.parse(a.data));
                          } catch {}
                      }
                  }
              }
              setCustomIcons(loadedIcons);
              loadedPresets.sort((a, b) => b.createdAt - a.createdAt);
              setAppearancePresets(loadedPresets);
          }

          // 導入後的角色清單（下面主動消息 2.0 對帳要用規範化之後的那份）
          let importedChars = chars;
          if (chars.length > 0) {
              let importedAutoContextCount = 0;
              let importedContextMigrated = false;
              const normalizedChars = chars.map(c => {
                  const normalized = normalizeCharacterDefaults(normalizeCharacterImpression(c));
                  const migration = migrateCharacterContextRange(normalized);
                  if (migration.migrated) importedContextMigrated = true;
                  if (migration.resetAutoContext) importedAutoContextCount++;
                  return migration.character;
              });
              if (importedContextMigrated) {
                  await Promise.all(normalizedChars.map(c => DB.saveCharacter(c)));
              }
              setCharacters(normalizedChars);
              importedChars = normalizedChars;
              if (importedAutoContextCount > 0) {
                  setTimeout(() => addToast(
                      `導入的舊設置已升級：${importedAutoContextCount} 個全自動記憶角色已使用自適應上下文。`,
                      'info',
                  ), 600);
              }
          }
          if (groupsList.length > 0) setGroups(groupsList);
          if (themes.length > 0) setCustomThemes(themes);
          if (user) setUserProfileBase(user);
          if (books.length > 0) setWorldbooks(books);
          if (novelList.length > 0) setNovels(novelList);
          if (songList.length > 0) setSongs(songList);

          // ─── 主動消息 2.0：導入後跟雲端對一次帳 ───
          // 導入換掉了整套角色，worker 那邊卻還停在導入前：舊檔角色的遠端任務變成無主任務
          // 到點照樣推送，新檔角色的 fire_pack 和工具憑據則停格在導入前那一刻。
          // 整段 best-effort：這是恢復流程的收尾，雲端夠不著不該讓已經寫好的本地數據回滾。
          try {
              const amsgWorkerUrl = (await ActiveMsgStore.getGlobalConfig()).workerUrl?.trim();
              if (amsgWorkerUrl) {
                  const knownCharIds = new Set(importedChars.map(c => c.id));
                  const remoteTasks = await ActiveMsgClient.listAllTasks();
                  for (const task of remoteTasks) {
                      if (typeof task?.uuid !== 'string') continue;
                      const owner = typeof task?.charId === 'string' ? task.charId : '';
                      if (owner && knownCharIds.has(owner)) continue;
                      // 「導入即放棄舊數據」：這條任務的主人在新檔裡已經不存在了（連主人是誰
                      // 都沒投影出來的同理），它正屬於該一起放棄的部分，取消就是對的。
                      await ActiveMsgClient.cancelTask(task.uuid).catch(() => {});
                  }
                  // 留下來的角色逐個刷雲端快照，同時把導入進來的實時感知憑據傳上去。
                  // 走同一個入口：雲端提示詞是按憑據裁過的，兩者必須同進同退。
                  // 有 AI 任務的角色才會真的上傳（門在 markAmsgStateDirty 裡）。
                  syncAmsgToolConfigAndPrompts(
                      data.realtimeConfig || realtimeConfig,
                      { characters: importedChars, userProfile: applyActivePersona(user || userProfile), groups: groupsList },
                  );
              }
          } catch (e) {
              console.warn('[amsg2] 導入後雲端對帳失敗（本地數據已恢復，不受影響）', e);
          }

          setSysOperation({ status: 'idle', message: '', progress: 100 });
          clearImportInProgress();
          addToast('恢復成功，系統即將重啟...', 'success');
          setTimeout(() => window.location.reload(), 1500);

      } catch (e: any) {
          console.error("Import Error:", e);
          setSysOperation({ status: 'idle', message: '', progress: 0 });
          const msg = e instanceof SyntaxError ? 'JSON 格式錯誤' : (e.message || '未知錯誤');
          markImportInProgress('error', sourceName, {
              sourceSize,
              current: lastCurrent,
              currentFile: lastCurrentFile,
              currentFileSize: lastCurrentFileSize,
              assetDone: restoredAssetFiles.size,
              assetTotal: totalAssetFiles || undefined,
              error: msg,
          });
          throw new Error(`恢復失敗: ${msg}`);
      }
  };

  const resetSystem = async () => { try { await DB.deleteDB(); localStorage.clear(); window.location.reload(); } catch (e) { console.error(e); addToast('重置失敗，請手動清除瀏覽器數據', 'error'); } };
  const openApp = (appId: AppID) => setActiveApp(appId);
  const closeApp = () => setActiveApp(AppID.Launcher);
  // 從聊天直接進入某角色的見面：切換當前角色 + 標記自動進入 + 打開見面 App
  const openDateWithChar = (charId: string) => {
    setActiveCharacterId(charId);
    setDateAutoStartCharId(charId);
    setActiveApp(AppID.Date);
  };
  const consumeDateAutoStart = () => setDateAutoStartCharId(null);
  const openGroupChat = (groupId: string) => {
    setPendingGroupChatId(groupId);
    setActiveApp(AppID.GroupChat);
  };
  const consumePendingGroupChat = () => setPendingGroupChatId(null);
  const unlock = () => setIsLocked(false);

  const suspendCall = (info: { charId: string; charName: string; charAvatar?: string; startedAt: number; bubbles?: any[]; sessionId?: string; elapsedSeconds?: number; voiceLang?: string; pendingAvatarTouches?: AvatarTouchRecord[] }) => {
    setSuspendedCall(info);
    setActiveApp(AppID.Launcher);
  };
  const resumeCall = () => {
    setActiveApp(AppID.Call);
  };
  const clearSuspendedCall = () => {
    setSuspendedCall(null);
  };

  // --- Back Handler Logic ---
  const registerBackHandler = useCallback((handler: () => boolean) => {
      backHandlerRef.current = handler;
      return () => {
          if (backHandlerRef.current === handler) {
              backHandlerRef.current = null;
          }
      };
  }, []);

  const handleBack = useCallback(() => {
      if (backHandlerRef.current) {
          const handled = backHandlerRef.current();
          if (handled) return;
      }
      // Default: Close App
      if (activeApp !== AppID.Launcher) {
          closeApp();
      }
  }, [activeApp, closeApp]);

  const value: OSContextType = {
    activeApp,
    openApp,
    closeApp,
    theme,
    updateTheme,
    virtualTime,
    apiConfig,
    updateApiConfig,
    isLocked,
    unlock,
    isDataLoaded,
    characters,
    activeCharacterId,
    addCharacter,
    updateCharacter,
    deleteCharacter,
    setActiveCharacterId,
    npcs,
    addNPC,
    updateNPC,
    deleteNPC,
    characterGroups,
    createCharacterGroup,
    renameCharacterGroup,
    deleteCharacterGroup,
    worldbooks,
    addWorldbook,
    updateWorldbook,
    deleteWorldbook,
    updateWorldbooks,
    deleteWorldbooks,
    novels,
    addNovel,
    updateNovel,
    deleteNovel,
    songs,
    addSong,
    updateSong,
    deleteSong,
    groups,
    createGroup,
    updateGroup,
    deleteGroup,
    userProfile,
    userProfileBase,
    updateUserProfile,
    addUserPersona,
    updateUserPersona,
    deleteUserPersona,
    setActivePersonaId,
    availableModels,
    setAvailableModels,
    apiPresets,
    addApiPreset,
    updateApiPreset,
    removeApiPreset,
    realtimeConfig,
    updateRealtimeConfig,
    memoryPalaceConfig,
    updateMemoryPalaceConfig,
    syncEmotionApiToAllCharacters,
    remoteVectorConfig,
    updateRemoteVectorConfig,
    customThemes,
    addCustomTheme,
    removeCustomTheme,
    appearancePresets,
    saveAppearancePreset,
    applyAppearancePreset,
    deleteAppearancePreset,
    renameAppearancePreset,
    exportAppearancePreset,
    importAppearancePreset,
    toasts,
    addToast,
    errorDialog,
    showError,
    dismissError,
    customIcons,
    setCustomIcon,
    resetAppearance,
    lastMsgTimestamp,
    unreadMessages,
    clearUnread,
    proactiveComposingChars,
    cloudBackupConfig,
    updateCloudBackupConfig,
    cloudBackupToWebDAV,
    cloudRestoreFromWebDAV,
    listCloudBackups,
    exportSystem,
    importSystem,
    resetSystem,
    sysOperation,
    systemLogs,
    clearLogs,
    registerBackHandler,
    handleBack,
    suspendedCall,
    suspendCall,
    resumeCall,
    clearSuspendedCall,
    dateAutoStartCharId,
    openDateWithChar,
    consumeDateAutoStart,
    pendingGroupChatId,
    openGroupChat,
    consumePendingGroupChat
  };

  return (
    <OSContext.Provider value={value}>
      {children}
    </OSContext.Provider>
  );
};

export const useOS = () => {
  const context = useContext(OSContext);
  if (context === undefined) {
    throw new Error('useOS must be used within an OSProvider');
  }
  return context;
};
