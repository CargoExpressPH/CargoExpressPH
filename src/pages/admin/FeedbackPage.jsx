import { useState, useEffect } from 'react';
import { getAdminFeedback, updateFeedbackVisibility } from '../../lib/database';
import { logActivity } from '../../lib/activityLog';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../hooks/useToast';
import { MessageSquare, Search, Filter, Eye, EyeOff } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { formatPhDateTime } from '../../utils/datetime';
import { SkeletonCard } from '../../components/ui/SkeletonLoader';
import EmptyState from '../../components/ui/EmptyState';
import CustomSelect from '../../components/ui/CustomSelect';

const FeedbackPage = () => {
  usePageTitle('Feedback Management');
  const [feedback, setFeedback] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterRating, setFilterRating] = useState('all');
  const toast = useToast();
  const { userProfile } = useAuth();

  useEffect(() => {
    loadFeedback();
  }, []);

  const loadFeedback = async () => {
    try {
      setLoading(true);
      const data = await getAdminFeedback();
      setFeedback(data || []);
    } catch (err) {
      toast.error('Failed to load feedback');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleVisibility = async (id, currentHidden) => {
    try {
      await updateFeedbackVisibility(id, !currentHidden);
      // Hiding a customer's published review is a moderation decision about
      // someone else's words. It belongs in the audit trail.
      const entry = feedback.find(f => f.id === id);
      logActivity({
        module: 'Feedback',
        action: currentHidden ? 'Feedback Unhidden' : 'Feedback Hidden',
        recordType: 'feedback',
        recordId: id,
        recordRef: entry?.orders?.tracking_number || entry?.profiles?.name || null,
        details: currentHidden
          ? 'Restored this review to the public website.'
          : 'Hid this review from the public website.',
      });
      setFeedback(prev => prev.map(f => f.id === id ? { ...f, is_hidden: !currentHidden } : f));
      toast.success(currentHidden ? 'Feedback restored to public view' : 'Feedback hidden from public view');
    } catch (err) {
      toast.error('Failed to update visibility');
    }
  };

  const filteredFeedback = feedback.filter(f => {
    const searchMatch = 
      (f.profiles?.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (f.message || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (f.orders?.tracking_number || '').toLowerCase().includes(searchTerm.toLowerCase());
      
    const ratingMatch = filterRating === 'all' || f.rating.toString() === filterRating;
    
    return searchMatch && ratingMatch;
  });

  return (
    <div className="page-transition">
      <div className="flex justify-between items-center mb-24 flex-wrap" style={{ gap: 12 }}>
        <div>
          <h1 className="admin-page-title"><MessageSquare size={24} color="var(--primary)" aria-hidden="true" />Customer Feedback</h1>
          <p className="page-subtitle mt-4">Manage reviews and delivery feedback from customers</p>
        </div>
      </div>

      <div className="mb-24">
        <div className="feedback-filter-row flex gap-16 flex-wrap">
          <div className="form-group flex-1 mb-0">
            <div className="relative">
              <Search size={18} aria-hidden="true" className="absolute text-tertiary" style={{left: 16, top: '50%', transform: 'translateY(-50%)',}} />
              <input
                type="text"
                className="form-input"
                aria-label="Search feedback"
                style={{ paddingLeft: 48 }}
                placeholder="Search by customer, message, or tracking number..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
          
          <div className="form-group feedback-rating-filter mb-0" style={{ minWidth: 180 }}>
            <div className="relative">
              <Filter size={18} className="absolute text-tertiary pointer-events-none" style={{left: 16, top: '50%', transform: 'translateY(-50%)', zIndex: 2,}} />
              <CustomSelect
                className="form-select"
                style={{ paddingLeft: 48 }}
                value={filterRating}
                onChange={e => setFilterRating(e.target.value)}
              >
                <option value="all">All Ratings</option>
                <option value="5">5 Stars</option>
                <option value="4">4 Stars</option>
                <option value="3">3 Stars</option>
                <option value="2">2 Stars</option>
                <option value="1">1 Star</option>
              </CustomSelect>
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-2 gap-24">
          {Array.from({ length: 4 }, (_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : filteredFeedback.length === 0 ? (
        <EmptyState 
          icon={MessageSquare}
          title="No feedback found"
          description={searchTerm || filterRating !== 'all' ? "Try adjusting your filters" : "Customers haven't submitted any feedback yet."}
        />
      ) : (
        <div className="grid grid-2" style={{ gap: 24 }}>
          {filteredFeedback.map(fb => (
            <div key={fb.id} className="card hover-lift flex flex-col" style={{ padding: 20 }}>
              <div className="flex justify-between items-start" style={{marginBottom: 16}}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1.125rem' }}>{fb.profiles?.name || 'Unknown Customer'}</div>
                  <div className="text-tertiary" style={{fontSize: '0.875rem'}}>
                    {fb.profiles?.email} • Order {fb.orders?.tracking_number}
                  </div>
                </div>
                
                <div className="flex" style={{gap: 2}}>
                  {[1, 2, 3, 4, 5].map(star => (
                    <svg key={star} width="16" height="16" viewBox="0 0 24 24" fill={star <= fb.rating ? "var(--warning)" : "var(--border)"} stroke="none" aria-hidden="true">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                    </svg>
                  ))}
                  <span className="sr-only">{fb.rating} out of 5 stars</span>
                </div>
              </div>
              
              <div className="text-secondary" style={{
                flex: 1,
                padding: 16,
                background: 'var(--bg-secondary)',
                borderRadius: 'var(--radius-md)',
                marginBottom: 16,
                fontStyle: 'italic',
              }}>
                "{fb.message}"
              </div>
              
              <div className="flex justify-between items-center" style={{marginTop: 'auto'}}>
                <div className="text-tertiary" style={{ fontSize: '0.75rem',}}>
                  {formatPhDateTime(fb.created_at)}
                </div>
                
                <button 
                  className={`btn btn-sm ${fb.is_hidden ? 'btn-primary' : 'btn-ghost text-error'}`}
                  onClick={() => handleToggleVisibility(fb.id, fb.is_hidden)}
                >
                  {fb.is_hidden ? <><Eye size={16} /> Restore</> : <><EyeOff size={16} /> Hide</>}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default FeedbackPage;
