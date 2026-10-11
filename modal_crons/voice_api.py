"""
Modal Voice API for Pocket Personal (k1 P2).

Endpoints:
  POST /tts    {text, secret} -> WAV audio (Henrry's cloned voice, VieNeu v3 Turbo)
  POST /tts_en {text, secret, voice} -> WAV audio (Kokoro-82M, native EN presets)

- VieNeu: CPU inference, voice embedding pre-computed, EQ softening (reduce harsh 4kHz)
- Kokoro: weights baked into image at build time, scale-to-zero
- Deploy via GitHub Actions (deploy-voice-api.yml)

Secrets (Modal dashboard -> Secrets -> "pocket-personal"):
  - VOICE_API_SECRET: bearer token for both endpoints
"""
import modal

# Persistent volume for models + voice embedding
volume = modal.Volume.from_name("voice-clone-vol", create_if_missing=True)

# Image with VieNeu + deps
voice_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install(
        "vieneu",
        "onnxruntime",
        "numpy",
        "scipy",
        "huggingface_hub",
    )
)

app = modal.App("pocket-personal-voice")

# Image with Kokoro-82M (English, native-speaker presets) + deps.
# Weights (~310MB) baked into image at build time.
kokoro_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("espeak-ng", "ffmpeg")
    .pip_install("kokoro", "numpy", "scipy", "soundfile")
    .run_commands("python3 -c \"from kokoro import KPipeline; KPipeline(lang_code='a')\"")
)

# Whitelist Kokoro American-English preset voices (same list as kokoro_local.py)
KOKORO_VOICES = (
    "am_adam", "am_michael", "am_onyx", "am_fenrir", "am_liam",
    "am_echo", "am_eric", "am_puck", "am_santa",
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica",
    "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
)

_KOKORO_PIPELINE = None


def _get_kokoro():
    """Lazy-load Kokoro pipeline (weights already baked into image)."""
    global _KOKORO_PIPELINE
    if _KOKORO_PIPELINE is None:
        from kokoro import KPipeline
        _KOKORO_PIPELINE = KPipeline(lang_code="a")
    return _KOKORO_PIPELINE


def _get_tts():
    """Load VieNeu with local models from volume."""
    from vieneu import Vieneu
    from vieneu._v3_turbo_engine import onnx_runtime_lite
    # Patch codec_dir (same workaround as VM)
    _orig_init = onnx_runtime_lite.OnnxV3LiteEngine.__init__
    def _patched(self, *a, **k):
        k.setdefault("codec_dir", "/data/models/codec")
        return _orig_init(self, *a, **k)
    onnx_runtime_lite.OnnxV3LiteEngine.__init__ = _patched
    return Vieneu(onnx_dir="/data/models/onnx_update")


@app.function(
    image=voice_image,
    volumes={"/data": volume},
    timeout=300,
)
def encode_voice(ref_audio_path: str = "/data/henrry_ref.wav"):
    """One-time: encode Henrry's voice from reference audio, save embedding."""
    import pickle
    tts = _get_tts()
    voice = tts.encode_reference(ref_audio_path, denoise=True)
    with open("/data/henrry_voice.pkl", "wb") as f:
        pickle.dump(voice, f)
    volume.commit()
    return {"ok": True}


@app.function(
    image=voice_image,
    volumes={"/data": volume},
    secrets=[modal.Secret.from_name("pocket-personal")],
    timeout=120,
    # Scale to zero when idle; cold start ~30s (model load)
)
@modal.fastapi_endpoint(method="POST")
def tts(request_data: dict):
    """POST /tts {text, secret} -> WAV audio bytes."""
    import os
    import pickle
    import subprocess
    import tempfile

    # Auth
    secret = request_data.get("secret", "")
    expected = os.environ.get("VOICE_API_SECRET", "")
    if not expected or secret != expected:
        return {"error": "Unauthorized"}, 401

    text = str(request_data.get("text", "")).strip()[:500]
    if not text:
        return {"error": "Missing text"}, 400

    # Load voice embedding
    with open("/data/henrry_voice.pkl", "rb") as f:
        voice = pickle.load(f)

    tts = _get_tts()
    audio = tts.infer(text=text, voice=voice, temperature=0.6, denoise=True)

    # Save raw, then apply EQ softening
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        raw_path = tf.name
    tts.save(audio, raw_path)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        out_path = tf.name
    subprocess.run(
        ["ffmpeg", "-y", "-i", raw_path,
         "-af", "equalizer=f=4000:t=q:w=1:g=-3,equalizer=f=300:t=q:w=1:g=1.5",
         out_path],
        capture_output=True, check=True,
    )
    with open(out_path, "rb") as f:
        wav_bytes = f.read()

    # Return as base64 JSON (Modal web_endpoint serialization)
    import base64
    return {"audio_b64": base64.b64encode(wav_bytes).decode()}


@app.function(
    image=kokoro_image,
    secrets=[modal.Secret.from_name("pocket-personal")],
    timeout=120,
    # Scale to zero when idle; cold start ~20s (torch + weights from image)
)
@modal.fastapi_endpoint(method="POST")
def tts_en(request_data: dict):
    """POST /tts_en {text, secret, voice} -> WAV audio (Kokoro-82M, native EN presets)."""
    import base64
    import io
    import os

    # Auth (same secret as /tts)
    secret = request_data.get("secret", "")
    expected = os.environ.get("VOICE_API_SECRET", "")
    if not expected or secret != expected:
        return {"error": "Unauthorized"}, 401

    text = str(request_data.get("text", "")).strip()[:500]
    if not text:
        return {"error": "Missing text"}, 400
    voice = str(request_data.get("voice", "am_michael")).strip()
    if voice not in KOKORO_VOICES:
        voice = "am_michael"

    import soundfile as sf
    import torch

    pipeline = _get_kokoro()
    chunks = [audio for _, _, audio in pipeline(text, voice=voice)]
    full = torch.cat(chunks, dim=-1) if len(chunks) > 1 else chunks[0]
    buf = io.BytesIO()
    sf.write(buf, full.numpy(), 24000, format="WAV")
    return {"audio_b64": base64.b64encode(buf.getvalue()).decode()}
