import os

layout_path = 'src/components/layout/CustomerLayout.jsx'
with open(layout_path, 'r') as f:
    content = f.read()

fab_jsx = """
    {location.pathname !== '/customer/support' && (
      <Link 
        to="/customer/support" 
        className="floating-chat-fab d-md-none" 
        aria-label="Chat Support"
      >
        <MessageCircle size={24} color="#fff" />
      </Link>
    )}
    </>
  );
"""
content = content.replace('    </>\n  );', fab_jsx)

with open(layout_path, 'w') as f:
    f.write(content)

css_path = 'src/styles/chat-inbox.css'
with open(css_path, 'a') as f:
    f.write("""
/* Floating Chat Bubble (Mobile) */
.floating-chat-fab {
  position: fixed;
  bottom: 85px; /* Above the bottom nav */
  right: 20px;
  width: 56px;
  height: 56px;
  background-color: var(--primary);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 50;
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.floating-chat-fab:active {
  transform: scale(0.92);
}
""")
