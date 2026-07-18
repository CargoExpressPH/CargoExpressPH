import { useState, useEffect } from 'react';
import { getAnnouncements, createAnnouncement, deleteAnnouncement, withTimeout } from '../../lib/database';
import ConfirmModal from '../../components/ui/ConfirmModal';
import { logAnnouncement } from '../../lib/activityLog';
import EmptyState from '../../components/ui/EmptyState';
import { SkeletonCard } from '../../components/ui/SkeletonLoader';
import { Plus, Trash2, Megaphone, Loader } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import usePageTitle from '../../hooks/usePageTitle';
import InfoTooltip from '../../components/ui/InfoTooltip';
import { ANNOUNCEMENT_CATEGORIES, getAnnouncementCategoryInfo } from '../../lib/announcements';

const AnnouncementsPage = () => {
  usePageTitle('Announcements');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ title: '', content: '', category: 'auto' });
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const data = await withTimeout(getAnnouncements());
      setItems(data || []);
    } catch(e) {
      setError(e.message || 'Failed to load announcements.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    let finalTitle = form.title.trim();
    if (!finalTitle || !form.content.trim()) { toast.warning('Please fill in both title and content.'); return; }
    if (finalTitle.length > 100) { toast.warning('Title must be 100 characters or less.'); return; }
    if (form.content.trim().length > 1500) { toast.warning('Content must be 1500 characters or less.'); return; }

    // Prepend designated emoji tag if explicit category selected and not already in title
    const selectedCategory = ANNOUNCEMENT_CATEGORIES.find(c => c.value === form.category);
    if (selectedCategory && selectedCategory.emoji && !finalTitle.includes(selectedCategory.emoji)) {
      finalTitle = `${selectedCategory.emoji} ${finalTitle}`.slice(0, 100);
    }

    setSaving(true);
    try {
      await withTimeout(createAnnouncement({
        title: finalTitle,
        content: form.content.trim(),
      }));
      setForm({ title: '', content: '', category: 'auto' });
      setShowForm(false);
      logAnnouncement('Announcement Published', null, finalTitle, { details: `Published announcement: ${finalTitle}` });
      await load();
      toast.success('Announcement published!');
    } catch(e) {
      toast.error(e.message || 'Failed to create announcement.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await withTimeout(deleteAnnouncement(deleteTarget.id));
      logAnnouncement('Announcement Deleted', deleteTarget.id, deleteTarget.title, { details: `Deleted announcement: ${deleteTarget.title}` });
      setDeleteTarget(null);
      await load();
      toast.success('Announcement deleted!');
    } catch(e) {
      toast.error(e.message || 'Failed to delete announcement.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page-transition">
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title">Announcements</h1>
          <p className="admin-page-subtitle">Publish operational updates customers can see in their dashboard.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={()=>setShowForm(!showForm)}><Plus size={16}/> New</button>
      </div>

      {showForm && (
        <div className="card animate-scale-in mb-16"><div className="card-body">
          <div className="form-group mb-16">
            <label className="form-label inline-flex items-center" htmlFor="announcement-category">
              Category Tag *
              <InfoTooltip text="Choose an explicit category tag for this announcement, or select Auto-Detect for smart keyword matching." />
            </label>
            <select
              id="announcement-category"
              className="form-select"
              value={form.category}
              onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
            >
              {ANNOUNCEMENT_CATEGORIES.map(cat => (
                <option key={cat.value} value={cat.value}>
                  {cat.label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label inline-flex items-center" htmlFor="announcement-title">
              Title * (Max 100 characters)
            </label>
            <input id="announcement-title" className="form-input" value={form.title} onChange={e=>setForm(p=>({...p,title:e.target.value}))} maxLength={100} required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="announcement-content">Content * (Max 1500 characters)</label>
            <textarea id="announcement-content" className="form-textarea" value={form.content} onChange={e=>setForm(p=>({...p,content:e.target.value}))} maxLength={1500} required />
          </div>
          <div className="admin-form-actions">
            <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={saving}>{saving?<Loader size={16} className="animate-spin"/>:'Publish'}</button>
            <button type="button" className="btn btn-ghost" onClick={()=>setShowForm(false)}>Cancel</button>
          </div>
        </div></div>
      )}

      {loading ? (
        <div className="flex flex-col gap-12">
          {Array.from({ length: 3 }, (_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : error ? (
        <div className="card text-center" style={{ padding: 40, color: 'var(--error)' }}>
          <h3>Error</h3><p>{error}</p>
          <button type="button" className="btn btn-primary mt-md" onClick={load}>Retry</button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={Megaphone} title="No announcements yet" description="Create your first announcement to keep customers informed." actionLabel="Create Announcement" onAction={() => setShowForm(true)} />
      ) : (
        items.map((a, i) => {
          const cat = getAnnouncementCategoryInfo(a);
          const CatIcon = cat.icon;
          return (
            <div key={a.id} className="card stagger-item mb-12" style={{animationDelay: `${i * 60}ms`}}>
              <div className="card-body p-16">
                <div className="admin-announcement-header">
                  <div className="flex items-center gap-10 flex-wrap">
                    <span
                      className="inline-flex items-center gap-6 px-8 py-2 rounded-full fw-700 text-uppercase"
                      style={{
                        fontSize: '0.65rem',
                        letterSpacing: '0.04em',
                        background: cat.badgeBg,
                        color: cat.badgeColor,
                      }}
                    >
                      <CatIcon size={12} />
                      {cat.label}
                    </span>
                    <h3 className="admin-announcement-title fw-700">{a.title}</h3>
                  </div>
                  <button type="button" className="btn btn-ghost btn-icon admin-card-action" onClick={()=>setDeleteTarget(a)} aria-label={`Delete ${a.title}`}><Trash2 size={16}/></button>
                </div>
                <p className="text-sm text-secondary mt-6">{a.content}</p>
                <div className="text-xs text-tertiary mt-8">by {a.profiles?.name||'Admin'} • {new Date(a.created_at).toLocaleDateString()}</div>
              </div>
            </div>
          );
        })
      )}

      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Announcement"
        message="Are you sure you want to delete this announcement? This action cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Keep"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
};
export default AnnouncementsPage;
