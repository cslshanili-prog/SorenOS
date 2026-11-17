/**
 * API 中心（plans/api-center-failover.md 第 1 批）：三個「副 API」各自的解析順序只在這裡寫一次。
 *
 * - 記憶副 API：memoryPalaceConfig.lightLLM（沒配就不跑，不回落主 API）——這裡不管它
 * - 情緒／日程 API：角色自己的 emotionConfig.api > 系統設置的 apiConfig.meterApi > 主 API
 * - 主動消息單獨 API：角色自己開的 activeMsg2Config.secondaryApi > 系統設置的 apiConfig.amsgApi > 角色的對話模型 > 主 API
 */

import type { APIConfig, SecondaryApi } from '../types';

export type ApiLike = Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'> & Partial<Pick<APIConfig, 'meterApi' | 'amsgApi'>>;

/** 填了 URL 和 Key 才算一組能用的 */
export const isUsableSecondaryApi = (api: Partial<SecondaryApi> | null | undefined): api is SecondaryApi =>
    !!api && !!api.baseUrl?.trim() && !!api.apiKey?.trim() && !!api.model?.trim();

/** 情緒／日程 API 的全局槽；沒設（或沒填齊）回 null */
export const globalMeterApi = (apiConfig: ApiLike | null | undefined): SecondaryApi | null =>
    isUsableSecondaryApi(apiConfig?.meterApi) ? apiConfig!.meterApi! : null;

/** 主動消息單獨 API 的全局槽；沒設回 null */
export const globalAmsgApi = (apiConfig: ApiLike | null | undefined): SecondaryApi | null =>
    isUsableSecondaryApi(apiConfig?.amsgApi) ? apiConfig!.amsgApi! : null;

/** 這組 API 現在是從哪一層來的（介面上標給用戶看） */
export type ApiSourceLabel = '角色自己的' | '系統設置的副 API' | '角色的對話模型' | '主 API';

export const describeMeterApiSource = (charApi: Partial<SecondaryApi> | null | undefined, apiConfig: ApiLike | null | undefined): ApiSourceLabel =>
    charApi?.baseUrl ? '角色自己的' : globalMeterApi(apiConfig) ? '系統設置的副 API' : '主 API';
