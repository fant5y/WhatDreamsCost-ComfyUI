export function _getVlmConfig() {
    let raw = {};
    try {
        raw = JSON.parse(localStorage.getItem("wdc_vlm_config") || "{}");
    } catch {
    }
    return {
        enabled: raw.enabled ?? true,
        model_name: raw.model_name ?? "Qwen2.5-VL-3B — Fast",
        temperature: raw.temperature ?? 0.3,
        max_tokens: raw.max_tokens ?? 180,
        offline_mode: raw.offline_mode ?? false,
        local_path: raw.local_path ?? "",
        mmproj_path: raw.mmproj_path ?? "",
        style_preset: raw.style_preset ?? "None — let VLM decide",
        shot_angle: raw.shot_angle ?? "None — let VLM decide",
        camera_move: raw.camera_move ?? "None — let VLM decide",
        style_extra: raw.style_extra ?? "",
    };
}

export function _setVlmConfig(cfg) {
    localStorage.setItem("wdc_vlm_config", JSON.stringify(cfg));
}
