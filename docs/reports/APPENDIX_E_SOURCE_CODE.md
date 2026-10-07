**APPENDIX E**

**SOURCE CODE**

The following listings are copied verbatim from the CargoExpress PH source code. Each listing shows the exact line range taken from the file named above it.

**Module 1: User Authentication and Registration**

*1.1*  
File: `AuthContext.jsx`  
Path: `src/contexts/AuthContext.jsx`  
Lines: 280–434  
Module/Feature: User Authentication and Registration  
Description: Implements customer login and registration using Supabase Auth. Login verifies the credentials and loads the user profile; registration validates Terms/Privacy consent, creates the auth account, saves the customer profile (with one retry), and maps Supabase errors to user-friendly messages.

```text
  const login = async (email, password) => {
    try {
      isAuthAction.current = true;
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      
      setLoading(true);
      const profileResult = await fetchProfile(data.user.id);
      
      if (!profileResult.success) {
        // If profile fetching fails, clear the broken session and surface the error.
        await supabase.auth.signOut();
        throw new Error(`Failed to retrieve user profile: ${profileResult.error.message || 'Unknown database error'}`);
      }

      // A successful ordinary login replaces any abandoned recovery attempt
      // on this browser. Do this only after the profile is ready so a failed
      // login cannot accidentally discard the recovery cleanup marker.
      clearPasswordRecoveryPending();
      isAuthAction.current = false;
      return { success: true, user: data.user, profile: profileResult.profile };
    } catch (error) {
      isAuthAction.current = false;
      setLoading(false);
      let msg = error.message || 'An unexpected error occurred.';
      // Map Supabase generic error to user-friendly messages
      if (msg.toLowerCase().includes('invalid login credentials') ||
          msg.toLowerCase().includes('invalid login')) {
        msg = 'Incorrect password or email.';
      } else if (msg.toLowerCase().includes('email not confirmed')) {
        msg = 'Your email is not confirmed. Please check your inbox.';
      } else if (msg.toLowerCase().includes('rate limit') ||
                 msg.toLowerCase().includes('too many')) {
        msg = 'Too many failed attempts. Please wait a few minutes and try again.';
      }
      return { success: false, error: msg };
    }
  };

  const register = async (email, password, profileData) => {
    try {
      // AuthRoute must keep this exact RegisterPage mounted while the global
      // session/profile state changes underneath it. Otherwise its local
      // success state is destroyed and the form can flash back on screen.
      setAuthTransition(AUTH_TRANSITIONS.REGISTERING);
      setLoading(true);

      const { legal_consent: legalConsent, ...profileFields } = profileData || {};
      if (
        legalConsent?.termsAccepted !== true ||
        legalConsent?.privacyAccepted !== true ||
        legalConsent?.termsVersion !== LEGAL_DOCUMENTS.terms.version ||
        legalConsent?.privacyVersion !== LEGAL_DOCUMENTS.privacy.version
      ) {
        throw new Error('You must agree to the current Terms of Service and Privacy Policy to create an account.');
      }

      // Set flag BEFORE signUp so onAuthStateChange skips the premature fetchProfile.
      isAuthAction.current = true;

      // These fields are written during the same auth transaction. The database
      // trigger validates the version against its published-document registry,
      // records both consents, AND inserts a minimal `profiles` row (id, email,
      // name, role) atomically with the auth user — see handle_new_user() /
      // on_auth_user_created. That guarantee is what the recovery path below
      // depends on: a signed-up user always has SOME profile row, so a failure
      // in the detailed upsert that follows is never "no profile exists," only
      // "the address/phone details never made it in."
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            name: profileFields.name,
            legal_terms_accepted: true,
            legal_privacy_accepted: true,
            legal_terms_version: legalConsent.termsVersion,
            legal_privacy_version: legalConsent.privacyVersion,
          },
        },
      });
      if (error) throw error;

      const normalizedAddress = normalizeProfileAddressFields(profileFields);
      const profilePayload = {
        id: data.user.id,
        email,
        name: profileFields.name,
        facebook_name: profileFields.facebook_name || null,
        phone: profileFields.phone || null,
        role: 'customer',
        address_lot_block: normalizedAddress.address_lot_block || null,
        address_street: normalizedAddress.address_street || null,
        address_barangay: normalizedAddress.address_barangay || null,
        address_city: normalizedAddress.address_city || null,
        address_province: normalizedAddress.address_province || null,
        address_landmark: normalizedAddress.address_landmark || null,
        wants_announcements: profileFields.wants_announcements === true,
      };

      // The auth user now exists — Supabase has already handed this browser a
      // live session for it, whether or not the rest of this function
      // succeeds. That means a thrown error from here on must never just
      // report failure: ProtectedRoute requires a `userProfile`, and with none
      // set this account would be signed in but permanently bounced back to
      // /login, with no profile row for a retry and "already registered"
      // blocking a second signUp(). Every path below ends in fetchProfile()
      // so the account is always left usable.
      let profileSaved = true;
      try {
        await createProfile(profilePayload);
      } catch (profileError) {
        // One retry: registration is a multi-request sequence, and the most
        // likely cause of a failure here is a transient network blip rather
        // than a real conflict — worth one more try before accepting the
        // address/phone details are lost.
        await new Promise(resolve => setTimeout(resolve, 800));
        try {
          await createProfile(profilePayload);
        } catch (retryError) {
          profileSaved = false;
        }
      }

      // Always attempt to load the profile. The trigger's baseline row means
      // this succeeds even when both createProfile attempts above failed —
      // that is what turns a failed detail-write into "the account exists and
      // is usable, please finish your profile" instead of a dead end.
      const fetchResult = await fetchProfile(data.user.id);
      isAuthAction.current = false;

      if (!fetchResult.success) {
        // Genuinely nothing usable came back (e.g. the network is down for
        // this whole request sequence) — surface the real failure rather than
        // pretending the account is ready.
        throw new Error(
          profileSaved
            ? `Account created, but we could not load your profile: ${fetchResult.error?.message || 'Unknown error'}. Please try logging in.`
            : 'Your account was created, but we could not save your address and phone number. Please log in and complete your profile from the Profile page.'
        );
      }

      clearPasswordRecoveryPending();
      return { success: true, user: data.user, profileIncomplete: !profileSaved };
    } catch (error) {
      isAuthAction.current = false;
      setAuthTransition(null);
      setLoading(false);
      let msg = error.message || 'Registration failed. Please try again.';
      if (msg.includes('already registered')) {
        msg = 'This email is already registered. Please sign in instead.';
      }
      return { success: false, error: msg };
    }
  };
```

*1.2*  
File: `supabase.js`  
Path: `src/lib/supabase.js`  
Lines: 109–139  
Module/Feature: User Authentication and Registration  
Description: Creates the single Supabase client used by the whole application. The URL and public anon key are read from environment variables (never hard-coded); the client persists and auto-refreshes the session and routes requests through a timeout/retry wrapper.

```text
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Persist session in localStorage
    persistSession: true,
    // Detect session from URL (for OAuth/magic link redirects)
    detectSessionInUrl: true,
    // Auto-refresh the token before it expires
    autoRefreshToken: true,
    // Custom lock for concurrent refresh requests over HTTP
    lock: customLock,
  },
  global: {
    fetch: (...args) => {
      const url = args[0];
      const options = args[1] || {};
      
      // Force no-store caching for PostgREST GET requests to prevent stale data
      // This fixes the issue where newly opened tabs show old data until hard refreshed.
      if (options.method === 'GET' && typeof url === 'string' && url.includes('/rest/v1/')) {
        options.cache = 'no-store';
      }
      
      return fetchWithRetry(url, options);
    }
  },
  realtime: {
    reconnectAfterMs: (tries) => Math.min(tries * 2000 + 1000, 15000),
  },
});

export default supabase;
```

**Module 2: Role-Based Access Control and Security**

*2.1*  
File: `App.jsx`  
Path: `src/App.jsx`  
Lines: 105–126  
Module/Feature: Role-Based Access Control and Security  
Description: ProtectedRoute component that guards the customer and admin areas. It redirects unauthenticated users to the login page and redirects users whose role does not match the required role (customer or admin).

```text
const ProtectedRoute = ({ children, requiredRole }) => {
  const { user, userProfile, loading } = useAuth();
  const location = useLocation();
  const hasUsableProfile = !!(user && userProfile && (!requiredRole || userProfile.role === requiredRole));
  if (loading && !hasUsableProfile) return <LoadingScreen />;
  // Carry the page the guest was actually trying to reach (pathname + its own
  // state, e.g. a preselected trip) so LoginPage can send them straight back
  // instead of dropping them at the generic role-based home. `from` is only
  // ever read there — nothing else depends on it, so a route that never hits
  // this guard keeps behaving exactly as before.
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!userProfile) return <Navigate to="/login" state={{ from: location }} replace />;

  if (requiredRole && userProfile.role !== requiredRole) {
    // If role is null/undefined (profile fetch failed), send to login
    // instead of redirecting to a role-based route that also rejects null,
    // which would create an infinite redirect loop.
    if (!userProfile.role) return <Navigate to="/login" replace />;
    return <Navigate to={userProfile.role === 'admin' ? '/admin' : '/customer'} replace />;
  }
  return children;
};
```

*2.2*  
File: `20260524190000_production_hardening.sql`  
Path: `supabase/migrations/20260524190000_production_hardening.sql`  
Lines: 9–19  
Module/Feature: Role-Based Access Control and Security  
Description: Database function is_admin() used by Row Level Security policies and RPCs to check, on the server, whether the signed-in user has the admin role.

```text
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT role = 'admin' FROM public.profiles WHERE id = auth.uid()),
    FALSE
  );
$$;
```

*2.3*  
File: `20260524190000_production_hardening.sql`  
Path: `supabase/migrations/20260524190000_production_hardening.sql`  
Lines: 36–64  
Module/Feature: Role-Based Access Control and Security  
Description: Trigger that prevents privilege escalation: a non-admin can never create or change a profile into an admin account, or alter its own id, email, or creation date.

```text
CREATE OR REPLACE FUNCTION public.guard_profile_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
      NEW.role := 'customer';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    NEW.id := OLD.id;
    NEW.email := OLD.email;
    NEW.role := OLD.role;
    NEW.created_at := OLD.created_at;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_write ON profiles;
CREATE TRIGGER profiles_guard_write
  BEFORE INSERT OR UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_write();
```

*2.4*  
File: `20260912030000_restrict_service_area_customer_insert.sql`  
Path: `supabase/migrations/20260912030000_restrict_service_area_customer_insert.sql`  
Lines: 150–164  
Module/Feature: Role-Based Access Control and Security  
Description: Row Level Security policy on the orders table. A customer may only insert a booking for their own account, in an unpaid and unweighed initial state.

```text
DROP POLICY IF EXISTS "Users can create own orders" ON public.orders;
CREATE POLICY "Users can create own orders" ON public.orders
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND status IN ('Pending', 'Assigned')
    AND actual_weight IS NULL
    AND payment_method IS NULL
    AND payment_status = 'unpaid'
    AND amount_paid = 0
    AND pickup_photos = '[]'::jsonb
    AND delivery_photos = '[]'::jsonb
    AND service_area_status IN ('standard', 'for_review')
    AND service_area_remarks IS NULL
  );
```

**Module 3: Customer Cargo Booking**

*3.1*  
File: `BookShipmentPage.jsx`  
Path: `src/pages/customer/BookShipmentPage.jsx`  
Lines: 480–550  
Module/Feature: Customer Cargo Booking  
Description: Submit handler of the customer booking wizard. It blocks double submission, validates the sender, receiver and route, builds the booking payload, flags out-of-coverage pickups for admin review, saves the booking and records an activity log entry.

```text
  const handleSubmit = async () => {
    // Synchronous re-entry guard. `loading` disables the button, but state
    // updates are async — two clicks inside the same React batch both pass the
    // disabled check and fire two createOrder() calls. createOrder is a POST:
    // a second one is a second booking, not a retry. A ref closes that window
    // because it is set before any await.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setLoading(true);
    // When validation sends the user back to a step, we focus the offending
    // field — and focusing already scrolls it into view. The catch block's
    // scroll-to-top would fight that, yanking the page away from the field the
    // user was just sent to fix, so it is skipped on that path only.
    let focusingInvalidField = false;
    try {
      if (!selectedRoute) throw new Error('Please select a route.');
      // C-2 fix: Navigate to the step containing the error before throwing
      const sErrs = validateSender(); if (Object.keys(sErrs).length) { setFieldErrors(sErrs); skipStepScrollRef.current = true; setStep(2); focusingInvalidField = true; focusFirstInvalid(); throw new Error('Please fix sender details.'); }
      const rErrs = validateReceiver(); if (Object.keys(rErrs).length) { setFieldErrors(rErrs); skipStepScrollRef.current = true; setStep(3); focusingInvalidField = true; focusFirstInvalid(); throw new Error('Please fix receiver details.'); }
      const validation = validateRouteProvinces(form.sender_province, form.receiver_province, selectedRoute);
      if (!validation.valid) throw new Error(validation.error);
      
      if (form.sender_province === 'Other Area' && selectedRoute.destination !== 'Bohol') {
        throw new Error('CargoExpress PH currently delivers to Bohol destinations only.');
      }
      

      const payload = {
        user_id: user.id,
        origin: selectedRoute.origin, destination: selectedRoute.destination, trip_id: selectedTrip ? form.trip_id : null,
        sender_first_name: normalizeName(form.sender_first_name), sender_last_name: normalizeName(form.sender_last_name), sender_phone: form.sender_phone,
        sender_facebook: normalizeName(form.sender_facebook), sender_city: form.sender_city, sender_province: form.sender_province === 'Other Area' ? form.sender_other_province : form.sender_province,
        sender_barangay: form.sender_barangay, sender_street: form.sender_street, sender_lot_block: form.sender_lot_block, sender_landmark: form.sender_landmark,
        receiver_first_name: normalizeName(form.receiver_first_name), receiver_last_name: normalizeName(form.receiver_last_name), receiver_phone: form.receiver_phone,
        receiver_facebook: normalizeName(form.receiver_facebook), receiver_city: form.receiver_city, receiver_province: form.receiver_province,
        receiver_barangay: form.receiver_barangay, receiver_street: form.receiver_street, receiver_lot_block: form.receiver_lot_block, receiver_landmark: form.receiver_landmark,
        package_description: form.package_description,
        payer_type: form.payer_type, payment_preference: form.payment_preference, notes: form.notes,
      };
      
      if (form.sender_province === 'Other Area') {
        payload.service_area_status = 'for_review';
        payload.status = 'Pending Review';
      }
      
      const data = await createOrder(payload);
      
      if (payload.service_area_status === 'for_review') {
        await logOrder('Out-of-Coverage Booking Submitted', data.id, data.tracking_number, { details: `Special pickup request submitted for ${orderPartyAddress(data, 'sender')}` });
      } else {
        await logOrder('Booking Created', data.id, data.tracking_number, { details: 'Standard booking created via Customer Portal.' });
      }
      
      setSuccess(data);
      // Not clearing `loading` here: `success` now takes over rendering via
      // the early-return below, and this page never reads `loading` again —
      // clearing it would risk a frame of the un-loading form before that
      // switch.
      clearBookingDraftStorage(user.id);
      // This booking (possibly with a just-edited sender/receiver contact) is
      // now in `orders` — refresh Recent Addresses so a subsequent "Book
      // Another" dropdown reflects it instead of the stale pre-edit version.
      refreshRecentContacts();
    } catch (err) {
      toast.error(err.message || 'An unexpected error occurred while saving the booking.');
      if (!focusingInvalidField) window.scrollTo({ top: 0, behavior: 'smooth' });
      setLoading(false);
    } finally {
      submittingRef.current = false;
    }
  };
```

*3.2*  
File: `database.js`  
Path: `src/lib/database.js`  
Lines: 224–297  
Module/Feature: Customer Cargo Booking  
Description: createOrder() inserts the booking into the Supabase orders table. It validates the pickup province against the route, checks trip availability and capacity when a trip is chosen, generates a tracking number, and sets the initial unpaid payment fields.

```text
export const createOrder = async (orderData) => {
  const trackingNumber = generateTrackingNumber();
  
  // Route-location validation guard
  if (orderData.sender_province && orderData.origin) {
    const detected = detectPickupLocation(orderData.sender_province);
    const expectedOrigin = detected === 'bohol' ? 'Bohol' : detected === 'manila' ? 'Manila' : null;
    if (expectedOrigin && expectedOrigin !== orderData.origin) {
      throw new Error(`Sender province "${orderData.sender_province}" does not match the selected route origin "${orderData.origin}".`);
    }
  }

  // A booking has no weight: the customer describes the parcel, the scale
  // prices it at pickup. Kept as 0 so the trip-capacity call below keeps its
  // shape — the rate is still resolved because it is shown to the customer.
  const weight = 0;
  let pricePerKilo = await getGlobalPricePerKilo();

  let finalStatus = 'Pending';
  let finalTripId = null;
  let finalOrigin = orderData.origin;
  let finalDestination = orderData.destination;

  if (orderData.trip_id) {
    const { data: trip, error: tripError } = await withTimeout(
      supabase
        .from('trips')
        .select('id, origin, destination')
        .eq('id', orderData.trip_id)
        .single()
    );
    if (tripError || !trip) {
      throw new Error('Selected trip is no longer available. Please choose another trip or book without selecting one.');
    }

    await attachCompanyTripDefaults(trip);
    await assertTripCapacity(trip, weight);
    finalStatus = 'Assigned';
    finalTripId = orderData.trip_id;
    finalOrigin = trip.origin;
    finalDestination = trip.destination;
  }

  // 0 until the parcel is weighed. prepare_order_insert enforces this
  // server-side too; sending it explicitly keeps the optimistic row honest.
  const shippingCost = weight * pricePerKilo;

  const { data, error } = await withTimeout(
    supabase
      .from('orders')
      .insert({
        ...orderData,
        tracking_number: trackingNumber,
        shipping_cost: shippingCost,
        amount_paid: 0,
        remaining_balance: shippingCost,
        payment_status: 'unpaid',
        payment_method: null,
        actual_weight: null,
        pickup_photos: [],
        delivery_photos: [],
        status: finalStatus,
        trip_id: finalTripId,
        origin: finalOrigin || null,
        destination: finalDestination || null,
      })
      .select()
      .single()
  );
  
  if (error) throw error;

  return data;
};
```

**Module 4: Shipment Status Workflow and Tracking**

*4.1*  
File: `status.js`  
Path: `src/constants/status.js`  
Lines: 7–36  
Module/Feature: Shipment Status Workflow and Tracking  
Description: Defines the shipment statuses and the sequential status flow from booking to delivery.

```text
export const ORDER_STATUS = {
  PENDING_REVIEW: 'Pending Review',
  PENDING: 'Pending',
  ASSIGNED: 'Assigned',
  PICKED_UP: 'Picked Up',
  IN_TRANSIT: 'In Transit',
  ARRIVED_HUB: 'Arrived at Hub',
  OUT_FOR_DELIVERY: 'Out for Delivery',
  DELIVERED: 'Delivered',
  // A customer has asked to cancel and stated a reason; an admin has not
  // decided yet. Deliberately a status and not a flag beside one: the point is
  // that the order stops advancing while a human looks at it, and every
  // surface here — badges, the Advance button, STATUS_FLOW, the filters —
  // already keys off `status`. See 20260816100000_cancellation_requests.sql.
  PENDING_CANCELLATION: 'Pending Cancellation',
  CANCELLED: 'Cancelled',
};

export const VALID_STATUSES = Object.values(ORDER_STATUS);

// Sequential status flow (each status maps to its next allowed status)
export const STATUS_FLOW = {
  [ORDER_STATUS.PENDING_REVIEW]: ORDER_STATUS.PENDING,
  [ORDER_STATUS.PENDING]: ORDER_STATUS.ASSIGNED,
  [ORDER_STATUS.ASSIGNED]: ORDER_STATUS.PICKED_UP,
  [ORDER_STATUS.PICKED_UP]: ORDER_STATUS.IN_TRANSIT,
  [ORDER_STATUS.IN_TRANSIT]: ORDER_STATUS.ARRIVED_HUB,
  [ORDER_STATUS.ARRIVED_HUB]: ORDER_STATUS.OUT_FOR_DELIVERY,
  [ORDER_STATUS.OUT_FOR_DELIVERY]: ORDER_STATUS.DELIVERED,
};
```

*4.2*  
File: `status.js`  
Path: `src/constants/status.js`  
Lines: 585–626  
Module/Feature: Shipment Status Workflow and Tracking  
Description: validateStatusTransition() enforces the status flow: delivered/cancelled orders are locked, statuses cannot be skipped, trip-required statuses need an assigned trip, and unpaid cargo cannot be dispatched without a promise-to-pay date.

```text
export const validateStatusTransition = (currentStatus, newStatus, tripId, order = null) => {
  if (currentStatus === ORDER_STATUS.DELIVERED || currentStatus === ORDER_STATUS.CANCELLED) {
    return { valid: false, error: `Cannot update an order that is already "${currentStatus}"` };
  }
  // Frozen pending review. The only ways out are approve → Cancelled and
  // reject → the recorded previous status, both written by
  // review_order_cancellation(). Mirrors the hold in guard_order_update.
  if (currentStatus === ORDER_STATUS.PENDING_CANCELLATION && newStatus !== ORDER_STATUS.CANCELLED) {
    return {
      valid: false,
      error: 'This order has a cancellation request awaiting review. Approve or reject it first.',
    };
  }
  if (newStatus === ORDER_STATUS.CANCELLED) {
    return { valid: true };
  }
  if (!VALID_STATUSES.includes(newStatus)) {
    return { valid: false, error: `Invalid status: "${newStatus}"` };
  }
  if (REQUIRES_TRIP.includes(newStatus) && !tripId) {
    return { valid: false, error: `Cannot set status to "${newStatus}" without an assigned trip.` };
  }
  const expectedNext = STATUS_FLOW[currentStatus];
  if (newStatus !== expectedNext) {
    return {
      valid: false,
      error: `Invalid transition: "${currentStatus}" → "${newStatus}". Next: "${expectedNext || 'none'}"`,
    };
  }

  // Warehouse hold: an unpaid Prepaid shipment is not dispatched for doorstep
  // delivery without a Promise Date. Only checked when the caller supplied the
  // order, so existing 3-arg callers are unaffected.
  if (newStatus === ORDER_STATUS.OUT_FOR_DELIVERY && order) {
    const dispatch = canDispatchForDelivery(order);
    if (!dispatch.allowed) {
      return { valid: false, error: dispatch.reason };
    }
  }

  return { valid: true };
};
```

*4.3*  
File: `database.js`  
Path: `src/lib/database.js`  
Lines: 3774–3780  
Module/Feature: Shipment Status Workflow and Tracking  
Description: Client function for public shipment tracking by tracking number; it calls a database RPC so the page never reads the orders table directly.

```text
export const getPublicTrackingResult = async (trackingNumber) => {
  const { data, error } = await supabase
    .rpc('track_order_public', { p_tracking_number: trackingNumber })
    .maybeSingle();
  if (error) throw error;
  return data;
};
```

*4.4*  
File: `20260926100000_simplify_stage1_derive_and_compat.sql`  
Path: `supabase/migrations/20260926100000_simplify_stage1_derive_and_compat.sql`  
Lines: 768–798  
Module/Feature: Shipment Status Workflow and Tracking  
Description: track_order_public() RPC that returns a privacy-safe tracking result (masked sender and receiver names, shortened package description) together with trip departure and arrival dates.

```text
CREATE OR REPLACE FUNCTION public.track_order_public(p_tracking_number text)
 RETURNS TABLE(tracking_number character varying, status character varying, sender_name text, receiver_name text, origin character varying, destination character varying, package_description text, actual_weight numeric, estimated_delivery timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone, trip_departure_date timestamp with time zone, trip_departure_at timestamp with time zone, trip_estimated_arrival_at timestamp with time zone, trip_arrived_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    o.tracking_number,
    o.status,
    public.mask_name(public.format_person_name(o.sender_first_name, o.sender_last_name))     AS sender_name,
    public.mask_name(public.format_person_name(o.receiver_first_name, o.receiver_last_name)) AS receiver_name,
    o.origin,
    o.destination,
    CASE
      WHEN length(o.package_description) > 40
        THEN left(o.package_description, 40) || '…'
      ELSE o.package_description
    END                               AS package_description,
    o.actual_weight,
    t.arrival_date                    AS estimated_delivery,
    o.created_at,
    o.updated_at,
    t.departure_date                  AS trip_departure_date,
    t.departure_at                    AS trip_departure_at,
    t.estimated_arrival_at            AS trip_estimated_arrival_at,
    t.arrived_at                      AS trip_arrived_at
  FROM public.orders AS o
  LEFT JOIN public.trips AS t ON t.id = o.trip_id
  WHERE o.tracking_number = UPPER(TRIM(p_tracking_number))
  LIMIT 1;
$function$;
```

**Module 5: Trip Management**

*5.1*  
File: `database.js`  
Path: `src/lib/database.js`  
Lines: 856–985  
Module/Feature: Trip Management  
Description: createTrip() creates a new trip after rejecting duplicate route/date trips, then automatically assigns matching pending bookings within the van capacity and can optionally send a trip announcement email to subscribers.

```text
export const createTrip = async (tripData) => {
  // Our own flag, not a trips column — pulled out before the insert below,
  // then used after the trip (and its trip_number) actually exist.
  const { announce_via_email, ...tripFields } = tripData;
  const tripNumber = generateTripNumber();

  const { data: user } = await supabase.auth.getUser();

  const duplicate = await findDuplicateTrip(tripFields);
  if (duplicate) {
    throw new Error(duplicateTripMessage(tripFields.origin, tripFields.destination, tripFields.departure_date));
  }

  const { data, error } = await supabase
    .from('trips')
    .insert({
      // available_slots is intentionally not written: it was a stale copy of
      // capacity that nothing ever read or decremented. Deprecated in
      // 20260803150000_deprecate_dead_columns.sql. Trip load is computed live
      // from order weights (see getTrips / current_trip_weight).
      ...tripFields,
      status: 'scheduled',
      trip_number: tripNumber,
      created_by: user?.user?.id || null,
    })
    .select()
    .single();
  if (error) {
    // The index is the real gate; the check above only loses a round trip.
    if (error.code === '23505' && /trips_unique_route_departure_day/.test(error.message || '')) {
      throw new Error(duplicateTripMessage(tripFields.origin, tripFields.destination, tripFields.departure_date));
    }
    throw error;
  }
  // Capacity is not a trip column; the auto-assignment below plans against
  // the current Company Information capacity.
  await attachCompanyTripDefaults(data);

  // Auto-assign pending orders matching this route
  let autoAssignedCount = 0;
  let autoAssignmentWarning = null;
  if (data.origin && data.destination) {
    const { data: pendingOrders, error: pendingErr } = await supabase
      .from('orders')
      .select('id, actual_weight')
      .eq('status', 'Pending')
      .is('trip_id', null)
      .eq('origin', data.origin)
      .eq('destination', data.destination)
      .order('created_at', { ascending: true });

    if (pendingErr) {
      autoAssignmentWarning = 'The trip was created, but pending bookings could not be checked for automatic assignment.';
    } else if (pendingOrders?.length) {
      let plannedWeight = 0;
      const selectedIds = [];
      const capacity = Number(data.capacity || 0);

      for (const order of pendingOrders) {
        const weight = parseFloat(order.actual_weight || 0);
        if (capacity > 0 && plannedWeight + weight > capacity) continue;
        plannedWeight += weight;
        selectedIds.push(order.id);
      }

      if (selectedIds.length > 0) {
        const { data: updated, error: updateErr } = await supabase
          .from('orders')
          .update({ trip_id: data.id, status: 'Assigned' })
          .in('id', selectedIds)
          // Compare-and-set the state used when selecting candidates. Without
          // these filters, a concurrent admin action could be overwritten and
          // move an order back to Assigned or onto the wrong route.
          .eq('status', 'Pending')
          .is('trip_id', null)
          .eq('origin', data.origin)
          .eq('destination', data.destination)
          .select('id, user_id, tracking_number');
        
        if (updateErr) {
          autoAssignmentWarning = 'The trip was created, but matching pending bookings could not be assigned automatically.';
        } else {
          autoAssignedCount = updated?.length || 0;
          if (autoAssignedCount !== selectedIds.length) {
            autoAssignmentWarning = `The trip was created, but ${selectedIds.length - autoAssignedCount} matching booking(s) changed before automatic assignment. Review the trip before departure.`;
          }
          
          // Activity logs only. The customer's "Order Assigned" notification is
          // written by the orders_notify_customer_of_change trigger inside the
          // same transaction as the trip_id write above — sending it from here
          // as well would give every auto-assigned customer two of them.
          await Promise.all((updated || []).map(async (order) => {
            try {
              await logOrder('Order Assigned', order.id, order.tracking_number, {
                previousValue: { status: 'Pending', trip_id: null },
                newValue: { status: 'Assigned', trip_id: data.id },
                details: `System auto-assigned to Trip ${tripNumber} during creation`
              });
            } catch (err) {
              console.warn(`Failed to log auto-assignment for order ${order.id}`, err);
            }
          }));
        }
      }
    }
  }

  // Optional trip-schedule email blast. The trip INSERT already created the
  // customer in-app notifications and push jobs atomically in the database.
  // This email-only announcement reuses the durable subscriber-email worker
  // without producing a second customer notification.
  // The consent check (profiles.wants_announcements / contact_inquiries.
  // wants_announcements) lives entirely inside that Edge Function; nothing
  // here bypasses or duplicates it.
  if (announce_via_email) {
    try {
      await createAnnouncement({
        title: `Bagong Biyahe: ${data.origin} → ${data.destination}`,
        content: `Bagong Biyahe! Mayroon kaming bagong scheduled trip papuntang ${data.destination} sa ${formatPhDate(data.departure_date)}. I-secure na ang slot ng inyong cargo habang may space pa!`,
        send_email: true,
        audience: 'email_only',
      });
    } catch (announceErr) {
      // Non-critical — the trip itself is already created and usable.
      console.warn('[createTrip] trip announcement failed to publish:', announceErr);
    }
  }

  return { ...data, autoAssignedCount, autoAssignmentWarning };
};
```

*5.2*  
File: `database.js`  
Path: `src/lib/database.js`  
Lines: 1336–1359  
Module/Feature: Trip Management  
Description: reassignTrip() moves a booking to another trip after re-checking the destination trip's capacity, then calls the reassign_trip RPC.

```text
export const reassignTrip = async (orderId, newTripId, reason) => {
  // Reassignment moves weight onto a trip exactly as a first assignment does,
  // so it answers to the same ceiling. It goes through the `reassign_trip` RPC
  // rather than updateOrder, which is why the check has to be repeated here —
  // without it, "move it to another trip" would be the way around the limit.
  if (newTripId) {
    const [{ data: trip }, { data: order }] = await Promise.all([
      supabase.from('trips').select('id').eq('id', newTripId).single(),
      supabase.from('orders').select('actual_weight').eq('id', orderId).single(),
    ]);
    if (trip) {
      await attachCompanyTripDefaults(trip);
      await assertTripCapacity(trip, parseFloat(order?.actual_weight || 0) || 0, orderId);
    }
  }

  const { data, error } = await supabase.rpc('reassign_trip', {
    p_order_id: orderId,
    p_new_trip_id: newTripId,
    p_reason: reason
  });
  if (error) throw error;
  return data;
};
```

*5.3*  
File: `database.js`  
Path: `src/lib/database.js`  
Lines: 3025–3056  
Module/Feature: Trip Management  
Description: bulkUpdateOrdersStatusByTrip() advances the status of every booking on a trip (for example when a trip departs or arrives) and logs each change.

```text
export const bulkUpdateOrdersStatusByTrip = async (tripId, currentStatuses, newStatus, actionDescription) => {
  // 1. Fetch matching orders
  const { data: orders, error: fetchErr } = await supabase
    .from('orders')
    .select('id, tracking_number, status, user_id')
    .eq('trip_id', tripId)
    .in('status', currentStatuses);

  if (fetchErr) throw fetchErr;
  if (!orders || orders.length === 0) return 0;

  // 2. Perform updates and create notifications
  await Promise.all(orders.map(async (order) => {
    // Update order status
    const { error: updateErr } = await supabase
      .from('orders')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', order.id);
    
    if (updateErr) throw updateErr;

    // Log the activity. The customer's status notification comes from the
    // orders_notify_customer_of_change trigger on the UPDATE above.
    logOrder(`Status Changed to ${newStatus}`, order.id, order.tracking_number, {
      previousValue: { status: order.status },
      newValue: { status: newStatus },
      details: actionDescription || `Bulk update via Trip ${tripId}`
    });
  }));

  return orders.length;
};
```

**Module 6: PayMongo GCash Payment Integration**

*6.1*  
File: `index.ts`  
Path: `supabase/functions/paymongo-create-payment/index.ts`  
Lines: 162–191  
Module/Feature: PayMongo GCash Payment Integration  
Description: Captures a chargeable GCash source by creating a PayMongo payment (amount converted to centavos). The secret key is read from a server environment variable through paymongoAuthHeader(), never from the browser.

```text
const capturePayment = async (sourceId: string, amount: number, description: string | null) => {
  const response = await providerFetch('https://api.paymongo.com/v1/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': paymongoAuthHeader(),
    },
    body: JSON.stringify({
      data: {
        attributes: {
          amount: Math.round(amount * 100),
          source: { id: sourceId, type: 'source' },
          currency: 'PHP',
          description: description || 'CargoExpress PH Shipping Payment',
        },
      },
    }),
  })

  const result = await response.json()
  if (!response.ok) {
    throw new Error(result.errors?.[0]?.detail || 'Failed to process payment')
  }

  return {
    paymentId: result.data.id,
    status: result.data.attributes.status,
    amount: result.data.attributes.amount / 100,
  }
}
```

*6.2*  
File: `index.ts`  
Path: `supabase/functions/paymongo-create-payment/index.ts`  
Lines: 226–353  
Module/Feature: PayMongo GCash Payment Integration  
Description: Excerpt of the payment Edge Function request handler. It authenticates the caller, validates the input, verifies that the caller is an admin or the owner of the order, and re-checks the amount against the order's outstanding balance on the server so a customer can never underpay or overpay.

```text
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) {
      return json({ error: 'Authentication required' }, 401)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )

    const { data: userData, error: userError } = await supabase.auth.getUser()
    if (userError || !userData.user) {
      return json({ error: 'Authentication required' }, 401)
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userData.user.id)
      .single()

    const { sourceId, amount, description, orderUpdate, action } = await req.json()
    const parsedAmount = Number(amount)
    const normalizedAction = action ?? 'capture'

    if (typeof sourceId !== 'string' || !PAYMONGO_SOURCE_ID.test(sourceId)) {
      return json({ error: 'A valid PayMongo sourceId is required' }, 400)
    }
    if (typeof normalizedAction !== 'string' || !PAYMENT_ACTIONS.has(normalizedAction)) {
      return json({ error: 'Unsupported payment action' }, 400)
    }
    if (description != null && (typeof description !== 'string' || description.length > 500)) {
      return json({ error: 'description must be a string of at most 500 characters' }, 400)
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return json({ error: 'amount must be greater than zero' }, 400)
    }

    const adminSupabase = serviceClient()
    const isAdmin = !profileError && profile?.role === 'admin'

    const orderUpdateAuthorization = authorizeOrderUpdate(orderUpdate, isAdmin)
    if (orderUpdateAuthorization.error) {
      console.warn('[paymongo-create-payment] Unauthorized order metadata rejected')
      return json({ error: orderUpdateAuthorization.error }, orderUpdateAuthorization.status)
    }
    const authorizedOrderUpdate = orderUpdateAuthorization.value

    // Load the order once — needed for BOTH the ownership check and the
    // server-side amount validation below.
    let orderRow: {
      user_id: string
      remaining_balance: number | null
      tracking_number: string | null
    } | null = null

    if (authorizedOrderUpdate?.orderId) {
      const { data } = await adminSupabase
        .from('orders')
        .select('user_id, remaining_balance, tracking_number')
        .eq('id', authorizedOrderUpdate.orderId)
        .single()
      orderRow = data as typeof orderRow
    }

    // Access Check: Admin OR Owner of the order
    if (!isAdmin) {
      if (!orderRow) {
        return json({ error: 'Admin access or valid order ID required' }, 403)
      }
      if (orderRow.user_id !== userData.user.id) {
        return json({ error: 'Unauthorized to pay for this order' }, 403)
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECURITY: the amount is supplied by the client and must never be trusted.
    //
    // Before this check, a caller could create a PayMongo source for any amount
    // (the browser holds the PUBLIC key and calls /v1/sources directly), then
    // register it here — paying ₱1 against a ₱5,000 order. See P-1 in
    // docs/archive/payment-redesign-v2.md.
    //
    // The order's outstanding balance is the authority. 'poll' is exempt: it
    // sends a placeholder amount of 1 and the server uses the stored attempt
    // amount instead.
    // ─────────────────────────────────────────────────────────────────────────
    if (normalizedAction !== 'poll') {
      if (!orderRow) {
        return json({ error: 'A valid order ID is required to create a payment.' }, 400)
      }

      const balance   = Number(orderRow.remaining_balance ?? 0)
      const TOLERANCE = 0.01   // remaining_balance is DECIMAL(10,2)
      const exceeds   = parsedAmount > balance + TOLERANCE

      if (!isAdmin) {
        // Customers may never pay more than they owe, nor pay a settled order.
        if (!(balance > 0)) {
          return json({ error: 'This order has no outstanding balance.' }, 409)
        }
        if (exceeds) {
          console.warn('[paymongo-create-payment] Customer over-balance amount rejected')
          return json({
            error: `Amount ₱${parsedAmount.toFixed(2)} exceeds the outstanding balance of ₱${balance.toFixed(2)}.`,
          }, 400)
        }
      } else if (exceeds || !(balance > 0)) {
        // Admins legitimately charge ABOVE the stored balance. At pickup the new
        // actual_weight has not been saved yet, so orders.shipping_cost is still
        // the booking estimate — e.g. booked 10 kg (₱800) but weighed 15 kg
        // (₱1,200). Rejecting that would break the admin pickup flow entirely.
        // Admins can already write orders directly, so this is not a new hole.
        // Logged for audit; the ledger records what was actually collected.
        console.warn('[paymongo-create-payment] Authorized admin over-balance pickup charge')
      }
    }
```

*6.3*  
File: `index.ts`  
Path: `supabase/functions/paymongo-webhook/index.ts`  
Lines: 41–84  
Module/Feature: PayMongo GCash Payment Integration  
Description: Webhook security: verifies the PayMongo-Signature header using HMAC-SHA256 over the raw request body, rejects replayed events older than five minutes, and compares signatures in constant time.

```text
const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

const parseSignature = (header: string) => {
  return header.split(',').reduce<Record<string, string>>((acc, part) => {
    const [key, value] = part.split('=')
    if (key && value !== undefined) acc[key.trim()] = value.trim()
    return acc
  }, {})
}

const verifySignature = async (rawBody: string, signatureHeader: string | null) => {
  const secret = Deno.env.get('PAYMONGO_WEBHOOK_SECRET')
  if (!secret) throw new Error('PAYMONGO_WEBHOOK_SECRET is not configured')
  if (!signatureHeader) return false

  const parts = parseSignature(signatureHeader)
  if (!parts.t) return false

  // Prevent replay attacks (5-minute tolerance)
  const currentTimestamp = Math.floor(Date.now() / 1000)
  if (currentTimestamp - Number(parts.t) > 300) {
    console.error('[paymongo-webhook] Signature timestamp is too old')
    return false
  }

  const signedPayload = `${parts.t}.${rawBody}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload)))

  return [parts.te, parts.li].some(value => value && timingSafeEqual(expected, value))
}
```

**Module 7: Partial Payment and Remaining Balance**

*7.1*  
File: `status.js`  
Path: `src/constants/status.js`  
Lines: 495–544  
Module/Feature: Partial Payment and Remaining Balance  
Description: Client-side balance rules: an order is priced only after it is weighed; the final fee is the shipping cost minus any discount; the outstanding balance is the final fee minus the amount already paid.

```text
/**
 * isOrderPriced — has this parcel been weighed, and therefore billed?
 *
 * `actual_weight` is the single input to the pricing formula and it enters the
 * system exactly once, from the scale at pickup. Until then `shipping_cost`
 * and `remaining_balance` are both 0 — and those two zeros mean "not priced
 * yet", never "paid in full". Every settlement question has to ask this first,
 * or an unweighed booking reads as a fully settled one.
 */
export const isOrderPriced = (order) => {
  if (!order) return false;
  return (parseFloat(order.actual_weight || 0) || 0) > 0;
};

/**
 * finalShippingFee — the DISCOUNTED, payable fee: shipping_cost (the
 * ORIGINAL fee — never redefined, see the shipping-discount migrations)
 * minus discount_amount, floored at 0. Mirrors order_payable_amount() in
 * Postgres exactly, so the client and the database can never disagree about
 * what an order's final fee is.
 */
export const finalShippingFee = (order) => {
  if (!order) return 0;
  const cost = parseFloat(order.shipping_cost || 0) || 0;
  const discount = parseFloat(order.discount_amount || 0) || 0;
  return Math.max(0, Math.round((cost - discount) * 100) / 100);
};

/** Has a discount actually been applied to this order? */
export const hasDiscount = (order) => (parseFloat(order?.discount_amount || 0) || 0) > 0;

/**
 * outstandingBalance — THE single client-side definition of "what is owed".
 *
 * Derived from `finalShippingFee(order) - amount_paid` rather than read from
 * the stored `remaining_balance` column. Both are maintained by the database,
 * but the stored copy can lag a ledger write, and two views reading two
 * different columns is exactly what produced two different "Outstanding"
 * figures in one report. Mirrors the SQL in get_sales_summary() / the
 * settlement queries in lib/database.js.
 *
 * Discount-aware since the shipping-discount feature: a discount reduces what
 * is owed exactly like a payment would reduce it, so it has to enter this
 * same single formula rather than being handled ad hoc by each caller.
 */
export const outstandingBalance = (order) => {
  if (!order) return 0;
  const paid = parseFloat(order.amount_paid || 0) || 0;
  return Math.max(0, Math.round((finalShippingFee(order) - paid) * 100) / 100);
};
```

*7.2*  
File: `database.js`  
Path: `src/lib/database.js`  
Lines: 3212–3231  
Module/Feature: Partial Payment and Remaining Balance  
Description: recordAdditionalPayment() records a partial or remaining-balance payment through the record_additional_payment RPC and returns the updated paid amount, balance and status.

```text
export const recordAdditionalPayment = async (orderId, amount, method, ref, notes, paymentDate = null, receiptUrl = null, idempotencyKey = null, adminVerifiedReceipt = false) => {
  const { data, error } = await supabase.rpc('record_additional_payment', {
    p_order_id: orderId,
    p_amount: amount,
    p_payment_method: method,
    p_reference: ref || null,
    p_notes: notes || null,
    p_payment_date: paymentDate || null,
    p_receipt_url: receiptUrl || null,
    p_idempotency_key: idempotencyKey || null,
    p_admin_verified_receipt: adminVerifiedReceipt || false,
  });
  if (error) throw error;

  return {
    newAmountPaid: data.amount_paid,
    newBalance: data.remaining_balance,
    newStatus: data.payment_status,
  };
};
```

*7.3*  
File: `20260919020000_fix_manual_payment_refund_awareness_part2.sql`  
Path: `supabase/migrations/20260919020000_fix_manual_payment_refund_awareness_part2.sql`  
Lines: 7–132  
Module/Feature: Partial Payment and Remaining Balance  
Description: record_additional_payment() RPC. Admin-only; locks the order row, supports idempotent retries, accepts GCash only after pickup, rejects amounts above the outstanding balance (net of refunds), and labels the payment as partial or fully paid.

```text
CREATE OR REPLACE FUNCTION public.record_additional_payment(
  p_order_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_reference text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_payment_date date DEFAULT NULL::date,
  p_receipt_url text DEFAULT NULL::text,
  p_idempotency_key uuid DEFAULT NULL::uuid,
  p_admin_verified_receipt boolean DEFAULT false
)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order              public.orders;
  v_admin_name         TEXT;
  v_paid_before        NUMERIC;
  v_paid_after         NUMERIC;
  v_payable            NUMERIC;
  v_outstanding_before NUMERIC;
  v_label              TEXT;
  v_ref_norm           TEXT;
  v_idempotency_order_id UUID;
  v_method             TEXT := lower(COALESCE(p_payment_method, ''));
  v_type               TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  IF COALESCE(p_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT order_id INTO v_idempotency_order_id
      FROM public.payment_transactions
     WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_idempotency_order_id = p_order_id THEN
        RETURN v_order;
      END IF;
      RAISE EXCEPTION 'This payment attempt identifier is already associated with another order.'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  IF v_method = 'cash' THEN
    RAISE EXCEPTION 'Cash is no longer accepted once an order has been picked up. Collect the remaining balance via GCash.'
      USING ERRCODE = '22023';
  END IF;

  IF v_method <> 'gcash' THEN
    RAISE EXCEPTION 'Unsupported payment method: %', COALESCE(p_payment_method, '(missing)')
      USING ERRCODE = '22023';
  END IF;

  v_ref_norm := public.guard_manual_gcash_payment(p_reference, p_admin_verified_receipt);

  DECLARE
    v_gross_paid_before NUMERIC;
    v_refunded          NUMERIC;
  BEGIN
    SELECT COALESCE(SUM(amount), 0)
      INTO v_gross_paid_before
      FROM public.payment_transactions
     WHERE order_id = p_order_id
       AND payment_status IN ('paid', 'partial');
       
    SELECT COALESCE(SUM(amount), 0)
      INTO v_refunded
      FROM public.payment_refunds
     WHERE order_id = p_order_id
       AND status = 'succeeded';
       
    v_paid_before := GREATEST(0, v_gross_paid_before - v_refunded);
  END;

  v_payable            := public.order_payable_amount(v_order.shipping_cost, v_order.discount_amount);
  v_outstanding_before := GREATEST(0, v_payable - v_paid_before);

  IF p_amount > v_outstanding_before + 0.005 THEN
    RAISE EXCEPTION 'Payment amount of ₱% exceeds the outstanding balance of ₱%.',
      TO_CHAR(p_amount, 'FM999999990.00'),
      TO_CHAR(v_outstanding_before, 'FM999999990.00')
      USING ERRCODE = '22023';
  END IF;

  SELECT name INTO v_admin_name FROM public.profiles WHERE id = auth.uid();

  v_paid_after := v_paid_before + p_amount;
  v_label := CASE WHEN v_paid_after >= v_payable THEN 'paid' ELSE 'partial' END;
  v_type  := CASE
               WHEN v_label = 'paid' AND v_outstanding_before > 0.005 THEN 'Balance Settlement'
               ELSE 'Additional Payment'
             END;

  BEGIN
    INSERT INTO public.payment_transactions (
      order_id, amount, payment_method, payment_status,
      transaction_reference, transaction_reference_normalized, gcash_channel,
      admin_id, admin_name, notes, payment_type, payment_date, receipt_url,
      idempotency_key
    ) VALUES (
      p_order_id, p_amount, 'gcash', v_label,
      p_reference, v_ref_norm, 'manual',
      auth.uid(), COALESCE(v_admin_name, 'Unknown Admin'), p_notes,
      v_type, p_payment_date, p_receipt_url, p_idempotency_key
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This GCash reference was already recorded on another order. It cannot be credited again.'
      USING ERRCODE = '23505';
  END;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  RETURN v_order;
END;
$function$;
```

*7.4*  
File: `20260913170000_serialize_order_payment_totals.sql`  
Path: `supabase/migrations/20260913170000_serialize_order_payment_totals.sql`  
Lines: 13–69  
Module/Feature: Partial Payment and Remaining Balance  
Description: Trigger function that recalculates an order's amount paid, remaining balance and payment status from the payment ledger (payments minus successful refunds) every time a payment row changes.

```text
CREATE OR REPLACE FUNCTION public.update_order_payment_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_gross_paid      NUMERIC(10,2);
  v_refunded        NUMERIC(10,2);
  v_total_paid      NUMERIC(10,2);
  v_shipping_cost   NUMERIC(10,2);
  v_discount_amount NUMERIC(10,2);
  v_payable         NUMERIC(10,2);
  v_remaining       NUMERIC(10,2);
  v_order_id        UUID;
BEGIN
  v_order_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;

  -- This is the common serialization point for payment and refund triggers.
  -- The aggregate SELECTs happen after the lock. Under READ COMMITTED, a
  -- concurrent waiter therefore takes its aggregate snapshot after the
  -- earlier recalculation commits and includes that transaction's child row.
  SELECT shipping_cost, discount_amount
    INTO v_shipping_cost, v_discount_amount
    FROM public.orders
   WHERE id = v_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(amount), 0)
    INTO v_gross_paid
    FROM public.payment_transactions
   WHERE order_id = v_order_id
     AND payment_status IN ('paid', 'partial');

  SELECT COALESCE(SUM(amount), 0)
    INTO v_refunded
    FROM public.payment_refunds
   WHERE order_id = v_order_id
     AND status = 'succeeded';

  v_total_paid := GREATEST(v_gross_paid - v_refunded, 0);
  v_payable := public.order_payable_amount(v_shipping_cost, v_discount_amount);
  v_remaining := GREATEST(0, v_payable - v_total_paid);

  UPDATE public.orders
     SET amount_paid = v_total_paid,
         remaining_balance = v_remaining,
         payment_status = public.derive_payment_status(v_payable, v_total_paid)
   WHERE id = v_order_id;

  RETURN NULL;
END;
$function$;
```

**Module 8: Notifications**

*8.1*  
File: `20260905003149_complete_order_notification_atomicity.sql`  
Path: `supabase/migrations/20260905003149_complete_order_notification_atomicity.sql`  
Lines: 15–145  
Module/Feature: Notifications  
Description: Database trigger that automatically notifies the customer when a booking is assigned, moved to another trip, picked up, delivered, cancelled, or otherwise updated. The notification is saved in the same transaction as the order change.

```text
CREATE OR REPLACE FUNCTION private.notify_customer_of_order_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_title TEXT;
  v_message TEXT;
  v_reason TEXT;
BEGIN
  -- A trip-status trigger updates its orders and emits the more useful
  -- trip-specific message itself. Suppress a second generic order message for
  -- those nested writes.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Walk-in orders are initially owned by the creating admin. Only registered
  -- customer profiles should receive customer lifecycle notifications.
  IF NEW.user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    WHERE p.id = NEW.user_id
      AND p.role = 'customer'
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    v_title := 'Booking Added to Your Account';
    v_message := format(
      'Booking %s has been added to your account history.',
      NEW.tracking_number
    );

  ELSIF NEW.service_area_status IS DISTINCT FROM OLD.service_area_status
        AND NEW.service_area_status = 'approved' THEN
    v_title := 'Pickup Request Approved';
    v_message := format(
      'Your special pickup request for Order %s has been approved.',
      NEW.tracking_number
    );

  ELSIF NEW.service_area_status IS DISTINCT FROM OLD.service_area_status
        AND NEW.service_area_status = 'rejected' THEN
    v_title := 'Pickup Request Rejected';
    v_message := format(
      'Your special pickup request for Order %s could not be accommodated. Reason: %s',
      NEW.tracking_number,
      COALESCE(NULLIF(btrim(NEW.service_area_remarks), ''), 'Not specified')
    );

  ELSIF NEW.trip_id IS DISTINCT FROM OLD.trip_id THEN
    IF NEW.trip_id IS NULL THEN
      v_title := 'Trip Assignment Removed';
      v_message := format(
        'Order %s is no longer assigned to its previous trip.',
        NEW.tracking_number
      );
    ELSIF OLD.trip_id IS NULL THEN
      v_title := 'Order Assigned';
      v_message := format('Order %s assigned to a trip', NEW.tracking_number);
    ELSE
      v_title := 'Trip Reassigned';
      v_message := format(
        'Order %s has been moved to a new trip',
        NEW.tracking_number
      );
    END IF;

  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    -- These transitions already create purpose-built notifications in their
    -- owning RPCs. Avoid duplicating those messages.
    IF NEW.status = 'Pending Cancellation'
       OR OLD.status = 'Pending Cancellation' THEN
      RETURN NEW;
    END IF;

    CASE NEW.status
      WHEN 'Picked Up' THEN
        v_title := 'Pickup Complete';
        v_message := format(
          'Order %s has been picked up',
          NEW.tracking_number
        );
      WHEN 'Delivered' THEN
        v_title := 'Delivery Complete';
        v_message := format(
          'Order %s has been delivered',
          NEW.tracking_number
        );
      WHEN 'Cancelled' THEN
        v_reason := NULLIF(btrim(NEW.cancellation_details->>'reason'), '');
        v_title := 'Order Cancelled';
        v_message := format(
          'Order %s has been cancelled.%s',
          NEW.tracking_number,
          CASE WHEN v_reason IS NULL THEN '' ELSE ' Reason: ' || v_reason END
        );
      ELSE
        v_title := 'Order Updated';
        v_message := format(
          'Order %s: %s',
          NEW.tracking_number,
          NEW.status
        );
    END CASE;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (
    user_id, title, message, type, reference_id
  ) VALUES (
    NEW.user_id, v_title, v_message, 'order_update', NEW.id
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.notify_customer_of_order_change()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orders_notify_customer_of_change ON public.orders;
CREATE TRIGGER orders_notify_customer_of_change
AFTER UPDATE OF user_id, service_area_status, trip_id, status
ON public.orders
FOR EACH ROW
EXECUTE FUNCTION private.notify_customer_of_order_change();
```

*8.2*  
File: `database.js`  
Path: `src/lib/database.js`  
Lines: 1530–1559  
Module/Feature: Notifications  
Description: Client functions that load a user's notifications (newest first, paginated) and mark one or all notifications as read.

```text
export const getNotifications = async (userId, { limit = 50, offset = 0 } = {}) => {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
};

export const markNotificationRead = async (id) => {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', id);
  if (error) throw error;
  emitNotificationsChanged();
};

export const markAllNotificationsRead = async (userId) => {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (error) throw error;
  emitNotificationsChanged();
};
```

**Module 9: Customer Support Chat**

*9.1*  
File: `database.js`  
Path: `src/lib/database.js`  
Lines: 2496–2529  
Module/Feature: Customer Support Chat  
Description: getOrCreateConversation() finds the customer's support conversation or creates one that starts in chatbot mode.

```text
export const getOrCreateConversation = async (customerId) => {
  // Try to find existing — use .limit(1) instead of .single() to avoid
  // PGRST116 errors when multiple rows exist (no unique constraint on
  // customer_id). .single() fails when 0 OR 2+ rows match, which caused
  // the snowballing duplicate-conversation bug.
  let { data: convRows, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true })
    .limit(1);
    
  if (error) throw error;
  
  let conv = convRows && convRows.length > 0 ? convRows[0] : null;
  
  // If not exists, create with status='bot_active' so the chatbot becomes the
  // first responder. It moves to 'waiting' only when the customer escalates.
  //
  // This used to insert 'closed' — the same value an admin wrote when they
  // FINISHED a conversation. One value meaning both "never needed a human"
  // and "a human is done" is why "nobody has replied yet" was unrepresentable.
  // See 20260804210000_conversation_service_state.sql.
  if (!conv) {
    const { data: newConv, error: createError } = await supabase
      .from('conversations')
      .insert({ customer_id: customerId, status: 'bot_active' })
      .select()
      .single();
    if (createError) throw createError;
    conv = newConv;
  }
  return conv;
};
```

*9.2*  
File: `database.js`  
Path: `src/lib/database.js`  
Lines: 2802–2815  
Module/Feature: Customer Support Chat  
Description: sendMessage() saves a chat message from a customer or admin into Supabase.

```text
export const sendMessage = async (conversationId, senderId, senderRole, text) => {
  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      conversation_id: conversationId,
      sender_id: senderId,
      sender_role: senderRole,
      message: text
    })
    .select()
    .single();
  if (error) throw error;
  return data;
};
```

*9.3*  
File: `supportChatEngine.js`  
Path: `src/lib/supportChatEngine.js`  
Lines: 1995–2104  
Module/Feature: Customer Support Chat  
Description: getBotReply() is the support chatbot engine. It detects the topic and language, handles menu selections, escalates case-specific problems to a human admin, matches the message against known intents (such as booking status or payment information), and falls back to a help menu when the question is not understood.

```text
export const getBotReply = async (text, userId, suppliedContext = null) => {
  const trimmed = normalizeMessage(text);
  const context = suppliedContext && typeof suppliedContext === 'object'
    ? suppliedContext
    : createConversationContext(userId);

  if (context.userId !== userId || context.version !== CONTEXT_VERSION) {
    resetConversationContext(context, userId, context.conversationId || null);
  }
  context.preferredLanguage = detectPreferredLanguage(trimmed);

  if (!trimmed) {
    context.pendingClarification = { type: 'topic_selection', options: TOPIC_OPTIONS };
    return { text: TOPIC_MENU_TEXT, escalate: false, askResolved: false };
  }

  // A choice is meaningful only when the preceding bot message established a
  // matching menu/selection. In particular, a bare "yes" never becomes a
  // payment consent or a booking action by itself.
  if (context.pendingClarification) {
    const pendingResult = await handlePendingChoice(trimmed, userId, context);
    if (pendingResult) return pendingResult;
  }

  // A direct tracking number is an order selector, not a generic greeting or
  // a public lookup. The actual query remains scoped to the authenticated user.
  const explicitTopic = detectTopic(trimmed);
  if (explicitTopic && context.currentTopic && explicitTopic !== context.currentTopic) {
    // A selected booking remains useful across related questions such as
    // "check mine" → "what is my balance?". An explicit tracking number or
    // the topic menu is what changes/clears the selected booking.
    context.pendingClarification = null;
  }
  if (explicitTopic) context.currentTopic = explicitTopic;

  if (isBareHow(trimmed) && context.currentTopic) {
    const followup = TOPIC_FOLLOWUPS[context.currentTopic];
    if (followup) {
      context.pendingClarification = { type: 'topic_followup', topic: context.currentTopic };
      return { text: followup.text, escalate: false, askResolved: false, quickReplies: followup.options };
    }
  }

  if (isTopicMenuRequest(trimmed)) {
    context.currentTopic = null;
    context.pendingClarification = { type: 'topic_selection', options: TOPIC_OPTIONS };
    context.selectedBookingId = null;
    context.selectedTrackingNumber = null;
    return { text: TOPIC_MENU_TEXT, escalate: false, askResolved: false, quickReplies: TOPIC_OPTIONS.map(option => option.label) };
  }

  // Specific FAQs are checked before broad handoff patterns. A refund policy
  // question and packing advice are answerable; a case-specific missing
  // payment/refund or damage/loss report goes to a human.
  if (shouldEscalate(trimmed)) {
    context.pendingClarification = null;
    return { text: null, escalate: true, askResolved: false };
  }

  const trackingIntentIds = extractTrackingNumber(trimmed)
    ? (TRACKING_PAYMENT_RX.test(trimmed) ? ['payment_info'] : ['shipment_location'])
    : [];
  const intentsToTry = [
    ...trackingIntentIds.map(id => INTENTS.find(intent => intent.id === id)).filter(Boolean),
    ...INTENTS.filter(intent => !trackingIntentIds.includes(intent.id)),
  ];

  for (const intent of intentsToTry) {
    if (!intent.patterns.some(rx => rx.test(trimmed))) continue;
    try {
      const result = await intent.handler(userId, trimmed, context);
      context.currentTopic = INTENT_TOPIC[intent.id] || context.currentTopic;
      context.consecutiveUnrecognizedReplies = 0;
      if (result.askResolved) {
        context.pendingClarification = { type: 'resolved_confirmation', topic: context.currentTopic };
      }
      return { escalate: false, ...result };
    } catch (err) {
      console.warn('[Bot] Intent handler error:', err?.message || err);
      context.pendingClarification = null;
      return {
        text: 'I cannot load that information right now. Please try again, or choose “Talk to an Admin” so the team can help you without guessing.',
        escalate: false,
        askResolved: false,
        unavailable: true,
      };
    }
  }

  // If the user typed a broad topic word (e.g. "booking", "about payment") 
  // but it didn't match a specific intent, show them the menu for that topic.
  if (explicitTopic) {
    const followup = TOPIC_FOLLOWUPS[explicitTopic];
    if (followup) {
      context.consecutiveUnrecognizedReplies = 0;
      context.pendingClarification = { type: 'topic_followup', topic: explicitTopic };
      return { text: followup.text, escalate: false, askResolved: false, quickReplies: followup.options };
    }
  }

  context.consecutiveUnrecognizedReplies += 1;
  const repeatedHint = context.consecutiveUnrecognizedReplies >= 2
    ? '\n\nI may be missing your question. You can choose a topic above or tap “Talk to an Admin.”'
    : '';
  return {
    text: `I’m not sure what you mean yet. You can ask about a booking, payment, delivery, pickup, or refund.${repeatedHint}`,
    escalate: false,
    askResolved: false,
  };
};
```

**Module 10: Admin Booking Management and Cancellation**

*10.1*  
File: `database.js`  
Path: `src/lib/database.js`  
Lines: 695–729  
Module/Feature: Admin Booking Management and Cancellation  
Description: Cancellation workflow: a customer submits a cancellation request with a reason, and an admin approves or rejects it through server-side RPCs that also write the activity log and customer notification.

```text
export const requestOrderCancellation = async (orderId, reason) => {
  const trimmed = (reason || '').trim();
  if (trimmed.length < 5) {
    throw new Error('Please tell us why you are cancelling (at least 5 characters).');
  }
  const { data, error } = await supabase.rpc('request_order_cancellation', {
    p_order_id: orderId,
    p_reason: trimmed,
  });
  if (error) throw error;

  return data;
};

/**
 * Admin rules on a cancellation request.
 *
 * Approve → 'Cancelled'. Reject → back to `cancellation_previous_status`, the
 * exact status the order was standing in when the request was made, so a
 * rejection puts an Assigned booking back as Assigned rather than guessing
 * 'Pending' and silently detaching it from a trip it is still on.
 *
 * The RPC writes the activity log and the customer's notification itself, so
 * neither can be skipped by a caller that forgets.
 */
export const reviewOrderCancellation = async (orderId, approve, notes = null) => {
  const { data, error } = await supabase.rpc('review_order_cancellation', {
    p_order_id: orderId,
    p_approve: approve,
    p_notes: notes || null,
  });
  if (error) throw error;

  return data;
};
```

**Module 11: Sales Reports**

*11.1*  
File: `database.js`  
Path: `src/lib/database.js`  
Lines: 1087–1132  
Module/Feature: Sales Reports  
Description: getPerTripSalesReport() loads a trip and all of its bookings (paged), their payment history and cancellation settlements, then builds the per-trip sales report.

```text
export const getPerTripSalesReport = async (tripId) => {
  if (!tripId) throw new Error('Choose a trip before loading its report.');

  const { data: trip, error: tripError } = await supabase
    .from('trips')
    .select('*')
    .eq('id', tripId)
    .single();
  if (tripError) throw tripError;
  await attachCompanyTripDefaults(trip);

  const orders = [];
  const pageSize = 1000;
  let from = 0;
  const orderSelect = `id, tracking_number, ${ORDER_PARTY_NAME_COLUMNS}, user_id, status, trip_id, actual_weight, sender_province, sender_city, receiver_province, receiver_city, origin, destination, created_at, shipping_cost, discount_amount, amount_paid, remaining_balance, payment_status, payment_method, payer_type, promised_payment_date, profiles:user_id (name)`;

  while (true) {
    const { data, error } = await supabase
      .from('orders')
      .select(orderSelect)
      .eq('trip_id', tripId)
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = data || [];
    orders.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }

  const orderIds = orders.map(order => order.id);
  const activityByOrder = await getPaymentTransactionsBatch(orderIds);
  const cancelledOrders = orders.filter(order => order.status === ORDER_STATUS.CANCELLED);
  const settlementPairs = await Promise.all(cancelledOrders.map(async (order) => [
    order.id,
    await getCancellationSettlementSummary(order.id),
  ]));
  const settlementsByOrder = Object.fromEntries(settlementPairs);

  return buildPerTripSalesReport({
    trip,
    orders,
    activityByOrder,
    settlementsByOrder,
  });
};
```

*11.2*  
File: `perTripSalesReport.js`  
Path: `src/lib/perTripSalesReport.js`  
Lines: 180–235  
Module/Feature: Sales Reports  
Description: buildPerTripSalesReport() computes the report totals (shipping fees, payments received, refunds, amount still to collect, booking counts) using cent-exact arithmetic.

```text
export const buildPerTripSalesReport = ({
  trip,
  orders = [],
  activityByOrder = {},
  settlementsByOrder = {},
}) => {
  const rows = orders.map(order => buildRow(
    order,
    activityByOrder[order.id] || [],
    settlementsByOrder[order.id],
  ));
  const activeRows = rows.filter(row => row.status !== ORDER_STATUS.CANCELLED);
  const cancelledRows = rows.filter(row => row.status === ORDER_STATUS.CANCELLED);
  const reviewRows = cancelledRows.filter(row => row.cancellation.needsReview);
  const dataInconsistent = rows.some(row => row.cancellation?.dataInconsistent);

  const paymentsReceivedCents = sumRows(rows, 'paymentsReceived');
  const moneyReturnedCents = sumRows(rows, 'moneyReturned');
  const cancelledAwaitingDecisionCents = reviewRows.reduce((total, row) => {
    const amount = toCents(row.cancellation.netRetained);
    return amount > 0 ? addCents(total, amount) : total;
  }, 0);

  const shippingFeesCents = activeRows.reduce((total, row) => (
    row.shippingFee === null ? total : addCents(total, toCents(row.shippingFee))
  ), 0);
  const amountStillToCollectCents = activeRows.reduce((total, row) => (
    row.amountStillToPay === null ? total : addCents(total, toCents(row.amountStillToPay))
  ), 0);

  return {
    trip,
    rows,
    activeRows,
    cancelledRows,
    summary: {
      shippingFees: fromCents(shippingFeesCents),
      paymentsReceived: fromCents(paymentsReceivedCents),
      moneyReturned: fromCents(moneyReturnedCents),
      paymentsAfterRefunds: fromCents(paymentsReceivedCents - moneyReturnedCents),
      amountStillToCollect: fromCents(amountStillToCollectCents),
      activeBookingCount: activeRows.length,
      completedBookingCount: activeRows.filter(row => row.isCompleted).length,
      cancelledBookingCount: cancelledRows.length,
      unpricedActiveCount: activeRows.filter(row => !row.isPriced).length,
      cancelledMoneyAwaitingDecision: fromCents(cancelledAwaitingDecisionCents),
      cancelledReviewCount: reviewRows.length,
      pendingRefundAmount: fromCents(sumRows(rows, 'refundPending')),
      failedRefundAmount: fromCents(sumRows(rows, 'refundFailed')),
      uncertainRefundAmount: fromCents(sumRows(rows, 'refundUncertain')),
      dataInconsistent,
    },
    basis: 'Shows recorded payments and refunds for bookings assigned to this trip, regardless of payment date.',
    assignmentNote: 'This report uses each booking’s current trip assignment. Reassigned bookings appear only under their current trip. A cancelled booking with no current assignment cannot be placed here reliably.',
  };
};
```

*11.3*  
File: `database.js`  
Path: `src/lib/database.js`  
Lines: 2075–2102  
Module/Feature: Sales Reports  
Description: deriveSettlement() computes an order's outstanding balance, detects mismatches with the stored balance, classifies it for the unpaid-shipments report, and counts days overdue past the promised payment date.

```text
export const deriveSettlement = (order, today = null) => {
  const ref = today || new Date();

  // Shared with the dispatch gate, the admin badges and get_sales_summary() —
  // one implementation of "what is owed", so no two views can disagree.
  const outstanding = outstandingBalance(order);
  const stored = order.remaining_balance == null ? null : parseFloat(order.remaining_balance);

  let daysOverdue = 0;
  if (order.promised_payment_date) {
    const promisedKey = phDateKey(order.promised_payment_date);
    const todayKey = phDateKey(ref);
    if (promisedKey && todayKey && promisedKey < todayKey) {
      const promisedUtc = Date.parse(`${promisedKey}T00:00:00Z`);
      const todayUtc = Date.parse(`${todayKey}T00:00:00Z`);
      daysOverdue = Math.floor((todayUtc - promisedUtc) / 86400000);
    }
  }

  return {
    outstanding,
    // NULL is the legacy case the widening exists for — not a mismatch to
    // report, just an absent figure the derived one stands in for.
    balance_mismatch: stored != null && Math.abs(stored - outstanding) > 0.01,
    settlement_bucket: classifySettlement(order, ref),
    days_overdue: daysOverdue,
  };
};
```

**Summary of Source Code Listings**

| No. | Module | File Name | File Path | Approximate Lines |
|---|---|---|---|---|
| 1.1 | User Authentication and Registration | AuthContext.jsx | src/contexts/AuthContext.jsx | 155 |
| 1.2 | User Authentication and Registration | supabase.js | src/lib/supabase.js | 31 |
| 2.1 | Role-Based Access Control and Security | App.jsx | src/App.jsx | 22 |
| 2.2 | Role-Based Access Control and Security | 20260524190000_production_hardening.sql | supabase/migrations/20260524190000_production_hardening.sql | 11 |
| 2.3 | Role-Based Access Control and Security | 20260524190000_production_hardening.sql | supabase/migrations/20260524190000_production_hardening.sql | 29 |
| 2.4 | Role-Based Access Control and Security | 20260912030000_restrict_service_area_customer_insert.sql | supabase/migrations/20260912030000_restrict_service_area_customer_insert.sql | 15 |
| 3.1 | Customer Cargo Booking | BookShipmentPage.jsx | src/pages/customer/BookShipmentPage.jsx | 71 |
| 3.2 | Customer Cargo Booking | database.js | src/lib/database.js | 74 |
| 4.1 | Shipment Status Workflow and Tracking | status.js | src/constants/status.js | 30 |
| 4.2 | Shipment Status Workflow and Tracking | status.js | src/constants/status.js | 42 |
| 4.3 | Shipment Status Workflow and Tracking | database.js | src/lib/database.js | 7 |
| 4.4 | Shipment Status Workflow and Tracking | 20260926100000_simplify_stage1_derive_and_compat.sql | supabase/migrations/20260926100000_simplify_stage1_derive_and_compat.sql | 31 |
| 5.1 | Trip Management | database.js | src/lib/database.js | 130 |
| 5.2 | Trip Management | database.js | src/lib/database.js | 24 |
| 5.3 | Trip Management | database.js | src/lib/database.js | 32 |
| 6.1 | PayMongo GCash Payment Integration | index.ts | supabase/functions/paymongo-create-payment/index.ts | 30 |
| 6.2 | PayMongo GCash Payment Integration | index.ts | supabase/functions/paymongo-create-payment/index.ts | 128 |
| 6.3 | PayMongo GCash Payment Integration | index.ts | supabase/functions/paymongo-webhook/index.ts | 44 |
| 7.1 | Partial Payment and Remaining Balance | status.js | src/constants/status.js | 50 |
| 7.2 | Partial Payment and Remaining Balance | database.js | src/lib/database.js | 20 |
| 7.3 | Partial Payment and Remaining Balance | 20260919020000_fix_manual_payment_refund_awareness_part2.sql | supabase/migrations/20260919020000_fix_manual_payment_refund_awareness_part2.sql | 126 |
| 7.4 | Partial Payment and Remaining Balance | 20260913170000_serialize_order_payment_totals.sql | supabase/migrations/20260913170000_serialize_order_payment_totals.sql | 57 |
| 8.1 | Notifications | 20260905003149_complete_order_notification_atomicity.sql | supabase/migrations/20260905003149_complete_order_notification_atomicity.sql | 131 |
| 8.2 | Notifications | database.js | src/lib/database.js | 30 |
| 9.1 | Customer Support Chat | database.js | src/lib/database.js | 34 |
| 9.2 | Customer Support Chat | database.js | src/lib/database.js | 14 |
| 9.3 | Customer Support Chat | supportChatEngine.js | src/lib/supportChatEngine.js | 110 |
| 10.1 | Admin Booking Management and Cancellation | database.js | src/lib/database.js | 35 |
| 11.1 | Sales Reports | database.js | src/lib/database.js | 46 |
| 11.2 | Sales Reports | perTripSalesReport.js | src/lib/perTripSalesReport.js | 56 |
| 11.3 | Sales Reports | database.js | src/lib/database.js | 28 |
| | **Total** | | | **1643** |
