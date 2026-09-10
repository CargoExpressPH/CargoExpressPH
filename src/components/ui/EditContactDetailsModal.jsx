import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { User, MapPin, Loader, X, AlertTriangle } from 'lucide-react';
import FocusTrap from './FocusTrap';
import CustomSelect from './CustomSelect';
import BarangaySelect from './BarangaySelect';
import useScrollLock from '../../hooks/useScrollLock';
import { VALID_PROVINCES, PH_LOCATIONS } from '../../constants/phLocations';
import { buildFullAddress } from '../../lib/address';
import { normalizeName, toAddressCase } from '../../utils/string';
import { validatePhone } from '../../utils/phone';

/**
 * EditContactDetailsModal — the ONLY place a booking's sender/receiver
 * identity and address can be changed after it is created.
 *
 * Scope is deliberately narrow: Name, Phone, Province, City, Barangay, Street,
 * Landmark. Nothing about the cargo (weight, description), money (shipping
 * cost, payments) or trip assignment is readable or writable from here — this
 * form's state doesn't even hold those fields, so there is no path for them to
 * leak into the update it produces.
 *
 * `lot_block` and `facebook` are part of the stored address/contact but are
 * NOT exposed here (out of the field list this feature was scoped to) — their
 * existing values are carried through unchanged when the full address string
 * is rebuilt, so editing here never blanks them out.
 *
 * This component only builds the update payload and hands it to `onSave`.
 * Both pages that use it (customer + admin) pass it straight to
 * updateOrderContactDetails(), which writes the row and the activity_logs
 * audit entry together, server-side, in one transaction.
 */

const SIDES = [
  { prefix: 'sender', label: 'Sender' },
  { prefix: 'receiver', label: 'Receiver' },
];

const FIELD_KEYS = ['name', 'phone', 'province', 'city', 'barangay', 'street', 'landmark'];

const buildInitialForm = (order) => {
  const form = {};
  for (const { prefix } of SIDES) {
    for (const key of FIELD_KEYS) {
      form[`${prefix}_${key}`] = order?.[`${prefix}_${key}`] || '';
    }
  }
  return form;
};

const EditContactDetailsModal = ({ isOpen, onClose, order, onSave, saving = false }) => {
  const [form, setForm] = useState(() => buildInitialForm(order));
  const [fieldErrors, setFieldErrors] = useState({});

  useEffect(() => {
    if (isOpen) {
      setForm(buildInitialForm(order));
      setFieldErrors({});
    }
    // Only re-seed when the modal opens on a (possibly new) order — not on
    // every keystroke, and not when the parent's `order` refreshes silently
    // underneath an open modal mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, order?.id]);

  useScrollLock(isOpen);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, saving, onClose]);

  if (!isOpen || !order) return null;

  const u = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  const validate = () => {
    const errs = {};
    for (const { prefix, label } of SIDES) {
      if (!form[`${prefix}_name`]?.trim()) errs[`${prefix}_name`] = `${label} name is required.`;
      const phoneErr = validatePhone(form[`${prefix}_phone`], { label: `${label} mobile number` });
      if (phoneErr) errs[`${prefix}_phone`] = phoneErr;
      if (!form[`${prefix}_province`]) errs[`${prefix}_province`] = `${label} province is required.`;
      if (!form[`${prefix}_city`]) errs[`${prefix}_city`] = `${label} city is required.`;
      if (!form[`${prefix}_barangay`]?.trim()) errs[`${prefix}_barangay`] = `${label} barangay is required.`;
      if (!form[`${prefix}_street`]?.trim()) errs[`${prefix}_street`] = `${label} street is required.`;
      if (!form[`${prefix}_landmark`]?.trim()) errs[`${prefix}_landmark`] = `${label} landmark is required.`;
    }
    return errs;
  };

  // The full new picture for every allowed column — update_order_contact_details()
  // takes the complete set on every call (it diffs against the current row
  // itself and no-ops if nothing changed), so this never needs to send a
  // partial patch.
  const buildPayload = () => {
    const payload = {};
    let changed = false;

    for (const { prefix } of SIDES) {
      for (const key of FIELD_KEYS) {
        const column = `${prefix}_${key}`;
        const nextVal = key === 'name' ? normalizeName(form[column]) : (form[column] || '').trim();
        payload[column] = nextVal;
        if (nextVal !== (order[column] || '')) changed = true;
      }

      const addressColumn = `${prefix}_address`;
      payload[addressColumn] = buildFullAddress({
        lotBlock: order[`${prefix}_lot_block`],
        street: payload[`${prefix}_street`],
        barangay: payload[`${prefix}_barangay`],
        city: payload[`${prefix}_city`],
        province: payload[`${prefix}_province`],
        landmark: payload[`${prefix}_landmark`],
      });
      if (payload[addressColumn] !== (order[addressColumn] || '')) changed = true;
    }

    return { payload, changed };
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const { payload, changed } = buildPayload();
    if (!changed) {
      onClose();
      return;
    }

    await onSave(payload);
  };

  const renderSide = ({ prefix, label }) => {
    const cities = form[`${prefix}_province`] ? (PH_LOCATIONS[form[`${prefix}_province`]] || []) : [];
    const fe = (key) => fieldErrors[`${prefix}_${key}`];
    const errEl = (key) => fe(key)
      ? <div className="field-error-inline" role="alert"><AlertTriangle size={12} aria-hidden="true" />{fe(key)}</div>
      : null;
    const id = (key) => `edit-contact-${prefix}-${key}`;

    return (
      <div key={prefix} className="mb-20">
        <div className="text-xs text-tertiary font-bold text-uppercase flex items-center gap-6 mb-12">
          <User size={12} /> {label}
        </div>
        <div className="grid grid-2 gap-12">
          <div className="form-group col-full">
            <label className="form-label" htmlFor={id('name')}>Full Name <span className="required">*</span></label>
            <input
              id={id('name')}
              className={`form-input ${fe('name') ? 'field-invalid' : ''}`}
              value={form[`${prefix}_name`]}
              onChange={(e) => u(`${prefix}_name`, e.target.value)}
              autoCapitalize="words"
            />
            {errEl('name')}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor={id('phone')}>Mobile Number <span className="required">*</span></label>
            <input
              id={id('phone')}
              className={`form-input ${fe('phone') ? 'field-invalid' : ''}`}
              value={form[`${prefix}_phone`]}
              onChange={(e) => u(`${prefix}_phone`, e.target.value.replace(/\D/g, '').slice(0, 11))}
              inputMode="numeric"
              maxLength={11}
              placeholder="09xxxxxxxxx"
            />
            {errEl('phone')}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor={id('province')}>Province <span className="required">*</span></label>
            <CustomSelect
              id={id('province')}
              className={`form-select ${fe('province') ? 'field-invalid' : ''}`}
              value={form[`${prefix}_province`]}
              onChange={(e) => { u(`${prefix}_province`, e.target.value); u(`${prefix}_city`, ''); u(`${prefix}_barangay`, ''); }}
            >
              <option value="">Select Province</option>
              {VALID_PROVINCES.map(p => <option key={p} value={p}>{p}</option>)}
            </CustomSelect>
            {errEl('province')}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor={id('city')}>City / Municipality <span className="required">*</span></label>
            <CustomSelect
              id={id('city')}
              className={`form-select ${fe('city') ? 'field-invalid' : ''}`}
              value={form[`${prefix}_city`]}
              onChange={(e) => { u(`${prefix}_city`, e.target.value); u(`${prefix}_barangay`, ''); }}
              disabled={!form[`${prefix}_province`]}
            >
              <option value="">Select City</option>
              {cities.map(c => <option key={c} value={c}>{c}</option>)}
            </CustomSelect>
            {errEl('city')}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor={id('barangay')}>Barangay <span className="required">*</span></label>
            <BarangaySelect
              id={id('barangay')}
              className={fe('barangay') ? 'field-invalid' : ''}
              province={form[`${prefix}_province`]}
              city={form[`${prefix}_city`]}
              value={form[`${prefix}_barangay`]}
              onChange={(e) => u(`${prefix}_barangay`, e.target.value)}
            />
            {errEl('barangay')}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor={id('street')}>Street / Subdivision <span className="required">*</span></label>
            <input
              id={id('street')}
              className={`form-input ${fe('street') ? 'field-invalid' : ''}`}
              value={form[`${prefix}_street`]}
              onChange={(e) => u(`${prefix}_street`, toAddressCase(e.target.value))}
              autoCapitalize="words"
            />
            {errEl('street')}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor={id('landmark')}>Landmark <span className="required">*</span></label>
            <input
              id={id('landmark')}
              className={`form-input ${fe('landmark') ? 'field-invalid' : ''}`}
              value={form[`${prefix}_landmark`]}
              onChange={(e) => u(`${prefix}_landmark`, toAddressCase(e.target.value))}
              placeholder="Near what building/place?"
              autoCapitalize="words"
            />
            {errEl('landmark')}
          </div>
        </div>
      </div>
    );
  };

  return createPortal(
    <FocusTrap active>
      <div
        className="modal-overlay"
        onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-contact-title"
      >
        <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
          <div className="modal-header">
            <h3 id="edit-contact-title" className="flex items-center gap-8">
              <MapPin size={20} aria-hidden="true" /> Edit Sender &amp; Receiver Details
            </h3>
            <button type="button" className="btn-icon btn-ghost" onClick={onClose} disabled={saving} aria-label="Close">
              <X size={20} />
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="modal-body modal-body-scroll">
              <p className="text-sm text-secondary mb-20">
                Update contact and address details only. Package, pricing and trip
                information cannot be changed here.
              </p>
              {SIDES.map(renderSide)}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving && <Loader size={16} className="animate-spin" />}
                Save Changes
              </button>
            </div>
          </form>
        </div>
      </div>
    </FocusTrap>,
    document.body
  );
};

export default EditContactDetailsModal;
