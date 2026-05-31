import type { ASSImage } from '../util.ts';
export declare class Canvas2DRenderer {
    canvas: OffscreenCanvas | null;
    ctx: OffscreenCanvasRenderingContext2D | null;
    bufferCanvas: OffscreenCanvas;
    bufferCtx: OffscreenCanvasRenderingContext2D | null;
    _scheduledResize?: {
        width: number;
        height: number;
    };
    resizeCanvas(width: number, height: number): void;
    setCanvas(canvas: OffscreenCanvas): void;
    setColorMatrix(subtitleColorSpace?: 'BT601' | 'BT709' | 'SMPTE240M' | 'FCC', videoColorSpace?: 'BT601' | 'BT709'): void;
    render(images: ASSImage[], heap: Uint8Array): void;
    destroy(): void;
}
