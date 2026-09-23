/**
 * 瀏覽器自動翻譯導致 React 崩潰自愈 —— "Failed to execute 'insertBefore'/'removeChild' on 'Node'"
 *
 * 觸發場景 (Chrome / Edge / 三星瀏覽器 等開啟「網頁自動翻譯」時高發):
 *  - 翻譯引擎會把頁面裡的文本節點 (Text node) 拆開、替換、外面再包一層 <font> 之類的容器,
 *    直接改動了 React 託管的真實 DOM 結構;
 *  - 之後 React 走 reconcile 想 removeChild / insertBefore 某個節點時, 該節點的 parentNode
 *    已經被翻譯器換掉了, 瀏覽器拋 NotFoundError: "The node before which the new node is to be
 *    inserted is not a child of this node." —— 整個 App 白屏崩潰。
 *  - 用戶側表現: 關掉翻譯就好了, 但開著翻譯就一進來 / 一切換頁面就報錯。
 *
 * 業界通行解法 (facebook/react#11538): 給 Node.prototype.insertBefore / removeChild 打個護欄 ——
 * 當參照節點 / 待刪節點的 parentNode 已經不是 this 時 (說明被翻譯器搬走了), 不再硬調原生方法拋錯,
 * 而是降級處理 (儘量在節點真正的 parent 上補做一次, 否則靜默返回)。React 下一輪渲染會自我修正,
 * 既不崩潰, 也不影響翻譯功能本身。
 *
 * 注意: 只在瀏覽器環境裝一次, 冪等。必須在 React 掛載前執行 (見 index.tsx 首行 import)。
 */

import { trackEvent } from './analytics';

let installed = false;

export const installTranslateCrashGuard = (): void => {
    if (installed) return;
    if (typeof Node !== 'function' || !Node.prototype) return;
    installed = true;

    const originalInsertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function <T extends Node>(this: Node, newNode: T, referenceNode: Node | null): T {
        // 參照節點存在、但它的爹已經不是 this —— 翻譯器把 DOM 搬過家了, 硬插會拋 NotFoundError。
        if (referenceNode && referenceNode.parentNode !== this) {
            // 儘量在參照節點真正的 parent 上完成插入, 讓視覺結果儘量正確;
            if (referenceNode.parentNode) {
                trackEvent('触发翻译白屏护栏', { 降级路径: '插入改挂真父节点' });
                return originalInsertBefore.call(referenceNode.parentNode, newNode, referenceNode) as T;
            }
            // 參照節點已徹底脫離文檔樹, 退化成 append 到 this, 總比崩潰強。
            trackEvent('触发翻译白屏护栏', { 降级路径: '插入降级为追加' });
            return this.appendChild(newNode) as T;
        }
        return originalInsertBefore.call(this, newNode, referenceNode) as T;
    } as typeof Node.prototype.insertBefore;

    const originalRemoveChild = Node.prototype.removeChild;
    Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
        // 待刪節點的爹已經不是 this —— 同樣是翻譯器搬家所致, 硬刪會拋 NotFoundError。
        if (child.parentNode !== this) {
            // 節點若還掛在別處, 就從它真正的 parent 上刪掉; 否則視為已脫離, 直接返回。
            if (child.parentNode) {
                trackEvent('触发翻译白屏护栏', { 降级路径: '删除改挂真父节点' });
                return originalRemoveChild.call(child.parentNode, child) as T;
            }
            trackEvent('触发翻译白屏护栏', { 降级路径: '删除视为已脱离' });
            return child;
        }
        return originalRemoveChild.call(this, child) as T;
    } as typeof Node.prototype.removeChild;
};
