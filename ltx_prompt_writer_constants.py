# ---------------------------------------------------------------------------
# Model registry
# ---------------------------------------------------------------------------

VISION_MODELS = {
    "Qwen2.5-VL-3B — Fast": "huihui-ai/Qwen2.5-VL-3B-Instruct-abliterated",
    "Qwen2.5-VL-7B — Best quality": "prithivMLmods/Qwen2.5-VL-7B-Abliterated-Caption-it",
}
_PROMPT_INTRO = """
You are an expert cinematographer and prompt writer for LTX-Video 2.3, a state-of-the-art AI video generation model.
Write a single scene description optimised for video generation following those guidelines: 
"""

_OUTPUT_FORMAT = """
## Output Format:

Output ONLY the description, no titles, no analysis, no preamble.

### For Best Results

- Write the scene description as a single flowing paragraph
- Use present tense verbs for action and movement
- Match the level of detail to the shot scale
- (close-ups need more detail than wide shots)
- Describe camera movement relative to the subject
- Aim for 4–8 descriptive sentences
"""

_RULES = """
## Rules

### Key Elements to Include

1. Establish the SHOT
Use cinematography terms that match your intended genre. Include shot scale or category-specific characteristics to refine the visual style.

2. Set the SCENE
Describe lighting conditions, color palette, surface textures, and atmosphere to establish mood and tone.
location, lighting, time of day, atmosphere, textures, dominant colors

3. Describe the ACTION
Write the core action as a natural sequence, flowing clearly from beginning to end.
Motion: What is happening or about to happen in the scene

4. Define the CHARACTER(S)/SUBJECT(s)
Include age, hairstyle, clothing, and distinguishing features. Express emotion through physical cues, not abstract labels.
physical appearance, clothing, pose, expression

5. Identify CAMERA MOVEMENT(S)
Specify how and when the camera moves. Describing how subjects appear after the movement helps the model complete the motion accurately.
- angle, distance, suggested movement (e.g. slow dolly, static wide, gentle pan)

6. Describe the AUDIO
Clearly describe ambient sound, music, speech, or singing.

TIPP: Place spoken dialogue in quotation marks. Specify language and accent if needed

### What Works Well

Cinematic compositions: Wide, medium, and close-up shots with thoughtful lighting, shallow depth of field, and natural motion
Emotive human moments: Strong single-subject emotional expressions, subtle gestures, and facial nuance
Atmosphere & setting: Fog, mist, golden-hour light, rain, reflections, ambient textures
Clear camera language: Explicit instructions like “slow dolly in” or “handheld tracking”
Stylized aesthetics: Painterly, noir, analog film, fashion editorial, pixelated animation
Lighting & mood control: Backlighting, color palettes, rim light, flickering lamps
Voice: Characters can talk and sing in multiple languages

### What to Avoid - Why It Doesn’t Work

Internal emotional states - Use visual cues instead of labels like “sad” or “confused”
Text and logos - Readable text is not currently reliable
Complex physics - Chaotic motion can introduce artifacts (dancing is OK)
Overloaded scenes - Too many characters or actions reduce clarity
Conflicting lighting - Mixed light logic confuses scene interpretation
"""

_EXAMPLE = """
The camera opens in a calm, sunlit frog yoga studio. Warm morning light washes over the wooden floor as incense smoke drifts lazily in the air. The senior frog instructor sits cross-legged at the center, eyes closed, voice deep and calm. “We are one with the pond.” All the frogs answer softly: “Ommm…” “We are one with the mud.” “Ommm…” He smiles faintly. “We are one with the flies.” A pause. The camera pans to the side towards one frog who twitches, eyes darting. Suddenly its tongue snaps out, catching a fly mid-air and pulling it into its mouth. The master exhales slowly, still serene. “But we do not chase the flies…” Beat. “not during class.” The guilty frog lowers its head in shame, folding its hands back into a meditative pose. The other frogs resume their chant: “Ommm…” Camera holds for a moment on the embarrassed frog, eyes closed too tightly, pretending nothing happened.
"""

VISION_SYSTEM_PROMPT = (
    _PROMPT_INTRO
    + "Analyze the image to use it with your scene description.\n\n"
    + _OUTPUT_FORMAT
    + _RULES
    + "- NEVER repeat already present and visible features from the image like style, hair color, appearance etc. This creates duplicated content. Focus on scene description that is NOT visible.\n"
    + "\n\n"
    + _EXAMPLE
    + "\n\n"
)

TEXT_ONLY_SYSTEM_PROMPT = (
    "/no_think\n" + _PROMPT_INTRO + _OUTPUT_FORMAT + _RULES + "\n\n" + _EXAMPLE + "\n\n"
)

# ---------------------------------------------------------------------------
# Style presets
# ---------------------------------------------------------------------------
# Each entry: "Preset name": "Full style instruction injected into the prompt."
# Add new presets here — the JS dropdown is populated automatically via the
# /whatdreamscost/style_presets endpoint; no JS edits needed.
#
# Style preset texts adapted from landon2022/LTX2EasyPrompt-LD
# https://github.com/landon2022/LTX2EasyPrompt-LD
# ---------------------------------------------------------------------------
_NONE_STYLE_LABEL = "None — let VLM decide"
STYLE_PRESETS: dict[str, str] = {
    _NONE_STYLE_LABEL: "",
    "Cinematic — Drama": (
        """
STYLE: Cinematic drama. Intimate, character-driven. Shallow depth of field — subject sharp, world behind them soft. 
COLOR GRADE: cool shadows, warm skin tones, restrained palette. 
CAMERA: medium close-ups and close-ups dominate. Moves are slow and purposeful — a slow push-in on a face, a rack focus between two people, a static hold that lets the actor breathe. 
LIGHTING: motivated practical sources — a lamp, a window, a candle. Never flat.
"""
    ),
    "Cinematic — Epic": (
        "STYLE: Epic cinematic. Scale and environment are the protagonist. "
        "Wide establishing shots and vast compositions that make people feel small against the world. "
        "Camera: sweeping crane moves, slow lateral tracking shots, long pulls across terrain. "
        "Colour grade: rich, contrasty — deep shadows, luminous highlights. "
        "Every frame should feel like a poster. Build depth with foreground elements. "
        "Natural motion blur on all movement."
    ),
    "Cinematic — Intimate close-up": (
        "STYLE: Intimate close-up cinema. The entire world is a face, a hand, a detail. "
        "Razor-thin depth of field — one eye sharp, the other already soft. Bokeh is smooth and organic. "
        "Framing: extreme close-ups only — fill the frame with a face or a single feature. "
        "Camera: barely moves — micro drifts and imperceptible breathing movement. "
        "Colour grade: skin-tone faithful, warm and close. Lighting: one soft source, one fill, nothing else."
    ),
    "Slow-burn thriller": (
        "STYLE: Slow-burn psychological thriller. Tight framing, long held shots, shallow depth of field. "
        "Colour palette: desaturated teal and amber. Camera moves deliberately and slowly. "
        "Tension built through restraint, not action."
    ),
    "Handheld documentary": (
        "STYLE: Handheld documentary. Camera moves with the subject, never static. Slight shake on movement. "
        "Natural available light only — no studio lighting. Colour grade: flat, slightly washed. "
        "Intimate and observational — camera follows, never leads."
    ),
    "Horror — desaturated, harsh contrast": (
        "STYLE: Horror. Heavily desaturated colour, crushed blacks. Harsh top-down or under-lighting. "
        "Camera movements are slow and uneasy — never reassuring. "
        "Framing leaves negative space — empty doorways, dark corners. No warmth in the image."
    ),
    "Golden hour drama": (
        "STYLE: Golden hour drama. Warm amber and orange light from a low sun. Heavy lens flare. "
        "Soft shadows, glowing skin tones. Wide establishing shots and medium shots. "
        "Emotional, sweeping camera movement. Colour grade: warm, slightly overexposed highlights."
    ),
    "Noir — deep shadows, venetian light": (
        "STYLE: Classic noir. Low-key lighting, venetian blind shadow patterns across faces and walls. "
        "Black and white or heavily desaturated with single colour accent. "
        "Camera angles: low, Dutch tilt, shot through objects. Mood is foreboding and fatalistic."
    ),
    "High fashion editorial": (
        "STYLE: High fashion editorial. Striking, composed frames. Hard directional lighting with deep shadows. "
        "Colour palette: high contrast, often monochrome or single accent colour. "
        "Movement is deliberate and posed — model-aware. Camera movements are slow and precise. "
        "Apply the editorial aesthetic to whatever location the user specified."
    ),
    "Music video — stylised": (
        "STYLE: Music video. Rhythm-cut visual language — movement is driven by the beat. "
        "High contrast colour grade with stylised palette. "
        "Mix of tight close-ups and dramatic wide shots. Camera movement is expressive, not documentary. "
        "Film the scene the user described, through a music video camera."
    ),
    "Action blockbuster": (
        "STYLE: Action blockbuster. Fast kinetic energy. Dutch angles, crash zooms, whip pans. "
        "Colour grade: teal and orange, high contrast. "
        "Camera is never still — it moves with every impact. Slow motion inserts on key moments."
    ),
    "Sports documentary": (
        "STYLE: Sports documentary. Tracking shots following the athlete. Telephoto compression. "
        "Slow motion bursts at peak moments. Natural sound — crowd noise, impact, breathing. "
        "Colour grade: clean and neutral. Camera is athletic — it moves like it is competing too."
    ),
    "Dreamy — soft focus, slow motion": (
        "STYLE: Dreamy aesthetic. Soft focus edges with sharp centre. Pastel colour bleed. "
        "Movement is slow — the frame breathes rather than cuts. "
        "Shallow depth of field with heavy bokeh. Light sources bloom and halo."
    ),
    "Lo-fi home video — VHS": (
        "STYLE: Lo-fi home video. VHS tape aesthetic — slightly washed colour, faint scan lines, soft edges. "
        "Colour grade: faded, slightly green-shifted. Camera is handheld and casual. "
        "Intimate domestic setting implied. Imperfection is the aesthetic."
    ),
    "Hyper-real 4K — clinical sharpness": (
        "STYLE: Hyper-real 4K. Clinical sharpness — every texture, pore, and fibre rendered in full detail. "
        "Even lighting, no blown highlights, no crushed blacks. "
        "Camera movement is minimal and precise. The image is almost uncomfortably detailed."
    ),
    "Gritty realism — flat, natural light": (
        "STYLE: Gritty realism. Flat colour grade, no cinematic enhancement. Natural light only — "
        "whatever is available in the location. Camera is direct and unsentimental. "
        "No stylisation. The scene is shot as if it is actually happening."
    ),
    "POV — first person, immersive": (
        "STYLE: First-person POV. The camera IS the viewer's eyes. "
        "Frame moves as a head would — natural breathing movement, slight tilt on turns. "
        "Everything is seen, not watched. Close physical detail — hands, surfaces, faces at speaking distance."
    ),
    "Amateur — naturalistic, raw": (
        "STYLE: Amateur home video aesthetic. Slightly overexposed. Natural indoor lighting — lamps, overhead. "
        "Camera is handheld and slightly uncertain. No cinematic framing. "
        "Colour: ungraded, as-shot. The imperfection is intentional."
    ),
    "Anime — Japanese animation": (
        "STYLE: Japanese anime. Hand-drawn animation aesthetic — clean ink outlines, flat colour fills with "
        "subtle cel shading. Large expressive eyes, stylised facial features. "
        "Colour palette: vivid, high saturation with strong accent colours. "
        "Motion: fluid on key poses, held on reaction shots. "
        "Render every subject in this style regardless of what was described."
    ),
    "2D cartoon — hand-drawn": (
        "STYLE: Classic hand-drawn 2D cartoon. Expressive ink outlines with variable line weight. "
        "Flat colour fills, minimal shading, bold colour palette. "
        "Movement uses squash-and-stretch. Background art is simplified and stylised, never photorealistic. "
        "Render every subject in this style regardless of what was described."
    ),
    "3D CGI — Pixar/DreamWorks": (
        "STYLE: High-end 3D CGI animation in the style of Pixar or DreamWorks. "
        "Subsurface scattering on skin and organic surfaces. Highly detailed surface textures. "
        "Warm, soft three-point lighting with gentle shadows. "
        "Camera: smooth cinematic moves — slow push-ins, arcing lateral tracks. "
        "Colour grade: warm, slightly saturated, storybook palette. "
        "Render every subject in this style regardless of what was described."
    ),
    "Sci-fi — cinematic, practical": (
        "STYLE: Cinematic science fiction. Clean, practical-feeling environments — metal corridors, "
        "reinforced glass, industrial lighting rigs. Colour palette: cool blue-white with accent LEDs. "
        "No fantasy or magic — everything looks functional and built. "
        "Camera: wide establishing shots then close on faces or hands for intimacy. Lens flare on light sources."
    ),
    "Cyberpunk neon illustrated": (
        "STYLE: Cyberpunk illustrated. Neon-lit urban environment — magenta, cyan, electric blue, acid green. "
        "Hard rim lighting from neon signs carves subjects out of near-total darkness. "
        "Rain-slick surfaces reflect light in pools and streaks. "
        "Camera: low angles, wide lenses, dramatic fog and haze."
    ),
    "Comic book / graphic novel": (
        "STYLE: Comic book or graphic novel. Bold ink outlines, halftone dot patterns in shadow areas. "
        "Colour is flat with hard-edged shadows. Speed lines radiate from points of impact. "
        "Camera moves like a comic panel transition — hard cuts between angles, no smooth motion blur. "
        "Render every subject in this style regardless of what was described."
    ),
    "Erotic cinema — tasteful, cinematic": (
        "STYLE: Tasteful erotic cinema. Warm, intimate lighting — practical sources only. "
        "Shallow depth of field. Camera moves slowly and deliberately. "
        "Colour grade: warm skin tones, soft highlights. "
        "Sensual but not pornographic — implication over explicit detail. Slow, breathing pace. "
        "Describe only what was asked for — the style wraps it, it does not expand it."
    ),
    "Explicit — direct, anatomical": (
        "STYLE: Explicit adult content. Direct lighting — bodies clearly lit with no flattering shadow. "
        "Camera is close and functional — shows exactly what is happening without cinematic softening. "
        "No romantic framing. Blunt and specific. Anatomical language used directly. "
        "Describe only what the user requested. Do not add acts or nudity the user did not write."
    ),
    "Voyeur — handheld, observational": (
        "STYLE: Voyeuristic. The camera is a person — someone who found this moment and is trying not to be noticed. "
        "The camera bobs and drifts with the natural sway of someone standing. "
        "The motion is involuntary — slight vertical bounce, gentle lateral drift, micro-rotations. "
        "The camera NEVER repositions to get a better angle. Natural available light only — no fill, no flash. "
        "The subject is unaware. The camera does not announce itself."
    ),
    "Softcore editorial — lingerie-adjacent": (
        "STYLE: Softcore editorial. Fashion-magazine aesthetic. Clean, even lighting. "
        "Colour grade: warm neutrals and soft pastels. "
        "Camera is composed — lingerie-level sensuality, no explicit content. Movement is slow and posed. "
        "Do NOT add undressing, nudity, or intimate acts the user did not ask for."
    ),
    "Gravure Idol — Japanese glamour": (
        "STYLE: Japanese gravure idol photoshoot / glamour video. "
        "Bright, glossy, commercial magazine aesthetic. "
        "High-key natural daylight or clean studio lighting with strong rim light and soft reflector fill. "
        "Vivid yet smooth skin tones, slightly increased saturation, polished and flattering look. "
        "Posing is intentional, playful and seductive: arched back, teasing eye contact. "
        "Camera movement: slow body pan, lingering holds, slow tilt up, push-in as she makes eye contact. "
        "Mood is cute-provocative: youthful charm combined with fan-service energy."
    ),
    "Femdom — verbal domination": (
        "STYLE: Femdom verbal domination. She is the only power in the room. "
        "Camera worships her — low angle looking up, slow orbital arc, close-up on her expression of contempt. "
        "Hard directional lighting — one side of her face in clean harsh light, one in shadow. "
        "Her voice is the dominant sound — every consonant audible. "
        "FORBIDDEN: softness, uncertainty, the dominant losing composure."
    ),
    "Portrait vertical — 9:16 mobile": (
        "STYLE: Native portrait video, 9:16 aspect ratio. Optimised for mobile — TikTok, Reels, Shorts. "
        "Frame is vertical throughout. Tight head-to-torso framing. "
        "Action moves vertically in frame. Camera stays close. No wide horizontal composition."
    ),
    "Selfie — self-shot, arm's length": (
        "STYLE: Self-shot selfie video. The subject is holding the camera themselves — "
        "outstretched arm, camera facing back at them. 9:16 vertical frame. "
        "Tight head-and-shoulders framing. Camera bobs as they move, tilts when they turn their head. "
        "FORBIDDEN: tripod stillness, gimbal smoothness, rack focus, dolly, crane. "
        "Colour: clean and bright, natural available light, no cinematic grade."
    ),
    # ── Add your own presets below this line ─────────────────────────────────
}
