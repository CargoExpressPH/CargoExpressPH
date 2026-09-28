import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { watchCustomerKeyboardVisibility } from '../src/lib/customerKeyboardVisibility.js';

const dom = new JSDOM(`<!doctype html><html><body>
  <input id="first" type="text"><input id="second" type="email">
  <input id="check" type="checkbox"><button id="done">Done</button>
</body></html>`, { pretendToBeVisual: true });
const { window } = dom;
const viewport = new window.EventTarget();
Object.assign(viewport, { height: 800, offsetTop: 0 });
Object.defineProperty(window, 'visualViewport', { value: viewport });
Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
const stop = watchCustomerKeyboardVisibility(window);
const hidden = () => window.document.body.classList.contains('keyboard-active');

assert.equal(hidden(), false, 'navigation starts visible');
window.document.getElementById('first').focus();
assert.equal(hidden(), true, 'focusing a text field hides navigation immediately');

// iOS can report the same layout and visual viewport height with the software
// keyboard still open. A resize in that state previously showed the tab bar.
viewport.height = window.innerHeight;
viewport.dispatchEvent(new window.Event('resize'));
assert.equal(hidden(), true, 'viewport measurements cannot reveal navigation over a focused field');

window.document.getElementById('second').focus();
await new Promise(resolve => setTimeout(resolve, 380));
assert.equal(hidden(), true, 'navigation stays hidden while moving between fields');

window.document.getElementById('done').focus();
assert.equal(hidden(), true, 'navigation stays hidden while the keyboard closes');
await new Promise(resolve => setTimeout(resolve, 380));
assert.equal(hidden(), false, 'navigation returns after editable focus ends');

window.document.getElementById('check').focus();
assert.equal(hidden(), false, 'a checkbox does not hide navigation');
window.document.getElementById('first').focus();
stop();
assert.equal(hidden(), false, 'cleanup restores navigation');
viewport.dispatchEvent(new window.Event('resize'));
assert.equal(hidden(), false, 'cleanup removes the viewport listener');
dom.window.close();

const legacy = new JSDOM('<!doctype html><html><body><input type="text"></body></html>', { pretendToBeVisual: true });
const stopLegacy = watchCustomerKeyboardVisibility(legacy.window);
legacy.window.document.querySelector('input').focus();
assert.equal(legacy.window.document.body.classList.contains('keyboard-active'), true,
  'older browsers without visualViewport still hide navigation on field focus');
stopLegacy();
legacy.window.close();
console.log('Customer keyboard navigation visibility checks passed.');
