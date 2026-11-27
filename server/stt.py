"""G2 マイクの生 PCM を Groq の Whisper API で文字起こしする。

runtime.py の POST /device/stt から呼ばれる。G2 SDK の audioEvent が送ってくる
16kHz・mono・16bit little-endian の PCM を WAV に包み、Groq の OpenAI 互換
Audio Transcriptions API へ multipart で送る。

xangi-even-g2 の bridge と同じ Groq 方式にそろえたのは、ホストに GPU 常駐の
Whisper を増やさず、既存の API キー運用を流用するため。

環境変数:
    GROQ_API_KEY     必須。Groq API キー
    GROQ_STT_MODEL   任意。既定 whisper-large-v3-turbo
    GTASKS_STT_LANG  任意。既定 ja

副作用:
    音声データを Groq（https://api.groq.com）へ送信する。
"""

from __future__ import annotations

import io
import json
import os
import urllib.error
import urllib.request
import uuid
import wave

GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
DEFAULT_MODEL = "whisper-large-v3-turbo"
# G2 SDK の audioPcm の形式（Even Hub SDK 0.0.14 の仕様、xangi-even-g2 と同じ）。
SAMPLE_RATE_HZ = 16000
SAMPLE_WIDTH_BYTES = 2
# Groq は数秒の音声なら 1 秒前後で返す。回線不調時も G2 を長く待たせないよう 30 秒で切る。
HTTP_TIMEOUT_SEC = 30
# Cloudflare 等が Python urllib の既定 User-Agent を拒否することがあるため明示する。
USER_AGENT = "xangi-google-tasks-stt/0.1"
# 30 秒未満の録音しか想定しないため、16kHz×2byte×120秒 を上限にして誤送信を防ぐ。
MAX_PCM_BYTES = SAMPLE_RATE_HZ * SAMPLE_WIDTH_BYTES * 120
# 0.3 秒未満は誤タップとみなして送らない（16kHz×2byte×0.3秒）。
MIN_PCM_BYTES = int(SAMPLE_RATE_HZ * SAMPLE_WIDTH_BYTES * 0.3)
# 無音・雑音だけの音声で Whisper が出しやすい定型文。YouTube 字幕由来の学習データの癖で、
# 2026-11-27 に無音 1 秒を送って「ご視聴ありがとうございました」が返ることを確認した。
# タスク名としてはまず使わない文なので、完全一致した場合は空文字として扱う。
HALLUCINATION_PHRASES = {
    "ご視聴ありがとうございました",
    "ご視聴ありがとうございました。",
    "ありがとうございました",
    "ありがとうございました。",
    "チャンネル登録よろしくお願いします",
    "おやすみなさい",
}


class SttError(RuntimeError):
    """文字起こしの失敗。message は G2 に表示できる短文にする。"""


def stt_configured() -> bool:
    """GROQ_API_KEY が設定されているかを返す（health 表示用）。"""
    return bool(os.environ.get("GROQ_API_KEY", "").strip())


def pcm_to_wav(pcm: bytes) -> bytes:
    """生 PCM を WAV ファイルのバイト列に変換する。"""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(SAMPLE_WIDTH_BYTES)
        writer.setframerate(SAMPLE_RATE_HZ)
        writer.writeframes(pcm)
    return buffer.getvalue()


def build_multipart(fields: dict[str, str], file_bytes: bytes, boundary: str) -> bytes:
    """multipart/form-data の本文を組み立てる（標準ライブラリだけで送るため自前実装）。"""
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    parts.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
            "Content-Type: audio/wav\r\n\r\n"
        ).encode()
        + file_bytes
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts)


def transcribe_pcm(pcm: bytes) -> str:
    """PCM を文字起こししてテキストを返す。

    Args:
        pcm: 16kHz mono s16le の生 PCM。

    Returns:
        前後の空白を除いた文字起こし結果。短すぎる録音や、無音時の定型誤認識
        （HALLUCINATION_PHRASES）は空文字。

    Raises:
        SttError: API キー未設定、サイズ超過、HTTP エラー、応答不正の場合。
    """
    if len(pcm) < MIN_PCM_BYTES:
        return ""
    if len(pcm) > MAX_PCM_BYTES:
        raise SttError("録音が長すぎます")
    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not api_key:
        raise SttError("GROQ_API_KEY が未設定です")
    boundary = f"----xangi{uuid.uuid4().hex}"
    body = build_multipart(
        {
            "model": os.environ.get("GROQ_STT_MODEL", "").strip() or DEFAULT_MODEL,
            "language": os.environ.get("GTASKS_STT_LANG", "").strip() or "ja",
            "response_format": "json",
        },
        pcm_to_wav(pcm),
        boundary,
    )
    request = urllib.request.Request(
        GROQ_TRANSCRIPTIONS_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SEC) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise SttError(f"STT HTTP {error.code}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise SttError("STT に接続できません") from error
    except ValueError as error:
        raise SttError("STT の応答を解析できません") from error
    text = str(payload.get("text", "")).strip()
    return "" if text in HALLUCINATION_PHRASES else text
