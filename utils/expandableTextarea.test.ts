// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExpandableTextarea from '../components/common/ExpandableTextarea';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const typeInto = (el: HTMLTextAreaElement, text: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
};
const button = (label: RegExp | string) => [...document.querySelectorAll('button')].find(b => (typeof label === 'string' ? b.textContent === label || b.getAttribute('aria-label') === label : label.test(b.getAttribute('aria-label') || b.textContent || '')))!;

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; });

const mount = (props: Partial<React.ComponentProps<typeof ExpandableTextarea>> = {}) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const Harness = () => {
        const [v, setV] = React.useState('原本');
        return React.createElement(ExpandableTextarea, { title: '人設', value: v, onChange: (x: string) => { setV(x); onChange(x); }, onCommit, ...props });
    };
    act(() => root!.render(React.createElement(Harness)));
    return { onChange, onCommit };
};

describe('ExpandableTextarea', () => {
    it('全螢幕改完按完成：回填，再叫 onCommit（失焦才存的框靠它存）', () => {
        const { onChange, onCommit } = mount();
        act(() => button(/全螢幕編輯：人設/).click());
        const full = document.querySelector('[role=dialog] textarea') as HTMLTextAreaElement;
        expect(full.value).toBe('原本');
        act(() => typeInto(full, '改過的'));
        act(() => button('完成').click());
        expect(onChange).toHaveBeenLastCalledWith('改過的');
        expect(onCommit).toHaveBeenCalledWith('改過的');
        expect(document.querySelector('[role=dialog]')).toBeNull();
    });

    it('取消不回填', () => {
        const { onChange, onCommit } = mount();
        act(() => button(/全螢幕編輯：人設/).click());
        act(() => typeInto(document.querySelector('[role=dialog] textarea') as HTMLTextAreaElement, '不要'));
        act(() => button('取消').click());
        expect(onChange).not.toHaveBeenCalled();
        expect(onCommit).not.toHaveBeenCalled();
    });

    it('唯讀：只能看，關掉不回填', () => {
        const { onChange } = mount({ readOnly: true });
        act(() => button(/全螢幕查看：人設/).click());
        expect((document.querySelector('[role=dialog] textarea') as HTMLTextAreaElement).readOnly).toBe(true);
        expect(button('取消')).toBeUndefined();
        act(() => button('關閉').click());
        expect(onChange).not.toHaveBeenCalled();
    });
});
