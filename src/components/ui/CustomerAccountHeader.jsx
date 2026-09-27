import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Headset } from 'lucide-react';

export default function CustomerAccountHeader({ title, description, icon: Icon }) {
  const navigate = useNavigate();

  return (
    <header className="account-settings-header">
      <div className="customer-top-actions">
        <button type="button" onClick={() => navigate(-1)} className="btn btn-ghost customer-back-action">
          <ArrowLeft size={18} aria-hidden="true" /> Back
        </button>
        <Link to="/customer/support" className="customer-inline-support-link">
          <Headset size={16} aria-hidden="true" /> Chat support
        </Link>
      </div>
      <div className="account-settings-title-row">
        <span className="account-settings-icon"><Icon size={24} aria-hidden="true" /></span>
        <div>
          <p className="account-settings-eyebrow">Account settings</p>
          <h1>{title}</h1>
        </div>
      </div>
      <p className="account-settings-description">{description}</p>
    </header>
  );
}
