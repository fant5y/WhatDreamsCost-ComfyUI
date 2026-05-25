// noinspection CssNonIntegerLengthInPixels
// const {app} = window.comfyAPI.app;
// const {api} = window.comfyAPI.api;

import { app }                          from "../../scripts/app.js";
import { api }                          from "../../scripts/api.js";
import { STYLES }                       from "./css_styles.js";
import {
    AUDIO_TRACK_HEIGHT,
    AudioMode,
    BLOCK_HEIGHT,
    CAMERA_MOVEMENTS,
    CANVAS_HEIGHT,
    HANDLE_HIT_PX,
    HIDDEN_WIDGET_NAMES,
    MIN_SEGMENT_LENGTH,
    PluginName,
    RULER_HEIGHT,
    SHOT_ANGLES
}                                       from "./constants.js";
import { ICONS }                        from "./icons.js";
import { hideWidget }                   from "./helpers.js";
import { _getVlmConfig, _setVlmConfig } from "./vlm_prompt.js";

if (!document.getElementById("prompt-relay-styles")) {
    const styleEl = document.createElement("style");
    styleEl.id = "prompt-relay-styles";
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

// --- Data Models ---
function parseInitial(jsonStr) {
    let parsed = {segments: [], audioSegments: []};
    try {
        if (jsonStr) {
            const p = JSON.parse(jsonStr);
            if (Array.isArray(p.segments)) parsed.segments = p.segments;
            if (Array.isArray(p.audioSegments)) parsed.audioSegments = p.audioSegments;
        }
    } catch (e) {
        console.warn(PluginName, "Failed to parse timeline data", e)
    }

    let currentStart = 0;
    for (let seg of parsed.segments) {
        if (seg.start === undefined) {
            seg.start = currentStart;
            currentStart += seg.length;
        }
        // Guarantee ID assignment to prevent node loading drag breaks
        if (!seg.id) {
            seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        }
    }

    for (let seg of parsed.audioSegments) {
        if (!seg.id) {
            seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        }
        if (seg.trimStart === undefined) seg.trimStart = 0;
    }

    return parsed;
}

class TimelineEditor {
    constructor(node, container, domWidget) {
        this.node = node;
        this.container = container;
        this.domWidget = domWidget;

        // Track heights (dynamic)
        this.rulerHeight = RULER_HEIGHT;
        this.blockHeight = BLOCK_HEIGHT;
        this.audioTrackHeight = AUDIO_TRACK_HEIGHT;
        this.canvasHeight = CANVAS_HEIGHT;

        // Core data
        this.timeline = {segments: [], audioSegments: []};
        this.selectionType = "image"; // "image" or "audio"
        this.selectedIndex = -1;

        // Interactions
        this._isDragging = false;
        this._dragType = null;
        this._dragStartX = 0;
        this._dragInitialTimeline = null;
        this.zoomLevel = 1.0;
        this._lastZoom = 1.0;
        this._lastScale = 1.0;
        this._dragTargetId = null;
        this._dragTargetIdRight = null;
        this._previewSegments = null;
        this._lastWidth = 0;
        this._hoveredGapIdx = -1;
        this._isHovering = false;

        // Playback state
        this.currentFrame = 0;
        this.isPlaying = false;
        this.isLooping = false;
        this.audioContext = null;
        this.activeAudioNodes = [];
        this.playbackStartTime = 0;
        this.playbackStartFrame = 0;
        this._playLoopId = null;

        // --- Ghost dragging state ---
        this._ghostSegmentId = null;
        this._ghostTrack = null;
        this._ghostInitialTimeline = null;

        // Attach to Python widgets
        this._gapMenu = null;         // Active gap popup menu element
        this._gapMenuDismisser = null;

        // Attach to Python widgets
        this.durationFramesWidget = this.node.widgets.find(w => w.name === "duration_frames");
        this.durationSecondsWidget = this.node.widgets.find(w => w.name === "duration_seconds");
        this.frameRateWidget = this.node.widgets.find(w => w.name === "frame_rate");
        this.timelineDataWidget = this.node.widgets.find(w => w.name === "timeline_data");
        this.localPromptsWidget = this.node.widgets.find(w => w.name === "local_prompts");
        this.segmentLengthsWidget = this.node.widgets.find(w => w.name === "segment_lengths");
        this.guideStrengthWidget = this.node.widgets.find(w => w.name === "guide_strength");
        this.displayModeWidget = this.node.widgets.find(w => w.name === "display_mode");

        this.renderStartSecondsWidget = this.node.widgets.find(w => w.name === "render_start_seconds");
        this.renderDurationSecondsWidget = this.node.widgets.find(w => w.name === "render_duration_seconds");

        this.timeline = parseInitial(this.timelineDataWidget?.value);
        this.loadMedia();

        this.createDOM();
        if (this.timeline.segments.length > 0) {
            this.selectedIndex = 0;
        }
        this.updateUIFromSelection();
        this.commitChanges(true);
        // Hide settings widgets by default to reduce node clutter.
        // Deferred so all widget types are finalized before we touch them.
        setTimeout(() => this.hideSettingsWidgets(), 0);

        let isSyncing = false;

        const origDurationFramesCallback = this.durationFramesWidget?.callback;
        if (this.durationFramesWidget) {
            this.durationFramesWidget.callback = (...args) => {
                if (origDurationFramesCallback) origDurationFramesCallback.apply(this.durationFramesWidget, args);

                if (!isSyncing && this.durationSecondsWidget) {
                    isSyncing = true;
                    this.durationSecondsWidget.value = parseFloat((this.getDurationFrames() / this.getFrameRate()).toFixed(3));
                    isSyncing = false;
                }

                this.commitChanges();
            };
        }

        const origDurationSecondsCallback = this.durationSecondsWidget?.callback;
        if (this.durationSecondsWidget) {
            this.durationSecondsWidget.callback = (...args) => {
                if (origDurationSecondsCallback) origDurationSecondsCallback.apply(this.durationSecondsWidget, args);

                if (!isSyncing && this.durationFramesWidget) {
                    isSyncing = true;
                    const newFrames = Math.max(1, Math.round(this.durationSecondsWidget.value * this.getFrameRate()));
                    this.durationFramesWidget.value = newFrames;
                    if (this.durationFramesWidget.callback) this.durationFramesWidget.callback(newFrames);
                    isSyncing = false;
                }
            };
        }

        if (this.renderStartSecondsWidget) {
            const origStartCallback = this.renderStartSecondsWidget.callback;
            this.renderStartSecondsWidget.callback = (...args) => {
                if (origStartCallback) origStartCallback.apply(this.renderStartSecondsWidget, args);
                this.render();
            };
        }

        if (this.renderDurationSecondsWidget) {
            const origDurationCallback = this.renderDurationSecondsWidget.callback;
            this.renderDurationSecondsWidget.callback = (...args) => {
                if (origDurationCallback) origDurationCallback.apply(this.renderDurationSecondsWidget, args);
                this.render();
            };
        }

        const origFrameRateCallback = this.frameRateWidget?.callback;
        if (this.frameRateWidget) {
            this.frameRateWidget.callback = (...args) => {
                if (origFrameRateCallback) origFrameRateCallback.apply(this.frameRateWidget, args);
                if (!isSyncing && this.durationSecondsWidget) {
                    isSyncing = true;
                    this.durationSecondsWidget.value = parseFloat((this.getDurationFrames() / this.getFrameRate()).toFixed(3));
                    isSyncing = false;
                }
            };
        }

        const origDisplayModeCallback = this.displayModeWidget?.callback;
        if (this.displayModeWidget) {
            this.displayModeWidget.callback = (...args) => {
                if (origDisplayModeCallback) origDisplayModeCallback.apply(this.displayModeWidget, args);
                this.updateWidgetVisibility();
                this.updateUIFromSelection();
                this.render();
            };
            this.updateWidgetVisibility(); // Initial trigger
        }

        // Polling is much more reliable in Comfy than ResizeObserver due to scale transforms
        this._renderLoop = requestAnimationFrame(() => this.checkResize());
    }

    // Widgets that are managed by the settings menu (hidden from node by default).
    get _settingsWidgetNames() {
        return ["display_mode", "epsilon", "divisible_by", "img_compression"];
    }

    destroy() {
        cancelAnimationFrame(this._renderLoop);
        this.pauseAudio();
        window.removeEventListener("mousemove", this._boundOnMouseMove);
        window.removeEventListener("mouseup", this._boundOnMouseUp);
        window.removeEventListener("keydown", this.handleKeyDown, true);
        window.removeEventListener("paste", this.handlePaste, true);
        if (this._shiftKeyDownHandler) window.removeEventListener("keydown", this._shiftKeyDownHandler);
        if (this._shiftKeyUpHandler) window.removeEventListener("keyup", this._shiftKeyUpHandler);
    }

    getDisplayMode() {
        if (!this.displayModeWidget) {
            this.displayModeWidget = this.node.widgets?.find(w => w.name === "display_mode");
        }
        const val = this.displayModeWidget ? this.displayModeWidget.value : null;
        return (val === "seconds" || val === "frames") ? val : "seconds";
    }

    getDurationFrames() {
        return parseInt((this.durationFramesWidget && this.durationFramesWidget.value > 0) ? this.durationFramesWidget.value : 24, 10);
    }

    // Grow the timeline duration to fit `requiredFrames` if it is currently shorter.
    getFrameRate() {
        return parseInt((this.frameRateWidget && this.frameRateWidget.value > 0) ? this.frameRateWidget.value : 24, 10);
    }


    // The timeline only ever grows — never shrinks — through this method.
    growTimelineIfNeeded(requiredFrames) {
        const current = this.getDurationFrames();
        if (requiredFrames <= current) return; // already big enough

        const newFrames = Math.ceil(requiredFrames);
        if (this.durationFramesWidget) {
            this.durationFramesWidget.value = newFrames;
        }
        if (this.durationSecondsWidget) {
            this.durationSecondsWidget.value = parseFloat((newFrames / this.getFrameRate()).toFixed(3));
        }
        // Notify ComfyUI that the widget value changed so it serialises correctly.
        if (window.app && window.app.graph) {
            window.app.graph.setDirtyCanvas(true, true);
        }
    }

    // Returns the visual timeline length in frames:
    // the furthest segment end (across both tracks) × 1.30, with a floor of getDurationFrames().

    // Returns the maximum allowed zoom level, computed so that at max zoom
    // the viewport shows exactly 4 seconds of the visual timeline.
    getMaxZoom() {
        const visualDurationSecs = this.getVisualDurationFrames() / this.getFrameRate();
        const baseMaxZoom = Math.max(1, visualDurationSecs / 4);

        // Limit max zoom to prevent canvas width from exceeding browser limits (causing crash)
        const viewportWidth = this.viewport ? this.viewport.clientWidth : 1000;
        const MAX_CANVAS_WIDTH = 32768; // Extended limit for modern browsers
        const limitMaxZoom = MAX_CANVAS_WIDTH / Math.max(1, viewportWidth);

        return Math.max(1, Math.min(baseMaxZoom, limitMaxZoom));
    }

    // Sync the zoom slider's max attribute to the current getMaxZoom() value,

    // This is used for all rendering/positioning — the actual output duration is getDurationFrames().
    getVisualDurationFrames() {
        let furthest = 0;
        for (const seg of this.timeline.segments) {
            furthest = Math.max(furthest, seg.start + seg.length);
        }
        for (const seg of this.timeline.audioSegments) {
            furthest = Math.max(furthest, seg.start + seg.length);
        }
        const outputDuration = this.getDurationFrames();
        if (furthest <= 0) return outputDuration;
        return Math.max(outputDuration, Math.ceil(furthest * 1.30));
    }

    // clamping zoomLevel if it now exceeds the new max.
    updateZoomSliderMax() {
        if (!this.zoomSlider) return;
        const maxZoom = this.getMaxZoom();
        this.zoomSlider.max = maxZoom.toFixed(2);
        if (this.zoomLevel > maxZoom) {
            this.zoomLevel = maxZoom;
            this.zoomSlider.value = maxZoom;
            // Resize the canvas to match the clamped zoom
            const viewportWidth = this.viewport ? this.viewport.clientWidth : 0;
            if (viewportWidth > 0) {
                const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);
                this.canvas.style.width = newCanvasWidth + "px";
                this.resizeCanvas(newCanvasWidth);
            }
        }
    }

    _liveScrubVideo(seg, edge) {
        if (seg.type !== "video" || !seg.videoEl) return;
        const targetSec = edge === "end"
            ? (seg.trimStart + seg.length) / this.getFrameRate()
            : seg.trimStart / this.getFrameRate();

        this._floatingPreviewSeg = seg;
        this._floatingPreviewEdge = edge;

        if (!seg._isSeeking && Math.abs(seg.videoEl.currentTime - targetSec) > 0.05) {
            seg._isSeeking = true;
            seg.videoEl.currentTime = targetSec;
            seg.videoEl.onseeked = () => {
                seg._isSeeking = false;
                this.render();
            };
        }
    }

    _liveScrubPlayhead() {
        const targetFrame = this.currentFrame;
        const seg = this.timeline.segments.find(s => s.type === "video" && targetFrame >= s.start && targetFrame < s.start + s.length);
        if (seg && seg.videoEl) {
            this._floatingPreviewSeg = seg;
            this._floatingPreviewEdge = "playhead";
            const targetSec = (seg.trimStart + (targetFrame - seg.start)) / this.getFrameRate();
            if (!seg._isSeeking && Math.abs(seg.videoEl.currentTime - targetSec) > 0.05) {
                seg._isSeeking = true;
                seg.videoEl.currentTime = targetSec;
                seg.videoEl.onseeked = () => {
                    seg._isSeeking = false;
                    this.render();
                };
            }
        } else {
            this._floatingPreviewSeg = null;
        }
    }

    async _ensureThumbnails(seg) {
        if (seg.thumbnails || seg._extractingThumbs) return;
        seg._extractingThumbs = true;
        seg.thumbnails = [];

        const vidUrl = seg.videoEl ? seg.videoEl.src : null;
        if (!vidUrl) return;

        const bgVid = document.createElement('video');
        bgVid.crossOrigin = "Anonymous";
        bgVid.muted = true;
        bgVid.src = vidUrl;

        await new Promise(r => {
            bgVid.onloadeddata = r;
            bgVid.onerror = r;
        });
        if (!bgVid.duration) {
            seg._extractingThumbs = false;
            return;
        }

        const duration = bgVid.duration;
        const numFrames = Math.max(5, Math.min(60, Math.ceil(duration * 2)));
        const canvas = document.createElement('canvas');
        let w = bgVid.videoWidth, h = bgVid.videoHeight;
        if (w === 0 || h === 0) return;

        if (h > this.blockHeight) {
            w = Math.round(w * (this.blockHeight / h));
            h = this.blockHeight;
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');

        for (let i = 0; i < numFrames; i++) {
            if (!this.timeline.segments.find(s => s.id === seg.id)) break;
            const time = (i / numFrames) * duration;
            bgVid.currentTime = time;

            await new Promise(r => {
                let resolved = false;
                const onSeek = () => {
                    if (!resolved) {
                        resolved = true;
                        r();
                    }
                };
                bgVid.onseeked = onSeek;
                setTimeout(onSeek, 1000);
            });

            ctx.drawImage(bgVid, 0, 0, w, h);
            const img = new Image();
            img.src = canvas.toDataURL('image/jpeg', 0.5);
            await new Promise(r => {
                img.onload = r;
            });
            seg.thumbnails.push({time, img});
            this.render();
        }
        seg._extractingThumbs = false;
    }

    loadMedia() {
        for (const seg of this.timeline.segments) {
            if (seg.type === "video" && seg.imageFile && !seg.videoEl) {
                const filename = seg.imageFile.split('/').pop();
                const subfolder = seg.imageFile.includes('/') ? seg.imageFile.split('/').slice(0, -1).join('/') : '';
                const vidUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

                const vid = document.createElement('video');
                vid.crossOrigin = "Anonymous";
                vid.muted = true;
                vid.src = vidUrl;
                seg.videoEl = vid;

                vid.onloadeddata = () => {
                    vid.currentTime = (seg.trimStart || 0) / this.getFrameRate() + 0.01;
                    this._ensureThumbnails(seg);
                };
                vid.onseeked = () => {
                    if (!seg.imageB64 || !seg.imgObj) {
                        const canvas = document.createElement('canvas');
                        canvas.width = Math.min(vid.videoWidth, 512);
                        canvas.height = Math.round((vid.videoHeight / vid.videoWidth) * canvas.width);
                        canvas.getContext('2d').drawImage(vid, 0, 0, canvas.width, canvas.height);
                        seg.imageB64 = canvas.toDataURL('image/jpeg');
                        const img = new Image();
                        img.onload = () => {
                            seg.imgObj = img;
                            this.render();
                        };
                        img.src = seg.imageB64;
                    }
                };
            }

            if (seg.imageB64 && !seg.imgObj) {
                seg.imgObj = new Image();
                seg.imgObj.onload = () => this.render();
                seg.imgObj.src = seg.imageB64;
            }
        }
    }

// --- Helper for concise element creation ---
    _el(tag, props = {}, children = []) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (k === "style" && typeof v === "object") Object.assign(el.style, v);
            else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.substring(2).toLowerCase(), v);
            else el[k] = v;
        }
        children.forEach(c => el.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
        return el;
    }

    _createBtn(label, icon, className, onClick, tooltip = "") {
        return this._el("button", {
            className: `pr-btn ${className}`.trim(),
            innerHTML: icon ? `${icon} ${label}`.trim() : label,
            title: tooltip,
            onClick
        });
    }

    _buildActionGroup() {
        const actionGroup = document.createElement("div");
        actionGroup.className = "pr-actions";

        actionGroup.appendChild(this._createBtn("Add Image", ICONS.upload, "", () => this.fileInput.click()));
        actionGroup.appendChild(this._createBtn("Add Audio", ICONS.audio, "", () => this.audioFileInput.click()));
        actionGroup.appendChild(this._createBtn("Add Video", ICONS.video, "", () => this.videoFileInput.click()));
        actionGroup.appendChild(this._createBtn("Add Text", ICONS.text, "", () => this.addTextSegmentFreeSpace()));
        actionGroup.appendChild(this._createBtn("Delete", ICONS.trash, "pr-btn-danger", () => this.deleteSelectedSegment()));

        // Complex Prompts Button
        this._generatePromptsBtn = this._createBtn(
            "Prompts", "✨", "pr-btn-vlm",
            (e) => {
                e.stopPropagation();
                if (e.shiftKey) {
                    if (this.selectionType !== "audio" && this.selectedIndex >= 0) {
                        this.generatePrompts(this._generatePromptsBtn, this.selectedIndex);
                    } else {
                        alert("Please select an image/video/text segment first to generate a single prompt, or click normally to generate all.");
                    }
                } else {
                    this.generatePrompts(this._generatePromptsBtn, -1); // -1 means all
                }
            },
            "Generate prompts for all image/text/video segments. [Shift+Click] to generate only for the selected segment."
        );

        // Reactive Shift-Key Morphing
        this._shiftKeyDownHandler = (e) => {
            if (e.key === "Shift" && !this._generatePromptsBtn.disabled) {
                if (this.selectionType !== "audio" && this.selectedIndex >= 0) {
                    this._generatePromptsBtn.innerHTML = "✨ Prompt (Selected)";
                    this._generatePromptsBtn.style.borderColor = "#8888FF";
                }
            }
        };

        this._shiftKeyUpHandler = (e) => {
            if (e.key === "Shift" && !this._generatePromptsBtn.disabled) {
                this._generatePromptsBtn.innerHTML = "✨ Prompts";
                this._generatePromptsBtn.style.borderColor = "";
            }
        };

        window.addEventListener("keydown", this._shiftKeyDownHandler);
        window.addEventListener("keyup", this._shiftKeyUpHandler);

        // Sync disabled state from saved config
        setTimeout(() => {
            const vlmInitCfg = _getVlmConfig();
            if (!vlmInitCfg.enabled) {
                this._generatePromptsBtn.disabled = true;
                this._generatePromptsBtn.title = "Prompt Writer is disabled. Enable it in Settings (⚙️).";
            }
        }, 0);

        actionGroup.appendChild(this._generatePromptsBtn);

        return actionGroup;
    }

    createDOM() {
        console.log(PluginName, "Creating Dom");

        this.wrapper = this._el("div", {
            className: "pr-wrapper", style: {position: "relative"},
            onMouseenter: () => this._isHovering = true,
            onMouseleave: () => this._isHovering = false
        });

        this._buildOverlay();
        this._buildInputs();
        this._buildToolbar();
        this._buildViewport();
        this._buildControlsAndProps();
        this._attachGlobalEvents();

        this.container.appendChild(this.wrapper);
    }

    // --- DOM Construction Sub-Methods ---

    _buildOverlay() {
        this.loadingOverlay = this._el("div", {className: "pr-overlay"});
        this.loadingOverlay.innerHTML = `<div class="pr-spinner"></div><div>✨ Analyzing scenes with Vision Model and writing prompts...</div>`;
        this.wrapper.appendChild(this.loadingOverlay);
    }

    _buildInputs() {
        const makeInput = (type, fn) => this._el("input", {
            type: "file",
            accept: `${type}/*`,
            multiple: true,
            style: {display: "none"},
            onChange: (e) => fn(e.target.files)
        });
        this.fileInput = makeInput("image", f => this.handleImageUpload(f));
        this.audioFileInput = makeInput("audio", f => this.handleAudioUpload(f));
        this.videoFileInput = makeInput("video", f => this.handleVideoUpload(f));
    }

    _buildToolbar() {
        const actionGroup = this._buildActionGroup();
        actionGroup.append(this.fileInput, this.audioFileInput, this.videoFileInput);

        this.segmentBoundsDisplay = this._el("div", {className: "pr-segment-bounds", textContent: "Start: - | End: -"});
        this.timeCodeDisplay = this._el("div", {className: "pr-timecode", textContent: this.formatTime(0)});

        const settingsBtn = this._createBtn("", ICONS.gear, "pr-settings-btn", (e) => {
            e.stopPropagation();
            this._settingsMenu ? this.dismissSettingsMenu() : this.showSettingsMenu(settingsBtn);
        }, "Settings");

        const btnGroup = this._el("div", {className: "pr-btn-group"}, [this._createAudioModeControl(), this._createHelpButton(), settingsBtn]);
        const rightGroup = this._el("div", {className: "pr-right-group"}, [btnGroup]);

        this.wrapper.appendChild(this._el("div", {className: "pr-toolbar"}, [actionGroup, rightGroup]));
    }

    _buildViewport() {
        this.canvas = this._el("canvas", {
            className: "pr-canvas", style: {width: "100%", height: `${CANVAS_HEIGHT}px`},
            onMousedown: (e) => this.onMouseDown(e),
            onContextmenu: (e) => this.onContextMenu(e)
        });
        this.ctx = this.canvas.getContext("2d");

        this.viewport = this._el("div", {className: "pr-timeline-viewport"}, [this.canvas]);
        this.viewport.addEventListener("wheel", (e) => this._handleZoomWheel(e), {passive: false, capture: true});

        this.wrapper.appendChild(this.viewport);
    }

    _buildControlsAndProps() {
        this.wrapper.appendChild(this._el("div", {className: "pr-controls-group"}, [
            this._createStrengthRow(),
            this._createPlayerControls()
        ]));
        this.wrapper.appendChild(this._createPropContainer());
    }

    _createPlayerControls() {
        const mkBtn = (icn, fn, tip) => this._el("button", {
            className: "pr-icon-btn",
            innerHTML: icn,
            title: tip,
            onClick: fn,
            style: {padding: "4px"}
        });

        this.playBtn = mkBtn(ICONS.play, () => this.togglePlay(), "Play/Pause Audio");
        this.loopBtn = mkBtn(ICONS.loop, () => this.toggleLoop(), "Toggle Loop");
        const zoomOut = mkBtn(ICONS.minus, () => this._setZoom(parseFloat(this.zoomSlider.value) - 0.5), "Zoom Out");
        const zoomIn = mkBtn(ICONS.plus, () => this._setZoom(parseFloat(this.zoomSlider.value) + 0.5), "Zoom In");
        const zoomFit = mkBtn(ICONS.fit, () => this._setZoom(1, true), "Zoom to Fit");

        this.seekBar = this._el("input", {
            type: "range", className: "pr-seek-bar", min: "0", value: "0", style: {flex: "1"}, onInput: (e) => {
                this.currentFrame = parseInt(e.target.value, 10);
                this.render();
                if (this.isPlaying) this.playAudio();
            }
        });

        this.zoomSlider = this._el("input", {
            type: "range",
            className: "pr-zoom-slider",
            min: "1",
            max: "1",
            step: "0.1",
            value: "1",
            title: "Zoom Level",
            onInput: (e) => this._handleZoomSlider(e)
        });

        const zoomControls = this._el("div", {className: "pr-zoom-controls"}, [zoomOut, this.zoomSlider, zoomIn, zoomFit]);
        return this._el("div", {className: "pr-player-controls"}, [this.playBtn, this.loopBtn, this.seekBar, zoomControls]);
    }

    _createStrengthRow() {
        this.strengthValue = this._el("input", {
            type: "text",
            className: "pr-strength-input",
            value: "1.00",
            disabled: true,
            style: {cursor: "ew-resize"}
        });
        this._attachStrengthDrag();

        this.strengthRow = this._el("div", {className: "pr-strength-row"}, [
            this.timeCodeDisplay, this.segmentBoundsDisplay,
            this._el("span", {className: "pr-strength-label", textContent: "Guide Strength:"}),
            this.strengthValue
        ]);

        return this.strengthRow;
    }

    _createPropContainer() {
        const onInput = (prop) => (e) => {
            if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
                this.timeline.segments[this.selectedIndex][prop] = e.target.value;
                this.commitChanges();
            }
        };

        this.hintInput = this._el("input", {
            type: "text",
            className: "pr-hint-input",
            placeholder: "scene hint for ✨ generation...",
            onInput: onInput('hint')
        });
        this.promptInput = this._el("textarea", {
            className: "pr-prompt-area",
            placeholder: "Generated prompt — edit freely.",
            onInput: onInput('prompt')
        });
        this.audioInfoArea = this._el("div", {className: "pr-audio-info"});

        const hintRow = this._el("div", {className: "pr-hint-row"}, [
            this._el("span", {
                className: "pr-hint-label",
                textContent: "✨ Hint",
                title: "Stays intact after generation."
            }),
            this.hintInput
        ]);

        return this._el("div", {className: "pr-prop-container"}, [hintRow, this.promptInput, this.audioInfoArea]);
    }

    // --- Extracted Event Handlers & Logic ---

    _setZoom(val, fit = false) {
        this.zoomLevel = fit ? 1 : Math.max(1, Math.min(this.getMaxZoom(), val));
        this.zoomSlider.value = this.zoomLevel;
        this.zoomSlider.dispatchEvent(new Event("input"));
        if (fit) this.viewport.scrollLeft = 0;
    }

    _handleZoomWheel(e) {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        e.stopPropagation();

        this.zoomLevel = Math.max(1, Math.min(this.getMaxZoom(), this.zoomLevel + (e.deltaY > 0 ? -0.5 : 0.5)));
        if (this.zoomSlider) this.zoomSlider.value = this.zoomLevel;

        const oldWidth = this.canvas.offsetWidth;
        const newWidth = this.viewport.clientWidth * this.zoomLevel;
        const mouseX = e.clientX - this.viewport.getBoundingClientRect().left;

        this.canvas.style.width = newWidth + "px";
        this.viewport.scrollLeft = ((this.viewport.scrollLeft + mouseX) / oldWidth) * newWidth - mouseX;
    }

    _handleZoomSlider(e) {
        this.zoomLevel = parseFloat(e.target.value);
        const vw = this.viewport.clientWidth;
        const newWidth = Math.max(vw, vw * this.zoomLevel);

        this.canvas.style.width = newWidth + "px";
        this.resizeCanvas(newWidth);
        this._lastWidth = vw;
        this._lastZoom = this.zoomLevel;

        const playheadRatio = this.currentFrame / this.getVisualDurationFrames();
        this.viewport.scrollLeft = (playheadRatio * newWidth) - (vw / 2);
    }

    _attachStrengthDrag() {
        let isDragging = false, startX = 0, startVal = 0, hasMoved = false;

        const onMove = (e) => {
            if (Math.abs(e.clientX - startX) > 3) {
                hasMoved = true;
                isDragging = true;
            }
            if (isDragging) {
                e.preventDefault();
                let newVal = Math.max(0, Math.min(1, startVal + (e.clientX - startX) * 0.002));
                this.strengthValue.value = newVal.toFixed(2);

                if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]?.type !== "text") {
                    this.timeline.segments[this.selectedIndex].guideStrength = newVal;
                    this.commitChanges();
                }
            }
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            if (!hasMoved) {
                this.strengthValue.focus();
                this.strengthValue.select();
            }
            isDragging = false;
        };

        this.strengthValue.addEventListener("mousedown", (e) => {
            if (this.strengthValue.disabled) return;
            startX = e.clientX;
            startVal = parseFloat(this.strengthValue.value) || 1.0;
            hasMoved = false;
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });

        this.strengthValue.addEventListener("change", (e) => {
            let val = Math.max(0, Math.min(1, parseFloat(e.target.value) || 1));
            this.strengthValue.value = val.toFixed(2);
            if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]?.type !== "text") {
                this.timeline.segments[this.selectedIndex].guideStrength = val;
                this.commitChanges();
            }
        });
    }

    _attachGlobalEvents() {
        // Keyboard mapping
        this.handleKeyDown = (e) => {
            const tag = document.activeElement?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || !this._isHovering) return;

            if ((e.key === "Delete" || e.key === "Backspace") && this.selectedIndex !== -1) {
                this.deleteSelectedSegment();
                e.preventDefault();
                e.stopPropagation();
            } else if (e.key === " " || e.code === "Space") {
                this.togglePlay();
                e.preventDefault();
                e.stopPropagation();
            }
        };
        window.addEventListener("keydown", this.handleKeyDown, true);

        // Paste mapping
        this.handlePaste = (e) => {
            if (!this._isHovering || ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
            const images = Array.from(e.clipboardData?.files || []).filter(f => f.type.startsWith("image/"));
            if (images.length) {
                this.handleImageUpload(images, this.currentFrame);
                e.preventDefault();
                e.stopPropagation();
            }
        };
        window.addEventListener("paste", this.handlePaste, true);

        // Bounded Window Mouse Events (Fixes memory leaks)
        this._boundOnMouseMove = this.onMouseMove.bind(this);
        this._boundOnMouseUp = this.onMouseUp.bind(this);
        window.addEventListener("mousemove", this._boundOnMouseMove);
        window.addEventListener("mouseup", this._boundOnMouseUp);

        // Drag and Drop
        this.wrapper.addEventListener("dragover", (e) => this._handleDragOver(e));
        this.wrapper.addEventListener("dragleave", (e) => this._handleDragLeave(e));
        this.wrapper.addEventListener("drop", (e) => this._handleDrop(e));
    }

    _handleDragOver(e) {
        e.preventDefault();
        this.wrapper.classList.add("drag-active");

        const {x, y} = this.getMousePos(e);
        const logicalWidth = this.canvas.offsetWidth;
        const totalFrames = this.getVisualDurationFrames();
        if (!logicalWidth || totalFrames <= 0) return;

        const isAudioTrack = y > RULER_HEIGHT + this.blockHeight;
        const trackType = isAudioTrack ? "audio" : "image";
        const arrToModify = isAudioTrack ? this.timeline.audioSegments : this.timeline.segments;

        if (!this._ghostSegmentId || this._ghostTrack !== trackType) {
            this._ghostSegmentId = "GHOST_" + Date.now();
            this._ghostTrack = trackType;
            this._ghostInitialTimeline = JSON.parse(JSON.stringify(arrToModify));

            const newLength = Math.max(1, this.getFrameRate() * 1);
            let startFrame = clamp(Math.round((x * (totalFrames / logicalWidth)) - newLength / 2), 0, totalFrames - newLength);

            this._ghostInitialTimeline.push({
                id: this._ghostSegmentId,
                start: startFrame,
                length: newLength,
                type: "ghost"
            });
        }

        const mouseFrameX = x * (totalFrames / logicalWidth);
        const ghost = this._ghostInitialTimeline.find(s => s.id === this._ghostSegmentId);

        this._previewSegments = this._applyCenterDragPhysics(
            this._ghostInitialTimeline, this._ghostSegmentId, mouseFrameX - ghost.length / 2,
            mouseFrameX, totalFrames, totalFrames, logicalWidth
        );

        for (let ps of this._previewSegments) {
            const orig = arrToModify.find(s => s.id === ps.id);
            if (orig) Object.assign(ps, {videoEl: orig.videoEl, imgObj: orig.imgObj, thumbnails: orig.thumbnails});
        }
        this.render();
    }

    _handleDragLeave(e) {
        const rect = this.wrapper.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX >= rect.right || e.clientY < rect.top || e.clientY >= rect.bottom) {
            this.wrapper.classList.remove("drag-active");
            this._clearGhostState();
            this.render();
        }
    }

    _handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        this.wrapper.classList.remove("drag-active");

        let targetFrameStart = null;
        let targetTrack = this._ghostTrack || "image";

        if (this._ghostSegmentId && this._previewSegments) {
            const ghost = this._previewSegments.find(s => s.id === this._ghostSegmentId);
            if (ghost) targetFrameStart = ghost.resolvedStart !== undefined ? ghost.resolvedStart : ghost.start;
        }
        this._clearGhostState();
        this.render();

        if (e.dataTransfer.files?.length) {
            const files = Array.from(e.dataTransfer.files);
            const videos = files.filter(f => f.type.startsWith("video/"));
            const audios = files.filter(f => f.type.startsWith("audio/"));
            const images = files.filter(f => f.type.startsWith("image/"));

            if (videos.length) this.handleVideoUpload(videos, targetFrameStart);
            else if (audios.length && (targetTrack === "audio" || !images.length)) this.handleAudioUpload(audios, targetFrameStart);
            else if (images.length) this.handleImageUpload(images, targetFrameStart);
        }
    }

    _clearGhostState() {
        this._ghostSegmentId = this._ghostTrack = this._ghostInitialTimeline = this._previewSegments = null;
    }

    //
    // createDOM() {
    //     console.log(PluginName, "Creating Dom")
    //     // --- Full Panel Loading Overlay ---
    //     this.wrapper = document.createElement("div");
    //     this.wrapper.className = "pr-wrapper";
    //     this.wrapper.style.position = "relative"; // Ensure it can contain absolute elements
    //
    //     // --- Full Panel Loading Overlay ---
    //     this.loadingOverlay = document.createElement("div");
    //     this.loadingOverlay.className = "pr-overlay";
    //     this.loadingOverlay.innerHTML = `
    //                 <div class="pr-spinner"></div>
    //                 <div>✨ Analyzing scenes with Vision Model and writing prompts...</div>
    //             `;
    //
    //     this.wrapper.appendChild(this.loadingOverlay);
    //
    //     this.wrapper.addEventListener("mouseenter", () => {
    //         this._isHovering = true;
    //     });
    //     this.wrapper.addEventListener("mouseleave", () => {
    //         this._isHovering = false;
    //     });
    //
    //     this.handleKeyDown = (e) => {
    //         const activeTag = document.activeElement ? document.activeElement.tagName : "";
    //         if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;
    //
    //         if ((e.key === "Delete" || e.key === "Backspace") && this.selectedIndex !== -1 && this._isHovering) {
    //             this.deleteSelectedSegment();
    //             e.stopPropagation();
    //             e.stopImmediatePropagation();
    //             e.preventDefault();
    //         } else if ((e.key === " " || e.code === "Space") && this._isHovering) {
    //             this.togglePlay();
    //             e.stopPropagation();
    //             e.stopImmediatePropagation();
    //             e.preventDefault();
    //         }
    //     };
    //     window.addEventListener("keydown", this.handleKeyDown, true);
    //
    //     this.handlePaste = (e) => {
    //         if (this._isHovering) {
    //             const activeTag = document.activeElement ? document.activeElement.tagName : "";
    //             if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;
    //
    //             if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
    //                 const imageFiles = Array.from(e.clipboardData.files).filter(f => f.type.startsWith("image/"));
    //                 if (imageFiles.length > 0) {
    //                     this.handleImageUpload(imageFiles, this.currentFrame);
    //                     e.preventDefault();
    //                     e.stopPropagation();
    //                 }
    //             }
    //         }
    //     };
    //     window.addEventListener("paste", this.handlePaste, true);
    //
    //     this.fileInput = document.createElement("input");
    //     this.fileInput.type = "file";
    //     this.fileInput.accept = "image/*";
    //     this.fileInput.multiple = true;
    //     this.fileInput.style.display = "none";
    //     this.fileInput.addEventListener("change", (e) => this.handleImageUpload(e.target.files));
    //
    //     this.audioFileInput = document.createElement("input");
    //     this.audioFileInput.type = "file";
    //     this.audioFileInput.accept = "audio/*";
    //     this.audioFileInput.multiple = true;
    //     this.audioFileInput.style.display = "none";
    //     this.audioFileInput.addEventListener("change", (e) => this.handleAudioUpload(e.target.files));
    //
    //     this.videoFileInput = document.createElement("input");
    //     this.videoFileInput.type = "file";
    //     this.videoFileInput.accept = "video/*";
    //     this.videoFileInput.multiple = true;
    //     this.videoFileInput.style.display = "none";
    //     this.videoFileInput.addEventListener("change", (e) => this.handleVideoUpload(e.target.files));
    //
    //     // --- Toolbar ---
    //     const toolbar = document.createElement("div");
    //     toolbar.className = "pr-toolbar";
    //
    //     const actionGroup = this._buildActionGroup();
    //     actionGroup.appendChild(this.fileInput);
    //     actionGroup.appendChild(this.audioFileInput);
    //     actionGroup.appendChild(this.videoFileInput);
    //
    //     toolbar.appendChild(actionGroup);
    //
    //     const rightGroup = document.createElement("div");
    //     rightGroup.className = "pr-right-group";
    //
    //     this.segmentBoundsDisplay = document.createElement("div");
    //     this.segmentBoundsDisplay.className = "pr-segment-bounds";
    //     this.segmentBoundsDisplay.textContent = "Start: - | End: -";
    //
    //     this.timeCodeDisplay = document.createElement("div");
    //     this.timeCodeDisplay.className = "pr-timecode";
    //     this.timeCodeDisplay.textContent = this.formatTime(0);
    //
    //     const settingsBtn = document.createElement("button");
    //     settingsBtn.className = "pr-btn pr-settings-btn";
    //     settingsBtn.innerHTML = ICONS.gear;
    //     settingsBtn.title = "Settings";
    //     settingsBtn.addEventListener("click", (e) => {
    //         e.stopPropagation();
    //         if (this._settingsMenu) {
    //             this.dismissSettingsMenu();
    //         } else {
    //             this.showSettingsMenu(settingsBtn);
    //         }
    //     });
    //
    //     const btnGroup = document.createElement("div");
    //     btnGroup.className = "pr-btn-group"
    //
    //     // btnGroup.appendChild(toggleBtn);
    //     btnGroup.appendChild(this._createAudioModeControl());
    //     btnGroup.appendChild(this._createHelpButton());
    //     btnGroup.appendChild(settingsBtn);
    //
    //     rightGroup.appendChild(btnGroup);
    //
    //     toolbar.appendChild(rightGroup);
    //
    //     // --- Canvas & Viewport ---
    //     this.viewport = document.createElement("div");
    //     this.viewport.className = "pr-timeline-viewport";
    //
    //     this.viewport.addEventListener("wheel", (e) => {
    //         if (e.ctrlKey || e.metaKey) {
    //             e.preventDefault();
    //             e.stopPropagation();
    //
    //             let zoomDelta = e.deltaY > 0 ? -0.5 : 0.5;
    //             this.zoomLevel = Math.max(1, Math.min(this.getMaxZoom(), this.zoomLevel + zoomDelta));
    //             if (this.zoomSlider) this.zoomSlider.value = this.zoomLevel;
    //
    //             const oldWidth = this.canvas.offsetWidth;
    //             const newWidth = this.viewport.clientWidth * this.zoomLevel;
    //             const mouseX = e.clientX - this.viewport.getBoundingClientRect().left;
    //             const scrollRatio = (this.viewport.scrollLeft + mouseX) / oldWidth;
    //
    //             this.canvas.style.width = newWidth + "px";
    //             this.viewport.scrollLeft = scrollRatio * newWidth - mouseX;
    //         }
    //     }, {passive: false, capture: true});
    //
    //     this.canvas = document.createElement("canvas");
    //     this.canvas.className = "pr-canvas";
    //     this.ctx = this.canvas.getContext("2d");
    //     this.canvas.style.width = "100%";
    //
    //     this.viewport.appendChild(this.canvas);
    //
    //     this.canvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
    //     this.canvas.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    //     this.canvas.style.height = `${CANVAS_HEIGHT}px`;
    //
    //     // --- Content Area Container ---
    //     const propContainer = document.createElement("div");
    //     propContainer.className = "pr-prop-container";
    //
    //     // --- Hint row (persists across generations — VLM instruction per segment) ---
    //     const hintRow = document.createElement("div");
    //     hintRow.className = "pr-hint-row";
    //
    //     const hintLabel = document.createElement("span");
    //     hintLabel.className = "pr-hint-label";
    //     hintLabel.textContent = "✨ Hint";
    //     hintLabel.title = "Stays intact after generation. Guides each image differently (e.g. 'balletto', 'lotta').";
    //
    //     this.hintInput = document.createElement("input");
    //     this.hintInput.type = "text";
    //     this.hintInput.className = "pr-hint-input";
    //     this.hintInput.placeholder = "scene hint for ✨ generation (e.g. balletto, lotta, slow sunset walk)…";
    //     this.hintInput.addEventListener("input", () => {
    //         if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
    //             this.timeline.segments[this.selectedIndex].hint = this.hintInput.value;
    //             this.commitChanges();
    //         }
    //     });
    //
    //     hintRow.appendChild(hintLabel);
    //     hintRow.appendChild(this.hintInput);
    //
    //     // --- Text Area (Image/Text) ---
    //     this.promptInput = document.createElement("textarea");
    //     this.promptInput.className = "pr-prompt-area";
    //     this.promptInput.placeholder = "Generated prompt — edit freely. Fill ✨ Hint above to guide the next generation.";
    //     this.promptInput.addEventListener("input", () => {
    //         if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
    //             this.timeline.segments[this.selectedIndex].prompt = this.promptInput.value;
    //             this.commitChanges();
    //         }
    //     });
    //
    //     // --- Audio Info Area ---
    //     this.audioInfoArea = document.createElement("div");
    //     this.audioInfoArea.className = "pr-audio-info";
    //
    //     propContainer.appendChild(hintRow);
    //     propContainer.appendChild(this.promptInput);
    //     propContainer.appendChild(this.audioInfoArea);
    //
    //     this.wrapper.addEventListener("dragover", (e) => {
    //         e.preventDefault();
    //         this.wrapper.classList.add("drag-active");
    //
    //         const {x, y} = this.getMousePos(e);
    //         const logicalWidth = this.canvas.offsetWidth;
    //         const totalFrames = this.getVisualDurationFrames();
    //         if (!logicalWidth || totalFrames <= 0) return;
    //
    //         const isAudioTrack = y > RULER_HEIGHT + this.blockHeight;
    //         const trackType = isAudioTrack ? "audio" : "image";
    //         const arrToModify = isAudioTrack ? this.timeline.audioSegments : this.timeline.segments;
    //
    //         if (!this._ghostSegmentId || this._ghostTrack !== trackType) {
    //             this._ghostSegmentId = "GHOST_" + Date.now();
    //             this._ghostTrack = trackType;
    //             this._ghostInitialTimeline = JSON.parse(JSON.stringify(arrToModify));
    //
    //             const frameRate = this.getFrameRate();
    //             const newLength = Math.max(1, frameRate * 1);
    //
    //             let mouseFrameX = x * (totalFrames / logicalWidth);
    //             let startFrame = clamp(Math.round(mouseFrameX - newLength / 2), 0, totalFrames - newLength);
    //
    //             this._ghostInitialTimeline.push({
    //                 id: this._ghostSegmentId,
    //                 start: startFrame,
    //                 length: newLength,
    //                 type: "ghost"
    //             });
    //         }
    //
    //         let mouseFrameX = x * (totalFrames / logicalWidth);
    //         const ghost = this._ghostInitialTimeline.find(s => s.id === this._ghostSegmentId);
    //         let D_mouse_start = mouseFrameX - ghost.length / 2;
    //
    //         this._previewSegments = this._applyCenterDragPhysics(
    //             this._ghostInitialTimeline,
    //             this._ghostSegmentId,
    //             D_mouse_start,
    //             mouseFrameX,
    //             totalFrames,
    //             totalFrames,
    //             logicalWidth
    //         );
    //
    //         for (let ps of this._previewSegments) {
    //             const orig = arrToModify.find(s => s.id === ps.id);
    //             if (orig) {
    //                 ps.videoEl = orig.videoEl;
    //                 ps.imgObj = orig.imgObj;
    //                 if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
    //             }
    //         }
    //
    //         this.render();
    //     });
    //
    //     this.wrapper.addEventListener("dragleave", (e) => {
    //         const rect = this.wrapper.getBoundingClientRect();
    //         if (e.clientX < rect.left || e.clientX >= rect.right ||
    //             e.clientY < rect.top || e.clientY >= rect.bottom) {
    //             this.wrapper.classList.remove("drag-active");
    //             this._ghostSegmentId = null;
    //             this._ghostTrack = null;
    //             this._ghostInitialTimeline = null;
    //             this._previewSegments = null;
    //             this.render();
    //         }
    //     });
    //
    //     this.wrapper.addEventListener("drop", (e) => {
    //         e.preventDefault();
    //         e.stopPropagation();
    //         this.wrapper.classList.remove("drag-active");
    //
    //         let targetFrameStart = null;
    //         let targetTrack = this._ghostTrack || "image";
    //
    //         if (this._ghostSegmentId && this._previewSegments) {
    //             const ghost = this._previewSegments.find(s => s.id === this._ghostSegmentId);
    //             if (ghost) {
    //                 targetFrameStart = ghost.resolvedStart !== undefined ? ghost.resolvedStart : ghost.start;
    //             }
    //         }
    //         this._ghostSegmentId = null;
    //         this._ghostTrack = null;
    //         this._ghostInitialTimeline = null;
    //         this._previewSegments = null;
    //         this.render();
    //
    //         if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    //             const imageFiles = [];
    //             const audioFiles = [];
    //             const videoFiles = [];
    //             for (let file of e.dataTransfer.files) {
    //                 if (file.type.startsWith("video/")) videoFiles.push(file);
    //                 else if (file.type.startsWith("audio/")) audioFiles.push(file);
    //                 else if (file.type.startsWith("image/")) imageFiles.push(file);
    //             }
    //
    //             // Let implicit intent handle mixing drops: use the track we hovered over
    //             // for the first type we process, or fallback.
    //             if (videoFiles.length > 0) {
    //                 this.handleVideoUpload(videoFiles, targetFrameStart);
    //             } else if (audioFiles.length > 0 && (targetTrack === "audio" || imageFiles.length === 0)) {
    //                 this.handleAudioUpload(audioFiles, targetFrameStart);
    //             } else if (imageFiles.length > 0) {
    //                 this.handleImageUpload(imageFiles, targetFrameStart);
    //             }
    //         }
    //     });
    //
    //     // Because these are anonymous functions, they cannot be targeted for removal. When a user deletes the LTXDirector node in ComfyUI, your destroy() method runs, but these listeners persist forever. Every time the node is deleted and added, a new set of ghost listeners is created, holding the entire TimelineEditor class (and all its canvases/images) in memory.
    //     //
    //     // Fix: Bind them to the class instance so they can be removed in destroy().
    //
    //     // window.addEventListener("mousemove", (e) => this.onMouseMove(e));
    //     // window.addEventListener("mouseup", (e) => this.onMouseUp(e));
    //     this._boundOnMouseMove = this.onMouseMove.bind(this);
    //     this._boundOnMouseUp = this.onMouseUp.bind(this);
    //     window.addEventListener("mousemove", this._boundOnMouseMove);
    //     window.addEventListener("mouseup", this._boundOnMouseUp);
    //
    //     // --- Player Controls ---
    //     const playerControls = document.createElement("div");
    //     playerControls.className = "pr-player-controls";
    //
    //     this.playBtn = document.createElement("button");
    //     this.playBtn.className = "pr-icon-btn";
    //     this.playBtn.style.padding = "4px";
    //     this.playBtn.innerHTML = ICONS.play;
    //     this.playBtn.title = "Play/Pause Audio";
    //     this.playBtn.addEventListener("click", () => this.togglePlay());
    //
    //     this.loopBtn = document.createElement("button");
    //     this.loopBtn.className = "pr-icon-btn";
    //     this.loopBtn.style.padding = "4px";
    //     this.loopBtn.innerHTML = ICONS.loop;
    //     this.loopBtn.title = "Toggle Loop";
    //     this.loopBtn.addEventListener("click", () => this.toggleLoop());
    //
    //     this.seekBar = document.createElement("input");
    //     this.seekBar.type = "range";
    //     this.seekBar.className = "pr-seek-bar";
    //     this.seekBar.min = "0";
    //     this.seekBar.value = "0";
    //     this.seekBar.style.flex = "1"; // take up remaining space
    //     this.seekBar.addEventListener("input", (e) => {
    //         this.currentFrame = parseInt(e.target.value, 10);
    //         this.render();
    //         if (this.isPlaying) {
    //             this.playAudio();
    //         }
    //     });
    //
    //     // --- Zoom Controls ---
    //     const zoomControls = document.createElement("div");
    //     zoomControls.className = "pr-zoom-controls";
    //
    //     const zoomOutBtn = document.createElement("button");
    //     zoomOutBtn.className = "pr-icon-btn";
    //     zoomOutBtn.style.padding = "4px";
    //     zoomOutBtn.innerHTML = ICONS.minus;
    //     zoomOutBtn.title = "Zoom Out";
    //     zoomOutBtn.addEventListener("click", () => {
    //         const currentZoom = parseFloat(this.zoomSlider.value);
    //         this.zoomSlider.value = Math.max(1, currentZoom - 0.5);
    //         this.zoomSlider.dispatchEvent(new Event("input"));
    //     });
    //
    //     this.zoomSlider = document.createElement("input");
    //     this.zoomSlider.type = "range";
    //     this.zoomSlider.className = "pr-zoom-slider";
    //     this.zoomSlider.min = "1";
    //     this.zoomSlider.max = "1"; // Updated dynamically via updateZoomSliderMax()
    //     this.zoomSlider.step = "0.1";
    //     this.zoomSlider.value = "1";
    //     this.zoomSlider.title = "Zoom Level";
    //     this.zoomSlider.addEventListener("input", (e) => {
    //         this.zoomLevel = parseFloat(e.target.value);
    //
    //         const viewportWidth = this.viewport.clientWidth;
    //         const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);
    //
    //         this.canvas.style.width = newCanvasWidth + "px";
    //         this.resizeCanvas(newCanvasWidth);
    //         this._lastWidth = viewportWidth;
    //         this._lastZoom = this.zoomLevel;
    //
    //         // Keep playhead centered
    //         const totalFrames = this.getVisualDurationFrames();
    //         const playheadRatio = this.currentFrame / totalFrames;
    //         const newPlayheadX = playheadRatio * newCanvasWidth;
    //         this.viewport.scrollLeft = newPlayheadX - (viewportWidth / 2);
    //     });
    //
    //     const zoomInBtn = document.createElement("button");
    //     zoomInBtn.className = "pr-icon-btn";
    //     zoomInBtn.style.padding = "4px";
    //     zoomInBtn.innerHTML = ICONS.plus;
    //     zoomInBtn.title = "Zoom In";
    //     zoomInBtn.addEventListener("click", () => {
    //         const currentZoom = parseFloat(this.zoomSlider.value);
    //         this.zoomSlider.value = Math.min(this.getMaxZoom(), currentZoom + 0.5);
    //         this.zoomSlider.dispatchEvent(new Event("input"));
    //     });
    //
    //     const zoomFitBtn = document.createElement("button");
    //     zoomFitBtn.className = "pr-icon-btn";
    //     zoomFitBtn.style.padding = "4px";
    //     zoomFitBtn.style.marginLeft = "4px";
    //     zoomFitBtn.innerHTML = ICONS.fit;
    //     zoomFitBtn.title = "Zoom to Fit (show full timeline)";
    //     zoomFitBtn.addEventListener("click", () => {
    //         this.zoomLevel = 1;
    //         this.zoomSlider.value = 1;
    //         const viewportWidth = this.viewport.clientWidth;
    //         this.canvas.style.width = viewportWidth + "px";
    //         this.resizeCanvas(viewportWidth);
    //         this._lastWidth = viewportWidth;
    //         this._lastZoom = 1;
    //         this.viewport.scrollLeft = 0;
    //     });
    //
    //     zoomControls.appendChild(zoomOutBtn);
    //     zoomControls.appendChild(this.zoomSlider);
    //     zoomControls.appendChild(zoomInBtn);
    //     zoomControls.appendChild(zoomFitBtn);
    //
    //     playerControls.appendChild(this.playBtn);
    //     playerControls.appendChild(this.loopBtn);
    //     playerControls.appendChild(this.seekBar);
    //     playerControls.appendChild(zoomControls);
    //
    //
    //     // --- Guide Strength Slider ---
    //     this.strengthRow = document.createElement("div");
    //     this.strengthRow.className = "pr-strength-row";
    //
    //     const strengthLabel = document.createElement("span");
    //     strengthLabel.className = "pr-strength-label";
    //     strengthLabel.textContent = "Guide Strength:";
    //
    //     this.strengthValue = document.createElement("input");
    //     this.strengthValue.type = "text";
    //     this.strengthValue.className = "pr-strength-input";
    //     this.strengthValue.value = "1.00";
    //     this.strengthValue.disabled = true;
    //     this.strengthValue.style.cursor = "ew-resize";
    //
    //     // Dragging logic for guide strength
    //     let isDragging = false;
    //     let startX = 0;
    //     let startVal = 0;
    //     let hasMoved = false;
    //
    //     this.strengthValue.addEventListener("mousedown", (e) => {
    //         if (this.strengthValue.disabled) return;
    //         startX = e.clientX;
    //         startVal = parseFloat(this.strengthValue.value) || 1.0;
    //         hasMoved = false;
    //
    //         const onMouseMove = (moveEvent) => {
    //             const deltaX = moveEvent.clientX - startX;
    //             if (Math.abs(deltaX) > 3) {
    //                 hasMoved = true;
    //                 isDragging = true;
    //             }
    //
    //             if (isDragging) {
    //                 moveEvent.preventDefault();
    //                 const sensitivity = 0.002;
    //                 let newVal = startVal + deltaX * sensitivity;
    //
    //                 if (newVal < 0) newVal = 0;
    //                 if (newVal > 1) newVal = 1;
    //
    //                 this.strengthValue.value = newVal.toFixed(2);
    //
    //                 if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
    //                     const seg = this.timeline.segments[this.selectedIndex];
    //                     if (seg.type !== "text") {
    //                         seg.guideStrength = newVal;
    //                         this.commitChanges();
    //                     }
    //                 }
    //             }
    //         };
    //
    //         const onMouseUp = () => {
    //             document.removeEventListener("mousemove", onMouseMove);
    //             document.removeEventListener("mouseup", onMouseUp);
    //
    //             if (!hasMoved) {
    //                 this.strengthValue.focus();
    //                 this.strengthValue.select();
    //             }
    //             isDragging = false;
    //         };
    //
    //         document.addEventListener("mousemove", onMouseMove);
    //         document.addEventListener("mouseup", onMouseUp);
    //     });
    //
    //     this.strengthValue.addEventListener("change", (e) => {
    //         let val = parseFloat(e.target.value);
    //         if (isNaN(val)) val = 1;
    //         val = Math.max(0, Math.min(1, val));
    //         this.strengthValue.value = val.toFixed(2);
    //         if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
    //             const seg = this.timeline.segments[this.selectedIndex];
    //             if (seg.type !== "text") {
    //                 seg.guideStrength = val;
    //                 this.commitChanges();
    //             }
    //         }
    //     });
    //
    //     this.strengthRow.appendChild(this.timeCodeDisplay);
    //     this.strengthRow.appendChild(this.segmentBoundsDisplay);
    //     this.strengthRow.appendChild(strengthLabel);
    //     this.strengthRow.appendChild(this.strengthValue);
    //
    //     this.wrapper.appendChild(toolbar);
    //     this.wrapper.appendChild(this.viewport);
    //
    //     const controlsGroup = document.createElement("div");
    //     controlsGroup.className = "pr-controls-group";
    //     controlsGroup.appendChild(this.strengthRow);
    //     controlsGroup.appendChild(playerControls);
    //     this.wrapper.appendChild(controlsGroup);
    //     this.wrapper.appendChild(propContainer);
    //
    //     this.container.appendChild(this.wrapper);
    // }
    //

    _createAudioModeControl() {
        const audioModeWrapper = document.createElement("div");
        audioModeWrapper.className = "pr-audio-mode-wrapper";

        const audioLabel = document.createElement("span");
        audioLabel.textContent = "AUDIO:";
        audioLabel.className = "pr-audio-label";

        const audioModeCtrl = document.createElement("div");
        audioModeCtrl.className = "pr-segmented-control";

        // Map short labels to the exact Python values
        // Map short labels to the exact Python values using our JS Enum
        const audioModes = [
            {
                label: "✨ Auto-Gen",
                value: AudioMode.GENERATE,
                title: "Generate new audio from scratch (ignores timeline)"
            },
            {
                label: "🔄 Remix",
                value: AudioMode.TEMPLATE,
                title: "Template mode: AI denoises your timeline audio (Dubbing)"
            },
            {
                label: "🔒 Preserve",
                value: AudioMode.PRESERVE,
                title: "Preserve mode: Locks timeline audio, AI only fills gaps"
            }
        ];

        const updateAudioModeUI = (val) => {
            Array.from(audioModeCtrl.children).forEach(child => {
                if (child.dataset.val === val) child.classList.add("active");
                else child.classList.remove("active");
            });
        };

        audioModes.forEach(m => {
            const seg = document.createElement("div");
            seg.className = "pr-segment";
            seg.textContent = m.label;
            seg.title = m.title;
            seg.dataset.val = m.value;
            seg.style.padding = "0 10px";

            seg.addEventListener("click", (e) => {
                e.stopPropagation();
                const widget = this.node.widgets?.find(w => w.name === "audio_mode");
                if (widget) {
                    widget.value = m.value;
                    updateAudioModeUI(m.value);
                    this.node.setDirtyCanvas(true, true);
                }
            });
            audioModeCtrl.appendChild(seg);
        });

        // Set initial active state based on the Python widget
        setTimeout(() => {
            const widget = this.node.widgets?.find(w => w.name === "audio_mode");
            if (widget) updateAudioModeUI(widget.value);
        }, 100);

        audioModeWrapper.appendChild(audioLabel);
        audioModeWrapper.appendChild(audioModeCtrl);

        return audioModeWrapper;
    }

    _createHelpButton() {
        const helpBtn = document.createElement("button");
        helpBtn.className = "pr-btn pr-settings-btn";
        helpBtn.innerHTML = "?";
        helpBtn.title = "Help / Documentation";
        helpBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            window.open("https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI", "_blank");
        });
        return helpBtn;
    }

    checkResize() {
        const viewportWidth = this.viewport.clientWidth;
        const currentScale = this.getRenderScale();

        if (viewportWidth > 0 && (this._lastWidth !== viewportWidth || this._lastZoom !== this.zoomLevel || this._lastScale !== currentScale)) {
            this._lastWidth = viewportWidth;
            this._lastZoom = this.zoomLevel;
            this._lastScale = currentScale;

            const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);
            this.canvas.style.width = newCanvasWidth + "px";
            this.resizeCanvas(newCanvasWidth);
        }
        this._renderLoop = requestAnimationFrame(() => this.checkResize());
    }

    getRenderScale() {
        const dpr = window.devicePixelRatio || 1;
        let graphScale = 1;
        try {
            if (window.app && window.app.canvas && window.app.canvas.ds && window.app.canvas.ds.scale) {
                graphScale = window.app.canvas.ds.scale;
            }
        } catch (e) {
        }
        // Scale up if zoomed in, but don't drop below 1x DPR if zoomed out
        return dpr * Math.max(1, graphScale);
    }

    resizeCanvas(widthPx) {
        const scale = this.getRenderScale();
        const targetWidth = Math.round(widthPx * scale);
        const targetHeight = Math.round(this.canvasHeight * scale);

        this.canvas.width = targetWidth;
        this.canvas.height = targetHeight;
        this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
        this.render();
    }

    // Helper to map mouse events accurately regardless of canvas scaling
    getMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();

        const scaleX = this.canvas.offsetWidth / rect.width;
        const scaleY = this.canvas.offsetHeight / rect.height;

        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        return {x, y};
    }

    // --- Async Image Upload Logic (Handles multiple images simultaneously) ---
    async handleImageUpload(files, targetFrameStart = null, explicitLength = null) {
        const frameRate = this.getFrameRate();
        const durationFrames = this.getDurationFrames();
        const newLength = explicitLength !== null ? explicitLength : frameRate * 1; // Default to 1 second long

        for (let file of files) {
            if (!file.type.startsWith("image/")) continue;

            await new Promise(async (resolve) => {
                try {
                    const body = new FormData();
                    body.append("image", file);
                    const resp = await api.fetchApi("/upload/image", {method: "POST", body});
                    if (resp.status !== 200) {
                        resolve();
                        return;
                    }

                    const data = await resp.json();
                    const filename = data.name;
                    const subfolder = data.subfolder || "";
                    const imageFile = subfolder ? subfolder + "/" + filename : filename;
                    const imgUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

                    const img = new Image();
                    img.onload = () => {

                        let newStart = targetFrameStart;
                        if (newStart === null) {
                            // Fallback: find the first free slot, or append past the end
                            newStart = 0;
                            this.timeline.segments.sort((a, b) => a.start - b.start);
                            for (let i = 0; i < this.timeline.segments.length; i++) {
                                let seg = this.timeline.segments[i];
                                if (newStart + newLength <= seg.start) break;
                                newStart = Math.max(newStart, seg.start + seg.length);
                            }
                        }

                        // Use the visual timeline as the physics bound so segments can
                        // land anywhere in the padded visual area without touching duration_frames.
                        const currentDuration = this.getVisualDurationFrames();

                        if (targetFrameStart !== null) {
                            // Resolve physics to push existing segments
                            let tempId = "TEMP_" + Date.now();
                            this.timeline.segments.push({id: tempId, start: newStart, length: newLength, type: "temp"});
                            let result = this._applyCenterDragPhysics(this.timeline.segments, tempId, newStart, newStart + newLength / 2, currentDuration, currentDuration, 1);

                            // Update original segments with resolved physics to preserve imgObj
                            for (let shiftedSeg of result) {
                                let original = this.timeline.segments.find(s => s.id === shiftedSeg.id);
                                if (original) {
                                    original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
                                }
                            }

                            let tempSeg = this.timeline.segments.find(s => s.id === tempId);
                            newStart = tempSeg.start;
                            this.timeline.segments = this.timeline.segments.filter(s => s.id !== tempId);
                            targetFrameStart = newStart + newLength; // For the next file in batch
                        }

                        // Use the full intended length — the timeline has already been grown to fit.
                        let constrainedLength = newLength;

                        const seg = {
                            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                            start: newStart,
                            length: constrainedLength,
                            prompt: "",
                            type: "image",
                            imageFile: imageFile,
                            imageB64: imgUrl
                        };

                        const displayImg = new Image();
                        displayImg.onload = () => {
                            seg.imgObj = displayImg;
                            this.render();
                            resolve(); // Resolve promise letting next image process
                        };
                        displayImg.src = imgUrl;

                        this.timeline.segments.push(seg);
                        this.timeline.segments.sort((a, b) => a.start - b.start);
                        this.selectionType = "image";
                        this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);

                        this.updateUIFromSelection();
                        this.commitChanges(true);
                    };
                    img.src = imgUrl;
                } catch (err) {
                    console.error(PluginName, "[PromptRelay] Image upload failed", err);
                    resolve();
                }
            });
        }
        this.fileInput.value = "";
    }

    async handleVideoUpload(files, targetFrameStart = null) {
        const frameRate = this.getFrameRate();

        for (let file of files) {
            if (!file.type.startsWith("video/")) continue;

            await new Promise(async (resolve) => {
                try {
                    const body = new FormData();
                    body.append("image", file);
                    const resp = await api.fetchApi("/upload/image", {method: "POST", body});

                    if (resp.status !== 200) {
                        resolve();
                        return;
                    }

                    const data = await resp.json();
                    const filename = data.name;
                    const subfolder = data.subfolder || "";
                    const filePath = subfolder ? subfolder + "/" + filename : filename;

                    const vidUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

                    const vid = document.createElement('video');
                    vid.crossOrigin = "Anonymous";
                    vid.preload = 'auto';

                    vid.onloadeddata = async () => {
                        const clipDurationSecs = vid.duration;
                        const clipFrames = Math.max(1, Math.ceil(clipDurationSecs * frameRate));

                        let newStart = targetFrameStart !== null ? targetFrameStart : 0;
                        let newLength = clipFrames;

                        const sharedId = Date.now().toString() + Math.random().toString(36).substr(2, 5);

                        // Create linked video segment
                        const vidSeg = {
                            id: sharedId + "_v",
                            type: "video",
                            start: newStart,
                            length: newLength,
                            trimStart: 0,
                            videoDurationFrames: clipFrames,
                            imageFile: filePath,
                            fileName: file.name,
                            prompt: "",
                            videoEl: vid
                        };

                        // And linked audio segment
                        const audSeg = {
                            id: sharedId + "_a",
                            type: "audio",
                            start: newStart,
                            length: newLength,
                            trimStart: 0,
                            audioDurationFrames: clipFrames,
                            audioFile: filePath,
                            fileName: file.name,
                            waveformPeaks: []
                        };

                        // Attempt to extract audio from video for waveform generation
                        try {
                            const arrayBuffer = await file.arrayBuffer();
                            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                            const channelData = audioBuffer.getChannelData(0);
                            const peaks = [];
                            const numPeaks = 200;
                            const step = Math.floor(channelData.length / numPeaks);
                            for (let i = 0; i < numPeaks; i++) {
                                let max = 0;
                                for (let j = 0; j < step; j++) {
                                    const val = Math.abs(channelData[i * step + j]);
                                    if (val > max) max = val;
                                }
                                peaks.push(max);
                            }
                            audSeg.waveformPeaks = peaks;
                            await audioCtx.close();
                        } catch (e) {
                            console.warn(PluginName, "No audio in video or decode failed");
                        }

                        // Extract a single frame for the static fallback thumbnail
                        vid.currentTime = 0.01;
                        vid.onseeked = () => {
                            const canvas = document.createElement('canvas');
                            canvas.width = Math.min(vid.videoWidth, 512);
                            canvas.height = Math.round((vid.videoHeight / vid.videoWidth) * canvas.width);
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
                            vidSeg.imageB64 = canvas.toDataURL('image/jpeg');

                            const imgObj = new Image();
                            imgObj.onload = () => {
                                vidSeg.imgObj = imgObj;
                                this.render();
                            };
                            imgObj.src = vidSeg.imageB64;

                            this.timeline.segments.push(vidSeg);
                            this.timeline.audioSegments.push(audSeg);
                            this.timeline.segments.sort((a, b) => a.start - b.start);
                            this.timeline.audioSegments.sort((a, b) => a.start - b.start);

                            this.selectionType = "image";
                            this.selectedIndex = this.timeline.segments.findIndex(s => s.id === vidSeg.id);

                            this.updateUIFromSelection();
                            this.commitChanges(true);
                            resolve();
                            this._ensureThumbnails(vidSeg);
                        };
                    };

                    vid.onerror = (e) => {
                        console.error(PluginName, "Video load error", e);
                        resolve();
                    };

                    vid.src = vidUrl;

                } catch (err) {
                    console.error(PluginName, "Video upload failed", err);
                    resolve();
                }
            });
        }

        if (this.videoFileInput) {
            this.videoFileInput.value = "";
        }
    }

    // --- Async Audio Upload Logic ---
    async handleAudioUpload(files, targetFrameStart = null) {
        const frameRate = this.getFrameRate();
        const durationFrames = this.getDurationFrames();

        for (let file of files) {
            if (!file.type.startsWith("audio/")) continue;

            await new Promise(async (resolve) => {
                try {
                    const body = new FormData();
                    body.append("image", file);
                    const resp = await api.fetchApi("/upload/image", {method: "POST", body});
                    if (resp.status !== 200) {
                        resolve();
                        return;
                    }

                    const data = await resp.json();
                    const filename = data.name;
                    const subfolder = data.subfolder || "";
                    const audioFile = subfolder ? subfolder + "/" + filename : filename;

                    const arrayBuffer = await file.arrayBuffer();
                    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                    const clipDurationSecs = audioBuffer.duration;
                    const clipFrames = Math.max(1, Math.ceil(clipDurationSecs * frameRate));

                    const channelData = audioBuffer.getChannelData(0);
                    const peaks = [];
                    const numPeaks = 200;
                    const step = Math.floor(channelData.length / numPeaks);
                    for (let i = 0; i < numPeaks; i++) {
                        let max = 0;
                        for (let j = 0; j < step; j++) {
                            const val = Math.abs(channelData[i * step + j]);
                            if (val > max) max = val;
                        }
                        peaks.push(max);
                    }
                    await audioCtx.close();
                    let newLength = clipFrames;
                    let newStart = targetFrameStart;

                    if (newStart === null) {
                        // Find the first free slot, or place past the end of all existing audio
                        newStart = 0;
                        this.timeline.audioSegments.sort((a, b) => a.start - b.start);
                        for (let i = 0; i < this.timeline.audioSegments.length; i++) {
                            let seg = this.timeline.audioSegments[i];
                            if (newStart + newLength <= seg.start) break;
                            newStart = Math.max(newStart, seg.start + seg.length);
                        }
                    }

                    // Use the visual timeline as the physics bound so segments can
                    // land anywhere in the padded visual area without touching duration_frames.
                    const currentDuration = this.getVisualDurationFrames();

                    if (targetFrameStart !== null) {
                        let tempId = "TEMP_" + Date.now();
                        this.timeline.audioSegments.push({
                            id: tempId,
                            start: newStart,
                            length: newLength,
                            type: "temp"
                        });
                        let result = this._applyCenterDragPhysics(this.timeline.audioSegments, tempId, newStart, newStart + newLength / 2, currentDuration, currentDuration, 1);

                        for (let shiftedSeg of result) {
                            let original = this.timeline.audioSegments.find(s => s.id === shiftedSeg.id);
                            if (original) original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
                        }

                        let tempSeg = this.timeline.audioSegments.find(s => s.id === tempId);
                        newStart = tempSeg.start;
                        this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== tempId);
                        targetFrameStart = newStart + newLength;
                    }

                    // Use the full clip length — timeline has already grown to fit.
                    let constrainedLength = newLength;

                    const seg = {
                        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                        type: "audio",
                        start: newStart,
                        length: constrainedLength,
                        trimStart: 0,
                        audioDurationFrames: clipFrames,
                        audioFile: audioFile,
                        fileName: file.name,
                        waveformPeaks: peaks
                    };

                    this.timeline.audioSegments.push(seg);
                    this.timeline.audioSegments.sort((a, b) => a.start - b.start);
                    this.selectionType = "audio";
                    this.selectedIndex = this.timeline.audioSegments.findIndex(s => s.id === seg.id);

                    this.updateUIFromSelection();
                    this.commitChanges(true);
                    this.render();
                    resolve();
                } catch (err) {
                    console.error(PluginName, "[PromptRelay] Audio processing failed", err);
                    resolve();
                }
            });
        }
        this.audioFileInput.value = "";
    }

    deleteSelectedSegment() {
        const delSibling = (seg) => {
            if (!seg || !seg.id) return;
            const isVid = seg.id.endsWith("_v");
            const isAud = seg.id.endsWith("_a");
            if (!isVid && !isAud) return;

            const siblingId = isVid ? seg.id.slice(0, -2) + "_a" : seg.id.slice(0, -2) + "_v";
            const siblingArray = isVid ? this.timeline.audioSegments : this.timeline.segments;
            const sIdx = siblingArray.findIndex(s => s.id === siblingId);
            if (sIdx !== -1) siblingArray.splice(sIdx, 1);
        };

        if (this.selectionType === "audio") {
            if (this.timeline.audioSegments.length === 0 || this.selectedIndex === -1) return;
            delSibling(this.timeline.audioSegments[this.selectedIndex]);
            this.timeline.audioSegments.splice(this.selectedIndex, 1);
            this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
        } else {
            if (this.timeline.segments.length === 0 || this.selectedIndex === -1) return;
            delSibling(this.timeline.segments[this.selectedIndex]);
            this.timeline.segments.splice(this.selectedIndex, 1);
            this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
        }
        this.updateUIFromSelection();
        this.commitChanges();
        this.render();
    }

    formatTime(frames, dropSuffix = false) {
        const mode = this.displayModeWidget ? this.displayModeWidget.value : "seconds";
        if (mode === "seconds") {
            const secs = frames / this.getFrameRate();
            return dropSuffix ? secs.toFixed(2) : secs.toFixed(2) + "s";
        }
        return dropSuffix ? Math.round(frames).toString() : Math.round(frames) + " frames";
    }

    updateWidgetVisibility() {
        const mode = this.displayModeWidget ? this.displayModeWidget.value : "seconds";

        if (this.durationFramesWidget) {
            // Always visible regardless of display mode
            this.durationFramesWidget.type = "INT";
            if (!this.durationFramesWidget.options) this.durationFramesWidget.options = {};
            this.durationFramesWidget.options.hidden = false;
            this.durationFramesWidget.hidden = false;
            delete this.durationFramesWidget.computeSize;
        }
        if (this.durationSecondsWidget) {
            // Always visible regardless of display mode
            this.durationSecondsWidget.type = "FLOAT";
            if (!this.durationSecondsWidget.options) this.durationSecondsWidget.options = {};
            this.durationSecondsWidget.options.hidden = false;
            this.durationSecondsWidget.hidden = false;
            delete this.durationSecondsWidget.computeSize;
        }

        // Force node resize and redraw deferred to next tick
        setTimeout(() => {
            if (this.node && this.node.computeSize) {
                const sz = this.node.computeSize();
                this.node.size[1] = sz[1];
                if (window.app && window.app.graph) {
                    window.app.graph.setDirtyCanvas(true, true);
                }
            }
        }, 0);
    }

    updateUIFromSelection() {
        let seg = null;
        if (this.selectedIndex >= 0) {
            if (this.selectionType === "audio") {
                const origSeg = this.timeline.audioSegments[this.selectedIndex];
                if (origSeg) {
                    const previewIsAudio = this._ghostTrack === 'audio' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'audio');
                    const arr = (this._previewSegments && previewIsAudio) ? this._previewSegments : this.timeline.audioSegments;
                    seg = arr.find(s => s.id === origSeg.id) || origSeg;
                }
            } else {
                const origSeg = this.timeline.segments[this.selectedIndex];
                if (origSeg) {
                    const previewIsImage = this._ghostTrack === 'image' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'image');
                    const arr = (this._previewSegments && previewIsImage) ? this._previewSegments : this.timeline.segments;
                    seg = arr.find(s => s.id === origSeg.id) || origSeg;
                }
            }
        }

        if (this.selectionType === "audio" && seg) {
            this.promptInput.style.display = "none";
            this.strengthRow.style.display = "flex";
            this.audioInfoArea.style.display = "block";
            this.audioInfoArea.innerHTML = `
        File: <span>${seg.fileName || "Unknown"}</span><br>
        Length: <span>${this.formatTime(seg.audioDurationFrames)}</span> Output Length: <span>${this.formatTime(seg.length)}</span><br>
        Trim-in: <span>${this.formatTime(Math.round(seg.trimStart))}</span> Trim-Out: <span>${this.formatTime(Math.round(seg.audioDurationFrames - (seg.trimStart + seg.length)))}</span>
      `;
            this.strengthValue.value = "1.00";
            this.strengthValue.disabled = true;
        } else {
            this.audioInfoArea.style.display = "none";
            this.promptInput.style.display = "block";
            this.strengthRow.style.display = "flex";

            if (seg) {
                this.promptInput.value = seg.prompt || "";
                this.promptInput.disabled = false;
                this.hintInput.value = seg.hint || "";
                this.hintInput.disabled = false;
                this.hintInput.closest(".pr-hint-row").style.display = "flex";

                const isImage = seg.type !== "text";
                const strength = isImage ? (seg.guideStrength ?? 1.0) : 1.0;
                this.strengthValue.value = strength.toFixed(2);
                this.strengthValue.disabled = !isImage;
            } else {
                this.promptInput.value = "";
                this.promptInput.disabled = true;
                this.hintInput.value = "";
                this.hintInput.disabled = true;
                this.hintInput.closest(".pr-hint-row").style.display = "none";
                this.strengthValue.value = "1.00";
                this.strengthValue.disabled = true;
            }
        }

        if (this.segmentBoundsDisplay) {
            if (seg) {
                const startStr = this.formatTime(seg.start, true);
                const endStr = this.formatTime(seg.start + seg.length, true);
                this.segmentBoundsDisplay.textContent = `Start: ${startStr} | End: ${endStr}`;
            } else {
                this.segmentBoundsDisplay.textContent = "Start: - | End: -";
            }
        }
    }


    // --- Rendering logic ---
    render() {
        const width = this.canvas.offsetWidth || this._lastWidth;
        const height = this.canvasHeight;
        const totalFrames = this.getVisualDurationFrames();

        if (!width || width <= 0) return;

        this.ctx.clearRect(0, 0, width, height);
        // Render Track Backgrounds
        this.ctx.fillStyle = "#111111"; // Image track bg
        // this.ctx.fillStyle = "#111111"; // Image track bg
        this.ctx.fillRect(0, RULER_HEIGHT, width, this.blockHeight);
        this.ctx.fillStyle = "#111111"; // Audio track bg
        this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight, width, this.audioTrackHeight);

        // Determine which track the preview belongs to.
        // _ghostTrack is set during HTML file drag-and-drop.
        // During canvas mouse drags, _ghostTrack is null, so fall back to selectionType.
        const previewIsAudio = this._ghostTrack === 'audio' ||
            (this._previewSegments && this._ghostTrack === null && this.selectionType === 'audio');

        let renderSegments = (this._previewSegments && !previewIsAudio)
            ? this._previewSegments : this.timeline.segments;

        let renderAudioSegments = (this._previewSegments && previewIsAudio)
            ? this._previewSegments : this.timeline.audioSegments;


        const activeSegId = this.timeline.segments[this.selectedIndex]?.id;
        const activeAudioSegId = this.timeline.audioSegments[this.selectedIndex]?.id;

        // Sort segments so that the selected one is drawn last (on top)
        const isImageSelection = this.selectionType === "image";
        const sortedSegments = [...renderSegments].sort((a, b) => {
            const aSel = isImageSelection && a.id === activeSegId;
            const bSel = isImageSelection && b.id === activeSegId;
            return aSel - bSel;
        });

        const isAudioSelection = this.selectionType === "audio";
        const sortedAudioSegments = [...renderAudioSegments].sort((a, b) => {
            const aSel = isAudioSelection && a.id === activeAudioSegId;
            const bSel = isAudioSelection && b.id === activeAudioSegId;
            return aSel - bSel;
        });

        // --- Draw Image/Text Segments ---
        for (let i = 0; i < sortedSegments.length; i++) {
            const seg = sortedSegments[i];
            const startX = (seg.start / totalFrames) * width;
            const pxWidth = (seg.length / totalFrames) * width;
            const isSelected = (this.selectionType === "image" && seg.id === activeSegId);

            const originalSeg = this.timeline.segments.find(s => s.id === seg.id);
            const imgObj = originalSeg ? originalSeg.imgObj : seg.imgObj;
            const videoEl = originalSeg ? originalSeg.videoEl : seg.videoEl;

            const mediaToDraw = (videoEl && videoEl.readyState >= 2) ? videoEl : (imgObj && imgObj.complete ? imgObj : null);

            if ((this._isDragging && this.selectionType === "image" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
                this.ctx.globalAlpha = 0.65;
            } else {
                this.ctx.globalAlpha = 1.0;
            }

            if (seg.type === "ghost") {
                this.ctx.fillStyle = "#2A2A2A";
                this.ctx.fillRect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);

                this.ctx.strokeStyle = "#777777";
                this.ctx.lineWidth = 2;
                this.ctx.setLineDash([5, 5]);
                this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
                this.ctx.setLineDash([]);

                this.ctx.fillStyle = "#AAAAAA";
                this.ctx.textAlign = "center";
                this.ctx.textBaseline = "middle";
                this.ctx.font = "bold 12px sans-serif";
                this.ctx.fillText("Drop to Place", startX + pxWidth / 2, RULER_HEIGHT + this.blockHeight / 2);
            } else {
                this.ctx.fillStyle = seg.type === "text" ? "#000B12" : "#000000";
                this.ctx.fillRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
            }

            if (seg.type === "video" && seg.thumbnails && seg.thumbnails.length > 0) {
                const natW = seg.thumbnails[0].img.naturalWidth;
                const natH = seg.thumbnails[0].img.naturalHeight;
                const imgRatio = natW / natH;
                const boxRatio = pxWidth / this.blockHeight;

                this.ctx.save();
                this.ctx.beginPath();
                this.ctx.rect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
                this.ctx.clip();

                if (imgRatio > boxRatio) {
                    const drawW = pxWidth;
                    const drawH = pxWidth / imgRatio;
                    const drawX = startX;
                    const drawY = RULER_HEIGHT + (this.blockHeight - drawH) / 2;

                    const midSec = ((seg.trimStart || 0) + seg.length / 2) / this.getFrameRate();
                    let nearestImg = seg.thumbnails[0].img;
                    let minDiff = Infinity;
                    for (const t of seg.thumbnails) {
                        const diff = Math.abs(t.time - midSec);
                        if (diff < minDiff) {
                            minDiff = diff;
                            nearestImg = t.img;
                        }
                    }
                    this.ctx.drawImage(nearestImg, drawX, drawY, drawW, drawH);
                } else {
                    const drawH = this.blockHeight;
                    const drawW = drawH * imgRatio;
                    const startSec = (seg.trimStart || 0) / this.getFrameRate();
                    const endSec = startSec + (seg.length / this.getFrameRate());

                    let curX = startX;
                    while (curX < startX + pxWidth) {
                        const ratioX = (curX - startX + drawW / 2) / pxWidth;
                        const timeAtX = startSec + ratioX * (endSec - startSec);

                        let nearestImg = seg.thumbnails[0].img;
                        let minDiff = Infinity;
                        for (const t of seg.thumbnails) {
                            const diff = Math.abs(t.time - timeAtX);
                            if (diff < minDiff) {
                                minDiff = diff;
                                nearestImg = t.img;
                            }
                        }

                        this.ctx.drawImage(nearestImg, curX, RULER_HEIGHT, drawW, drawH);
                        curX += drawW;
                    }
                }
                this.ctx.restore();
            } else if (mediaToDraw && seg.type !== "ghost") {
                const isVid = !!mediaToDraw.videoWidth;
                const natW = isVid ? mediaToDraw.videoWidth : mediaToDraw.naturalWidth;
                const natH = isVid ? mediaToDraw.videoHeight : mediaToDraw.naturalHeight;

                if (natW > 0) {
                    const imgRatio = natW / natH;
                    const boxRatio = pxWidth / this.blockHeight;
                    let drawW, drawH, drawX, drawY;
                    if (imgRatio > boxRatio) {
                        drawW = pxWidth;
                        drawH = pxWidth / imgRatio;
                        drawX = startX;
                        drawY = RULER_HEIGHT + (this.blockHeight - drawH) / 2;
                    } else {
                        drawH = this.blockHeight;
                        drawW = this.blockHeight * imgRatio;
                        drawY = RULER_HEIGHT;
                        drawX = startX + (pxWidth - drawW) / 2;
                    }

                    // Clip to segment bounds so tiled images don't bleed into adjacent segments
                    this.ctx.save();
                    this.ctx.beginPath();
                    this.ctx.rect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
                    this.ctx.clip();

                    if (imgRatio > boxRatio) {
                        // Fits width, vertical letterboxing (black bars top/bottom) — keep as is
                        this.ctx.drawImage(mediaToDraw, drawX, drawY, drawW, drawH);
                    } else {
                        // Fits height, horizontal letterboxing (black bars left/right) — tile horizontally
                        this.ctx.drawImage(mediaToDraw, drawX, drawY, drawW, drawH);
                        // Tile left
                        let leftX = drawX - drawW;
                        while (leftX + drawW > startX) {
                            this.ctx.drawImage(mediaToDraw, leftX, drawY, drawW, drawH);
                            leftX -= drawW;
                        }
                        let rightX = drawX + drawW;
                        while (rightX < startX + pxWidth) {
                            this.ctx.drawImage(mediaToDraw, rightX, drawY, drawW, drawH);
                            rightX += drawW;
                        }
                    }
                    this.ctx.restore();
                }
            }

            if ((seg.type === "video" || mediaToDraw) && seg.type !== "ghost") {
                if (seg.type === "video") {
                    this.ctx.fillStyle = "rgba(0,0,0,0.6)";
                    this.ctx.fillRect(startX + 4, RULER_HEIGHT + 4, 30, 16);
                    this.ctx.fillStyle = "#FFFFFF";
                    this.ctx.font = "bold 10px sans-serif";
                    this.ctx.textAlign = "center";
                    this.ctx.textBaseline = "middle";
                    this.ctx.fillText("VID", startX + 19, RULER_HEIGHT + 12);
                }

                // --- Prompt subtitle overlay ---
                if (seg.prompt && seg.type !== "ghost" && pxWidth > 24) {
                    const overlayH = Math.round(this.blockHeight * 0.20);
                    const overlayY = RULER_HEIGHT + this.blockHeight - overlayH;

                    this.ctx.save();
                    this.ctx.beginPath();
                    this.ctx.rect(startX, overlayY, pxWidth, overlayH);
                    this.ctx.clip();

                    // Translucent background
                    this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
                    this.ctx.fillRect(startX, overlayY, pxWidth, overlayH);

                    // Text
                    const fontSize = Math.min(11, overlayH * 0.58);
                    this.ctx.font = `${fontSize}px sans-serif`;
                    this.ctx.fillStyle = "#E0E3ED";
                    this.ctx.textAlign = "center";
                    this.ctx.textBaseline = "middle";

                    // Measure and truncate to single line
                    const maxTextW = pxWidth - 10;
                    let label = seg.prompt;
                    if (this.ctx.measureText(label).width > maxTextW) {
                        while (label.length > 0 && this.ctx.measureText(label + "…").width > maxTextW) {
                            label = label.slice(0, -1);
                        }
                        label += "…";
                    }

                    this.ctx.fillText(label, startX + pxWidth / 2, overlayY + overlayH / 2);
                    this.ctx.restore();
                }
            } else if (seg.type === "text") {
                const pad = 8;
                const boxW = pxWidth - pad * 2;
                if (boxW > 12) {
                    this.ctx.save();
                    this.ctx.beginPath();
                    this.ctx.rect(startX + pad, RULER_HEIGHT + pad, boxW, this.blockHeight - pad * 2);
                    this.ctx.clip();
                    this.ctx.fillStyle = "#E0E3ED";
                    this.ctx.font = "11px sans-serif";
                    this.ctx.textAlign = "center";
                    this.ctx.textBaseline = "top";
                    const label = seg.prompt || "(no prompt)";
                    const words = label.split(" ");
                    const lineH = 15;
                    let line = "";
                    let lines = [];
                    for (const word of words) {
                        const test = line ? line + " " + word : word;
                        if (this.ctx.measureText(test).width > boxW && line) {
                            lines.push(line);
                            line = word;
                        } else {
                            line = test;
                        }
                    }
                    if (line) lines.push(line);

                    const maxLines = Math.max(1, Math.floor((this.blockHeight - pad * 2) / lineH));
                    if (lines.length > maxLines) {
                        lines = lines.slice(0, maxLines);
                        lines[lines.length - 1] += "…";
                    }

                    const totalTextHeight = lines.length * lineH;
                    let ty = RULER_HEIGHT + (this.blockHeight - totalTextHeight) / 2 + 2;

                    for (const l of lines) {
                        this.ctx.fillText(l, startX + pxWidth / 2, ty);
                        ty += lineH;
                    }
                    this.ctx.restore();
                }
            }

            if (isSelected) {
                this.ctx.strokeStyle = "#FFFFFF";
                this.ctx.lineWidth = 2;
                this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
                this.ctx.fillStyle = "#FFFFFF";
                this.ctx.beginPath();
                this.ctx.roundRect(startX, RULER_HEIGHT + this.blockHeight / 2 - 12, 4, 24, 2);
                this.ctx.fill();
                this.ctx.beginPath();
                this.ctx.roundRect(startX + pxWidth - 4, RULER_HEIGHT + this.blockHeight / 2 - 12, 4, 24, 2);
                this.ctx.fill();
            } else {
                this.ctx.strokeStyle = "#000000";
                this.ctx.lineWidth = 1.5;
                this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
            }
            this.ctx.globalAlpha = 1.0;
        }

        // --- Draw Audio Segments ---
        for (let i = 0; i < sortedAudioSegments.length; i++) {
            const seg = sortedAudioSegments[i];
            const startX = (seg.start / totalFrames) * width;
            const pxWidth = (seg.length / totalFrames) * width;
            const isSelected = (this.selectionType === "audio" && seg.id === activeAudioSegId);
            const trackY = RULER_HEIGHT + this.blockHeight;

            if ((this._isDragging && this.selectionType === "audio" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
                this.ctx.globalAlpha = 0.65;
            } else {
                this.ctx.globalAlpha = 1.0;
            }

            if (seg.type === "ghost") {
                this.ctx.fillStyle = "#1A1A1A";
                this.ctx.fillRect(startX, trackY, pxWidth, this.audioTrackHeight);
                this.ctx.strokeStyle = "#555555";
                this.ctx.lineWidth = 2;
                this.ctx.setLineDash([5, 5]);
                this.ctx.strokeRect(startX, trackY, pxWidth, this.audioTrackHeight);
                this.ctx.setLineDash([]);
                this.ctx.fillStyle = "#888888";
                this.ctx.textAlign = "center";
                this.ctx.textBaseline = "middle";
                this.ctx.font = "bold 12px sans-serif";
                this.ctx.fillText("Drop Audio", startX + pxWidth / 2, trackY + this.audioTrackHeight / 2);
            } else {
                this.drawAudioSegmentVisuals(this.ctx, seg, isSelected, trackY, this.audioTrackHeight, startX, pxWidth);
            }
            this.ctx.globalAlpha = 1.0;
        }

        // --- Draw Ruler & Divider AFTER segments to prevent overlap ---
        // Ruler Background
        this.ctx.fillStyle = "#1E1E1E";
        this.ctx.fillRect(0, 0, width, RULER_HEIGHT);

        // Crisp Ruler Text
        this.ctx.fillStyle = "#AAAAAA";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.font = "10px sans-serif";

        const frameRate = this.getFrameRate();
        const mode = this.displayModeWidget ? this.displayModeWidget.value : "seconds";

        // Define logical steps for both modes
        let steps;
        if (mode === "seconds") {
            steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
        } else {
            steps = [1, 2, 5, 10, 24, 48, 120, 240, 480, 960, 1920];
        }

        const minSpacingPx = 60;
        let majorStep = steps[steps.length - 1];
        for (let i = 0; i < steps.length; i++) {
            const stepFrames = mode === "seconds" ? steps[i] * frameRate : steps[i];
            const spacingPx = (stepFrames / totalFrames) * width;
            if (spacingPx >= minSpacingPx) {
                majorStep = steps[i];
                break;
            }
        }

        const majorStepFrames = mode === "seconds" ? majorStep * frameRate : majorStep;

        let minorStep;
        if (mode === "seconds") {
            if (majorStep <= 0.2) minorStep = majorStep / 2;
            else if (majorStep <= 1) minorStep = majorStep / 5;
            else if (majorStep <= 5) minorStep = 1;
            else if (majorStep <= 15) minorStep = 5;
            else if (majorStep <= 30) minorStep = 10;
            else if (majorStep <= 60) minorStep = 10;
            else minorStep = majorStep / 5;
        } else {
            if (majorStep <= 5) minorStep = 1;
            else if (majorStep <= 10) minorStep = 2;
            else if (majorStep <= 24) minorStep = 6;
            else if (majorStep <= 48) minorStep = 12;
            else minorStep = majorStep / 5;
        }
        const minorStepFrames = mode === "seconds" ? minorStep * frameRate : minorStep;

        this.ctx.fillStyle = "#444444";
        const totalMinorTicks = Math.floor(totalFrames / minorStepFrames);
        for (let i = 0; i <= totalMinorTicks; i++) {
            const frameVal = i * minorStepFrames;
            if (Math.abs(frameVal % majorStepFrames) < 0.1) continue;

            const x = (frameVal / totalFrames) * width;
            this.ctx.fillRect(Math.floor(x), RULER_HEIGHT - 3, 1, 3);
        }

        this.ctx.fillStyle = "#AAAAAA";
        const totalMajorTicks = Math.floor(totalFrames / majorStepFrames);
        for (let i = 0; i <= totalMajorTicks; i++) {
            const frameVal = i * majorStepFrames;
            const x = (frameVal / totalFrames) * width;

            this.ctx.fillStyle = "#AAAAAA";
            this.ctx.fillRect(Math.floor(x), RULER_HEIGHT - 6, 1, 6);

            if (frameVal > 0 && frameVal < totalFrames) {
                this.ctx.textAlign = "center";
                this.ctx.fillText(this.formatTime(frameVal, true), x, RULER_HEIGHT / 2);
            }
        }

        this.ctx.textAlign = "left";
        const zeroLabel = mode === "seconds" ? "0" : this.formatTime(0, true);
        this.ctx.fillText(zeroLabel, 4, RULER_HEIGHT / 2);

        // Divider
        this.ctx.fillStyle = "#333333";
        this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight, width, 1);

        // Draw gap "+" buttons
        if (!this._isDragging) {
            const BTN_R = 12;
            const gapRegions = this.getGapRegions();
            for (let i = 0; i < gapRegions.length; i++) {
                const gap = gapRegions[i];
                if (gap.widthPx < BTN_R * 2 + 8) continue;
                const hov = this._hoveredGapIdx === i;
                const BTN_W = 18;
                const BTN_H = 18;
                this.ctx.beginPath();
                this.ctx.roundRect(gap.centerX - BTN_W / 2, gap.centerY - BTN_H / 2, BTN_W, BTN_H, 4);
                this.ctx.fillStyle = hov ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.05)";
                this.ctx.fill();
                this.ctx.fillStyle = hov ? "#FFFFFF" : "#888888";
                this.ctx.font = "14px sans-serif";
                this.ctx.textAlign = "center";
                this.ctx.textBaseline = "middle";
                this.ctx.fillText("+", gap.centerX, gap.centerY + 1);
            }
        }

        // --- Out-of-duration shadow overlay ---
        const outputFrames = this.getDurationFrames();
        if (outputFrames < totalFrames) {
            const cutoffX = (outputFrames / totalFrames) * width;
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
            this.ctx.fillRect(cutoffX, RULER_HEIGHT, width - cutoffX, this.blockHeight + this.audioTrackHeight);
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
            this.ctx.fillRect(cutoffX, 0, width - cutoffX, RULER_HEIGHT);
        }
        // Dashed boundary line at the output duration cutoff
        // this.ctx.save();
        // this.ctx.strokeStyle = "rgba(255, 80, 80, 0.7)";
        // this.ctx.lineWidth = 1.5;
        // this.ctx.setLineDash([5, 4]);
        // this.ctx.beginPath();
        // this.ctx.moveTo(cutoffX, 0);
        // this.ctx.lineTo(cutoffX, CANVAS_HEIGHT);
        // this.ctx.stroke();
        // this.ctx.setLineDash([]);
        // this.ctx.restore();

        // ====================================================================
        // --- Render Relative Crop Shadow Overlay (Start + Duration) ---
        const renderStartSecs = this.renderStartSecondsWidget ? (parseFloat(this.renderStartSecondsWidget.value) || 0.0) : 0.0;
        const renderDurationSecs = this.renderDurationSecondsWidget ? (parseFloat(this.renderDurationSecondsWidget.value) || 0.0) : 0.0;

        const renderStartFrame = renderStartSecs * frameRate;
        const renderEndFrame = (renderDurationSecs > 0.0) ? ((renderStartSecs + renderDurationSecs) * frameRate) : this.getDurationFrames();

        if (renderStartFrame > 0 && renderStartFrame < totalFrames) {
            const maskX = (renderStartFrame / totalFrames) * width;
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
            this.ctx.fillRect(0, RULER_HEIGHT, maskX, this.blockHeight + this.audioTrackHeight);
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
            this.ctx.fillRect(0, 0, maskX, RULER_HEIGHT);
        }

        if (renderEndFrame < totalFrames) {
            const maskX = (renderEndFrame / totalFrames) * width;
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
            this.ctx.fillRect(maskX, RULER_HEIGHT, width - maskX, this.blockHeight + this.audioTrackHeight);
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
            this.ctx.fillRect(maskX, 0, width - maskX, RULER_HEIGHT);
        }

        this.ctx.save();
        this.ctx.lineWidth = 1.5;
        this.ctx.setLineDash([4, 4]);

        if (renderStartFrame > 0 && renderStartFrame < totalFrames) {
            const startX = (renderStartFrame / totalFrames) * width;
            this.ctx.strokeStyle = "rgba(255, 165, 0, 0.85)";
            this.ctx.beginPath();
            this.ctx.moveTo(startX, 0);
            this.ctx.lineTo(startX, height);
            this.ctx.stroke();
        }

        if (renderEndFrame < totalFrames) {
            const endX = (renderEndFrame / totalFrames) * width;
            this.ctx.strokeStyle = "rgba(255, 165, 0, 0.85)";
            this.ctx.beginPath();
            this.ctx.moveTo(endX, 0);
            this.ctx.lineTo(endX, height);
            this.ctx.stroke();
        }
        this.ctx.restore();
        // ====================================================================

        // --- Draw Playhead ---
        const playheadX = (this.currentFrame / totalFrames) * width;

        // Playhead Line
        this.ctx.beginPath();
        this.ctx.moveTo(playheadX, 14);
        this.ctx.lineTo(playheadX, this.canvasHeight);
        this.ctx.strokeStyle = "#FF4444";
        this.ctx.lineWidth = 1.5;
        this.ctx.stroke();

        // Playhead Handle (Polygon above numbers)
        this.ctx.fillStyle = "#FF4444";
        this.ctx.beginPath();
        this.ctx.moveTo(playheadX - 6, 0);
        this.ctx.lineTo(playheadX + 6, 0);
        this.ctx.lineTo(playheadX + 6, 8);
        this.ctx.lineTo(playheadX, 14);
        this.ctx.lineTo(playheadX - 6, 8);
        this.ctx.fill();

        // Draw vertical grab bar on the right edge of viewport for resizing width
        const grabBarW = 4;
        const grabBarH = 50;
        const grabBarX = this.viewport.scrollLeft + this.viewport.clientWidth - grabBarW - 3;
        const grabBarY = RULER_HEIGHT + (this.blockHeight + this.audioTrackHeight - grabBarH) / 2;

        this.ctx.fillStyle = "rgba(40, 40, 40, 0.6)";
        this.ctx.beginPath();
        this.ctx.roundRect(grabBarX, grabBarY, grabBarW, grabBarH, 2);
        this.ctx.fill();

        // Draw horizontal grab bar at the bottom of viewport for resizing height
        const hBarW = 50;
        const hBarH = 4;
        const hBarX = this.viewport.scrollLeft + (this.viewport.clientWidth - hBarW) / 2;
        const hBarY = this.canvasHeight - hBarH - 3; // 3px from the bottom edge

        this.ctx.fillStyle = "rgba(20, 20, 20, 0.8)";
        this.ctx.beginPath();
        this.ctx.roundRect(hBarX, hBarY, hBarW, hBarH, 2);
        this.ctx.fill();

        if (this._isDragging && this._floatingPreviewSeg && this._floatingPreviewSeg.videoEl) {
            const vid = this._floatingPreviewSeg.videoEl;
            if (vid.readyState >= 2) {
                const maxPh = Math.max(60, this.blockHeight - 20);
                const maxPw = 240;
                const videoRatio = (vid.videoWidth || 16) / (vid.videoHeight || 9);

                let ph = maxPh;
                let pw = Math.round(ph * videoRatio);

                if (pw > maxPw) {
                    pw = maxPw;
                    ph = Math.round(pw / videoRatio);
                }

                let drawX = 0;
                if (this._floatingPreviewEdge === "playhead") {
                    drawX = (this.currentFrame / totalFrames) * width - (pw / 2);
                } else {
                    const arr = this._previewSegments || this.timeline.segments;
                    const pSeg = arr.find(s => s.id === this._floatingPreviewSeg.id);
                    if (pSeg) {
                        if (this._floatingPreviewEdge === "start") drawX = (pSeg.start / totalFrames) * width - (pw / 2);
                        else if (this._floatingPreviewEdge === "end") drawX = ((pSeg.start + pSeg.length) / totalFrames) * width - (pw / 2);
                    }
                }

                drawX = clamp(drawX, 10, width - pw - 10);
                const drawY = RULER_HEIGHT + 10;

                this.ctx.save();
                this.ctx.shadowColor = "rgba(0,0,0,0.8)";
                this.ctx.shadowBlur = 8;
                this.ctx.lineWidth = 2;
                this.ctx.strokeStyle = "#38BDF8";
                this.ctx.strokeRect(drawX, drawY, pw, ph);
                this.ctx.shadowBlur = 0;
                this.ctx.drawImage(vid, drawX, drawY, pw, ph);

                this.ctx.fillStyle = "rgba(0,0,0,0.75)";
                this.ctx.fillRect(drawX, drawY + ph - 20, pw, 20);
                this.ctx.fillStyle = "#38BDF8";
                this.ctx.font = "bold 11px sans-serif";
                this.ctx.textAlign = "center";
                this.ctx.textBaseline = "middle";
                this.ctx.fillText("Source: " + vid.currentTime.toFixed(2) + "s", drawX + pw / 2, drawY + ph - 10);
                this.ctx.restore();
            }
        }

        this.updatePlayerUI();
    }

    drawAudioSegmentVisuals(ctx, seg, isSelected, yOffset, trackHeight, startX, pxWidth) {
        ctx.fillStyle = isSelected ? "#2A4A3A" : "#1A2A1A";
        ctx.fillRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

        if (seg.waveformPeaks && pxWidth > 0) {
            ctx.fillStyle = isSelected ? "rgba(100, 255, 100, 0.6)" : "rgba(100, 255, 100, 0.3)";
            const startRatio = seg.trimStart / seg.audioDurationFrames;
            const endRatio = (seg.trimStart + seg.length) / seg.audioDurationFrames;
            const peakCount = seg.waveformPeaks.length;
            const centerY = yOffset + trackHeight / 2;

            ctx.beginPath();
            for (let i = 0; i < pxWidth; i++) {
                const pixelRatio = i / pxWidth;
                const globalRatio = startRatio + pixelRatio * (endRatio - startRatio);
                const peakIdx = Math.floor(globalRatio * peakCount);

                if (peakIdx >= 0 && peakIdx < peakCount) {
                    const val = seg.waveformPeaks[peakIdx];
                    const amp = (val * (trackHeight - 12) / 2) * 0.9;
                    ctx.fillRect(startX + i, centerY - amp, 1, amp * 2);
                }
            }
        }

        ctx.strokeStyle = isSelected ? "#4FFF8F" : "#000000";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

        if (isSelected) {
            ctx.fillStyle = "#4FFF8F";
            ctx.beginPath();
            ctx.roundRect(startX, yOffset + trackHeight / 2 - 12, 4, 24, 2);
            ctx.fill();
            ctx.beginPath();
            ctx.roundRect(startX + pxWidth - 4, yOffset + trackHeight / 2 - 12, 4, 24, 2);
            ctx.fill();
        }

        ctx.fillStyle = "#CCCCCC";
        ctx.font = "11px sans-serif";
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        ctx.save();
        ctx.beginPath();
        ctx.rect(startX, yOffset + 2, pxWidth, trackHeight - 3);
        ctx.clip();

        let text = seg.fileName || "Audio Track";
        const maxWidth = pxWidth - 12;
        if (ctx.measureText(text).width > maxWidth && maxWidth > 0) {
            while (text.length > 0 && ctx.measureText(text + "...").width > maxWidth) {
                text = text.slice(0, -1);
            }
            text = text + "...";
        }

        ctx.fillText(text, startX + 6, yOffset + 8);
        ctx.restore();
    }

    // --- Interaction Logic ---
    getHitTest(mouseX, mouseY) {
        const width = this.canvas.offsetWidth;
        const totalFrames = this.getVisualDurationFrames();

        // Check Playhead Handle first
        const playheadX = (this.currentFrame / totalFrames) * width;
        if (mouseY <= 24 && Math.abs(mouseX - playheadX) <= 12) {
            return {type: "playhead"};
        }

        if (mouseY <= RULER_HEIGHT) {
            return {type: "ruler"};
        }

        if (mouseY < RULER_HEIGHT || mouseY > this.canvasHeight) return null;

        const isAudioTrack = mouseY > RULER_HEIGHT + this.blockHeight;
        const trackSegments = isAudioTrack ? this.timeline.audioSegments : this.timeline.segments;
        const trackType = isAudioTrack ? "audio" : "image";

        if (trackSegments.length === 0) return null;

        // The variables width and totalFrames are already declared above.

        let sortedSegments = [...trackSegments]
            .map((s, i) => ({...s, originalIndex: i}))
            .sort((a, b) => a.start - b.start);

        const HANDLE_CORE = 4;

        for (let i = 0; i < sortedSegments.length; i++) {
            const seg = sortedSegments[i];
            const startX = (seg.start / totalFrames) * width;
            const pxWidth = (seg.length / totalFrames) * width;
            const endX = startX + pxWidth;

            const prevSeg = sortedSegments[i - 1];
            const nextSeg = sortedSegments[i + 1];

            const isLeftJoint = prevSeg && prevSeg.start + prevSeg.length === seg.start;
            if (!isLeftJoint) {
                if (Math.abs(mouseX - startX) <= HANDLE_HIT_PX) {
                    return {type: "edge", index: seg.originalIndex, dir: "left", track: trackType};
                }
            }

            const isRightJoint = nextSeg && nextSeg.start === seg.start + seg.length;
            if (isRightJoint) {
                const dx = mouseX - endX;
                if (Math.abs(dx) <= HANDLE_HIT_PX) {
                    if (dx < -HANDLE_CORE) {
                        return {type: "edge", index: seg.originalIndex, dir: "right", track: trackType};
                    } else if (dx > HANDLE_CORE) {
                        return {type: "edge", index: nextSeg.originalIndex, dir: "left", track: trackType};
                    } else {
                        return {
                            type: "joint",
                            leftIndex: seg.originalIndex,
                            rightIndex: nextSeg.originalIndex,
                            track: trackType
                        };
                    }
                }
            } else {
                if (Math.abs(mouseX - endX) <= HANDLE_HIT_PX) {
                    return {type: "edge", index: seg.originalIndex, dir: "right", track: trackType};
                }
            }
        }

        for (let i = 0; i < sortedSegments.length; i++) {
            const seg = sortedSegments[i];
            const startX = (seg.start / totalFrames) * width;
            const pxWidth = (seg.length / totalFrames) * width;
            const endX = startX + pxWidth;

            if (mouseX >= startX && mouseX < endX) {
                return {type: "center", index: seg.originalIndex, track: trackType};
            }
        }

        return null;
    }

    onMouseDown(e) {
        if (e.button !== 0) return;
        const {x, y} = this.getMousePos(e);

        const isOverDivider = Math.abs(y - (RULER_HEIGHT + this.blockHeight)) <= 4;
        if (isOverDivider) {
            this._isDragging = true;
            this._dragType = "divider";
            this._startBlockHeight = this.blockHeight;
            this._startAudioTrackHeight = this.audioTrackHeight;
            this._startY = y;
            return;
        }

        const isAtBottom = Math.abs(y - this.canvasHeight) <= 15;
        if (isAtBottom) {
            this._isDragging = true;
            this._dragType = "height_resize";
            this._startBlockHeight = this.blockHeight;
            this._startY = y;
            document.body.style.userSelect = "none";
            return;
        }

        const viewRect = this.viewport.getBoundingClientRect();
        const isAtRightEdge = Math.abs(e.clientX - viewRect.right) <= 20;
        if (isAtRightEdge) {
            this._isDragging = true;
            this._dragType = "width_resize";
            this._startNodeWidth = this.node.size[0];
            this._startX = e.clientX;
            document.body.style.userSelect = "none";
            return;
        }

        if (y >= RULER_HEIGHT && y <= this.canvasHeight) {
            const BTN_R = 12;
            const gapRegions = this.getGapRegions();
            for (let i = 0; i < gapRegions.length; i++) {
                const gap = gapRegions[i];
                if (gap.widthPx < BTN_R * 2 + 8) continue;
                const dx = x - gap.centerX, dy2 = y - gap.centerY;
                if (dx * dx + dy2 * dy2 <= BTN_R * BTN_R) {
                    if (gap.track === "audio") {
                        // Direct to audio upload
                        this.promptAddAudioInGap(gap.frameStart, gap.frameEnd);
                    } else {
                        this.showGapMenu(e.clientX, e.clientY, gap);
                    }
                    return;
                }
            }
        }

        const hit = this.getHitTest(x, y);
        if (!hit) {
            // Only deselect if they clicked the same track but hit empty space
            const clickedTrack = y > RULER_HEIGHT + this.blockHeight ? "audio" : "image";
            if (this.selectionType === clickedTrack) {
                this.selectedIndex = -1;
                this.updateUIFromSelection();
            }
            this.render();
            return;
        }

        if (hit.type === "playhead" || hit.type === "ruler") {
            this._isDragging = true;
            this._dragType = "playhead";
            const logicalWidth = this.canvas.offsetWidth;
            const totalFrames = this.getVisualDurationFrames();
            let mouseFrameX = x * (totalFrames / logicalWidth);
            this.currentFrame = clamp(mouseFrameX, 0, totalFrames);
            this.render();
            if (this.isPlaying) {
                this.playAudio();
            }
            return;
        }

        this.selectionType = hit.track;
        const targetArray = hit.track === "audio" ? this.timeline.audioSegments : this.timeline.segments;

        if (hit.type === "joint") {
            this.selectedIndex = hit.leftIndex;
            this.updateUIFromSelection();
            this._dragType = "joint";
            this._dragTargetId = targetArray[hit.leftIndex].id;
            this._dragTargetIdRight = targetArray[hit.rightIndex].id;
        } else if (hit.type === "center") {
            this.selectedIndex = hit.index;
            this.updateUIFromSelection();
            this._dragType = "center";
        } else {
            if (this.selectedIndex !== hit.index) {
                this.selectedIndex = hit.index;
                this.updateUIFromSelection();
            }
            this._dragType = hit.dir;
        }

        this._isDragging = true;
        this._previewSegments = null;
        this._dragStartX = x;
        this._dragInitialTimeline = JSON.parse(JSON.stringify(targetArray));

        if (hit.type !== "joint") {
            this._dragTargetId = targetArray[hit.index].id;
        }
        this.render();
    }

    onMouseMove(e) {
        const {x: mouseX, y: mouseY} = this.getMousePos(e);

        if (!this._isDragging) {
            let newHoveredGapIdx = -1;
            const BTN_R = 12;
            const gapRegions = this.getGapRegions();
            for (let i = 0; i < gapRegions.length; i++) {
                const gap = gapRegions[i];
                if (gap.widthPx < BTN_R * 2 + 8) continue;
                const dx = mouseX - gap.centerX, dy2 = mouseY - gap.centerY;
                if (dx * dx + dy2 * dy2 <= BTN_R * BTN_R) {
                    newHoveredGapIdx = i;
                    break;
                }
            }
            if (this._hoveredGapIdx !== newHoveredGapIdx) {
                this._hoveredGapIdx = newHoveredGapIdx;
                this.render();
            }

            const isOverDivider = Math.abs(mouseY - (RULER_HEIGHT + this.blockHeight)) <= 4;
            const isAtBottom = Math.abs(mouseY - this.canvasHeight) <= 15;
            const viewRect = this.viewport.getBoundingClientRect();
            const isAtRightEdge = Math.abs(e.clientX - viewRect.right) <= 20;
            const hit = this.getHitTest(mouseX, mouseY);
            if (isOverDivider || isAtBottom) {
                this.canvas.style.cursor = "ns-resize";
            } else if (isAtRightEdge) {
                this.canvas.style.cursor = "ew-resize";
            } else if (newHoveredGapIdx >= 0) {
                this.canvas.style.cursor = "pointer";
            } else if (hit?.type === "edge") {
                this.canvas.style.cursor = "ew-resize";
            } else if (hit?.type === "joint") {
                this.canvas.style.cursor = "col-resize";
            } else if (hit?.type === "center") {
                this.canvas.style.cursor = "grab";
            } else if (hit?.type === "playhead") {
                this.canvas.style.cursor = "ew-resize";
            } else {
                this.canvas.style.cursor = "default";
            }
            return;
        }

        if (this._dragType === "divider") {
            this.canvas.style.cursor = "ns-resize";
            const deltaY = mouseY - this._startY;

            const minBlockH = 50;
            const minAudioH = 50;

            let newBlockHeight = this._startBlockHeight + deltaY;
            let newAudioTrackHeight = this._startAudioTrackHeight - deltaY;

            if (newBlockHeight < minBlockH) {
                newBlockHeight = minBlockH;
                newAudioTrackHeight = this._startBlockHeight + this._startAudioTrackHeight - minBlockH;
            }
            if (newAudioTrackHeight < minAudioH) {
                newAudioTrackHeight = minAudioH;
                newBlockHeight = this._startBlockHeight + this._startAudioTrackHeight - minAudioH;
            }

            this.blockHeight = newBlockHeight;
            this.audioTrackHeight = newAudioTrackHeight;

            this.render();
            return;
        }

        if (this._dragType === "height_resize") {
            this.canvas.style.cursor = "ns-resize";
            const deltaY = mouseY - this._startY;

            this.blockHeight = Math.max(100, this._startBlockHeight + deltaY);
            this.canvasHeight = this.rulerHeight + this.blockHeight + this.audioTrackHeight;

            this.canvas.style.height = `${this.canvasHeight}px`;

            this.resizeCanvas(this.canvas.offsetWidth);
            this.render();

            if (this.node && this.node.computeSize) {
                const sz = this.node.computeSize();
                this.node.size[1] = sz[1];
                if (window.app && window.app.graph) {
                    window.app.graph.setDirtyCanvas(true, true);
                }
            }
            return;
        }

        if (this._dragType === "width_resize") {
            this.canvas.style.cursor = "ew-resize";
            const deltaX = e.clientX - this._startX;

            this.node.size[0] = Math.max(300, this._startNodeWidth + deltaX);

            if (window.app && window.app.graph) {
                window.app.graph.setDirtyCanvas(true, true);
            }
            return;
        }

        if (this._dragType === "playhead") {
            this.canvas.style.cursor = "ew-resize";
            const logicalWidth = this.canvas.offsetWidth;
            const totalFrames = this.getVisualDurationFrames();
            let mouseFrameX = mouseX * (totalFrames / logicalWidth);
            this.currentFrame = clamp(mouseFrameX, 0, totalFrames);
            this._liveScrubPlayhead();
            this.render();
            if (this.isPlaying) {
                this.playAudio(); // Scrub (restart from new position)
            }
            return;
        }

        this.canvas.style.cursor = this._dragType === "center" ? "grabbing" :
            this._dragType === "joint" ? "col-resize" : "ew-resize";

        const logicalWidth = this.canvas.offsetWidth;
        const totalFrames = this.getVisualDurationFrames();
        const durationFrames = totalFrames;
        const dragDelta = Math.round((mouseX - this._dragStartX) * (totalFrames / logicalWidth));

        let t = JSON.parse(JSON.stringify(this._dragInitialTimeline));

        // --- Rolling Edit (Slide Edit) ---
        if (this._dragType === "joint") {
            let leftIdx = t.findIndex(s => s.id === this._dragTargetId);
            let rightIdx = t.findIndex(s => s.id === this._dragTargetIdRight);

            if (leftIdx >= 0 && rightIdx >= 0) {
                let origLeft = this._dragInitialTimeline.find(s => s.id === this._dragTargetId);
                let origRight = this._dragInitialTimeline.find(s => s.id === this._dragTargetIdRight);

                let maxDeltaRight = origRight.length - MIN_SEGMENT_LENGTH;
                let maxDeltaLeft = origLeft.length - MIN_SEGMENT_LENGTH;

                if (this.selectionType === "audio" || origRight.type === "video") {
                    // Drag LEFT: right clip extends left by un-trimming its head.
                    // Can only un-trim as much as the right clip has been trimmed (trimStart >= 0).
                    maxDeltaLeft = Math.min(maxDeltaLeft, origRight.trimStart || 0);
                }
                if (this.selectionType === "audio" || origLeft.type === "video") {
                    // Drag RIGHT: left clip extends right by consuming its remaining tail audio.
                    // Can only extend as far as the left clip's unplayed tail allows.
                    let origDur = origLeft.audioDurationFrames || origLeft.videoDurationFrames || origLeft.length;
                    let availLeftTail = origDur - ((origLeft.trimStart || 0) + origLeft.length);
                    maxDeltaRight = Math.min(maxDeltaRight, availLeftTail);
                }

                let safeDelta = clamp(dragDelta, -maxDeltaLeft, maxDeltaRight);

                t[leftIdx].length = origLeft.length + safeDelta;
                t[rightIdx].start = origRight.start + safeDelta;
                t[rightIdx].length = origRight.length - safeDelta;

                if (this.selectionType === "audio" || t[rightIdx].type === "video") {
                    t[rightIdx].trimStart = origRight.trimStart + safeDelta;
                }
            }
        }
        // --- Edge & Center Drags ---
        else {
            const targetIdx = t.findIndex((s) => s.id === this._dragTargetId);
            if (targetIdx < 0) return;

            if (this._dragType === "right") {
                let newLen = t[targetIdx].length + dragDelta;
                let maxPossibleLength = totalFrames - t[targetIdx].start;
                let nextSeg = t.find(s => s.start >= t[targetIdx].start + t[targetIdx].length && s.id !== t[targetIdx].id);
                if (nextSeg) {
                    maxPossibleLength = nextSeg.start - t[targetIdx].start;
                }

                if (this.selectionType === "audio" || t[targetIdx].type === "video") {
                    const origDur = t[targetIdx].audioDurationFrames || t[targetIdx].videoDurationFrames || t[targetIdx].length;
                    maxPossibleLength = Math.min(maxPossibleLength, origDur - (t[targetIdx].trimStart || 0));
                }

                t[targetIdx].length = Math.max(MIN_SEGMENT_LENGTH, Math.min(newLen, maxPossibleLength));

            } else if (this._dragType === "left") {
                let newStart = t[targetIdx].start + dragDelta;
                let minPossibleStart = 0;
                let prevSeg = t.slice().reverse().find(s => s.start + s.length <= t[targetIdx].start && s.id !== t[targetIdx].id);
                if (prevSeg) {
                    minPossibleStart = prevSeg.start + prevSeg.length;
                }

                if (this.selectionType === "audio" || t[targetIdx].type === "video") {
                    minPossibleStart = Math.max(minPossibleStart, t[targetIdx].start - (t[targetIdx].trimStart || 0));
                }

                let maxStart = t[targetIdx].start + t[targetIdx].length - MIN_SEGMENT_LENGTH;
                newStart = Math.max(minPossibleStart, Math.min(newStart, maxStart));

                let diff = newStart - t[targetIdx].start;
                t[targetIdx].start = newStart;
                t[targetIdx].length -= diff;
                if (this.selectionType === "audio" || t[targetIdx].type === "video") {
                    t[targetIdx].trimStart += diff;
                }

            } else if (this._dragType === "center") {
                let initT = this._dragInitialTimeline;
                let dIdx = initT.findIndex(s => s.id === this._dragTargetId);
                if (dIdx < 0) return;
                let D = JSON.parse(JSON.stringify(initT[dIdx]));

                let D_mouse_start = D.start + dragDelta;
                let mouseFrameX = mouseX * (totalFrames / logicalWidth);

                t = this._applyCenterDragPhysics(initT, D.id, D_mouse_start, mouseFrameX, durationFrames, totalFrames, logicalWidth);
            }
        }

        const targetArray = this.selectionType === "audio" ? this.timeline.audioSegments : this.timeline.segments;
        for (let ps of t) {
            const orig = targetArray.find(s => s.id === ps.id);
            if (orig) {
                ps.videoEl = orig.videoEl;
                ps.imgObj = orig.imgObj;
                if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
            }
        }

        if (this._dragType === "left") {
            this._liveScrubVideo(t.find(s => s.id === this._dragTargetId), "start");
        } else if (this._dragType === "right") {
            this._liveScrubVideo(t.find(s => s.id === this._dragTargetId), "end");
        } else if (this._dragType === "joint") {
            this._liveScrubVideo(t.find(s => s.id === this._dragTargetId), "end");
            this._liveScrubVideo(t.find(s => s.id === this._dragTargetIdRight), "start");
        }

        const syncSibling = (targetId, activeArray) => {
            if (!targetId) return;
            const isVid = targetId.endsWith("_v");
            const isAud = targetId.endsWith("_a");
            if (!isVid && !isAud) return;

            const siblingId = isVid ? targetId.slice(0, -2) + "_a" : targetId.slice(0, -2) + "_v";
            const siblingArray = isVid ? this.timeline.audioSegments : this.timeline.segments;
            const sibling = siblingArray.find(s => s.id === siblingId);
            const active = activeArray.find(s => s.id === targetId);

            if (sibling && active) {
                sibling.start = active.start;
                sibling.length = active.length;
                if (active.trimStart !== undefined) sibling.trimStart = active.trimStart;
            }
        };

        syncSibling(this._dragTargetId, t);
        if (this._dragType === "joint") syncSibling(this._dragTargetIdRight, t);

        this._previewSegments = t;
        this.updateUIFromSelection(); // Live update of trim values
        this.render();
    }

    _applyCenterDragPhysics(initT, D_id, D_mouse_start, mouseFrameX, durationFrames, totalFrames, logicalWidth) {
        let t_copy = JSON.parse(JSON.stringify(initT));
        let dIdx = t_copy.findIndex(s => s.id === D_id);
        if (dIdx < 0) return t_copy;

        let D = t_copy[dIdx];
        let D_clamped_start = clamp(D_mouse_start, 0, durationFrames - D.length);

        let baseSegments = t_copy.filter(s => s.id !== D.id);

        let insertIdx = baseSegments.length;
        for (let i = 0; i < baseSegments.length; i++) {
            let centerBase = baseSegments[i].start + baseSegments[i].length / 2;
            if (mouseFrameX < centerBase) {
                insertIdx = i;
                break;
            }
        }

        let leftBound = insertIdx > 0 ? baseSegments[insertIdx - 1].start + baseSegments[insertIdx - 1].length : 0;
        let rightBound = insertIdx < baseSegments.length ? baseSegments[insertIdx].start : durationFrames;

        if (rightBound - leftBound >= D.length) {
            D_clamped_start = clamp(D_clamped_start, leftBound, rightBound - D.length);
        } else {
            let gapCenter = (leftBound + rightBound) / 2;
            D_clamped_start = gapCenter - D.length / 2;
        }

        let t_test = [];
        for (let i = 0; i < insertIdx; i++) {
            t_test.push({...baseSegments[i], original_start: baseSegments[i].start});
        }
        t_test.push({...D, start: D_clamped_start, original_start: D_clamped_start});
        let D_index = insertIdx;

        for (let i = insertIdx; i < baseSegments.length; i++) {
            t_test.push({...baseSegments[i], original_start: baseSegments[i].start});
        }

        for (let i = D_index + 1; i < t_test.length; i++) {
            let prev = t_test[i - 1];
            t_test[i].start = Math.max(t_test[i].original_start, prev.start + prev.length);
        }

        for (let i = D_index - 1; i >= 0; i--) {
            let next = t_test[i + 1];
            t_test[i].start = Math.min(t_test[i].original_start, next.start - t_test[i].length);
        }

        let rightCursor = durationFrames;
        for (let i = t_test.length - 1; i >= 0; i--) {
            if (t_test[i].start + t_test[i].length > rightCursor) {
                t_test[i].start = rightCursor - t_test[i].length;
            }
            rightCursor = t_test[i].start;
        }
        let leftCursor = 0;
        for (let i = 0; i < t_test.length; i++) {
            if (t_test[i].start < leftCursor) {
                t_test[i].start = leftCursor;
            }
            leftCursor = t_test[i].start + t_test[i].length;
        }

        let result = t_test.map(s => {
            let clean = {...s};
            delete clean.original_start;
            return clean;
        });

        let draggedPreview = result.find(s => s.id === D.id);
        if (draggedPreview) {
            draggedPreview.resolvedStart = draggedPreview.start;
        }

        return result;
    }

    onMouseUp(e) {
        document.body.style.userSelect = "";
        this._floatingPreviewSeg = null;
        if (this._isDragging) {
            if (this._previewSegments) {
                const targetArray = this.selectionType === "audio" ? this.timeline.audioSegments : this.timeline.segments;

                const mappedArray = this._previewSegments.map(ps => {
                    const orig = targetArray.find(s => s.id === ps.id);
                    let finalStart = ps.resolvedStart !== undefined ? ps.resolvedStart : ps.start;
                    let newPs = {...ps, start: finalStart};
                    if (orig && orig.imgObj) newPs.imgObj = orig.imgObj;
                    if (orig && orig.videoEl) newPs.videoEl = orig.videoEl;
                    if (orig && orig.thumbnails) newPs.thumbnails = orig.thumbnails;
                    if (orig && orig._extractingThumbs !== undefined) newPs._extractingThumbs = orig._extractingThumbs;
                    delete newPs.resolvedStart;
                    return newPs;
                });

                if (this.selectionType === "audio") {
                    this.timeline.audioSegments = mappedArray;
                    if (this._dragTargetId) this.selectedIndex = this.timeline.audioSegments.findIndex(s => s.id === this._dragTargetId);
                } else {
                    this.timeline.segments = mappedArray;
                    if (this._dragTargetId) this.selectedIndex = this.timeline.segments.findIndex(s => s.id === this._dragTargetId);
                }

            }

            this._isDragging = false;
            this._previewSegments = null;
            this._ghostTrack = null;
            this.canvas.style.cursor = "default";
            this.commitChanges();
        }
    }

    // --- Backend Data Sync ---
    commitChanges(skipRender = false) {
        let sortedSegments = [...this.timeline.segments].sort((a, b) => a.start - b.start);
        let contiguousLengths = [];
        let contiguousPrompts = [];
        let currentCursor = 0;
        const durationFrames = this.getDurationFrames();

        // Build segment lengths clipped at the duration cutoff.
        // - Gaps before the first segment, or between segments, are absorbed into the adjacent
        //   segment's length (same as before), but are also clipped at durationFrames.
        // - Segments that start at or past the cutoff are excluded entirely.
        // - Segments that cross the cutoff are trimmed so their end = durationFrames exactly.
        let pendingGap = 0;
        for (let seg of sortedSegments) {
            // Skip segments entirely outside the duration.
            if (seg.start >= durationFrames) break;

            if (seg.start > currentCursor) {
                // Gap between the cursor and this segment — clip it at the cutoff too.
                const gapLength = Math.min(seg.start, durationFrames) - currentCursor;
                if (contiguousLengths.length > 0) {
                    contiguousLengths[contiguousLengths.length - 1] += gapLength;
                } else {
                    pendingGap += gapLength;
                }
            }

            // Clip segment end at the duration cutoff.
            const clippedEnd = Math.min(seg.start + seg.length, durationFrames);
            const clippedLength = clippedEnd - seg.start;

            contiguousLengths.push(clippedLength + pendingGap);
            contiguousPrompts.push(seg.prompt || "");
            pendingGap = 0;
            currentCursor = seg.start + seg.length; // advance by the real (unclipped) end for gap detection
        }

        // If segments don't fill to the end of the duration, pad the last segment to reach it.
        const clampedCursor = Math.min(currentCursor, durationFrames);
        if (contiguousLengths.length > 0 && clampedCursor < durationFrames) {
            contiguousLengths[contiguousLengths.length - 1] += durationFrames - clampedCursor;
        }

        const toSave = {
            segments: sortedSegments.map(s => {
                const {imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, ...rest} = s;
                return rest;
            }),
            audioSegments: (this.timeline.audioSegments || []).map(s => ({...s}))
        };

        const jsonStr = JSON.stringify(toSave);
        if (this.timelineDataWidget) this.timelineDataWidget.value = jsonStr;

        if (this.localPromptsWidget) {
            this.localPromptsWidget.value = contiguousPrompts.join(" | ");
        }
        if (this.segmentLengthsWidget) {
            this.segmentLengthsWidget.value = contiguousLengths.join(",");
        }

        if (this.guideStrengthWidget) {
            const imgStrengths = sortedSegments
                .filter(s => s.type !== "text")
                .map(s => (s.guideStrength !== undefined ? s.guideStrength : 1.0).toFixed(2));
            this.guideStrengthWidget.value = imgStrengths.join(",");
        }

        // Keep zoom slider max in sync with the current timeline duration.
        this.updateZoomSliderMax();

        setTimeout(() => {
            if (this.node && this.node.computeSize) {
                const sz = this.node.computeSize();
                this.node.size[1] = sz[1];
                if (app.graph) app.graph.setDirtyCanvas(true, true);
            }
        }, 0);

        if (!skipRender) this.render();
    }

    // --- Gap Region Calculation ---
    getGapRegions() {
        const totalFrames = this.getVisualDurationFrames();
        const outputFrames = this.getDurationFrames();
        const width = this.canvas.offsetWidth || this._lastWidth || 0;
        const gaps = [];
        if (!width) return gaps;

        // Image gaps
        let cursor = 0;
        const sortedImg = [...this.timeline.segments].sort((a, b) => a.start - b.start);
        for (const seg of sortedImg) {
            if (seg.start > cursor) {
                const x0 = (cursor / totalFrames) * width;
                const x1 = (seg.start / totalFrames) * width;
                gaps.push({
                    track: 'image',
                    frameStart: cursor,
                    frameEnd: seg.start,
                    centerX: (x0 + x1) / 2,
                    centerY: RULER_HEIGHT + this.blockHeight / 2,
                    widthPx: x1 - x0
                });
            }
            cursor = seg.start + seg.length;
        }
        if (cursor < outputFrames) {
            const x0 = (cursor / totalFrames) * width;
            const x1 = (outputFrames / totalFrames) * width;
            gaps.push({
                track: 'image',
                frameStart: cursor,
                frameEnd: outputFrames,
                centerX: (x0 + x1) / 2,
                centerY: RULER_HEIGHT + this.blockHeight / 2,
                widthPx: x1 - x0
            });
        }

        // Audio gaps
        cursor = 0;
        const sortedAud = [...this.timeline.audioSegments].sort((a, b) => a.start - b.start);
        for (const seg of sortedAud) {
            if (seg.start > cursor) {
                const x0 = (cursor / totalFrames) * width;
                const x1 = (seg.start / totalFrames) * width;
                gaps.push({
                    track: 'audio',
                    frameStart: cursor,
                    frameEnd: seg.start,
                    centerX: (x0 + x1) / 2,
                    centerY: RULER_HEIGHT + this.blockHeight + this.audioTrackHeight / 2,
                    widthPx: x1 - x0
                });
            }
            cursor = seg.start + seg.length;
        }
        if (cursor < outputFrames) {
            const x0 = (cursor / totalFrames) * width;
            const x1 = (outputFrames / totalFrames) * width;
            gaps.push({
                track: 'audio',
                frameStart: cursor,
                frameEnd: outputFrames,
                centerX: (x0 + x1) / 2,
                centerY: RULER_HEIGHT + this.blockHeight + this.audioTrackHeight / 2,
                widthPx: x1 - x0
            });
        }

        return gaps;
    }

    promptAddAudioInGap(frameStart, frameEnd) {
        const fi = document.createElement("input");
        fi.type = "file";
        fi.accept = "audio/*";
        fi.addEventListener("change", (ev) => {
            if (ev.target.files?.[0]) this.handleAudioUpload([ev.target.files[0]], frameStart);
        });
        fi.click();
    }

    // --- Context Menu ---
    onContextMenu(e) {
        e.preventDefault();
        e.stopPropagation(); // <--- This hides the ComfyUI menu!
        e.stopImmediatePropagation(); // <--- Safety net to guarantee it dies here
        const {x: mouseX, y: mouseY} = this.getMousePos(e);

        const trackHeight = this.blockHeight;
        const isAudioTrack = mouseY >= RULER_HEIGHT + trackHeight && mouseY <= RULER_HEIGHT + trackHeight + this.audioTrackHeight;
        const isImageTrack = mouseY >= RULER_HEIGHT && mouseY <= RULER_HEIGHT + trackHeight;

        const logicalWidth = this.canvas.offsetWidth || 1;
        const totalFrames = this.getVisualDurationFrames();
        const cursor = mouseX * (totalFrames / logicalWidth);

        let clickedSeg = null;
        let trackType = "";

        if (isAudioTrack) {
            clickedSeg = this.timeline.audioSegments.find(s => cursor >= s.start && cursor <= s.start + s.length);
            trackType = "audio";
        } else if (isImageTrack) {
            clickedSeg = this.timeline.segments.find(s => cursor >= s.start && cursor <= s.start + s.length);
            trackType = clickedSeg ? clickedSeg.type : "";
        }

        if (clickedSeg) {
            this.showContextMenu(e.clientX, e.clientY, clickedSeg, trackType);
        } else if (isAudioTrack || isImageTrack) {
            const gapRegions = this.getGapRegions();
            const currentTrack = isAudioTrack ? "audio" : "image";
            let gap = gapRegions.find(g => cursor >= g.frameStart && cursor <= g.frameEnd && g.track === currentTrack);

            if (!gap) {
                const startFrame = Math.round(cursor);
                gap = {
                    track: currentTrack,
                    frameStart: startFrame,
                    frameEnd: startFrame + Math.max(1, this.getFrameRate())
                };
            }
            gap.clickedFrame = cursor;

            this.showGapContextMenu(e.clientX, e.clientY, gap);
        }
    }

    showContextMenu(clientX, clientY, seg, trackType) {
        this.dismissContextMenu();
        const menu = document.createElement("div");
        menu.className = "pr-gap-menu";
        menu.style.left = `${clientX + 6}px`;
        menu.style.top = `${clientY - 10}px`;

        const isImage = trackType !== "audio" && trackType !== "text" && seg.imageB64;

        if (isImage) {
            const copyBtn = document.createElement("button");
            copyBtn.className = "pr-gap-menu-btn";
            copyBtn.innerHTML = `Copy Image`;
            copyBtn.onclick = async () => {
                try {
                    const res = await fetch(seg.imageB64);
                    const blob = await res.blob();
                    await navigator.clipboard.write([new ClipboardItem({[blob.type]: blob})]);
                } catch (err) {
                    console.error(PluginName, "Failed to copy image", err);
                }
                this.dismissContextMenu();
            };
            menu.appendChild(copyBtn);

            const saveBtn = document.createElement("button");
            saveBtn.className = "pr-gap-menu-btn";
            saveBtn.innerHTML = `Save Image`;
            saveBtn.onclick = () => {
                const a = document.createElement("a");
                a.href = seg.imageB64;
                a.download = "timeline_image.jpg";
                a.click();
                this.dismissContextMenu();
            };
            menu.appendChild(saveBtn);

            const openBtn = document.createElement("button");
            openBtn.className = "pr-gap-menu-btn";
            openBtn.innerHTML = `Open Image in New Tab`;
            openBtn.onclick = () => {
                const win = window.open();
                if (win) {
                    win.document.write(`<body style="margin:0;display:flex;justify-content:center;align-items:center;background:#0e0e0e;height:100vh;"><img style="max-width:100%;max-height:100%;" src="${seg.imageB64}" /></body>`);
                    win.document.close();
                }
                this.dismissContextMenu();
            };
            menu.appendChild(openBtn);

        }

        if (trackType !== "audio") {
            const copyPromptBtn = document.createElement("button");
            copyPromptBtn.className = "pr-gap-menu-btn";
            copyPromptBtn.innerHTML = `Copy Prompt`;
            copyPromptBtn.onclick = async () => {
                try {
                    await navigator.clipboard.writeText(seg.prompt || "");
                } catch (err) {
                    console.error(PluginName, "Failed to copy prompt", err);
                }
                this.dismissContextMenu();
            };
            menu.appendChild(copyPromptBtn);

            const genPromptBtn = document.createElement("button");
            genPromptBtn.className = "pr-gap-menu-btn";
            genPromptBtn.innerHTML = `✨ Generate Prompt`;
            genPromptBtn.onclick = () => {
                this.dismissContextMenu();
                const segIndex = this.timeline.segments.findIndex(s => s.id === seg.id);
                if (segIndex !== -1) {
                    this.generatePrompts(this._generatePromptsBtn, segIndex);
                }
            };
            menu.appendChild(genPromptBtn);
        }

        const copySegBtn = document.createElement("button");
        copySegBtn.className = "pr-gap-menu-btn";
        copySegBtn.innerHTML = `Copy Segment`;
        copySegBtn.onclick = () => {
            this._copiedSegment = {...seg, id: Date.now().toString() + Math.random().toString(36).substr(2, 5)};
            this._copiedSegmentTrack = trackType === "audio" ? "audio" : "image";
            this.dismissContextMenu();
        };
        menu.appendChild(copySegBtn);

        const isVidLink = trackType === "video" && seg.id.endsWith("_v");
        const isAudLink = trackType === "audio" && seg.id.endsWith("_a");
        let siblingForUnlink = null;

        if (isVidLink) {
            siblingForUnlink = this.timeline.audioSegments.find(s => s.id === seg.id.slice(0, -2) + "_a");
        } else if (isAudLink) {
            siblingForUnlink = this.timeline.segments.find(s => s.id === seg.id.slice(0, -2) + "_v");
        }

        if (siblingForUnlink) {
            const unlinkBtn = document.createElement("button");
            unlinkBtn.className = "pr-gap-menu-btn";
            unlinkBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="12" x2="16" y2="12"></line></svg> Unlink Media`;
            unlinkBtn.onclick = () => {
                seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
                siblingForUnlink.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
                this.commitChanges();
                this.render();
                this.dismissContextMenu();
            };
            menu.appendChild(unlinkBtn);
        }

        const currentTrack = trackType === "audio" ? "audio" : "image";
        if (this._copiedSegment && this._copiedSegmentTrack === currentTrack) {
            const pasteReplaceBtn = document.createElement("button");
            pasteReplaceBtn.className = "pr-gap-menu-btn";
            pasteReplaceBtn.innerHTML = `Paste & Replace`;
            pasteReplaceBtn.onclick = () => {
                const newSeg = {
                    ...this._copiedSegment,
                    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                    start: seg.start,
                    length: this._copiedSegment.length
                };
                const targetArray = currentTrack === "audio" ? this.timeline.audioSegments : this.timeline.segments;
                const idx = targetArray.findIndex(s => s.id === seg.id);
                if (idx >= 0) targetArray[idx] = newSeg;
                this.commitChanges();
                this.dismissContextMenu();
            };
            menu.appendChild(pasteReplaceBtn);
        }

        const delBtn = document.createElement("button");
        delBtn.className = "pr-gap-menu-btn";
        delBtn.innerHTML = `Delete`;
        delBtn.style.color = "#FF4444";
        delBtn.onclick = () => {
            this.selectionType = trackType === "audio" ? "audio" : "image";
            const list = trackType === "audio" ? this.timeline.audioSegments : this.timeline.segments;
            this.selectedIndex = list.findIndex(s => s.id === seg.id);
            this.deleteSelectedSegment();
            this.dismissContextMenu();
        };
        menu.appendChild(delBtn);

        document.body.appendChild(menu);
        this._contextMenu = menu;

        setTimeout(() => {
            this._contextMenuDismisser = (ev) => {
                if (!menu.contains(ev.target)) this.dismissContextMenu();
            };
            document.addEventListener("pointerdown", this._contextMenuDismisser, true);
        }, 0);
    }

    showGapContextMenu(clientX, clientY, gap) {
        this.dismissContextMenu();
        const menu = document.createElement("div");
        menu.className = "pr-gap-menu";
        menu.style.left = `${clientX + 6}px`;
        menu.style.top = `${clientY - 10}px`;

        const currentTrack = gap.track === "audio" ? "audio" : "image";

        if (this._copiedSegment && this._copiedSegmentTrack === currentTrack) {
            const pasteBtn = document.createElement("button");
            pasteBtn.className = "pr-gap-menu-btn";
            pasteBtn.innerHTML = `Paste Segment`;
            pasteBtn.onclick = () => {
                const startFrame = Math.round(gap.clickedFrame !== undefined ? gap.clickedFrame : gap.frameStart);
                const gapLength = gap.frameEnd - startFrame;

                const newSeg = {
                    ...this._copiedSegment,
                    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                    start: startFrame,
                    length: Math.min(this._copiedSegment.length, gapLength)
                };
                const targetArray = currentTrack === "audio" ? this.timeline.audioSegments : this.timeline.segments;
                targetArray.push(newSeg);
                targetArray.sort((a, b) => a.start - b.start);
                this.commitChanges();
                this.dismissContextMenu();
            };
            menu.appendChild(pasteBtn);
        }

        if (currentTrack === "image") {
            const textBtn = document.createElement("button");
            textBtn.className = "pr-gap-menu-btn";
            textBtn.innerHTML = `${ICONS.text} Text Segment`;
            textBtn.onclick = () => {
                this.addSegmentInGap(gap.frameStart, gap.frameEnd, "text");
                this.dismissContextMenu();
            };
            menu.appendChild(textBtn);

            const imgBtn = document.createElement("button");
            imgBtn.className = "pr-gap-menu-btn";
            imgBtn.innerHTML = `${ICONS.upload} Image Segment`;
            imgBtn.onclick = () => {
                this.dismissContextMenu();
                const fi = document.createElement("input");
                fi.type = "file";
                fi.accept = "image/*";
                fi.addEventListener("change", (ev) => {
                    if (ev.target.files?.[0]) {
                        const gapLength = gap.frameEnd - gap.frameStart;
                        this.handleImageUpload([ev.target.files[0]], gap.frameStart, gapLength);
                    }
                });
                fi.click();
            };
            menu.appendChild(imgBtn);

            const vidBtn = document.createElement("button");
            vidBtn.className = "pr-gap-menu-btn";
            vidBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> Video Segment`;
            vidBtn.onclick = () => {
                this.dismissContextMenu();
                const fi = document.createElement("input");
                fi.type = "file";
                fi.accept = "video/*";
                fi.addEventListener("change", (ev) => {
                    if (ev.target.files?.[0]) this.handleVideoUpload([ev.target.files[0]], gap.frameStart);
                });
                fi.click();
            };
            menu.appendChild(vidBtn);
        }

        document.body.appendChild(menu);
        this._contextMenu = menu;
        setTimeout(() => {
            this._contextMenuDismisser = (ev) => {
                if (!menu.contains(ev.target)) this.dismissContextMenu();
            };
            document.addEventListener("pointerdown", this._contextMenuDismisser, true);
        }, 0);
    }

    dismissContextMenu() {
        if (this._contextMenu) {
            this._contextMenu.remove();
            this._contextMenu = null;
        }
        if (this._contextMenuDismisser) {
            document.removeEventListener("pointerdown", this._contextMenuDismisser, true);
            this._contextMenuDismisser = null;
        }
    }

    // --- Gap Popup Menu ---
    showGapMenu(clientX, clientY, gap) {
        this.dismissGapMenu();
        const menu = document.createElement("div");
        menu.className = "pr-gap-menu";
        menu.style.left = `${clientX + 6}px`;
        menu.style.top = `${clientY - 10}px`;

        const textBtn = document.createElement("button");
        textBtn.className = "pr-gap-menu-btn";
        textBtn.innerHTML = `${ICONS.text} Text Segment`;
        textBtn.addEventListener("click", () => {
            this.addSegmentInGap(gap.frameStart, gap.frameEnd, "text");
            this.dismissGapMenu();
        });

        const imgBtn = document.createElement("button");
        imgBtn.className = "pr-gap-menu-btn";
        imgBtn.innerHTML = `${ICONS.upload} Image Segment`;
        imgBtn.addEventListener("click", () => {
            this.dismissGapMenu();
            const fi = document.createElement("input");
            fi.type = "file";
            fi.accept = "image/*";
            fi.addEventListener("change", (ev) => {
                if (ev.target.files?.[0]) {
                    const gapLength = gap.frameEnd - gap.frameStart;
                    this.handleImageUpload([ev.target.files[0]], gap.frameStart, gapLength);
                }
            });
            fi.click();
        });

        const vidBtn = document.createElement("button");
        vidBtn.className = "pr-gap-menu-btn";
        vidBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> Video Segment`;
        vidBtn.addEventListener("click", () => {
            this.dismissGapMenu();
            const fi = document.createElement("input");
            fi.type = "file";
            fi.accept = "video/*";
            fi.addEventListener("change", (ev) => {
                if (ev.target.files?.[0]) {
                    this.handleVideoUpload([ev.target.files[0]], gap.frameStart);
                }
            });
            fi.click();
        });

        menu.appendChild(textBtn);
        menu.appendChild(imgBtn);
        menu.appendChild(vidBtn);
        const currentTrack = gap.track === "audio" ? "audio" : "image";
        if (this._copiedSegment && this._copiedSegmentTrack === currentTrack) {
            const pasteBtn = document.createElement("button");
            pasteBtn.className = "pr-gap-menu-btn";
            pasteBtn.innerHTML = `Paste Segment`;
            pasteBtn.onclick = () => {
                const gapLength = gap.frameEnd - gap.frameStart;

                let finalLength = Math.min(this._copiedSegment.length, gapLength);
                if (currentTrack === "image") {
                    finalLength = gapLength;
                }

                const newSeg = {
                    ...this._copiedSegment,
                    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                    start: gap.frameStart,
                    length: finalLength
                };
                const targetArray = currentTrack === "audio" ? this.timeline.audioSegments : this.timeline.segments;
                targetArray.push(newSeg);
                targetArray.sort((a, b) => a.start - b.start);
                this.commitChanges();
                this.dismissGapMenu();
            };
            menu.appendChild(pasteBtn);
        }

        document.body.appendChild(menu);
        this._gapMenu = menu;
        setTimeout(() => {
            this._gapMenuDismisser = (ev) => {
                if (!menu.contains(ev.target)) this.dismissGapMenu();
            };
            document.addEventListener("pointerdown", this._gapMenuDismisser, true);
        }, 0);
    }

    // --- Settings Menu ---

    dismissGapMenu() {
        if (this._gapMenu) {
            this._gapMenu.remove();
            this._gapMenu = null;
        }
        if (this._gapMenuDismisser) {
            document.removeEventListener("pointerdown", this._gapMenuDismisser, true);
            this._gapMenuDismisser = null;
        }
    }

    // Hide all settings widgets on the node (called on init).
    hideSettingsWidgets() {
        for (const name of this._settingsWidgetNames) {
            const w = this.node.widgets?.find(w => w.name === name);
            if (w) hideWidget(w);

            // Also remove corresponding input slot if it exists and is NOT connected
            // to prevent overlapping issues in classic ComfyUI (nodes v1)
            if (this.node.inputs) {
                const inputIdx = this.node.inputs.findIndex(i => i.name === name);
                if (inputIdx !== -1) {
                    const input = this.node.inputs[inputIdx];
                    if (input.link == null) {
                        this.node.removeInput(inputIdx);
                    }
                }
            }
        }
        this.updateWidgetVisibility();

        // Workaround: toggle display mode to force ComfyUI to refresh the node
        if (this.displayModeWidget) {
            const origVal = this.displayModeWidget.value;
            const otherVal = origVal === "frames" ? "seconds" : "frames";

            this.displayModeWidget.value = otherVal;
            if (this.displayModeWidget.callback) this.displayModeWidget.callback(otherVal);

            this.displayModeWidget.value = origVal;
            if (this.displayModeWidget.callback) this.displayModeWidget.callback(origVal);
        }
    }

    // Restore all settings widgets on the node.
    showSettingsWidgets() {
        for (const name of this._settingsWidgetNames) {
            const w = this.node.widgets?.find(w => w.name === name);
            if (!w) continue;

            const typeMap = {
                display_mode: "combo", epsilon: "FLOAT", divisible_by: "INT",
                img_compression: "INT",
            };
            w.type = typeMap[name] || w._origType || "number";
            w.hidden = false;
            if (w.options) w.options.hidden = false;
            delete w.computeSize;
            if (w.element) w.element.style.display = "";
        }
        this.updateWidgetVisibility();

        // Workaround: toggle display mode to force ComfyUI to refresh the node
        if (this.displayModeWidget) {
            const origVal = this.displayModeWidget.value;
            const otherVal = origVal === "frames" ? "seconds" : "frames";

            this.displayModeWidget.value = otherVal;
            if (this.displayModeWidget.callback) this.displayModeWidget.callback(otherVal);

            this.displayModeWidget.value = origVal;
            if (this.displayModeWidget.callback) this.displayModeWidget.callback(origVal);
        }
    }

    _makeSettingRow(label, inputEl) {
        const row = document.createElement("div");
        row.className = "pr-settings-row";
        const lbl = document.createElement("span");
        lbl.className = "pr-settings-label";
        lbl.textContent = label;
        row.appendChild(lbl);
        row.appendChild(inputEl);
        return row;
    }

    showSettingsMenu(anchorEl) {
        this.dismissSettingsMenu();
        const menu = document.createElement("div");
        menu.className = "pr-settings-menu";

        // Title & Close Button Container
        const titleContainer = document.createElement("div");
        titleContainer.className = "pr-settings-title";
        titleContainer.style.display = "flex";
        titleContainer.style.justifyContent = "space-between";
        titleContainer.style.alignItems = "center";

        const titleText = document.createElement("span");
        titleText.textContent = "Timeline Settings";
        titleContainer.appendChild(titleText);

        const closeBtn = document.createElement("button");
        closeBtn.className = "pr-settings-close-btn";
        closeBtn.innerHTML = ICONS.close;
        closeBtn.title = "Close Settings";
        closeBtn.addEventListener("click", () => this.dismissSettingsMenu());
        titleContainer.appendChild(closeBtn);

        menu.appendChild(titleContainer);

        // Helper: fire a widget's callback safely
        const fireCallback = (w, val) => {
            w.value = val;
            if (w.callback) {
                try {
                    w.callback(val, app.canvas, this.node, null, null);
                } catch (e) {
                }
            }
            if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
        };

        // --- Display Mode ---
        const dmWidget = this.node.widgets?.find(w => w.name === "display_mode");
        if (dmWidget) {
            const ctrl = document.createElement("div");
            ctrl.className = "pr-segmented-control";

            const framesSeg = document.createElement("div");
            framesSeg.className = "pr-segment";
            framesSeg.textContent = "Frames";

            const secondsSeg = document.createElement("div");
            secondsSeg.className = "pr-segment";
            secondsSeg.textContent = "Seconds";

            const updateActive = (val) => {
                if (val === "frames") {
                    framesSeg.classList.add("active");
                    secondsSeg.classList.remove("active");
                } else {
                    secondsSeg.classList.add("active");
                    framesSeg.classList.remove("active");
                }
            };

            updateActive(dmWidget.value);

            const onSegClick = (val) => {
                fireCallback(dmWidget, val);
                updateActive(val);
                // Update ruler/timecode immediately
                if (this.updateWidgetVisibility) this.updateWidgetVisibility();
                if (this.updateUIFromSelection) this.updateUIFromSelection();
                this.render();
            };

            framesSeg.addEventListener("click", () => onSegClick("frames"));
            secondsSeg.addEventListener("click", () => onSegClick("seconds"));

            ctrl.appendChild(secondsSeg);
            ctrl.appendChild(framesSeg);

            menu.appendChild(this._makeSettingRow("Display Mode", ctrl));
        }

        const divider1 = document.createElement("hr");
        divider1.className = "pr-settings-divider";
        menu.appendChild(divider1);

        // Helper to create scrubbable number control with horizontal buttons
        const createScrubbableNumberControl = (w, step, min, max, isFloat = false) => {
            const container = document.createElement("div");
            container.className = "pr-number-control";

            const decBtn = document.createElement("button");
            decBtn.className = "pr-number-btn";
            decBtn.textContent = "-";

            const inp = document.createElement("input");
            inp.type = "number";
            inp.className = "pr-settings-input";
            inp.value = w.value;
            inp.step = step.toString();
            inp.min = min.toString();
            inp.max = max.toString();

            const incBtn = document.createElement("button");
            incBtn.className = "pr-number-btn";
            incBtn.textContent = "+";

            decBtn.addEventListener("click", () => {
                let val = parseFloat(inp.value) - step;
                if (val < min) val = min;
                inp.value = isFloat ? val.toFixed(4) : Math.round(val);
                fireCallback(w, parseFloat(inp.value));
            });

            incBtn.addEventListener("click", () => {
                let val = parseFloat(inp.value) + step;
                if (val > max) val = max;
                inp.value = isFloat ? val.toFixed(4) : Math.round(val);
                fireCallback(w, parseFloat(inp.value));
            });

            inp.addEventListener("change", () => {
                let val = parseFloat(inp.value);
                if (isNaN(val)) val = w.value;
                if (val < min) val = min;
                if (val > max) val = max;
                inp.value = isFloat ? val.toFixed(4) : Math.round(val);
                fireCallback(w, parseFloat(inp.value));
            });

            // Dragging logic
            let isDragging = false;
            let startX = 0;
            let startVal = 0;
            let hasMoved = false;

            inp.style.cursor = "ew-resize";

            inp.addEventListener("mousedown", (e) => {
                startX = e.clientX;
                startVal = parseFloat(inp.value);
                hasMoved = false;

                const onMouseMove = (moveEvent) => {
                    const deltaX = moveEvent.clientX - startX;
                    if (Math.abs(deltaX) > 3) {
                        hasMoved = true;
                        isDragging = true;
                    }

                    if (isDragging) {
                        moveEvent.preventDefault();
                        const sensitivity = isFloat ? 0.001 : 0.5;
                        let newVal = startVal + deltaX * sensitivity;

                        if (newVal < min) newVal = min;
                        if (newVal > max) newVal = max;

                        inp.value = isFloat ? newVal.toFixed(4) : Math.round(newVal);
                        fireCallback(w, parseFloat(inp.value));
                    }
                };

                const onMouseUp = () => {
                    document.removeEventListener("mousemove", onMouseMove);
                    document.removeEventListener("mouseup", onMouseUp);

                    if (!hasMoved) {
                        inp.focus();
                        inp.select();
                    }
                    isDragging = false;
                };

                document.addEventListener("mousemove", onMouseMove);
                document.addEventListener("mouseup", onMouseUp);
            });

            container.appendChild(decBtn);
            container.appendChild(inp);
            container.appendChild(incBtn);

            return container;
        };

        // --- Epsilon ---
        const epsWidget = this.node.widgets?.find(w => w.name === "epsilon");
        if (epsWidget) {
            menu.appendChild(this._makeSettingRow("Epsilon", createScrubbableNumberControl(epsWidget, 0.0001, 0.0001, 0.99, true)));
        }

        // --- Divisible By ---
        const divByWidget = this.node.widgets?.find(w => w.name === "divisible_by");
        if (divByWidget) {
            menu.appendChild(this._makeSettingRow("Divisible By", createScrubbableNumberControl(divByWidget, 1, 1, 256, false)));
        }

        // --- Img Compression ---
        const compWidget = this.node.widgets?.find(w => w.name === "img_compression");
        if (compWidget) {
            menu.appendChild(this._makeSettingRow("Img Compression", createScrubbableNumberControl(compWidget, 1, 0, 100, false)));
        }

        // --- Global Prompt Toggle ---
        const globalPromptWidget = this.node.widgets?.find(w => w.name === "global_prompt");
        if (globalPromptWidget) {
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = !(globalPromptWidget.options && globalPromptWidget.options.hidden);
            cb.style.cursor = "pointer";
            cb.addEventListener("change", () => {
                const isVisible = cb.checked;
                if (!globalPromptWidget.options) globalPromptWidget.options = {};
                globalPromptWidget.options.hidden = !isVisible;

                if (isVisible) {
                    delete globalPromptWidget.computeSize;
                    globalPromptWidget.hidden = false;
                    if (globalPromptWidget.element) globalPromptWidget.element.style.display = "";
                } else {
                    globalPromptWidget.computeSize = () => [0, 0];
                    globalPromptWidget.hidden = true;
                    if (globalPromptWidget.element) globalPromptWidget.element.style.display = "none";
                }

                // Force refresh via display mode double-toggle trick
                if (this.displayModeWidget) {
                    const origVal = this.displayModeWidget.value;
                    const otherVal = origVal === "frames" ? "seconds" : "frames";
                    this.displayModeWidget.value = otherVal;
                    if (this.displayModeWidget.callback) this.displayModeWidget.callback(otherVal);
                    this.displayModeWidget.value = origVal;
                    if (this.displayModeWidget.callback) this.displayModeWidget.callback(origVal);
                }
            });
            menu.appendChild(this._makeSettingRow("Use Global Prompt", cb));
        }


        // --- VLM Prompt Writer Config ---
        const vlmDivider = document.createElement("hr");
        vlmDivider.className = "pr-settings-divider";
        menu.appendChild(vlmDivider);

        const vlmTitle = document.createElement("div");
        vlmTitle.className = "pr-vlm-section-title";
        vlmTitle.textContent = "Prompt Writer (Qwen2.5-VL)";
        menu.appendChild(vlmTitle);

        const vlmCfg = _getVlmConfig();

        // Enable toggle
        const enabledCb = document.createElement("input");
        enabledCb.type = "checkbox";
        enabledCb.checked = vlmCfg.enabled;
        enabledCb.style.cursor = "pointer";
        enabledCb.addEventListener("change", () => {
            const c = _getVlmConfig();
            c.enabled = enabledCb.checked;
            _setVlmConfig(c);
            if (this._generatePromptsBtn) {
                this._generatePromptsBtn.disabled = !c.enabled;
                this._generatePromptsBtn.title = c.enabled
                    ? "Generate prompts for all image segments using Qwen2.5-VL. Configure in Settings (⚙️)."
                    : "Prompt Writer is disabled. Enable it in Settings (⚙️).";
            }
        });
        menu.appendChild(this._makeSettingRow("Enable Prompt Writer", enabledCb));

        // Vision model dropdown
        const modelSel = document.createElement("select");
        modelSel.className = "pr-settings-field pr-select";
        const vlmModelOptions = [
            "Qwen2.5-VL-3B — Fast",
            "Qwen2.5-VL-7B — Best quality",
        ];
        vlmModelOptions.forEach(opt => {
            const o = document.createElement("option");
            o.value = opt;
            o.textContent = opt;
            if (opt === vlmCfg.model_name) o.selected = true;
            modelSel.appendChild(o);
        });
        modelSel.addEventListener("change", () => {
            const c = _getVlmConfig();
            c.model_name = modelSel.value;
            _setVlmConfig(c);
        });
        menu.appendChild(this._makeSettingRow("Vision Model", modelSel));

        // Temperature
        const tempInput = document.createElement("input");
        tempInput.type = "number";
        tempInput.className = "pr-settings-field pr-number-input";
        tempInput.min = 0;
        tempInput.max = 2;
        tempInput.step = 0.05;
        tempInput.value = vlmCfg.temperature;
        tempInput.addEventListener("change", () => {
            const c = _getVlmConfig();
            c.temperature = parseFloat(tempInput.value) ?? 0.3;
            _setVlmConfig(c);
        });
        menu.appendChild(this._makeSettingRow("Temperature", tempInput));

        // Max tokens
        const maxTokInput = document.createElement("input");
        maxTokInput.type = "number";
        maxTokInput.className = "pr-settings-field pr-number-input";
        maxTokInput.min = 32;
        maxTokInput.max = 512;
        maxTokInput.step = 1;
        maxTokInput.value = vlmCfg.max_tokens;
        maxTokInput.addEventListener("change", () => {
            const c = _getVlmConfig();
            c.max_tokens = parseInt(maxTokInput.value) || 180;
            _setVlmConfig(c);
        });
        menu.appendChild(this._makeSettingRow("Max Tokens", maxTokInput));

        // Offline mode
        const offlineCb = document.createElement("input");
        offlineCb.type = "checkbox";
        offlineCb.checked = vlmCfg.offline_mode;
        offlineCb.style.cursor = "pointer";
        offlineCb.addEventListener("change", () => {
            const c = _getVlmConfig();
            c.offline_mode = offlineCb.checked;
            _setVlmConfig(c);
        });
        menu.appendChild(this._makeSettingRow("Offline Mode", offlineCb));

        // Local model path
        const localPathInput = document.createElement("input");
        localPathInput.type = "text";
        localPathInput.className = "pr-settings-field pr-text-input";
        localPathInput.value = vlmCfg.local_path;
        localPathInput.placeholder = "Dir with config.json (HF), dir with .gguf, or .gguf file path";
        localPathInput.addEventListener("change", () => {
            const c = _getVlmConfig();
            c.local_path = localPathInput.value.trim();
            _setVlmConfig(c);
        });
        menu.appendChild(this._makeSettingRow("Local Path", localPathInput));

        // mmproj path (for GGUF vision models — auto-detected if left empty)
        const mmProjInput = document.createElement("input");
        mmProjInput.type = "text";
        mmProjInput.className = "pr-settings-field pr-select";
        mmProjInput.value = vlmCfg.mmproj_path;
        mmProjInput.placeholder = "mmproj .gguf — auto-detected from Local Path dir";
        mmProjInput.addEventListener("change", () => {
            const c = _getVlmConfig();
            c.mmproj_path = mmProjInput.value.trim();
            _setVlmConfig(c);
        });
        menu.appendChild(this._makeSettingRow("mmproj Path", mmProjInput));

        // --- Style Directives ---
        const styleDivider = document.createElement("hr");
        styleDivider.className = "pr-settings-divider";
        menu.appendChild(styleDivider);

        const styleTitle = document.createElement("div");
        styleTitle.className = "pr-vlm-section-title";
        styleTitle.textContent = "Style Directives";
        menu.appendChild(styleTitle);

        const _makeVlmSelect = (options, currentVal, key) => {
            const sel = document.createElement("select");
            sel.className = "pr-settings-field pr-select";
            options.forEach(opt => {
                const o = document.createElement("option");
                o.value = opt;
                o.textContent = opt;
                if (opt === currentVal) o.selected = true;
                sel.appendChild(o);
            });
            sel.addEventListener("change", () => {
                const c = _getVlmConfig();
                c[key] = sel.value;
                _setVlmConfig(c);
            });
            return sel;
        };

        // Style Preset — options loaded dynamically from Python STYLE_PRESETS dict
        const presetRow = this._makeSettingRow("Style Preset", (() => {
            const sel = document.createElement("select");
            sel.className = "pr-settings-field  pr-select";
            const _fillPresetSel = (names) => {
                sel.innerHTML = "";
                names.forEach(opt => {
                    const o = document.createElement("option");
                    o.value = opt;
                    o.textContent = opt;
                    if (opt === vlmCfg.style_preset) o.selected = true;
                    sel.appendChild(o);
                });
            };
            // Populate from server; fall back to a minimal list on error
            api.fetchApi("/whatdreamscost/style_presets")
                .then(r => r.json())
                .then(d => {
                    if (d.presets?.length) _fillPresetSel(d.presets);
                })
                .catch(() => _fillPresetSel(["None — let VLM decide"]));
            sel.addEventListener("change", () => {
                const c = _getVlmConfig();
                c.style_preset = sel.value;
                _setVlmConfig(c);
            });
            return sel;
        })());
        menu.appendChild(presetRow);

        menu.appendChild(this._makeSettingRow("Shot Angle", _makeVlmSelect(SHOT_ANGLES, vlmCfg.shot_angle, "shot_angle")));

        menu.appendChild(this._makeSettingRow("Camera Movement", _makeVlmSelect(CAMERA_MOVEMENTS, vlmCfg.camera_move, "camera_move")));

        const styleExtraInput = document.createElement("input");
        styleExtraInput.type = "text";
        styleExtraInput.className = "pr-settings-field pr-text-input";
        styleExtraInput.value = vlmCfg.style_extra;
        styleExtraInput.placeholder = "e.g. warm golden light, shallow DOF";
        styleExtraInput.addEventListener("change", () => {
            const c = _getVlmConfig();
            c.style_extra = styleExtraInput.value.trim();
            _setVlmConfig(c);
        });
        menu.appendChild(this._makeSettingRow("Extra Instruction", styleExtraInput));

        // --- Show/Hide on Node Toggle ---
        const toggleBtn = document.createElement("button");
        toggleBtn.className = "pr-settings-toggle-btn";
        const widgetsVisible = !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
        toggleBtn.textContent = widgetsVisible ? "Hide Widgets on Node" : "Show Widgets on Node";
        toggleBtn.addEventListener("click", () => {
            const nowVisible = !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
            if (nowVisible) {
                this.hideSettingsWidgets();
                toggleBtn.textContent = "Show Widgets on Node";
            } else {
                this.showSettingsWidgets();
                toggleBtn.textContent = "Hide Widgets on Node";
            }
        });
        menu.appendChild(toggleBtn);

        // Position the menu below the anchor button (pop down)
        document.body.appendChild(menu);
        const rect = anchorEl.getBoundingClientRect();
        const menuW = menu.offsetWidth || 230;
        const menuH = menu.offsetHeight || 350;
        let left = rect.right - menuW;
        let top = rect.bottom + 6;
        if (left < 4) left = 4;
        // Fallback to top if it overflows the bottom of the screen
        if (top + menuH > window.innerHeight - 4) {
            top = rect.top - menuH - 6;
        }
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;

        this._settingsMenu = menu;
        setTimeout(() => {
            this._settingsDismisser = (ev) => {
                if (!menu.contains(ev.target) && !anchorEl.contains(ev.target)) this.dismissSettingsMenu();
            };
            document.addEventListener("mousedown", this._settingsDismisser);
        }, 0);
    }

    dismissSettingsMenu() {
        if (this._settingsMenu) {
            this._settingsMenu.remove();
            this._settingsMenu = null;
        }
        if (this._settingsDismisser) {
            document.removeEventListener("mousedown", this._settingsDismisser);
            this._settingsDismisser = null;
        }
    }


    async generatePrompts(btn, targetIndex = -1) {
        const cfg = _getVlmConfig();

        if (!cfg.enabled) {
            alert("Prompt Writer is disabled.\nEnable it in Settings (⚙️) → Prompt Writer section.");
            return;
        }

        const validSections = this.timeline.segments.filter(s => {
            if (s.type === "text" || s.type === "video") return true;
            return s.type === "image" || s.imageB64 || s.imageFile;
        });

        if (validSections.length === 0) {
            alert("No valid segments found on the timeline.\nAdd media or text first, then click Generate Prompts.");
            return;
        }

        const targetCount = targetIndex === -1 ? validSections.length : 1;
        const origHTML = btn.innerHTML;

        // 1. Create the AbortController for this request
        this._promptAbortController = new AbortController();
        const signal = this._promptAbortController.signal;

        const setGeneratingState = (isGenerating, isError = false, isAborted = false) => {
            btn.disabled = isGenerating;
            if (isGenerating) {
                if (this.loadingOverlay) {
                    // 2. Add an Abort button to the overlay UI
                    this.loadingOverlay.innerHTML = `
                               <div class="pr-spinner"></div>
                               <div style="margin-bottom: 12px;">✨ Analyzing ${targetCount} clip${targetCount > 1 ? 's' : ''} with Vision Model...</div>
                               <button id="pr-abort-btn" class="pr-btn pr-btn-danger">Cancel</button>
                           `;
                    this.loadingOverlay.style.display = "flex";

                    // 3. Attach a click event to trigger the abort
                    const abortBtn = this.loadingOverlay.querySelector("#pr-abort-btn");
                    if (abortBtn) {
                        abortBtn.addEventListener("click", () => {
                            if (this._promptAbortController) {
                                this._promptAbortController.abort();
                            }
                        });
                    }
                }
                this.promptInput.disabled = true;
            } else {
                if (this.loadingOverlay) this.loadingOverlay.style.display = "none";
                this.promptInput.disabled = false;

                // Update button text based on exit state
                if (isAborted) btn.innerHTML = "⏹ Aborted";
                else if (isError) btn.innerHTML = "✗ Error";
            }
        };

        setGeneratingState(true);

        try {
            const globalPromptWidget = this.node.widgets?.find(w => w.name === "global_prompt");
            const globalPrompt = globalPromptWidget?.value || "";

            const payload = {
                segments: this.timeline.segments.map((s, idx) => {
                    const isTarget = targetIndex === -1 || targetIndex === idx;
                    return {
                        imageB64: isTarget ? (s.imageB64 || null) : null,
                        imageFile: isTarget ? (s.imageFile || null) : null,
                        hint: s.hint || "",
                        prompt: s.prompt || "",
                        type: isTarget ? (s.type || "image") : "text",
                    };
                }),
                global_prompt: globalPrompt,
                model_name: cfg.model_name,
                temperature: cfg.temperature,
                max_tokens: cfg.max_tokens,
                offline_mode: cfg.offline_mode,
                local_path: cfg.local_path,
                mmproj_path: cfg.mmproj_path,
                style_preset: cfg.style_preset,
                shot_angle: cfg.shot_angle,
                camera_move: cfg.camera_move,
                style_extra: cfg.style_extra,
            };

            const resp = await api.fetchApi("/whatdreamscost/generate_prompts", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(payload),
                signal: signal // 4. Pass the abort signal to the fetch request
            });

            const data = await resp.json();
            if (!resp.ok || data.error) throw new Error(data.error || `Server error ${resp.status}`);

            const prompts = data.prompts || [];
            let filled = 0;

            prompts.forEach((p, i) => {
                if (i < this.timeline.segments.length && p) {
                    this.timeline.segments[i].prompt = p;
                    if (this.timeline.segments[i].type !== "text" && (this.timeline.segments[i].imageB64 || this.timeline.segments[i].imageFile)) {
                        filled++;
                    }
                }
            });

            if (this.selectionType === "image" && this.selectedIndex >= 0 && this.selectedIndex < this.timeline.segments.length) {
                this.promptInput.value = this.timeline.segments[this.selectedIndex].prompt || "";
            }

            this.commitChanges();
            this.render();

            setGeneratingState(false);
            btn.innerHTML = `✓ ${filled} done`;

            setTimeout(() => {
                btn.innerHTML = origHTML;
            }, 2500);

        } catch (e) {
            // 5. Catch the AbortError specifically to prevent throwing a nasty alert
            if (e.name === 'AbortError') {
                console.log(PluginName, "Prompt generation aborted by user.");
                setGeneratingState(false, false, true); // sets isAborted = true

                setTimeout(() => {
                    btn.innerHTML = origHTML;
                    btn.disabled = false;
                }, 2000);

                return;
            }

            setGeneratingState(false, true);

            setTimeout(() => {
                btn.innerHTML = origHTML;
                btn.disabled = false;
            }, 3000);

            alert(`Prompt generation failed:\n\n${e.message}`);
        } finally {
            // 6. Clean up the controller
            this._promptAbortController = null;
        }
    }

    addSegmentInGap(frameStart, frameEnd, type = "text") {
        const seg = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            start: frameStart, length: frameEnd - frameStart,
            prompt: "", type,
        };
        this.timeline.segments.push(seg);
        this.timeline.segments.sort((a, b) => a.start - b.start);
        this.selectionType = "image";
        this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);
        this.updateUIFromSelection();
        this.commitChanges();
    }

    addTextSegmentFreeSpace() {
        const frameRate = this.getFrameRate();
        const newLength = Math.max(1, frameRate); // 1 second default
        const sorted = [...this.timeline.segments].sort((a, b) => a.start - b.start);
        let newStart = 0;
        for (const seg of sorted) {
            if (newStart + newLength <= seg.start) break;
            newStart = Math.max(newStart, seg.start + seg.length);
        }
        // Place the segment at the first free slot in the visual timeline (no output duration change).
        const durationFrames = this.getVisualDurationFrames();
        const seg = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            start: newStart, length: Math.min(newLength, Math.max(newLength, durationFrames - newStart)),
            prompt: "", type: "text",
        };
        this.timeline.segments.push(seg);
        this.timeline.segments.sort((a, b) => a.start - b.start);
        this.selectionType = "image";
        this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);
        this.updateUIFromSelection();
        this.commitChanges();
    }

    // --- Audio Player Engine ---
    updatePlayerUI() {
        if (!this.playBtn || !this.loopBtn) return;
        this.playBtn.innerHTML = this.isPlaying ? ICONS.pause : ICONS.play;
        if (this.isLooping) {
            this.loopBtn.classList.add("active");
        } else {
            this.loopBtn.classList.remove("active");
        }
        if (this.seekBar) {
            this.seekBar.max = this.getVisualDurationFrames();
            this.seekBar.value = this.currentFrame;
        }
        if (this.timeCodeDisplay) {
            this.timeCodeDisplay.textContent = this.formatTime(this.currentFrame);
        }
    }

    togglePlay() {
        if (this.isPlaying) {
            this.pauseAudio();
        } else {
            if (this.currentFrame >= this.getVisualDurationFrames()) {
                this.currentFrame = 0;
            }
            this.playAudio();
        }
    }

    toggleLoop() {
        this.isLooping = !this.isLooping;
        this.updatePlayerUI();
    }

    async playAudio() {
        this.pauseAudio(true); // clear any existing playback, but don't suspend context if scrubbing

        this._playCounter = (this._playCounter || 0) + 1;
        const playId = this._playCounter;
        this._currentPlayId = playId;
        this.isPlaying = true;

        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state !== 'running') {
            try {
                await this.audioContext.resume();
            } catch (e) {
            }
        }
        if (this._currentPlayId !== playId || !this.isPlaying) return;

        this.updatePlayerUI();

        const frameRate = this.getFrameRate();
        this.playbackStartFrame = this.currentFrame;
        this.playbackStartTime = this.audioContext.currentTime;

        // Decode and schedule all audio segments that happen AT or AFTER currentFrame
        for (let seg of this.timeline.audioSegments) {
            const segStartFrame = seg.start;
            const segEndFrame = seg.start + seg.length;

            if (segEndFrame <= this.currentFrame) continue;

            try {
                // Build audio buffer: fetch from server URL if audioFile is set, otherwise fall back to audioB64
                let audioBuffer;
                if (seg.audioFile) {
                    const audioUrl = api.apiURL(`/view?filename=${encodeURIComponent(seg.audioFile.split("/").pop())}&type=input&subfolder=${encodeURIComponent(seg.audioFile.includes("/") ? seg.audioFile.split("/").slice(0, -1).join("/") : "")}`);
                    const resp = await fetch(audioUrl);
                    const arrayBuffer = await resp.arrayBuffer();
                    audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
                } else if (seg.audioB64) {
                    const binaryString = window.atob(seg.audioB64);
                    const len = binaryString.length;
                    const bytes = new Uint8Array(len);
                    for (let i = 0; i < len; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    audioBuffer = await this.audioContext.decodeAudioData(bytes.buffer);
                } else {
                    continue;
                }
                if (this._currentPlayId !== playId || !this.isPlaying) return;

                const framesToSkipInSegment = Math.max(0, this.currentFrame - segStartFrame);
                const waitFrames = Math.max(0, segStartFrame - this.currentFrame);
                const waitTimeSec = waitFrames / frameRate;

                const fileOffsetFrames = seg.trimStart + framesToSkipInSegment;
                const fileOffsetSec = fileOffsetFrames / frameRate;

                const playDurationFrames = seg.length - framesToSkipInSegment;
                const playDurationSec = playDurationFrames / frameRate;

                if (playDurationSec <= 0) continue;

                const bufferNode = this.audioContext.createBufferSource();
                bufferNode.buffer = audioBuffer;
                bufferNode["connect"](this.audioContext.destination);

                const startTime = this.audioContext.currentTime + waitTimeSec;
                bufferNode.start(startTime, fileOffsetSec, playDurationSec);

                this.activeAudioNodes.push(bufferNode);
            } catch (err) {
                console.error(PluginName, "Playback decode error for segment:", err);
            }
        }

        if (this._currentPlayId !== playId || !this.isPlaying) return;

        const loop = () => {
            if (!this.isPlaying || this._currentPlayId !== playId) return;

            const elapsedSec = this.audioContext.currentTime - this.playbackStartTime;
            const elapsedFrames = elapsedSec * frameRate;

            this.currentFrame = this.playbackStartFrame + elapsedFrames;

            const visualDurationFrames = this.getVisualDurationFrames();
            const durationFrames = this.getDurationFrames();

            if (this.isLooping) {
                const loopBound = (this.playbackStartFrame >= durationFrames) ? visualDurationFrames : durationFrames;
                if (this.currentFrame >= loopBound) {
                    this.currentFrame = 0;
                    this.playAudio(); // Restart playback
                    return;
                }
            } else {
                if (this.currentFrame >= visualDurationFrames) {
                    this.currentFrame = visualDurationFrames;
                    this.pauseAudio();
                    this.render();
                    return;
                }
            }

            this.render();
            this._playLoopId = requestAnimationFrame(loop);
        };

        this._playLoopId = requestAnimationFrame(loop);
    }

    pauseAudio(isScrubbing = false) {
        this.isPlaying = false;
        this._currentPlayId = null;

        if (!isScrubbing && this.audioContext && this.audioContext.state === 'running') {
            try {
                this.audioContext.suspend();
            } catch (e) {
            }
        }

        for (let node of this.activeAudioNodes) {
            try {
                node.stop();
            } catch (e) {
            }
            try {
                node.disconnect();
            } catch (e) {
            }
        }
        this.activeAudioNodes = [];

        if (this._playLoopId) {
            cancelAnimationFrame(this._playLoopId);
            this._playLoopId = null;
        }
        this.updatePlayerUI();
    }
}

// --- Node Registration Hooks ---
const APPENDED_WIDGET_DEFAULTS = [
    ["timeline_data", "{}"],
    ["local_prompts", ""],
    ["segment_lengths", ""],
];
try {
    app.registerExtension({
        name: "LTXDirector",
        async beforeRegisterNodeDef(nodeType, nodeData, app) {
            if (nodeData.name === "LTXDirector") {
                const onNodeCreated = nodeType.prototype.onNodeCreated;
                nodeType.prototype.onNodeCreated = function () {
                    if (onNodeCreated) onNodeCreated.apply(this, arguments);

                    for (const [name, def] of APPENDED_WIDGET_DEFAULTS) {
                        if (!this.widgets?.find(w => w.name === name)) {
                            this.addWidget("string", name, def, () => {
                            });
                        }
                    }
                    for (const w of this.widgets) {
                        if (HIDDEN_WIDGET_NAMES.includes(w.name)) hideWidget(w);
                    }

                    // Set default width to be wider on creation (approx 2.5x default ~220px)
                    this.size[0] = 1000;

                    // Force default for img_compression if not set (ComfyUI sometimes skips optional defaults)
                    const compWidget = this.widgets?.find(w => w.name === "img_compression");
                    if (compWidget && (compWidget.value === undefined || compWidget.value === null || compWidget.value === 0)) {
                        compWidget.value = 18;
                    }
                    // Hide global prompt by default on creation without destroying its DOM element
                    const globalPromptWidget = this.widgets?.find(w => w.name === "global_prompt");
                    if (globalPromptWidget) {
                        if (!globalPromptWidget.options) globalPromptWidget.options = {};
                        globalPromptWidget.options.hidden = true;
                        globalPromptWidget.hidden = true;
                        globalPromptWidget.computeSize = () => [0, 0];
                        setTimeout(() => {
                            if (globalPromptWidget.element) globalPromptWidget.element.style.display = "none";
                        }, 0);
                    }

                    const container = document.createElement("div");
                    const widget = this.addDOMWidget("timeline_ui", "timeline_ui", container, {
                        getValue: () => "",
                        setValue: () => {
                        },
                    });

                    widget.computeSize = function (width) {
                        const canvasH = self._timelineEditor ? self._timelineEditor.canvasHeight : CANVAS_HEIGHT;
                        return [width, canvasH + 235];
                    };

                    const self = this;
                    setTimeout(() => {
                        try {
                            self._timelineEditor = new TimelineEditor(self, container, widget);
                        } catch (err) {
                            console.error(PluginName, "[PromptRelay] timeline editor init failed:", err);
                        }
                    }, 0);
                };

                const onRemoved = nodeType.prototype.onRemoved;
                nodeType.prototype.onRemoved = function () {
                    this._timelineEditor?.destroy();
                    return onRemoved?.apply(this, arguments);
                };

                const onConfigure = nodeType.prototype.onConfigure;
                nodeType.prototype.onConfigure = function (info) {
                    const out = onConfigure?.apply(this, arguments);
                    for (const [name, def] of APPENDED_WIDGET_DEFAULTS) {
                        const w = this.widgets.find(x => x.name === name);
                        if (w && (w.value == null || w.value === "")) w.value = def;
                    }

                    setTimeout(() => {
                        if (this._timelineEditor) {
                            this._timelineEditor.timeline = parseInitial(this._timelineEditor.timelineDataWidget?.value);
                            this._timelineEditor.loadMedia();
                            this._timelineEditor.selectionType = "image";
                            this._timelineEditor.selectedIndex = clamp(
                                this._timelineEditor.selectedIndex, -1,
                                Math.max(-1, this._timelineEditor.timeline.segments.length - 1)
                            );
                            this._timelineEditor.updateUIFromSelection();
                            this._timelineEditor.render();
                        }
                    }, 0);
                    return out;
                };
            }
        },
    });
} catch (err) {
    // Silently ignore the "already registered" error caused by Vite HMR / Double loading
    if (err.message && err.message.includes("already registered")) {
        console.warn(PluginName, "LTXDirector extension already registered (HMR or duplicate load). Skipping.");
    } else {
        console.error(PluginName, "Failed to register LTXDirector:", err);
    }
}
