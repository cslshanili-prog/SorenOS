import React, { useEffect, useMemo, useState } from 'react';
import { useOS } from '../context/OSContext';
import ShoppingMallMiniApp, { type MallSendOrderInput } from '../components/mall/ShoppingMallMiniApp';
import { DB } from '../utils/db';
import { applyRealBalanceDelta, ensureRealBalanceState } from '../utils/realBalance';
import { mallRecipientsFrom, mallSpendLabel } from '../utils/mallOrders';
import { trackEvent } from '../utils/analytics';
import type { MallProduct } from '../types';
import GiftPlanTargetPage from '../components/mall/GiftPlanTargetPage';
import { mallLaunch } from '../utils/appLaunch';
import { lineArgFromKey } from '../utils/bond/collect';
import { plannedGiftFromProduct } from '../utils/bond/gift';
import { saveBondEntry } from '../utils/bond/entries';

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
    // 羈絆「去買」帶來的：那件放進購物車、給 TA、記在那條線（只讀一次）
    const [launch] = useState(() => mallLaunch.peek());
    useEffect(() => { mallLaunch.consume(); }, []);
    const [planning, setPlanning] = useState<MallProduct | null>(null);

    const handleSendOrder = async (order: MallSendOrderInput): Promise<boolean> => {
        if (order.mode !== 'gift' && order.mode !== 'self') return false;
        const char = order.recipientCharId ? characters.find(c => c.id === order.recipientCharId) : undefined;
        if (order.recipientCharId && !char) { addToast('找不到這個角色了', 'error'); return false; }
        const result = applyRealBalanceDelta(ensureRealBalanceState(userProfileBase.realBalance), -order.total, mallSpendLabel(order.mallKind, char?.name));
        if (!result.ok) { addToast(result.reason, 'error'); return false; }
        updateUserProfile({ realBalance: result.state });
        if (char) {
            // 卡片寫進那條線的私聊（羈絆去買帶來的線；平常是主線）
            const line = order.lineKey ? lineArgFromKey(order.lineKey) : char.id;
            const lineFields = typeof line === 'string' ? { charId: char.id } : { charId: char.id, personaKey: line.personaKey };
            await DB.saveMessage({
                ...lineFields, role: 'user', type: 'mall_order', content: '[購物中心卡片]',
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
        <>
        <ShoppingMallMiniApp
            open
            onClose={closeApp}
            recipients={recipients}
            userBalance={balance}
            onSendOrder={handleSendOrder}
            addToast={addToast}
            apiConfig={apiConfig}
            apiPresets={apiPresets}
            launch={launch}
            orderLineKey={cid => (launch && launch.recipientCharId === cid ? launch.lineKey : undefined)}
            onPlanGift={setPlanning}
        />
        {planning && (
            <GiftPlanTargetPage product={planning} characters={characters} allowed={recipients.map(r => r.id)} userProfileBase={userProfileBase}
                onBack={() => setPlanning(null)}
                onPick={async t => {
                    try {
                        await saveBondEntry(plannedGiftFromProduct(t.bondId, planning));
                        trackEvent('羁绊礼物', { 动作: '打算', 方向: '我送', 来源: '购物' });
                        addToast(`記下了：打算送${t.charName}（在羈絆的珍藏裡，只有你看得到）`, 'success');
                        setPlanning(null);
                    } catch (e: any) {
                        addToast(`沒記成功：${e?.message || e}`, 'error');
                    }
                }} />
        )}
        </>
    );
};

export default MallApp;
