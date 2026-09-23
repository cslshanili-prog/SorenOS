import type { APIConfig, ApiPreset } from '../../types';
import { extractModelIds } from '../../utils/modelList';
import { safeResponseJson } from '../../utils/safeApi';
import type { CollaborationApiProfile, CollaborationSettings } from './types';

const hasConnection = (profile: CollaborationApiProfile): boolean => Boolean(
  profile.baseUrl.trim() || profile.apiKey.trim() || profile.model.trim(),
);

export const collaborationProfileFromApi = (
  config: APIConfig,
  source: 'chat' | 'preset' | 'custom',
  sourceName: string,
  sourceId?: string,
): CollaborationApiProfile => ({
  baseUrl: config.baseUrl || '',
  apiKey: config.apiKey || '',
  model: config.model || '',
  stream: config.stream ?? true,
  temperature: config.temperature ?? 0.7,
  source,
  sourceId,
  sourceName,
});

const refreshLinkedProfile = (
  profile: CollaborationApiProfile,
  config: APIConfig,
  sourceName: string,
): CollaborationApiProfile => ({
  ...profile,
  baseUrl: config.baseUrl || '',
  apiKey: config.apiKey || '',
  model: config.model || '',
  sourceName,
});

/**
 * Old blank collaboration settings become a live copy of the current Chat API.
 * Existing hand-written settings remain custom; linked sources refresh their
 * credentials/model while retaining collaboration-specific stream/temperature.
 */
export const hydrateCollaborationApiSettings = (
  settings: CollaborationSettings,
  chatApi: APIConfig,
  presets: ApiPreset[],
): CollaborationSettings => {
  const hydrateProfile = (profile: CollaborationApiProfile): CollaborationApiProfile => {
    if (!profile.source) {
      if (hasConnection(profile)) return { ...profile, source: 'custom', sourceName: '協同專用配置' };
      return collaborationProfileFromApi(chatApi, 'chat', '當前 ChatApp');
    }
    if (profile.source === 'chat') {
      return refreshLinkedProfile(profile, chatApi, '當前 ChatApp');
    }
    if (profile.source === 'preset') {
      const preset = presets.find(item => item.id === profile.sourceId);
      if (preset) return refreshLinkedProfile(profile, preset.config, preset.name);
      return { ...profile, source: 'custom', sourceId: undefined, sourceName: `${profile.sourceName || '已刪除預設'} · 副本` };
    }
    return profile;
  };

  return {
    ...settings,
    immersive: hydrateProfile(settings.immersive),
    focused: hydrateProfile(settings.focused),
  };
};

export const collaborationProfileMatches = (
  profile: CollaborationApiProfile,
  config: APIConfig,
): boolean => profile.baseUrl.trim().replace(/\/+$/, '') === (config.baseUrl || '').trim().replace(/\/+$/, '')
  && profile.apiKey === (config.apiKey || '')
  && profile.model === (config.model || '');

export const fetchCollaborationModels = async (
  profile: Pick<CollaborationApiProfile, 'baseUrl' | 'apiKey'>,
  request: typeof fetch = fetch,
): Promise<string[]> => {
  const baseUrl = profile.baseUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('請先選擇一個已保存的連接');
  const response = await request(`${baseUrl}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${profile.apiKey || 'sk-none'}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const models = extractModelIds(await safeResponseJson(response));
  if (models.length === 0) throw new Error('模型列表為空或格式不兼容');
  return models;
};
