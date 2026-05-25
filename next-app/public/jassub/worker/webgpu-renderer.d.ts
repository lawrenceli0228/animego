import type { ASSImage } from '../jassub';
export declare const colorMatrixConversionMap: {
    readonly BT601: {
        readonly BT709: Float32Array<ArrayBuffer>;
        readonly BT601: Float32Array<ArrayBuffer>;
    };
    readonly BT709: {
        readonly BT601: Float32Array<ArrayBuffer>;
        readonly BT709: Float32Array<ArrayBuffer>;
    };
    readonly FCC: {
        readonly BT709: Float32Array<ArrayBuffer>;
        readonly BT601: Float32Array<ArrayBuffer>;
    };
    readonly SMPTE240M: {
        readonly BT709: Float32Array<ArrayBuffer>;
        readonly BT601: Float32Array<ArrayBuffer>;
    };
};
export type ColorSpace = keyof typeof colorMatrixConversionMap;
interface TextureInfo {
    texture: GPUTexture;
    view: GPUTextureView;
    width: number;
    height: number;
}
export declare class WebGPURenderer {
    device: GPUDevice | null;
    context: GPUCanvasContext | null;
    pipeline: GPURenderPipeline | null;
    bindGroupLayout: GPUBindGroupLayout | null;
    uniformBuffer: GPUBuffer | null;
    colorMatrixBuffer: GPUBuffer | null;
    imageDataBuffers: GPUBuffer[];
    textures: TextureInfo[];
    pendingDestroyTextures: GPUTexture[];
    format: GPUTextureFormat;
    constructor(device: GPUDevice);
    setCanvas(canvas: OffscreenCanvas, width: number, height: number): void;
    /**
     * Set the color matrix for color space conversion.
     * Pass null or undefined to use identity (no conversion).
     * Matrix should be a pre-padded Float32Array with 12 values (3 columns × 4 floats each).
     */
    setColorMatrix(subtitleColorSpace?: 'BT601' | 'BT709' | 'SMPTE240M' | 'FCC', videoColorSpace?: 'BT601' | 'BT709'): void;
    createTextureInfo(width: number, height: number): TextureInfo;
    render(images: ASSImage[], heap: Uint8Array): void;
    destroy(): void;
}
export {};
