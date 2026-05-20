"""Bắt sự kiện TikTokLive và gửi tới các handler đã đăng ký."""
import asyncio
import hashlib
import os
import time
from collections import OrderedDict
from typing import Callable, List


def _sanitize_ssl_bundle_env() -> None:
    """Xóa SSL_CERT_FILE / REQUESTS_CA_BUNDLE nếu trỏ tới file không tồn tại.

    httpx (dùng bởi TikTokLive) đọc các biến này; trên Windows Cursor/WSL đôi khi để
    đường dẫn Linux hoặc file đã xóa → FileNotFoundError khi tạo AsyncClient.
    """
    for key in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        raw = os.environ.get(key)
        if not raw:
            continue
        path = raw.strip().strip('"').strip("'")
        if path and not os.path.isfile(path):
            os.environ.pop(key, None)


_sanitize_ssl_bundle_env()

from TikTokLive import TikTokLiveClient
from TikTokLive.client.web.web_settings import WebDefaults
from TikTokLive.events import (
    ConnectEvent, DisconnectEvent, LiveEndEvent,
    CommentEvent, GiftEvent, LikeEvent, JoinEvent,
    FollowEvent, ShareEvent, RoomUserSeqEvent
)
from monitor.euler_counter import patch as patch_euler, get_stats

patch_euler()

_DEDUP_TTL = 15   # giây — cửa sổ loại trùng lặp
_DEDUP_MAX = 3000


def _apply_euler_key():
    key = os.getenv("EULER_API_KEY", "").strip()
    if key:
        WebDefaults.tiktok_sign_api_key = key


def safe_avatar(user) -> str:
    if user is None:
        return ''
    for attr in ('avatar_thumb', 'avatar_large', 'avatar_medium', 'avatar_jpg', 'avatar'):
        obj = getattr(user, attr, None)
        if obj is None:
            continue
        m_urls = getattr(obj, 'm_urls', None)
        if m_urls:
            return m_urls[0] if isinstance(m_urls, (list, tuple)) else str(m_urls)
        url_list = getattr(obj, 'url_list', None)
        if url_list:
            return url_list[0] if isinstance(url_list, (list, tuple)) else str(url_list)
        m_uri = getattr(obj, 'm_uri', None)
        if m_uri:
            return str(m_uri)
        url = getattr(obj, 'url', None)
        if url:
            return str(url)
    return ''


def safe_str(user, attr: str, default='') -> str:
    try:
        val = getattr(user, attr, default)
        return str(val) if val else default
    except Exception:
        return default


def safe_int(obj, attr: str, default=0) -> int:
    try:
        val = getattr(obj, attr, default)
        return int(val) if val is not None else default
    except Exception:
        return default


def safe_bool(obj, attr: str, default=False) -> bool:
    try:
        return bool(getattr(obj, attr, default))
    except Exception:
        return default


def serialize_user(user) -> dict:
    if user is None:
        return {
            "user_id": "",
            "username": "",
            "nickname": "",
            "sec_uid": "",
            "avatar": "",
            "verified": False,
            "followers": 0,
            "following": 0,
        }

    follow_info = getattr(user, "follow_info", None)
    username = safe_str(user, "unique_id") or safe_str(user, "username")
    nickname = safe_str(user, "nickname") or safe_str(user, "nick_name")

    return {
        "user_id": safe_str(user, "id"),
        "username": username,
        "nickname": nickname,
        "sec_uid": safe_str(user, "sec_uid"),
        "avatar": safe_avatar(user),
        "verified": safe_bool(user, "is_verified"),
        "followers": safe_int(follow_info, "follower_count"),
        "following": safe_int(follow_info, "following_count"),
    }


def deep_get(data, *keys, default=None):
    cur = data
    for key in keys:
        if isinstance(cur, dict):
            cur = cur.get(key)
        else:
            cur = getattr(cur, key, None)
        if cur is None:
            return default
    return cur


def pick_image_url(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        for item in value:
            if isinstance(item, str) and item:
                return item
            if isinstance(item, dict):
                nested = pick_image_url(item.get("url_list") or item.get("urls") or item.get("url"))
                if nested:
                    return nested
    if isinstance(value, dict):
        for key in ("url_list", "urls", "cover_url", "avatar_url", "url", "uri"):
            nested = pick_image_url(value.get(key))
            if nested:
                return nested
    return ""


def serialize_room_info(room_info: dict | None, fallback_username: str) -> dict:
    room_info = room_info or {}
    owner = deep_get(room_info, "owner", default={}) or deep_get(room_info, "user", default={}) or {}
    title = deep_get(room_info, "title", default="") or deep_get(room_info, "room_title", default="")
    cover = (
        pick_image_url(deep_get(room_info, "cover", default=None))
        or pick_image_url(deep_get(room_info, "cover_url", default=None))
        or pick_image_url(deep_get(room_info, "dynamic_cover", default=None))
    )
    avatar = (
        pick_image_url(deep_get(owner, "avatar_thumb", default=None))
        or pick_image_url(deep_get(owner, "avatar_large", default=None))
        or pick_image_url(deep_get(owner, "avatar_url", default=None))
    )
    return {
        "room_id": safe_str(room_info, "id") or safe_str(room_info, "room_id"),
        "title": title,
        "cover": cover,
        "stream_url_hls": deep_get(room_info, "hls_pull_url", default="") or deep_get(room_info, "stream_url", default=""),
        "stream_url_flv": deep_get(room_info, "flv_pull_url", default=""),
        "current_viewers": safe_int(room_info, "user_count") or safe_int(room_info, "current_viewers"),
        "total_viewers": safe_int(room_info, "total_user_count") or safe_int(room_info, "total_viewers"),
        "start_time": safe_int(room_info, "create_time") or safe_int(room_info, "start_time"),
        "creator": {
            "user_id": safe_str(owner, "id") or safe_str(owner, "numeric_uid"),
            "username": safe_str(owner, "unique_id") or fallback_username.lstrip("@"),
            "nickname": safe_str(owner, "nickname"),
            "signature": safe_str(owner, "signature"),
            "sec_uid": safe_str(owner, "sec_uid"),
            "avatar": avatar,
            "verified": safe_bool(owner, "is_verified"),
            "followers": safe_int(owner, "followers"),
            "following": safe_int(owner, "following"),
        }
    }


def serialize_gift_info(gift_info: dict | None) -> dict:
    gift_info = gift_info or {}
    gifts = []
    raw_list = gift_info.get("gifts") or gift_info.get("gift_list") or []
    for item in raw_list:
        if not isinstance(item, dict):
            continue
        gifts.append({
            "id": item.get("id") or item.get("gift_id"),
            "name": item.get("name") or item.get("describe") or "Quà",
            "diamond_count": item.get("diamond_count") or item.get("diamondCount") or 0,
            "image": pick_image_url(item.get("image") or item.get("icon") or item.get("gift_image")),
        })
    return {
        "count": len(gifts),
        "gifts": gifts,
    }


class _DedupCache:
    """
    Cache LRU+TTL để loại trùng theo khóa nội dung.
    Khóa = hash(loại + user_id + nội_dung_chính).
    """

    def __init__(self, ttl: int = _DEDUP_TTL, maxsize: int = _DEDUP_MAX):
        self._ttl = ttl
        self._maxsize = maxsize
        self._store: OrderedDict[str, float] = OrderedDict()

    def _make_key(self, tipo: str, user_id: str, content: str) -> str:
        raw = f"{tipo}:{user_id}:{content}"
        return hashlib.md5(raw.encode()).hexdigest()

    def is_duplicate(self, tipo: str, user_id: str, content: str) -> bool:
        key = self._make_key(tipo, user_id, content)
        now = time.monotonic()
        # Dọn định kỳ các mục hết hạn
        if len(self._store) > self._maxsize // 2:
            expired = [k for k, ts in self._store.items() if now - ts > self._ttl]
            for k in expired:
                del self._store[k]
        if key in self._store:
            if now - self._store[key] < self._ttl:
                return True
            del self._store[key]
        # LRU: xóa khi đầy
        if len(self._store) >= self._maxsize:
            self._store.popitem(last=False)
        self._store[key] = now
        return False


class LiveCollector:
    def __init__(self, username: str):
        _apply_euler_key()
        self.username = username
        self.client = TikTokLiveClient(unique_id=username)
        self._handlers: List[Callable] = []
        self._viewer_count = 0
        self._dedup = _DedupCache()
        self._client_task: asyncio.Task | None = None
        self._setup_events()

    def on_event(self, handler: Callable):
        self._handlers.append(handler)

    def _emit(self, event_data: dict):
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        for handler in self._handlers:
            loop.create_task(handler(event_data))

    def _emit_euler(self):
        stats = get_stats()
        self._emit({"type": "euler_stats", "count": stats["count"], "remaining": stats["remaining"]})

    def _dup(self, tipo: str, user_id: str, content: str) -> bool:
        return self._dedup.is_duplicate(tipo, user_id, content)

    def _setup_events(self):
        client = self.client

        @client.on(ConnectEvent)
        async def on_connect(event):
            self._emit({"type": "connect", "username": self.username})
            self._emit_euler()

        @client.on(DisconnectEvent)
        async def on_disconnect(event):
            self._emit({"type": "disconnect"})

        @client.on(LiveEndEvent)
        async def on_end(event):
            self._emit({"type": "live_end"})

        @client.on(CommentEvent)
        async def on_comment(event: CommentEvent):
            try:
                profile = serialize_user(event.user)
                uid = profile["username"]
                text = getattr(event, 'comment', '') or ''
                # Bình luận: user + nội dung đúng. TTL=15s tránh nuốt
                # các tin giống nhau cố ý gửi lặp
                if self._dup('comment', uid, text):
                    return
                self._emit({
                    "type": "comment",
                    "user": uid,
                    "nickname": profile["nickname"],
                    "avatar": profile["avatar"],
                    "profile": profile,
                    "text": text,
                })
            except Exception:
                pass

        @client.on(GiftEvent)
        async def on_gift(event: GiftEvent):
            try:
                gift = getattr(event, 'gift', None)
                streakable = getattr(gift, 'streakable', False)
                streaking = getattr(event, 'streaking', False)
                if streakable and streaking:
                    return
                profile = serialize_user(event.user)
                uid = profile["username"]
                gift_name = getattr(gift, 'name', 'Quà') if gift else 'Quà'
                count = str(getattr(event, 'repeat_count', 1) or 1)
                if self._dup('gift', uid, gift_name + count):
                    return
                self._emit({
                    "type": "gift",
                    "user": uid,
                    "nickname": profile["nickname"],
                    "avatar": profile["avatar"],
                    "profile": profile,
                    "gift_name": gift_name,
                    "gift_count": int(count),
                    "coin_value": getattr(gift, 'diamond_count', 0) if gift else 0,
                })
                self._emit_euler()
            except Exception:
                pass

        @client.on(LikeEvent)
        async def on_like(event: LikeEvent):
            try:
                profile = serialize_user(event.user)
                uid = profile["username"]
                if self._dup('like', uid, uid):
                    return
                self._emit({
                    "type": "like",
                    "user": uid,
                    "nickname": profile["nickname"],
                    "avatar": profile["avatar"],
                    "profile": profile,
                })
            except Exception:
                pass

        @client.on(JoinEvent)
        async def on_join(event: JoinEvent):
            try:
                profile = serialize_user(event.user)
                uid = profile["username"]
                if self._dup('join', uid, uid):
                    return
                self._emit({
                    "type": "join",
                    "user": uid,
                    "nickname": profile["nickname"],
                    "avatar": profile["avatar"],
                    "profile": profile,
                })
            except Exception:
                pass

        @client.on(FollowEvent)
        async def on_follow(event: FollowEvent):
            try:
                profile = serialize_user(event.user)
                uid = profile["username"]
                if self._dup('follow', uid, uid):
                    return
                self._emit({
                    "type": "follow",
                    "user": uid,
                    "nickname": profile["nickname"],
                    "avatar": profile["avatar"],
                    "profile": profile,
                })
            except Exception:
                pass

        @client.on(ShareEvent)
        async def on_share(event: ShareEvent):
            try:
                profile = serialize_user(event.user)
                uid = profile["username"]
                if self._dup('share', uid, uid):
                    return
                self._emit({
                    "type": "share",
                    "user": uid,
                    "nickname": profile["nickname"],
                    "avatar": profile["avatar"],
                    "profile": profile,
                })
            except Exception:
                pass

        @client.on(RoomUserSeqEvent)
        async def on_viewers(event: RoomUserSeqEvent):
            try:
                count = getattr(event, 'viewer_count', 0) or 0
                if count != self._viewer_count:
                    self._viewer_count = count
                    self._emit({"type": "viewers", "count": count})
            except Exception:
                pass

    async def start(self):
        self._client_task = await self.client.start(fetch_room_info=True, fetch_gift_info=True)
        self._emit({
            "type": "room_info",
            "room": serialize_room_info(self.client.room_info, self.username),
        })
        self._emit({
            "type": "gift_catalog",
            "catalog": serialize_gift_info(self.client.gift_info),
        })
        await self._client_task

    async def stop(self):
        task = self._client_task
        try:
            if task and not task.done():
                task.cancel()
            await self.client.disconnect()
            if task and not task.done():
                try:
                    await asyncio.wait_for(asyncio.shield(task), timeout=3.0)
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    pass
        except Exception:
            pass
        finally:
            self._client_task = None
