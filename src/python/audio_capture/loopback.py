#!/usr/bin/env python3
"""
Windows audio capture sidecar for AI Conversation Copilot.

Streams PCM16 mono 16 kHz audio to stdout so the Electron main process can run
VAD + STT without native Node addons.

Usage:
  python loopback.py stream --mode loopback --device default
  python loopback.py stream --mode mic --device default
  python loopback.py devices
  python loopback.py probe --mode loopback --seconds 2

Protocol
--------
stream mode  : raw PCM16 LE frames on stdout (chunk-ms per write).
              JSON event lines on stderr (`started` / `level` / `silent` / `error`).
devices mode : one JSON array on stdout.
probe mode   : one JSON object on stdout describing whether real signal arrived.

WASAPI loopback captures whatever the *default playback device* is playing, so
it works with any application (browsers, Bilibili, VLC, meetings, games) without
per-app configuration — as long as that app outputs to the same device.
"""

import argparse
import contextlib
import json
import math
import sys
import time


# --------------------------------------------------------------------------- #
# stdio helpers
# --------------------------------------------------------------------------- #

def configure_stdio() -> None:
    """Force UTF-8 so Chinese device names survive the pipe on Windows."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - older interpreters
            pass


def emit_error(message: str) -> None:
    # Keep the legacy "ERROR:" prefix (the main process matches on it) *and*
    # send a structured line so the UI can show something actionable.
    sys.stderr.write(f"ERROR: {message}\n")
    sys.stderr.write(json.dumps({"event": "error", "message": message}, ensure_ascii=False) + "\n")
    sys.stderr.flush()


def emit_event(payload: dict) -> None:
    sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stderr.flush()


# --------------------------------------------------------------------------- #
# device resolution
# --------------------------------------------------------------------------- #

def _loopback_devices(sc):
    try:
        return [
            device
            for device in sc.all_microphones(include_loopback=True)
            if getattr(device, "isloopback", False)
        ]
    except Exception:  # noqa: BLE001
        return []


def _base_name(name: str) -> str:
    """`扬声器 (2- Realtek(R) Audio)` -> `扬声器` so names can be compared."""
    return (name or "").split(" (")[0].strip().lower()


def resolve_loopback(sc, device_id: str | None):
    """Pick the capture endpoint that echoes the default speaker's output."""
    if device_id and device_id != "default":
        return sc.get_microphone(device_id, include_loopback=True)

    loopbacks = _loopback_devices(sc)
    if not loopbacks:
        raise RuntimeError(
            "系统里没有找到可用的“系统声音”回环设备。请确认扬声器/耳机已连接并在系统中启用。"
        )

    # 1) Exact id of the default speaker (soundcard exposes loopbacks under it).
    try:
        speaker = sc.default_speaker()
        for device in loopbacks:
            if device.id == speaker.id:
                return device
        # 2) Same friendly name, e.g. "扬声器" vs "扬声器 (2- Realtek(R) Audio)".
        speaker_base = _base_name(getattr(speaker, "name", ""))
        if speaker_base:
            for device in loopbacks:
                if _base_name(device.name) == speaker_base:
                    return device
    except Exception:  # noqa: BLE001 - no default speaker configured
        pass

    # 3) Anything that loops back is better than silence.
    return loopbacks[0]


def resolve_microphone(sc, device_id: str | None):
    if device_id and device_id != "default":
        return sc.get_microphone(device_id, include_loopback=False)
    return sc.default_microphone()


# --------------------------------------------------------------------------- #
# system volume / mute  (只用于诊断)
# --------------------------------------------------------------------------- #

_ENDPOINT_VOLUME_IID = "{5CDF2C82-841E-4546-9722-0CF74078229A}"
_DEVICE_ENUMERATOR_CLSID = "{BCDE0395-E52F-467C-8E3D-C4579291692E}"
_DEVICE_ENUMERATOR_IID = "{A95664D2-9614-4F35-A746-DE8DB63617E6}"
_CLSCTX_ALL = 0x17
_COINIT_APARTMENTTHREADED = 0x2


def read_endpoint_volume():
    """读默认播放设备的音量（0..1）与静音标志，读不到就返回 None。

    为什么值得读：WASAPI 回环是在端点音量 / 静音**之前**取样的 —— 本项目实测过
    （音量拧到 2%、甚至点了静音，采到的电平与满音量相差不到 1%），所以系统静音
    **不会**影响识别。把这两个值报给界面，用户才能一眼看到「我明明是静音的，
    它却照样听得见」；否则他会把「没字幕」归罪于自己点了静音，转而去折腾一个
    根本不是问题的地方。

    纯 ctypes 调 COM，不引入新依赖。任何一步失败都安静返回 None —— 这只是
    锦上添花的诊断，绝不能因为它把采集本身搞坏。
    """
    try:
        import ctypes
        from ctypes import byref, c_float, c_uint, c_void_p, wintypes

        ole32 = ctypes.WinDLL("ole32")
        ole32.CLSIDFromString.restype = ctypes.c_long
        ole32.CoCreateInstance.restype = ctypes.c_long
        ole32.CoInitializeEx.restype = ctypes.c_long

        class Guid(ctypes.Structure):
            _fields_ = [
                ("Data1", ctypes.c_ulong),
                ("Data2", ctypes.c_ushort),
                ("Data3", ctypes.c_ushort),
                ("Data4", ctypes.c_ubyte * 8),
            ]

        def make_guid(text):
            value = Guid()
            ole32.CLSIDFromString(ctypes.c_wchar_p(text), byref(value))
            return value

        def method(ptr, index, restype, *argtypes):
            table = ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(c_void_p))).contents
            return ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)(table[index])

        # 线程可能已经被别的库初始化成另一种公寓模型，这里刻意不检查返回值。
        ole32.CoInitializeEx(None, _COINIT_APARTMENTTHREADED)

        enumerator = c_void_p()
        if (
            ole32.CoCreateInstance(
                byref(make_guid(_DEVICE_ENUMERATOR_CLSID)),
                None,
                _CLSCTX_ALL,
                byref(make_guid(_DEVICE_ENUMERATOR_IID)),
                byref(enumerator),
            )
            != 0
        ):
            return None

        device = c_void_p()
        get_default = method(
            enumerator, 4, ctypes.c_long, ctypes.c_int, ctypes.c_int, ctypes.POINTER(c_void_p)
        )
        # eRender = 0, eConsole = 0
        if get_default(enumerator, 0, 0, byref(device)) != 0:
            return None

        volume = c_void_p()
        activate = method(
            device,
            3,
            ctypes.c_long,
            ctypes.POINTER(Guid),
            c_uint,
            c_void_p,
            ctypes.POINTER(c_void_p),
        )
        if activate(device, byref(make_guid(_ENDPOINT_VOLUME_IID)), _CLSCTX_ALL, None, byref(volume)) != 0:
            return None

        scalar = c_float()
        method(volume, 9, ctypes.c_long, ctypes.POINTER(c_float))(volume, byref(scalar))
        muted = wintypes.BOOL()
        method(volume, 15, ctypes.c_long, ctypes.POINTER(wintypes.BOOL))(volume, byref(muted))
        return {"volume": round(float(scalar.value), 3), "mute": bool(muted.value)}
    except Exception:  # noqa: BLE001
        return None


def endpoint_volume_fields() -> dict:
    """给 probe / started 事件用的两个字段（读不到就是空字典）。"""
    info = read_endpoint_volume()
    if not info:
        return {}
    return {"systemVolume": info["volume"], "systemMute": info["mute"]}


# --------------------------------------------------------------------------- #
# recorder negotiation
# --------------------------------------------------------------------------- #

def candidate_formats(preferred_rate: int, preferred_channels: int):
    """Ordered fallbacks: some drivers reject 16 kHz shared-mode capture."""
    out = []
    seen = set()
    for rate in (preferred_rate, 48000, 44100, 32000):
        for channels in (preferred_channels, 1):
            key = (rate, channels)
            if key in seen:
                continue
            seen.add(key)
            out.append(key)
    return out


def open_recorder(device, rate: int, channels: int, frames: int):
    """Open a recorder, verifying that the very first read actually works."""
    recorder = device.recorder(samplerate=rate, channels=channels, blocksize=frames)
    recorder.__enter__()
    try:
        probe = recorder.record(numframes=max(1, frames))
        if probe is None:
            raise RuntimeError("first read returned nothing")
        return recorder
    except Exception:
        with contextlib.suppress(Exception):
            recorder.__exit__(None, None, None)
        raise


def negotiate(device, preferred_rate: int, preferred_channels: int, frames: int):
    """Return (recorder, rate, channels) using the first format that opens."""
    attempts = []
    for rate, channels in candidate_formats(preferred_rate, preferred_channels):
        try:
            recorder = open_recorder(device, rate, channels, frames)
            return recorder, rate, channels, attempts
        except Exception as error:  # noqa: BLE001
            attempts.append(f"{rate}Hz/{channels}ch: {error}")
    raise RuntimeError("无法以任何采样率打开该设备 —— " + "; ".join(attempts[-3:]))


# --------------------------------------------------------------------------- #
# dsp
# --------------------------------------------------------------------------- #

def frames_to_mono(data):
    import numpy as np

    if data.ndim == 1:
        return data.astype("float32")
    return data.mean(axis=1).astype("float32")


def _lowpass_fir(signal, source_rate: int, cutoff_hz: float):
    """加窗 sinc 低通（Hamming），用来在降采样前砍掉超过目标 Nyquist 的成分。

    不用 scipy 也能做：sinc 窗函数乘 Hamming 窗，33 抽头对语音已经足够，
    单块（100 ms）的卷积量在 numpy 里可以忽略。
    """
    import numpy as np

    taps = 33
    index = np.arange(taps) - (taps - 1) / 2.0
    normalized = float(cutoff_hz) / float(source_rate)
    if normalized <= 0.0 or normalized >= 0.5:
        return signal
    window = 0.54 - 0.46 * np.cos(2.0 * np.pi * np.arange(taps) / (taps - 1))
    kernel = 2.0 * normalized * np.sinc(2.0 * normalized * index) * window
    total = float(np.sum(kernel))
    if total == 0.0:
        return signal
    kernel = (kernel / total).astype("float32")
    return np.convolve(signal, kernel, mode="same").astype("float32")


def to_16k_mono(data, source_rate: int):
    """任意采样率的采集块 -> float32 单声道 16 kHz。

    为什么不能只做线性插值：48 kHz 里 8 kHz 以上的成分在 16 kHz 下会「折叠」
    回人声频段（混叠），听起来只是略微发闷，但语音识别率会明显下降——这正是
    「能听到声音、字幕却老是不准」的一个隐蔽原因。所以这里先做抗混叠低通，
    再降采样。

    返回 float32（-1..1），交给调用方决定怎么量化。
    """
    import numpy as np

    mono = frames_to_mono(data)
    if len(mono) == 0 or source_rate == 16000:
        return mono

    # 16 kHz 的 Nyquist 是 8 kHz，留一点过渡带取 7.2 kHz。
    mono = _lowpass_fir(mono, source_rate, 7200.0)

    ratio = float(source_rate) / 16000.0
    step = int(round(ratio))
    if step >= 2 and abs(ratio - step) < 1e-6:
        usable = (len(mono) // step) * step
        if usable <= 0:
            return np.zeros(0, dtype="float32")
        # 盒式平均再做一次轻度平滑，同时完成抽取。
        return mono[:usable].reshape(-1, step).mean(axis=1).astype("float32")

    target_len = int(len(mono) / ratio)
    if target_len <= 0:
        return np.zeros(0, dtype="float32")
    source_index = np.linspace(0.0, len(mono) - 1.0, num=len(mono))
    target_index = np.linspace(0.0, len(mono) - 1.0, num=target_len)
    return np.interp(target_index, source_index, mono).astype("float32")


def resample_to_16k_mono(data, source_rate: int) -> bytes:
    """data: numpy float32 (frames, channels) -> mono int16 @16 kHz bytes."""
    import numpy as np

    mono = to_16k_mono(data, source_rate)
    if len(mono) == 0:
        return b""
    return (np.clip(mono, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def measure(data) -> tuple[float, float]:
    """(rms, peak) in 0..1 for a raw capture block."""
    import numpy as np

    mono = frames_to_mono(data)
    if len(mono) == 0:
        return 0.0, 0.0
    rms = float(np.sqrt(np.mean(np.square(mono))))
    peak = float(np.max(np.abs(mono)))
    return rms, peak


def to_db(value: float) -> float:
    if value <= 0:
        return -120.0
    return round(20.0 * math.log10(value), 1)


def clean_pcm(data, source_rate: int, sensitivity: float, peak_gain: bool) -> bytes:
    """降采样到 16k 单声道，并施加「不会削顶」的自适应增益。

    旧实现是 `clip(mono * sensitivity)`：音量一大波形就被削成方波，谐波失真
    会让识别率不升反降（用户反馈「准确率只有 60% 多」的原因之一）。
    现在增益是自适应的：

        gain = min(sensitivity, 0.97 / peak)

    安静的对白按灵敏度放大（VAD 更容易触发），一旦峰值接近满刻度就自动收手；
    任何情况下都不会削顶。
    """
    import numpy as np

    mono = to_16k_mono(data, source_rate)
    if len(mono) == 0:
        return b""

    peak = float(np.max(np.abs(mono)))
    gain = float(sensitivity) if sensitivity else 1.0
    if peak > 0.0:
        gain = min(gain, 0.97 / peak)
    else:
        gain = 1.0
    if gain != 1.0:
        mono = mono * gain

    # 兜底（正常路径下不会是截断，只是防止意外数值越界）。
    mono = np.clip(mono, -1.0, 1.0)
    return (mono * 32767.0).astype("<i2").tobytes()


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #

def cmd_devices(_args) -> int:
    try:
        import soundcard as sc
    except Exception as error:  # noqa: BLE001
        emit_error(f"soundcard import failed: {error}")
        return 1

    default_speaker_id = None
    default_mic_id = None
    with contextlib.suppress(Exception):
        default_speaker_id = sc.default_speaker().id
    with contextlib.suppress(Exception):
        default_mic_id = sc.default_microphone().id

    devices = []
    try:
        for device in sc.all_microphones(include_loopback=True):
            is_loopback = bool(getattr(device, "isloopback", False))
            devices.append(
                {
                    "id": device.id,
                    "name": device.name,
                    "kind": "system" if is_loopback else "mic",
                    "channels": getattr(device, "channels", 1),
                    "isDefault": device.id in (default_speaker_id, default_mic_id),
                }
            )
    except Exception as error:  # noqa: BLE001
        emit_error(f"device enumeration failed: {error}")
        return 1

    json.dump(devices, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


def cmd_probe(args) -> int:
    """Record a couple of seconds and report whether real signal arrived.

    This is the single most useful diagnostic for "the app hears nothing":
    it separates *capture broken* from *speech recognition broken*.
    """
    result = {
        "ok": False,
        "mode": args.mode,
        "device": "",
        "deviceId": "",
        "rate": 0,
        "channels": 0,
        "rms": 0.0,
        "peak": 0.0,
        "db": -120.0,
        "durationMs": int(args.seconds * 1000),
        "hasSignal": False,
        "attempts": [],
        "message": "",
    }
    # 端点音量 / 静音：读得到就一并带上。这两个值只是给界面看的 ——
    # 实测证明系统静音**不影响**回环采集，报出来是为了让用户不必怀疑它。
    result.update(endpoint_volume_fields())
    try:
        import soundcard as sc
    except Exception as error:  # noqa: BLE001
        result["message"] = f"soundcard 不可用：{error}"
        print(json.dumps(result, ensure_ascii=False))
        return 1

    try:
        if args.mode == "loopback":
            device = resolve_loopback(sc, args.device)
        else:
            device = resolve_microphone(sc, args.device)
    except Exception as error:  # noqa: BLE001
        result["message"] = str(error)
        print(json.dumps(result, ensure_ascii=False))
        return 2

    result["device"] = device.name
    result["deviceId"] = device.id

    chunk_ms = 100
    peak_rms = 0.0
    peak_peak = 0.0
    recorder = None
    try:
        recorder, rate, channels, attempts = negotiate(
            device, args.rate, args.channels, int(args.rate * chunk_ms / 1000)
        )
        result["rate"] = rate
        result["channels"] = channels
        result["attempts"] = attempts

        deadline = time.time() + args.seconds
        while time.time() < deadline:
            data = recorder.record(numframes=int(rate * chunk_ms / 1000))
            if data is None or len(data) == 0:
                continue
            rms, peak = measure(data)
            peak_rms = max(peak_rms, rms)
            peak_peak = max(peak_peak, peak)

        result["rms"] = round(peak_rms, 6)
        result["peak"] = round(peak_peak, 6)
        result["db"] = to_db(peak_rms)
        result["hasSignal"] = peak_rms >= args.silence_rms
        result["ok"] = True
        if not result["hasSignal"]:
            # 刻意不提「音量 / 静音」：实测证明这两者都不影响回环采集，
            # 提了反而把人引到错误的方向上去。
            result["message"] = (
                "设备已打开，但没有收到任何声音。请确认正在播放、播放软件自己"
                "没有静音、且它的输出设备与系统默认扬声器一致。"
            )
    except Exception as error:  # noqa: BLE001
        result["message"] = str(error)
    finally:
        if recorder is not None:
            with contextlib.suppress(Exception):
                recorder.__exit__(None, None, None)

    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 3


def cmd_stream(args) -> int:
    try:
        import soundcard as sc
    except Exception as error:  # noqa: BLE001
        emit_error(f"soundcard import failed: {error}")
        return 1

    try:
        if args.mode == "loopback":
            device = resolve_loopback(sc, args.device)
        else:
            device = resolve_microphone(sc, args.device)
    except Exception as error:  # noqa: BLE001
        emit_error(str(error))
        return 2

    if device is None:
        emit_error("没有可用的采集设备")
        return 2

    frames_per_chunk = int(args.rate * args.chunk_ms / 1000)
    recorder = None
    try:
        recorder, rate, channels, attempts = negotiate(
            device, args.rate, args.channels, frames_per_chunk
        )
    except Exception as error:  # noqa: BLE001
        emit_error(str(error))
        return 3

    emit_event(
        {
            "event": "started",
            "mode": args.mode,
            "device": device.name,
            "deviceId": device.id,
            "rate": rate,
            "channels": channels,
            "attempts": attempts,
            **endpoint_volume_fields(),
        }
    )

    level_interval = args.level_ms / 1000.0
    last_level_at = 0.0
    loudest_rms = 0.0
    silent_since = time.time()
    silent_reported = False
    captured = 0.0

    try:
        while True:
            data = recorder.record(numframes=int(rate * args.chunk_ms / 1000))
            if data is None or len(data) == 0:
                continue

            rms, peak = measure(data)
            pcm = clean_pcm(data, rate, args.sensitivity, False)
            if pcm:
                sys.stdout.buffer.write(pcm)
                sys.stdout.buffer.flush()
            captured += args.chunk_ms / 1000.0

            loudest_rms = max(loudest_rms, rms)
            now = time.time()

            if rms >= args.silence_rms:
                silent_since = now
                silent_reported = False

            if now - last_level_at >= level_interval:
                emit_event(
                    {
                        "event": "level",
                        "rms": round(rms, 6),
                        "peak": round(peak, 6),
                        "db": to_db(rms),
                        "capturedSeconds": round(captured, 1),
                        "speaking": rms >= args.speech_rms,
                    }
                )
                last_level_at = now

            # One explicit "I hear nothing at all" alert, so the UI can say
            # something smarter than an empty list of subtitles.
            if (
                not silent_reported
                and now - silent_since >= args.silent_alert_s
                and loudest_rms < args.silence_rms
            ):
                silent_reported = True
                emit_event(
                    {
                        "event": "silent",
                        "seconds": round(now - silent_since, 1),
                        "device": device.name,
                    }
                )
    except KeyboardInterrupt:
        return 0
    except Exception as error:  # noqa: BLE001
        emit_error(f"capture failed: {error}")
        return 4
    finally:
        if recorder is not None:
            with contextlib.suppress(Exception):
                recorder.__exit__(None, None, None)
    return 0


def main() -> int:
    configure_stdio()
    parser = argparse.ArgumentParser(description="WASAPI loopback capture sidecar")
    subparsers = parser.add_subparsers(dest="command", required=True)

    stream = subparsers.add_parser("stream", help="stream PCM16 to stdout")
    stream.add_argument("--mode", choices=["loopback", "mic"], default="loopback")
    stream.add_argument("--device", default="default")
    stream.add_argument("--rate", type=int, default=16000)
    stream.add_argument("--channels", type=int, default=2)
    stream.add_argument("--chunk-ms", type=int, default=100)
    stream.add_argument("--level-ms", type=float, default=200.0)
    stream.add_argument("--sensitivity", type=float, default=1.0)
    stream.add_argument("--silence-rms", type=float, default=0.0015)
    stream.add_argument("--speech-rms", type=float, default=0.01)
    stream.add_argument("--silent-alert-s", type=float, default=5.0)
    stream.set_defaults(func=cmd_stream)

    devices = subparsers.add_parser("devices", help="list capture devices as JSON")
    devices.set_defaults(func=cmd_devices)

    probe = subparsers.add_parser("probe", help="record briefly and report signal level")
    probe.add_argument("--mode", choices=["loopback", "mic"], default="loopback")
    probe.add_argument("--device", default="default")
    probe.add_argument("--rate", type=int, default=16000)
    probe.add_argument("--channels", type=int, default=2)
    probe.add_argument("--seconds", type=float, default=2.0)
    probe.add_argument("--silence-rms", type=float, default=0.0015)
    probe.set_defaults(func=cmd_probe)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
