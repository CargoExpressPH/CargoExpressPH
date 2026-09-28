import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Headset } from 'lucide-react';

/**
 * Header for the account settings forms (Change Email, Change Password,
 * Personal Info). Shared by the customer and admin portals; admins have no
 * support chat, so they pass `showSupport={false}`.
 *
 * Back goes to the previous screen when there is one in this tab, and to
 * `backTo` otherwise — a page opened from a bookmark or after a refresh has
 * no in-app history, and navigate(-1) there would leave the app entirely.
 */
export default function CustomerAccountHeader({
  title,
  description,
  icon: Icon,
  backTo = '/customer/profile',
  showSupport = true,
}) {
  const navigate = useNavigate();
  const goBack = () => {
    if (window.history.state?.idx > 0) navigate(-1);
    else navigate(backTo, { replace: true });
  };

  return (
    <header className="account-settings-header">
      <div className="customer-top-actions">
        <button type="button" onClick={goBack} className="btn btn-ghost customer-back-action">
          <ArrowLeft size={18} aria-hidden="true" /> Back
        </button>
        {showSupport && (
          <Link to="/customer/support" className="customer-inline-support-link">
            <Headset size={16} aria-hidden="true" /> Chat support
          </Link>
        )}
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
