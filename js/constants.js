export const PluginName = "[💭 WhatDreamsCost]"
// --- UI Constants & Configuration ---
export const RULER_HEIGHT = 24;
export const BLOCK_HEIGHT = 160; // Increased to make the image timeline area much taller
export const AUDIO_TRACK_HEIGHT = 80;
export const CANVAS_HEIGHT = RULER_HEIGHT + BLOCK_HEIGHT + AUDIO_TRACK_HEIGHT;
export const HANDLE_HIT_PX = 14;
export const MIN_SEGMENT_LENGTH = 6;
export const MAX_THUMBNAIL_DIM = 512; // Increased to maintain quality for taller images

export const HIDDEN_WIDGET_NAMES = ["timeline_data", "local_prompts", "segment_lengths", "guide_strength", "audio_data", "audio_mode"];

export const AudioMode = Object.freeze({
    GENERATE: "Generate From Scratch",
    TEMPLATE: "Template (Audio2Audio)",
    PRESERVE: "Preserve (Inpaint Gaps)"
});

export const SHOT_ANGLES = [
    "None — let VLM decide",
    "Wide shot",
    "Medium shot",
    "Close-up",
    "Extreme close-up",
    "Aerial / Bird's eye",
    "Low angle",
    "Over the shoulder",
    "POV",
]

export const CAMERA_MOVEMENTS = [
    "None — let VLM decide",
    "Static",
    "Slow dolly in",
    "Slow dolly out",
    "Gentle pan left",
    "Gentle pan right",
    "Tilt up",
    "Tilt down",
    "Tracking shot",
    "Handheld",
    "Crane / Boom up",
    "Circular orbit",
]
