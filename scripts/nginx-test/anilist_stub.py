"""Stand-in for AniList's image CDN (s4.anilist.co) in the nginx harness.

:443 speaks TLS 1.3 with a certificate for s4.anilist.co that the harness's
test root CA issued through two intermediate CAs; the harness mounts that
root into nginx as its only trusted CA.  Session tickets are off, so no
connection can resume an earlier session: every connection shows nginx a
certificate to check, including right after the certificate is switched.

GET /file/anilistcdn/<path> answers 200 with "original <path> v<version>"
and a Last-Modified that moves with the version; an If-Modified-Since at or
after it gets a 304.  Both carry every header that would stop a naive cache
from storing them (Cache-Control: no-store, an Expires in the past, Vary: *,
Set-Cookie, X-Accel-Expires: 0, X-Accel-Redirect) and headers that must never
reach our visitors (Set-Cookie, Strict-Transport-Security, Report-To, NEL).
Error answers carry headers that invite a cache to keep them.

:9000 is plain HTTP, for the harness.  <path> is the part after
/file/anilistcdn/.
  /set?path=<path>[&status=N][&retry_after=S][&version=N][&delay=S]
  /all?status=N        answer every path with N (0: back to per-path rules)
  /listen?on=0|1       stop, or resume, accepting connections on :443
  /cert?mode=good|untrusted|wrong_name
  /hits[?path=<path>]  requests answered, in all or for one path
  /last?field=F        from the last request: target, sni, status,
                       header_names, or a request header (lower case)
  /targets             every request target seen, one per line
"""
import email.utils
import socket
import ssl
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

PREFIX = "/file/anilistcdn/"
CERT_DIR = "/certs"
# Last-Modified of version n is n days after this (2026-01-01T00:00:00Z).
FIRST_MODIFIED = 1767225600
DAY = 86400

STORE_REPELLENT = (
    ("Cache-Control", "private, no-store"),
    ("Expires", "Thu, 01 Jan 1970 00:00:00 GMT"),
    ("Vary", "*"),
    ("Set-Cookie", "anilist_test=1; Path=/"),
    ("X-Accel-Expires", "0"),
    ("X-Accel-Redirect", "/maintenance.html"),
    ("Strict-Transport-Security", "max-age=1"),
    ("Report-To", '{"group":"cf-nel","max_age":1,"endpoints":[{"url":"https://reports.invalid/"}]}'),
    ("NEL", '{"report_to":"cf-nel","max_age":1}'),
)
ERROR_CACHEABLE = (
    ("Cache-Control", "public, max-age=3600"),
    ("X-Accel-Expires", "3600"),
)

Headers = tuple[tuple[str, str], ...]

lock = threading.Lock()
rules: dict[str, dict[str, float]] = {}
hits_by_path: dict[str, int] = {}
targets: list[str] = []
last: dict[str, str] = {}
state = {"all": 0, "cert": "good", "sni": "", "hits": 0}


def tls_context(name: str) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_3
    ctx.num_tickets = 0
    ctx.options |= ssl.OP_NO_TICKET
    ctx.load_cert_chain(f"{CERT_DIR}/{name}-chain.pem", f"{CERT_DIR}/{name}.key")
    return ctx


CONTEXTS = {mode: tls_context(mode) for mode in ("good", "untrusted", "wrong_name")}
LISTENING = tls_context("good")


def choose_certificate(conn: ssl.SSLSocket, server_name: str | None, _: ssl.SSLContext) -> None:
    with lock:
        state["sni"] = server_name or ""
        mode = state["cert"]
    conn.context = CONTEXTS[mode]


LISTENING.sni_callback = choose_certificate


class TLSServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 256

    def finish_request(self, request: socket.socket, client_address: tuple) -> None:
        # The handshake runs here, in the connection's own thread, so a slow
        # or refused one never holds up the accept loop.
        with lock:
            state["sni"] = ""
        try:
            conn = LISTENING.wrap_socket(request, server_side=True)
        except OSError:
            return  # nginx refused the certificate, or went away
        try:
            self.RequestHandlerClass(conn, client_address, self)
        finally:
            conn.close()


class CDN(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        target = self.path
        path = urlsplit(target).path
        name = path[len(PREFIX):] if path.startswith(PREFIX) else path
        with lock:
            state["hits"] += 1
            hits_by_path[name] = hits_by_path.get(name, 0) + 1
            targets.append(target)
            last.clear()
            last.update({k.lower(): v for k, v in self.headers.items()})
            last["target"] = target
            last["sni"] = str(state["sni"])
            last["header_names"] = " ".join(sorted({k.lower() for k in self.headers.keys()}))
            rule = dict(rules.get(name, {}))
            status = int(state["all"]) or int(rule.get("status", 200))
        time.sleep(rule.get("delay", 0))
        if status == 200:
            self.answer_original(name, int(rule.get("version", 1)))
        else:
            self.answer_error(status, int(rule.get("retry_after", 0)))

    def answer_original(self, name: str, version: int) -> None:
        modified_at = FIRST_MODIFIED + version * DAY
        modified = email.utils.formatdate(modified_at, usegmt=True)
        since = self.headers.get("If-Modified-Since")
        if since and email.utils.parsedate_to_datetime(since).timestamp() >= modified_at:
            self.answer(304, b"", (("Last-Modified", modified),) + STORE_REPELLENT)
            return
        body = f"original {name} v{version}\n".encode()
        headers = (("Content-Type", "image/png"), ("Last-Modified", modified))
        self.answer(200, body, headers + STORE_REPELLENT)

    def answer_error(self, status: int, retry_after: int) -> None:
        headers: Headers = (("Content-Type", "text/plain"),) + ERROR_CACHEABLE
        if retry_after:
            headers += (("Retry-After", str(retry_after)),)
        self.answer(status, f"stub {status}\n".encode(), headers)

    def answer(self, status: int, body: bytes, headers: Headers) -> None:
        with lock:
            last["status"] = str(status)
        self.send_response(status)
        for key, value in headers:
            self.send_header(key, value)
        if status != 304:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if status != 304:
            self.wfile.write(body)


tls_server: TLSServer | None = None
listen_lock = threading.Lock()


def listen(on: bool) -> None:
    global tls_server
    with listen_lock:
        if on and tls_server is None:
            tls_server = TLSServer(("0.0.0.0", 443), CDN)
            threading.Thread(
                target=tls_server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
            ).start()
        elif not on and tls_server is not None:
            tls_server.shutdown()
            tls_server.server_close()
            tls_server = None


def set_rule(q: dict[str, str]) -> str:
    update = {k: int(q[k]) for k in ("status", "retry_after", "version") if k in q}
    if "delay" in q:
        update["delay"] = float(q["delay"])
    with lock:
        rules[q["path"]] = {**rules.get(q["path"], {}), **update}
    return "ok"


def set_all(q: dict[str, str]) -> str:
    with lock:
        state["all"] = int(q["status"])
    return "ok"


def set_listen(q: dict[str, str]) -> str:
    listen(q["on"] == "1")
    return "ok"


def set_cert(q: dict[str, str]) -> str:
    if q["mode"] not in CONTEXTS:
        raise ValueError(f"unknown certificate mode {q['mode']}")
    with lock:
        state["cert"] = q["mode"]
    return "ok"


def get_hits(q: dict[str, str]) -> str:
    with lock:
        return str(hits_by_path.get(q["path"], 0) if "path" in q else state["hits"])


def get_last(q: dict[str, str]) -> str:
    with lock:
        return last.get(q["field"].lower(), "")


def get_targets(_: dict[str, str]) -> str:
    with lock:
        return "\n".join(targets)


COMMANDS: dict[str, Callable[[dict[str, str]], str]] = {
    "set": set_rule,
    "all": set_all,
    "listen": set_listen,
    "cert": set_cert,
    "hits": get_hits,
    "last": get_last,
    "targets": get_targets,
}


class Control(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        url = urlsplit(self.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        command = COMMANDS.get(url.path.strip("/"))
        if command is None:
            self.reply(404, "unknown command\n")
            return
        try:
            self.reply(200, command(query) + "\n")
        except (KeyError, ValueError) as error:
            self.reply(400, f"bad request: {error}\n")

    def reply(self, status: int, text: str) -> None:
        body = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    listen(True)
    ThreadingHTTPServer(("0.0.0.0", 9000), Control).serve_forever()
