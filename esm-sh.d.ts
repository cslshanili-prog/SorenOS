// esm.sh 上的運行時 CDN 依賴：Vite 會原樣保留這類 URL 動態 import，
// 但 tsc 解析不到，所以在這裡按實際用法補一份環境聲明（別把它們改成 npm 依賴）。

declare module 'https://esm.sh/html2canvas@1.4.1' {
    /** 只聲明調用點用到的選項，需要別的再往上加 */
    export interface Html2CanvasOptions {
        backgroundColor: string | null;
        scale: number;
        useCORS: boolean;
        logging: boolean;
    }

    export default function html2canvas(
        element: HTMLElement,
        options?: Partial<Html2CanvasOptions>
    ): Promise<HTMLCanvasElement>;
}
