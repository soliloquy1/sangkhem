#!/usr/bin/env python3
"""Laya WI Director service.

Local HTTP wrapper around the Laya decision model. Scores World Info
candidates for relevance and usefulness so the SillyTavern extension can
decide which entries to actually inject.

Endpoints:
    GET  /health       -> {"status": "ok"}
    POST /wi-director   -> {"results": [{"id", "relevance", "usefulness"}, ...]}
    POST /reply-guard   -> {"refusal": p}   (P(refusal or OOC decline), 0-1)
    POST /echo-check    -> {"p_new": [p, ...]}  (P(sentence adds something the user didn't write))

The model never generates text; it returns ordinal scores (0-5) and P(true).
"""
import json
import os

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("LAYA_WID_HOST", "127.0.0.1")
PORT = int(os.environ.get("LAYA_WID_PORT", "8666"))
# torch (default, validated) or mlx (native Apple Silicon, ~4x faster).
BACKEND = os.environ.get("LAYA_WID_BACKEND", "torch").lower()
MLX_REPO = os.environ.get("LAYA_WID_MLX_REPO", "aac6fef/laya-mlx")

# 6 anchor labels -> Laya scales the score to 0..5.
REL_CRITERIA = [
    "irrelevant to the current scene",
    "barely relevant",
    "somewhat relevant",
    "relevant",
    "very relevant",
    "essential to the current scene",
]
USE_CRITERIA = [
    "no benefit if injected",
    "minimal benefit",
    "slight benefit",
    "helpful",
    "very helpful",
    "critical to include",
]

QUESTIONS = {
    "relevance": {
        "type": "score",
        "instructions": "How relevant is this lore entry to the current scene and the latest message?",
        "criteria": REL_CRITERIA,
    },
    "usefulness": {
        "type": "score",
        "instructions": "Would injecting this lore entry improve the assistant's next reply?",
        "criteria": USE_CRITERIA,
    },
}

def load_model():
    """Return an object with .predict(state, questions) for the chosen backend."""
    if BACKEND == "mlx":
        # Native Apple Silicon (MLX). Requires: pip install laya-mlx
        import laya_mlx

        print(f"Loading laya-mlx backend ({MLX_REPO})...", flush=True)
        return laya_mlx.load(MLX_REPO)
    if BACKEND == "torch":
        from laya import Router

        # Lazy by default: both endpoints route to the English checkpoint, and
        # preloading all three took 132s vs 45s for English alone. Non-English
        # text loads its checkpoint on first use. LAYA_WID_PRELOAD=1 restores
        # eager loading of all checkpoints.
        preload = os.environ.get("LAYA_WID_PRELOAD") == "1"
        return Router(preload=preload)
    raise SystemExit(f"Unknown LAYA_WID_BACKEND={BACKEND!r} (expected 'torch' or 'mlx')")


print(
    f"Loading Laya ({BACKEND}) from local cache — ~45s on Apple Silicon. "
    "Only the very first run ever downloads (~2 GB).",
    flush=True,
)
model = load_model()
# Warm up now so the first SillyTavern turn doesn't pay the checkpoint load.
model.predict({"current_message": "warmup", "lore_entry": "warmup"}, QUESTIONS)
print(f"Laya ready (backend={BACKEND}).", flush=True)


def score_candidate(message, recent, content):
    state = {
        "current_message": message,
        "recent_context": "\n".join(recent),
        "lore_entry": content,
    }
    res = model.predict(state, QUESTIONS)
    answers = res["answers"]
    return float(answers["relevance"]["score"]), float(answers["usefulness"]["score"])


# -- Reply guard --------------------------------------------------------------
# Refusal detection only. Calibrated on hand-made cases: this 3-way choice put
# hard, "as an AI", and OOC-decline refusals at 0.95-0.99 and every story
# reply (incl. graphic violence) at <=0.88. Yes/no phrasings scored violence
# as refusal, so don't "simplify" this back to a noul question.
# Speaks-for-user isn't asked here: Laya couldn't find "who acts" in a reply,
# so guard-heuristics.js nominates clauses in the browser and /echo-check only
# judges whether each one merely restates the user's message.
GUARD_QUESTIONS = {
    "kind": {
        "type": "choice",
        "instructions": "What kind of text is this?",
        "criteria": {
            "story": "story narration or character dialogue, any content including violence",
            "refusal": "an assistant apologizing, refusing, or citing guidelines",
            "ooc_decline": "an out-of-character note saying the writer is uncomfortable or wants to change direction",
        },
    }
}

# ~300 tokens per chunk leaves room for the question text in the 512 window.
GUARD_CHUNK_CHARS = 1200


def chunk_text(text, size=GUARD_CHUNK_CHARS):
    """Split on paragraph boundaries into chunks of at most `size` chars."""
    chunks, cur = [], ""
    for para in (p for p in text.split("\n") if p.strip()):
        while len(para) > size:
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(para[:size])
            para = para[size:]
        if cur and len(cur) + len(para) + 1 > size:
            chunks.append(cur)
            cur = para
        else:
            cur = f"{cur}\n{para}" if cur else para
    if cur:
        chunks.append(cur)
    return chunks or [text[:size]]


def guard_reply(reply, user_name, char_name):
    """P(refusal or OOC decline), worst of the first and last chunk.

    Refusals lead the reply and OOC notes trail it; scoring every middle chunk
    of a long story only adds false-positive chances.
    """
    chunks = chunk_text(reply)
    edges = chunks if len(chunks) <= 2 else [chunks[0], chunks[-1]]
    worst = 0.0
    for chunk in edges:
        state = {"user_character": user_name, "ai_character": char_name, "reply": chunk}
        probs = model.predict(state, GUARD_QUESTIONS)["answers"]["kind"]["probabilities"]
        worst = max(worst, float(probs.get("refusal", 0.0)) + float(probs.get("ooc_decline", 0.0)))
    return {"refusal": worst}


# -- Echo check ----------------------------------------------------------------
# The browser-side pattern check nominates clauses where the user's character
# acts. Many are echo: the model restating what the user just wrote, often
# paraphrased ("I regain my distance" -> "Miyu pulled away"). Calibrated on the
# user's real chats: this same/different phrasing put echo at 0.02-0.24 and
# genuinely new actions at 0.44-0.98 (a 3-way restates/appearance/new choice
# and a yes/no "already describes?" both overlapped). Keep this wording.
ECHO_USER_CHARS = 1500  # leaves room in the 512-token window for the sentence


def echo_question(name):
    return {
        "kind": {
            "type": "choice",
            "instructions": f"Is what {name} does in the sentence the same as in the user's message?",
            "criteria": {
                "same": f"the same action or words the user's message already gives {name}",
                "different": f"an action, words, or feeling for {name} that the user's message does not mention",
            },
        }
    }


def echo_check(user_name, user_message, sentences):
    """P(sentence gives the user's character something NOT in their message), per sentence."""
    q = echo_question(user_name)
    out = []
    for sentence in sentences:
        state = {"user_character": user_name, "user_message": user_message[:ECHO_USER_CHARS], "sentence": sentence}
        probs = model.predict(state, q)["answers"]["kind"]["probabilities"]
        out.append(float(probs.get("different", 0.0)))
    return out


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # ST runs in the browser on a different port -> allow cross-origin.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"status": "ok"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in ("/wi-director", "/reply-guard", "/echo-check"):
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", 0) or 0)
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:  # noqa: BLE001
            return self._send(400, {"error": f"bad json: {e}"})

        if self.path == "/echo-check":
            try:
                p_new = echo_check(
                    req.get("user_name", "User"),
                    req.get("user_message", ""),
                    (req.get("sentences") or [])[:12],
                )
            except Exception as e:  # noqa: BLE001
                return self._send(500, {"error": str(e)})
            return self._send(200, {"p_new": p_new})

        if self.path == "/reply-guard":
            try:
                verdict = guard_reply(
                    req.get("reply", ""),
                    req.get("user_name", "User"),
                    req.get("char_name", "Character"),
                )
            except Exception as e:  # noqa: BLE001
                # Extension treats non-200 as "no verdict" and never swipes.
                return self._send(500, {"error": str(e)})
            return self._send(200, verdict)

        message = req.get("message", "")
        recent = req.get("recent_turns", []) or []
        results = []
        for cand in req.get("candidates", []) or []:
            cid = cand.get("id")
            try:
                rel, use = score_candidate(message, recent, cand.get("content", ""))
                results.append({"id": cid, "relevance": rel, "usefulness": use})
            except Exception as e:  # noqa: BLE001
                # Fail open: a scoring error should never drop an entry.
                results.append(
                    {"id": cid, "relevance": 5.0, "usefulness": 5.0, "error": str(e)}
                )
        self._send(200, {"results": results})

    def log_message(self, *args):  # silence per-request logging
        pass


if __name__ == "__main__":
    print(f"Serving on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
