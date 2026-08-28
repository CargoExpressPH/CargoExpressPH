import { useState } from 'react';
import { updateCompanyInformation, updateCompanyFeaturesOrder } from '../../lib/database';
import { logCompany } from '../../lib/activityLog';
import { Plus, Trash2, Edit2, Save, Loader, Star, X, GripVertical } from 'lucide-react';
import { getFeatureIcon } from '../../lib/featureIcons';
import { useToast } from '../../hooks/useToast';
import ConfirmModal from '../../components/ui/ConfirmModal';
import useFieldErrors from '../../hooks/useFieldErrors';
import FieldError, { fieldAttrs, invalidClass } from '../../components/ui/FieldError';
import { DndContext, closestCenter, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
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
      <td className="feature-drag-handle text-center text-tertiary w-40" style={{cursor: 'grab'}} {...attributes} {...listeners}>
        <GripVertical size={16} />
      </td>
      <td data-label="Icon">
        <div className="rounded-sm flex items-center justify-center" style={{ width: 34, height: 34, background: 'var(--primary-bg)', color: 'var(--primary-text)'}}>
          <Ico size={18} />
        </div>
      </td>
      <td data-label="Title & Description">
        <div className="feature-title-desc">
          <div style={{ fontWeight: 700, marginBottom: 2 }}>{feat.title}</div>
          <div className="text-secondary" style={{ fontSize: '0.8125rem',}}>{feat.description}</div>
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
            style={{ color: 'var(--error-text)' }}
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
  const { errors, validate, clearError, clearAll } = useFieldErrors();
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);

  // Mouse and touch need different activation rules, not the same PointerSensor
  // tuned once. A `distance` threshold is right for a mouse — it only screens
  // out an accidental drag from a click that wobbled a few pixels — but on a
  // touchscreen the first 8px of an intended vertical SCROLL looks identical
  // to the first 8px of a drag, so a distance-only constraint hijacks a plain
  // scroll into a drag the moment a finger lands anywhere on the handle. A
  // short press `delay` (with a small `tolerance` for finger jitter during the
  // hold) gives a scroll started on the handle time to prove itself a scroll
  // before dnd-kit ever calls preventDefault.
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
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

  // One editor is reused for every row, so its errors must not survive being
  // pointed at a different feature.
  const handleEdit = (feat) => {
    setEditingId(feat.id);
    setFormData({ icon: feat.icon, title: feat.title, description: feat.description });
    setShowIconPicker(false);
    clearAll();
  };

  const handleAddNew = () => {
    setEditingId('new');
    setFormData({ icon: 'Star', title: '', description: '' });
    setShowIconPicker(false);
    clearAll();
  };

  const handleCancel = () => {
    setEditingId(null);
    setShowIconPicker(false);
    clearAll();
  };

  const handleSave = async () => {
    const ok = validate({
      title: !formData.title?.trim() ? 'Please enter a title for this feature.' : null,
      description: !formData.description?.trim()
        ? 'Please enter a description — it is shown under the title on the public page.'
        : null,
    });
    if (!ok) return;
    
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
      logCompany(editingId === 'new' ? 'Service Feature Added' : 'Service Feature Updated', {
        details: `${editingId === 'new' ? 'Added' : 'Updated'} the public service feature "${formData.title}".`,
      });
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
      logCompany('Service Feature Deleted', {
        details: `Deleted the public service feature "${deleteTarget.title}".`,
      });
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
              <div className="form-group mb-0">
                <label className="form-label">Icon</label>
                <div className="flex items-center gap-8">
                  <div
                    className="rounded-sm flex items-center justify-center"
                    style={{
                      width: 44, height: 44, background: 'var(--primary-bg)', border: '1.5px solid var(--border)',
                      flexShrink: 0, color: 'var(--primary-text)',
                    }}
                  >
                    <PreviewIcon size={22} />
                  </div>
                  <div className="relative" style={{ flex: 1,}}>
                    <button
                      type="button"
                      className="form-input text-left cursor-pointer flex items-center justify-between"
                      onClick={() => setShowIconPicker(p => !p)}
                    >
                      <span>{formData.icon || 'Select icon...'}</span>
                      <span className="text-tertiary" style={{ fontSize: '0.75rem',}}>▼</span>
                    </button>
                    {showIconPicker && (
                      <div className="absolute rounded-md" style={{top: 'calc(100% + 4px)', left: 0, zIndex: 200,
                        background: 'var(--surface)', border: '1px solid var(--border)',
                        boxShadow: 'var(--shadow-lg)',
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
                                className="flex items-center justify-center cursor-pointer"
                                style={{
                                  width: 34, height: 34, borderRadius: 'var(--radius-xs)', border: '1.5px solid',
                                  borderColor: formData.icon === name ? 'var(--primary)' : 'transparent',
                                  background: formData.icon === name ? 'var(--primary-bg)' : 'transparent',
                                  color: formData.icon === name ? 'var(--primary)' : 'var(--text-secondary)',
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
                        <div className="text-tertiary" style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-light)', fontSize: '0.75rem',}}>
                          Or type a custom name:{' '}
                          <input
                            className="form-input inline"
                            aria-label="Custom icon name"
                            style={{ width: 120, padding: '4px 8px', minHeight: 'auto', fontSize: '0.8125rem' }}
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
              <div className="form-group mb-0">
                <label className="form-label" htmlFor="feature-title">Title <span className="required">*</span></label>
                <input
                  id="feature-title"
                  className={`form-input ${invalidClass('title', errors)}`}
                  value={formData.title}
                  onChange={e => { setFormData({ ...formData, title: e.target.value }); clearError('title'); }}
                  placeholder="e.g. Fast & Reliable"
                  autoFocus
                  {...fieldAttrs('title', errors)}
                />
                <FieldError name="title" errors={errors} />
              </div>

              {/* Description */}
              <div className="form-group mb-0 col-full">
                <label className="form-label" htmlFor="feature-description">Description <span className="required">*</span></label>
                <textarea
                  id="feature-description"
                  className={`form-textarea ${invalidClass('description', errors)}`}
                  rows={2}
                  value={formData.description || ''}
                  onChange={e => { setFormData({ ...formData, description: e.target.value }); clearError('description'); }}
                  placeholder="Short description shown below the feature title..."
                  {...fieldAttrs('description', errors)}
                />
                <FieldError name="description" errors={errors} />
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
<th scope="col" className="w-40"></th>
    <th scope="col" className="w-80">Icon</th>
    <th scope="col">Title & Description</th>
    <th scope="col" className="text-right" style={{ width: 100,}}>Actions</th>
              </tr>
            </thead>
            <tbody>
                {features.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-center text-tertiary" style={{padding: '32px 24px',}}>
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
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        variant="danger"
      />
    </div>
  );
};

export default CompanyInfoFeaturesTab;
