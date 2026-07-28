"""Minimal client for the BlenderMCP addon socket (localhost:9876).

Speaks the same protocol the blender-mcp MCP server speaks, so it verifies the
addon end of the integration without needing the MCP tools loaded.
"""
import json
import socket
import sys


def send(cmd_type, params=None, timeout=120.0):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(("localhost", 9876))
    s.sendall(json.dumps({"type": cmd_type, "params": params or {}}).encode())

    chunks = []
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
        try:
            return json.loads(b"".join(chunks).decode())
        except json.JSONDecodeError:
            continue  # partial response, keep reading
    raise RuntimeError("connection closed before a complete response")


def run_code(code, timeout=900.0):
    r = send("execute_code", {"code": code}, timeout=timeout)
    if r.get("status") != "success":
        raise RuntimeError(r.get("message", r))
    return r["result"]


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "get_scene_info"
    if cmd == "code":
        print(json.dumps(run_code(sys.stdin.read()), indent=2)[:4000])
    else:
        print(json.dumps(send(cmd), indent=2)[:4000])
