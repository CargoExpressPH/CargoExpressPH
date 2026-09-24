import { test, expect } from '@playwright/test';
import { adminClient, customerClient, findLatestE2ECustomer } from './helpers/db.js';

const MISSING_ORDER_ID = '00000000-0000-0000-0000-000000000001';

test.describe('authorization regressions', () => {
  test.describe.configure({ mode: 'serial' });

  let admin;
  let customer;
  let customerProfile;

  test.beforeAll(async () => {
    admin = await adminClient();
    customerProfile = await findLatestE2ECustomer();
    expect(customerProfile, 'A labeled E2E customer is required').toBeTruthy();
    customer = await customerClient(customerProfile.email);
  });

  test('cancellation review rejects a customer before inspecting the order', async () => {
    const { error: customerError } = await customer.rpc('review_order_cancellation', {
      p_order_id: MISSING_ORDER_ID,
      p_approve: true,
      p_notes: 'Authorization regression check',
    });

    expect(customerError).toBeTruthy();
    expect(customerError.code).toBe('42501');
    expect(customerError.message).toMatch(/admin privileges required/i);

    const { error: adminError } = await admin.rpc('review_order_cancellation', {
      p_order_id: MISSING_ORDER_ID,
      p_approve: true,
      p_notes: 'Authorization regression check',
    });

    expect(adminError).toBeTruthy();
    expect(adminError.message).toMatch(/order not found/i);
  });

  test('customer can mark an admin message read but cannot alter its content', async () => {
    const { data: conversation, error: conversationError } = await admin
      .from('conversations')
      .select('id')
      .eq('customer_id', customerProfile.id)
      .maybeSingle();

    expect(conversationError).toBeNull();
    expect(conversation, 'The labeled E2E customer needs a support conversation').toBeTruthy();

    const { data: messages, error: messageError } = await admin
      .from('chat_messages')
      .select('id,message,is_read')
      .eq('conversation_id', conversation.id)
      .eq('sender_role', 'admin')
      .order('created_at', { ascending: false })
      .limit(1);

    expect(messageError).toBeNull();
    expect(messages?.length, 'The support conversation needs an admin reply').toBe(1);
    const original = messages[0];

    const marker = `SECURITY-REGRESSION-${Date.now()}`;
    const { error: tamperError } = await customer
      .from('chat_messages')
      .update({ message: `${original.message} ${marker}`, is_read: true })
      .eq('id', original.id)
      .select('id');

    expect(tamperError).toBeTruthy();
    expect(tamperError.code).toBe('42501');
    expect(tamperError.message).toMatch(/change only the read state/i);

    const { data: unchanged, error: verifyError } = await admin
      .from('chat_messages')
      .select('message')
      .eq('id', original.id)
      .single();

    expect(verifyError).toBeNull();
    expect(unchanged.message).toBe(original.message);
    expect(unchanged.message).not.toContain(marker);

    const { data: acknowledged, error: readError } = await customer
      .from('chat_messages')
      .update({ is_read: true })
      .eq('id', original.id)
      .select('id,is_read')
      .single();

    expect(readError).toBeNull();
    expect(acknowledged).toEqual({ id: original.id, is_read: true });
  });
});
