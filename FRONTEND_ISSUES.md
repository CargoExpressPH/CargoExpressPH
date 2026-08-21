# CargoExpressPH — Comprehensive Frontend Issues & Quality Architecture Audit

> **Quality Assurance, Accessibility (WCAG 2.2 AA/AAA) & Lead Frontend Architecture Review**  
> **Target Codebase:** CargoExpressPH (`React 19.1.0`, `Vite 6.3.0`, `React Router 7.14.2`, Supabase Realtime, Firebase Web Push)  
> **Scope:** Entire frontend surface area — Every page, modal, component, layout, and stylesheet across all device form factors (320px–3840px).  
> **Audit Status:** Complete & Actionable Comprehensive Registry (Issues #1 – #32)

---

## 1. Executive Severity & Domain Matrix

| Severity | Domain / Category | Issue IDs | Focus Areas |
|---|---|---|---|
| **P0 / Blocker / Critical** | **Core UI, Accessibility & Viewport Integrity** | #1 – #8 | Unnamed Mobile Navigation Tab, Missing `viewport-fit=cover`, Token Shadowing / Fragmentation, Table-to-Card Breakpoint Clash, 320px Foldable Card Squeezing, Modal Virtual Keyboard Trapping, Client vs Server Query Parity |
| **P1 / High** | **Architecture, a11y & Rendering Performance** | #9 – #18 | CustomSelect Option Semantics & Auto-scroll, Universal Transition CSS Thrashing, Subsystem Token Leaks, Unbounded Ultrawide/4K Canvas, Monolithic Service Modules, `@dnd-kit` Touch Sensor Scroll Hijacking, Toast Live Region Lifecycle, ThemeContext Memoization |
| **P2 / Medium** | **Typography, Motion & Component Ergonomics** | #19 – #26 | Sub-11px Micro-Typography, Duplicate Tab Stops in DonutChart, MiniBarChart Screen Reader Gaps, CommandPalette Mobile Keyboard Occlusion, Duplicate Auth Hero Component, Inline Styles Overriding Cascade Layers, Push Notification Effect Churn |
| **P3 / Polish** | **Micro-interactions, Touch Targets & Asset Delivery** | #27 – #32 | Cramped Coarse Touch Targets (<44px), Heavy Unsplit About SVG Assets, FocusTrap External Focus Safety, Textarea Dynamic Auto-grow Reflow, Install Banner Escape Handlers, Error Boundary Section Isolation |

---

## 🔴 P0: Critical / Blocker Issues (Must Fix Immediately)

---

### Issue #1: Unnamed Mobile Navigation Tab Link ("Book Shipment")
* **Locations:** [`src/components/layout/CustomerLayout.jsx:391-418`](file:///c:/system/CargoExpressPH/src/components/layout/CustomerLayout.jsx#L391-L418)
* **Standard / Heuristic:** [WCAG 2.1 SC 4.1.2 Name, Role, Value](https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html) (Level A), [WCAG 2.1 SC 2.4.4 Link Purpose](https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context.html) (Level A)
* **Why Issue:** In the mobile floating bottom navigation bar, the central action tab (`item.isBookTab = true`) renders only `<div className="book-tab-icon"><item.icon size={22} /></div>` without any text node or `aria-label`. Screen readers (VoiceOver, TalkBack, NVDA) announce this critical primary action as an unlabelled `"link"`.
* **World-Class Solution:**
```jsx
// src/components/layout/CustomerLayout.jsx:391-418
<NavLink
  key={item.to}
  to={item.to}
  end={item.end}
  aria-label={item.isBookTab ? 'Place order / Book shipment' : undefined}
  className={({ isActive }) =>
    `customer-bottom-tab ${isActive ? 'active' : ''} ${item.isBookTab ? 'book-tab' : ''}`
  }
>
  {item.isBookTab ? (
    <div className="book-tab-icon" aria-hidden="true">
      <item.icon size={22} />
    </div>
  ) : (
    <>
      <div className="relative inline-flex" aria-hidden="true">
        <item.icon size={20} />
      </div>
      <span>{item.label}</span>
    </>
  )}
</NavLink>
```

---

### Issue #2: Missing `viewport-fit=cover` & iOS Safe Area Breakage
* **Location:** [`index.html:5`](file:///c:/system/CargoExpressPH/index.html#L5)
* **Standard / Heuristic:** W3C CSS Values and Units Level 4 (Viewport-relative units & Safe Area Insets), Apple HIG
* **Why Issue:** `index.html` defines:
  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, interactive-widget=resizes-visual" />
  ```
  `viewport-fit=cover` is omitted. Under WebKit / Safari specifications, without `viewport-fit=cover`, `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` resolve to `0px`. Consequently, on all iPhone models with notches or Dynamic Islands (iPhone X through 16 Pro Max), the floating bottom navigation bar (`.customer-bottom-nav`), bottom sheets (`.install-banner-card`), and toast alerts render flush against the bottom physical bezel, overlapping the iOS home indicator swipe gesture bar.
* **World-Class Solution:**
```html
<!-- index.html -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover, interactive-widget=resizes-visual" />
```

---

### Issue #3: Subsystem Token Shadowing & Design Token Fragmentation
* **Locations:** [`src/styles/admin-modern-refresh.css:6-36`](file:///c:/system/CargoExpressPH/src/styles/admin-modern-refresh.css#L6-L36), [`src/styles/customer-mobile-refresh.css:58-88`](file:///c:/system/CargoExpressPH/src/styles/customer-mobile-refresh.css#L58-L88), [`src/styles/tokens.css:157-184`](file:///c:/system/CargoExpressPH/src/styles/tokens.css#L157-L184)
* **Standard / Heuristic:** Design Token Consistency & Single Source of Truth Architecture
* **Why Issue:** `.app-layout` and `.customer-layout-v2` re-declare localized `--admin-*` and `--customer-*` tokens with hardcoded hex colors (`#16A34A`, `#0B5F3D`, `#0B1220`, `#607085`) that shadow the global `:root` tokens in `tokens.css`. Over 320 raw `#hex` values bypass design tokens across 35 stylesheets.
* **World-Class Solution:** Remove localized token shadows from refresh stylesheets and unify all semantic tokens strictly inside `src/styles/tokens.css` under `:root` and `[data-theme="dark"]`.

---

### Issue #4: Table-to-Card Breakpoint Discrepancy (`900px` vs `768px`)
* **Locations:** [`src/styles/tables-mobile.css:11`](file:///c:/system/CargoExpressPH/src/styles/tables-mobile.css#L11), [`src/styles/admin-modern-refresh.css:1120`](file:///c:/system/CargoExpressPH/src/styles/admin-modern-refresh.css#L1120)
* **Standard / Heuristic:** Consistency & Predictable Responsive Layout
* **Why Issue:** `tables-mobile.css` converts `.data-table` to stacked grid cards at `@media (max-width: 900px)`, while `admin-modern-refresh.css` converts them to modern flex cards at `@media (max-width: 768px)`. On tablet portrait viewports between `768.02px` and `900px` (e.g. iPad 10th Gen 820px), the old grid card styling applies without modern refresh formatting, causing visual regression on 9 admin management pages.
* **World-Class Solution:** Unify the breakpoint across both files to `820px` (or standard `899.98px`).

---

### Issue #5: Cascade Layer Specificity Clash on Narrow Mobile (<360px)
* **Locations:** [`src/styles/mobile-density.css:287-310`](file:///c:/system/CargoExpressPH/src/styles/mobile-density.css#L287-L310) vs [`src/styles/customer-mobile-refresh.css:1428`](file:///c:/system/CargoExpressPH/src/styles/customer-mobile-refresh.css#L1428)
* **Standard / Heuristic:** WCAG 2.1 SC 1.4.10 (Reflow 320px)
* **Why Issue:** In `main.css`, `@layer density` outranks `@layer refresh`. `mobile-density.css` forces `.customer-layout-v2 .customer-home-snapshot` to 3 columns (`grid-template-columns: repeat(3, minmax(0, 1fr))`) with no exception for `<360px`. This overrides the 1-column mobile rule, forcing 3 columns on a 320px screen (Galaxy Z Fold cover screen, iPhone SE) where each pill is squeezed into ~86px width, clipping numbers and text labels.
* **World-Class Solution:** Add a `<360px` override in `mobile-density.css`:
```css
/* src/styles/mobile-density.css */
@media (max-width: 360px) {
  .customer-layout-v2 .customer-home-snapshot {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .customer-layout-v2 .customer-snapshot-pill {
    min-height: 56px;
    padding: 10px 14px;
  }
}
```

---

### Issue #6: Modal Body Hardcoded `maxHeight: '70vh'` vs Mobile Virtual Keyboards
* **Locations:** [`src/components/ui/PickupModal.jsx:251`](file:///c:/system/CargoExpressPH/src/components/ui/PickupModal.jsx#L251), [`src/components/ui/DeliveryModal.jsx:218`](file:///c:/system/CargoExpressPH/src/components/ui/DeliveryModal.jsx#L218), [`src/components/ui/AdditionalPaymentModal.jsx:215`](file:///c:/system/CargoExpressPH/src/components/ui/AdditionalPaymentModal.jsx#L215)
* **Standard / Heuristic:** Mobile Viewport Usability & W3C Dynamic Viewport Units
* **Why Issue:** Modals pass inline `style={{ maxHeight: '70vh', overflowY: 'auto' }}` on `.modal-body`. In mobile browsers with interactive viewports (`interactive-widget=resizes-visual`), `70vh` resolves against the 100vh layout viewport instead of the visible viewport. Combined with header and footer heights, the modal extends beneath the software keyboard, blocking action buttons.
* **World-Class Solution:** Remove inline styles and use CSS flex column structure with dynamic viewport units:
```css
/* src/styles/components.css */
.modal {
  display: flex;
  flex-direction: column;
  max-height: min(90dvh, calc(100dvh - 24px));
}
.modal-body {
  flex: 1 1 auto;
  min-height: 0;
  max-height: calc(100dvh - 140px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
@media (max-width: 640px) {
  .modal-body {
    max-height: calc(100dvh - 120px - env(safe-area-inset-bottom, 0px));
  }
}
```

---

### Issue #7: Customer Orders Client-Side `.filter` vs Admin Server Range
* **Locations:** [`src/pages/customer/OrdersPage.jsx:65`](file:///c:/system/CargoExpressPH/src/pages/customer/OrdersPage.jsx#L65) vs [`src/lib/database.js:260`](file:///c:/system/CargoExpressPH/src/lib/database.js#L260)
* **Standard / Heuristic:** Scalability & Architectural Parity
* **Why Issue:** The customer orders view loads all customer records into browser memory and filters them locally with JavaScript array `.filter()`. At 500+ orders, this causes UI jank and memory overhead. Admin orders use server-side `count: 'exact'` + range pagination.
* **World-Class Solution:** Align customer orders with server-side pagination and database status filtering.

---

### Issue #8: Raw `#EF4444` in Admin Layout Failing WCAG AA
* **Locations:** [`src/styles/admin-modern-refresh.css:323, 460`](file:///c:/system/CargoExpressPH/src/styles/admin-modern-refresh.css#L323)
* **Standard / Heuristic:** WCAG 2.1 SC 1.4.3 Contrast (Minimum 4.5:1 for body text)
* **Why Issue:** Uses raw `color: #EF4444;` on light `#FFFFFF` background. Contrast ratio of `#EF4444` on `#FFFFFF` is **3.76:1** (Fails AA).
* **World-Class Solution:** Replace raw `#EF4444` with `var(--error-text-strong)` (`#B91C1C` = 5.91:1) or `var(--error-text)` (`#DC2626` = 4.63:1).

---

## ⚡ P1: High-Severity Architecture, a11y & Performance Issues

---

### Issue #9: `CustomSelect` Listbox Nested Button Semantics & Missing Auto-Scroll
* **Location:** [`src/components/ui/CustomSelect.jsx:97-186`](file:///c:/system/CargoExpressPH/src/components/ui/CustomSelect.jsx#L97-L186)
* **Standard / Heuristic:** WAI-ARIA Authoring Practices Guide (APG) Listbox Pattern & WCAG 2.1 SC 2.1.1 Keyboard
* **Why Issue:**
  1. Options are rendered as `<button type="button" role="option">` inside `<div role="listbox">`. Nested buttons inside listboxes trigger redundant "button option" screen reader announcements.
  2. Navigating with <kbd>↑</kbd> and <kbd>↓</kbd> updates `highlightedIndex` in state, but the element does not auto-scroll into view (`scrollIntoView({ block: 'nearest' })`), causing sighted keyboard users to lose focus after the 7th item.
  3. Missing <kbd>Home</kbd> and <kbd>End</kbd> keybindings.
* **World-Class Solution:**
```jsx
// src/components/ui/CustomSelect.jsx
useEffect(() => {
  if (open && rootRef.current) {
    const activeEl = rootRef.current.querySelector(`#${listboxId}-option-${highlightedIndex}`);
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }
}, [open, highlightedIndex, listboxId]);

// Option rendering:
<div
  key={`${option.value}-${option.label}`}
  id={`${listboxId}-option-${index}`}
  role="option"
  aria-selected={active}
  aria-disabled={option.disabled || undefined}
  onMouseEnter={() => setHighlightedIndex(index)}
  className={`custom-select-option ${active ? 'active' : ''} ${highlightedIndex === index ? 'highlighted' : ''}`.trim()}
  onClick={() => !option.disabled && emitChange(option.value)}
>
  <span>{option.label}</span>
  {active && <Check size={15} aria-hidden="true" />}
</div>
```

---

### Issue #10: Universal Transition Selector (`.theme-transition *`) Layout Thrashing
* **Location:** [`src/styles/tokens.css:434-436`](file:///c:/system/CargoExpressPH/src/styles/tokens.css#L434-L436)
* **Standard / Heuristic:** Browser Compositing & INP (Interaction to Next Paint) Performance
* **Why Issue:**
  ```css
  .theme-transition, .theme-transition * {
    transition: background-color 0.35s ease, border-color 0.35s ease, color 0.35s ease, box-shadow 0.35s ease, fill 0.35s ease, stroke 0.35s ease !important;
  }
  ```
  The universal `*` selector forces transition calculations across all DOM nodes in the application during theme toggle. On data tables with 800+ DOM nodes, this causes main-thread frame drops and noticeable lag.
* **World-Class Solution:** Target only top-level surfaces and text containers:
```css
/* src/styles/tokens.css */
.theme-transition,
.theme-transition body,
.theme-transition .topbar,
.theme-transition .sidebar,
.theme-transition .card,
.theme-transition .data-table,
.theme-transition input,
.theme-transition select,
.theme-transition button {
  transition: background-color 0.3s ease, border-color 0.3s ease, color 0.3s ease, box-shadow 0.3s ease;
}
```

---

### Issue #11: Unbounded Ultrawide (QHD/4K) Admin Canvas Stretching
* **Location:** [`src/styles/layout-admin.css:369-413`](file:///c:/system/CargoExpressPH/src/styles/layout-admin.css#L369-L413)
* **Standard / Heuristic:** Large Display Information Architecture & Ergonomics
* **Why Issue:** In Admin Layout, `.main-content` and `.page-content` have no `max-width` boundary. On 2560px (QHD), 3440px (Ultrawide), and 3840px (4K) monitors, stat tiles stretch to 750px wide and tables exhibit 500px+ gaps between adjacent data columns, leading to visual fatigue.
* **World-Class Solution:**
```css
/* src/styles/layout-admin.css */
.page-content {
  width: 100%;
  max-width: 1720px;
  margin-inline: auto;
  padding: 28px 32px;
}
@media (min-width: 2560px) {
  .page-content {
    max-width: 1920px;
    padding: 36px 48px;
  }
}
```

---

### Issue #12: `@dnd-kit` PointerSensor Touch Scroll Hijacking on Tablets
* **Locations:** [`src/pages/admin/CompanyInfoFeaturesTab.jsx:85`](file:///c:/system/CargoExpressPH/src/pages/admin/CompanyInfoFeaturesTab.jsx#L85), [`src/pages/admin/CompanyInfoCoverageTab.jsx:30`](file:///c:/system/CargoExpressPH/src/pages/admin/CompanyInfoCoverageTab.jsx#L30)
* **Standard / Heuristic:** Touch vs Pointer Gesture Disambiguation
* **Why Issue:** On tablets (>768px touchscreens), `PointerSensor` is instantiated without activation constraints:
  ```javascript
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  ```
  Touching a drag handle or table row while scrolling immediately initiates drag-and-drop instead of allowing natural vertical page scrolling.
* **World-Class Solution:**
```javascript
const sensors = useSensors(
  useSensor(PointerSensor, {
    activationConstraint: {
      distance: 8, // 8px drag movement required before drag begins
    },
  }),
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
);
```

---

### Issue #13: Orphaned Capacity Tokens Defined in Component Stylesheet
* **Location:** [`src/styles/data.css:337-356`](file:///c:/system/CargoExpressPH/src/styles/data.css#L337-L356)
* **Standard / Heuristic:** Token Hierarchy & Separation of Concerns
* **Why Issue:** `--capacity-safe-text`, `--capacity-safe-bar`, `--capacity-critical-text`, etc. are defined inside `data.css` instead of `tokens.css`.
* **World-Class Solution:** Move all `--capacity-*` variable declarations into `src/styles/tokens.css` with light and dark mode mappings.

---

### Issue #14: Toast Container Dynamic Unmounting Breaking Live Region Announcements
* **Location:** [`src/hooks/useToast.jsx:126-135`](file:///c:/system/CargoExpressPH/src/hooks/useToast.jsx#L126-L135)
* **Standard / Heuristic:** [WCAG 2.1 SC 4.1.3 Status Messages](https://www.w3.org/WAI/WCAG21/Understanding/status-messages.html) (Level AA)
* **Why Issue:** `ToastContainer` returns `null` when `toasts.length === 0`. When the first toast is triggered, the `role="region"` / `aria-live` element is mounted simultaneously with the text. In VoiceOver and NVDA, dynamically injected live regions frequently fail to announce.
* **World-Class Solution:** Keep the toast container permanently in the DOM so that live regions remain active:
```jsx
// src/hooks/useToast.jsx
const ToastContainer = ({ toasts, onRemove }) => {
  return (
    <div
      className="toast-container"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onRemove={onRemove} />
      ))}
    </div>
  );
};
```

---

### Issue #15: `ThemeContext.jsx` Missing Value Memoization
* **Location:** [`src/contexts/ThemeContext.jsx:101-105`](file:///c:/system/CargoExpressPH/src/contexts/ThemeContext.jsx#L101-L105)
* **Standard / Heuristic:** React 19 Performance Standards & Context Optimization
* **Why Issue:** `<ThemeContext.Provider value={{ theme, toggleTheme, setThemeMode }}>` instantiates a fresh object literal on every render, causing all components consuming `useTheme()` to re-render unnecessarily.
* **World-Class Solution:**
```jsx
const contextValue = useMemo(
  () => ({ theme, toggleTheme, setThemeMode }),
  [theme, toggleTheme, setThemeMode]
);

return (
  <ThemeContext.Provider value={contextValue}>
    {children}
  </ThemeContext.Provider>
);
```

---

### Issue #16: Monolithic Service God-Module (`database.js` 2,707 lines / 105 exports)
* **Location:** [`src/lib/database.js`](file:///c:/system/CargoExpressPH/src/lib/database.js)
* **Standard / Heuristic:** Single Responsibility Principle (SRP) & Tree-Shaking
* **Why Issue:** A single file manages orders, trips, chat, company profile, announcements, analytics, and settlement logs. Modifying chat logic creates merge conflict risk in core booking or billing routines.
* **World-Class Solution:** Decompose `database.js` into domain-specific modules: `lib/db/orders.js`, `lib/db/trips.js`, `lib/db/chat.js`, `lib/db/analytics.js`, and `lib/db/settings.js`.

---

### Issue #17: CSS Cascade Layer Accumulation ("Patchwork Architecture")
* **Locations:** [`src/styles/main.css:17`](file:///c:/system/CargoExpressPH/src/styles/main.css#L17), [`src/styles/premium-refresh.css`](file:///c:/system/CargoExpressPH/src/styles/premium-refresh.css), [`src/styles/customer-mobile-refresh.css`](file:///c:/system/CargoExpressPH/src/styles/customer-mobile-refresh.css), [`src/styles/admin-modern-refresh.css`](file:///c:/system/CargoExpressPH/src/styles/admin-modern-refresh.css), [`src/styles/viewport-hardening.css`](file:///c:/system/CargoExpressPH/src/styles/viewport-hardening.css), [`src/styles/mobile-density.css`](file:///c:/system/CargoExpressPH/src/styles/mobile-density.css)
* **Standard / Heuristic:** Architectural Maintainability
* **Why Issue:** Sequential override layers (`refresh`, `hardening`, `density`) re-declare properties rather than refactoring base component stylesheets. A developer debugging a component must trace rules across up to 6 separate CSS files.
* **World-Class Solution:** Merge the refreshed and hardened rules back into their respective base files (`components.css`, `layout-admin.css`, `layout-customer.css`) and streamline layer declarations.

---

### Issue #18: `!important` Cascade Inversion in Validation Layer
* **Location:** [`src/styles/validation.css:31-67`](file:///c:/system/CargoExpressPH/src/styles/validation.css#L31-L67)
* **Standard / Heuristic:** W3C CSS Cascade Layers Specification
* **Why Issue:** In CSS Cascade Layers, `!important` declarations invert the layer hierarchy. An `!important` declaration in `@layer components` beats an `!important` declaration in `@layer refresh` or `@layer density`.
* **World-Class Solution:** Remove `!important` and rely on standard layer precedence and selector specificity.

---

## 📱 P2: Medium-Severity UX, a11y & Responsiveness Issues

---

### Issue #19: Sub-11px Micro-Typography Violations
* **Locations:**
  * [`src/styles/charts.css:228`](file:///c:/system/CargoExpressPH/src/styles/charts.css#L228): `.bar-chart-value-label { font-size: 0.6rem; }` (9.6px)
  * [`src/styles/charts.css:262`](file:///c:/system/CargoExpressPH/src/styles/charts.css#L262): `.bar-chart-tooltip-label { font-size: 0.65rem; }` (10.4px)
  * [`src/styles/components.css:440`](file:///c:/system/CargoExpressPH/src/styles/components.css#L440): `.badge-sm { font-size: 0.6875rem; }` (11px at normal weight)
  * [`src/styles/animations-utils.css:197`](file:///c:/system/CargoExpressPH/src/styles/animations-utils.css#L197): `.cmd-palette-footer kbd { font-size: 0.625rem; }` (10px)
  * [`src/styles/about-page.css:1192`](file:///c:/system/CargoExpressPH/src/styles/about-page.css#L1192): `font-size: 0.56rem;` (9px)
* **Standard / Heuristic:** Apple HIG (11pt minimum), Stripe Design Guidelines (12px floor)
* **Why Issue:** Text below 11px is illegible on mobile screens and fails quick visual scanning.
* **World-Class Solution:** Upgrade all labels and micro-text to `0.6875rem` (11px with bold weight) or `0.75rem` (12px).

---

### Issue #20: Duplicate Tab Stops in DonutChart
* **Location:** [`src/components/ui/DonutChart.jsx:120-173`](file:///c:/system/CargoExpressPH/src/components/ui/DonutChart.jsx#L120-L173)
* **Standard / Heuristic:** WCAG 2.1 SC 2.1.1 Keyboard & SC 2.4.3 Focus Order
* **Why Issue:** SVG `<circle>` arcs have `tabIndex={0}` and `role="button"`, and the legend items below also have `<button>`. Keyboard users must tab 12 times through duplicate controls for a 6-segment chart.
* **World-Class Solution:** Set SVG elements to `aria-hidden="true"` and keep keyboard navigation on the legend list items.

---

### Issue #21: MiniBarChart Lacks Accessible Data Points
* **Location:** [`src/components/ui/MiniBarChart.jsx:63-112`](file:///c:/system/CargoExpressPH/src/components/ui/MiniBarChart.jsx#L63-L112)
* **Standard / Heuristic:** WCAG 2.1 SC 1.1.1 Non-text Content
* **Why Issue:** The container has `role="img" aria-label={summary}`, but individual bars are only hoverable via mouse (`onMouseEnter`). Screen reader and keyboard users cannot inspect specific dates or values.
* **World-Class Solution:** Render a visually hidden data table `<table className="sr-only">` summarizing every data point.

---

### Issue #22: Command Palette Mobile Viewport & Keyboard Push-down
* **Locations:** [`src/styles/animations-utils.css:107-123`](file:///c:/system/CargoExpressPH/src/styles/animations-utils.css#L107-L123), [`src/components/ui/CommandPalette.jsx:108-187`](file:///c:/system/CargoExpressPH/src/components/ui/CommandPalette.jsx#L108-L187)
* **Standard / Heuristic:** Mobile Dialog Ergonomics & Virtual Keyboard Adaptability
* **Why Issue:** `.cmd-palette-overlay` has `padding-top: min(20vh, 160px)`. When the mobile virtual keyboard opens, results are pushed off-screen. Desktop kbd shortcut legends waste 42px of vertical mobile screen space.
* **World-Class Solution:**
```css
/* src/styles/animations-utils.css */
@media (max-width: 640px) {
  .cmd-palette-overlay {
    padding: 12px;
    align-items: flex-start;
    padding-top: max(12px, env(safe-area-inset-top, 12px));
  }
  .cmd-palette {
    max-height: calc(100dvh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  }
  .cmd-palette-results {
    max-height: calc(100dvh - 160px);
  }
  .cmd-palette-footer {
    display: none;
  }
}
```

---

### Issue #23: Auth Left Hero Panel Duplication
* **Locations:** [`src/pages/auth/LoginPage.jsx:187`](file:///c:/system/CargoExpressPH/src/pages/auth/LoginPage.jsx#L187) vs [`src/pages/auth/RegisterPage.jsx:416`](file:///c:/system/CargoExpressPH/src/pages/auth/RegisterPage.jsx#L416)
* **Standard / Heuristic:** DRY (Don't Repeat Yourself) Principle
* **Why Issue:** Identical 70-line left brand hero component duplicated across Login and Register pages. Design adjustments in one page risk drifting from the other.
* **World-Class Solution:** Extract the hero layout into a shared `<AuthHeroPanel />` component.

---

### Issue #24: Inline Styles Overriding Cascade Layers
* **Locations:** [`src/components/ui/InstallAppBanner.jsx:218`](file:///c:/system/CargoExpressPH/src/components/ui/InstallAppBanner.jsx#L218), [`src/components/ui/CapacityTracker.jsx:19`](file:///c:/system/CargoExpressPH/src/components/ui/CapacityTracker.jsx#L19)
* **Standard / Heuristic:** Separation of Concerns & CSP Compliance
* **Why Issue:** Inline `style={{}}` attributes outrank all `@layer` rules, cannot be easily themed in dark mode, and prevent strict Content Security Policy (CSP) enforcement.
* **World-Class Solution:** Replace inline styles with CSS custom properties or dedicated utility classes.

---

### Issue #25: `usePushNotification.js` Listener Churn
* **Location:** [`src/hooks/usePushNotification.js:251-264`](file:///c:/system/CargoExpressPH/src/hooks/usePushNotification.js#L251-L264)
* **Standard / Heuristic:** React Hook Best Practices & Subscription Management
* **Why Issue:** The `useEffect` depends directly on `[userId, onMsg]`. If a caller passes an inline arrow function, the FCM foreground listener continuously unsubscribes and re-subscribes.
* **World-Class Solution:** Wrap `onMsg` in a mutable `useRef` (matching `useRealtimeOrders.js`).

---

### Issue #26: Insufficient Search Input Placeholder Contrast
* **Location:** [`src/styles/customer-mobile-refresh.css:55`](file:///c:/system/CargoExpressPH/src/styles/customer-mobile-refresh.css#L55)
* **Standard / Heuristic:** WCAG 2.1 SC 1.4.3 Contrast (3:1 minimum for form controls/placeholders)
* **Why Issue:** `color: rgba(255, 255, 255, 0.65)` on semi-transparent backgrounds resolves to ~2.8:1 contrast, causing users to miss input fields or mistake them for disabled elements.
* **World-Class Solution:** Increase opacity or use explicit high-contrast theme tokens.

---

## 💅 P3: Low-Severity / Polish & Micro-Interactions

---

### Issue #27: Cramped Coarse Touch Targets (<44px)
* **Locations:** [`src/styles/charts.css:329-344`](file:///c:/system/CargoExpressPH/src/styles/charts.css#L329-L344) (`.pagination-btn` 34px × 34px), [`src/styles/admin-modern-refresh.css:441`](file:///c:/system/CargoExpressPH/src/styles/admin-modern-refresh.css#L441) (`.admin-notif-delete-btn` 24px × 24px)
* **Standard / Heuristic:** Apple HIG (44pt Minimum Target), WCAG 2.2 SC 2.5.8 Target Size (Minimum 24px, recommended 44px)
* **Why Issue:** Pagination buttons (34px) and notification delete actions (24px) are difficult to tap accurately on touchscreens.
* **World-Class Solution:** Add coarse pointer media queries:
```css
/* src/styles/charts.css */
@media (hover: none) and (pointer: coarse) {
  .pagination-btn {
    min-width: 44px;
    height: 44px;
  }
}
```

---

### Issue #28: Heavy Unsplit Marketing SVG Assets
* **Locations:** [`src/pages/public/AboutPage.jsx:153`](file:///c:/system/CargoExpressPH/src/pages/public/AboutPage.jsx#L153), [`src/styles/about-page.css`](file:///c:/system/CargoExpressPH/src/styles/about-page.css)
* **Standard / Heuristic:** Web Performance & Largest Contentful Paint (LCP)
* **Why Issue:** Complex 280×420 SVG map with 8 gradients and 5 filters is shipped to mobile devices where it is hidden at `@media (max-width: 640px) { display: none; }`, adding unnecessary payload on slow mobile connections.
* **World-Class Solution:** Lazy-load the SVG illustration or conditionally render it on larger viewports only.

---

### Issue #29: `FocusTrap.jsx` Missing Active Element Container Check
* **Location:** [`src/components/ui/FocusTrap.jsx:20-83`](file:///c:/system/CargoExpressPH/src/components/ui/FocusTrap.jsx#L20-L83)
* **Standard / Heuristic:** WAI-ARIA Focus Management
* **Why Issue:** If focus escapes to the browser address bar and tabs back into the page, `FocusTrap` does not re-intercept focus unless it happens to hit the first/last boundary element.
* **World-Class Solution:** Verify `trapElement.contains(document.activeElement)` and redirect focus to `firstElement` if external.

---

### Issue #30: Support Chat Textarea Height Layout Thrashing
* **Location:** [`src/pages/customer/SupportChatPage.jsx:761-774`](file:///c:/system/CargoExpressPH/src/pages/customer/SupportChatPage.jsx#L761-L774)
* **Standard / Heuristic:** Browser Layout & Reflow Optimization
* **Why Issue:** On every keystroke, the handler mutates style, reads `scrollHeight`, and writes style again synchronously, triggering unnecessary layout recalculations.
* **World-Class Solution:** Use CSS `field-sizing: content;` with JavaScript fallback inside a layout effect.

---

### Issue #31: Install App Banners Missing `Escape` Key Dismissal
* **Locations:** [`src/components/ui/InstallAppBanner.jsx:116`](file:///c:/system/CargoExpressPH/src/components/ui/InstallAppBanner.jsx#L116), [`src/components/ui/IosInstallBanner.jsx:79`](file:///c:/system/CargoExpressPH/src/components/ui/IosInstallBanner.jsx#L79)
* **Standard / Heuristic:** WCAG 2.1 SC 2.1.1 Keyboard & WAI-ARIA Dialog Pattern
* **Why Issue:** Banners declare `role="dialog"` but lack `keydown` Escape event listeners.
* **World-Class Solution:** Attach an Escape key listener to dismiss the banner.

---

### Issue #32: Granular Error Boundary Coverage
* **Location:** [`src/components/ui/ErrorBoundarySection.jsx`](file:///c:/system/CargoExpressPH/src/components/ui/ErrorBoundarySection.jsx)
* **Standard / Heuristic:** Defensive UI Rendering & Fault Isolation
* **Why Issue:** `ErrorBoundarySection` is only applied in `DashboardPage.jsx` and `OrderDetailPage.jsx`. Secondary component failures in `SalesReportsPage` or `SupportChatPage` risk crashing full pages.
* **World-Class Solution:** Wrap standalone reporting charts, pricing calculators, and chat timelines in `<ErrorBoundarySection>`.

---

## 🗺️ Actionable Production Remediation Roadmap

```
IMPLEMENTATION TIMELINE:
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ SPRINT 1: Critical a11y & Viewport Hardening (P0 Immediate Priority)                     │
│ 1. [Fix #2] Add `viewport-fit=cover` to `index.html`.                                     │
│ 2. [Fix #1] Add `aria-label="Place order / Book shipment"` to CustomerLayout bottom tab. │
│ 3. [Fix #5] Add ≤360px single-column snapshot rule in `mobile-density.css`.             │
│ 4. [Fix #6] Remove inline `70vh` from Pickup, Delivery, and Payment modals.              │
│ 5. [Fix #9] Fix CustomSelect listbox option semantics & keyboard auto-scroll.            │
│ 6. [Fix #14] Keep ToastContainer mounted in DOM for persistent live region.             │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ SPRINT 2: Design Token & Typography Consolidation (P1 Core System Elevation)             │
│ 1. [Fix #3 & #13] Remove shadow tokens in refresh stylesheets; move `--capacity-*` to root│
│ 2. [Fix #10] Refactor `.theme-transition *` universal selector to target components only.│
│ 3. [Fix #8] Replace raw `#EF4444` in admin refresh with `--error-text-strong`.           │
│ 4. [Fix #19] Enforce 11px/12px font size floors across `charts.css`, badges, and kbd.    │
│ 5. [Fix #15] Memoize `ThemeContext.jsx` provider value.                                  │
│ 6. [Fix #12] Add `activationConstraint: { distance: 8 }` to `@dnd-kit` `PointerSensor`. │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ SPRINT 3: Large Screens, Layouts & Architectural Modularization (P2 & P3 Polish)         │
│ 1. [Fix #11] Add `max-width: 1720px` to `.page-content` in `layout-admin.css`.          │
│ 2. [Fix #4] Synchronize table-to-card breakpoints to `820px` / `899.98px`.               │
│ 3. [Fix #22] Add mobile keyboard layout protection to CommandPalette.                    │
│ 4. [Fix #27] Expand coarse touch hitboxes (≥44px) on pagination and delete actions.      │
│ 5. [Fix #23] Extract `<AuthHeroPanel />` from Login and Register pages.                  │
│ 6. [Fix #16] Begin domain modularization of monolithic `database.js`.                   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```
