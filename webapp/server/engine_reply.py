"""回复建议：云端模型（真实）／人工模板（明确标注，不冒充模型）。

两种来源的界线必须清楚：
- `provider`：模型生成的句子，界面写「AI 生成」；
- `mock`：人工写死的模板句，界面写「模板句」——它同样有用，但它不是 AI。

为什么模板也给三条而不是一条：听障使用者真正需要的是**选择**。
一条「好的，谢谢」既不能确认理解、也不能请对方打字，等于把问题原样还给他。

安全底线（模板与模型提示词里都写了）：不替用户答应任何事、不编造事实。
所以模板里没有「Yes, that works for me」这类替人拍板的句子。
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field

import httpx

LOG = logging.getLogger("copilot.reply")
TIMEOUT = float(os.getenv("COPILOT_UPSTREAM_TIMEOUT", "20"))


class ReplyError(Exception):
    def __init__(self, code: str, status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass
class ReplyResult:
    reply: str
    meaning: str
    mode: str
    elapsed_ms: int
    #: 一到三条候选。`reply` 保留为第一条，兼容只读一个字段的旧调用方。
    suggestions: list[dict] = field(default_factory=list)


class ProviderReply:
    mode = "provider"

    def __init__(self) -> None:
        self.base_url = (os.getenv("COPILOT_LLM_BASE_URL") or "").rstrip("/")
        self.api_key = os.getenv("COPILOT_LLM_API_KEY") or ""
        self.model = os.getenv("COPILOT_LLM_MODEL") or ""
        self.available = bool(self.base_url and self.api_key and self.model)
        self.detail = f"云端模型 {self.model}" if self.available else "未配置模型接口"

    def reply(self, text: str, translation: str) -> ReplyResult:
        started = time.perf_counter()
        system = (
            "You help a hard-of-hearing user reply in English. Given what the other person said, "
            "propose THREE short, polite English sentences the user could say, plus the Chinese "
            "meaning of each. Each must be usable as-is in a real conversation.\n"
            "Rules: never invent facts; never promise or agree on the user's behalf "
            "(no 'Yes, that works for me' unless the other person only asked whether the user heard them); "
            "prefer asking the other person to type, repeat, or confirm.\n"
            'Return strict JSON: {"replies":[{"reply":"...","meaning":"...","kind":"confirm|repeat|ask"}]}'
        )
        payload = {
            "model": self.model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": f"Other person said: {text}\nMy understanding (zh): {translation}"},
            ],
        }
        headers = {"authorization": f"Bearer {self.api_key}", "content-type": "application/json"}
        try:
            with httpx.Client(timeout=TIMEOUT) as client:
                response = client.post(f"{self.base_url}/chat/completions", json=payload, headers=headers)
        except httpx.TimeoutException as error:
            raise ReplyError("UPSTREAM_TIMEOUT", 504) from error
        except httpx.HTTPError as error:
            raise ReplyError("UPSTREAM_ERROR", 502) from error
        if response.status_code >= 400:
            LOG.warning("reply upstream status=%s", response.status_code)
            raise ReplyError("UPSTREAM_ERROR", 502)
        try:
            content = response.json()["choices"][0]["message"]["content"]
            data = json.loads(content)
            items = data.get("replies") or []
            suggestions = []
            for item in items[:3]:
                reply = str(item.get("reply", "")).strip()
                meaning = str(item.get("meaning", "")).strip()
                if not reply:
                    continue
                suggestions.append(
                    {"reply": reply, "meaning": meaning, "kind": str(item.get("kind", "confirm"))}
                )
            if not suggestions:
                raise ValueError("empty")
        except Exception as error:
            raise ReplyError("UPSTREAM_ERROR", 502) from error
        first = suggestions[0]
        return ReplyResult(
            reply=first["reply"],
            meaning=first["meaning"],
            mode=self.mode,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
            suggestions=suggestions,
        )


#: 四条「安全句」。共同点：都不替用户答应、不编造事实，且都能在真实对话里直接说。
TEMPLATE_LINES = {
    "repeat": ("Could you type that in the chat? I'm hard of hearing.", "你能打在聊天框里吗？我听力不太好。"),
    "confirm": ("Let me make sure I got that right.", "我确认一下我没听错。"),
    "ask": ("Let me check and get back to you.", "我查一下再回复你。"),
    "thanks": ("Got it, thanks. I'll follow up if anything is unclear.", "明白了，谢谢。有不清楚的我再问。"),
}


def _is_question(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False
    # 各语言都可能用半角 / 全角问号；问号是最可靠的判据，词首判据只作补充。
    if stripped.endswith(("?", "？")):
        return True
    head = stripped.lower()
    return head.startswith(
        ("what", "why", "how", "when", "where", "who", "can ", "could ", "do ", "does ", "are ", "is ")
    )


def _has_correction(text: str) -> bool:
    lower = text.lower()
    return any(
        token in lower
        for token in ("not ", "n't", "instead", "moved", "changed", "actually", "ではなく", "아니", "не ")
    )


class TemplateReply:
    """人工模板。三条按场景排序，`mode="mock"`，界面必须标「模板句」。"""

    mode = "mock"
    available = True
    detail = "模板句（没有可用模型，界面上要标成模板）"

    def reply(self, text: str, translation: str) -> ReplyResult:
        if _has_correction(text) or _has_correction(translation):
            order = ["confirm", "repeat", "thanks"]
        elif _is_question(text):
            order = ["ask", "repeat", "confirm"]
        else:
            order = ["thanks", "repeat", "confirm"]

        suggestions = [
            {"reply": TEMPLATE_LINES[key][0], "meaning": TEMPLATE_LINES[key][1], "kind": key}
            for key in order
        ]
        first = suggestions[0]
        return ReplyResult(
            reply=first["reply"],
            meaning=first["meaning"],
            mode=self.mode,
            elapsed_ms=0,
            suggestions=suggestions,
        )


def build_reply_chain() -> tuple[list[object], dict[str, str]]:
    provider = ProviderReply()
    template = TemplateReply()
    chain = [provider, template]
    return chain, {"provider": provider.detail, "template": template.detail}


def choose_reply(chain: list[object]) -> object:
    for backend in chain:
        if getattr(backend, "available", False):
            return backend
    return chain[-1]
