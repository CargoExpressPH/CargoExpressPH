const fs = require('fs');
const file = 'src/styles/layout-customer.css';
let code = fs.readFileSync(file, 'utf8');

const target = `.customer-chat-fab {
  display: none;
  position: fixed;
  right: 18px;
  /* Clears the floating tab bar (~89px tall incl. its own bottom padding) and
     the notch inset underneath it. */
  bottom: calc(105px + var(--customer-safe-bottom));
  z-index: var(--z-sticky);
  /* A pill, not a disc: \`width: auto\` lets the label size the control, and the
     min-height keeps it a 48px touch target even if the label is ever
     shortened. \`max-width\` is the guard against the one way this can go wrong
     — a longer label on a 320px phone would otherwise push the pill off the
     left edge; it truncates instead of overflowing. */
  width: auto;
  max-width: calc(100vw - 36px);
  min-height: 48px;
  padding: 0 20px;
  gap: 8px;
  align-items: center;
  justify-content: center;
  border-radius: 30px;
  background: linear-gradient(135deg, var(--customer-green), #22C55E);
  color: #FFFFFF;
  box-shadow: 0 16px 34px rgba(18, 138, 90, 0.28),
    inset 0 1px 0 rgba(255, 255, 255, 0.3);
  transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease;
  will-change: transform;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}

/* The pseudo-element pulse ring. It sits behind the text and icon (z-index: -1)
   and animates continuously. */
.customer-chat-fab::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: inherit;
  border: 2px solid var(--customer-green);
  opacity: 0;
  z-index: -1;
  pointer-events: none;
  animation: customer-chat-pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

.customer-chat-fab:active {
  transform: scale(0.95);
}
/* Stop the pulse while pressed, otherwise the ring separates visibly from the
   shrinking button. */
.customer-chat-fab:active::after {
  animation: none;
}

.customer-chat-fab-label {
  font-weight: 600;
  font-size: 14px;
  /* Protect the layout from a long translation wrapping to two lines */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@keyframes customer-chat-pulse {
  0% { transform: scale(0.9); opacity: 0; }
  50% { opacity: 0.4; }
  100% { transform: scale(1.15); opacity: 0; }
}`;

const replacement = `.customer-chat-fab {
  display: none;
  position: fixed;
  right: 18px;
  /* Clears the floating tab bar (~89px tall incl. its own bottom padding) and
     the notch inset underneath it. */
  bottom: calc(105px + var(--customer-safe-bottom));
  z-index: var(--z-sticky);
  width: 56px;
  height: 56px;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: linear-gradient(135deg, var(--customer-green), #22C55E);
  color: #FFFFFF;
  box-shadow: 0 16px 34px rgba(18, 138, 90, 0.28),
    inset 0 1px 0 rgba(255, 255, 255, 0.3);
  transition: opacity 0.2s ease;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  animation: customer-chat-float 3s ease-in-out infinite;
}

/* The pseudo-element pulse ring. */
.customer-chat-fab::after {
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: inherit;
  border: 2px solid var(--customer-green);
  opacity: 0;
  z-index: -1;
  pointer-events: none;
  animation: customer-chat-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

.customer-chat-fab:active {
  transform: scale(0.95) translateY(0) !important;
  animation: none;
}

.customer-chat-fab:active::after {
  animation: none;
}

@keyframes customer-chat-float {
  0% { transform: translateY(0); }
  50% { transform: translateY(-8px); }
  100% { transform: translateY(0); }
}

@keyframes customer-chat-pulse {
  0% { transform: scale(0.9); opacity: 0; }
  50% { opacity: 0.6; }
  100% { transform: scale(1.3); opacity: 0; }
}`;

if (code.includes(target)) {
  code = code.replace(target, replacement);
  fs.writeFileSync(file, code);
  console.log('CSS Replaced successfully');
} else {
  console.log('Target CSS not found. Exact match failed.');
}
