"""Application settings.

Plain environment-variable reads — no pydantic-settings dependency needed.
Values come from the process environment, with `backend/.env` loaded first so a
local checkout can configure the LLM without exporting anything.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent  # .../backend

# Real environment variables win over the file, so `LLM_BASE_URL=... uvicorn ...`
# still overrides .env for a one-off run.
load_dotenv(BASE_DIR / ".env", override=False)


def _csv(name: str, default: str) -> list[str]:
    raw = os.getenv(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    app_name: str = "Resume Tailor API"
    version: str = "0.1.0"
    api_prefix: str = "/api"

    # The SQLite database — users, their sections, generated resumes and the
    # application registry, all in one file. Back this up and you have backed
    # up everything.
    #
    # In a container it MUST be on a mounted volume, or every deploy wipes it.
    database_file: Path = field(
        default_factory=lambda: Path(
            os.getenv("DATABASE_FILE", str(BASE_DIR / "data" / "resume-tailor.db"))
        ).resolve()
    )

    # Where the old JSON files live. Only read now, and only once: whatever is
    # there is imported into SQLite at startup and renamed out of the way.
    data_file: Path = field(
        default_factory=lambda: Path(
            os.getenv("DATA_FILE", str(BASE_DIR / "data" / "db.json"))
        ).resolve()
    )

    # The directory those JSON files sit in — where the importer looks for
    # YYYYMMDD_registry.json. Defaults to the same place as DATA_FILE.
    registry_dir: Path = field(
        default_factory=lambda: Path(
            os.getenv(
                "REGISTRY_DIR",
                str(
                    Path(os.getenv("DATA_FILE", str(BASE_DIR / "data" / "db.json")))
                    .resolve()
                    .parent
                ),
            )
        ).resolve()
    )

    # Origins allowed to call the API from a browser.
    cors_origins: list[str] = field(
        default_factory=lambda: _csv(
            "CORS_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173",
        )
    )

    # ---- LLM -------------------------------------------------------------
    # Base URL of an OpenAI-compatible server, including the port and the API
    # prefix — e.g. http://localhost:1234/v1 (LM Studio), http://localhost:11434/v1
    # (Ollama), or https://api.openai.com/v1. Empty means "not configured", and
    # the tailor endpoint reports that rather than guessing a default.
    llm_base_url: str = field(
        default_factory=lambda: os.getenv("LLM_BASE_URL", "").strip().rstrip("/")
    )
    llm_api_key: str = field(
        default_factory=lambda: os.getenv("LLM_API_KEY", "").strip()
    )
    llm_model: str = field(
        default_factory=lambda: os.getenv("LLM_MODEL", "gpt-4o").strip()
    )
    # Seconds for a whole generation, not one call. A request still running
    # after this is usually a model that has stalled rather than one about to
    # answer, and the UI says "the model timed out" instead of holding the page.
    #
    # 60 is sized for the one-call default: a detailed resume is a few thousand
    # output tokens, and output is written serially at roughly 30-80 tokens a
    # second, so 40 was cutting off generations that were still making progress.
    # Raise LLM_TIMEOUT in backend/.env if your endpoint is slow but healthy —
    # a large local model on CPU can legitimately need minutes for a full
    # resume, and LLM_REFINE=on needs room for up to three calls.
    llm_timeout: float = field(
        default_factory=lambda: float(os.getenv("LLM_TIMEOUT", "60"))
    )
    llm_temperature: float = field(
        default_factory=lambda: float(os.getenv("LLM_TEMPERATURE", "0.3"))
    )
    # One generation returns the whole resume AND the reading of the posting:
    # several roles with a bullet per point in the profile, the four term
    # lists, 10-16 `wants` lines and 8-16 sample sentences. Measured against
    # the current schema, a typical profile lands near 3,300 tokens and a
    # detailed one — five roles, a dozen bullets each — passes 4,800, so 4000
    # was cutting real answers in half. A model that hits the cap stops
    # mid-string, and what arrives here is invalid JSON.
    #
    # Raising it costs nothing on a request that does not need the room: the
    # limit is a ceiling, not an amount to produce. It does raise the ceiling
    # on how long one can take, which LLM_TIMEOUT then bounds.
    # The two follow-up calls — the coverage pass and the match pass — each cost
    # a whole round trip, and a round trip here is tens of seconds because the
    # answer is produced one token at a time. Off by default: one generation is
    # one call. Turn it on when a complete reading matters more than the wait.
    llm_refine: bool = field(
        default_factory=lambda: os.getenv("LLM_REFINE", "off").strip().lower()
        in ("1", "on", "true", "yes")
    )
    llm_max_tokens: int = field(
        default_factory=lambda: int(os.getenv("LLM_MAX_TOKENS", "8000"))
    )
    # "auto" sends response_format=json_object and silently retries without it
    # if the server rejects the parameter. "on" requires it, "off" never sends
    # it — the prompt asks for JSON either way.
    llm_json_mode: str = field(
        default_factory=lambda: os.getenv("LLM_JSON_MODE", "auto").strip().lower()
    )

    # ---- Claude (humanizing pass) ----------------------------------------
    # Anthropic's Messages API, not the OpenAI chat format — different URL
    # shape, different auth header, different response body. Kept as its own
    # setting so the two passes can use different providers.
    claude_base_url: str = field(
        default_factory=lambda: os.getenv(
            "CLAUDE_BASE_URL", "https://api.anthropic.com/v1"
        ).strip().rstrip("/")
    )
    claude_api_key: str = field(
        default_factory=lambda: os.getenv("CLAUDE_API_KEY", "").strip()
    )
    # No default model id: they change over time, and silently calling the
    # wrong one is worse than saying "set this".
    claude_model: str = field(
        default_factory=lambda: os.getenv("CLAUDE_MODEL", "").strip()
    )
    claude_version: str = field(
        default_factory=lambda: os.getenv("CLAUDE_VERSION", "2023-06-01").strip()
    )
    # The humanizing pass rewrites a resume that already exists, so a stall
    # here costs the rewrite and not the generation. Same budget as the
    # generation call above, for one less number to reason about.
    claude_timeout: float = field(
        default_factory=lambda: float(os.getenv("CLAUDE_TIMEOUT", "60"))
    )
    # Matches llm_max_tokens above, and has to: the humanizing pass is handed a
    # finished resume and asked to return the whole thing rewritten, so its
    # answer is at least as long as the one that came out of generation. A
    # smaller ceiling here would cut the rewrite off partway and throw away a
    # resume that generated cleanly.
    claude_max_tokens: int = field(
        default_factory=lambda: int(os.getenv("CLAUDE_MAX_TOKENS", "8000"))
    )
    claude_temperature: float = field(
        default_factory=lambda: float(os.getenv("CLAUDE_TEMPERATURE", "0.8"))
    )

    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_base_url)

    @property
    def claude_configured(self) -> bool:
        # A key is required for api.anthropic.com but not for a local proxy,
        # so the model is the field that always has to be set.
        return bool(self.claude_base_url and self.claude_model)


settings = Settings()
