import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from './useToast';

/**
 * Shared "select a trip to book" gate used by both the customer Trips page
 * and the public About page's Trip Schedules section. A guest is sent to
 * Login and back to wherever they started — not threaded through to
 * BookShipmentPage with the trip still selected — so each caller only needs
 * to supply its own return path via `from`.
 */
export const useTripBooking = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  return (trip, { from = { pathname: '/schedules' } } = {}) => {
    if (!user) {
      toast.info('Login to book the schedule or inquire');
      navigate('/login', { state: { from } });
      return;
    }
    navigate('/customer/book', {
      state: { preselectedRoute: `${trip.origin} → ${trip.destination}`, preselectedTripId: trip.id },
    });
  };
};

export default useTripBooking;
