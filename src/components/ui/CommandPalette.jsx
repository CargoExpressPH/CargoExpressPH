import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, LayoutDashboard, Package, Truck, Users, BarChart3,
  Megaphone, MessageSquare, FileText, Mail, Building, ClipboardList, User
} from 'lucide-react';
import FocusTrap from './FocusTrap';

const COMMANDS = [
  { label: 'Dashboard', to: '/admin', icon: LayoutDashboard, section: 'Navigation', keywords: 'home overview stats' },
  { label: 'Orders', to: '/admin/orders', icon: Package, section: 'Navigation', keywords: 'shipments bookings packages' },
  { label: 'Trips', to: '/admin/trips', icon: Truck, section: 'Navigation', keywords: 'routes vehicles delivery' },
  { label: 'Customers', to: '/admin/customers', icon: Users, section: 'Navigation', keywords: 'clients users accounts' },
  { label: 'Sales', to: '/admin/sales', icon: BarChart3, section: 'Management', keywords: 'revenue income payments' },
  { label: 'Reports', to: '/admin/reports', icon: FileText, section: 'Management', keywords: 'analytics data export' },
  { label: 'Announcements', to: '/admin/announcements', icon: Megaphone, section: 'Management', keywords: 'notifications broadcast' },
  { label: 'Inbox', to: '/admin/inbox', icon: MessageSquare, section: 'Management', keywords: 'messages chat support' },
  { label: 'Contact Inquiries', to: '/admin/contact-inquiries', icon: Mail, section: 'Management', keywords: 'messages inquiries contact' },
  { label: 'Customer Feedback', to: '/admin/feedback', icon: MessageSquare, section: 'Management', keywords: 'feedback testimonials reviews' },
  { label: 'Activity Logs', to: '/admin/activity-logs', icon: ClipboardList, section: 'Management', keywords: 'audit history logs' },
  { label: 'Company Information', to: '/admin/company-info', icon: Building, section: 'System', keywords: 'profile config business coverage settings' },
];

const CommandPalette = ({ isOpen, onClose }) => {
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef(null);
  const resultsRef = useRef(null);
  const navigate = useNavigate();

  const filtered = query.trim()
    ? COMMANDS.filter(cmd => {
        const q = query.toLowerCase();
        return cmd.label.toLowerCase().includes(q) || cmd.keywords.includes(q);
      })
    : COMMANDS;

  // Group by section
  const sections = {};
  filtered.forEach(cmd => {
    if (!sections[cmd.section]) sections[cmd.section] = [];
    sections[cmd.section].push(cmd);
  });

  const flatFiltered = filtered;
  const activeDescendantId = flatFiltered[highlightedIndex]
    ? `cmd-palette-option-${highlightedIndex}`
    : undefined;

  const selectCommand = useCallback((cmd) => {
    navigate(cmd.to);
    onClose();
  }, [navigate, onClose]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setHighlightedIndex(0);
      // Focus input after animation
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!resultsRef.current) return;
    const highlighted = resultsRef.current.querySelector('.highlighted');
    if (highlighted) {
      highlighted.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex]);

  const handleKeyDown = (e) => {
    const isCommandButton = e.target.closest('.cmd-palette-item');

    if (!flatFiltered.length && ['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) {
      e.preventDefault();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(prev => Math.min(prev + 1, flatFiltered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && flatFiltered[highlightedIndex]) {
      if (isCommandButton) return;
      e.preventDefault();
      selectCommand(flatFiltered[highlightedIndex]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!isOpen) return null;

  let itemIndex = -1;

  return (
    <FocusTrap active>
    <div className="cmd-palette-overlay" onClick={onClose}>
      <div
        className="cmd-palette"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cmd-palette-title"
      >
        <h2 id="cmd-palette-title" className="sr-only">Admin command palette</h2>
        {/* Search Input */}
        <div className="cmd-palette-input-wrap">
          <Search size={18} />
          <input
            ref={inputRef}
            className="cmd-palette-input"
            placeholder="Search pages, actions..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="cmd-palette-results"
            aria-activedescendant={activeDescendantId}
            aria-label="Search admin pages and actions"
            spellCheck={false}
          />
          <kbd className="cmd-palette-kbd">ESC</kbd>
        </div>

        {/* Results */}
        <div
          className="cmd-palette-results"
          ref={resultsRef}
          id="cmd-palette-results"
          role="listbox"
          aria-label="Admin command results"
        >
          {flatFiltered.length === 0 ? (
            <div className="cmd-palette-empty">
              No results for "{query}"
            </div>
          ) : (
            Object.entries(sections).map(([section, items]) => (
              <div key={section} role="group" aria-label={section}>
                <div className="cmd-palette-section-label">{section}</div>
                {items.map(cmd => {
                  itemIndex++;
                  const idx = itemIndex;
                  return (
                    <button
                      type="button"
                      key={cmd.to}
                      id={`cmd-palette-option-${idx}`}
                      className={`cmd-palette-item${idx === highlightedIndex ? ' highlighted' : ''}`}
                      onClick={() => selectCommand(cmd)}
                      onMouseEnter={() => setHighlightedIndex(idx)}
                      onFocus={() => setHighlightedIndex(idx)}
                      role="option"
                      aria-selected={idx === highlightedIndex}
                    >
                      <cmd.icon size={18} />
                      <span className="cmd-palette-item-label">{cmd.label}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="cmd-palette-footer">
          <span><kbd>↑↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>ESC</kbd> Close</span>
        </div>
      </div>
    </div>
    </FocusTrap>
  );
};

export default CommandPalette;
