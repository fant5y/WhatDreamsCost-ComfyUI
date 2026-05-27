import asyncio
import base64
import gc
import io as _io
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
from PIL import Image

import folder_paths

from .ltx_prompt_writer_constants import (
    _NONE_STYLE_LABEL,
    STYLE_PRESETS,
    TEXT_ONLY_SYSTEM_PROMPT,
    VISION_MODELS,
    VISION_SYSTEM_PROMPT,
)

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# External Configuration Setup
# ---------------------------------------------------------------------------

# Use ComfyUI's official user directory to prevent overwrites during git updates.
# Fallback to the node's directory if running an older version of ComfyUI.
try:
    _USER_DIR = folder_paths.get_user_directory()
except AttributeError:
    _USER_DIR = os.path.dirname(__file__)

# Named specifically to avoid clashing with other nodes in the user folder
CONFIG_PATH = os.path.join(_USER_DIR, "ltx_prompt_writer_config.json")


def get_config() -> dict:
    """Load configuration from JSON, generating default file if it doesn't exist."""
    if not os.path.exists(CONFIG_PATH):
        default_config = {
            "VISION_MODELS": VISION_MODELS,
            "VISION_SYSTEM_PROMPT": VISION_SYSTEM_PROMPT,
            "STYLE_PRESETS": STYLE_PRESETS,
        }
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(default_config, f, indent=4, ensure_ascii=False)
        except Exception as e:
            log.warning("[PromptWriter] Could not write default config: %s", e)
        return default_config

    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log.error("[PromptWriter] Error reading config: %s. Using defaults.", e)
        return {
            "VISION_MODELS": VISION_MODELS,
            "TEXT_ONLY_SYSTEM_PROMPT": TEXT_ONLY_SYSTEM_PROMPT,
            "VISION_SYSTEM_PROMPT": VISION_SYSTEM_PROMPT,
            "STYLE_PRESETS": STYLE_PRESETS,
        }


# ---------------------------------------------------------------------------
# GGUF path helpers
# ---------------------------------------------------------------------------


def _resolve_gguf_path(local_path: str) -> tuple[str | None, bool]:
    """Returns (gguf_file, is_gguf_mode).

    is_gguf_mode is True when local_path is a .gguf file directly, or a
    directory that contains .gguf files but no config.json (i.e. not a
    HuggingFace transformers snapshot).
    """
    if not local_path:
        return None, False
    lp = local_path.strip()
    if not lp:
        return None, False
    if os.path.isfile(lp) and lp.lower().endswith(".gguf"):
        return lp, True
    if os.path.isdir(lp):
        if os.path.exists(os.path.join(lp, "config.json")):
            return None, False  # valid transformers dir — not GGUF mode
        candidates = sorted(
            [
                f
                for f in os.listdir(lp)
                if f.lower().endswith(".gguf") and "mmproj" not in f.lower()
            ],
            key=lambda f: os.path.getsize(os.path.join(lp, f)),
            reverse=True,
        )
        if candidates:
            return os.path.join(lp, candidates[0]), True
    return None, False


def _find_mmproj(gguf_file: str, mmproj_hint: str = "") -> str | None:
    """Return mmproj path: use hint if valid, otherwise scan same directory."""
    if mmproj_hint.strip() and os.path.isfile(mmproj_hint.strip()):
        return mmproj_hint.strip()
    directory = os.path.dirname(gguf_file)
    for fname in os.listdir(directory):
        if fname.lower().endswith(".gguf") and "mmproj" in fname.lower():
            return os.path.join(directory, fname)
    return None


# ---------------------------------------------------------------------------
# GGUF model singleton
# ---------------------------------------------------------------------------

_gguf_llm = None
_gguf_llm_key: str | None = None


def _unload_gguf_model() -> None:
    global _gguf_llm, _gguf_llm_key
    if _gguf_llm is None:
        return
    _gguf_llm = None
    _gguf_llm_key = None
    gc.collect()
    log.info("[PromptWriter] GGUF model unloaded.")


def _load_gguf_model(gguf_file: str, mmproj_file: str | None):
    global _gguf_llm, _gguf_llm_key

    cache_key = f"{gguf_file}|{mmproj_file or ''}"
    if _gguf_llm_key == cache_key:
        return _gguf_llm

    _unload_gguf_model()
    _unload_vision_model()  # only one backend loaded at a time

    try:
        import comfy.model_management as mm

        mm.unload_all_models()
        mm.soft_empty_cache()
    except Exception:
        pass

    from llama_cpp import Llama

    kwargs: dict = dict(
        model_path=gguf_file,
        n_ctx=8192,
        n_gpu_layers=-1,
        verbose=False,
    )

    if mmproj_file:
        handler_cls = None
        # Try handlers in order of preference
        for cls_name in (
            "Qwen35ChatHandler",
            "Qwen2VLChatHandler",
            "Qwen2_5VLChatHandler",
        ):
            try:
                from llama_cpp import llama_chat_format as _lcf

                handler_cls = getattr(_lcf, cls_name)
                log.info("[PromptWriter] Using %s for vision", cls_name)
                break
            except (ImportError, AttributeError):
                continue

        if handler_cls:
            try:
                # enable_thinking=False disables chain-of-thought (Qwen3.5 specific)
                try:
                    kwargs["chat_handler"] = handler_cls(
                        clip_model_path=mmproj_file,
                        verbose=False,
                        enable_thinking=False,
                    )
                except TypeError:
                    kwargs["chat_handler"] = handler_cls(
                        clip_model_path=mmproj_file,
                        verbose=False,
                    )
                log.info(
                    "[PromptWriter] GGUF vision handler loaded with mmproj: %s",
                    mmproj_file,
                )
            except Exception as e:
                log.warning(
                    "[PromptWriter] Vision handler init failed (%s: %s) — text-only",
                    type(e).__name__,
                    e,
                )
        else:
            log.warning(
                "[PromptWriter] No VL chat handler found in llama-cpp — text-only"
            )

    _gguf_llm = Llama(**kwargs)
    _gguf_llm_key = cache_key
    log.info("[PromptWriter] GGUF model loaded: %s", gguf_file)
    return _gguf_llm


import re as _re


def _strip_thinking(text: str) -> str:
    """Strip <think>...</think> blocks and chain-of-thought preambles.

    Strategy: after removing explicit think tags, split into paragraphs and
    return the last one that looks like plain prose (no markdown bullets or
    headers) and is at least 40 characters long.  This handles thinking models
    that dump analysis before writing the actual answer.
    """
    # 1. Remove explicit <think> blocks
    text = _re.sub(r"<think>[\s\S]*?</think>", "", text, flags=_re.DOTALL).strip()
    if not text:
        return text

    # 2. Split into blank-line-separated paragraphs
    paragraphs = [p.strip() for p in _re.split(r"\n\s*\n", text) if p.strip()]
    if not paragraphs:
        return text

    # 3. Find last paragraph that reads as plain prose
    bullet_or_header = _re.compile(r"^\s*(\d+[\.\)]|[-*#]|\*\*)", _re.MULTILINE)
    for para in reversed(paragraphs):
        # Reject if the paragraph is mostly bullets / headers / markdown bold
        non_md = _re.sub(r"\*+[^*\n]+\*+", "", para)  # strip **bold**
        non_md = _re.sub(r"^\s*[-*#\d]+[.)\s].*$", "", non_md, flags=_re.MULTILINE)
        non_md = non_md.strip()
        if len(non_md) >= 40 and not bullet_or_header.match(para):
            return para

    # 4. Hard fallback: last paragraph regardless
    return paragraphs[-1]


def _describe_image_gguf_sync(
    image_tensor: torch.Tensor | None,
    gguf_file: str,
    mmproj_file: str | None,
    user_text: str,
    temperature: float,
    max_tokens: int,
) -> str:
    import base64 as _b64
    import io as _sio

    llm = _load_gguf_model(gguf_file, mmproj_file)
    has_vision = mmproj_file and getattr(llm, "chat_handler", None) is not None

    # For thinking models (Qwen3, DeepSeek-R1, etc.) add /no_think system instruction
    system_msg = {
        "role": "system",
        "content": "/no_think\nOutput ONLY the scene description. No reasoning, no analysis, no preamble.",
    }

    if has_vision and image_tensor is not None:
        pil = _tensor_to_pil(image_tensor)
        buf = _sio.BytesIO()
        pil.save(buf, format="JPEG", quality=90)
        img_b64 = _b64.b64encode(buf.getvalue()).decode()
        messages = [
            system_msg,
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"},
                    },
                    {"type": "text", "text": user_text},
                ],
            },
        ]
    else:
        log.info("[PromptWriter] GGUF text-only mode (no mmproj — image not analysed)")
        # Compact prompt for text-only: avoids triggering long reasoning chains
        textonly_prompt = get_config().get(
            "TEXT_ONLY_SYSTEM_PROMPT", TEXT_ONLY_SYSTEM_PROMPT
        )
        if user_text:
            # Append context/style lines from the original prompt (skip the verbose system block)
            extra = []
            for line in user_text.splitlines():
                if (
                    line.startswith("Global scene context")
                    or line.startswith("- ")
                    or line.startswith("Concept to expand")
                ):
                    extra.append(line)
            if extra:
                textonly_prompt += "\n".join(extra)
        messages = [system_msg, {"role": "user", "content": textonly_prompt}]

        log.info("[PromptWriter] Using Prompt:\n%s", messages)

        # ---> ENABLE STREAMING TO ALLOW INTERRUPTS <---
        import comfy.model_management as mm

        response_stream = llm.create_chat_completion(
            messages=messages,
            max_tokens=max(max_tokens, 300),
            temperature=max(temperature, 0.01),
            stream=True,  # <-- STREAM ENABLED
        )

        raw = ""
        for chunk in response_stream:
            if mm.processing_interrupted():
                log.info("[PromptWriter] GGUF generation interrupted mid-stream.")
                break

            delta = chunk["choices"][0].get("delta", {})
            if "content" in delta and delta["content"] is not None:
                raw += delta["content"]

        raw = raw.strip()
        return _strip_thinking(raw)


# ---------------------------------------------------------------------------
# Transformers model singleton (one vision model loaded at a time)
# ---------------------------------------------------------------------------

_executor = ThreadPoolExecutor(max_workers=1)
_loaded_model_id: str | None = None
_loaded_model = None
_loaded_processor = None


def _unload_vision_model() -> None:
    global _loaded_model, _loaded_model_id, _loaded_processor
    if _loaded_model is None:
        return
    try:
        for param in _loaded_model.parameters():
            param.data = torch.empty(0)
    except Exception:
        pass
    _loaded_model = None
    _loaded_processor = None
    _loaded_model_id = None
    for _ in range(3):
        gc.collect()
    if torch.cuda.is_available():
        try:
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
            torch.cuda.reset_peak_memory_stats()
        except Exception:
            pass
    log.info("[PromptWriter] Vision model unloaded and VRAM freed.")


def _load_vision_model(model_id: str, offline_mode: bool, local_path: str):
    global _loaded_model, _loaded_model_id, _loaded_processor

    if _loaded_model_id == model_id:
        return _loaded_processor, _loaded_model

    _unload_vision_model()

    try:
        import comfy.model_management as mm

        mm.unload_all_models()
        mm.soft_empty_cache()
    except Exception:
        pass

    source = local_path.strip() if local_path.strip() else None

    # Only use local_path if it's a valid transformers snapshot directory
    if source and not (
        os.path.isdir(source) and os.path.exists(os.path.join(source, "config.json"))
    ):
        source = None

    if not source:
        try:
            from huggingface_hub import snapshot_download

            source = snapshot_download(
                repo_id=model_id,
                local_files_only=offline_mode,
                ignore_patterns=["*.gguf"],
            )
        except Exception:
            source = model_id

    log.info("[PromptWriter] Loading vision model from: %s", source)

    from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

    processor = AutoProcessor.from_pretrained(source, local_files_only=offline_mode)

    dtype = (
        torch.bfloat16
        if (torch.cuda.is_available() and torch.cuda.is_bf16_supported())
        else torch.float16
    )
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        source,
        torch_dtype=dtype,
        device_map="auto",
        trust_remote_code=True,
        local_files_only=offline_mode,
    )
    model.eval()
    model.config.use_cache = True

    _loaded_model = model
    _loaded_model_id = model_id
    _loaded_processor = processor
    log.info("[PromptWriter] Vision model loaded: %s", model_id)
    return processor, model


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------


def _tensor_to_pil(tensor: torch.Tensor) -> Image.Image:
    arr = (tensor[0].cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    return Image.fromarray(arr)


_NONE_STYLE = _NONE_STYLE_LABEL  # alias for backward compat


def _build_user_text(
    global_context: str,
    style_preset: str,
    shot_angle: str,
    camera_move: str,
    style_extra: str,
    segment_hint: str = "",
    has_image: bool = True,
) -> str:
    # Load settings from dynamic config
    config = get_config()
    system_prompt = config.get("VISION_SYSTEM_PROMPT", VISION_SYSTEM_PROMPT)
    style_presets = config.get("STYLE_PRESETS", STYLE_PRESETS)

    if has_image:
        text = system_prompt
    else:
        text = system_prompt.replace(
            "Analyze the image and write", "Expand the provided concept into"
        )
        # text += f"\n\nConcept to expand: {segment_hint if segment_hint else 'A cinematic scene'}"
        # segment_hint = ""  # Clear so it isn't duplicated
    # Full style preset text (from STYLE_PRESETS dict) takes priority
    preset_text = style_presets.get(style_preset, "")
    if preset_text:
        text += f"\n\nUse this in your prompt:\n{preset_text}"
    elif style_preset and style_preset != _NONE_STYLE:
        # Unknown preset label — fall back to generic directive
        text += f"\n\nUse this in your prompt:\nVisual style: {style_preset}"

    if global_context.strip():
        text += f"\n\nGlobal scene context provided by the director: {global_context.strip()}"

    if segment_hint.strip():
        text += f"\n\nSPECIFIC INSTRUCTION for this scene: {segment_hint.strip()}\n\n"

    # Additional per-shot directives
    extra_lines = ["\n\nShot directives — incorporate these:\n"]
    if shot_angle and shot_angle != _NONE_STYLE:
        extra_lines.append(f"- Shot angle: {shot_angle}")
    if camera_move and camera_move != _NONE_STYLE:
        extra_lines.append(f"- Camera movement: {camera_move}")
    if style_extra.strip():
        extra_lines.append(f"- Additional: {style_extra.strip()}")
    if extra_lines:
        text += "\n".join(extra_lines)
    return text


def _describe_image_sync(
    image_tensor: torch.Tensor | None,
    model_id: str,
    offline_mode: bool,
    local_path: str,
    global_context: str,
    temperature: float,
    max_tokens: int,
    style_preset: str = _NONE_STYLE,
    shot_angle: str = _NONE_STYLE,
    camera_move: str = _NONE_STYLE,
    style_extra: str = "",
    mmproj_path: str = "",
    segment_hint: str = "",
) -> str:
    user_text = _build_user_text(
        global_context,
        style_preset,
        shot_angle,
        camera_move,
        style_extra,
        segment_hint,
        has_image=(image_tensor is not None),
    )

    # --- GGUF dispatch ---
    gguf_file, is_gguf = _resolve_gguf_path(local_path)
    if is_gguf:
        if gguf_file:
            mmproj = _find_mmproj(gguf_file, mmproj_path)
            return _describe_image_gguf_sync(
                image_tensor,
                gguf_file,
                mmproj,
                user_text,
                temperature,
                max_tokens,
            )
        log.warning(
            "[PromptWriter] GGUF mode detected but no .gguf file found in: %s — falling back to HuggingFace",
            local_path,
        )

    # --- Transformers dispatch ---
    processor, model = _load_vision_model(model_id, offline_mode, local_path)
    # pil = _tensor_to_pil(image_tensor)

    content = []
    if image_tensor is not None:
        content.append({"type": "image", "image": _tensor_to_pil(image_tensor)})
    content.append({"type": "text", "text": user_text})

    messages = [{"role": "user", "content": content}]

    text = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )

    log.info("[PromptWriter] Using Prompt:\n%s", messages)

    try:
        from qwen_vl_utils import process_vision_info

        image_inputs, video_inputs = process_vision_info(messages)

        kwargs = {"text": [text], "padding": True, "return_tensors": "pt"}
        if image_inputs is not None:
            kwargs["images"] = image_inputs
        if video_inputs is not None:
            kwargs["videos"] = video_inputs

        inputs = processor(**kwargs)
    except ImportError:
        # Fallback
        kwargs = {"text": [text], "padding": True, "return_tensors": "pt"}
        if image_tensor is not None:
            kwargs["images"] = [_tensor_to_pil(image_tensor)]
        inputs = processor(**kwargs)

    inputs = inputs.to(model.device)
    # ---> ADD STOPPING CRITERIA <---
    from transformers import StoppingCriteria, StoppingCriteriaList

    import comfy.model_management as mm

    class ComfyInterruptCriteria(StoppingCriteria):
        def __call__(
            self, input_ids: torch.LongTensor, scores: torch.FloatTensor, **kwargs
        ) -> bool:
            return mm.processing_interrupted()

    with torch.no_grad():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            temperature=temperature if temperature > 0 else None,
            top_p=0.9 if temperature > 0 else None,
            do_sample=temperature > 0,
            stopping_criteria=StoppingCriteriaList([ComfyInterruptCriteria()]),
        )

    generated = output_ids[:, inputs["input_ids"].shape[1] :]
    result = processor.batch_decode(
        generated,
        skip_special_tokens=True,
        clean_up_tokenization_spaces=True,
    )[0]
    return result.strip()


def _load_image_tensor_from_seg(seg: dict) -> torch.Tensor | None:
    image_file = seg.get("imageFile")
    if image_file:
        path = os.path.join(folder_paths.get_input_directory(), image_file)
        if os.path.exists(path):
            try:
                pil = Image.open(path).convert("RGB")
                arr = np.array(pil, dtype=np.float32) / 255.0
                return torch.from_numpy(arr).unsqueeze(0)
            except Exception:
                pass

    b64 = seg.get("imageB64", "")
    if b64 and not b64.startswith("/view?"):
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        try:
            img_bytes = base64.b64decode(b64)
            pil = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
            arr = np.array(pil, dtype=np.float32) / 255.0
            return torch.from_numpy(arr).unsqueeze(0)
        except Exception:
            pass

    return None


# ---------------------------------------------------------------------------
# HTTP route
# ---------------------------------------------------------------------------


async def handle_generate_prompts(request):
    from aiohttp import web

    try:
        from server import PromptServer

        # Check if the ComfyUI PromptServer and queue exist
        if (
            hasattr(
                PromptServer.instance,
                "prompt_queue",
            )
            and PromptServer.instance.prompt_queue is not None
        ):
            pending, running = PromptServer.instance.prompt_queue.get_current_queue()

            # If the 'running' list/dict has anything in it, ComfyUI is busy.
            if len(running) > 0:
                error_msg = (
                    "ComfyUI is currently generating a workflow.\n\n"
                    "Please wait for the queue to finish before using the Prompt Writer, "
                    "otherwise it will forcefully unload your models and crash the generation."
                )
                return web.json_response({"error": error_msg}, status=409)
    except Exception as e:
        log.warning("[PromptWriter] Could not check ComfyUI queue status: %s", e)
        # Fail-closed: If we can't verify the queue is empty, abort to protect VRAM.
        return web.json_response(
            {
                "error": "Failed to verify ComfyUI queue status. Aborting Prompt Writer to prevent potential VRAM crash.",
            },
            status=500,
        )

    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"error": f"Invalid JSON: {e}"}, status=400)

    segments = body.get("segments", [])
    global_prompt = body.get("global_prompt", "")
    model_name = body.get("model_name", "Qwen2.5-VL-3B — Fast")
    offline_mode = bool(body.get("offline_mode", False))
    local_path = body.get("local_path", "")
    temperature = float(body.get("temperature", 0.3))
    max_tokens = int(body.get("max_tokens", 180))
    style_preset = body.get("style_preset", _NONE_STYLE)
    shot_angle = body.get("shot_angle", _NONE_STYLE)
    camera_move = body.get("camera_move", _NONE_STYLE)
    style_extra = body.get("style_extra", "")
    mmproj_path = body.get("mmproj_path", "")

    model_id = (
        get_config()
        .get("VISION_MODELS", VISION_MODELS)
        .get(model_name, VISION_MODELS["Qwen2.5-VL-3B — Fast"])
    )

    loop = asyncio.get_event_loop()
    prompts: list[str] = []

    for i, seg in enumerate(segments):
        import comfy.model_management as mm

        if mm.processing_interrupted():
            log.info("[PromptWriter] Prompt generation aborted by user.")
            break

        segment_prompt = seg.get("prompt", "").strip()

        # ---> IGNORE NON-TARGETS IMMEDIATELY <---
        if seg.get("skip", False):
            prompts.append(segment_prompt)
            continue

        tensor = _load_image_tensor_from_seg(seg)
        segment_hint = seg.get("hint", "").strip()

        if tensor is None:
            # If no image/video frame, check if there's text/hint to expand instead
            text_to_expand = segment_hint if segment_hint else segment_prompt
            if not text_to_expand:
                prompts.append(segment_prompt)
                continue

            # Use the existing short text as the hint to expand
            segment_hint = text_to_expand
        try:
            prompt = await loop.run_in_executor(
                _executor,
                _describe_image_sync,
                tensor,
                model_id,
                offline_mode,
                local_path,
                global_prompt,
                temperature,
                max_tokens,
                style_preset,
                shot_angle,
                camera_move,
                style_extra,
                mmproj_path,
                segment_hint,
            )
            prompts.append(prompt)
            log.info("[PromptWriter] Segment %d: %s…", i, prompt[:80])
        except Exception as e:
            log.error("[PromptWriter] Segment %d failed: %s", i, e)
            # Unload before returning the error too
            _unload_gguf_model()
            _unload_vision_model()
            return web.json_response({"error": str(e)}, status=500)

    # Always unload after generation to free VRAM / RAM
    _unload_gguf_model()
    _unload_vision_model()

    return web.json_response({"prompts": prompts, "model_used": model_name})


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------


async def handle_style_presets(request):
    """Return the list of available style preset names (for the JS dropdown)."""
    from aiohttp import web

    return web.json_response(
        {"presets": list(get_config().get("STYLE_PRESETS", STYLE_PRESETS).keys())}
    )


def register_routes() -> None:
    try:
        from server import PromptServer

        PromptServer.instance.routes.post(
            "/whatdreamscost/generate_prompts",
        )(handle_generate_prompts)
        PromptServer.instance.routes.get(
            "/whatdreamscost/style_presets",
        )(handle_style_presets)
        log.info("[PromptWriter] Routes registered.")
    except Exception as e:
        log.warning("[PromptWriter] Could not register routes: %s", e)
