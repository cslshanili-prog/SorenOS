/**
 * 思考鏈參數（thinking / reasoning_effort）能不能和 tools 一起發。
 *
 * 背景：Gemini 兼容層收到 thinking 參數 + tools 會直接 400 INVALID_ARGUMENT，
 * 表現是「開了思考鏈的角色一用工具就報錯，換個沒開思考鏈的角色就好」。
 *
 * 兩類工具的處理不一樣：
 *  - 小程序點單 / 瑞幸聊天 / 通用 MCP：用戶主動進入的模式，一律思考鏈讓步（既有慣例，
 *    只影響這一輪對話）。
 *  - 主動消息 2.0：配了 worker 就常駐在每一輪請求裡。要是也一刀切讓步，等於所有配過
 *    worker 的角色永久失去思考鏈——代價比偶發 400 大得多。所以只對真會打回的渠道讓步。
 */

/**
 * 這個渠道會不會因為「thinking + tools 同發」打回請求。
 * 目前只有 Gemini 系確認會（含各種帶前綴的中轉名，如 google/gemini-2.0-flash）。
 * 以後發現別的渠道也炸，往這裡加就行。
 */
export const modelRejectsThinkingWithTools = (model: string): boolean =>
  /gemini/i.test(model || '');

export const shouldSendThinkingParams = (input: {
  /** 用戶在角色設置裡開的「思考過程展示」。 */
  thinkingActive: boolean;
  /** 小程序 / 瑞幸聊天 / 通用 MCP 這類用戶主動進入的工具模式。 */
  legacyToolModeActive: boolean;
  /** 本輪是否注入了主動消息 2.0 的排程工具。 */
  amsg2ToolsInjected: boolean;
  model: string;
}): boolean => {
  if (!input.thinkingActive) return false;
  if (input.legacyToolModeActive) return false;
  if (input.amsg2ToolsInjected && modelRejectsThinkingWithTools(input.model)) return false;
  return true;
};
