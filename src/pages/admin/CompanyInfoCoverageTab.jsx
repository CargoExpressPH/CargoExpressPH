import { useState } from 'react';
import { saveCoverageRegion, deleteCoverageRegion, saveCoverageMunicipality, deleteCoverageMunicipality, updateCoverageRegionsOrder, updateCoverageMunicipalitiesOrder } from '../../lib/database';
import { logCompany } from '../../lib/activityLog';
import { Plus, Trash2, Edit2, Save, Loader, MapPin, X, GripVertical, ChevronDown } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import ConfirmModal from '../../components/ui/ConfirmModal';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const SortableRegion = ({ region, handleEditRegion, setDeleteTarget, handleAddNewMuni, handleEditMuni, setCoverageAreas, isExpanded, onToggle }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: region.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
    backgroundColor: 'var(--surface)',
    zIndex: isDragging ? 10 : 1,
    position: 'relative'
  };

  const muniCount = region.municipalities ? region.municipalities.length : 0;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleMuniDragEnd = async (event) => {
    const { active, over } = event;
    if (active.id !== over.id) {
      setCoverageAreas((areas) => {
        const newAreas = [...areas];
        const regionIndex = newAreas.findIndex(r => r.id === region.id);
        const munis = [...newAreas[regionIndex].municipalities];
        const oldIndex = munis.findIndex(m => m.id === active.id);
        const newIndex = munis.findIndex(m => m.id === over.id);
        
        const newMunis = arrayMove(munis, oldIndex, newIndex);
        newMunis.forEach((m, index) => m.display_order = index);
        
        newAreas[regionIndex] = { ...newAreas[regionIndex], municipalities: newMunis };
        
        // Background sync
        updateCoverageMunicipalitiesOrder(newMunis).catch(err => console.error('Failed to update muni order:', err));
        
        return newAreas;
      });
    }
  };

  return (
    <div ref={setNodeRef} style={style}>
      {/* Region Header */}
      <div
        style={{
          padding: '12px 16px',
          background: 'var(--bg-secondary)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer',
          userSelect: 'none',
          borderBottom: isExpanded ? '1px solid var(--border-light)' : 'none',
          transition: 'border-bottom 0ms 250ms'
        }}
        onClick={onToggle}
      >
        <div style={{ fontWeight: 700, fontSize: '0.9375rem', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            {...attributes}
            {...listeners}
            style={{ cursor: 'grab', display: 'flex', alignItems: 'center', color: 'var(--text-tertiary)' }}
            onClick={e => e.stopPropagation()}
          >
            <GripVertical size={16} />
          </div>
          <MapPin size={16} style={{ color: 'var(--primary)' }} />
          <span>{region.name}</span>
          {muniCount > 0 && (
            <span style={{
              fontSize: '0.7rem',
              fontWeight: 500,
              color: 'var(--text-tertiary)',
              background: 'var(--bg-secondary)',
              borderRadius: '999px',
              padding: '1px 7px',
              lineHeight: '1.5'
            }}>
              {muniCount}
            </span>
          )}
        </div>
        <div className="flex gap-4" style={{ alignItems: 'center' }}>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            onClick={e => { e.stopPropagation(); handleEditRegion(region); }}
            title="Edit region"
          >
            <Edit2 size={14} />
          </button>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            style={{ color: 'var(--error)' }}
            onClick={e => { e.stopPropagation(); setDeleteTarget({ type: 'region', id: region.id, name: region.name }); }}
            title="Delete region"
          >
            <Trash2 size={14} />
          </button>
          {/* Divider */}
          <div style={{ width: 1, height: 18, background: 'var(--border-light)', margin: '0 4px' }} />
          {/* Chevron toggle */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              color: 'var(--text-secondary)',
              transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 250ms cubic-bezier(0.4, 0, 0.2, 1)'
            }}
          >
            <ChevronDown size={16} />
          </div>
        </div>
      </div>

      {/* Municipalities — collapsible with smooth animation */}
      <div
        style={{
          display: 'grid',
          gridTemplateRows: isExpanded ? '1fr' : '0fr',
          transition: 'grid-template-rows 250ms cubic-bezier(0.4, 0, 0.2, 1)'
        }}
      >
        <div style={{ overflow: 'hidden' }}>
          <div style={{ padding: 16 }}>
            <div className="flex justify-between items-center mb-12">
              <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Municipalities</div>
              <button
                className="btn btn-outline btn-sm"
                style={{ padding: '4px 10px', fontSize: '0.75rem', minHeight: 28 }}
                onClick={() => handleAddNewMuni(region.id)}
              >
                <Plus size={12} /> Add Muni
              </button>
            </div>

            {(!region.municipalities || region.municipalities.length === 0) ? (
              <div style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)' }}>No municipalities added to this region.</div>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleMuniDragEnd}>
                <SortableContext items={region.municipalities.map(m => m.id)} strategy={verticalListSortingStrategy}>
                  <div className="flex flex-col gap-8" style={{ maxHeight: 400, overflowY: 'auto', paddingRight: 4 }}>
                    {region.municipalities.map(muni => (
                      <SortableMuni key={muni.id} muni={muni} regionId={region.id} handleEditMuni={handleEditMuni} setDeleteTarget={setDeleteTarget} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const SortableMuni = ({ muni, regionId, handleEditMuni, setDeleteTarget }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: muni.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    backgroundColor: 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-sm)',
    zIndex: isDragging ? 10 : 1,
    position: 'relative'
  };

  return (
    <div ref={setNodeRef} style={style}>
      <div {...attributes} {...listeners} style={{ cursor: 'grab', display: 'flex', alignItems: 'center', color: 'var(--text-tertiary)' }}>
        <GripVertical size={14} />
      </div>
      <div style={{ flex: 1, fontSize: '0.8125rem', fontWeight: 500 }}>{muni.name}</div>
      <button className="btn-icon" style={{ padding: 4, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer' }} onClick={() => handleEditMuni(muni, regionId)}>
        <Edit2 size={12} />
      </button>
      <button className="btn-icon" style={{ padding: 4, background: 'none', border: 'none', color: 'var(--error)', cursor: 'pointer' }} onClick={() => setDeleteTarget({ type: 'muni', id: muni.id, regionId, name: muni.name })}>
        <Trash2 size={12} />
      </button>
    </div>
  );
};

const CompanyInfoCoverageTab = ({ coverageAreas, setCoverageAreas }) => {
  const toast = useToast();
  
  const [editingRegion, setEditingRegion] = useState(null);
  const [regionForm, setRegionForm] = useState({ name: '' });
  const [savingRegion, setSavingRegion] = useState(false);

  const [editingMuni, setEditingMuni] = useState(null);
  const [muniForm, setMuniForm] = useState({ region_id: '', name: '' });
  const [savingMuni, setSavingMuni] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Accordion state — tracks which region IDs are expanded. All collapsed by default.
  const [expandedRegions, setExpandedRegions] = useState(new Set());

  const toggleRegion = (regionId) => {
    setExpandedRegions(prev => {
      const next = new Set(prev);
      if (next.has(regionId)) {
        next.delete(regionId);
      } else {
        next.add(regionId);
      }
      return next;
    });
  };

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleRegionDragEnd = async (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setCoverageAreas((items) => {
        const oldIndex = items.findIndex(item => item.id === active.id);
        const newIndex = items.findIndex(item => item.id === over.id);
        const newItems = arrayMove(items, oldIndex, newIndex);
        
        // Assign new display order
        newItems.forEach((item, index) => item.display_order = index);
        
        // Persist to DB
        updateCoverageRegionsOrder(newItems).catch(err => console.error('Failed to update region order:', err));
        
        return newItems;
      });
    }
  };

  // Region Handlers
  const handleEditRegion = (region) => {
    setEditingRegion(region.id);
    setRegionForm({ name: region.name });
    setEditingMuni(null);
  };
  
  const handleAddNewRegion = () => {
    setEditingRegion('new');
    setRegionForm({ name: '' });
    setEditingMuni(null);
  };
  
  const handleSaveRegion = async () => {
    if (!regionForm.name.trim()) { toast.error('Region name is required'); return; }
    try {
      setSavingRegion(true);
      const data = { ...regionForm };
      if (editingRegion === 'new') {
        data.display_order = coverageAreas.length;
      }
      if (editingRegion !== 'new') data.id = editingRegion;

      const saved = await saveCoverageRegion(data);
      
      if (editingRegion === 'new') {
        const newItem = saved || { ...data, id: Date.now().toString(), municipalities: [] };
        setCoverageAreas(prev => [...prev, newItem]);
        logCompany('Coverage Region Added', { details: `Added region: ${data.name}` });
      } else {
        setCoverageAreas(prev => prev.map(r => r.id === editingRegion ? { ...r, ...data } : r));
        logCompany('Coverage Region Updated', { details: `Updated region: ${data.name}` });
      }
      
      setEditingRegion(null);
      toast.success('Region saved successfully');
    } catch (err) {
      toast.error('Failed to save region');
      console.error(err);
    } finally {
      setSavingRegion(false);
    }
  };

  // Municipality Handlers
  const handleEditMuni = (muni, regionId) => {
    setEditingMuni(muni.id);
    setMuniForm({ name: muni.name, region_id: regionId });
    setEditingRegion(null);
  };
  
  const handleAddNewMuni = (regionId) => {
    setEditingMuni('new');
    setMuniForm({ region_id: regionId, name: '' });
    setEditingRegion(null);
  };
  
  const handleSaveMuni = async () => {
    if (!muniForm.name.trim()) { toast.error('Municipality name is required'); return; }
    try {
      setSavingMuni(true);
      const data = { ...muniForm };
      const region = coverageAreas.find(r => r.id === data.region_id);
      
      if (editingMuni === 'new') {
        data.display_order = region.municipalities ? region.municipalities.length : 0;
      }
      if (editingMuni !== 'new') data.id = editingMuni;

      const saved = await saveCoverageMunicipality(data);
      
      if (editingMuni === 'new') {
        const newItem = saved || { ...data, id: Date.now().toString() };
        setCoverageAreas(prev => prev.map(r => {
          if (r.id === data.region_id) {
            return { ...r, municipalities: [...(r.municipalities || []), newItem] };
          }
          return r;
        }));
        logCompany('Coverage Municipality Added', { details: `Added municipality: ${data.name}` });
      } else {
        setCoverageAreas(prev => prev.map(r => {
          if (r.id === data.region_id) {
            return { ...r, municipalities: (r.municipalities || []).map(m => m.id === editingMuni ? { ...m, ...data } : m) };
          }
          return r;
        }));
        logCompany('Coverage Municipality Updated', { details: `Updated municipality: ${data.name}` });
      }
      
      setEditingMuni(null);
      toast.success('Municipality saved successfully');
    } catch (err) {
      toast.error('Failed to save municipality');
      console.error(err);
    } finally {
      setSavingMuni(false);
    }
  };

  const executeDelete = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(true);
      if (deleteTarget.type === 'region') {
        await deleteCoverageRegion(deleteTarget.id);
        setCoverageAreas(prev => prev.filter(r => r.id !== deleteTarget.id));
        logCompany('Coverage Region Deleted', { details: `Deleted region: ${deleteTarget.name}` });
      } else {
        await deleteCoverageMunicipality(deleteTarget.id);
        setCoverageAreas(prev => prev.map(region => {
          if (region.id === deleteTarget.regionId) {
            return { ...region, municipalities: region.municipalities.filter(m => m.id !== deleteTarget.id) };
          }
          return region;
        }));
        logCompany('Coverage Municipality Deleted', { details: `Deleted municipality: ${deleteTarget.name}` });
      }
      toast.success('Deleted successfully');
    } catch (err) {
      toast.error('Failed to delete');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="flex flex-col gap-16">
      <div className="card">
        <div className="card-header">
          <h3><MapPin size={16} className="inline mr-8" />Coverage Areas</h3>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleAddNewRegion}
            disabled={editingRegion !== null || editingMuni !== null}
          >
            <Plus size={14} /> Add Region
          </button>
        </div>

        {/* Region Form */}
        {editingRegion && (
          <div style={{ borderBottom: '1px solid var(--border-light)', padding: '20px 24px', background: 'var(--bg-secondary)' }}>
            <div style={{ fontWeight: 700, marginBottom: 16, fontSize: '0.9375rem' }}>
              {editingRegion === 'new' ? 'New Region' : 'Edit Region'}
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Region Name <span className="required">*</span></label>
              <input
                className="form-input"
                value={regionForm.name}
                onChange={e => setRegionForm({...regionForm, name: e.target.value})}
                placeholder="e.g. Metro Manila"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-8" style={{ marginTop: 16 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditingRegion(null)}><X size={14} /> Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={handleSaveRegion} disabled={savingRegion}>
                {savingRegion ? <Loader size={14} className="animate-spin" /> : <Save size={14} />} Save Region
              </button>
            </div>
          </div>
        )}

        {/* Municipality Form */}
        {editingMuni && (
          <div style={{ borderBottom: '1px solid var(--border-light)', padding: '20px 24px', background: 'var(--bg-secondary)' }}>
            <div style={{ fontWeight: 700, marginBottom: 16, fontSize: '0.9375rem' }}>
              {editingMuni === 'new' ? 'New Municipality' : 'Edit Municipality'}
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Municipality Name <span className="required">*</span></label>
              <input
                className="form-input"
                value={muniForm.name}
                onChange={e => setMuniForm({...muniForm, name: e.target.value})}
                placeholder="e.g. Quezon City"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-8" style={{ marginTop: 16 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditingMuni(null)}><X size={14} /> Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={handleSaveMuni} disabled={savingMuni}>
                {savingMuni ? <Loader size={14} className="animate-spin" /> : <Save size={14} />} Save Municipality
              </button>
            </div>
          </div>
        )}

        {/* Coverage List */}
        <div style={{ padding: 24 }}>
          {coverageAreas.length === 0 ? (
            <div className="text-center p-20 text-tertiary border rounded" style={{ borderColor: 'var(--border-light)' }}>
              No coverage areas defined. Click "Add Region" to get started.
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleRegionDragEnd}>
              <SortableContext items={coverageAreas.map(r => r.id)} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col gap-16">
                  {coverageAreas.map(region => (
                    <SortableRegion 
                      key={region.id} 
                      region={region} 
                      handleEditRegion={handleEditRegion}
                      setDeleteTarget={setDeleteTarget}
                      handleAddNewMuni={handleAddNewMuni}
                      handleEditMuni={handleEditMuni}
                      setCoverageAreas={setCoverageAreas}
                      isExpanded={expandedRegions.has(region.id)}
                      onToggle={() => toggleRegion(region.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={!!deleteTarget}
        title={`Delete ${deleteTarget?.type === 'region' ? 'Region' : 'Municipality'}`}
        message={deleteTarget?.type === 'region' 
          ? `Are you sure you want to delete the region "${deleteTarget?.name}" and ALL its municipalities? This cannot be undone.`
          : `Are you sure you want to delete "${deleteTarget?.name}"?`
        }
        onClose={() => setDeleteTarget(null)}
        onConfirm={executeDelete}
        confirmText={deleting ? 'Deleting...' : 'Delete'}
        variant="danger"
      />
    </div>
  );
};

export default CompanyInfoCoverageTab;
