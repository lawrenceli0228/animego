/* eslint-disable camelcase */
import { finalizer } from 'abslink';
import { expose } from 'abslink/w3c';
import { queryRemoteFonts } from 'lfa-ponyfill';
import WASM from '../wasm/jassub-worker.js';
import { Canvas2DRenderer } from "./renderers/2d-renderer.js";
import { WebGL1Renderer } from "./renderers/webgl1-renderer.js";
import { WebGL2Renderer } from "./renderers/webgl2-renderer.js";
import { _applyKeys, _fetch, fetchtext, LIBASS_YCBCR_MAP, THREAD_COUNT, WEIGHT_MAP } from "./util.js";
const constructor = Symbol.for('constructor');
export class ASSRenderer {
    _wasm;
    _subtitleColorSpace;
    _videoColorSpace;
    _malloc;
    _gpurender;
    debug = false;
    constructor(...args) {
        return this[constructor](...args);
    }
    async [constructor](data, getFont, ctrl) {
        // remove case sensitivity
        this._availableFonts = Object.fromEntries(Object.entries(data.availableFonts).map(([k, v]) => [k.trim().toLowerCase(), v]));
        this.debug = data.debug;
        this.queryFonts = data.queryFonts;
        this._getFont = getFont;
        this._defaultFont = data.defaultFont.trim().toLowerCase();
        // hack, we want custom WASM URLs
        const _fetch = globalThis.fetch;
        globalThis.fetch = _ => _fetch(data.wasmUrl);
        // const devicePromise = navigator.gpu?.requestAdapter({
        //   powerPreference: 'high-performance'
        // }).then(adapter => adapter?.requestDevice())
        try {
            const testCanvas = new OffscreenCanvas(1, 1);
            if (testCanvas.getContext('webgl2')) {
                this._gpurender = new WebGL2Renderer();
            }
            else {
                this._gpurender = testCanvas.getContext('webgl')?.getExtension('ANGLE_instanced_arrays') ? new WebGL1Renderer() : new Canvas2DRenderer();
            }
        }
        catch {
            this._gpurender = new Canvas2DRenderer();
        }
        this._gpurender.setCanvas(ctrl);
        this._loadedInitialFonts = !data.fonts.length;
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const { _malloc, JASSUB } = await WASM({ __url: data.wasmUrl, __out: (log) => this._log(log) });
        this._malloc = _malloc;
        this._wasm = new JASSUB(data.width, data.height, this._defaultFont);
        // Firefox seems to have issues with multithreading in workers
        // a worker inside a worker does not recieve messages properly
        this._wasm.setThreads(THREAD_COUNT);
        if (!this._loadedInitialFonts)
            await this._loadInitialFonts(data.fonts);
        this._wasm.createTrackMem(data.subContent ?? await fetchtext(data.subUrl));
        this._subtitleColorSpace = LIBASS_YCBCR_MAP[this._wasm.trackColorSpace];
        if (data.libassMemoryLimit > 0 || data.libassGlyphLimit > 0) {
            this._wasm.setMemoryLimits(data.libassGlyphLimit || 0, data.libassMemoryLimit || 0);
        }
        this._checkColorSpace();
        return this;
    }
    // this passes a string of track data to libass, be it styles, events etc, which it then processes and adds to the track
    // useful for streaming subtitles
    processData(events) {
        this._wasm.processData(events);
    }
    createEvent(event) {
        _applyKeys(event, this._wasm.getEvent(this._wasm.allocEvent()));
    }
    getEvents() {
        const events = [];
        for (let i = 0; i < this._wasm.getEventCount(); i++) {
            const { Start, Duration, ReadOrder, Layer, Style, MarginL, MarginR, MarginV, Name, Text, Effect } = this._wasm.getEvent(i);
            events.push({ Start, Duration, ReadOrder, Layer, Style, MarginL, MarginR, MarginV, Name, Text, Effect });
        }
        return events;
    }
    setEvent(event, index) {
        _applyKeys(event, this._wasm.getEvent(index));
    }
    removeEvent(index) {
        this._wasm.removeEvent(index);
    }
    createStyle(style) {
        const alloc = this._wasm.getStyle(this._wasm.allocStyle());
        _applyKeys(style, alloc);
        return alloc;
    }
    getStyles() {
        const styles = [];
        for (let i = 0; i < this._wasm.getStyleCount(); i++) {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            const { Name, FontName, FontSize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding, treat_fontname_as_pattern, Blur, Justify } = this._wasm.getStyle(i);
            styles.push({ Name, FontName, FontSize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding, treat_fontname_as_pattern, Blur, Justify });
        }
        return styles;
    }
    setStyle(style, index) {
        _applyKeys(style, this._wasm.getStyle(index));
    }
    removeStyle(index) {
        this._wasm.removeStyle(index);
    }
    styleOverride(style) {
        this._wasm.styleOverride(this.createStyle(style));
    }
    disableStyleOverride() {
        this._wasm.disableStyleOverride();
    }
    setTrack(content) {
        this._wasm.createTrackMem(content);
        this._subtitleColorSpace = LIBASS_YCBCR_MAP[this._wasm.trackColorSpace];
    }
    freeTrack() {
        this._wasm.removeTrack();
    }
    async setTrackByUrl(url) {
        this.setTrack(await fetchtext(url));
    }
    _checkColorSpace() {
        if (!this._subtitleColorSpace || !this._videoColorSpace)
            return;
        this._gpurender.setColorMatrix(this._subtitleColorSpace, this._videoColorSpace);
    }
    _defaultFont;
    setDefaultFont(fontName) {
        this._defaultFont = fontName.trim().toLowerCase();
        this._wasm.setDefaultFont(this._defaultFont);
    }
    async _log(log) {
        console.debug(log);
        const match = log.match(/JASSUB: fontselect:[^(]+: \(([^,]+), (\d{1,4}), \d\)/);
        if (match && !await this._findAvailableFont(match[1].trim().toLowerCase(), WEIGHT_MAP[Math.ceil(parseInt(match[2]) / 100) - 1])) {
            await this._findAvailableFont(this._defaultFont);
        }
    }
    async addFonts(fontOrURLs) {
        if (!fontOrURLs.length)
            return false;
        const strings = [];
        const uint8s = [];
        for (const fontOrURL of fontOrURLs) {
            if (typeof fontOrURL === 'string') {
                strings.push(fontOrURL);
            }
            else {
                uint8s.push(fontOrURL);
            }
        }
        if (uint8s.length)
            this._allocFonts(uint8s);
        // this isn't batched like uint8s because software like jellyfin exists, which loads 50+ fonts over the network which takes time...
        // is connection exhaustion a concern here?
        return !!await Promise.allSettled(strings.map(url => this._asyncWrite(url)));
    }
    // we don't want to run _findAvailableFont before initial fonts are loaded
    // because it could duplicate fonts
    _loadedInitialFonts = false;
    async _loadInitialFonts(fontOrURLs) {
        await this.addFonts(fontOrURLs);
        this._loadedInitialFonts = true;
        this._wasm.reloadFonts();
    }
    _getFont;
    _availableFonts = {};
    _checkedFonts = new Set();
    async _findAvailableFont(fontName, weight) {
        if (!this._loadedInitialFonts)
            return;
        // Roboto Medium, null -> Roboto, Medium
        // Roboto Medium, Medium -> Roboto, Medium
        // Roboto, null -> Roboto, Regular
        // italic is not handled I guess
        for (const _weight of WEIGHT_MAP) {
            // check if fontname has this weight name in it, if yes remove it
            if (fontName.includes(_weight)) {
                fontName = fontName.replace(_weight, '').trim();
                weight ??= _weight;
                break;
            }
        }
        weight ??= 'regular';
        const key = fontName + ' ' + weight;
        if (this._checkedFonts.has(key))
            return;
        this._checkedFonts.add(key);
        try {
            const font = this._availableFonts[key] ?? this._availableFonts[fontName] ?? await this._queryLocalFont(fontName, weight) ?? await this._queryRemoteFont([key, fontName]);
            if (font)
                return await this.addFonts([font]);
        }
        catch (e) {
            console.warn('Error querying font', fontName, weight, e);
        }
    }
    queryFonts;
    async _queryLocalFont(fontName, weight) {
        if (!this.queryFonts)
            return;
        return await this._getFont(fontName, weight);
    }
    async _queryRemoteFont(postscriptNames) {
        if (this.queryFonts !== 'localandremote')
            return;
        const fontData = await queryRemoteFonts({ postscriptNames });
        if (!fontData.length)
            return;
        const blob = await fontData[0].blob();
        return new Uint8Array(await blob.arrayBuffer());
    }
    async _asyncWrite(font) {
        const res = await _fetch(font);
        this._allocFonts([new Uint8Array(await res.arrayBuffer())]);
    }
    _fontId = 0;
    _allocFonts(uint8s) {
        // TODO: this should re-draw last frame!
        for (const uint8 of uint8s) {
            const ptr = this._malloc(uint8.byteLength);
            self.HEAPU8RAW.set(uint8, ptr);
            this._wasm.addFont('font-' + (this._fontId++), ptr, uint8.byteLength);
        }
        this._wasm.reloadFonts();
    }
    _resizeCanvas(width, height, videoWidth, videoHeight) {
        this._wasm.resizeCanvas(width, height, videoWidth, videoHeight);
        this._gpurender.resizeCanvas(width, height);
    }
    async [finalizer]() {
        this._wasm.quitLibrary();
        this._gpurender.destroy();
        // @ts-expect-error force GC
        this._wasm = null;
        // @ts-expect-error force GC
        this._gpurender = null;
        this._availableFonts = {};
    }
    _draw(time, repaint = false) {
        const result = this._wasm.rawRender(time, Number(repaint));
        if (this._wasm.changed === 0 && !repaint)
            return;
        const bitmaps = [];
        for (let image = result, i = 0; i < this._wasm.count; image = image.next, ++i) {
            // @ts-expect-error internal emsc types
            bitmaps.push({
                bitmap: image.bitmap,
                color: image.color,
                dst_x: image.dst_x,
                dst_y: image.dst_y,
                h: image.h,
                stride: image.stride,
                w: image.w
            });
        }
        this._gpurender.render(bitmaps, self.HEAPU8RAW);
    }
    _setColorSpace(videoColorSpace) {
        if (videoColorSpace === 'RGB')
            return;
        this._videoColorSpace = videoColorSpace;
        this._checkColorSpace();
    }
}
if (self.name === 'jassub-worker') {
    expose(ASSRenderer);
}
//# sourceMappingURL=worker.js.map