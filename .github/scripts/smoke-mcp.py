"""Drive Settings and read its copied config on smoke-linux.sh's private desktop."""

import json
import os
from pathlib import Path
import subprocess
import sys
import time

if __name__ == "__main__" and Path(__file__) != Path("/smoke-mcp.py"):
    sys.exit("Use smoke-linux.sh to create a private desktop first")

import gi

gi.require_version("Atspi", "2.0")
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Atspi, Gdk, GLib, Gtk


def wait_for(app, description, check, timeout=20):
    deadline = time.monotonic() + timeout
    while app.poll() is None and time.monotonic() < deadline:
        while GLib.MainContext.default().iteration(False):
            pass
        result = check()
        if result:
            return result
        time.sleep(0.1)
    raise RuntimeError(f"Did not find {description} (app exit: {app.poll()})")


def control(node, label):
    if node.get_name() == label and node.get_state_set().contains(Atspi.StateType.FOCUSABLE):
        return node
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child:
            found = control(child, label)
            if found:
                return found
    return None


def check_stdio(config, app_path):
    assert config["command"] == app_path, "Copy setup did not name the packaged binary"
    assert config["args"] == ["--mcp"], "Copy setup did not specify --mcp"
    # Electron-based clients inherit this variable and apply the copied config's env last.
    env = {**os.environ, "ELECTRON_RUN_AS_NODE": "1", **config.get("env", {})}
    proxy = subprocess.Popen([config["command"], *config["args"]], env=env,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def send(message):
        proxy.stdin.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
        proxy.stdin.flush()

    def request(id_, method, params):
        print(f"stdio: {method}")
        send({"id": id_, "method": method, "params": params})
        reply = json.loads(proxy.stdout.readline())
        assert reply["jsonrpc"] == "2.0" and reply["id"] == id_, reply
        assert "error" not in reply, reply.get("error")
        return reply["result"]

    try:
        init = request(1, "initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "gitdesk package smoke", "version": "1"},
        })
        assert init["serverInfo"]["name"] == "gitdesk" and "tools" in init["capabilities"]
        send({"method": "notifications/initialized"})
        tools = request(2, "tools/list", {})["tools"]
        assert any(tool["name"] == "list_repositories" for tool in tools)
        result = request(3, "tools/call", {"name": "list_repositories", "arguments": {}})
        assert not result.get("isError"), result
        item, = result["content"]
        assert item["type"] == "text" and json.loads(item["text"])["repositories"] == []
        proxy.stdin.close()
        assert proxy.wait(timeout=5) == 0 and not proxy.stdout.read(), "Unexpected proxy exit/output"
        print(f"Discovered {len(tools)} tools; list_repositories returned an empty list.")
    finally:
        proxy.kill()
        proxy.wait()


def smoke(app_path):
    profile = Path.home() / ".config/gitdesk"
    log = profile / "logs/main.log"
    assert not profile.exists(), "Expected a fresh smoke profile"
    subprocess.run([
        "gdbus", "call", "--session", "--dest", "org.a11y.Bus", "--object-path", "/org/a11y/bus",
        "--method", "org.freedesktop.DBus.Properties.Set", "org.a11y.Status", "IsEnabled", "<true>",
    ], check=True, stdout=subprocess.DEVNULL)
    app = subprocess.Popen([app_path, "--force-renderer-accessibility"])
    try:
        wait_for(app, "window ready", lambda: log.is_file() and "window ready" in log.read_text(), timeout=60)
        desktop = Atspi.get_desktop(0)
        for label in ("Continue without an account", "Settings", "MCP",
                      "Let agents on this computer connect", "Copy setup"):
            print(f"Settings smoke: {label}")
            button = wait_for(app, label, lambda: control(desktop, label))
            assert button.do_action(0), f"Could not activate {label}"
        clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        copied = wait_for(app, "copied MCP config", clipboard.wait_for_text)
        wait_for(app, "profile's MCP listener", lambda: (profile / "mcp.token").is_file())
        check_stdio(json.loads(copied)["mcpServers"]["gitdesk"], app_path)
    except Exception:
        if log.is_file():
            print(log.read_text(), file=sys.stderr)
        raise
    finally:
        app.terminate()
        try:
            app.wait(timeout=5)
        except subprocess.TimeoutExpired:
            app.kill()
            app.wait()


if __name__ == "__main__":
    smoke(sys.argv[1])
