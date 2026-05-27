import base64
import io as _io
import json
import logging
import math
import os
from enum import StrEnum

import av
import comfy.model_management
import folder_paths
import numpy as np
import torch
import torch.nn.functional as F
from comfy_api.latest import io
from PIL import Image

from .patches import apply_patches, detect_model_type
from .prompt_relay import (
    build_segments,
    create_mask_fn,
    distribute_segment_lengths,
    get_raw_tokenizer,
    map_token_indices,
    )

log = logging.getLogger(__name__)

# Custom socket type shared with LTXSequencer
GuideData = io.Custom("GUIDE_DATA")


class AudioMode(StrEnum):
    GENERATE = "Generate From Scratch"
    TEMPLATE = "Template (Audio2Audio)"
    PRESERVE = "Preserve (Inpaint Gaps)"


def _load_image_tensor(seg: dict) -> torch.Tensor:
    """Decode an image from the ComfyUI input folder (if imageFile provided) or fallback to base64
    to a ComfyUI-style image tensor of shape [1, H, W, 3], float32 in [0, 1]."""
    if seg.get("imageFile"):
        file_path = os.path.join(
                folder_paths.get_input_directory(), seg["imageFile"],
                )
        if os.path.exists(file_path):
            img = Image.open(file_path).convert("RGB")
            arr = np.array(img, dtype=np.float32) / 255.0
            return torch.from_numpy(arr).unsqueeze(0)

    b64_str = seg.get("imageB64", "")
    if not b64_str or b64_str.startswith("/view?"):
        return torch.zeros((1, 512, 512, 3), dtype=torch.float32)

    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]

    try:
        img_bytes = base64.b64decode(b64_str)
        img = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
        arr = np.array(img, dtype=np.float32) / 255.0
        return torch.from_numpy(arr).unsqueeze(0)
    except:
        return torch.zeros((1, 512, 512, 3), dtype=torch.float32)


def _load_video_tensor(seg: dict, frame_rate: float) -> torch.Tensor:
    """Extracts a sequence of frames from a video file based on the segment's trim parameters,
    and returns them as an [N, H, W, 3] float32 tensor."""
    file_path = os.path.join(
            folder_paths.get_input_directory(), seg.get("imageFile", ""),
            )

    if not os.path.exists(file_path):
        return torch.zeros((1, 512, 512, 3), dtype=torch.float32)

    trim_start_frames = float(seg.get("trimStart", 0))
    length_frames = float(seg.get("length", 1))
    start_sec = trim_start_frames / frame_rate

    frames = []
    try:
        with av.open(file_path) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"

            # Seek slightly before target to hit a keyframe
            if stream.time_base:
                seek_pts = int(
                        (max(0, start_sec - 0.5)) / float(stream.time_base),
                        )
            else:
                seek_pts = int((max(0, start_sec - 0.5)) * av.time_base)

            container.seek(seek_pts, stream=stream, backward=True)

            for frame in container.decode(stream):
                frame_time = frame.time
                if (
                        frame_time is None
                        and frame.pts is not None
                        and stream.time_base
                ):
                    frame_time = float(frame.pts * stream.time_base)

                if frame_time is None:
                    frame_time = 0.0

                if frame_time < start_sec - 0.01:
                    continue

                frames.append(frame.to_ndarray(format="rgb24"))

                if len(frames) >= int(length_frames):
                    break
    except Exception as e:
        log.warning(f"[PromptRelay] Video extract error: {e}")

    if not frames:
        return torch.zeros((1, 512, 512, 3), dtype=torch.float32)

    frames_np = np.array(frames, dtype=np.float32) / 255.0
    return torch.from_numpy(frames_np)


def _resize_image(
        tensor: torch.Tensor,
        target_w: int,
        target_h: int,
        method: str,
        divisible_by: int = 32,
        ) -> torch.Tensor:
    """Resize an [N, H, W, 3] float32 tensor to target dimensions using the given method,
    then snap the final dimensions to be divisible by `divisible_by`."""

    divisible_by = (
            int(divisible_by)
            if isinstance(divisible_by, (int, float)) and divisible_by > 0
            else 32
    )

    def snap(val, div):
        return max(div, (val // div) * div)

    tw = snap(target_w, divisible_by)
    th = snap(target_h, divisible_by)

    N, H, W, C = tensor.shape
    if H == th and W == tw:
        return tensor

    t_nchw = tensor.permute(0, 3, 1, 2)

    if method == "stretch to fit":
        resized = F.interpolate(
                t_nchw, size=(th, tw), mode="bilinear", align_corners=False,
                )

    elif method == "maintain aspect ratio":
        ratio = min(tw / W, th / H)
        new_w = snap(int(W * ratio), divisible_by)
        new_h = snap(int(H * ratio), divisible_by)
        resized = F.interpolate(
                t_nchw, size=(new_h, new_w), mode="bilinear", align_corners=False,
                )

    elif method == "pad":
        ratio = min(tw / W, th / H)
        new_w = snap(int(W * ratio), divisible_by)
        new_h = snap(int(H * ratio), divisible_by)
        inner = F.interpolate(
                t_nchw, size=(new_h, new_w), mode="bilinear", align_corners=False,
                )

        pad_l = (tw - new_w) // 2
        pad_t = (th - new_h) // 2
        resized = F.pad(
                inner,
                (pad_l, tw - new_w - pad_l, pad_t, th - new_h - pad_t),
                mode="constant",
                value=0,
                )

    elif method == "crop":
        ratio = max(tw / W, th / H)
        new_w = int(W * ratio)
        new_h = int(H * ratio)
        inner = F.interpolate(
                t_nchw, size=(new_h, new_w), mode="bilinear", align_corners=False,
                )

        left = (new_w - tw) // 2
        top = (new_h - th) // 2
        resized = inner[:, :, top: top + th, left: left + tw]

    else:
        resized = F.interpolate(
                t_nchw, size=(th, tw), mode="bilinear", align_corners=False,
                )

    return resized.permute(0, 2, 3, 1)


def _compress_image(tensor: torch.Tensor, crf: int) -> torch.Tensor:
    """Apply H.264 compression artefacts to an [N, H, W, 3] float32 tensor (ComfyUI image format).
    crf=0 means no compression. Uses PyAV to encode/decode frames in-memory."""
    if crf == 0:
        return tensor

    N, H, W, C = tensor.shape

    # Dimensions must be even for H.264
    h = (H // 2) * 2
    w = (W // 2) * 2

    # uint8 [N, H, W, 3]
    tensor_bytes = (tensor[:, :h, :w, :] * 255.0).byte().cpu().numpy()

    try:
        buf = _io.BytesIO()
        container = av.open(buf, mode="w", format="mp4")
        stream = container.add_stream("libx264", rate=24)
        stream.width = w
        stream.height = h
        stream.pix_fmt = "yuv420p"
        stream.options = {"crf": str(crf), "preset": "ultrafast"}

        for i in range(N):
            frame = av.VideoFrame.from_ndarray(tensor_bytes[i], format="rgb24")
            for pkt in stream.encode(frame):
                container.mux(pkt)

        for pkt in stream.encode(None):
            container.mux(pkt)

        container.close()

        buf.seek(0)
        container_r = av.open(buf, mode="r")
        decoded = [
                frame_r.to_ndarray(format="rgb24")
                for frame_r in container_r.decode(video=0)
                ]
        container_r.close()

        if not decoded:
            return tensor

        decoded_np = np.stack(decoded).astype(np.float32) / 255.0

        # Re-embed into original tensor shape (may have been cropped by even-rounding)
        out = tensor.clone()
        dec_N = min(N, len(decoded))
        out[:dec_N, :h, :w] = torch.from_numpy(decoded_np[:dec_N]).to(
                tensor.device, tensor.dtype,
                )

        return out

    except Exception as e:
        log.warning("[PromptRelay] img_compression encode/decode failed: %s", e)
        return tensor


def _build_combined_audio(
    timeline_data_str: str,
    duration_frames: int,
    frame_rate: float = 24,
) -> dict:
    """Parses timeline JSON, loads/trims audio directly from memory using PyAV,
    and aligns to a global timeline yielding ComfyUI's format.
    Output length explicitly mimics the timeline's duration_frames length."""
    target_sr = 44100
    total_samples = max(
            1, int(math.ceil(duration_frames / frame_rate * target_sr)),
            )
    empty_audio = {
            "waveform": torch.zeros((1, 2, total_samples), dtype=torch.float32),
            "sample_rate": target_sr,
            }

    if not timeline_data_str:
        return empty_audio

    try:
        data = json.loads(timeline_data_str)
        audio_segs = data.get("audioSegments", [])
    except Exception:
        return empty_audio

    if not audio_segs:
        return empty_audio

    out_waveform = torch.zeros((2, total_samples), dtype=torch.float32)

    for seg in audio_segs:
        buffer = None
        if seg.get("audioFile"):
            file_path = os.path.join(
                    folder_paths.get_input_directory(), seg["audioFile"],
                    )
            if os.path.exists(file_path):
                with open(file_path, "rb") as f:
                    buffer = _io.BytesIO(f.read())

        if not buffer and seg.get("audioB64"):
            b64 = seg.get("audioB64")
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            try:
                audio_bytes = base64.b64decode(b64)
                buffer = _io.BytesIO(audio_bytes)
            except:
                pass

        if not buffer:
            continue

        try:
            clip_frames = []

            # Use PyAV to decode directly from memory buffer
            with av.open(buffer) as container:
                stream = container.streams.audio[0]

                # Setup resampler to ensure output is 44.1kHz, Stereo, Float32 Planar
                resampler = av.AudioResampler(
                        format="fltp",
                        layout="stereo",
                        rate=target_sr,
                        )

                for frame in container.decode(stream):
                    for resampled_frame in resampler.resample(frame):
                        # to_ndarray() on fltp gives shape (channels, samples)
                        arr = resampled_frame.to_ndarray()
                        clip_frames.append(torch.from_numpy(arr))

                # Flush the resampler to get any remaining samples
                for resampled_frame in resampler.resample(None):
                    arr = resampled_frame.to_ndarray()
                    clip_frames.append(torch.from_numpy(arr))

            if not clip_frames:
                continue

            # Concatenate all frame blocks along the samples dimension (dim 1)
            waveform = torch.cat(
                    clip_frames, dim=1,
                    )  # Shape: [2, total_clip_samples]

            # Calculate interactive trim boundaries
            trim_start_frames = float(seg.get("trimStart", 0))
            length_frames = float(seg.get("length", 1))
            start_frames = float(seg.get("start", 0))

            start_sample_src = int(trim_start_frames / frame_rate * target_sr)
            length_samples = int(length_frames / frame_rate * target_sr)
            end_sample_src = start_sample_src + length_samples

            if start_sample_src < 0:
                start_sample_src = 0
            if end_sample_src > waveform.shape[1]:
                end_sample_src = waveform.shape[1]

            actual_length = end_sample_src - start_sample_src
            if actual_length <= 0:
                continue

            # Extract the correct segment of the audio
            clip_waveform = waveform[:, start_sample_src:end_sample_src]

            # Position onto the timeline
            start_sample_dst = int(start_frames / frame_rate * target_sr)

            if start_sample_dst >= out_waveform.shape[1]:
                continue

            end_sample_dst = start_sample_dst + actual_length

            # Clip any trailing overflow so we don't index past the timeline bounds
            if end_sample_dst > out_waveform.shape[1]:
                actual_length = out_waveform.shape[1] - start_sample_dst
                clip_waveform = clip_waveform[:, :actual_length]
                end_sample_dst = start_sample_dst + actual_length

            if actual_length <= 0:
                continue

            # Additive composite (allows clips overlapping to sum together naturally)
            out_waveform[:, start_sample_dst:end_sample_dst] += clip_waveform

        except Exception as e:
            log.warning(
                    "[PromptRelay] Audio process error for segment %s: %s",
                    seg.get("fileName"),
                    e,
                    )
            continue

    return {"waveform": out_waveform.unsqueeze(0), "sample_rate": target_sr}


def _convert_to_latent_lengths(pixel_lengths, temporal_stride, latent_frames):
    """Convert pixel-space segment lengths to integer latent-space lengths using the
    largest-remainder method. Targets the full `latent_frames` when the pixel sum looks
    like full coverage (within one stride of latent_frames * stride). Otherwise targets
    round(total_pixel / temporal_stride) so partial-coverage timelines stay partial.
    """
    if not pixel_lengths:
        return []
    total_pixel = sum(pixel_lengths)
    if total_pixel <= 0:
        return [1] * len(pixel_lengths)

    naive_total = max(1, round(total_pixel / temporal_stride))
    target_total = min(latent_frames, naive_total)
    # Within one frame of full → user clearly intended full coverage; pin to latent_frames.
    if target_total >= latent_frames - 1:
        target_total = latent_frames

    exact = [p * target_total / total_pixel for p in pixel_lengths]
    result = [int(e) for e in exact]
    diff = target_total - sum(result)
    if diff > 0:
        order = sorted(
                range(len(exact)), key=lambda i: -(exact[i] - int(exact[i])),
                )
        for k in range(diff):
            result[order[k % len(order)]] += 1

    # Ensure every segment has ≥ 1 latent frame (steal from the largest if needed).
    for i in range(len(result)):
        if result[i] < 1:
            max_idx = max(range(len(result)), key=lambda j: result[j])
            if result[max_idx] > 1:
                result[max_idx] -= 1
                result[i] = 1

    return result


def _encode_relay(
        model, clip, latent, global_prompt, local_prompts, segment_lengths, epsilon,
        ):
    for name, val in (
                ("global_prompt", global_prompt),
                ("local_prompts", local_prompts),
                ("segment_lengths", segment_lengths),
            ):
        if val is None:
            raise ValueError(
                    f"PromptRelay: '{name}' arrived as None. "
                    "Likely causes: a stale workflow JSON saved with null, the timeline "
                    "editor's web extension failing to load, or an upstream node returning None. "
                    "Set the field to an empty string or fix the upstream connection.",
                    )

    # Split prompts but do NOT filter out empty ones yet, so we can detect them
    locals_list = [p.strip() for p in local_prompts.split("|")]

    # Check if any specific segment is empty
    for p in locals_list:
        if not p:
            raise ValueError(
                    "Oops! You're trying to generate a part of the timeline that doesn't have any segments yet. Double-check your 'render_start_seconds' setting.",
                    )

    if not locals_list or (len(locals_list) == 1 and not locals_list[0]):
        raise ValueError("At least one local prompt is required.")

    arch, patch_size, temporal_stride = detect_model_type(model)

    samples = latent["samples"]
    latent_frames = samples.shape[2]
    tokens_per_frame = (samples.shape[3] // patch_size[1]) * (
            samples.shape[4] // patch_size[2]
    )

    parsed_lengths = None
    if segment_lengths.strip():
        pixel_lengths = [
                int(float(x.strip()))
                for x in segment_lengths.split(",")
                if x.strip()
                ]
        parsed_lengths = _convert_to_latent_lengths(
                pixel_lengths, temporal_stride, latent_frames,
                )

    raw_tokenizer = get_raw_tokenizer(clip)
    full_prompt, token_ranges = map_token_indices(
            raw_tokenizer, global_prompt, locals_list,
            )

    log.info(
            "[PromptRelay] Global: tokens [0:%d] (%d tokens)",
            token_ranges[0][0],
            token_ranges[0][0],
            )
    for i, (s, e) in enumerate(token_ranges):
        log.info(
                "[PromptRelay] Segment %d: tokens [%d:%d] (%d tokens)",
                i,
                s,
                e,
                e - s,
                )

    conditioning = clip.encode_from_tokens_scheduled(clip.tokenize(full_prompt))

    effective_lengths = distribute_segment_lengths(
            len(locals_list), latent_frames, parsed_lengths,
            )

    log.info(
            "[PromptRelay] Latent: %d frames, %d tokens/frame, segments: %s",
            latent_frames,
            tokens_per_frame,
            effective_lengths,
            )

    q_token_idx = build_segments(token_ranges, effective_lengths, epsilon, None)
    mask_fn = create_mask_fn(q_token_idx, tokens_per_frame, latent_frames)

    patched = model.clone()
    apply_patches(patched, arch, mask_fn)

    return patched, conditioning


class LTXDirector(io.ComfyNode):
    """WYSIWYG timeline variant — segments and lengths come from a visual editor in the node UI."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LTXDirector",
            display_name="LTX Director",
            category="WhatDreamsCost",
            description=(
                "Same as Prompt Relay Encode, but local prompts and segment lengths are edited "
                "visually as draggable blocks on a timeline. The duration_frames input only sets the "
                "timeline scale (pixel space) — actual frame count is still read from the latent."
            ),
            inputs=[
                io.Model.Input("model"),
                io.Clip.Input("clip"),
                io.Vae.Input(
                    "audio_vae",
                    optional=False,
                    tooltip="Connect an Audio VAE to generate audio latents.",
                ),
                io.Latent.Input(
                    "optional_latent",
                    optional=True,
                    tooltip="Optional. Connect a latent to override the auto-generated one.",
                ),
                io.String.Input(
                    "global_prompt",
                    multiline=True,
                    default="",
                    tooltip="Conditions the entire video. Anchors persistent characters, objects, and scene context.",
                ),
                # --- 1. Timing & Playback ---
                io.Float.Input(
                    "frame_rate",
                    default=24,
                    min=1,
                    max=60,
                    step=1,
                    optional=True,
                    tooltip="Frames per second — affects timeline display and rendering math.",
                ),
                io.Int.Input(
                    "duration_frames",
                    default=120,
                    min=1,
                    max=10000,
                    step=1,
                    tooltip="Total timeline length in pixel-space frames.",
                ),
                io.Float.Input(
                    "duration_seconds",
                    default=5.00,
                    min=0.10,
                    max=1000.0,
                    step=0.50,
                    tooltip="Total timeline duration in seconds (computed/synced from frames).",
                ),
                # --- 2. Render Crop ---
                io.Float.Input(
                    "render_start_seconds",
                    default=0.0,
                    min=0.0,
                    max=1000.0,
                    step=0.50,
                    optional=True,
                    tooltip="Crop the generation window to start from this second instead of 0.0s.",
                ),
                io.Float.Input(
                    "render_duration_seconds",
                    default=5.0,
                    min=1.00,
                    max=20.0,
                    step=0.50,
                    optional=True,
                    tooltip="How many seconds to generate. Set to 0.0 to generate all the way to the end of the timeline.",
                ),
                # --- 3. Output Resolution ---
                io.Int.Input(
                    "custom_width",
                    default=0,
                    min=0,
                    max=8192,
                    step=1,
                    optional=True,
                    tooltip="Target output width for all image segments. Set to 0 to use original.",
                ),
                io.Int.Input(
                    "custom_height",
                    default=0,
                    min=0,
                    max=8192,
                    step=1,
                    optional=True,
                    tooltip="Target output height for all image segments. Set to 0 to use original.",
                ),
                io.Combo.Input(
                    "resize_method",
                    options=[
                        "maintain aspect ratio",
                        "stretch to fit",
                        "pad",
                        "crop",
                    ],
                    default="maintain aspect ratio",
                    optional=True,
                    tooltip="How to resize image segments to fit the target dimensions.",
                ),
                # --- 4. Audio Control ---
                io.Combo.Input(
                    "audio_mode",
                    options=AudioMode,
                    default=AudioMode.GENERATE,
                    tooltip="Generate: New audio from scratch. Template: AI creates new audio based on timeline. Preserve: Audio is used only for video conditioning (lip sync, etc).",
                ),
                # --- 5. Hidden / Internal Settings ---
                io.String.Input(
                    "timeline_data",
                    default="",
                    tooltip="JSON state of the timeline editor.",
                ),
                io.String.Input(
                    "local_prompts",
                    multiline=True,
                    default="",
                ),
                io.String.Input(
                    "segment_lengths",
                    default="",
                ),
                io.String.Input(
                    "guide_strength",
                    default="",
                ),
                io.Float.Input(
                    "epsilon",
                    default=0.001,
                    min=0.0001,
                    max=0.99,
                    step=0.0001,
                ),
                io.Combo.Input(
                    "display_mode",
                    options=["frames", "seconds"],
                    default="seconds",
                    optional=True,
                ),
                io.Int.Input(
                    "divisible_by",
                    default=32,
                    min=1,
                    max=256,
                    step=1,
                    optional=True,
                ),
                io.Int.Input(
                    "img_compression",
                    default=18,
                    min=0,
                    max=100,
                    step=1,
                    optional=True,
                ),
            ],
            outputs=[
                io.Model.Output(display_name="model"),
                io.Conditioning.Output(display_name="positive"),
                io.Latent.Output(
                    display_name="video_latent",
                    tooltip="Auto-generated LTXV empty latent (only populated when no latent is connected).",
                ),
                io.Latent.Output(
                    display_name="audio_latent",
                    tooltip="Auto-generated audio latent (uses custom audio if enabled).",
                ),
                GuideData.Output(display_name="guide_data"),
                io.Float.Output(
                    display_name="frame_rate",
                    tooltip="The frame rate used for the timeline.",
                ),
                io.Audio.Output(
                    display_name="timeline_audio",
                    tooltip="Original Audio from Timeline.",
                ),
                io.Boolean.Output(
                    display_name="is_use_raw_audio",
                    tooltip="Outputs True if in Preserve mode, useful for triggering an Audio Switch node.",
                ),
            ],
        )e-3,
        frame_rate=24,
        display_mode="seconds",
        custom_width=768,
        custom_height=512,
        resize_method="maintain aspect ratio",
        divisible_by=32,
        img_compression=18,
        optional_latent=None,
        audio_mode=AudioMode.GENERATE,
        render_start_seconds=0.0,
        render_duration_seconds=5.0,
    ) -> io.NodeOutput:

        # --- Calculate crop window in frame spaces (Start + Duration instead of End) ---
        render_duration_seconds = render_duration_seconds or duration_seconds

        start_crop_frame = round(max(0, render_start_seconds * frame_rate))

        end_crop_frame = round(start_crop_frame + render_duration_seconds * frame_rate)

        # Override the targeted latent generation duration
        duration_frames = end_crop_frame - start_crop_frame

        # --- Slice and offset the prompt segments ---
        if segment_lengths.strip():
            raw_lengths = [
                    int(float(x.strip()))
                    for x in segment_lengths.split(",")
                    if x.strip()
                    ]
            raw_prompts = [p.strip() for p in local_prompts.split("|")]

            current_frame = 0
            new_lengths = []
            new_prompts = []

            for length, prompt in zip(raw_lengths, raw_prompts):
                seg_start = current_frame
                seg_end = current_frame + length
                current_frame = seg_end

                overlap_start = max(seg_start, start_crop_frame)
                overlap_end = min(seg_end, end_crop_frame)

                if overlap_start < overlap_end:
                    new_lengths.append(overlap_end - overlap_start)
                    new_prompts.append(prompt)

            if new_lengths:
                segment_lengths = ",".join(map(str, new_lengths))
                local_prompts = " | ".join(new_prompts)
            else:
                segment_lengths = str(duration_frames)
                local_prompts = raw_prompts[0] if raw_prompts else ""

        # --- Programmatically slice timeline JSON data for audio tracks ---

        tdata = json.loads(timeline_data) if timeline_data else {}

        if timeline_data:
            try:
                if "audioSegments" in tdata:
                    adjusted_audio = []
                    for aud in tdata["audioSegments"]:
                        a_start = float(aud.get("start", 0))
                        a_len = float(aud.get("length", 0))
                        a_end = a_start + a_len

                        overlap_start = max(a_start, start_crop_frame)
                        overlap_end = min(a_end, end_crop_frame)

                        if overlap_start < overlap_end:
                            aud["start"] = overlap_start - start_crop_frame
                            if a_start < start_crop_frame:
                                aud["trimStart"] = float(
                                        aud.get("trimStart", 0),
                                        ) + (start_crop_frame - a_start)
                            aud["length"] = overlap_end - overlap_start
                            adjusted_audio.append(aud)
                    tdata["audioSegments"] = adjusted_audio
                timeline_data = json.dumps(tdata)
            except Exception as e:
                log.warning(
                    "[PromptRelay] Could not adjust audio timeline data: %s",
                    e,
                )

        # --- Build guide_data from image segments FIRST (to derive output dimensions) ---
        guide_data = {
                "images": [],
                "insert_frames": [],
                "strengths": [],
                "frame_rate": frame_rate,
                }

        derived_w, derived_h = custom_width, custom_height

        try:
            img_segs = [
                    s
                    for s in tdata.get("segments", [])
                    if s.get("type", "image") in ("image", "video")
                       and (s.get("imageFile") or s.get("imageB64"))
                       and int(s.get("start", 0)) < end_crop_frame
                    ]

            img_segs.sort(key=lambda s: float(s.get("start", 0)))
            strengths = []
            if guide_strength.strip():
                strengths = [
                        float(x.strip())
                        for x in guide_strength.split(",")
                        if x.strip()
                        ]

            # Crop and offset images belonging to our active window
            valid_img_segs = []
            valid_strengths = []
            for idx, seg in enumerate(img_segs):
                s_start = int(round(float(seg.get("start", 0))))
                s_len = int(round(float(seg.get("length", 1))))
                s_end = s_start + s_len

                # Check if this image segment overlaps with the crop window
                overlap_start = max(s_start, start_crop_frame)
                overlap_end = min(s_end, end_crop_frame)

                if overlap_start < overlap_end:
                    seg_copy = seg.copy()
                    seg_copy["start"] = overlap_start - start_crop_frame

                    if s_start < start_crop_frame:
                        seg_copy["trimStart"] = float(seg.get("trimStart", 0)) + (
                                start_crop_frame - s_start)

                    seg_copy["length"] = overlap_end - overlap_start

                    valid_img_segs.append(seg_copy)
                    str_val = strengths[idx] if idx < len(strengths) else 1.0
                    valid_strengths.append(str_val)

            for idx, seg in enumerate(valid_img_segs):
                if seg.get("type") == "video":
                    tensor = _load_video_tensor(seg, float(frame_rate))
                else:
                    tensor = _load_image_tensor(seg)

                # Apply resize
                src_h, src_w = tensor.shape[1], tensor.shape[2]

                def snap(val, div):
                    return max(div, (val // div) * div)

                if custom_width > 0 and custom_height > 0:
                    tensor = _resize_image(
                            tensor,
                            custom_width,
                            custom_height,
                            resize_method,
                            divisible_by,
                            )
                elif custom_width > 0:
                    tgt_w = snap(custom_width, divisible_by)
                    tgt_h = snap(int(src_h * tgt_w / src_w), divisible_by)
                    tensor = _resize_image(
                            tensor, tgt_w, tgt_h, "stretch to fit", divisible_by,
                            )
                elif custom_height > 0:
                    tgt_h = snap(custom_height, divisible_by)
                    tgt_w = snap(int(src_w * tgt_h / src_h), divisible_by)
                    tensor = _resize_image(
                            tensor, tgt_w, tgt_h, "stretch to fit", divisible_by,
                            )
                else:
                    tensor = _resize_image(
                            tensor,
                            src_w,
                            src_h,
                            "maintain aspect ratio",
                            divisible_by,
                            )

                # Apply compression
                if img_compression > 0:
                    tensor = _compress_image(tensor, img_compression)

                # Record dimensions of the first processed image for latent generation
                if idx == 0:
                    derived_h = tensor.shape[1]
                    derived_w = tensor.shape[2]

                strength = valid_strengths[idx]
                guide_data["images"].append(tensor)
                guide_data["insert_frames"].append(int(seg["start"]))
                guide_data["strengths"].append(float(strength))

            # If no images were loaded from the timeline, create a dummy image at strength 0
            # to prevent artifacts in text-to-video mode.
            if not guide_data["images"] and optional_latent is None:
                w = derived_w if derived_w > 0 else 768
                h = derived_h if derived_h > 0 else 512
                w = (w // divisible_by) * divisible_by
                h = (h // divisible_by) * divisible_by

                dummy_image = torch.zeros((1, h, w, 3), dtype=torch.float32)
                guide_data["images"].append(dummy_image)
                guide_data["insert_frames"].append(0)
                guide_data["strengths"].append(0.0)

                derived_w = w
                derived_h = h
        except Exception as e:
            log.warning("[PromptRelay] Could not build guide_data: %s", e)

        # --- Auto-generate LTXV latent if none was provided ---
        ltxv_length = duration_frames + 1
        if optional_latent is None:
            latent_w = max(32, (derived_w // 32) * 32)
            latent_h = max(32, (derived_h // 32) * 32)
            # LTXV temporal: ((length - 1) // 8) + 1 latent frames; invert to get pixel frames -> length
            latent_t = ((ltxv_length - 1) // 8) + 1
            samples = torch.zeros(
                    [1, 128, latent_t, latent_h // 32, latent_w // 32],
                    device=comfy.model_management.intermediate_device(),
                    )
            latent = {"samples": samples}
            log.info(
                    "[PromptRelay] Auto-generated LTXV latent: %dx%d, %d pixel frames (%d latent frames)",
                    latent_w,
                    latent_h,
                    ltxv_length,
                    latent_t,
                    )
        else:
            latent = optional_latent

        patched, conditioning = _encode_relay(
                model,
                clip,
                latent,
                global_prompt,
                local_prompts,
                segment_lengths,
                epsilon,
                )

        # Determine if we should process timeline audio at all
        process_audio = audio_mode != AudioMode.GENERATE

        # --- Build Audio Output ---
        # If we are generating from scratch, pass an empty string so combined_audio is pure silence
        audio_out = _build_combined_audio(
                timeline_data if process_audio else "",
                ltxv_length,
                float(frame_rate),
                )

        # --- Audio Latent Generation ---
        audio_latent = {}

        if process_audio:
            if audio_out is None:
                raise ValueError("No audio waveform to encode.")
            waveform = audio_out["waveform"]
            if waveform.ndim == 2:
                waveform = waveform.unsqueeze(0)
            if waveform.ndim != 3:
                raise ValueError(
                    f"Expected custom audio waveform with 2 or 3 dims, got shape {tuple(waveform.shape)}",
                )

            if hasattr(audio_vae, "first_stage_model"):
                latent_samples = audio_vae.encode(waveform.movedim(1, -1))
            else:
                latent_samples = audio_vae.encode(
                    {
                        "waveform": waveform,
                        "sample_rate": audio_out["sample_rate"],
                    },
                )

            if latent_samples.numel() == 0:
                raise ValueError("Encoded audio latent is empty (0 elements).")

            # EXACT SAME LATENT FOR BOTH TEMPLATE AND PRESERVE.
            # No masks. Just the raw encoded audio to act as the guide.
            audio_latent = {
                "samples": latent_samples,
                "type": "audio",
            }

            log.info(
                f"[PromptRelay] Generated custom audio latent in '{audio_mode}' mode."
            )

        else:
            # generate empty audio latent
            inner = getattr(audio_vae, "first_stage_model", audio_vae)
            z_channels = getattr(
                audio_vae,
                "latent_channels",
                getattr(inner, "latent_channels", 32),
            )
            audio_freq = inner.latent_frequency_bins
            num_audio_latents = inner.num_of_latents_from_frames(
                ltxv_length,
                float(frame_rate),
            )
            audio_latents = torch.zeros(
                (1, z_channels, num_audio_latents, audio_freq),
                device=comfy.model_management.intermediate_device(),
            )
            audio_latent = {"samples": audio_latents, "type": "audio"}

            log.info(
                "[PromptRelay] Auto-generated empty audio latent (Generate From Scratch)."
            )

        use_raw_audio = bool(audio_mode == AudioMode.PRESERVE)

        return io.NodeOutput(
            patched,
            conditioning,
            latent,
            audio_latent,
            guide_data,
            float(frame_rate),
            audio_out,
            use_raw_audio,
        )


NODE_CLASS_MAPPINGS = {
        "LTXDirector": LTXDirector,
        }

NODE_DISPLAY_NAME_MAPPINGS = {
        "LTXDirector": "Prompt Relay Encode (Timeline)",
        # "PromptRelayEncodeTimeline": "Prompt Relay Encode (Timeline)",
        }
