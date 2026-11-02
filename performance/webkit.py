"""Run the local browser fixture in Linux WebKitGTK; requires system PyGObject."""

import json
import sys
import time

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

window = Gtk.Window()
window.set_default_size(1440, 900)
view = WebKit2.WebView.new_with_context(WebKit2.WebContext.new_ephemeral())
window.add(view)
window.show_all()
deadline = time.monotonic() + 120
exit_status = 1
pending = False


def received(webview, result):
    global exit_status, pending
    try:
        value = webview.evaluate_javascript_finish(result).to_string()
        if value != "null":
            report = json.loads(value)
            print(json.dumps(report, indent=2))
            exit_status = int("error" in report)
            Gtk.main_quit()
    finally:
        pending = False


def poll():
    global pending
    if time.monotonic() > deadline:
        print("WebKit benchmark timed out", file=sys.stderr)
        Gtk.main_quit()
        return False
    if not pending:
        pending = True
        view.evaluate_javascript(
            "JSON.stringify(window.performanceResult || null)",
            -1, None, None, None, received,
        )
    return True


view.load_uri(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8743/performance.html?autorun")
GLib.timeout_add(200, poll)
Gtk.main()
window.destroy()
sys.exit(exit_status)
