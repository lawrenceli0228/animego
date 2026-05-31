import { type ASSImage } from './util.ts';
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
export declare class WebGL2Renderer {
    canvas: OffscreenCanvas | null;
    gl: WebGL2RenderingContext | null;
    program: WebGLProgram | null;
    vao: WebGLVertexArrayObject | null;
    u_resolution: WebGLUniformLocation | null;
    u_texArray: WebGLUniformLocation | null;
    u_colorMatrix: WebGLUniformLocation | null;
    instanceDestRectBuffer: WebGLBuffer | null;
    instanceColorBuffer: WebGLBuffer | null;
    instanceTexLayerBuffer: WebGLBuffer | null;
    instanceDestRectData: Float32Array;
    instanceColorData: Float32Array;
    instanceTexLayerData: Float32Array;
    texArray: WebGLTexture | null;
    texArrayWidth: number;
    texArrayHeight: number;
    colorMatrix: Float32Array;
    constructor();
    _scheduledResize?: {
        width: number;
        height: number;
    };
    resizeCanvas(width: number, height: number): void;
    setCanvas(canvas: OffscreenCanvas): void;
    createShader(type: number, source: string): WebGLShader | null;
    setColorMatrix(subtitleColorSpace?: 'BT601' | 'BT709' | 'SMPTE240M' | 'FCC', videoColorSpace?: 'BT601' | 'BT709'): void;
    createTexArray(width: number, height: number): void;
    render(images: ASSImage[], heap: Uint8Array): void;
    destroy(): void;
}
