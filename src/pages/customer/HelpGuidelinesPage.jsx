import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, BookOpen, CheckCircle2, HelpCircle, MessageCircle,
  PackageCheck, Search, ShieldAlert, Truck,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import EmptyState from '../../components/ui/EmptyState';
import usePageTitle from '../../hooks/usePageTitle';

const fallbackFaqs = [
  {
    id: 'fallback-tracking',
    title: 'How do I track my shipment?',
    category: 'Tracking',
    answer: 'Open Orders, select your tracking number, and review the latest status timeline.',
  },
  {
    id: 'fallback-payment',
    title: 'When do I pay?',
    category: 'Payments',
    answer: 'Payment is recorded during pickup, delivery, or approved balance settlement depending on the order.',
  },
  {
    id: 'fallback-support',
    title: 'How do I contact support?',
    category: 'Support',
    answer: 'Use Live Support Chat from your profile or order details page for shipment-specific questions.',
  },
];

const guidelineSections = [
  {
    title: 'Before Booking',
    icon: BookOpen,
    items: [
      'Prepare sender and receiver names, mobile numbers, and full pickup or delivery addresses.',
      'Use accurate package weight and item details so pricing and handling are correct.',
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
      'Order status updates appear in your Orders page and notification center.',
      'Delivery proof photos may be attached after successful handoff.',
      'Contact support from the order page if a status looks incorrect.',
    ],
  },
];

const HelpGuidelinesPage = () => {
  usePageTitle('Help & Guidelines');
  const navigate = useNavigate();
  const [faqs, setFaqs] = useState(fallbackFaqs);
  const [search, setSearch] = useState('');
  const [loadingFaqs, setLoadingFaqs] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const loadFaqs = async () => {
      try {
        const { data, error } = await supabase
          .from('chat_faqs')
          .select('id, title, answer, category, status, is_active, priority, created_at')
          .eq('is_active', true)
          .order('created_at', { ascending: false })
          .limit(25);

        if (error) throw error;
        const published = (data || []).filter(faq => !faq.status || faq.status === 'published');
        if (isMounted && published.length > 0) setFaqs(published);
      } catch (err) {
        if (isMounted) setFaqs(fallbackFaqs);
      } finally {
        if (isMounted) setLoadingFaqs(false);
      }
    };

    loadFaqs();
    return () => { isMounted = false; };
  }, []);

  const filteredFaqs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return faqs;
    return faqs.filter(faq =>
      faq.title?.toLowerCase().includes(q) ||
      faq.answer?.toLowerCase().includes(q) ||
      faq.category?.toLowerCase().includes(q)
    );
  }, [faqs, search]);

  return (
    <div className="page-transition customer-help-guidelines-page">
      <button type="button" onClick={() => navigate(-1)} className="btn btn-ghost customer-back-action mb-16">
        <ArrowLeft size={18} /> Back
      </button>

      <div className="customer-page-heading mb-20">
        <div>
          <h1 className="fw-800 flex items-center gap-8">
            <HelpCircle size={24} aria-hidden="true" /> Help & Guidelines
          </h1>
          <p className="text-sm text-secondary mt-4">
            Shipping rules, handling reminders, and answers maintained by the CargoExpress PH team.
          </p>
        </div>
      </div>

      <div className="grid grid-2 gap-12 mb-16">
        <button type="button" className="btn btn-primary justify-center" onClick={() => navigate('/customer/book')}>
          <PackageCheck size={16} /> Book a Shipment
        </button>
        <button type="button" className="btn btn-outline justify-center" onClick={() => navigate('/customer/support')}>
          <MessageCircle size={16} /> Contact Support
        </button>
      </div>

      <h3 className="profile-section-title">Shipping Guidelines</h3>
      <div className="grid grid-2 gap-12 mb-16">
        {guidelineSections.map(section => (
          <div className="card card-body" key={section.title}>
            <div className="flex items-center gap-8 mb-10">
              <div className="profile-menu-icon-wrap info">
                <section.icon size={18} />
              </div>
              <div className="fw-800">{section.title}</div>
            </div>
            <div className="flex flex-col gap-8">
              {section.items.map(item => (
                <div className="flex gap-8 text-sm text-secondary" key={item}>
                  <CheckCircle2 size={15} className="text-success" style={{ flexShrink: 0, marginTop: 2 }} />
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
        {loadingFaqs && <p className="form-helper">Loading published FAQs...</p>}
      </div>

      {filteredFaqs.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No Help Topics Found"
          description="Try a different keyword or contact support for shipment-specific help."
          actionLabel="Open Support"
          onAction={() => navigate('/customer/support')}
        />
      ) : (
        <div className="flex flex-col gap-10">
          {filteredFaqs.map(faq => (
            <div className="card card-body" key={faq.id}>
              <div className="flex justify-between gap-12 mb-8" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div className="fw-800">{faq.title}</div>
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
