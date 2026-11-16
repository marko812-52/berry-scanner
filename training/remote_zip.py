"""Читання ZIP-архіву просто з інтернету частинами (HTTP Range), без завантаження цілого файлу.

Потрібно, коли з архіву на сотні мегабайт нам треба лише кілька папок (наприклад, класи ягід із Fruits-360).
Працює з будь-яким сервером, що підтримує заголовок Range (Zenodo, сховище Mendeley Data).
"""
from __future__ import annotations

import io
import zipfile

import requests

USER_AGENT = "berry-scanner-training/1.0 (open-data downloader)"


class HttpRangeFile(io.RawIOBase):
    """Файлоподібний об'єкт поверх URL: читає шматками й тримає останній шматок у пам'яті."""

    def __init__(self, url: str, chunk: int = 4 * 1024 * 1024, session: requests.Session | None = None):
        self.url = url
        self.chunk = chunk
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        head = self.session.get(url, headers={"Range": "bytes=0-0"}, stream=True, timeout=60, allow_redirects=True)
        head.raise_for_status()
        if head.status_code != 206 or "Content-Range" not in head.headers:
            raise OSError("Сервер не підтримує часткове завантаження (Range): " + url)
        self.url = head.url  # після переадресації
        self.size = int(head.headers["Content-Range"].rsplit("/", 1)[1])
        head.close()
        self.pos = 0
        self._buf_start = 0
        self._buf = b""
        self.bytes_fetched = 0

    def seekable(self) -> bool:
        return True

    def readable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            self.pos = offset
        elif whence == io.SEEK_CUR:
            self.pos += offset
        else:
            self.pos = self.size + offset
        return self.pos

    def _fetch(self, start: int, length: int) -> bytes:
        end = min(self.size, start + length) - 1
        for attempt in range(4):
            try:
                r = self.session.get(self.url, headers={"Range": f"bytes={start}-{end}"}, timeout=120)
                r.raise_for_status()
                self.bytes_fetched += len(r.content)
                return r.content
            except requests.RequestException:
                if attempt == 3:
                    raise
        return b""

    def read(self, n: int = -1) -> bytes:
        if n is None or n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        b0 = self._buf_start
        if not (b0 <= self.pos and self.pos + n <= b0 + len(self._buf)):
            self._buf_start = self.pos
            self._buf = self._fetch(self.pos, max(n, self.chunk))
            b0 = self._buf_start
        out = self._buf[self.pos - b0:self.pos - b0 + n]
        self.pos += len(out)
        return out

    def readinto(self, b) -> int:
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)


def open_remote_zip(url: str, chunk: int = 4 * 1024 * 1024) -> tuple[zipfile.ZipFile, HttpRangeFile]:
    raw = HttpRangeFile(url, chunk=chunk)
    # Каталог архіву лежить у кінці файлу: одразу беремо хвіст одним запитом.
    tail = min(raw.size, 8 * 1024 * 1024)
    raw._buf_start = raw.size - tail
    raw._buf = raw._fetch(raw.size - tail, tail)
    return zipfile.ZipFile(io.BufferedReader(raw, buffer_size=1024 * 1024)), raw
