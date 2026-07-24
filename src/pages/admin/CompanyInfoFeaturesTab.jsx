import { useState } from 'react';
import { updateCompanyInformation, updateCompanyFeaturesOrder } from '../../lib/database';
import { logCompany } from '../../lib/activityLog';
import { Plus, Trash2, Edit2, Save, Loader, Star, X, GripVertical } from 'lucide-react';
import { getFeatureIcon } from '../../lib/featureIcons';
import { useToast } from '../../hooks/useToast';
import ConfirmModal from '../../components/ui/ConfirmModal';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Curated list of popular icons for cargo/logistics company features
const ICON_OPTIONS = [
  'ShieldCheck', 'Clock', 'Truck', 'Package', 'MapPin', 'Phone', 'Star',
  'Zap', 'Heart', 'Award', 'ThumbsUp', 'CheckCircle2', 'Globe', 'Headphones',
  'Warehouse', 'Navigation', 'BadgeCheck', 'Handshake', 'BarChart3', 'Lock',
  'Leaf', 'RefreshCw', 'Users', 'Target', 'TrendingUp', 'Box', 'Send',
];

const SortableRow = ({ feat, handleEdit, setDeleteTarget }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: feat.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    backgroundColor: isDragging ? 'var(--bg-secondary)' : 'inherit',
    position: 'relative',
    zIndex: isDragging ? 10 : 1,
  };

  const Ico = getFeatureIcon(feat.icon);

  return (
    <tr ref={setNodeRef} style={style}>
      <td className="feature-drag-handle" style={{ width: 40, textAlign: 'center', color: 'var(--text-tertiary)', cursor: 'grab' }} {...attributes} {...listeners}>
        <GripVertical size={16} />
      </td>
      <td data-label="Icon">
        <div style={{ width: 34, height: 34, borderRadius: 'var(--radius-sm)', background: 'var(--primary-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)' }}>
          <Ico size={18} />
        </div>
      </td>
      <td data-label="Title & Description">
        <div className="feature-title-desc">
          <div style={{ fontWeight: 700, marginBottom: 2 }}>{feat.title}</div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>{feat.description}</div>
        </div>
      </td>
      <td>
        <div className="flex justify-end gap-6">
          <button
            className="btn btn-ghost btn-icon btn-sm"
            aria-label="Edit feature"
            onClick={() => handleEdit(feat)}
          >
            <Edit2 size={15} />
          </button>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            aria-label="Delete feature"
            style={{ color: 'var(--error)' }}
            onClick={() => setDeleteTarget(feat)}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </td>
    </tr>
  );
};

const CompanyInfoFeaturesTab = ({ features, setFeatures }) => {
  const toast = useToast();
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState({ icon: 'Star', title: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = async (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setFeatures((items) => {
        const oldIndex = items.findIndex(item => item.id === active.id);
        const newIndex = items.findIndex(item => item.id === over.id);
        const newItems = arrayMove(items, oldIndex, newIndex);
        
        newItems.forEach((item, index) => item.display_order = index);
        
        // Persist
        updateCompanyFeaturesOrder(newItems).catch(err => console.error('Failed to update features order:', err));
        
        return newItems;
      });
    }
  };

  const handleEdit = (feat) => {
    setEditingId(feat.id);
    setFormData({ icon: feat.icon, title: feat.title, description: feat.description });
    setShowIconPicker(false);
  };

  const handleAddNew = () => {
    setEditingId('new');
    setFormData({ icon: 'Star', title: '', description: '' });
    setShowIconPicker(false);
  };

  const handleCancel = () => {
    setEditingId(null);
    setShowIconPicker(false);
  };

  const handleSave = async () => {
    if (!formData.title || !formData.description) return toast.error('Title and description are required.');
    
    try {
      setSaving(true);
      
      let newFeatures = [...features];
      if (editingId === 'new') {
        const newFeature = { id: crypto.randomUUID(), ...formData, display_order: features.length };
        newFeatures.push(newFeature);
      } else {
        newFeatures = newFeatures.map(f => f.id === editingId ? { ...f, ...formData } : f);
      }
      
      await updateCompanyInformation({ features: newFeatures });
      setFeatures(newFeatures);
      setEditingId(null);
      toast.success(editingId === 'new' ? 'Feature added!' : 'Feature updated!');
    } catch (err) {
      toast.error(err.message || 'Failed to save feature');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(true);
      const newFeatures = features.filter(f => f.id !== deleteTarget.id);
      
      await updateCompanyInformation({ features: newFeatures });
      setFeatures(newFeatures);
      setDeleteTarget(null);
      toast.success('Feature deleted');
    } catch (err) {
      toast.error(err.message || 'Failed to delete feature');
    } finally {
      setDeleting(false);
    }
  };

  const PreviewIcon = getFeatureIcon(formData.icon);

  return (
    <div className="flex flex-col gap-16">
      {/* Header card */}
      <div className="card">
        <div className="card-header">
          <h3><Star size={16} className="inline mr-8" />Why Choose Us Features</h3>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleAddNew}
            disabled={editingId !== null}
          >
            <Plus size={14} /> Add Feature
          </button>
        </div>

        {/* Edit Form */}
        {editingId && (
          <div style={{ borderBottom: '1px solid var(--border-light)', padding: '20px 24px', background: 'var(--bg-secondary)' }}>
            <div style={{ fontWeight: 700, marginBottom: 16, fontSize: '0.9375rem' }}>
              {editingId === 'new' ? 'New Feature' : 'Edit Feature'}
            </div>

            <div className="grid grid-2" style={{ gap: 16 }}>
              {/* Icon Picker */}
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Icon</label>
                <div className="flex items-center gap-8">
                  <div
                    style={{
                      width: 44, height: 44, borderRadius: 'var(--radius-sm)',
                      background: 'var(--primary-bg)', border: '1.5px solid var(--border)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0, color: 'var(--primary)',
                    }}
                  >
                    <PreviewIcon size={22} />
                  </div>
                  <div style={{ flex: 1, position: 'relative' }}>
                    <button
                      type="button"
                      className="form-input"
                      style={{ textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                      onClick={() => setShowIconPicker(p => !p)}
                    >
                      <span>{formData.icon || 'Select icon...'}</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>▼</span>
                    </button>
                    {showIconPicker && (
                      <div style={{
                        position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 200,
                        background: 'var(--surface)', border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-lg)',
                        padding: 12, width: 280,
                      }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
                          {ICON_OPTIONS.map(name => {
                            const Ico = getFeatureIcon(name);
                            if (!Ico) return null;
                            return (
                              <button
                                key={name}
                                title={name}
                                type="button"
                                onClick={() => { setFormData(p => ({ ...p, icon: name })); setShowIconPicker(false); }}
                                style={{
                                  width: 34, height: 34, borderRadius: 6, border: '1.5px solid',
                                  borderColor: formData.icon === name ? 'var(--primary)' : 'transparent',
                                  background: formData.icon === name ? 'var(--primary-bg)' : 'transparent',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  cursor: 'pointer', color: formData.icon === name ? 'var(--primary)' : 'var(--text-secondary)',
                                  transition: 'all 0.15s',
                                }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-secondary)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = formData.icon === name ? 'var(--primary-bg)' : 'transparent'; }}
                              >
                                <Ico size={16} />
                              </button>
                            );
                          })}
                        </div>
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-light)', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          Or type a custom name:{' '}
                          <input
                            className="form-input"
                            style={{ display: 'inline', width: 120, padding: '4px 8px', minHeight: 'auto', fontSize: '0.8125rem' }}
                            value={formData.icon}
                            onChange={e => setFormData(p => ({ ...p, icon: e.target.value }))}
                            placeholder="e.g. ShieldCheck"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Title */}
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Title <span className="required">*</span></label>
                <input
                  className="form-input"
                  value={formData.title}
                  onChange={e => setFormData({ ...formData, title: e.target.value })}
                  placeholder="e.g. Fast & Reliable"
                  autoFocus
                />
              </div>

              {/* Description */}
              <div className="form-group" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
                <label className="form-label">Description</label>
                <textarea
                  className="form-textarea"
                  rows={2}
                  value={formData.description || ''}
                  onChange={e => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Short description shown below the feature title..."
                />
              </div>


            </div>

            <div className="flex justify-end gap-8" style={{ marginTop: 16 }}>
              <button className="btn btn-ghost btn-sm" onClick={handleCancel}><X size={14} /> Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
                {saving ? <Loader size={14} className="animate-spin" /> : <Save size={14} />} Save Feature
              </button>
            </div>
          </div>
        )}

        {/* Feature List */}
        <div className="table-container">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <table className="data-table">
              <thead>
              <tr>
                <th style={{ width: 40 }}></th>
                <th style={{ width: 80 }}>Icon</th>
                <th>Title & Description</th>
                <th style={{ width: 100, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
                {features.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'center', padding: '32px 24px', color: 'var(--text-tertiary)' }}>
                      No features added yet. Click "Add Feature" to get started.
                    </td>
                  </tr>
                ) : (
                  <SortableContext items={features.map(f => f.id)} strategy={verticalListSortingStrategy}>
                    {features.map(f => (
                      <SortableRow key={f.id} feat={f} handleEdit={handleEdit} setDeleteTarget={setDeleteTarget} />
                    ))}
                  </SortableContext>
                )}
              </tbody>
            </table>
          </DndContext>
        </div>
      </div>

      <ConfirmModal
        isOpen={!!deleteTarget}
        title="Delete Feature"
        message={`Are you sure you want to delete "${deleteTarget?.title}"? This cannot be undone.`}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        confirmText={deleting ? 'Deleting...' : 'Delete'}
        variant="danger"
      />
    </div>
  );
};

export default CompanyInfoFeaturesTab;
