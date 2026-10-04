import React, { useMemo } from 'react';
import { useOS } from '../context/OSContext';
import ShoppingMallMiniApp, { type MallSendOrderInput } from '../components/mall/ShoppingMallMiniApp';
import { DB } from '../utils/db';
import { applyRealBalanceDelta, ensureRealBalanceState } from '../utils/realBalance';
import { mallRecipientsFrom, mallSpendLabel } from '../utils/mallOrders';
import { trackEvent } from '../utils/analytics';

/**
 * 桌面「購物中心」（2026-10 第三批，見 plans/mall-redesign.md）。跟私聊「＋」進去的是同一個頁面，差在：
 * - 「給誰」可以挑自己或任一角色（拉黑中的不列）；沒有代付（要有人在對話裡回你）、沒有手動模擬卡。
 * - 給角色的：扣你的錢，卡片以你發的訊息寫進那個角色的私聊，不逼角色馬上回——下次聊天它就看到了。
 * - 給自己的：扣你的錢，只記一筆訂單，不發卡。
 * - 結帳後留在購物中心的訂單頁。
 */
const MallApp: React.FC = () => {
    const { closeApp, characters, userProfileBase, updateUserProfile, addToast, apiConfig, apiPresets } = useOS();
    const recipients = useMemo(() => mallRecipientsFrom(characters), [characters]);
    const balance = ensureRealBalanceState(userProfileBase.realBalance).balance;

    const handleSendOrder = async (order: MallSendOrderInput): Promise<boolean> => {
        if (order.mode !== 'gift' && order.mode !== 'self') return false;
        const char = order.recipientCharId ? characters.find(c => c.id === order.recipientCharId) : undefined;
        if (order.recipientCharId && !char) { addToast('找不到這個角色了', 'error'); return false; }
        const result = applyRealBalanceDelta(ensureRealBalanceState(userProfileBase.realBalance), -order.total, mallSpendLabel(order.mallKind, char?.name));
        if (!result.ok) { addToast(result.reason, 'error'); return false; }
        updateUserProfile({ realBalance: result.state });
        if (char) {
            await DB.saveMessage({
                charId: char.id, role: 'user', type: 'mall_order', content: '[購物中心卡片]',
                metadata: {
                    mallKind: order.mallKind, mode: 'gift', items: order.items, note: order.note,
                    total: order.total, orderId: order.orderId, paidAt: order.paidAt, status: 'sent',
                },
            });
        }
        trackEvent('购物中心桌面下单', { mallKind: order.mallKind, 给谁: char ? '角色' : '自己' });
        return true;
    };

    return (
        <ShoppingMallMiniApp
            open
            onClose={closeApp}
            recipients={recipients}
            userBalance={balance}
            onSendOrder={handleSendOrder}
            addToast={addToast}
            apiConfig={apiConfig}
            apiPresets={apiPresets}
        />
    );
};

export default MallApp;
