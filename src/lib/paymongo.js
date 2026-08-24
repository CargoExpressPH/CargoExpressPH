// PayMongo GCash Payment Integration
// Uses PayMongo API for actual GCash payment processing
// Docs: https://developers.paymongo.com/

import { supabase } from './supabase';

const PAYMONGO_PUBLIC_KEY = import.meta.env.VITE_PAYMONGO_PUBLIC_KEY || '';

const PAYMONGO_API = 'https://api.paymongo.com/v1';

/**
 * Create a GCash payment source
 * This generates a redirect URL for the customer to authorize payment
 * @param {number} amount - Amount in PHP (will be converted to centavos)
 * @param {string} description - Payment description
 * @param {object} billing - Billing details { name, phone, email }
 * @param {boolean} isAdmin - Whether the admin is initiating the payment
 * @param {string} orderId - Optional order UUID to redirect back to the specific order page
 * @returns {object} - { sourceId, checkoutUrl }
 */
export const createGCashSource = async (amount, description, billing = {}, isAdmin = false, orderId = null) => {
  if (!PAYMONGO_PUBLIC_KEY) {
    throw new Error('PayMongo public key is not configured. Add VITE_PAYMONGO_PUBLIC_KEY to your .env file.');
  }

  const response = await fetch(`${PAYMONGO_API}/sources`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${btoa(PAYMONGO_PUBLIC_KEY + ':')}`,
    },
    body: JSON.stringify({
      data: {
        attributes: {
          amount: Math.round(amount * 100), // Convert to centavos
          redirect: {
            success: `${window.location.origin}/${isAdmin ? 'admin' : 'customer'}/orders${orderId ? `/${orderId}` : ''}?payment=success`,
            failed: `${window.location.origin}/${isAdmin ? 'admin' : 'customer'}/orders${orderId ? `/${orderId}` : ''}?payment=failed`,
          },
          type: 'gcash',
          currency: 'PHP',
          description: description || 'CargoExpress PH Shipping Payment',
          billing: {
            name: billing.name || 'CargoExpress PH Customer',
            phone: billing.phone || '09000000000',
            email: billing.email || 'noreply@cargoexpress.ph',
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.errors?.[0]?.detail || 'Failed to create GCash payment');
  }

  const data = await response.json();
  return {
    sourceId: data.data.id,
    checkoutUrl: data.data.attributes.redirect.checkout_url,
    status: data.data.attributes.status,
  };
};

/**
 * Check the status of a payment source
 * @param {string} sourceId - The PayMongo source ID
 * @returns {object} - { status, amount }
 */
export const checkPaymentStatus = async (sourceId) => {
  if (!PAYMONGO_PUBLIC_KEY) {
    throw new Error('PayMongo key not configured');
  }

  const response = await fetch(`${PAYMONGO_API}/sources/${sourceId}`, {
    headers: {
      'Authorization': `Basic ${btoa(PAYMONGO_PUBLIC_KEY + ':')}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to check payment status');
  }

  const data = await response.json();
  return {
    status: data.data.attributes.status,
    amount: data.data.attributes.amount / 100, // Convert from centavos
  };
};

/**
 * Create a payment from a chargeable source.
 * The PayMongo secret key is intentionally kept server-side in a Supabase
 * Edge Function secret named PAYMONGO_SECRET_KEY.
 * @param {string} sourceId - Chargeable source ID
 * @param {number} amount - Amount in PHP
 * @param {string} description - Payment description
 * @param {object} [orderUpdate] - Optional order data for server-side reconciliation
 * @param {string} [orderUpdate.orderId] - Order UUID
 * @param {number} [orderUpdate.actualWeight] - Actual weight in kg
 * @param {string} [orderUpdate.payerType] - 'sender' or 'receiver'
 * @param {string[]} [orderUpdate.pickupPhotos] - Photo URLs
 */
export const createPayment = async (sourceId, amount, description, orderUpdate = null) => {
  if (!sourceId) {
    throw new Error('PayMongo source ID is required.');
  }
  if (!amount || Number(amount) <= 0) {
    throw new Error('PayMongo payment amount must be greater than zero.');
  }

  const body = { sourceId, amount, description, action: 'capture' };
  if (orderUpdate) {
    body.orderUpdate = orderUpdate;
  }

  const { data, error } = await supabase.functions.invoke('paymongo-create-payment', {
    body,
  });

  if (error) {
    throw new Error(error.message || 'Failed to process payment');
  }
  if (data?.error) {
    throw new Error(data.error);
  }

  return {
    paymentId: data.paymentId,
    status: data.status,
    amount: data.amount,
    orderReconciled: data.orderReconciled || false,
  };
};

/**
 * Registers a newly created PayMongo source with the backend.
 * This links the source to the order so webhooks can process it.
 * @param {string} sourceId - Created source ID
 * @param {number} amount - Amount in PHP
 * @param {object} orderUpdate - Order data { orderId, actualWeight, payerType, pickupPhotos }
 */
export const registerSource = async (sourceId, amount, orderUpdate) => {
  if (!sourceId || !orderUpdate?.orderId) {
    throw new Error('PayMongo source ID and orderId are required.');
  }
  
  const body = { 
    sourceId, 
    amount, 
    description: `CargoExpress PH - Order ${orderUpdate.orderId}`,
    orderUpdate, 
    action: 'register' 
  };
  
  const { data, error } = await supabase.functions.invoke('paymongo-create-payment', {
    body,
  });

  if (error) {
    throw new Error(error.message || 'Failed to register source');
  }
  if (data?.error) {
    throw new Error(data.error);
  }
  return data;
};

/**
 * Initiate GCash payment flow for a customer booking
 * Opens a new window/tab for GCash authorization
 * @param {number} amount - Amount in PHP
 * @param {string} trackingNumber - Order tracking number
 * @param {object} customer - { name, phone, email }
 * @param {boolean} isAdmin - Whether the admin is initiating the payment
 * @param {string} orderId - Optional order UUID for redirect
 * @returns {string} sourceId - To poll for payment status
 */
export const initiateGCashPayment = async (amount, trackingNumber, customer = {}, isAdmin = false, orderId = null) => {
  const description = `CargoExpress PH - Order ${trackingNumber}`;
  const { sourceId, checkoutUrl } = await createGCashSource(amount, description, customer, isAdmin, orderId);

  return { sourceId, checkoutUrl };
};

const inFlightPolls = new Map();

/**
 * Poll the payment status from the server.
 * Called when the customer returns from PayMongo checkout.
 * The server checks the PayMongo source status and reconciles if paid.
 * Includes concurrency deduplication to prevent duplicate webhook/polling race conditions.
 * @param {string} sourceId - PayMongo source ID
 * @param {string} orderId - Order UUID
 * @returns {object} - { status, orderReconciled, paymentId, amount, error }
 */
export const pollPaymentStatus = async (sourceId, orderId) => {
  if (!sourceId || !orderId) {
    throw new Error('sourceId and orderId are required for polling');
  }

  const pollKey = `${sourceId}:${orderId}`;
  if (inFlightPolls.has(pollKey)) {
    return inFlightPolls.get(pollKey);
  }

  const pollPromise = (async () => {
    try {
      const { data, error } = await supabase.functions.invoke('paymongo-create-payment', {
        body: {
          sourceId,
          amount: 1, // Minimum — the server uses the stored attempt amount
          action: 'poll',
          orderUpdate: { orderId },
        },
      });

      if (error) {
        throw new Error(error.message || 'Failed to verify payment status');
      }
      if (data?.error) {
        throw new Error(data.error);
      }

      return {
        status: data.status || 'unknown',
        orderReconciled: data.orderReconciled || false,
        paymentId: data.paymentId || null,
        amount: data.amount || 0,
        message: data.message || null,
      };
    } finally {
      inFlightPolls.delete(pollKey);
    }
  })();

  inFlightPolls.set(pollKey, pollPromise);
  return pollPromise;
};
