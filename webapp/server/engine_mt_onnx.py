"""进程内 ONNX 英译中（MarianMT / opus-mt-en-zh）。

为什么不用 HTTP 边车：公网部署只希望带一个 Python 运行时。Node 侧
`@xenova/transformers` 那一套要 301MB 的 node_modules，放进容器里既慢又难审计。
这里直接用 onnxruntime + tokenizers 跑同一份模型文件（同一个
`Xenova/opus-mt-en-zh` 量化权重），模型目录不变、校验和不变。

模型结构（merged decoder + KV cache，transformers.js 的导出格式）：
  encoder: input_ids, attention_mask -> last_hidden_state
  decoder: input_ids, encoder_hidden_states, encoder_attention_mask,
           past_key_values.{0..5}.{decoder,encoder}.{key,value}, use_cache_branch
        -> logits, present.{0..5}...

首步 use_cache_branch=False（此时 past 张量按长度 0 传，图内部自己算
cross-attention 的 KV），之后每步 True 并把上一步的 present 喂回去。

已知取舍：
- 贪心解码（不做 beam search）。和原来 Node 边车的输出逐字一致，见
  `.dev/mt-parity.mjs` 的对拍记录。
- `tokenizer.json` 里的 normalizer 是 Precompiled 且 charsmap 为 null，
  Rust 版 tokenizers 会 panic，这里把 normalizer 置空再加载。导出时这张
  归一化表本来就丢了，Node 边车拿到的也是 null，所以两边行为一致。
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import List, Optional

import numpy as np

from engine_mt import MTResult, UpstreamError

DEFAULT_MODEL_DIR = Path(__file__).resolve().parent.parent / "mt" / "models" / "Xenova" / "opus-mt-en-zh"


class _MarianOnnx:
    """一个进程一份，加载一次反复用。onnxruntime 的 session 本身线程安全。"""

    def __init__(self, model_dir: Path, threads: int = 0) -> None:
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.model_dir = model_dir
        cfg_path = model_dir / "config.json"
        if not cfg_path.exists():
            raise FileNotFoundError(f"缺少模型配置：{cfg_path}")
        self.cfg = json.loads(cfg_path.read_text(encoding="utf-8"))

        self.pad_id = int(self.cfg.get("pad_token_id", 65000))
        self.eos_id = int(self.cfg.get("eos_token_id", 0))
        self.decoder_start_id = int(self.cfg.get("decoder_start_token_id", self.pad_id))
        self.num_layers = int(self.cfg.get("decoder_layers", 6))
        self.heads = int(self.cfg.get("decoder_attention_heads", 8))
        self.head_dim = int(self.cfg.get("d_model", 512)) // self.heads
        self.max_len = int(self.cfg.get("max_length", 512))
        self.num_beams = int(self.cfg.get("num_beams", 4))

        # tokenizer：normalizer 是 Precompiled + null charsmap，Rust 版加载会 panic
        tok_path = model_dir / "tokenizer.json"
        raw = json.loads(tok_path.read_text(encoding="utf-8"))
        raw["normalizer"] = None
        self.tok = Tokenizer.from_str(json.dumps(raw))

        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        if threads > 0:
            so.intra_op_num_threads = threads
            so.inter_op_num_threads = 1
        so.log_severity_level = 3  # 只留 error，避免启动刷屏

        enc = model_dir / "onnx" / "encoder_model_quantized.onnx"
        dec = model_dir / "onnx" / "decoder_model_merged_quantized.onnx"
        for p in (enc, dec):
            if not p.exists():
                raise FileNotFoundError(f"缺少模型文件：{p}")

        t0 = time.perf_counter()
        self.enc = ort.InferenceSession(str(enc), so, providers=["CPUExecutionProvider"])
        self.dec = ort.InferenceSession(str(dec), so, providers=["CPUExecutionProvider"])
        self.load_ms = int((time.perf_counter() - t0) * 1000)

        self._lock = threading.Lock()
        self._past_cache: dict = {}

    # ---- 单步 ----
    def _past(self, batch: int, enc_len: int) -> dict:
        """这一版导出里 KV cache 走不通（见文件头说明），每步都重算整段，
        所以 past 张量只用来给图里的 Reshape 提供维度，内容不参与计算。"""
        key = (batch, enc_len)
        cached = self._past_cache.get(key)
        if cached is not None:
            return cached
        built = {
            f"past_key_values.{i}.{side}.{kv}": np.zeros(
                (batch, self.heads, 0 if side == "decoder" else enc_len, self.head_dim),
                dtype=np.float32,
            )
            for i in range(self.num_layers)
            for side in ("decoder", "encoder")
            for kv in ("key", "value")
        }
        self._past_cache[key] = built
        return built

    def _logits(self, seq: np.ndarray, enc_hidden: np.ndarray, enc_mask: np.ndarray) -> np.ndarray:
        feeds = {
            "input_ids": seq,
            "encoder_hidden_states": enc_hidden,
            "encoder_attention_mask": enc_mask,
            "use_cache_branch": np.array([False], dtype=np.bool_),
        }
        feeds.update(self._past(seq.shape[0], enc_hidden.shape[1]))
        return self.dec.run(["logits"], feeds)[0]

    @staticmethod
    def _ban_repeat(logits: np.ndarray, seq: np.ndarray, n: int) -> np.ndarray:
        """禁止同一 n-gram 再次出现（no_repeat_ngram_size）。

        为什么必须有这一条：这个量化模型在**极短输入**上会稳定退化，实测

            hello        -> 哈哈哈哈哈哈哈哈哈
            Good morning -> 早早早早早
            hi           -> hi hi hi

        三次都是「同一个 token 反复出」。beam search 会主动挑这种低风险的重复，
        因为每步概率都不低、累积得分反而更好看。官方 MarianMT 的默认值是不开，
        但那是给完整句子用的；本产品大量输入是两三个词，必须显式关掉这条路。

        n=3 是折中：真正的中文重复（「谢谢，谢谢」）只有 2-gram 重复，不会被误伤；
        而「哈哈哈哈哈哈」在第 3 个字就会被拦住。
        """
        if n <= 1:
            return logits
        before = logits.copy()
        for row in range(seq.shape[0]):
            tokens = seq[row].tolist()
            if len(tokens) < n:
                continue
            prefix = tuple(tokens[-(n - 1):])
            banned = set()
            for i in range(len(tokens) - n + 1):
                if tuple(tokens[i:i + n - 1]) == prefix:
                    banned.add(tokens[i + n - 1])
            for token in banned:
                logits[row, token] = -np.inf
        # 整行都被屏蔽时必须退回去：实测短句（「こんにちは」这类）会出现这一步所有
        # 候选都构成 3-gram 的情况，全 -inf 之后 log_softmax 算出 nan，
        # argmax 落到 0（EOS），译文被凭空截断。宁可重复一次，也不要截断。
        dead = ~np.isfinite(logits).any(axis=1)
        if dead.any():
            logits[dead] = before[dead]
        return logits

    # ---- 整句：beam search ----
    def translate(self, text: str, num_beams: int = 0,
                  length_penalty: float = 1.0, max_new_tokens: int = 0,
                  no_repeat_ngram: int = 3) -> str:
        enc = self.tok.encode(text)
        ids = np.array([enc.ids], dtype=np.int64)
        mask = np.ones_like(ids, dtype=np.int64)
        hidden = self.enc.run(None, {"input_ids": ids, "attention_mask": mask})[0]
        enc_len = ids.shape[1]
        # 输出长度按输入自适应。
        #
        # 原来一律给 512，短句解码可以一路跑到几百个 token 才遇到 EOS ——
        # 中间那段全是重复。英文 1 个词译成中文一般不超过 10 个字，
        # 按 `词数 * 3` 给上限，多留一截余量（中文 token 比英文碎）。
        cap = max(24, int(enc_len * 4.5) + 12)
        limit = min(max_new_tokens or self.max_len, self.max_len, cap)

        beams = max(1, int(num_beams or self.num_beams))
        if beams == 1:
            return self._greedy(hidden, mask, limit, no_repeat_ngram)

        # 所有 beam 共用同一份 encoder 输出；每步按**当前存活 beam 数**重复。
        #
        # 不能一开始就 repeat(beams) 然后不管：某个 beam 提前 EOS 之后，seq 行数
        # 会少于 beams，而 hidden 还是 beams 行 —— 图和输入 batch 对不上，整步直接
        # 抛异常。实测「短句 + 部分 beam 提前结束」正好会踩到。
        seq = np.full((1, 1), self.decoder_start_id, dtype=np.int64)
        scores = np.zeros(1, dtype=np.float32)
        done: List[tuple] = []

        for _ in range(limit):
            current = seq.shape[0]
            hidden_c = np.repeat(hidden, current, axis=0)
            mask_c = np.repeat(mask, current, axis=0)
            logits = self._logits(seq, hidden_c, mask_c)[:, -1, :].astype(np.float32)
            logits[:, self.pad_id] = -np.inf  # bad_words_ids
            logits = self._ban_repeat(logits, seq, no_repeat_ngram)
            vocab = logits.shape[1]
            top = np.log(logits.max(axis=1, keepdims=True))
            logp = logits - (top + np.log(np.exp(logits - top).sum(axis=1, keepdims=True)))
            cand = (scores[:, None] + logp).reshape(-1)
            take = min(beams * 2, cand.size)
            flat = np.argpartition(-cand, take - 1)[:take]
            flat = flat[np.argsort(-cand[flat])]

            rows, new_scores = [], []
            for idx in flat:
                bi, token = divmod(int(idx), vocab)
                score = float(cand[idx])
                if token == self.eos_id:
                    done.append((score, seq[bi, 1:].tolist()))
                elif len(rows) < beams:
                    rows.append(np.append(seq[bi], token))
                    new_scores.append(score)
            if not rows:
                break
            seq = np.array(rows, dtype=np.int64)
            scores = np.array(new_scores, dtype=np.float32)
            if len(done) >= beams:
                break

        for bi in range(seq.shape[0]):
            done.append((float(scores[bi]), seq[bi, 1:].tolist()))
        if not done:
            return ""

        def norm(item):
            score, toks = item
            return score / max(1, len(toks)) ** length_penalty

        _, best = max(done, key=norm)
        return self.tok.decode(best, skip_special_tokens=True).strip()

    def _greedy(self, hidden: np.ndarray, mask: np.ndarray, limit: int,
                no_repeat_ngram: int = 3) -> str:
        out: List[int] = []
        seq = [self.decoder_start_id]
        for _ in range(limit):
            logits = self._logits(np.array([seq], dtype=np.int64), hidden, mask)[0, -1, :].astype(np.float32)
            logits[self.pad_id] = -np.inf
            logits = self._ban_repeat(logits[None, :], np.array([seq], dtype=np.int64),
                                      no_repeat_ngram)[0]
            nxt = int(np.argmax(logits))
            if nxt == self.eos_id or nxt == self.pad_id:
                break
            out.append(nxt)
            seq.append(nxt)
        return self.tok.decode(out, skip_special_tokens=True).strip()


class OnnxOpusMT:
    """进程内英译中。模型缺失就标 not available，由链条降级到下一路。

    和 LocalOpusMT（HTTP 边车）是同一个模型、同一份量化权重，只是不再需要
    Node 运行时。`available` 在构造时只做「文件在不在」的轻量判断，真正的
    session 加载推迟到第一次 translate/warmup，避免拖慢启动。
    """

    mode = "local-onnx"

    def __init__(self, model_dir: Optional[str] = None, threads: int = 0) -> None:
        self.model_dir = Path(model_dir or os.environ.get("COPILOT_MT_MODEL_DIR") or DEFAULT_MODEL_DIR)
        self._threads = threads
        self._model: Optional[_MarianOnnx] = None
        self._err: Optional[str] = None

        enc = self.model_dir / "onnx" / "encoder_model_quantized.onnx"
        dec = self.model_dir / "onnx" / "decoder_model_merged_quantized.onnx"
        tok = self.model_dir / "tokenizer.json"
        missing = [str(p.name) for p in (enc, dec, tok) if not p.exists()]
        if missing:
            self.available = False
            self.detail = f"本地翻译模型缺少文件：{', '.join(missing)}（目录 {self.model_dir}）"
        else:
            total_mb = sum(p.stat().st_size for p in (enc, dec)) // (1024 * 1024)
            self.available = True
            self.detail = f"本地 Opus-MT（进程内 ONNX 量化，{total_mb}MB，不需要 Node）"

    def _ensure(self) -> "_MarianOnnx":
        if self._model is not None:
            return self._model
        if self._err is not None:
            raise UpstreamError("NOT_CONFIGURED", 503)
        try:
            self._model = _MarianOnnx(self.model_dir, self._threads)
        except Exception as exc:  # noqa: BLE001 - 任何加载失败都退成 NOT_CONFIGURED
            self._err = type(exc).__name__
            self.available = False
            self.detail = f"本地翻译模型加载失败：{type(exc).__name__}"
            raise UpstreamError("NOT_CONFIGURED", 503) from exc
        return self._model

    def warmup(self) -> dict:
        """预加载 + 空跑一句。返回值只含耗时与目录，不含任何文本。"""
        model = self._ensure()
        started = time.perf_counter()
        with model._lock:
            model.translate("Hello.")
        return {
            "model_dir": str(model.model_dir),
            "load_ms": model.load_ms,
            "warmup_ms": int((time.perf_counter() - started) * 1000),
        }

    def translate(self, text: str) -> MTResult:
        model = self._ensure()
        started = time.perf_counter()
        try:
            with model._lock:
                out = model.translate(text)
        except Exception as exc:  # noqa: BLE001
            raise UpstreamError("UPSTREAM_ERROR", 502) from exc
        if not out:
            raise UpstreamError("UPSTREAM_ERROR", 502)
        return MTResult(
            translation=out,
            mode=self.mode,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
        )
