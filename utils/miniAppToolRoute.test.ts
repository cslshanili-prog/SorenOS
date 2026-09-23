// utils/miniAppToolRoute.test.ts
// 小程序（麥當勞 / 瑞幸）點單模式下，這一輪請求裡除了 propose_cart_items，還掛著主動消息
// 2.0 的排程工具。小程序的工具循環原本把「不是 propose_cart_items 的一律當畸形調用回錯」，
// 於是角色在點單時想排個定時消息，調用會被吃掉當報錯，緊接著的續寫請求又把 tools 刪了，
// 排程永遠走不到執行器。這裡釘住分流：amsg2 工具必須被認出來，不能落進 malformed。
import { describe, it, expect, vi } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: { scheduleCharacterTask: vi.fn(), cancelTask: vi.fn() },
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { getGlobalConfig: vi.fn() },
}));

import { routeMiniAppToolCall } from './miniAppToolRoute';

describe('routeMiniAppToolCall', () => {
  it('帶 items 的 propose_cart_items → 走小程序推薦卡', () => {
    expect(routeMiniAppToolCall('propose_cart_items', { items: [{ code: 'a' }] })).toBe('propose');
  });

  it('排程工具 → 交給 amsg2 執行器（迴歸：被當成畸形調用吃掉）', () => {
    expect(routeMiniAppToolCall('schedule_active_message', { send_at: 'x' })).toBe('amsg2');
  });

  it('取消 / 續期 / 列表也一樣放行', () => {
    expect(routeMiniAppToolCall('cancel_active_message', {})).toBe('amsg2');
    expect(routeMiniAppToolCall('renew_active_message', { send_at: 'x' })).toBe('amsg2');
    expect(routeMiniAppToolCall('list_active_messages', {})).toBe('amsg2');
  });

  it('propose_cart_items 但 items 空 → 仍算畸形，讓模型自糾（既有行為不迴歸）', () => {
    expect(routeMiniAppToolCall('propose_cart_items', { items: [] })).toBe('malformed');
    expect(routeMiniAppToolCall('propose_cart_items', {})).toBe('malformed');
  });

  it('模型幻覺出的工具名 → 畸形', () => {
    expect(routeMiniAppToolCall('order_pizza', {})).toBe('malformed');
  });
});
