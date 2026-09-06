import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * Keyboard-accessible, single-open accordion for FAQ content. Mirrors the
 * expand/collapse interaction already used by the About page's Coverage
 * region cards (aria-expanded + rotating chevron) so the two accordions on
 * this page behave identically.
 */
const FAQAccordion = ({ items }) => {
  const [openId, setOpenId] = useState(null);

  if (!items || items.length === 0) return null;

  return (
    <div className="about-faq-list">
      {items.map((item) => {
        const isOpen = openId === item.id;
        const panelId = `faq-panel-${item.id}`;
        const buttonId = `faq-question-${item.id}`;
        return (
          <div className={`about-faq-item ${isOpen ? 'open' : ''}`} key={item.id}>
            <h3 className="about-faq-question-heading">
              <button
                type="button"
                id={buttonId}
                className="about-faq-question"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpenId(isOpen ? null : item.id)}
              >
                <span className="about-faq-question-text">{item.title}</span>
                <ChevronDown size={20} className="about-faq-chevron" aria-hidden="true" />
              </button>
            </h3>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeInOut' }}
                  className="about-faq-answer-wrap"
                >
                  <p className="about-faq-answer">{item.answer}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
};

export default FAQAccordion;
