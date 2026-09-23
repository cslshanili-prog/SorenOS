/**
 * Pixel Home — LLM 裝修邏輯
 *
 * 消化後觸發，角色基於消化結果決定是否調整房間。
 * 輸出 JSON diff，不刪除用戶放的傢俱。
 */

import type { DecorationDiff, DecorationAction, PixelRoomLayout } from '../apps/pixelHome/types';
import type { MemoryRoom } from './memoryPalace/types';
import type { DigestResult } from './memoryPalace/digestion';
import { PixelLayoutDB } from '../apps/pixelHome/pixelHomeDb';
import { ROOM_META, ALL_ROOMS } from '../apps/pixelHome/roomTemplates';
import { safeFetchJson } from './safeApi';

interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 角色自主裝修：基於消化結果生成裝修 diff 並應用。
 */
export async function generateDecoration(
  charId: string,
  charName: string,
  persona: string,
  llmConfig: LLMConfig,
  digestResult?: DigestResult | null,
  userName?: string,
): Promise<DecorationDiff | null> {
  try {
    // 獲取當前所有房間佈局
    const layouts = await PixelLayoutDB.getAllForChar(charId);
    if (layouts.length === 0) return null;

    const layoutSummary = layouts.map(l => ({
      room: l.roomId,
      name: ROOM_META[l.roomId].name,
      wall: l.wallColor,
      floor: l.floorColor,
      furniture: l.furniture.map(f => ({
        slot: f.slotId,
        x: Math.round(f.x),
        y: Math.round(f.y),
        hasCustomAsset: !!f.assetId,
        placedBy: f.placedBy,
      })),
    }));

    // 消化摘要
    let digestSummary = '';
    if (digestResult) {
      const parts: string[] = [];
      if (digestResult.resolved.length > 0) parts.push(`化解了${digestResult.resolved.length}個困惑`);
      if (digestResult.deepened.length > 0) parts.push(`${digestResult.deepened.length}個創傷加深了`);
      if (digestResult.fulfilled.length > 0) parts.push(`${digestResult.fulfilled.length}個期盼實現了`);
      if (digestResult.disappointed.length > 0) parts.push(`${digestResult.disappointed.length}個期盼落空了`);
      if (digestResult.selfInsights.length > 0) parts.push(`產生了${digestResult.selfInsights.length}個自我領悟`);
      digestSummary = parts.length > 0 ? `最近的心理變化：${parts.join('，')}。` : '';
    }

    const systemPrompt = `你是${charName}，正在整理自己的像素小屋。
${persona ? `你的人設：${persona.slice(0, 500)}` : ''}

你有7個房間，每個房間有5個固定傢俱槽位。你可以：
1. 移動傢俱位置 (move)：調整 x,y 座標（0-100 的百分比）
2. 換色 (recolor)：給傢俱換個顏色覆蓋
3. 調大小 (rescale)：調整傢俱的縮放比例（0.3-3.0）
4. 換牆色 (set_wall)：換房間牆壁顏色
5. 換地板色 (set_floor)：換房間地板顏色
6. 設氛圍 (set_ambiance)：給房間寫一句氛圍描述

規則：
- 你不能刪除${userName || '用戶'}放的傢俱（placedBy: "user"），但可以微調位置
- 不要大幅改動，只做1-5個小變化
- 變化要反映你當前的心境
- 如果沒什麼變化的心境，返回空數組

${digestSummary}

當前房間佈局：
${JSON.stringify(layoutSummary, null, 2)}

請返回JSON格式（僅返回JSON，不要其他文字）：
{
  "actions": [
    { "type": "move", "roomId": "bedroom", "slotId": "lamp", "x": 80, "y": 40 },
    { "type": "set_wall", "roomId": "bedroom", "color": "#ede9fe" },
    { "type": "set_ambiance", "roomId": "bedroom", "ambiance": "今晚的月光特別溫柔" }
  ],
  "summary": "你的一句裝修感言"
}`;

    const data = await safeFetchJson(
      `${llmConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${llmConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: llmConfig.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: '請根據你現在的心境，決定要不要整理一下房間。' },
          ],
          temperature: 0.7,
          max_tokens: 800,
        }),
      },
      2, 0, { appName: '小小窩', purpose: '房間佈置' },
    );

    const reply = data.choices?.[0]?.message?.content || '';
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('🏠 [HomeDecoration] 角色決定不裝修');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const actions: DecorationAction[] = (parsed.actions || []).filter((a: any) =>
      a.type && a.roomId && ALL_ROOMS.includes(a.roomId)
    );

    if (actions.length === 0) {
      console.log('🏠 [HomeDecoration] 無裝修動作');
      return null;
    }

    const diff: DecorationDiff = {
      charId,
      actions,
      summary: parsed.summary || '',
      timestamp: Date.now(),
    };

    // 應用裝修
    await applyDecoration(charId, diff, layouts);

    console.log(`🏠 [HomeDecoration] ${charName}整理了房間：${diff.summary}（${actions.length}個變化）`);
    return diff;
  } catch (err: any) {
    console.warn(`🏠 [HomeDecoration] 裝修失敗: ${err.message}`);
    return null;
  }
}

/** 將裝修 diff 應用到 DB */
async function applyDecoration(
  charId: string,
  diff: DecorationDiff,
  layouts: PixelRoomLayout[],
): Promise<void> {
  const layoutMap = new Map(layouts.map(l => [l.roomId, { ...l }]));

  for (const action of diff.actions) {
    const layout = layoutMap.get(action.roomId);
    if (!layout) continue;

    switch (action.type) {
      case 'move': {
        if (!action.slotId) break;
        const f = layout.furniture.find(f => f.slotId === action.slotId);
        if (f && f.placedBy !== 'user') {
          if (action.x != null) f.x = Math.max(5, Math.min(95, action.x));
          if (action.y != null) f.y = Math.max(10, Math.min(90, action.y));
        }
        // 用戶放的傢俱只做微調（±5）
        if (f && f.placedBy === 'user') {
          if (action.x != null) f.x = Math.max(5, Math.min(95, f.x + Math.max(-5, Math.min(5, action.x - f.x))));
          if (action.y != null) f.y = Math.max(10, Math.min(90, f.y + Math.max(-5, Math.min(5, action.y - f.y))));
        }
        break;
      }
      case 'recolor': {
        if (!action.slotId || !action.color) break;
        const f = layout.furniture.find(f => f.slotId === action.slotId);
        if (f) f.colorOverride = action.color;
        break;
      }
      case 'rescale': {
        if (!action.slotId || action.scale == null) break;
        const f = layout.furniture.find(f => f.slotId === action.slotId);
        if (f && f.placedBy !== 'user') {
          f.scale = Math.max(0.3, Math.min(3, action.scale));
        }
        break;
      }
      case 'set_wall':
        if (action.color) layout.wallColor = action.color;
        break;
      case 'set_floor':
        if (action.color) layout.floorColor = action.color;
        break;
      case 'set_ambiance':
        if (action.ambiance) layout.ambiance = action.ambiance;
        break;
    }

    layout.lastUpdatedAt = Date.now();
    layout.lastDecoratedBy = 'character';
  }

  // 保存修改的房間
  const modifiedRooms = diff.actions
    .map(a => a.roomId)
    .filter((v, i, arr) => arr.indexOf(v) === i);

  for (const roomId of modifiedRooms) {
    const layout = layoutMap.get(roomId);
    if (layout) await PixelLayoutDB.save(layout);
  }
}
