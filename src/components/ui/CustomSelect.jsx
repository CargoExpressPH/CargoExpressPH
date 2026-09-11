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
    // The search box, when present, is the menu's first DOM child, ahead of
    // the options — shift the lookup past it so the index still lands on the
    // highlighted option and not the search box itself.
    const domIndex = highlightedIndex + (searchable ? 1 : 0);
    const node = menuRef.current.children[domIndex];
    node?.scrollIntoView({ block: 'nearest' });
  }, [open, highlightedIndex, searchable]);

  // Auto-focus the search box the moment the menu opens, so the user can
  // start typing immediately instead of having to click into it first.
  useEffect(() => {
    if (open && searchable) {
      searchInputRef.current?.focus();
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
          style={menuMaxHeight ? { maxHeight: `${menuMaxHeight}px` } : undefined}
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
