
export const processImage = (file: File, options?: { maxWidth?: number, quality?: number, forceJpeg?: boolean, skipCompression?: boolean }): Promise<string> => {
    return new Promise((resolve, reject) => {
        // 簡單驗證
        if (!file.type.startsWith('image/')) {
            reject(new Error('請上傳圖片文件'));
            return;
        }

        // 1. 如果開啟了 skipCompression (用於壁紙等)，直接讀取原文件返回，不經過Canvas重繪
        if (options?.skipCompression) {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = (e) => resolve(e.target?.result as string);
            reader.onerror = (e) => reject(new Error('文件讀取失敗'));
            return;
        }

        // GIF 不壓縮直接讀取（放寬限制至 50MB）
        if (file.type === 'image/gif') {
            if (file.size > 50 * 1024 * 1024) {
                reject(new Error('GIF 圖片過大(>50MB)，可能導致應用崩潰'));
                return;
            }
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = (e) => resolve(e.target?.result as string);
            reader.onerror = (e) => reject(e);
            return;
        }

        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target?.result as string;
            img.onload = () => {
                // 壓縮邏輯
                // 默認 1200 (高畫質)，如果傳入 options 則使用傳入值 (如 Chat 中傳 600)
                const MAX_WIDTH = options?.maxWidth || 1200; 
                const MAX_HEIGHT = MAX_WIDTH; // 保持比例限制
                
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > MAX_WIDTH) {
                        height *= MAX_WIDTH / width;
                        width = MAX_WIDTH;
                    }
                } else {
                    if (height > MAX_HEIGHT) {
                        width *= MAX_HEIGHT / height;
                        height = MAX_HEIGHT;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error('Canvas context error'));
                    return;
                }
                
                // 清空畫布 (保證透明)
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);
                
                // 智能格式選擇: 
                // 1. 如果 forceJpeg 為 true (如聊天發送圖)，強制轉 JPEG 以節省體積
                // 2. 否則如果原圖是 PNG/WebP，保持格式以保留透明通道 (如立繪、貼紙)
                // 3. 默認 JPEG
                let mimeType = 'image/jpeg';
                if (!options?.forceJpeg && (file.type === 'image/png' || file.type === 'image/webp')) {
                    mimeType = file.type;
                }
                
                // 質量控制: 默認 0.85，傳入值優先
                const quality = options?.quality || 0.85;
                
                const dataUrl = canvas.toDataURL(mimeType, quality);
                resolve(dataUrl);
            };
            img.onerror = (err) => reject(new Error('圖片加載失敗'));
        };
        reader.onerror = (err) => reject(new Error('文件讀取失敗'));
    });
};

/**
 * 與 processImage 同款壓縮邏輯，但產出 Blob 而非 base64 data URL —— 供改存 Blob 的
 * 場景（壁紙、小屋等，見 utils/blobRef.ts）使用，省掉一次 base64 編碼 + 常駐內存。
 * GIF / skipCompression 直接返回原文件（File 本身即 Blob，不經 Canvas 重繪）。
 */
export const processImageToBlob = (file: File, options?: { maxWidth?: number, quality?: number, forceJpeg?: boolean, skipCompression?: boolean }): Promise<Blob> => {
    return new Promise((resolve, reject) => {
        if (!file.type.startsWith('image/')) {
            reject(new Error('請上傳圖片文件'));
            return;
        }

        // 壁紙等：不重繪，原文件即結果（File 繼承自 Blob）。
        if (options?.skipCompression) {
            resolve(file);
            return;
        }

        // GIF 不壓縮直接用原文件（放寬限制至 50MB）。
        if (file.type === 'image/gif') {
            if (file.size > 50 * 1024 * 1024) {
                reject(new Error('GIF 圖片過大(>50MB)，可能導致應用崩潰'));
                return;
            }
            resolve(file);
            return;
        }

        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target?.result as string;
            img.onload = () => {
                const MAX_WIDTH = options?.maxWidth || 1200;
                const MAX_HEIGHT = MAX_WIDTH;

                let width = img.width;
                let height = img.height;
                if (width > height) {
                    if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
                } else {
                    if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) { reject(new Error('Canvas context error')); return; }
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);

                let mimeType = 'image/jpeg';
                if (!options?.forceJpeg && (file.type === 'image/png' || file.type === 'image/webp')) {
                    mimeType = file.type;
                }
                const quality = options?.quality || 0.85;

                canvas.toBlob(
                    (blob) => {
                        if (blob) resolve(blob);
                        else reject(new Error('圖片壓縮失敗'));
                    },
                    mimeType,
                    quality
                );
            };
            img.onerror = () => reject(new Error('圖片加載失敗'));
        };
        reader.onerror = () => reject(new Error('文件讀取失敗'));
    });
};
