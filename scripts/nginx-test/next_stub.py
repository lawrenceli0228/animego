"""Stand-in for next-image (and next-app) in the nginx behaviour harness.

:3000 answers every request with a 1x1 PNG.  The url query parameter picks a
delay, so the harness can make an image slow on purpose: a url starting with
/veryslow waits 40s, /slower 5s, /slow 1s, anything else answers at once.
X-Stub names the stand-in that answered (STUB_NAME), and X-Url echoes the
url it was asked for, which shows whose bytes a cached answer holds.

:9000 answers "<requests seen> <most requests in flight at once>".
"""
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

NAME = os.environ["STUB_NAME"]
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)
DELAYS = (("/veryslow", 40.0), ("/slower", 5.0), ("/slow", 1.0))

lock = threading.Lock()
stats = {"hits": 0, "inflight": 0, "max_inflight": 0}


def delay_for(url: str) -> float:
    for prefix, seconds in DELAYS:
        if url.startswith(prefix):
            return seconds
    return 0.0


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # nginx opens up to 256 connections at once in the flood check; with the
    # default listen backlog of 5, some of them would wait on SYN retries.
    request_queue_size = 1024


class Image(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        url = parse_qs(urlparse(self.path).query).get("url", [""])[0]
        with lock:
            stats["hits"] += 1
            stats["inflight"] += 1
            stats["max_inflight"] = max(stats["max_inflight"], stats["inflight"])
        try:
            time.sleep(delay_for(url))
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(PNG)))
            self.send_header("X-Stub", NAME)
            self.send_header("X-Url", url)
            self.end_headers()
            self.wfile.write(PNG)
        finally:
            with lock:
                stats["inflight"] -= 1


class Control(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        with lock:
            body = f"{stats['hits']} {stats['max_inflight']}\n".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    control = Server(("0.0.0.0", 9000), Control)
    threading.Thread(target=control.serve_forever, daemon=True).start()
    Server(("0.0.0.0", 3000), Image).serve_forever()
