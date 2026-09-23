"""One JSON file on disk, read and written safely.

Extracted from db.py so the app can keep more than one store: db.json holds
users and generated resumes, registry.json holds the application registry.
Keeping them in separate files means a registry that grows with every download
never slows down loading the user list, and either file can be backed up,
inspected or deleted on its own.

Two guarantees, both of which a naive `json.dump(open(path, "w"))` loses:

* **Atomic writes.** The new content goes to a temp file in the same directory
  and is then moved over the old one. A crash mid-write leaves the previous
  file intact instead of a half-written one.
* **One writer at a time.** An RLock per store serialises read-modify-write
  cycles within the process, so two requests appending at once cannot drop one
  another's entry.

The lock is per process, which is why the deployment notes insist on a single
uvicorn worker. Swapping either store for SQLite later means rewriting this
module and nothing else.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator


class JsonStore:
    """A JSON document on disk, with a lock and atomic writes.

    `path_getter` is a callable rather than a Path so the location is resolved
    at call time — settings are read from the environment at import, and the
    tests point DATA_FILE somewhere temporary.
    """

    def __init__(
        self, path_getter: Callable[[], Path], empty: dict[str, list[Any]]
    ) -> None:
        self._path_getter = path_getter
        self._empty = empty
        self._lock = threading.RLock()

    @property
    def path(self) -> Path:
        return Path(self._path_getter())

    @property
    def lock(self) -> threading.RLock:
        return self._lock

    def empty(self) -> dict[str, list[Any]]:
        return {k: list(v) for k, v in self._empty.items()}

    # -- io ----------------------------------------------------------------

    def _atomic_write(self, data: dict[str, Any]) -> None:
        path = self.path
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2, ensure_ascii=False)
                fh.write("\n")
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    def ensure_file(self) -> None:
        with self._lock:
            path = self.path
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                self._atomic_write(self.empty())

    def read(self) -> dict[str, Any]:
        """The whole document. A missing or corrupt file reads as empty rather
        than raising — the app should start, not refuse to."""
        with self._lock:
            self.ensure_file()
            try:
                with self.path.open("r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except (json.JSONDecodeError, OSError):
                data = self.empty()
            if not isinstance(data, dict):
                data = self.empty()
            for key, default in self._empty.items():
                data.setdefault(key, list(default))
            return data

    def write(self, data: dict[str, Any]) -> None:
        with self._lock:
            self._atomic_write(data)

    @contextmanager
    def transaction(self) -> Iterator[dict[str, Any]]:
        """Read-modify-write, with the lock held for the whole block:

            with store.transaction() as data:
                data["entries"].append(entry)

        The file is written once, on a clean exit. An exception inside the
        block leaves the file untouched.
        """
        with self._lock:
            data = self.read()
            yield data
            self.write(data)

    def collection(self, name: str) -> list[dict[str, Any]]:
        """Read-only snapshot of one collection."""
        value = self.read().get(name, [])
        return value if isinstance(value, list) else []

    def backup_once(self) -> None:
        """Copy the file to `<name>.json.bak`, the first time only. Called
        before a migration rewrites rows."""
        with self._lock:
            path = self.path
            backup = path.with_suffix(".json.bak")
            if not backup.exists() and path.exists():
                backup.write_bytes(path.read_bytes())
