/**
 * 小程序（麥當勞 / 瑞幸）點單模式下一次工具調用該交給誰。
 *
 * 這兩個模式的循環原本只認 propose_cart_items，其餘一律當畸形調用回錯讓模型自糾。
 * 但主動消息 2.0 的排程工具是常駐注入的，也會出現在同一批 tool_calls 裡——被當成畸形
 * 吃掉後，緊接著的續寫請求又把 tools 刪了，角色「點單時順手排個提醒」就永遠不會生效。
 */

import { AMSG2_TOOL_NAMES } from './amsg2ToolBridge';

export type MiniAppToolRoute = 'propose' | 'amsg2' | 'malformed';

export const routeMiniAppToolCall = (fname: string, args: any): MiniAppToolRoute => {
  if (AMSG2_TOOL_NAMES.has(fname)) return 'amsg2';
  if (fname === 'propose_cart_items' && Array.isArray(args?.items) && args.items.length) return 'propose';
  return 'malformed';
};
