"""Settings, read from environment variables (or a .env file next to the repo)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv() -> None:
    env = Path(__file__).resolve().parent.parent / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()


@dataclass(frozen=True)
class Settings:
    # "live" logs into CCE with your member account; "mock" returns sample bids
    # so the app can be tried without an account.
    cce_mode: str = os.getenv("CCE_MODE", "mock").lower()
    cce_base_url: str = os.getenv("CCE_BASE_URL", "https://www.certifiedcoinexchange.com")
    cce_user_id: str = os.getenv("CCE_USER_ID", "")
    cce_password: str = os.getenv("CCE_PASSWORD", "")
    # Member-area page that lists bids for one coin.  Placeholders:
    # {pcgs_no} {grade} {grade_num} {service} {cert} {barcode} {query}
    cce_search_url: str = os.getenv("CCE_SEARCH_URL", "")
    # Grading APIs (optional). PCGS_API_TOKEN may hold several keys separated by
    # commas/spaces; they rotate when one hits its daily limit.
    pcgs_api_tokens: tuple = tuple(t for t in re.split(r"[\s,]+", os.getenv("PCGS_API_TOKEN", "")) if t)
    cacg_api_key: str = os.getenv("CACG_API_KEY", "")
    cacg_api_token: str = os.getenv("CACG_API_TOKEN", "")
    greysheet_api_key: str = os.getenv("GREYSHEET_API_KEY", "")
    greysheet_api_token: str = os.getenv("GREYSHEET_API_TOKEN", "")
    cache_seconds: int = int(os.getenv("CACHE_SECONDS", "600"))


settings = Settings()
