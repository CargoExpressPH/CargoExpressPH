import { Suspense, useEffect } from 'react';
import { lazyWithRetry } from './lib/lazyWithRetry';
import PageLoader from './components/ui/PageLoader';
import InstallAppBanner from './components/ui/InstallAppBanner';
import IosInstallBanner from './components/ui/IosInstallBanner';
import { createBrowserRouter, RouterProvider, Navigate, Outlet, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './hooks/useToast';

// Layouts — eagerly loaded (always needed)
import AdminLayout from './components/layout/AdminLayout';
import CustomerLayout from './components/layout/CustomerLayout';

// Auth Pages — eagerly loaded (first thing users see)
import LoginPage from './pages/auth/LoginPage';
import RegisterPage from './pages/auth/RegisterPage';
import ForgotPasswordPage from './pages/auth/ForgotPasswordPage';
import ResetPasswordPage from './pages/auth/ResetPasswordPage';
import { BrandLogo, BrandWordmark } from './components/ui/BrandLogo';

// ─── Lazy-loaded Pages ─────────────────────────────────────────────────────
// Each page is loaded on-demand only when the user navigates to it.
// This splits the 826 kB bundle into smaller, route-specific chunks.

// Customer Pages
const HomePage = lazyWithRetry(() => import('./pages/customer/HomePage'));
const CustOrdersPage = lazyWithRetry(() => import('./pages/customer/OrdersPage'));
const CustOrderDetailPage = lazyWithRetry(() => import('./pages/customer/OrderDetailPage'));
const BookShipmentPage = lazyWithRetry(() => import('./pages/customer/BookShipmentPage'));
const CustTripsPage = lazyWithRetry(() => import('./pages/customer/TripsPage'));
const NotificationsPage = lazyWithRetry(() => import('./pages/customer/NotificationsPage'));
const CustProfilePage = lazyWithRetry(() => import('./pages/customer/ProfilePage'));
const CustPersonalInfoPage = lazyWithRetry(() => import('./pages/customer/PersonalInfoPage'));
const ChangePasswordPage = lazyWithRetry(() => import('./pages/shared/ChangePasswordPage'));
const ChangeEmailPage = lazyWithRetry(() => import('./pages/shared/ChangeEmailPage'));
const SupportChatPage = lazyWithRetry(() => import('./pages/customer/SupportChatPage'));
const PaymentHistoryPage = lazyWithRetry(() => import('./pages/customer/PaymentHistoryPage'));
const HelpGuidelinesPage = lazyWithRetry(() => import('./pages/customer/HelpGuidelinesPage'));
const AboutVersionPage = lazyWithRetry(() => import('./pages/customer/AboutVersionPage'));

// Admin Pages
const DashboardPage = lazyWithRetry(() => import('./pages/admin/DashboardPage'));
const FeedbackPage = lazyWithRetry(() => import('./pages/admin/FeedbackPage'));
const AdminOrdersPage = lazyWithRetry(() => import('./pages/admin/OrdersPage'));
const AdminOrderDetailPage = lazyWithRetry(() => import('./pages/admin/OrderDetailPage'));
const AdminTripsPage = lazyWithRetry(() => import('./pages/admin/TripsPage'));
const CreateTripPage = lazyWithRetry(() => import('./pages/admin/CreateTripPage'));
const TripDetailPage = lazyWithRetry(() => import('./pages/admin/TripDetailPage'));
const CustomersPage = lazyWithRetry(() => import('./pages/admin/CustomersPage'));
const CustomerDetailPage = lazyWithRetry(() => import('./pages/admin/CustomerDetailPage'));
const SalesReportsPage = lazyWithRetry(() => import('./pages/admin/SalesReportsPage'));
const AnnouncementsPage = lazyWithRetry(() => import('./pages/admin/AnnouncementsPage'));
const InboxPage = lazyWithRetry(() => import('./pages/admin/InboxPage'));
const ContactInquiriesPage = lazyWithRetry(() => import('./pages/admin/ContactInquiriesPage'));
const AdminProfilePage = lazyWithRetry(() => import('./pages/admin/ProfilePage'));
const ActivityLogsPage = lazyWithRetry(() => import('./pages/admin/ActivityLogsPage'));
const CompanyInformationPage = lazyWithRetry(() => import('./pages/admin/CompanyInformationPage'));

// Public Pages
const TrackingPage = lazyWithRetry(() => import('./pages/public/TrackingPage'));
const AboutPage = lazyWithRetry(() => import('./pages/public/AboutPage'));
const TermsPage = lazyWithRetry(() => import('./pages/public/TermsPage'));
const PrivacyPage = lazyWithRetry(() => import('./pages/public/PrivacyPage'));
const NotFoundPage = lazyWithRetry(() => import('./pages/public/NotFoundPage'));

// ─── Loading Screens ────────────────────────────────────────────────────────

const LoadingScreen = () => (
  <div className="loading-screen">
    <div className="loading-brand animate-scale-in">
      <BrandLogo size={44} decorative />
      <h1><BrandWordmark /></h1>
    </div>
    <div className="spinner" />
    <p>Loading Cargo Express PH...</p>
  </div>
);

// ─── Route Guards ───────────────────────────────────────────────────────────

/**
 * `loading` flips true again after boot — a re-login, a profile refresh. Once
 * we already hold a valid profile for the required role, honouring that flip
 * would swap the whole authenticated subtree for <LoadingScreen/>, unmounting
 * whatever page the user is on and destroying its state: a half-filled booking
 * wizard included. The loading screen is for the FIRST resolve only, when
 * there is genuinely nothing to show. After that, keep rendering what we have.
 */
const ProtectedRoute = ({ children, requiredRole }) => {
  const { user, userProfile, loading } = useAuth();
  const hasUsableProfile = !!(user && userProfile && (!requiredRole || userProfile.role === requiredRole));
  if (loading && !hasUsableProfile) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  if (!userProfile) return <Navigate to="/login" replace />;

  if (requiredRole && userProfile.role !== requiredRole) {
    // If role is null/undefined (profile fetch failed), send to login
    // instead of redirecting to a role-based route that also rejects null,
    // which would create an infinite redirect loop.
    if (!userProfile.role) return <Navigate to="/login" replace />;
    return <Navigate to={userProfile.role === 'admin' ? '/admin' : '/customer'} replace />;
  }
  return children;
};

const AuthRoute = ({ children }) => {
  const { user, userProfile, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  // Only redirect away from auth pages if the user has a valid role.
  // If role is null (profile fetch failed), stay on login so the user
  // can re-authenticate, which retries the profile fetch.
  if (user && userProfile && userProfile.role) {
    return <Navigate to={userProfile.role === 'admin' ? '/admin' : '/customer'} replace />;
  }
  return children;
};

const RootRedirect = () => {
  const { user, userProfile, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  if (!userProfile || !userProfile.role) return <Navigate to="/login" replace />;
  return <Navigate to={userProfile.role === 'admin' ? '/admin' : '/customer'} replace />;
};

/** Automatically scrolls to top of page on route changes */
const ScrollToTop = () => {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
};

// ─── Root Layout (provides Suspense boundary for the entire route tree) ─────
const RootLayout = () => (
  <Suspense fallback={<LoadingScreen />}>
    <ScrollToTop />
    <Outlet />
  </Suspense>
);

// ─── Data Router (required for useBlocker support) ──────────────────────────
const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      // Root
      { path: '/', element: <RootRedirect /> },

      // Public (lazy)
      { path: '/track', element: <TrackingPage /> },
      { path: '/about', element: <AboutPage /> },
      { path: '/terms', element: <TermsPage /> },
      { path: '/privacy', element: <PrivacyPage /> },

      // Auth (eager — first thing users see)
      { path: '/login', element: <AuthRoute><LoginPage /></AuthRoute> },
      { path: '/register', element: <AuthRoute><RegisterPage /></AuthRoute> },
      { path: '/forgot-password', element: <AuthRoute><ForgotPasswordPage /></AuthRoute> },
      { path: '/reset-password', element: <ResetPasswordPage /> },

      // Customer — each child page loads on demand
      {
        path: '/customer',
        element: <ProtectedRoute requiredRole="customer"><CustomerLayout /></ProtectedRoute>,
        children: [
          { index: true, element: <Suspense fallback={<PageLoader />}><HomePage /></Suspense> },
          { path: 'orders', element: <Suspense fallback={<PageLoader />}><CustOrdersPage /></Suspense> },
          { path: 'orders/:id', element: <Suspense fallback={<PageLoader />}><CustOrderDetailPage /></Suspense> },
          { path: 'book', element: <Suspense fallback={<PageLoader />}><BookShipmentPage /></Suspense> },
          { path: 'track', element: <Suspense fallback={<PageLoader />}><TrackingPage embedded /></Suspense> },
          { path: 'trips', element: <Suspense fallback={<PageLoader />}><CustTripsPage /></Suspense> },
          { path: 'notifications', element: <Suspense fallback={<PageLoader />}><NotificationsPage /></Suspense> },
          { path: 'profile', element: <Suspense fallback={<PageLoader />}><CustProfilePage /></Suspense> },
          { path: 'personal-info', element: <Suspense fallback={<PageLoader />}><CustPersonalInfoPage /></Suspense> },
          { path: 'change-password', element: <Suspense fallback={<PageLoader />}><ChangePasswordPage /></Suspense> },
          { path: 'change-email', element: <Suspense fallback={<PageLoader />}><ChangeEmailPage /></Suspense> },
          { path: 'support', element: <Suspense fallback={<PageLoader />}><SupportChatPage /></Suspense> },
          { path: 'payments', element: <Suspense fallback={<PageLoader />}><PaymentHistoryPage /></Suspense> },
          // The page was 'payment-methods' until it was renamed to Payment
          // History. Kept as a redirect because the old path is in browser
          // history, in the PWA's cached shell and in any link a customer
          // saved — dropping it would 404 them rather than move them.
          { path: 'payment-methods', element: <Navigate to="/customer/payments" replace /> },
          { path: 'help-guidelines', element: <Suspense fallback={<PageLoader />}><HelpGuidelinesPage /></Suspense> },
          { path: 'about-version', element: <Suspense fallback={<PageLoader />}><AboutVersionPage /></Suspense> },
        ],
      },

      // Admin — each child page loads on demand
      {
        path: '/admin',
        element: <ProtectedRoute requiredRole="admin"><AdminLayout /></ProtectedRoute>,
        children: [
          { index: true, element: <Suspense fallback={<PageLoader />}><DashboardPage /></Suspense> },
          { path: 'orders', element: <Suspense fallback={<PageLoader />}><AdminOrdersPage /></Suspense> },
          { path: 'orders/:id', element: <Suspense fallback={<PageLoader />}><AdminOrderDetailPage /></Suspense> },
          { path: 'trips', element: <Suspense fallback={<PageLoader />}><AdminTripsPage /></Suspense> },
          { path: 'trips/create', element: <Suspense fallback={<PageLoader />}><CreateTripPage /></Suspense> },
          { path: 'trips/:id', element: <Suspense fallback={<PageLoader />}><TripDetailPage /></Suspense> },
          { path: 'customers', element: <Suspense fallback={<PageLoader />}><CustomersPage /></Suspense> },
          { path: 'customers/:id', element: <Suspense fallback={<PageLoader />}><CustomerDetailPage /></Suspense> },
          { path: 'sales', element: <Suspense fallback={<PageLoader />}><SalesReportsPage /></Suspense> },
          { path: 'reports', element: <Suspense fallback={<PageLoader />}><SalesReportsPage initialSection="reports" /></Suspense> },
          { path: 'announcements', element: <Suspense fallback={<PageLoader />}><AnnouncementsPage /></Suspense> },
          { path: 'inbox', element: <Suspense fallback={<PageLoader />}><InboxPage /></Suspense> },
          { path: 'contact-inquiries', element: <Suspense fallback={<PageLoader />}><ContactInquiriesPage /></Suspense> },
          { path: 'profile', element: <Suspense fallback={<PageLoader />}><AdminProfilePage /></Suspense> },
          { path: 'change-email', element: <Suspense fallback={<PageLoader />}><ChangeEmailPage /></Suspense> },
          { path: 'change-password', element: <Suspense fallback={<PageLoader />}><ChangePasswordPage /></Suspense> },
          { path: 'activity-logs', element: <Suspense fallback={<PageLoader />}><ActivityLogsPage /></Suspense> },
          { path: 'company-info', element: <Suspense fallback={<PageLoader />}><CompanyInformationPage /></Suspense> },
          { path: 'feedback', element: <Suspense fallback={<PageLoader />}><FeedbackPage /></Suspense> },
        ],
      },

      // 404
      { path: '*', element: <Suspense fallback={<PageLoader />}><NotFoundPage /></Suspense> },
    ],
  },
]);


function App() {
  return (
    <ThemeProvider>
    <ToastProvider>
      <AuthProvider>
        <InstallAppBanner />
        <IosInstallBanner />
        <RouterProvider router={router} />
      </AuthProvider>
    </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
