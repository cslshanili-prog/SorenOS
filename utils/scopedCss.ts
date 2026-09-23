// 限定作用域的用戶自定義 CSS 校驗 —— 氣泡工坊（.sully-bubble-*）與心象卡片（.sully-psyche*）共用。
// 注意：這是編輯期軟校驗（語法檢查 + 選擇器作用域白名單），不做 XSS 級安全過濾；
// 注入端仍是原樣 <style>，作用域白名單隻為防止用戶樣式外溢汙染整個應用。

export type CssValidationResult = {
    isValid: boolean;
    errors: string[];
    errorLines: number[];
    importantCount: number;
};

export const findLineNumberByIndex = (input: string, index: number) => input.slice(0, index).split('\n').length;

const extractLineFromErrorMessage = (message: string) => {
    const lineMatch = message.match(/line\s*(\d+)/i);
    return lineMatch ? parseInt(lineMatch[1], 10) : null;
};

/**
 * @param selectorRegex 非 @ 規則的每個選擇器必須命中的白名單正則（如 /^\.sully-bubble-(user|ai)\b/）
 * @param scopeHint     報錯文案裡展示給用戶看的作用域說明（如「.sully-bubble-user / .sully-bubble-ai」）
 */
export const validateScopedCss = (css: string, selectorRegex: RegExp, scopeHint: string): CssValidationResult => {
    const source = css || '';
    const errors: string[] = [];
    const errorLines: number[] = [];
    const pushError = (message: string, line?: number | null) => {
        errors.push(message);
        if (line && !Number.isNaN(line)) {
            errorLines.push(line);
        }
    };

    const importantCount = (source.match(/!important/g) || []).length;
    if (!source.trim()) {
        return { isValid: true, errors: [], errorLines: [], importantCount };
    }

    // Minimal syntax check 1: browser parser
    try {
        if (typeof CSSStyleSheet !== 'undefined') {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(source);
        }
    } catch (error: any) {
        pushError(`CSS 語法錯誤：${error?.message || '請檢查語法。'}`, extractLineFromErrorMessage(error?.message || ''));
    }

    // Minimal syntax check 2: brace balance
    const braceStack: number[] = [];
    [...source].forEach((char, index) => {
        if (char === '{') braceStack.push(index);
        if (char === '}') {
            if (braceStack.length === 0) {
                pushError('發現多餘的 `}`，請檢查大括號閉合。', findLineNumberByIndex(source, index));
            } else {
                braceStack.pop();
            }
        }
    });
    braceStack.forEach(index => pushError('存在未閉合的 `{`，請補全規則塊。', findLineNumberByIndex(source, index)));

    // Scope check（先去掉註釋，避免 /* comment */ .selector 誤報）
    const sourceWithoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const ruleRegex = /([^{}]+)\{/g;
    let selectorMatch = ruleRegex.exec(sourceWithoutComments);
    while (selectorMatch) {
        const selectorGroup = selectorMatch[1].trim();
        if (!selectorGroup.startsWith('@')) {
            const selectorList = selectorGroup.split(',').map(item => item.trim()).filter(Boolean);
            selectorList.forEach(selector => {
                // @keyframes 的內部步驟也會被上面的輕量 ruleRegex 讀成普通“選擇器”。
                // 它們不訪問 DOM，不屬於作用域外溢，應該放行；真正的語法仍由
                // CSSStyleSheet.replaceSync / 大括號檢查負責。
                if (/^(?:from|to|\d+(?:\.\d+)?%)$/i.test(selector)) return;
                if (!selectorRegex.test(selector)) {
                    pushError(
                        `選擇器 \`${selector}\` 超出限定範圍，僅允許以 ${scopeHint} 開頭。`,
                        findLineNumberByIndex(sourceWithoutComments, selectorMatch!.index)
                    );
                }
            });
        }
        selectorMatch = ruleRegex.exec(sourceWithoutComments);
    }

    return {
        isValid: errors.length === 0,
        errors,
        errorLines,
        importantCount
    };
};

/** 把 CSS 真插進 <style> 數 cssRules，驗證瀏覽器確實能渲染出規則 */
export const runCssRenderabilityCheck = (css: string, validation: CssValidationResult) => {
    if (!validation.isValid) {
        return {
            ok: false,
            message: `CSS 不可渲染：第 ${validation.errorLines[0] || '?'} 行附近存在錯誤，請先修復。`
        };
    }

    if (!css.trim()) {
        return { ok: true, message: '' };
    }

    try {
        const styleEl = document.createElement('style');
        styleEl.textContent = css;
        document.head.appendChild(styleEl);
        const ruleCount = styleEl.sheet?.cssRules?.length ?? 0;
        styleEl.remove();
        if (ruleCount === 0) {
            return { ok: false, message: 'CSS 未生成有效規則，請確認語法和選擇器。' };
        }
    } catch (error: any) {
        return { ok: false, message: `CSS 渲染檢查失敗：${error?.message || '未知錯誤。'}` };
    }

    return { ok: true, message: '' };
};
