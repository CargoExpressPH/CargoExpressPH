import { useState, useEffect } from 'react';
import { Package, MapPin, Bell, Truck, ArrowRight, X, CheckCircle } from 'lucide-react';
import FocusTrap from './FocusTrap';

const ONBOARDING_KEY = 'cargoexpress_onboarding_done';

const STEPS = [
  {
    icon: Package,
    title: 'Welcome to CargoExpress PH',
    description: 'Your one-stop cargo delivery service between Bohol and Manila. Let us show you around!',
    color: 'linear-gradient(135deg, var(--primary), var(--primary-light))',
  },
  {
    icon: MapPin,
    title: 'Book Shipments Easily',
    description: 'Place orders in seconds — just enter sender & receiver details, select your route, and we handle the rest.',
    color: 'linear-gradient(135deg, var(--info), var(--info-dark))',
  },
  {
    icon: Truck,
    title: 'Track in Real-Time',
    description: 'Follow your package from pickup to delivery with our live tracking timeline. No guessing!',
    color: 'linear-gradient(135deg, var(--success), var(--success-dark))',
  },
  {
    icon: Bell,
    title: 'Stay Updated',
    description: 'Get instant notifications on pickup schedules, delivery updates, and announcements.',
    color: 'linear-gradient(135deg, var(--accent), var(--accent-light))',
  },
];

/**
 * OnboardingModal — Full-screen welcome tour for first-time users.
 * Shows once per device, stored in localStorage.
 */
const OnboardingModal = () => {
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(0);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const done = localStorage.getItem(ONBOARDING_KEY);
    if (!done) {
      const timer = setTimeout(() => setShow(true), 800);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      setStep(s => s + 1);
    } else {
      handleFinish();
    }
  };

  const handleSkip = () => {
    handleFinish();
  };

  const handleFinish = () => {
    setExiting(true);
    setTimeout(() => {
      localStorage.setItem(ONBOARDING_KEY, 'true');
      setShow(false);
    }, 300);
  };

  if (!show) return null;

  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  return (
    <div
      className={`onboarding-overlay ${exiting ? 'onboarding-exit' : 'onboarding-enter'}`}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome tour"
    >
      <FocusTrap active={show && !exiting}>
      <div className={`onboarding-card ${exiting ? 'onboarding-card-exit' : 'onboarding-card-enter'}`}>
        {!isLast && (
          <button className="onboarding-skip" onClick={handleSkip} type="button">
            Skip <X size={14} />
          </button>
        )}

        <div className="onboarding-icon" style={{ background: current.color }}>
          <Icon size={36} strokeWidth={1.8} />
        </div>

        <h2 className="onboarding-title">{current.title}</h2>
        <p className="onboarding-desc">{current.description}</p>

        <div className="onboarding-dots">
          {STEPS.map((_, i) => (
            <button
              key={i}
              className={`onboarding-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
              onClick={() => setStep(i)}
              aria-label={`Go to step ${i + 1}`}
              type="button"
            />
          ))}
        </div>

        <button className="onboarding-btn" onClick={handleNext} type="button">
          {isLast ? (
            <>
              <CheckCircle size={18} /> Get Started
            </>
          ) : (
            <>
              Next <ArrowRight size={18} />
            </>
          )}
        </button>
      </div>
      </FocusTrap>
    </div>
  );
};

export default OnboardingModal;
