import { Children, isValidElement, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

const optionText = (children) => {
  if (Array.isArray(children)) return children.map(optionText).join('');
  if (children === null || children === undefined) return '';
  return String(children);
};

const CustomSelect = ({
  id,
  className = '',
  value = '',
  onChange,
  children,
  disabled = false,
  'aria-label': ariaLabel,
  ...rest
}) => {
  const [open, setOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState('bottom');
  const [menuMaxHeight, setMenuMaxHeight] = useState(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const generatedId = useId();
  const listboxId = `${generatedId}-listbox`;
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  // Type-to-jump buffer. Kept in a ref, not state: it must not re-render on
  // every keystroke, and the timer that clears it would be reset by the
  // re-render it caused.
  const typeaheadRef = useRef({ query: '', timer: null });

  const options = Children.toArray(children)
    .filter(isValidElement)
    .map(child => ({
      value: child.props.value ?? '',
      label: optionText(child.props.children),
      disabled: Boolean(child.props.disabled),
    }));

  const selected = options.find(option => String(option.value) === String(value)) || options[0];
  const selectedIndex = Math.max(0, options.findIndex(option => String(option.value) === String(value)));

  const updateMenuPlacement = () => {
    if (!rootRef.current || typeof window === 'undefined') return;

    const rect = rootRef.current.getBoundingClientRect();
    const gutter = 8;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const optionHeight = 44;
    const estimatedMenuHeight = Math.min(320, viewportHeight * 0.52, (options.length * optionHeight) + 12);
    const spaceBelow = viewportHeight - rect.bottom - gutter;
    const spaceAbove = rect.top - gutter;
    const shouldOpenUp = spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow;
    const availableSpace = shouldOpenUp ? spaceAbove : spaceBelow;

    setMenuPlacement(shouldOpenUp ? 'top' : 'bottom');
    setMenuMaxHeight(Math.max(96, Math.min(320, availableSpace - gutter)));
  };

  const openMenu = () => {
    updateMenuPlacement();
    setHighlightedIndex(selectedIndex);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;

    updateMenuPlacement();

    const closeOnOutsidePointer = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    const repositionMenu = () => updateMenuPlacement();

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', repositionMenu);

    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', repositionMenu);
    };
  }, [open, options.length]);

  // Keep the keyboard cursor on screen. Without this the arrow keys move a
  // highlight the user cannot see the moment a list is longer than the menu —
  // which the barangay lists are (Quezon City has 142).
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const node = menuRef.current.children[highlightedIndex];
    node?.scrollIntoView({ block: 'nearest' });
  }, [open, highlightedIndex]);

  const emitChange = (nextValue) => {
    onChange?.({ target: { value: nextValue } });
    setOpen(false);
  };

  const moveSelection = (direction) => {
    if (!options.length) return;
    let nextIndex = highlightedIndex;

    for (let i = 0; i < options.length; i += 1) {
      nextIndex = (nextIndex + direction + options.length) % options.length;
      if (!options[nextIndex].disabled) {
        setHighlightedIndex(nextIndex);
        return;
      }
    }
  };

  const handleKeyDown = (event) => {
    if (disabled) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      open ? moveSelection(1) : openMenu();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      open ? moveSelection(-1) : openMenu();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) {
        const option = options[highlightedIndex];
        if (option && !option.disabled) emitChange(option.value);
      } else {
        openMenu();
      }
    } else if (event.key === 'Tab') {
      if (open) setOpen(false);
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Type-to-jump, the behaviour a native <select> has and this one did
      // not: typing "san" walks to the first option starting with it. Repeated
      // presses of the SAME letter cycle through the options beginning with
      // it, again matching the native control.
      event.preventDefault();
      if (!open) openMenu();

      const state = typeaheadRef.current;
      const char = event.key.toLowerCase();
      const repeatedChar = state.query.length === 1 && state.query === char;
      state.query = repeatedChar ? char : state.query + char;

      clearTimeout(state.timer);
      state.timer = setTimeout(() => { state.query = ''; }, 700);

      const startAt = repeatedChar ? highlightedIndex + 1 : 0;
      const match = options.findIndex((option, i) =>
        i >= startAt && !option.disabled && option.label.toLowerCase().startsWith(state.query));
      const wrapped = match === -1
        ? options.findIndex(option => !option.disabled && option.label.toLowerCase().startsWith(state.query))
        : match;
      if (wrapped !== -1) setHighlightedIndex(wrapped);
    }
  };

  useEffect(() => () => clearTimeout(typeaheadRef.current.timer), []);

  return (
    <div className="custom-select-root" ref={rootRef}>
      <button
        id={id}
        type="button"
        className={`custom-select-trigger ${className}`.trim()}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && options[highlightedIndex] ? `${listboxId}-option-${highlightedIndex}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
        {...rest}
      >
        <span className={`custom-select-value ${selected?.value ? '' : 'placeholder'}`.trim()}>
          {selected?.label || 'Select'}
        </span>
        <ChevronDown size={16} aria-hidden="true" className="custom-select-icon" />
      </button>

      {open && !disabled && (
        <div
          ref={menuRef}
          className={`custom-select-menu ${menuPlacement === 'top' ? 'open-up' : ''}`.trim()}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          style={menuMaxHeight ? { maxHeight: `${menuMaxHeight}px` } : undefined}
        >
          {options.map((option, index) => {
            const active = String(option.value) === String(value);

            return (
              <button
                key={`${option.value}-${option.label}`}
                type="button"
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={active}
                tabIndex={-1}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={`custom-select-option ${active ? 'active' : ''} ${highlightedIndex === index ? 'highlighted' : ''}`.trim()}
                disabled={option.disabled}
                onClick={() => emitChange(option.value)}
              >
                <span>{option.label}</span>
                {active && <Check size={15} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default CustomSelect;
