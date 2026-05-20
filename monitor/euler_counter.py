"""
Chặn request HTTP thật của httpx (TikTokLive v6+)
tới máy chủ Euler Stream và đếm mỗi lần gọi trong cửa sổ 60 giây.
"""
import time

try:
    import httpx
    _HAS_HTTPX = True
except ImportError:
    _HAS_HTTPX = False

EULER_HOST = "eulerstream.com"

_count: int = 0
_window_start: float = time.time()
_patched: bool = False


def get_stats() -> dict:
    global _count, _window_start
    now = time.time()
    elapsed = now - _window_start
    if elapsed >= 60:
        _count = 0
        _window_start = now
        elapsed = 0
    return {
        "count": _count,
        "window_sec": int(elapsed),
        "remaining": max(0, 60 - int(elapsed)),
    }


def _tick():
    global _count, _window_start
    now = time.time()
    if now - _window_start >= 60:
        _count = 0
        _window_start = now
    _count += 1


def patch():
    """Monkey-patch httpx.AsyncClient.send để đếm request thật tới Euler."""
    global _patched
    if _patched or not _HAS_HTTPX:
        return

    _original_send = httpx.AsyncClient.send

    async def _patched_send(self, request, **kwargs):
        if EULER_HOST in str(request.url):
            _tick()
        return await _original_send(self, request, **kwargs)

    httpx.AsyncClient.send = _patched_send
    _patched = True
