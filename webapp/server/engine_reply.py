"""回复建议：云端模型（真实）／固定模板（明确标注，不冒充模型）。

模板只用于「这句我听清了 / 我需要再确认」这类场景，条数很少 ——
界面上要写成「模板句」，不能写成 AI 生成。
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass

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
            "propose ONE short, polite English sentence the user could say, plus its Chinese meaning. "
            "Do not invent facts. Return strict JSON: {\"reply\": \"...\", \"meaning\": \"...\"}."
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
            reply = str(data["reply"]).strip()
            meaning = str(data["meaning"]).strip()
        except Exception as error:
            raise ReplyError("UPSTREAM_ERROR", 502) from error
        return ReplyResult(
            reply=reply,
            meaning=meaning,
            mode=self.mode,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
        )


class TemplateReply:
    mode = "mock"
    available = True
    detail = "模板句（没有可用模型，界面上要标成模板）"

    def reply(self, text: str, translation: str) -> ReplyResult:
        lower = text.lower()
        if "?" in text or "could you" in lower or "can you" in lower:
            reply = "Could you say that once more, a little slower?"
            meaning = "能再说一遍吗？慢一点。"
        elif "not" in lower or "instead" in lower or "moved" in lower:
            reply = "Let me repeat that to make sure I got it right."
            meaning = "我重复一遍，确认我没听错。"
        else:
            reply = "Got it, thanks. I'll follow up if anything is unclear."
            meaning = "明白了，谢谢。有不清楚的我再问。"
        return ReplyResult(reply=reply, meaning=meaning, mode=self.mode, elapsed_ms=0)


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
