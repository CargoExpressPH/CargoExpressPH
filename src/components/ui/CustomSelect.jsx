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
  const generatedId = useId();
  const listboxId = `${generatedId}-listbox`;
  const rootRef = useRef(null);

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
    window.addEventListener('scroll', repositionMenu, true);

    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', repositionMenu);
      window.removeEventListener('scroll', repositionMenu, true);
    };
  }, [open, options.length]);

  const emitChange = (nextValue) => {
    onChange?.({ target: { value: nextValue } });
    setOpen(false);
  };

  const moveSelection = (direction) => {
    if (!options.length) return;
    let nextIndex = selectedIndex;

    for (let i = 0; i < options.length; i += 1) {
      nextIndex = (nextIndex + direction + options.length) % options.length;
      if (!options[nextIndex].disabled) {
        emitChange(options[nextIndex].value);
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
      open ? setOpen(false) : openMenu();
    }
  };

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
          className={`custom-select-menu ${menuPlacement === 'top' ? 'open-up' : ''}`.trim()}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          style={menuMaxHeight ? { maxHeight: `${menuMaxHeight}px` } : undefined}
        >
          {options.map(option => {
            const active = String(option.value) === String(value);

            return (
              <button
                key={`${option.value}-${option.label}`}
                type="button"
                role="option"
                aria-selected={active}
                className={`custom-select-option ${active ? 'active' : ''}`.trim()}
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
