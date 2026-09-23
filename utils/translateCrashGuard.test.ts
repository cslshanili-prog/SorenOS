import { describe, it, expect, afterAll, vi } from 'vitest';
import { installTranslateCrashGuard } from './translateCrashGuard';

// 鎖住「瀏覽器自動翻譯改 DOM → React reconcile 拋 NotFoundError 白屏」的護欄行為。
// 測試環境是 node, 沒有真實 Node, 這裡搭一個最小 DOM 模型:
// 原生 insertBefore/removeChild 在「參照/待刪節點不是自己孩子」時拋錯 (復刻瀏覽器行為),
// 護欄裝上後應降級到節點真正的 parent 上完成操作, 而非拋錯。

class FakeNode {
    parentNode: FakeNode | null = null;
    childNodes: FakeNode[] = [];

    insertBefore(newNode: FakeNode, ref: FakeNode | null): FakeNode {
        if (ref && ref.parentNode !== this) {
            throw new Error("NotFoundError: reference node is not a child of this node");
        }
        const idx = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
        this.childNodes.splice(idx, 0, newNode);
        newNode.parentNode = this;
        return newNode;
    }

    removeChild(child: FakeNode): FakeNode {
        if (child.parentNode !== this) {
            throw new Error("NotFoundError: node is not a child of this node");
        }
        this.childNodes.splice(this.childNodes.indexOf(child), 1);
        child.parentNode = null;
        return child;
    }

    appendChild(node: FakeNode): FakeNode {
        this.childNodes.push(node);
        node.parentNode = this;
        return node;
    }
}

// 用 FakeNode 冒充全局 Node, 再裝護欄 (護欄改的就是 Node.prototype)。
vi.stubGlobal('Node', FakeNode);
installTranslateCrashGuard();

afterAll(() => {
    vi.unstubAllGlobals();
});

describe('installTranslateCrashGuard - insertBefore', () => {
    it('參照節點正常 (是 this 的孩子) 時, 行為不變', () => {
        const parent = new FakeNode();
        const a = new FakeNode();
        const b = new FakeNode();
        parent.appendChild(b);
        parent.insertBefore(a, b);
        expect(parent.childNodes).toEqual([a, b]);
    });

    it('參照節點被「翻譯器」搬到別的 parent 後, 不再拋錯, 而是插到它真正的 parent', () => {
        const reactParent = new FakeNode();
        const translatorWrapper = new FakeNode();
        const ref = new FakeNode();
        // 翻譯器把 ref 從 reactParent 搬進了 translatorWrapper
        translatorWrapper.appendChild(ref);

        const newNode = new FakeNode();
        // React 以為 ref 還在 reactParent 下 → 原生會拋 NotFoundError
        expect(() => reactParent.insertBefore(newNode, ref)).not.toThrow();
        // 降級: 插到 ref 真正的 parent (translatorWrapper)
        expect(translatorWrapper.childNodes).toEqual([newNode, ref]);
    });

    it('參照節點已徹底脫離文檔樹時, 退化為 append 到 this, 不拋錯', () => {
        const parent = new FakeNode();
        const orphanRef = new FakeNode(); // parentNode 為 null
        const newNode = new FakeNode();
        expect(() => parent.insertBefore(newNode, orphanRef)).not.toThrow();
        expect(parent.childNodes).toEqual([newNode]);
    });
});

describe('installTranslateCrashGuard - removeChild', () => {
    it('待刪節點是 this 的孩子時, 行為不變', () => {
        const parent = new FakeNode();
        const child = new FakeNode();
        parent.appendChild(child);
        parent.removeChild(child);
        expect(parent.childNodes).toEqual([]);
    });

    it('待刪節點被「翻譯器」搬走後, 從它真正的 parent 刪除, 不拋錯', () => {
        const reactParent = new FakeNode();
        const translatorWrapper = new FakeNode();
        const child = new FakeNode();
        translatorWrapper.appendChild(child);

        expect(() => reactParent.removeChild(child)).not.toThrow();
        expect(translatorWrapper.childNodes).toEqual([]);
        expect(child.parentNode).toBeNull();
    });

    it('待刪節點已脫離文檔樹時, 靜默返回, 不拋錯', () => {
        const reactParent = new FakeNode();
        const orphan = new FakeNode();
        expect(() => reactParent.removeChild(orphan)).not.toThrow();
    });
});
