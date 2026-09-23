"""FastAPI application entry point.

Run from the backend/ directory:

    uvicorn app.main:app --reload --port 8000

Interactive docs: http://localhost:8000/docs
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import database, db, importer
from .config import settings
from .routers import registry, tailor, users


logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Create the schema if it is not there, then import any JSON files left
    # over from before the move to SQLite. Both are no-ops after the first run.
    database.init()

    imported = importer.run()
    if imported["files"]:
        logger.info(
            "Imported %d user(s), %d resume(s) and %d registry row(s) from %s. "
            "The source files were renamed to *.imported and can be deleted "
            "once you are happy with the result.",
            imported["users"],
            imported["resumes"],
            imported["registry"],
            ", ".join(f["name"] for f in imported["files"]),
        )

    counts = db.counts()
    logger.info(
        "Database ready: %d user(s), %d resume(s), %d registry row(s).",
        counts["users"],
        counts["resumes"],
        counts["registry"],
    )

    incomplete = db.incomplete_count()
    if incomplete:
        logger.warning(
            "%d user row(s) are missing fields the current schema expects; "
            "they are returned with is_complete=false. PATCH the missing "
            "fields, or delete the rows.",
            incomplete,
        )
    yield
    database.close()


app = FastAPI(
    title=settings.app_name,
    version=settings.version,
    description="Backend for Resume Tailor.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(users.router, prefix=settings.api_prefix)
app.include_router(tailor.router, prefix=settings.api_prefix)
app.include_router(registry.router, prefix=settings.api_prefix)


@app.get("/api/health", tags=["meta"], summary="Health check")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "app": settings.app_name,
        "version": settings.version,
        "database": str(settings.database_file),
        **db.counts(),
        "llm_configured": settings.llm_configured,
    }
