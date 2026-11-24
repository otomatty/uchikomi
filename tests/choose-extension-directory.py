"""Select a directory in Chrome's native GTK file chooser on the Linux CI desktop."""
import subprocess
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi


def children(node):
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child:
            yield child
            yield from children(child)


def wait_for(find, label):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        result = find()
        if result:
            return result
        time.sleep(0.2)
    raise RuntimeError("File picker did not expose " + label)


def chooser():
    for app in children(Atspi.get_desktop(0)):
        if app.get_name() == "Select the extension directory.":
            return app
    return None


def visible(node):
    return node.get_state_set().contains(Atspi.StateType.SHOWING)


dialog = wait_for(chooser, "the directory chooser")
subprocess.run(["xdotool", "key", "--clearmodifiers", "ctrl+l"], check=True)
entry = wait_for(lambda: next((node for node in children(dialog)
                              if visible(node) and node.get_state_set().contains(Atspi.StateType.EDITABLE)), None),
                 "the editable location")
if not entry.set_text_contents(sys.argv[1]):
    raise RuntimeError("Could not enter the extension directory")
assert entry.get_text(0, -1) == sys.argv[1]

# Activate the named affirmative button rather than relying on GTK's current
# default action, which can simply navigate into the typed directory.
def select_button():
    return next((node for node in children(dialog) if visible(node)
                 and node.get_role() == Atspi.Role.PUSH_BUTTON
                 and node.get_name().strip('_').lower() in ('open', 'select', 'select folder')
                 and node.get_state_set().contains(Atspi.StateType.SENSITIVE)), None)


button = wait_for(select_button, "the enabled Select/Open button")
print("Choosing", entry.get_text(0, -1), "with", button.get_name(), flush=True)
if not button.do_action(0):
    raise RuntimeError("Could not confirm the selected directory")
