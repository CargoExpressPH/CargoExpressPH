import { Ship, Package, DollarSign, Search, Zap } from 'lucide-react';
import { BrandLogo, BrandWordmark } from '../ui/BrandLogo';

const FEATURES = [
  { icon: Package,    text: 'Door-to-door delivery' },
  { icon: Search,     text: 'Real-time tracking' },
  { icon: DollarSign, text: 'Affordable per-kilo rates' },
  { icon: Zap,        text: 'Fast and reliable service' },
];

export default function AuthHeroPanel({ ariaHidden = false }) {
  return (
    <div className="login-left-panel" aria-hidden={ariaHidden || undefined}>
      <div className="login-left-content">
        <div className="login-brand flex items-center" style={{ gap: 10 }}>
          <BrandLogo size={44} decorative />
          <h1><BrandWordmark tone="on-dark" /></h1>
        </div>

        {/* Tagline */}
        <h2 className="login-tagline">
          Fast &amp; Reliable<br />Cargo Delivery
        </h2>
        <p className="login-tagline-sub">
          Connecting Bohol and Manila with safe,<br />
          affordable sea cargo shipping.
        </p>

        {/* Route pills */}
        <div className="login-route-pills">
          <div className="login-route-pill">
            <Ship size={14} aria-hidden="true" /> Bohol → Manila
          </div>
          <div className="login-route-pill">
            <Ship size={14} aria-hidden="true" /> Manila → Bohol
          </div>
        </div>

        {/* Features */}
        <div className="login-features">
          {FEATURES.map((f, i) => (
            <div key={i} className="login-feature-item">
              <div className="login-feature-icon-wrap">
                <f.icon size={14} aria-hidden="true" />
              </div>
              {f.text}
            </div>
          ))}
        </div>
      </div>

      {/* Bottom attribution */}
      <div className="login-left-footer">
        <div>© {new Date().getFullYear()} Cargo Express PH. All rights reserved.</div>
      </div>
    </div>
  );
}
