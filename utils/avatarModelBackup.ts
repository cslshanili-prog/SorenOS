import { buildZip, openZipWithFallback } from './zipStream/factory';
import type { BackupZipReader } from './zipStream/reader';
import type { CharacterProfile } from '../types';
import { DB } from './db';
import { live2DRuntimeCacheAssetIds } from './avatarModelStore';

export const AVATAR_MODEL_BACKUP_FORMAT = 'sully-avatar-models';
export const AVATAR_MODEL_BACKUP_VERSION = 1;

type VideoAvatarConfig = NonNullable<CharacterProfile['videoAvatar']>;

export interface AvatarModelBackupInventoryItem {
  characterId: string;
  characterName: string;
  format: VideoAvatarConfig['format'];
  fileName: string;
  byteLength: number;
  available: boolean;
}

export interface AvatarModelBackupInventory {
  models: AvatarModelBackupInventoryItem[];
  availableCount: number;
  missingCount: number;
  totalBytes: number;
}

export interface AvatarModelBackupProgress {
  phase: 'scan' | 'pack' | 'restore';
  done: number;
  total: number;
  label: string;
}

interface AvatarModelManifestEntry {
  characterId: string;
  characterName: string;
  path: string;
  byteLength: number;
  config: VideoAvatarConfig;
  slot?: 'active' | 'wardrobe';
}

interface AvatarModelBackupManifest {
  format: typeof AVATAR_MODEL_BACKUP_FORMAT;
  version: typeof AVATAR_MODEL_BACKUP_VERSION;
  createdAt: number;
  models: AvatarModelManifestEntry[];
}

export interface RestoredAvatarModel {
  characterId: string;
  characterName: string;
  config: VideoAvatarConfig;
}

export interface AvatarModelRestoreResult {
  total: number;
  restored: number;
  skipped: number;
  restoredBytes: number;
  models: RestoredAvatarModel[];
  warnings: string[];
}

const modelPath = (index: number, format: VideoAvatarConfig['format']): string => (
  `models/${String(index + 1).padStart(3, '0')}.${format === 'vrm' ? 'vrm' : 'live2d.zip'}`
);

const isSafeModelPath = (value: string): boolean => (
  /^models\/[^/]+$/i.test(value) && !value.includes('..') && !value.includes('\\')
);

const isVideoAvatarConfig = (value: unknown): value is VideoAvatarConfig => {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<VideoAvatarConfig>;
  return config.version === 1
    && (config.format === 'vrm' || config.format === 'live2d')
    && typeof config.assetId === 'string'
    && config.assetId.length > 0
    && typeof config.fileName === 'string';
};

const readManifest = async (zip: BackupZipReader): Promise<AvatarModelBackupManifest> => {
  const entry = zip.file('manifest.json');
  if (!entry) throw new Error('這不是 Sully 模型備份：缺少 manifest.json。');

  let value: unknown;
  try {
    value = JSON.parse(await entry.async('string'));
  } catch {
    throw new Error('模型備份清單無法讀取，文件可能已損壞。');
  }

  const manifest = value as Partial<AvatarModelBackupManifest>;
  if (manifest.format !== AVATAR_MODEL_BACKUP_FORMAT) {
    throw new Error('這不是 Sully 模型備份，請在上方“導入普通備份”中選擇它。');
  }
  if (manifest.version !== AVATAR_MODEL_BACKUP_VERSION) {
    throw new Error(`不支持的模型備份版本：${String(manifest.version ?? '未知')}。`);
  }
  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    throw new Error('模型備份中沒有可恢復的模型。');
  }
  if (manifest.models.length > 200) {
    throw new Error('模型備份中的模型數量異常，已停止導入。');
  }

  const seenAssetIds = new Set<string>();
  for (const item of manifest.models) {
    if (!item || typeof item.characterId !== 'string' || !item.characterId) {
      throw new Error('模型備份清單缺少角色 ID。');
    }
    if (!isSafeModelPath(item.path) || !zip.file(item.path)) {
      throw new Error(`模型文件缺失或路徑不安全：${item.path || '未知路徑'}。`);
    }
    if (!Number.isSafeInteger(item.byteLength) || item.byteLength <= 0) {
      throw new Error(`模型 ${item.characterName || item.characterId} 的大小信息無效。`);
    }
    if (!isVideoAvatarConfig(item.config)) {
      throw new Error(`模型 ${item.characterName || item.characterId} 的配置無效。`);
    }
    if (seenAssetIds.has(item.config.assetId)) {
      throw new Error(`模型備份中資源 ${item.config.assetId} 出現了兩次。`);
    }
    seenAssetIds.add(item.config.assetId);
  }

  return manifest as AvatarModelBackupManifest;
};

export const getAvatarModelBackupInventory = async (): Promise<AvatarModelBackupInventory> => {
  const characters = await DB.getAllCharacters();
  const models: AvatarModelBackupInventoryItem[] = [];

  for (const character of characters) {
    const configs = [character.videoAvatar, ...(character.videoAvatarWardrobe || [])]
      .filter((config, index, all): config is VideoAvatarConfig => Boolean(config)
        && all.findIndex(item => item?.assetId === config?.assetId) === index);
    for (const config of configs) {
      // Built-in Sully ships with the application and has no IndexedDB blob to
      // back up. Character framing/quality preferences remain in normal data.
      if (config.format === 'live2d' && config.builtIn) continue;
      const blob = await DB.getBlobAsset(config.assetId);
      models.push({
        characterId: character.id,
        characterName: character.name,
        format: config.format,
        fileName: config.fileName,
        byteLength: blob?.size || config.byteLength || 0,
        available: Boolean(blob),
      });
    }
  }

  return {
    models,
    availableCount: models.filter(model => model.available).length,
    missingCount: models.filter(model => !model.available).length,
    totalBytes: models.reduce((sum, model) => sum + (model.available ? model.byteLength : 0), 0),
  };
};

export const createAvatarModelBackup = async (
  onProgress?: (progress: AvatarModelBackupProgress) => void,
): Promise<Blob> => {
  const characters = await DB.getAllCharacters();
  const candidates = characters.flatMap(character => {
    const configs = [character.videoAvatar, ...(character.videoAvatarWardrobe || [])]
      .filter((config, index, all): config is VideoAvatarConfig => Boolean(config)
        && all.findIndex(item => item?.assetId === config?.assetId) === index);
    return configs
      .filter(config => !(config.format === 'live2d' && config.builtIn))
      .map(config => ({
        character,
        config,
        slot: config.assetId === character.videoAvatar?.assetId ? 'active' as const : 'wardrobe' as const,
      }));
  });
  if (!candidates.length) throw new Error('當前沒有需要備份的自定義模型；Sully 內置模型會隨應用自動提供。');

  // 模型一個一個讀、寫出去就放（plans/backup-streaming.md 第 4 批）。以前是全部讀進記憶體、最後一次打包，
  // 幾個上百 MB 的模型在手機上會讓分頁被系統關掉。輸出能寫磁碟就寫磁碟上的暫存檔。
  // 寫暫存檔失敗時 buildZip 會用記憶體把這段重跑一次，所以清單每次從頭組。
  let models: AvatarModelManifestEntry[] = [];
  const archive = await buildZip({ tmpPrefix: 'models' }, async (zip) => {
    models = [];
    for (let index = 0; index < candidates.length; index++) {
      const { character, config, slot } = candidates[index];
      onProgress?.({ phase: 'scan', done: index, total: candidates.length, label: `正在讀取 ${character.name} 的模型…` });
      const blob = await DB.getBlobAsset(config.assetId);
      if (!blob) continue;
      const path = modelPath(models.length, config.format);
      zip.file(path, blob, { compression: 'STORE' });
      await zip.drain();
      models.push({
        characterId: character.id,
        characterName: character.name,
        path,
        byteLength: blob.size,
        config: { ...config, byteLength: blob.size },
        slot,
      });
      onProgress?.({ phase: 'scan', done: index + 1, total: candidates.length, label: `已加入 ${character.name}` });
    }

    if (!models.length) throw new Error('角色資料裡有模型索引，但本地模型文件已經丟失。');

    const manifest: AvatarModelBackupManifest = {
      format: AVATAR_MODEL_BACKUP_FORMAT,
      version: AVATAR_MODEL_BACKUP_VERSION,
      createdAt: Date.now(),
      models,
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2), { compression: 'STORE' });
    onProgress?.({ phase: 'pack', done: 100, total: 100, label: '正在生成模型備份 100%…' });
  });
  return archive;
};

export const restoreAvatarModelBackup = async (
  file: Blob,
  onProgress?: (progress: AvatarModelBackupProgress) => void,
): Promise<AvatarModelRestoreResult> => {
  // 只讀目錄，要哪個模型才讀那一段；整個備份檔不進記憶體（第 4 批）
  const zip = await openZipWithFallback(file);
  const manifest = await readManifest(zip);
  const characters = await DB.getAllCharacters();
  const byId = new Map(characters.map(character => [character.id, character]));
  const byName = new Map<string, CharacterProfile | null>();
  for (const character of characters) {
    const existing = byName.get(character.name);
    byName.set(character.name, existing === undefined ? character : null);
  }

  const result: AvatarModelRestoreResult = {
    total: manifest.models.length,
    restored: 0,
    skipped: 0,
    restoredBytes: 0,
    models: [],
    warnings: [],
  };

  for (let index = 0; index < manifest.models.length; index++) {
    const item = manifest.models[index];
    const target = byId.get(item.characterId) || byName.get(item.characterName) || null;
    if (!target) {
      result.skipped += 1;
      result.warnings.push(`未找到角色“${item.characterName}”，已跳過其模型。`);
      continue;
    }

    onProgress?.({
      phase: 'restore',
      done: index,
      total: manifest.models.length,
      label: `正在恢復 ${item.characterName}（${index + 1}/${manifest.models.length}）…`,
    });
    const entry = zip.file(item.path)!;
    const type = item.config.format === 'vrm' ? 'model/gltf-binary' : 'application/zip';
    // 隨機讀取器開的檔：模型沒壓縮，直接拿備份檔裡的那一段當 Blob 存，內容不經過記憶體。
    // 退回 JSZip 時沒有 blob()，照舊讀成位元組。
    let blob: Blob;
    if (typeof (entry as { blob?: unknown }).blob === 'function') {
      blob = await entry.blob(type);
    } else {
      const bytes = await entry.async('uint8array');
      blob = new Blob([bytes.slice().buffer], { type });
    }
    if (blob.size !== item.byteLength) {
      throw new Error(`模型 ${item.characterName} 大小校驗失敗，已停止導入。`);
    }

    const config = { ...item.config, byteLength: blob.size } as VideoAvatarConfig;
    await DB.putBlobAsset(config.assetId, blob);
    if (config.format === 'live2d') {
      await Promise.all(live2DRuntimeCacheAssetIds(config.assetId).map(id => DB.deleteBlobAsset(id)));
    }
    const updatedTarget = item.slot === 'wardrobe'
      ? {
          ...target,
          videoAvatarWardrobe: [
            ...(target.videoAvatarWardrobe || []).filter(model => model.assetId !== config.assetId),
            config,
          ],
        }
      : { ...target, videoAvatar: config };
    await DB.saveCharacter(updatedTarget);
    byId.set(target.id, updatedTarget);
    result.restored += 1;
    result.restoredBytes += blob.size;
    result.models.push({ characterId: target.id, characterName: target.name, config });
    onProgress?.({
      phase: 'restore',
      done: index + 1,
      total: manifest.models.length,
      label: `已恢復 ${target.name}`,
    });
  }

  return result;
};
