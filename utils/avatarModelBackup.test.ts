import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  getAllCharacters: vi.fn(),
  getBlobAsset: vi.fn(),
  putBlobAsset: vi.fn(),
  deleteBlobAsset: vi.fn(),
  saveCharacter: vi.fn(),
}));

vi.mock('./db', () => ({ DB: dbMock }));

import {
  AVATAR_MODEL_BACKUP_FORMAT,
  createAvatarModelBackup,
  getAvatarModelBackupInventory,
  restoreAvatarModelBackup,
} from './avatarModelBackup';

const vrmConfig = {
  version: 1 as const,
  format: 'vrm' as const,
  assetId: 'video-avatar-vrm-a',
  fileName: 'A.vrm',
  byteLength: 3,
  importedAt: 1,
};

const live2dConfig = {
  version: 1 as const,
  format: 'live2d' as const,
  assetId: 'video-avatar-live2d-b',
  fileName: 'B',
  modelPath: 'B/B.model3.json',
  byteLength: 4,
  fileCount: 2,
  importedAt: 2,
  lipSyncParameterIds: ['ParamMouthOpenY'],
  actions: [],
};

const sourceCharacters = [
  { id: 'a', name: 'A', avatar: '', videoAvatar: vrmConfig },
  { id: 'b', name: 'B', avatar: '', videoAvatar: live2dConfig },
];

describe('avatar model backup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.getAllCharacters.mockResolvedValue(sourceCharacters);
    dbMock.getBlobAsset.mockImplementation(async (id: string) => {
      if (id === vrmConfig.assetId) return new Blob([new Uint8Array([1, 2, 3])]);
      if (id === live2dConfig.assetId) return new Blob([new Uint8Array([4, 5, 6, 7])]);
      return null;
    });
    dbMock.putBlobAsset.mockResolvedValue(undefined);
    dbMock.deleteBlobAsset.mockResolvedValue(undefined);
    dbMock.saveCharacter.mockResolvedValue(undefined);
  });

  it('lists only source model blobs and reports their real stored size', async () => {
    const inventory = await getAvatarModelBackupInventory();
    expect(inventory).toMatchObject({ availableCount: 2, missingCount: 0, totalBytes: 7 });
    expect(inventory.models.map(model => model.format)).toEqual(['vrm', 'live2d']);
  });

  it('packs multiple character models into one STORE archive without derived runtime cache', async () => {
    const blob = await createAvatarModelBackup();
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));

    expect(manifest.format).toBe(AVATAR_MODEL_BACKUP_FORMAT);
    expect(manifest.models).toHaveLength(2);
    expect(Object.keys(zip.files).filter(path => path.startsWith('models/') && !zip.files[path].dir)).toEqual([
      'models/001.vrm',
      'models/002.live2d.zip',
    ]);
    expect(Object.keys(zip.files).some(path => path.includes('runtime-store'))).toBe(false);
  });

  it('includes inactive wardrobe models and restores them without replacing the active model', async () => {
    const spare = { ...live2dConfig, assetId: 'video-avatar-live2d-spare', fileName: 'B-night' };
    dbMock.getAllCharacters.mockResolvedValue([
      { id: 'b', name: 'B', avatar: '', videoAvatar: live2dConfig, videoAvatarWardrobe: [spare] },
    ]);
    dbMock.getBlobAsset.mockImplementation(async (id: string) => (
      id === live2dConfig.assetId || id === spare.assetId ? new Blob([new Uint8Array([4, 5, 6, 7])]) : null
    ));

    const archive = await createAvatarModelBackup();
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.models.map((item: any) => item.slot)).toEqual(['active', 'wardrobe']);

    await restoreAvatarModelBackup(archive);
    expect(dbMock.saveCharacter).toHaveBeenLastCalledWith(expect.objectContaining({
      videoAvatar: expect.objectContaining({ assetId: live2dConfig.assetId }),
      videoAvatarWardrobe: [expect.objectContaining({ assetId: spare.assetId })],
    }));
  });

  it('restores model blobs and character configs strictly one at a time', async () => {
    const archive = await createAvatarModelBackup();
    const writes: string[] = [];
    dbMock.putBlobAsset.mockImplementation(async (id: string) => {
      writes.push(`start:${id}`);
      await Promise.resolve();
      writes.push(`done:${id}`);
    });

    const result = await restoreAvatarModelBackup(archive);

    expect(result).toMatchObject({ total: 2, restored: 2, skipped: 0, restoredBytes: 7 });
    expect(writes).toEqual([
      `start:${vrmConfig.assetId}`,
      `done:${vrmConfig.assetId}`,
      `start:${live2dConfig.assetId}`,
      `done:${live2dConfig.assetId}`,
    ]);
    expect(dbMock.saveCharacter).toHaveBeenCalledTimes(2);
    expect(dbMock.deleteBlobAsset).toHaveBeenCalledWith(`${live2dConfig.assetId}:live2d-runtime-store-v1`);
    expect(dbMock.deleteBlobAsset).toHaveBeenCalledWith(`${live2dConfig.assetId}:live2d-runtime-store-v1:balanced`);
    expect(dbMock.deleteBlobAsset).toHaveBeenCalledWith(`${live2dConfig.assetId}:live2d-runtime-store-v1:hd`);
  });

  it('skips a model when its character has not been restored yet', async () => {
    const archive = await createAvatarModelBackup();
    dbMock.getAllCharacters.mockResolvedValue([{ id: 'a', name: 'A', avatar: '', videoAvatar: vrmConfig }]);

    const result = await restoreAvatarModelBackup(archive);

    expect(result).toMatchObject({ total: 2, restored: 1, skipped: 1 });
    expect(result.warnings[0]).toContain('B');
  });

  // 第 4 批：打包和還原換成串流寫入器／隨機讀取器，下面幾條鎖著「跟以前的備份互通」
  const bytesOf = async (blob: Blob) => Array.from(new Uint8Array(await blob.arrayBuffer()));

  it('restores each model as a slice of the archive with the right type and bytes', async () => {
    const archive = await createAvatarModelBackup();
    const stored = new Map<string, Blob>();
    dbMock.putBlobAsset.mockImplementation(async (id: string, blob: Blob) => { stored.set(id, blob); });

    await restoreAvatarModelBackup(archive);

    expect(stored.get(vrmConfig.assetId)!.type).toBe('model/gltf-binary');
    expect(await bytesOf(stored.get(vrmConfig.assetId)!)).toEqual([1, 2, 3]);
    expect(stored.get(live2dConfig.assetId)!.type).toBe('application/zip');
    expect(await bytesOf(stored.get(live2dConfig.assetId)!)).toEqual([4, 5, 6, 7]);
  });

  it('restores an archive produced by the previous JSZip packer (streamed, with data descriptors)', async () => {
    const legacy = new JSZip();
    legacy.file('models/001.vrm', new Uint8Array([1, 2, 3]), { compression: 'STORE' });
    legacy.file('models/002.live2d.zip', new Uint8Array([4, 5, 6, 7]), { compression: 'STORE' });
    legacy.file('manifest.json', JSON.stringify({
      format: AVATAR_MODEL_BACKUP_FORMAT,
      version: 1,
      createdAt: 1,
      models: [
        { characterId: 'a', characterName: 'A', path: 'models/001.vrm', byteLength: 3, config: vrmConfig },
        { characterId: 'b', characterName: 'B', path: 'models/002.live2d.zip', byteLength: 4, config: live2dConfig },
      ],
    }), { compression: 'STORE' });
    const archive = await legacy.generateAsync({ type: 'blob', streamFiles: true, compression: 'STORE' });
    const stored = new Map<string, Blob>();
    dbMock.putBlobAsset.mockImplementation(async (id: string, blob: Blob) => { stored.set(id, blob); });

    const result = await restoreAvatarModelBackup(archive);

    expect(result).toMatchObject({ total: 2, restored: 2, skipped: 0, restoredBytes: 7 });
    expect(await bytesOf(stored.get(vrmConfig.assetId)!)).toEqual([1, 2, 3]);
    expect(await bytesOf(stored.get(live2dConfig.assetId)!)).toEqual([4, 5, 6, 7]);
  });

  it('stops before writing when a model in the archive is not the size the manifest says', async () => {
    const broken = new JSZip();
    broken.file('models/001.vrm', new Uint8Array([1, 2]), { compression: 'STORE' });
    broken.file('manifest.json', JSON.stringify({
      format: AVATAR_MODEL_BACKUP_FORMAT,
      version: 1,
      createdAt: 1,
      models: [{ characterId: 'a', characterName: 'A', path: 'models/001.vrm', byteLength: 3, config: vrmConfig }],
    }));
    const archive = await broken.generateAsync({ type: 'blob' });

    await expect(restoreAvatarModelBackup(archive)).rejects.toThrow('大小校驗失敗');
    expect(dbMock.putBlobAsset).not.toHaveBeenCalled();
  });

  it('reads the models one at a time when packing, never holding two at once', async () => {
    let held = 0;
    let peak = 0;
    dbMock.getBlobAsset.mockImplementation(async (id: string) => {
      const source = new Blob([new Uint8Array(id === vrmConfig.assetId ? [1, 2, 3] : [4, 5, 6, 7])]);
      // 包一層：寫入器真的去讀它的時候才算「握著」，讀完就放
      return new Proxy(source, {
        get(target, key) {
          if (key === 'arrayBuffer') return async () => { held++; peak = Math.max(peak, held); try { return await target.arrayBuffer(); } finally { held--; } };
          const value = (target as any)[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });

    const archive = await createAvatarModelBackup();

    expect(peak).toBe(1);
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    expect(Array.from(await zip.file('models/002.live2d.zip')!.async('uint8array'))).toEqual([4, 5, 6, 7]);
  });
});
