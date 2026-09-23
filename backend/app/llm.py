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


async def chat(
    messages: list[dict[str, str]], *, json_mode: bool = False
) -> Completion:
    """Send a chat completion.

    With `json_mode`, asks the server for a JSON object. Not every
    OpenAI-compatible server supports `response_format`, so a 400 that mentions
    it is retried once without — the prompt asks for JSON regardless, so the
    parameter is a belt, not the braces.
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

    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout) as client:
            response = await client.post(url, json=payload, headers=headers)
            # Some servers reject response_format outright; drop it and retry.
            if (
                response.status_code == 400
                and want_json
                and settings.llm_json_mode == "auto"
                and "response_format" in response.text
            ):
                payload.pop("response_format", None)
                response = await client.post(url, json=payload, headers=headers)
    except (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.WriteTimeout) as exc:
        raise LLMTimeout(
            f"The model at {settings.llm_base_url} did not respond within "
            f"{settings.llm_timeout:.0f}s."
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

    return Completion(
        text=content.strip(),
        model=data.get("model") or settings.llm_model,
    )


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
        async with httpx.AsyncClient(timeout=settings.claude_timeout) as client:
            response = await client.post(url, json=payload, headers=headers)
    except (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.WriteTimeout) as exc:
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

    return Completion(
        text=text.strip(),
        model=data.get("model") or settings.claude_model,
    )
