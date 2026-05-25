import type { ASS_Event, ASS_Image, ASS_Style, ClassHandle } from '../wasm/types.d.ts';
export type ASSEvent = Omit<ASS_Event, keyof ClassHandle>;
export type ASSStyle = Omit<ASS_Style, keyof ClassHandle>;
export type ASSImage = Omit<ASS_Image, keyof ClassHandle>;
export declare const WEIGHT_MAP: readonly ["thin", "extralight", "light", "regular", "medium", "semibold", "bold", "extrabold", "black", "ultrablack"];
export type WeightValue = typeof WEIGHT_MAP[number];
export declare const IS_FIREFOX: boolean;
export declare const IS_SAFARI: boolean;
export declare const LIBASS_YCBCR_MAP: readonly [null, "BT601", null, "BT601", "BT601", "BT709", "BT709", "SMPTE240M", "SMPTE240M", "FCC", "FCC"];
export declare function _applyKeys<T extends (ASSEvent | ASSStyle)>(input: T, output: T): void;
export declare const _fetch: typeof fetch;
export declare function fetchtext(url: string): Promise<string>;
export declare const THREAD_COUNT: number;
export declare const SUPPORTS_GROWTH: boolean;
export declare const SHOULD_REFERENCE_MEMORY: boolean;
export declare const IDENTITY_MATRIX: Float32Array<ArrayBuffer>;
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
