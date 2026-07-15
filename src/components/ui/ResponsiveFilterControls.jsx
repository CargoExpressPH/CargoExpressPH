import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

const defaultOptionLabel = (option) => {
  const suffix = option.count != null ? ` (${option.count})` : '';
  return `${option.label}${suffix}`;
};

const ResponsiveFilterControls = ({
  options,
  value,
  onChange,
  ariaLabel,
  label = 'Filter',
  className = '',
  desktopClassName = 'tabs',
  buttonClassName,
  optionLabel = defaultOptionLabel,
}) => {
  const [open, setOpen] = useState(false);
  const dropdownId = useId();
  const rootRef = useRef(null);
  const selected = options.find(option => option.value === value);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const getButtonClassName = (option, active) => {
    if (typeof buttonClassName === 'function') return buttonClassName(option, active);
    return `tab ${option.buttonClassName || ''} ${active ? 'active' : ''}`.trim();
  };

  const selectOption = (nextValue) => {
    onChange(nextValue);
    setOpen(false);
  };

  const moveSelection = (direction) => {
    if (options.length === 0) return;
    const currentIndex = Math.max(0, options.findIndex(option => option.value === value));
    const nextIndex = (currentIndex + direction + options.length) % options.length;
    selectOption(options[nextIndex].value);
  };

  const handleTriggerKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      open ? moveSelection(1) : setOpen(true);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      open ? moveSelection(-1) : setOpen(true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(prev => !prev);
    }
  };

  return (
    <div className={`responsive-filter ${className}`.trim()} ref={rootRef}>
      <div className={`${desktopClassName} responsive-filter-tabs`.trim()} role="tablist" aria-label={ariaLabel}>
        {options.map(option => {
          const active = value === option.value;
          const Icon = option.icon;

          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={active}
              className={getButtonClassName(option, active)}
              onClick={() => onChange(option.value)}
              style={option.style}
            >
              {Icon && <Icon size={option.iconSize || 14} aria-hidden="true" />}
              <span>{option.label}</span>
              {option.count != null && <span className="tab-count">{option.count}</span>}
            </button>
          );
        })}
      </div>

      <div className="responsive-filter-select-wrap">
        <span className="responsive-filter-select-label">{label}</span>
        <button
          type="button"
          className="form-select responsive-filter-select responsive-filter-trigger"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={dropdownId}
          onClick={() => setOpen(prev => !prev)}
          onKeyDown={handleTriggerKeyDown}
        >
          <span className="responsive-filter-trigger-text">
            {selected ? optionLabel(selected) : 'Select'}
          </span>
          <ChevronDown size={16} aria-hidden="true" className="responsive-filter-trigger-icon" />
        </button>
        {open && (
          <div className="responsive-filter-menu" id={dropdownId} role="listbox" aria-label={ariaLabel}>
            {options.map(option => {
              const active = value === option.value;
              const Icon = option.icon;

              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`responsive-filter-option ${active ? 'active' : ''}`}
                  onClick={() => selectOption(option.value)}
                >
                  <span className="responsive-filter-option-main">
                    {Icon && <Icon size={15} aria-hidden="true" />}
                    <span>{option.label}</span>
                  </span>
                  <span className="responsive-filter-option-meta">
                    {option.count != null && <span className="tab-count">{option.count}</span>}
                    {active && <Check size={15} aria-hidden="true" />}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {selected && <span className="responsive-filter-current">{optionLabel(selected)}</span>}
      </div>
    </div>
  );
};

export default ResponsiveFilterControls;
