/**
 * Shared importer so React.lazy and registration preloading resolve the exact
 * same Vite chunk. Starting this request while the account is being created
 * prevents the customer shell from briefly waiting on an uncached home-page
 * bundle after the success screen.
 */
export const loadCustomerHomePage = () => import('../pages/customer/HomePage');
export const preloadCustomerHomePage = loadCustomerHomePage;
