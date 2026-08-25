import os

layout_path = 'src/components/layout/CustomerLayout.jsx'
with open(layout_path, 'r') as f:
    lines = f.readlines()

new_lines = []
skip = False
for line in lines:
    if "location.pathname !== '/customer/support' && (" in line and "floating-chat-fab" in "".join(lines):
        # We need to skip my injected block
        pass
with open(layout_path, 'r') as f:
    content = f.read()

# Remove the block I added
start_marker = "    {location.pathname !== '/customer/support' && (\n      <Link \n        to=\"/customer/support\" \n        className=\"floating-chat-fab d-md-none\" \n        aria-label=\"Chat Support\"\n      >\n        <MessageCircle size={24} color=\"#fff\" />\n      </Link>\n    )}"
content = content.replace(start_marker, "")

with open(layout_path, 'w') as f:
    f.write(content)

css_path = 'src/styles/chat-inbox.css'
with open(css_path, 'r') as f:
    css_content = f.read()

start_idx = css_content.find("/* Floating Chat Bubble (Mobile) */")
if start_idx != -1:
    css_content = css_content[:start_idx]
    with open(css_path, 'w') as f:
        f.write(css_content)

