"""Backend FastAPI và WebSocket cho bảng điều khiển."""
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Set, Optional

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from groq import Groq
import uvicorn

_root = str(Path(__file__).parent.parent)
if _root not in sys.path:
    sys.path.insert(0, _root)

app = FastAPI(title="Giám sát TikTok Live")

static_path = Path(__file__).parent / "static"
if static_path.exists():
    app.mount("/static", StaticFiles(directory=str(static_path)), name="static")

connected_clients: Set[WebSocket] = set()
collector_task: Optional[asyncio.Task] = None
current_collector = None
current_username: str = ""
_groq_client: Optional[Groq] = None


class VoiceChatRequest(BaseModel):
    text: str


def _get_groq_client() -> Groq:
    global _groq_client
    if _groq_client is not None:
        return _groq_client
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key:
        raise ValueError("Chưa cấu hình GROQ_API_KEY trong file .env")
    _groq_client = Groq(api_key=api_key)
    return _groq_client


def _generate_voice_reply(user_text: str) -> str:
    text = (user_text or "").strip()
    if not text:
        raise ValueError("Bạn chưa nói nội dung nào.")
    if len(text) > 1000:
        text = text[:1000]

    model = os.getenv("AI_MODEL", "llama-3.3-70b-versatile").strip() or "llama-3.3-70b-versatile"
    client = _get_groq_client()

    completion = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "system",
                "content": (
                    "Bạn là bot trả lời bình luận TikTok Live tiếng Việt. "
                    "Nói chuyện kiểu Gen Z Việt Nam, hài hước, cà khịa mạnh, troll duyên, phản ứng nhanh như streamer. "
                    "Được phép xưng hô m - tao, bố - con, anh - em tùy ngữ cảnh cho vui. "
                    "Luôn trả lời ngắn gọn 1 câu, tối đa 15 từ. "
                    "Ưu tiên câu gây cười, bất ngờ, meme, bắt trend mạng xã hội Việt Nam. "
                    "Không lịch sự quá mức, không robot, không giải thích dài dòng. "
                    "Có thể chọc nhẹ người xem nhưng không xúc phạm nặng, không toxic cực đoan, không phân biệt vùng miền/chủng tộc. "
                    "Nếu bị spam hoặc hỏi nhảm thì đáp kiểu troll hài: 'não m lag à', 'hỏi câu đau server vậy', 't chịu m luôn'. "
                    "Nếu được khen thì phản ứng tự luyến hài hước. "
                    "Nếu bị chê thì cà khịa ngược vui vẻ như streamer TikTok. "
                    "Không được thêm biểu tượng cảm xúc hoặc ký tự emoji vào câu trả lời."
                ),
            },
            {"role": "user", "content": text},
        ],
        temperature=0.8,
        max_tokens=80,
        top_p=1,
        stream=False,
    )
    answer = (completion.choices[0].message.content or "").strip()
    return answer or "Mình đang nghe đây, bạn nói lại giúp mình nhé."


async def fetch_euler_rate_limits() -> dict:
    api_key = os.getenv("EULER_API_KEY", "").strip()
    params = {"apiKey": api_key} if api_key else {}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get("https://tiktok.eulerstream.com/webcast/rate_limits", params=params)
            response.raise_for_status()
            data = response.json()
            return {
                "type": "euler_limits",
                "limits": {
                    "minute": data.get("minute", {}),
                    "hour": data.get("hour", {}),
                    "day": data.get("day", {}),
                    "load_shedding": data.get("load_shedding", {}),
                }
            }
    except Exception:
        return {"type": "euler_limits", "limits": {}}


async def broadcast(data: dict):
    global connected_clients
    if not connected_clients:
        return
    message = json.dumps(data, ensure_ascii=False)
    dead = set()
    for ws in connected_clients:
        try:
            await ws.send_text(message)
        except Exception:
            dead.add(ws)
    if dead:
        connected_clients = connected_clients - dead


@app.get("/", response_class=HTMLResponse)
async def root():
    html_path = Path(__file__).parent / "static" / "index.html"
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


@app.post("/api/voice/chat")
async def voice_chat(payload: VoiceChatRequest):
    try:
        answer = await asyncio.to_thread(_generate_voice_reply, payload.text)
        return {"ok": True, "reply": answer}
    except Exception as e:
        return {"ok": False, "reply": "", "error": str(e)}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    connected_clients.add(ws)
    try:
        while True:
            data = await ws.receive_text()
            msg = json.loads(data)
            if msg.get("action") == "connect":
                username = msg.get("username", "").strip()
                if username:
                    await start_monitor(username, ws)
    except WebSocketDisconnect:
        connected_clients.discard(ws)
    except Exception:
        connected_clients.discard(ws)


async def _stop_current():
    global collector_task, current_collector, current_username
    if collector_task and not collector_task.done():
        collector_task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(collector_task), timeout=3.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
    collector_task = None
    if current_collector:
        try:
            await current_collector.stop()
        except Exception:
            pass
        current_collector = None
    current_username = ""
    await asyncio.sleep(1.5)


@app.on_event("shutdown")
async def shutdown_event():
    await _stop_current()
    connected_clients.clear()


async def start_monitor(username: str, ws: WebSocket):
    global collector_task, current_collector, current_username

    if username == current_username and current_collector is not None:
        try:
            await ws.send_text(json.dumps({"type": "status", "message": f"Đã kết nối sẵn tới {username}"}))
        except Exception:
            pass
        return

    await _stop_current()
    current_username = username

    from monitor.collector import LiveCollector

    try:
        await ws.send_text(json.dumps({"type": "status", "message": f"Đang kết nối tới {username}..."}))
        await ws.send_text(json.dumps(await fetch_euler_rate_limits()))
    except Exception:
        pass

    async def run_with_retry():
        global current_collector
        while True:
            collector = LiveCollector(username)
            current_collector = collector
            collector.on_event(broadcast)
            try:
                await collector.start()
                await broadcast({"type": "status", "message": f"Kết nối tới {username} đã đóng, đang kết nối lại..."})
                await asyncio.sleep(3)
            except asyncio.CancelledError:
                await collector.stop()
                break
            except Exception as e:
                err = str(e)
                await broadcast({"type": "error", "message": err})
                try:
                    await collector.stop()
                except Exception:
                    pass
                wait = 30 if "RATE_LIMIT" in err or "rate_limit" in err.lower() else 10
                await asyncio.sleep(wait)
                await broadcast({"type": "status", "message": f"Đang kết nối lại tới {username}..."})

    collector_task = asyncio.create_task(run_with_retry())


if __name__ == "__main__":
    port = int(os.getenv("WEB_PORT", 8000))
    uvicorn.run("web.server:app", host="0.0.0.0", port=port, reload=False, log_level="info")
