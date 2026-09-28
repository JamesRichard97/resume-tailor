"""Thin client for an OpenAI-compatible chat-completions endpoint.

Deliberately not the `openai` SDK: the wire format is one POST, and speaking it
directly keeps the app working against OpenAI, LM Studio, Ollama, vLLM,
llama.cpp and anything else that implements `/chat/completions` — whichever the
operator points `LLM_BASE_URL` at.

The failure modes are kept apart because the UI says something different for
each: "nobody configured a server", "the server is not answering", "the server
answered with an error".
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass

import httpx

from .config import settings


@dataclass
class Completion:
    """What a provider gave back: the text, and which model actually produced
    it — servers sometimes resolve an alias to a dated model id, and that id is
    what gets stored on the resume record."""

    text: str
    model: str
    # What the provider says the call cost, from the `usage` block it returns.
    # Reported rather than counted locally: the only number that matters is the
    # one the provider billed, and a local tokenizer is a guess at another
    # vendor's tokenizer that drifts every time they change it. Zero means the
    # provider sent no usage block — some OpenAI-compatible servers do not.
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


class LLMError(RuntimeError):
    """Base for anything that stops us returning a generated resume."""


class LLMNotConfigured(LLMError):
    """The endpoint is not configured — there is nothing to call."""


class LLMUnavailable(LLMError):
    """The endpoint could not be reached (DNS, refused, network)."""


class LLMTimeout(LLMError):
    """The endpoint accepted the request but did not answer in time."""


class LLMBadResponse(LLMError):
    """The endpoint answered, but with an error or an unusable body."""


def _snippet(text: str, limit: int = 280) -> str:
    text = " ".join(text.split())
    return text[:limit] + ("…" if len(text) > limit else "")


# Below this there is no point starting a call: the connection alone can take
# most of it, and a request that cannot finish is worse than one not made.
MIN_BUDGET = 3.0


async def chat(
    messages: list[dict[str, str]], *, json_mode: bool = False, budget: float | None = None
) -> Completion:
    """Send a chat completion.

    With `json_mode`, asks the server for a JSON object. Not every
    OpenAI-compatible server supports `response_format`, so a 400 that mentions
    it is retried once without — the prompt asks for JSON regardless, so the
    parameter is a belt, not the braces.

    `budget` is the seconds this call may take IN TOTAL, retry included. The
    caller passes what is left of the request's deadline, so a generation that
    makes several calls still finishes inside one timeout rather than one
    timeout per call. Omitted, it falls back to the configured timeout.
    """
    if not settings.llm_configured:
        raise LLMNotConfigured(
            "No LLM endpoint is configured. Set LLM_BASE_URL in backend/.env "
            "(for example http://localhost:1234/v1) and restart the server."
        )

    url = f"{settings.llm_base_url}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if settings.llm_api_key:
        headers["Authorization"] = f"Bearer {settings.llm_api_key}"

    payload = {
        "model": settings.llm_model,
        "messages": messages,
        "temperature": settings.llm_temperature,
        "max_tokens": settings.llm_max_tokens,
        "stream": False,
    }

    want_json = json_mode and settings.llm_json_mode in ("auto", "on")
    if want_json:
        payload["response_format"] = {"type": "json_object"}

    limit = settings.llm_timeout if budget is None else max(budget, 0.0)
    if limit < MIN_BUDGET:
        raise LLMTimeout(
            f"No time left for the model to answer in "
            f"({settings.llm_timeout:.0f}s budget spent)."
        )

    started = time.monotonic()
    try:
        # Every phase gets the same ceiling, so a server that accepts the
        # connection and then says nothing is cut off as surely as one that
        # never answers at all.
        async with httpx.AsyncClient(timeout=httpx.Timeout(limit)) as client:
            response = await client.post(url, json=payload, headers=headers)
            # Some servers reject response_format outright; drop it and retry.
            if (
                response.status_code == 400
                and want_json
                and settings.llm_json_mode == "auto"
                and "response_format" in response.text
            ):
                payload.pop("response_format", None)
                # The retry shares the budget rather than getting a fresh one —
                # otherwise a server that rejects the parameter costs twice the
                # timeout the operator asked for.
                left = limit - (time.monotonic() - started)
                if left < MIN_BUDGET:
                    raise LLMTimeout(
                        f"The model at {settings.llm_base_url} did not respond "
                        f"within {limit:.0f}s."
                    )
                response = await client.post(
                    url, json=payload, headers=headers, timeout=httpx.Timeout(left)
                )
    # Every timeout httpx raises, not the three that were listed here: a pool
    # timeout was being reported as "could not reach the server", which sends
    # whoever reads it looking in the wrong place.
    except httpx.TimeoutException as exc:
        raise LLMTimeout(
            f"The model at {settings.llm_base_url} did not respond within "
            f"{limit:.0f}s."
        ) from exc
    except httpx.RequestError as exc:
        raise LLMUnavailable(
            f"Could not reach the model at {settings.llm_base_url}. "
            "Check that the server is running and the URL and port are right."
        ) from exc

    if response.status_code >= 400:
        detail = _snippet(response.text) or response.reason_phrase
        # 401/403 are worth calling out — they are a key problem, not an outage.
        if response.status_code in (401, 403):
            raise LLMBadResponse(
                f"The model endpoint rejected the credentials ({response.status_code}). "
                "Check LLM_API_KEY."
            )
        raise LLMBadResponse(
            f"The model endpoint returned {response.status_code}: {detail}"
        )

    try:
        data = response.json()
    except ValueError as exc:
        raise LLMBadResponse(
            "The model endpoint returned a response that was not JSON."
        ) from exc

    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMBadResponse(
            "The model endpoint returned an unexpected payload: "
            f"{_snippet(str(data))}"
        ) from exc

    if not content or not content.strip():
        raise LLMBadResponse("The model returned an empty response.")

    # A cut-off answer is not malformed JSON, it is an answer that ran out of
    # room, and saying so points at the setting that fixes it. Without this the
    # failure surfaces as "the model returned malformed JSON", which sends
    # whoever reads it looking at the prompt instead of at LLM_MAX_TOKENS.
    if (data["choices"][0] or {}).get("finish_reason") == "length":
        raise LLMBadResponse(
            f"The model hit its {settings.llm_max_tokens}-token output limit and "
            "the answer was cut off mid-JSON. Raise LLM_MAX_TOKENS in "
            "backend/.env and restart the server."
        )

    prompt_tokens, completion_tokens = _usage(
        data.get("usage"), "prompt_tokens", "completion_tokens"
    )
    return Completion(
        text=content.strip(),
        model=data.get("model") or settings.llm_model,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )


def _usage(block, prompt_key: str, completion_key: str) -> tuple[int, int]:
    """Pull the two counts out of a provider's usage block.

    Tolerant on purpose: not every OpenAI-compatible server sends one, and a
    missing or malformed block must cost a number on screen, never the resume
    the user waited for.
    """
    if not isinstance(block, dict):
        return 0, 0

    def count(key: str) -> int:
        try:
            return max(0, int(block.get(key) or 0))
        except (TypeError, ValueError):
            return 0

    return count(prompt_key), count(completion_key)


_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)


def extract_json(content: str, *, hint: str = "") -> dict:
    """Parse the model's JSON, tolerating the two things models actually do:
    wrap it in a ``` fence, or pad it with a sentence of preamble.

    `hint` is appended to the "not JSON" error — the advice differs by provider,
    and pointing someone at a setting that does not apply to their endpoint is
    worse than no advice at all.
    """
    text = _FENCE.sub("", content.strip())

    try:
        data = json.loads(text)
    except ValueError:
        # Fall back to the outermost {...} in the response.
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            raise LLMBadResponse(
                "The model replied with prose instead of JSON. Try again, or "
                "use a stronger model." + (f" {hint}" if hint else "")
            ) from None
        try:
            data = json.loads(text[start : end + 1])
        except ValueError as exc:
            raise LLMBadResponse(
                f"The model returned malformed JSON: {_snippet(str(exc), 120)}"
            ) from exc

    if not isinstance(data, dict):
        raise LLMBadResponse("The model returned JSON that was not an object.")
    return data


# --------------------------------------------------------------------------
# Claude — Anthropic Messages API
# --------------------------------------------------------------------------
#
# A separate function rather than a flag on `chat`: the Messages API differs
# from OpenAI's chat completions in URL, auth header, request body and response
# shape. Pretending they are the same would mean a translation layer that has to
# be right in both directions; two small clients are easier to keep honest.


async def claude(system: str, user_content: str) -> Completion:
    """Send one message to Claude."""
    if not settings.claude_configured:
        raise LLMNotConfigured(
            "Claude is not configured. Set CLAUDE_MODEL (and CLAUDE_API_KEY for "
            "api.anthropic.com) in backend/.env and restart the server."
        )

    url = f"{settings.claude_base_url}/messages"
    headers = {
        "content-type": "application/json",
        "anthropic-version": settings.claude_version,
    }
    if settings.claude_api_key:
        headers["x-api-key"] = settings.claude_api_key

    payload = {
        "model": settings.claude_model,
        "max_tokens": settings.claude_max_tokens,
        "temperature": settings.claude_temperature,
        "system": system,
        "messages": [{"role": "user", "content": user_content}],
    }

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(settings.claude_timeout)
        ) as client:
            response = await client.post(url, json=payload, headers=headers)
    except httpx.TimeoutException as exc:
        raise LLMTimeout(
            f"Claude at {settings.claude_base_url} did not respond within "
            f"{settings.claude_timeout:.0f}s."
        ) from exc
    except httpx.RequestError as exc:
        raise LLMUnavailable(
            f"Could not reach Claude at {settings.claude_base_url}. "
            "Check that the URL is right and the machine has network access."
        ) from exc

    if response.status_code >= 400:
        detail = _snippet(response.text) or response.reason_phrase
        if response.status_code in (401, 403):
            raise LLMBadResponse(
                f"Claude rejected the credentials ({response.status_code}). "
                "Check CLAUDE_API_KEY."
            )
        if response.status_code == 429:
            raise LLMBadResponse(
                "Claude is rate limiting this key (429). Wait a moment and retry."
            )
        raise LLMBadResponse(f"Claude returned {response.status_code}: {detail}")

    try:
        data = response.json()
    except ValueError as exc:
        raise LLMBadResponse("Claude returned a response that was not JSON.") from exc

    # content is a list of blocks; concatenate the text ones.
    try:
        blocks = data["content"]
        text = "".join(
            b.get("text", "") for b in blocks if b.get("type") == "text"
        )
    except (KeyError, TypeError, AttributeError) as exc:
        raise LLMBadResponse(
            f"Claude returned an unexpected payload: {_snippet(str(data))}"
        ) from exc

    if not text.strip():
        raise LLMBadResponse("Claude returned an empty response.")

    # The same guard the generation call above has, for the same reason. Claude
    # says "max_tokens" where OpenAI says "length", but a cut-off rewrite fails
    # identically: it is not malformed JSON, it is an answer that ran out of
    # room, and naming the setting saves whoever reads the error from going
    # through the prompt looking for the fault.
    if data.get("stop_reason") == "max_tokens":
        raise LLMBadResponse(
            f"Claude hit its {settings.claude_max_tokens}-token output limit and "
            "the rewrite was cut off. Raise CLAUDE_MAX_TOKENS in backend/.env "
            "and restart the server."
        )

    # Claude names them differently: input_tokens / output_tokens.
    prompt_tokens, completion_tokens = _usage(
        data.get("usage"), "input_tokens", "output_tokens"
    )
    return Completion(
        text=text.strip(),
        model=data.get("model") or settings.claude_model,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )
