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
  searchable = false,
  placement = 'auto',
  'aria-label': ariaLabel,
  ...rest
}) => {
  const [open, setOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState('bottom');
  const [menuMaxHeight, setMenuMaxHeight] = useState(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const generatedId = useId();
  const listboxId = `${generatedId}-listbox`;
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const searchInputRef = useRef(null);
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

  const filterOptions = (query) => {
    const normalized = query.trim().toLowerCase();
    if (!searchable || !normalized) return options;
    return options.filter(option => option.label.toLowerCase().includes(normalized));
  };

  // The list the open menu actually renders and navigates. Equal to `options`
  // whenever search is off or the box is empty, so every non-search code path
  // below stays correct without a separate branch.
  const visibleOptions = filterOptions(searchQuery);
  const firstEnabledIndex = (list) => {
    const index = list.findIndex(option => !option.disabled);
    return index === -1 ? 0 : index;
  };

  const selected = options.find(option => String(option.value) === String(value)) || options[0];
  const selectedIndex = Math.max(0, options.findIndex(option => String(option.value) === String(value)));

  const updateMenuPlacement = () => {
    if (!rootRef.current || typeof window === 'undefined') return;

    const rect = rootRef.current.getBoundingClientRect();
    const gutter = 8;
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop || 0;
    let viewportBottom = viewportTop + (viewport?.height || window.innerHeight);
    const bottomNav = rootRef.current.closest('.customer-layout-v2')?.querySelector('.customer-bottom-nav');
    if (bottomNav && getComputedStyle(bottomNav).display !== 'none' && getComputedStyle(bottomNav).opacity !== '0') {
      viewportBottom = Math.min(viewportBottom, bottomNav.getBoundingClientRect().top);
    }
    const navbar = rootRef.current.closest('.customer-layout-v2')?.querySelector('.customer-navbar');
    const unobstructedTop = Math.max(viewportTop, navbar?.getBoundingClientRect().bottom || viewportTop);
    const optionHeight = 44;
    const estimatedMenuHeight = Math.min(320, (options.length * optionHeight) + (searchable ? 58 : 12));
    const spaceBelow = Math.max(0, viewportBottom - rect.bottom - gutter);
    const spaceAbove = Math.max(0, rect.top - unobstructedTop - gutter);
    const shouldOpenUp = placement === 'top' || (placement === 'auto' && spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow);
    // Explicit bottom placement is used in admin controls whose panel must
    // keep opening below the trigger even when it reaches the viewport edge.
    const availableSpace = placement === 'bottom' ? Math.max(spaceBelow, 320) : (shouldOpenUp ? spaceAbove : spaceBelow);

    setMenuPlacement(shouldOpenUp ? 'top' : 'bottom');
    setMenuMaxHeight(Math.max(0, Math.min(320, availableSpace - gutter)));
  };

  const openMenu = () => {
    updateMenuPlacement();
    setHighlightedIndex(selectedIndex);
    setSearchQuery('');
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

    const repositionMenu = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      const viewport = window.visualViewport;
      const visibleTop = viewport?.offsetTop || 0;
      const visibleBottom = visibleTop + (viewport?.height || window.innerHeight);
      // Scrolling past an open select must not leave its floating menu over
      // unrelated fields further up or down the booking form.
      if (!rect || rect.bottom <= visibleTop || rect.top >= visibleBottom) {
        setOpen(false);
        return;
      }
      updateMenuPlacement();
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('scroll', repositionMenu, true);
    window.addEventListener('resize', repositionMenu);
    window.visualViewport?.addEventListener('resize', repositionMenu);
    window.visualViewport?.addEventListener('scroll', repositionMenu);

    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('scroll', repositionMenu, true);
      window.removeEventListener('resize', repositionMenu);
      window.visualViewport?.removeEventListener('resize', repositionMenu);
      window.visualViewport?.removeEventListener('scroll', repositionMenu);
    };
  }, [open, options.length]);

  // Scroll only the list. scrollIntoView also scrolls the page on Android,
  // moving the trigger and leaving an open menu over unrelated booking fields.
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const menu = menuRef.current;
    const domIndex = highlightedIndex + (searchable ? 1 : 0);
    const node = menu.children[domIndex];
    if (!node) return;
    const menuRect = menu.getBoundingClientRect();
    const optionRect = node.getBoundingClientRect();
    const searchHeight = searchable ? menu.firstElementChild?.getBoundingClientRect().height || 0 : 0;
    if (optionRect.top < menuRect.top + searchHeight) {
      menu.scrollTop -= menuRect.top + searchHeight - optionRect.top;
    } else if (optionRect.bottom > menuRect.bottom) {
      menu.scrollTop += optionRect.bottom - menuRect.bottom;
    }
  }, [open, highlightedIndex, searchable, searchQuery]);

  // On touch devices, focusing here opens the software keyboard and shrinks
  // the viewport before the customer has chosen to search. Keep the menu
  // anchored; the customer can tap Search if needed.
  useEffect(() => {
    if (open && searchable && !window.matchMedia('(pointer: coarse)').matches) {
      searchInputRef.current?.focus({ preventScroll: true });
    }
  }, [open, searchable]);

  const emitChange = (nextValue) => {
    onChange?.({ target: { value: nextValue } });
    setOpen(false);
  };

  const moveSelection = (direction) => {
    if (!visibleOptions.length) return;
    let nextIndex = highlightedIndex;

    for (let i = 0; i < visibleOptions.length; i += 1) {
      nextIndex = (nextIndex + direction + visibleOptions.length) % visibleOptions.length;
      if (!visibleOptions[nextIndex].disabled) {
        setHighlightedIndex(nextIndex);
        return;
      }
    }
  };

  const handleSearchChange = (event) => {
    const nextQuery = event.target.value;
    setSearchQuery(nextQuery);
    setHighlightedIndex(firstEnabledIndex(filterOptions(nextQuery)));
  };

  const handleSearchKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = visibleOptions[highlightedIndex];
      if (option && !option.disabled) emitChange(option.value);
    } else if (event.key === 'Escape') {
      setOpen(false);
    } else if (event.key === 'Tab') {
      setOpen(false);
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
        const option = visibleOptions[highlightedIndex];
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
        aria-activedescendant={open && visibleOptions[highlightedIndex] ? `${listboxId}-option-${highlightedIndex}` : undefined}
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
          style={menuMaxHeight !== null ? { maxHeight: `${menuMaxHeight}px` } : undefined}
        >
          {searchable && (
            <div className="custom-select-search">
              <input
                ref={searchInputRef}
                type="text"
                className="custom-select-search-input"
                placeholder="Search..."
                value={searchQuery}
                onChange={handleSearchChange}
                onKeyDown={handleSearchKeyDown}
                aria-label="Search options"
              />
            </div>
          )}

          {visibleOptions.length === 0 && (
            <div className="custom-select-empty">No matches found</div>
          )}

          {visibleOptions.map((option, index) => {
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
