import { type ASSImage } from '../util.ts';
export declare class WebGL1Renderer {
    canvas: OffscreenCanvas | null;
    gl: WebGLRenderingContext | null;
    program: WebGLProgram | null;
    instancedArraysExt: ANGLE_instanced_arrays | null;
    u_resolution: WebGLUniformLocation | null;
    u_tex: WebGLUniformLocation | null;
    u_colorMatrix: WebGLUniformLocation | null;
    u_texDimensions: WebGLUniformLocation | null;
    a_quadPos: number;
    a_destRect: number;
    a_color: number;
    a_texLayer: number;
    quadPosBuffer: WebGLBuffer | null;
    instanceDestRectBuffer: WebGLBuffer | null;
    instanceColorBuffer: WebGLBuffer | null;
    instanceTexLayerBuffer: WebGLBuffer | null;
    instanceDestRectData: Float32Array;
    instanceColorData: Float32Array;
    instanceTexLayerData: Float32Array;
    textureCache: Map<number, WebGLTexture>;
    textureWidth: number;
    textureHeight: number;
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
    createTexture(width: number, height: number): WebGLTexture;
    render(images: ASSImage[], heap: Uint8Array): void;
    destroy(): void;
}
