import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import AdminOrdersPage from '../../src/pages/admin/OrdersPage';
import CustomerDetailPage from '../../src/pages/admin/CustomerDetailPage';
import TripDetailPage from '../../src/pages/admin/TripDetailPage';
import CustomerOrdersPage from '../../src/pages/customer/OrdersPage';
import PaymentHistoryPage from '../../src/pages/customer/PaymentHistoryPage';
import LoginPage from '../../src/pages/auth/LoginPage';
import OnboardingModal from '../../src/components/ui/OnboardingModal';
import '../../src/styles/fonts.css';
import '../../src/styles/main.css';

const state = globalThis.__historyUI;
const root = createRoot(document.getElementById('root'));
let generation = 0;
const Navigation = () => {
  const navigate = useNavigate();
  useEffect(() => { state.navigate = navigate; }, [navigate]);
  return null;
};
state.mount = path => root.render(
  <StrictMode>
    <MemoryRouter key={++generation} initialEntries={[path]}>
      <Navigation />
      <Routes>
        <Route path="/admin/orders" element={<AdminOrdersPage />} />
        <Route path="/admin/customers/:id" element={<CustomerDetailPage />} />
        <Route path="/admin/trips/:id" element={<TripDetailPage />} />
        <Route path="/customer/orders" element={<CustomerOrdersPage />} />
        <Route path="/customer/payments" element={<PaymentHistoryPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/onboarding" element={<OnboardingModal />} />
        <Route path="*" element={<div data-testid="signed-in">Signed in</div>} />
      </Routes>
    </MemoryRouter>
  </StrictMode>
);
state.ready = true;
