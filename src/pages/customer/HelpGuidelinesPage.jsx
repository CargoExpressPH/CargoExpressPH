import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, BookOpen, CheckCircle2, HelpCircle, MessageCircle,
  PackageCheck, Search, ShieldAlert, Truck,
} from 'lucide-react';
import EmptyState from '../../components/ui/EmptyState';
import usePageTitle from '../../hooks/usePageTitle';
import { useAuth } from '../../contexts/AuthContext';
import { FAQ_ITEMS as fallbackFaqs } from '../../constants/faqContent';

const guidelineSections = [
  {
    title: 'Before Booking',
    icon: BookOpen,
    items: [
      'Prepare sender and receiver names, mobile numbers, and full pickup or delivery addresses.',
      'Describe your items accurately. The final price is based on the weight measured at pickup.',
      'Check the route and upcoming trip schedule before confirming a shipment.',
    ],
  },
  {
    title: 'Pickup Handoff',
    icon: Truck,
    items: [
      'Make sure the cargo is packed securely before the handler arrives.',
      'Confirm the tracking number and payment record before releasing the package.',
      'Keep fragile, liquid, or high-value items clearly declared to the team.',
    ],
  },
  {
    title: 'Restricted Items',
    icon: ShieldAlert,
    items: [
      'Do not ship illegal goods, hazardous chemicals, weapons, or undocumented regulated items.',
      'Perishable or fragile items may require special approval and packaging.',
      'CargoExpress PH may refuse cargo that cannot be safely transported.',
    ],
  },
  {
    title: 'Tracking and Delivery',
    icon: PackageCheck,
    items: [
      'Enter your tracking number on the Track Shipment page. No account is needed.',
      'Delivery proof photos may be attached after successful handoff.',
      'If a status looks incorrect, use Contact Us on the About page or sign in to use Live Support Chat.',
    ],
  },
];

const HelpGuidelinesPage = () => {
  usePageTitle('Help & Guidelines');
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user, userProfile } = useAuth();
  const isPublicPage = pathname === '/faq';
  const supportPath = user && userProfile?.role === 'customer' ? '/customer/support' : '/about#contact';
  const [search, setSearch] = useState('');

  const filteredFaqs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return fallbackFaqs;
    return fallbackFaqs.filter(faq =>
      faq.title?.toLowerCase().includes(q) ||
      faq.answer?.toLowerCase().includes(q) ||
      faq.category?.toLowerCase().includes(q)
    );
  }, [search]);

  return (
    <div className="page-transition customer-help-guidelines-page">
      {isPublicPage ? (
        <Link to="/" className="btn btn-ghost customer-back-action mb-16">
          <ArrowLeft size={18} /> Home
        </Link>
      ) : (
        <button type="button" onClick={() => navigate(-1)} className="btn btn-ghost customer-back-action mb-16">
          <ArrowLeft size={18} /> Back
        </button>
      )}

      <div className="customer-page-heading mb-20">
        <div>
          <h1 className="fw-700 flex items-center gap-8">
            <HelpCircle size={24} aria-hidden="true" /> Help & Guidelines
          </h1>
          <p className="text-sm text-secondary mt-4">
            Shipping rules, handling reminders, and answers maintained by the CargoExpress PH team.
          </p>
        </div>
      </div>

      <div className="grid grid-2 gap-12 mb-16">
        <Link className="btn btn-primary justify-center" to="/customer/book">
          <PackageCheck size={16} /> Book a Shipment
        </Link>
        <Link className="btn btn-outline justify-center" to={supportPath}>
          <MessageCircle size={16} /> Contact Support
        </Link>
      </div>

      <h3 className="profile-section-title">Shipping Guidelines</h3>
      <div className="grid grid-2 gap-12 mb-16">
        {guidelineSections.map(section => (
          <div className="card card-body" key={section.title}>
            <div className="flex items-center gap-8 mb-10">
              <div className="profile-menu-icon-wrap info">
                <section.icon size={18} />
              </div>
              <div className="fw-700">{section.title}</div>
            </div>
            <div className="flex flex-col gap-8">
              {section.items.map(item => (
                <div className="flex gap-8 text-sm text-secondary" key={item}>
                  <CheckCircle2 size={15} className="text-success shrink-0" style={{ marginTop: 2 }} />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <h3 className="profile-section-title">FAQs</h3>
      <div className="card card-body mb-12">
        <label className="form-label" htmlFor="help-search">Search Help</label>
        <div className="form-input-wrapper">
          <Search size={15} className="form-input-icon" />
          <input
            id="help-search"
            className="form-input form-input-icon-left"
            placeholder="Search tracking, payments, pickup, delivery..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {filteredFaqs.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No Help Topics Found"
          description="Try a different keyword or contact support for shipment-specific help."
          actionLabel="Open Support"
          onAction={() => navigate(supportPath)}
        />
      ) : (
        <div className="flex flex-col gap-10">
          {filteredFaqs.map(faq => (
            <div className="card card-body" key={faq.id}>
              <div className="flex justify-between gap-12 mb-8 items-start flex-wrap">
                <div className="fw-700">{faq.title}</div>
                {faq.category && <span className="badge badge-info">{faq.category}</span>}
              </div>
              <p className="text-sm text-secondary m-0">{faq.answer}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default HelpGuidelinesPage;
