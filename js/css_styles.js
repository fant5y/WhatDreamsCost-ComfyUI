// --- Modern Dark/Grey UI CSS (ComfyUI Match) ---
export const STYLES = `
    :root{
        --shadow-color: rgba(0,0,0,0.6);
        --border-color: #111111;
        
        --crop-line-color: rgba(255, 165, 0, 0.85);
        --crop-mask-dark: rgba(0, 0, 0, 0.55);
        --crop-mask-light: rgba(0, 0, 0, 0.35);
    }

  .pr-wrapper {
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding-bottom: 4px;
    gap: 8px;
  }
  .pr-wrapper.drag-active {
    border-radius: 6px;
    outline: 2px dashed #888888;
    background: rgba(255, 255, 255, 0.05);
  }
  .pr-toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: space-between;
    padding: 2px 0;
    gap: 6px;
  }
  .pr-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  
  .pr-btn-group{
  display: flex;
  gap: 6px;
  align-items: center;
  }
  
  .pr-btn {
  font-size: 11px;
  font-weight: 500;
    display: flex;
    align-items: center;
    padding: 6px 12px;
    cursor: pointer;
    transition: all 0.2s ease;
    color: #E0E0E0;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: #222222;
    gap: 6px;
  }
  
  .pr-btn .pr-settings-btn{
        justify-content: center;
        box-sizing: border-box;
        width: 28px;
        height: 28px;
        padding: 6px;
  } 
  
  .pr-btn:hover {
    border-color: #555555;
    background: #333333;
  }
  .pr-btn-danger:hover {
    color: #FFAAAA;
    border-color: #CC4444;
    background: #4A1515;
  }
  .pr-btn-vlm {
    color: #B0B0FF;
    border-color: #3A3A6E;
    background: #1A1A2E;
  }
  .pr-btn-vlm:hover {
    color: #D0D0FF;
    border-color: #6060CC;
    background: #2A2A4E;
  }
  .pr-btn-vlm:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .pr-vlm-section-title {
    font-size: 10px;
    font-weight: 600;
    padding: 4px 0 2px 0;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: #888888;
  }
  .pr-canvas {
    display: block; /* Ensure no inline baseline gaps */
    width: 100%;
    cursor: pointer;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    outline: none;
    background: #2A2A2A;
  }
  .pr-prop-container {
    display: flex;
    flex-direction: column;
    flex-grow: 1; /* Automatically scales to fill node height */
    width: 100%;
    min-height: 40px;
    gap: 4px;
  }
  .pr-hint-row {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    width: 100%;
    gap: 5px;
  }
  .pr-hint-label {
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
    white-space: nowrap;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #888888;
  }
  .pr-hint-input {
    font-size: 11px;
    font-style: italic;
    flex: 1;
    box-sizing: border-box;
    padding: 3px 7px;
    color: #B0B0FF;
    border: 1px solid #3A3A6E;
    border-radius: 4px;
    outline: none;
    background: #1A1A2E;
  }
  .pr-hint-input:focus {
    color: #D0D0FF;
    border-color: #6060CC;
  }
  .pr-hint-input::placeholder {
    font-style: italic;
    color: #5A5A8A;
  }
  .pr-prompt-area {
    font-size: 12px;
    line-height: 1.4;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 8px;
    resize: none; /* Removed the manual resize corner handle */
    transition: border-color 0.2s ease;
    color: #E0E0E0;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    outline: none;
    background: #222222;
  }
  .pr-prompt-area:focus {
    border-color: #888888;
  }
  .pr-audio-info {
    font-size: 12px;
    line-height: 1.6;
    display: none;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 10px;
    color: #AAAAAA;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: #181818;
  }
  .pr-audio-info span { font-weight: 500; color: #FFFFFF; }
  .pr-controls-group {
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    width: 100%;
    margin-bottom: 4px;
    padding: 6px 10px;
    border: 1px solid #333333;
    border-radius: 6px;
    background: #1E1E1E;
    gap: 4px;
  }
  .pr-strength-row {
    display: flex;
    align-items: center;
    box-sizing: border-box;
    width: 100%;
    gap: 12px;
  }
  .pr-height-resizer {
    height: 6px;
    margin: 2px 0;
    cursor: ns-resize;
    transition: background 0.15s;
    border: 1px solid #1E1E1E;
    border-radius: 3px;
    background: #2A2A2A;
  }
  .pr-height-resizer:hover {
    border-color: #555555;
    background: #444444;
  }
  .pr-strength-label {
    font-size: 11px;
    font-weight: 600;
    margin-left: auto;
    white-space: nowrap;
    color: #FFFFFF;
  }
  .pr-strength-slider {
    width: 80px;
    height: 4px;
    cursor: pointer;
    border: 1px solid #222222;
    border-radius: 2px;
    outline: none;
    background: #444444;
    -webkit-appearance: none;
    appearance: none;
  }
  .pr-strength-slider::-webkit-slider-thumb {
    width: 12px;
    height: 12px;
    cursor: pointer;
    border-radius: 50%;
    background: #AAAAAA;
    -webkit-appearance: none;
    appearance: none;
  }
  .pr-strength-slider:disabled {
    cursor: not-allowed;
    opacity: 0.3;
  }
  .pr-strength-input {
    font-size: 12px;
    width: 52px;
    padding: 3px;
    text-align: center;
    color: #FFFFFF;
    border: 1px solid #444444;
    border-radius: 4px;
    background: #222222;
  }
  .pr-strength-input::-webkit-outer-spin-button,
  .pr-strength-input::-webkit-inner-spin-button {
    margin: 0;
    -webkit-appearance: none;
  }
  .pr-strength-input[type=number] {
    -moz-appearance: textfield;
  }
  .pr-strength-input:disabled {
    cursor: not-allowed;
    opacity: 0.35;
  }
  .pr-gap-menu {
    position: fixed;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    padding: 4px;
    border: 1px solid #444444;
    border-radius: 6px;
    background: #1E1E1E;
    box-shadow: 0 4px 16px var(--shadow-color);
    gap: 4px;
  }
  .pr-gap-menu-btn {
    font-family: inherit;
    font-size: 11px;
    display: flex;
    align-items: center;
    padding: 6px 14px;
    cursor: pointer;
    transition: background 0.15s ease;
    text-align: left;
    white-space: nowrap;
    color: #E0E0E0;
    border: 1px solid #333333;
    border-radius: 4px;
    background: #2A2A2A;
    gap: 6px;
  }
  .pr-gap-menu-btn:hover {
    border-color: #666666;
    background: #3A3A3A;
  }
  .pr-player-controls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: center;
    width: 100%;
    padding: 2px 0;
    gap: 12px;
  }
  .pr-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 6px 12px;
    cursor: pointer;
    transition: all 0.2s;
    color: #EEEEEE;
    border: 1px solid #444444;
    border-radius: 4px;
    background: #2A2A2A;
  }
  .pr-icon-btn * {
    pointer-events: none;
  }
  .pr-icon-btn:hover {
    color: #FFFFFF;
    border-color: #666666;
    background: #3A3A3A;
  }
  .pr-icon-btn.active {
    color: #4FFF8F;
    border-color: #4FFF8F;
    background: #1A3A2A;
  }
  .pr-seek-bar {
    height: 6px;
    cursor: pointer;
    border: 1px solid #222222;
    border-radius: 3px;
    outline: none;
    background: #444444;
    -webkit-appearance: none;
    appearance: none;
  }
  .pr-seek-bar::-webkit-slider-thumb {
    width: 14px;
    height: 14px;
    cursor: pointer;
    border: 2px solid #222222;
    border-radius: 50%;
    background: #FF4444;
    -webkit-appearance: none;
    appearance: none;
  }
  .pr-timeline-viewport {
    overflow-x: auto;
    overflow-y: hidden;
    width: 100%;
  }
  .pr-timeline-viewport::-webkit-scrollbar {
    height: 10px;
  }
  .pr-timeline-viewport::-webkit-scrollbar-track {
    border-radius: 5px;
    background: #151515;
  }
  .pr-timeline-viewport::-webkit-scrollbar-thumb {
    border: 1px solid var(--border-color);
    border-radius: 5px;
    background: #444444;
  }
  .pr-timeline-viewport::-webkit-scrollbar-thumb:hover {
    border-color: #000000;
    background: #666666;
  }
  .pr-zoom-controls {
    display: flex;
    align-items: center;
    margin-left: 12px;
    gap: 4px;
  }
  .pr-zoom-slider {
    width: 80px;
    height: 4px;
    cursor: pointer;
    border-radius: 2px;
    outline: none;
    background: #444444;
    -webkit-appearance: none;
    appearance: none;
  }
  .pr-zoom-slider::-webkit-slider-thumb {
    width: 12px;
    height: 12px;
    cursor: pointer;
    border-radius: 50%;
    background: #AAAAAA;
    -webkit-appearance: none;
    appearance: none;
  }
  .pr-right-group {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .pr-segment-bounds {
    font-family: monospace;
    font-size: 12px;
    color: #AAAAAA;
  }
  .pr-timecode {
    font-family: monospace;
    font-size: 14px;
    font-weight: bold;
    color: #E0E0E0;
  }
  .pr-settings-menu {
    position: fixed;
    z-index: 9999;
    display: flex;
    overflow-y: auto;
    flex-direction: column;
    min-width: 260px;
    max-height: 85vh;
    padding: 10px;
    color: #E0E0E0 !important;
    border: 1px solid #555555 !important;
    border-radius: 6px;
    background: #1E1E1E !important;
    box-shadow: 0 4px 24px var(--shadow-color);
    gap: 8px;
  }
  .pr-settings-title {
    font-size: 11px;
    font-weight: 600;
    margin-bottom: 2px;
    padding-bottom: 4px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #AAAAAA !important;
    border-bottom: 1px solid #3A3A3A;
  }
  .pr-settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .pr-settings-label {
    font-size: 12px;
    flex: 1;
    white-space: nowrap;
    color: #CCCCCC !important;
  }
  .pr-settings-field {
    font-size: 12px;
    box-sizing: border-box;
    padding: 4px 6px;
    cursor: pointer;
    color: #E0E0E0 !important;
    border: 1px solid #4A4A4A !important;
    border-radius: 4px;
    outline: none;
    background: #2C2C2C !important;
  }
  .pr-settings-field:focus {
    border-color: #6A6AAA !important;
  }
  .pr-settings-field option {
    color: #E0E0E0;
    background: #2C2C2C;
  }

  .pr-settings-field.pr-text-input, .pr-settings-field.pr-select{
  width: 100%;
  }  
 
  
  .pr-settings-field.pr-number-input{
  width: 70px;
  text-align: center;
  }
  
  .pr-text-input{
    width: 70px;
    text-align: center;
    }
    
  .pr-number-control {
    display: flex;
    overflow: hidden;
    align-items: center;
    border: 1px solid #444444;
    border-radius: 4px;
    background: #2A2A2A;
  }
  .pr-number-btn {
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 22px;
    cursor: pointer;
    user-select: none;
    transition: background 0.15s;
    color: #AAAAAA;
    border: none;
    background: #333333;
  }
  .pr-number-btn:hover {
    color: #FFFFFF;
    background: #444444;
  }
  .pr-settings-input {
    font-family: monospace;
    font-size: 12px;
    width: 50px;
    height: 22px;
    padding: 0 4px;
    text-align: center;
    color: #E0E0E0;
    border: none;
    outline: none;
    background: transparent;
    -moz-appearance: textfield;
  }
  .pr-settings-input::-webkit-outer-spin-button,
  .pr-settings-input::-webkit-inner-spin-button {
    margin: 0;
    -webkit-appearance: none;
  }
  .pr-settings-select {
    font-size: 12px;
    width: 98px;
    padding: 3px 4px;
    cursor: pointer;
    color: #E0E0E0;
    border: 1px solid #444444;
    border-radius: 4px;
    background: #2A2A2A;
  }
  .pr-settings-divider {
    margin: 2px 0;
    border: none;
    border-top: 1px solid #2A2A2A;
  }
  .pr-settings-toggle-btn {
    font-size: 11px;
    width: 100%;
    padding: 5px 8px;
    cursor: pointer;
    transition: all 0.15s;
    text-align: center;
    color: #AAAAAA;
    border: 1px solid #333333;
    border-radius: 4px;
    background: #252525;
  }
  .pr-settings-toggle-btn:hover {
    color: #CCCCCC;
    border-color: #555555;
    background: #2E2E2E;
  }
  .pr-settings-close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    cursor: pointer;
    transition: all 0.15s;
    color: #888888;
    border: none;
    border-radius: 4px;
    background: transparent;
  }
  .pr-settings-close-btn:hover {
    color: #FFFFFF;
    background: rgba(255,255,255,0.1);
  }
.pr-segmented-control {
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    height: 28px; /* Matches the other toolbar buttons */
    padding: 3px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: #151515; /* Dark background to make the active state pop */
  }
  .pr-segment {
    font-size: 11px;
    font-weight: 600;
    line-height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 12px;
    cursor: pointer;
    user-select: none;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    color: #777777;
    border-radius: 4px;
  }
  .pr-segment.active {
    color: #FFFFFF;
    background: #3A3A6E; /* Gives it a nice highlighted tint */
    box-shadow: 0 1px 3px rgba(0,0,0,0.5);
  }
  .pr-segment:hover:not(.active) {
    color: #EEEEEE;
    background: #252525;
  }
  /* --- Loading Overlay --- */
    .pr-overlay {
      font-size: 13px;
      font-weight: 600; position: absolute; z-index: 1000; top: 0;
      right: 0;
      bottom: 0;
      left: 0;
      display: none; /* Hidden by default */
      align-items: center;
      flex-direction: column;
      justify-content: center;
      letter-spacing: 0.5px;
      color: #B0B0FF;
      border-radius: 6px;
      background: rgba(15, 15, 20, 0.75);
      backdrop-filter: blur(4px);
    }
    .pr-spinner {
      width: 28px;
      height: 28px;
      margin-bottom: 12px;
      animation: pr-spin 1s linear infinite;
      border: 3px solid rgba(176, 176, 255, 0.2);
      border-top-color: #B0B0FF;
      border-radius: 50%;
    }
    
    .pr-audio-mode-wrapper{
    display: flex;
    align-items: center;
    margin-right:6px;
    gap: 6px;
    }
    
    .pr-audio-label{
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.5px;
    color: #888888;
    }
    
    @keyframes pr-spin {
      to { transform: rotate(360deg); }
    }
  @keyframes pr-pulse {
      0% { opacity: 1; }
      50% { opacity: 0.4; }
      100% { opacity: 1; }
    }
    .pr-btn-generating {
      animation: pr-pulse 1.5s ease-in-out infinite;
      pointer-events: none;
    }


`;
